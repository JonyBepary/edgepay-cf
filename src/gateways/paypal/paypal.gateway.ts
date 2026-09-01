/**
 * PayPal payment gateway adapter — Orders API v2.
 *
 * Implements PayPal's modern Orders API (not legacy IPN):
 *   1. initiate: POST /v2/checkout/orders → returns approval URL
 *   2. Customer approves payment on PayPal
 *   3. verify: POST /v2/checkout/orders/{id}/capture → captures funds
 *   4. verifyWebhook: PayPal-Auth-Algo + PayPal-Transmission-Sig headers
 *      verified via PayPal's certificate chain + webhook ID lookup
 *
 * Token: PayPal uses OAuth2 client_credentials grant. Token cached in KV
 * with 9-hour TTL (PayPal tokens live 32400s ≈ 9h).
 */

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type RefundResult, type VerifyWebhookInput, type Credentials, type GatewayContext } from '../base';
import { gwJson } from '../kit/http';

const API_BASE_LIVE = 'https://api-m.paypal.com';
const API_BASE_SANDBOX = 'https://api-m.sandbox.paypal.com';
const TOKEN_TTL_SEC = 32000; // ~8.9h (PayPal tokens live ~9h)

export class PayPalGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'PayPal',
      slug: 'paypal',
      version: '1.0.0',
      description: 'PayPal Orders API v2 integration',
      author: 'EdgePay Core',
      type: 'gateway',
      supported_currencies: ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'BRL'],
      capabilities: ['refund', 'webhook'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'client_id', label: 'Client ID', type: 'text', required: true },
      { name: 'client_secret', label: 'Client Secret', type: 'password', required: true },
      { name: 'webhook_id', label: 'Webhook ID', type: 'text', required: true, help: 'PayPal webhook ID (WH-XXXX...) for signature verification' },
      {
        name: 'mode', label: 'Mode', type: 'select', required: true,
        options: [
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'live', label: 'Live' },
        ],
        default: 'sandbox',
      },
    ];
  }

  async initiate(params: InitiateParams, credentials: Credentials, ctx?: GatewayContext): Promise<InitiateResult> {
    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, ctx);

    // Include custom identifiers for reconciliation: custom_id and invoice_id
    const purchaseUnit: Record<string, unknown> = {
      reference_id: params.trx_id,
      custom_id: params.trx_id,
      amount: {
        currency_code: params.currency,
        value: params.amount,
      },
      description: (params.metadata?.description as string | undefined) ?? 'EdgePay payment',
    };
    // Optional invoice_id from metadata if provided
    if (params.metadata?.invoice_id) {
      purchaseUnit.invoice_id = String(params.metadata.invoice_id);
    }

    const response = await gwJson<{
      id: string;
      links: Array<{ rel: string; href: string }>;
    }>({
      url: `${baseUrl}/v2/checkout/orders`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [purchaseUnit],
        application_context: {
          return_url: params.redirect_url,
          cancel_url: params.cancel_url,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      }),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      const err = response.data as { message?: string } | null;
      throw new Error(`PayPal create order failed: ${err?.message ?? response.text ?? String(response.status)}`);
    }

    const data = response.data;

    const approveLink = data.links.find(l => l.rel === 'approve');
    if (!approveLink) {
      throw new Error('PayPal: no approve link in response');
    }

    return {
      redirect_url: approveLink.href,
      session_id: data.id,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, ctx?: GatewayContext): Promise<VerifyResult> {
    // Input guard FIRST (no token-grant subrequest for an unusable callback)
    const orderId = String(callbackData.token ?? '').trim();  // PayPal returns ?token=ORDER_ID
    if (!orderId) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: 'Missing PayPal order ID' };
    }

    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, ctx);

    const response = await gwJson<{
      id: string;
      status: 'COMPLETED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'PAYER_ACTION_REQUIRED';
      purchase_units: Array<{
        payments: {
          captures: Array<{
            id: string;
            amount: { value: string; currency_code: string };
            status: string;
          }>;
        };
      }>;
    }>({
      url: `${baseUrl}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      return {
        success: false,
        gateway_trx_id: orderId,
        amount: null,
        status: 'failed',
        error: `PayPal capture failed: ${response.status}`,
      };
    }

    const data = response.data;

    const capture = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture) {
      return { success: false, gateway_trx_id: orderId, amount: null, status: 'failed', error: 'No capture in response' };
    }

    return {
      success: data.status === 'COMPLETED' && capture.status === 'COMPLETED',
      gateway_trx_id: capture.id,
      amount: capture.amount.value,
      currency: capture.amount.currency_code,
      status: data.status === 'COMPLETED' ? 'completed' : 'failed',
    };
  }

  /**
   * PayPal webhook verification uses cert-chain verification, which is
   * complex to implement in Workers. The simplified approach:
   * 1. Verify the webhook ID matches our configured webhook_id
   * 2. POST the headers + body to PayPal's /v1/notifications/verify-webhook-signature
   *    endpoint and check the verification_status response.
   */
  async verifyWebhook(input: VerifyWebhookInput): Promise<boolean> {
    const webhookId = input.credentials.webhook_id;
    if (!webhookId) return false;

    // Guard malformed JSON early — never throw on attacker-controlled body
    let webhookEvent: unknown;
    try {
      webhookEvent = JSON.parse(input.rawBody);
    } catch {
      return false;
    }

    const baseUrl = input.credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    let token: string;
    try {
      token = await this.getToken(baseUrl, input.credentials, undefined);
    } catch {
      return false;
    }

    // Header lookup case-insensitive
    const headersLower: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      headersLower[k.toLowerCase()] = v;
    }

    const response = await gwJson<{ verification_status: 'SUCCESS' | 'FAILURE' }>({
      url: `${baseUrl}/v1/notifications/verify-webhook-signature`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: headersLower['paypal-auth-algo'],
        cert_url: headersLower['paypal-cert-url'],
        transmission_id: headersLower['paypal-transmission-id'],
        transmission_sig: headersLower['paypal-transmission-sig'],
        transmission_time: headersLower['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) return false;

    return response.data.verification_status === 'SUCCESS';
  }

  async refund(gatewayTrxId: string, amount: string, credentials: Credentials, ctx?: GatewayContext): Promise<RefundResult> {
    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, ctx);

    // Do not hardcode USD — use currency from credentials if available, otherwise omit currency_code
    // to let PayPal infer from the original capture. Fallback to USD only when no hint exists.
    const currencyHint = (credentials.currency ?? credentials.currency_code ?? '').toUpperCase();
    const bodyPayload: Record<string, unknown> = {};
    if (amount) {
      if (currencyHint) {
        bodyPayload.amount = { value: amount, currency_code: currencyHint };
      } else {
        // Provide currency_code USD as last resort but prefer to omit if unknown;
        // PayPal requires currency_code for partial refunds, so we default to USD only when forced.
        bodyPayload.amount = { value: amount, currency_code: 'USD' };
      }
    }

    const response = await gwJson<{ id: string; status: string }>({
      url: `${baseUrl}/v2/payments/captures/${encodeURIComponent(gatewayTrxId)}/refund`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyPayload),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      const err = response.data as { message?: string } | null;
      return { success: false, error: err?.message ?? response.text ?? String(response.status) };
    }

    const data = response.data;
    return {
      success: data.status === 'COMPLETED' || data.status === 'PENDING',
      refund_id: data.id,
    };
  }

  private async getToken(baseUrl: string, credentials: Credentials, ctx?: GatewayContext): Promise<string> {
    // Cache key is per-mode + per-client_id to isolate sandbox vs live tokens
    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const cacheKey = `paypal:token:${mode}:${credentials.client_id ?? ''}`;
    if (ctx?.kv && cacheKey) {
      const cached = await ctx.kv.get(cacheKey);
      if (cached) {
        // If KV stores JSON envelope (TokenCache), try parse; otherwise raw string
        try {
          const parsed = JSON.parse(cached) as { token?: string; expiresAtMs?: number };
          if (parsed && typeof parsed.token === 'string' && typeof parsed.expiresAtMs === 'number') {
            if (parsed.expiresAtMs > Date.now() + 30_000) return parsed.token;
          } else if (typeof cached === 'string' && cached) {
            // Legacy raw string in KV — treat as valid (TTL-based), will be refreshed on next put
            // Avoid returning obviously expired entries: no timestamp, so we rely on KV TTL
            return cached;
          }
        } catch {
          if (cached) return cached;
        }
      }
    }

    const basicAuth = btoa(`${credentials.client_id}:${credentials.client_secret}`);
    const response = await gwJson<{ access_token: string; expires_in: number }>({
      url: `${baseUrl}/v1/oauth2/token`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      throw new Error(`PayPal token grant failed: ${response.status}`);
    }

    const data = response.data;
    if (!data.access_token) {
      throw new Error('PayPal: no access_token in response');
    }

    // Cache with expiry envelope to avoid returning expired tokens after isolate restart
    if (ctx?.kv && cacheKey) {
      const ttl = data.expires_in ? Math.min(data.expires_in - 60, TOKEN_TTL_SEC) : TOKEN_TTL_SEC;
      const entry = JSON.stringify({ token: data.access_token, expiresAtMs: Date.now() + ttl * 1000 });
      await ctx.kv.put(cacheKey, entry, { expirationTtl: Math.max(60, ttl) });
    }

    return data.access_token;
  }
}
