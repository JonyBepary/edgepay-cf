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

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type RefundResult, type VerifyWebhookInput, type Credentials } from '../base';

const API_BASE_LIVE = 'https://api-m.paypal.com';
const API_BASE_SANDBOX = 'https://api-m.sandbox.paypal.com';
const TOKEN_KV_KEY = 'paypal:token';
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

  async initiate(params: InitiateParams, credentials: Credentials, env?: { KV: import('../../types/env').Env['KV'] }): Promise<InitiateResult> {
    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, env);

    const response = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: params.trx_id,
          amount: {
            currency_code: params.currency,
            value: params.amount,
          },
          description: params.metadata?.description ?? 'EdgePay payment',
        }],
        application_context: {
          return_url: params.redirect_url,
          cancel_url: params.cancel_url,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      throw new Error(`PayPal create order failed: ${err?.message ?? response.status}`);
    }

    const data = await response.json() as {
      id: string;
      links: Array<{ rel: string; href: string }>;
    };

    const approveLink = data.links.find(l => l.rel === 'approve');
    if (!approveLink) {
      throw new Error('PayPal: no approve link in response');
    }

    return {
      redirect_url: approveLink.href,
      session_id: data.id,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, env?: { KV: import('../../types/env').Env['KV'] }): Promise<VerifyResult> {
    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, env);

    const orderId = String(callbackData.token ?? '');  // PayPal returns ?token=ORDER_ID
    if (!orderId) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: 'Missing PayPal order ID' };
    }

    const response = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        gateway_trx_id: orderId,
        amount: null,
        status: 'failed',
        error: `PayPal capture failed: ${response.status}`,
      };
    }

    const data = await response.json() as {
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
    };

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

    const baseUrl = input.credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, input.credentials, undefined);

    const response = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        auth_algo: input.headers['paypal-auth-algo'],
        cert_url: input.headers['paypal-cert-url'],
        transmission_id: input.headers['paypal-transmission-id'],
        transmission_sig: input.headers['paypal-transmission-sig'],
        transmission_time: input.headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: JSON.parse(input.rawBody),
      }),
    });

    if (!response.ok) return false;

    const data = await response.json() as { verification_status: 'SUCCESS' | 'FAILURE' };
    return data.verification_status === 'SUCCESS';
  }

  async refund(gatewayTrxId: string, amount: string, credentials: Credentials, env?: { KV: import('../../types/env').Env['KV'] }): Promise<RefundResult> {
    const baseUrl = credentials.mode === 'live' ? API_BASE_LIVE : API_BASE_SANDBOX;
    const token = await this.getToken(baseUrl, credentials, env);

    const response = await fetch(`${baseUrl}/v2/payments/captures/${gatewayTrxId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: { value: amount, currency_code: 'USD' },
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { message?: string };
      return { success: false, error: err?.message ?? response.statusText };
    }

    const data = await response.json() as { id: string; status: string };
    return {
      success: data.status === 'COMPLETED' || data.status === 'PENDING',
      refund_id: data.id,
    };
  }

  private async getToken(baseUrl: string, credentials: Credentials, env?: { KV: import('../../types/env').Env['KV'] }): Promise<string> {
    // Check cache (cache key per merchant — would normally include merchant_id in real impl)
    const cacheKey = env?.KV ? await this.cacheKey(credentials) : '';
    if (env?.KV && cacheKey) {
      const cached = await env.KV.get(cacheKey);
      if (cached) return cached;
    }

    const basicAuth = btoa(`${credentials.client_id}:${credentials.client_secret}`);
    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!response.ok) {
      throw new Error(`PayPal token grant failed: ${response.status}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error('PayPal: no access_token in response');
    }

    // Cache
    if (env?.KV && cacheKey) {
      await env.KV.put(cacheKey, data.access_token, { expirationTtl: TOKEN_TTL_SEC });
    }

    return data.access_token;
  }

  private async cacheKey(credentials: Credentials): Promise<string> {
    return `${TOKEN_KV_KEY}:${credentials.client_id}`;
  }
}
