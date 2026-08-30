/**
 * bKash API payment gateway adapter — tokenized checkout flow.
 *
 * Port of EdgePay's PHP BkashApiGateway. Three-step flow:
 *   1. Grant token (POST /tokenized/checkout/token/grant)
 *   2. Create payment (POST /tokenized/checkout/create) → returns bkashURL
 *   3. Execute payment (POST /tokenized/checkout/execute) after redirect
 *
 * Token caching: bKash tokens are valid ~60 min. EdgePay PHP uses a static
 * array cache that persists across FPM worker invocations. In Workers, each
 * isolate is ephemeral — we MUST cache in KV with 55min TTL.
 *
 * Sandbox URL: https://tokenized.sandbox.bka.sh/v1.2.0-beta
 * Live URL:    https://tokenized.pay.bka.sh/v1.2.0-beta
 */

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type Credentials, type GatewayContext } from '../base';

const SANDBOX_BASE = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';
const LIVE_BASE = 'https://tokenized.pay.bka.sh/v1.2.0-beta';
const TOKEN_KV_KEY_PREFIX = 'bkash:token:';
const TOKEN_TTL_SEC = 3300; // 55 minutes (bKash tokens live 60min)

export class BkashApiGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'bKash API',
      slug: 'bkash-api',
      version: '1.0.0',
      description: 'bKash tokenized checkout API integration',
      author: 'EdgePay Core',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'app_key', label: 'App Key', type: 'text', required: true },
      { name: 'app_secret', label: 'App Secret', type: 'password', required: true },
      { name: 'username', label: 'Username', type: 'text', required: true },
      { name: 'password', label: 'Password', type: 'password', required: true },
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
    if (!credentials.app_key || !credentials.app_secret || !credentials.username || !credentials.password) {
      throw new Error('bKash: missing credentials');
    }

    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_BASE : SANDBOX_BASE;
    const token = await this.getToken(baseUrl, credentials, ctx);

    // Sanitize trx_id — bKash only accepts alphanumeric
    const sanitizedTrxId = params.trx_id.replace(/[^a-zA-Z0-9]/g, '');

    const response = await fetch(`${baseUrl}/tokenized/checkout/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'X-APP-Key': credentials.app_key,
      },
      body: JSON.stringify({
        mode: '0011',
        payerReference: sanitizedTrxId,
        callbackURL: params.redirect_url,
        amount: params.amount,
        currency: 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: sanitizedTrxId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`bKash create payment failed: ${response.status} ${errorText}`);
    }

    const data = await response.json() as {
      bkashURL?: string;
      paymentID?: string;
      statusCode?: string;
      statusMessage?: string;
    };

    if (!data.bkashURL) {
      const err = data.statusCode ? `[${data.statusCode}] ${data.statusMessage}` : 'Unknown';
      throw new Error(`bKash error: ${err}`);
    }

    return {
      redirect_url: data.bkashURL,
      session_id: data.paymentID ?? undefined,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, ctx?: GatewayContext): Promise<VerifyResult> {
    // Input guard FIRST: never spend a token-grant subrequest (or throw on
    // grant failure) for a callback that cannot be verified anyway.
    const paymentId = String(callbackData.paymentID ?? '');
    if (!paymentId) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: 'Missing paymentID' };
    }

    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_BASE : SANDBOX_BASE;
    const token = await this.getToken(baseUrl, credentials, ctx);

    const response = await fetch(`${baseUrl}/tokenized/checkout/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': token,
        'X-APP-Key': credentials.app_key,
      },
      body: JSON.stringify({ paymentID: paymentId }),
    });

    if (!response.ok) {
      return {
        success: false,
        gateway_trx_id: '',
        amount: null,
        status: 'failed',
        error: `bKash execute failed: ${response.status}`,
      };
    }

    const data = await response.json() as {
      statusCode?: string;
      transactionStatus?: string;
      trxID?: string;
      amount?: string;
    };

    const success = data.statusCode === '0000' && data.transactionStatus === 'Completed';

    return {
      success,
      gateway_trx_id: data.trxID ?? '',
      amount: data.amount ?? null,
      currency: 'BDT',
      status: success ? 'completed' : 'failed',
    };
  }

  /**
   * Get or refresh a bKash API token. Caches in KV with 55-minute TTL.
   * In EdgePay PHP this used a static array cache — that doesn't work in
   * Workers (isolates are ephemeral). KV is the right cache layer here.
   */
  private async getToken(baseUrl: string, credentials: Credentials, ctx?: GatewayContext): Promise<string> {
    const cacheKey = `${TOKEN_KV_KEY_PREFIX}${credentials.app_key}`;

    // Check KV cache
    if (ctx?.kv) {
      const cached = await ctx.kv.get(cacheKey);
      if (cached) return cached;
    }

    // Grant new token
    const response = await fetch(`${baseUrl}/tokenized/checkout/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'username': credentials.username,
        'password': credentials.password,
      },
      body: JSON.stringify({
        app_key: credentials.app_key,
        app_secret: credentials.app_secret,
      }),
    });

    if (!response.ok) {
      throw new Error(`bKash token grant failed: ${response.status}`);
    }

    const data = await response.json() as { id_token?: string };
    if (!data.id_token) {
      throw new Error('bKash: token grant returned no id_token');
    }

    // Cache for 55 min (bKash tokens expire at 60min)
    if (ctx?.kv) {
      await ctx.kv.put(cacheKey, data.id_token, { expirationTtl: TOKEN_TTL_SEC });
    }

    return data.id_token;
  }
}
