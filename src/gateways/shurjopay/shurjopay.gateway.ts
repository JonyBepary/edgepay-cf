/**
 * ShurjoPay gateway adapter — hand port of EdgePay-Gateway-Plugin/shurjopay.
 *
 * Flow (tokenized hosted checkout):
 *   1. POST /api/get_token (username+password) -> { token, store_id }
 *   2. POST /api/secret-pay (Bearer token, form body) -> checkout_url
 *   3. Callback carries order_id (+ status embedded in the callback value);
 *      server-side verification POST /api/verification { order_id } ->
 *      list[0].bank_status === 'success'
 *
 * Token caching: tokens are granted per verify/initiate and cached in KV
 * (55min TTL) + isolate memory via the shared TokenCache kit.
 */

import {
  BaseGatewayAdapter,
  type GatewayMetadata,
  type GatewayField,
  type InitiateParams,
  type InitiateResult,
  type VerifyResult,
  type Credentials,
  type GatewayContext,
} from '../base';
import { gwJson, formBody } from '../kit/http';
import { TokenCache } from '../kit/token-cache';

const LIVE_URL = 'https://engine.shurjopayment.com';
const SANDBOX_URL = 'https://sandbox.shurjopayment.com';

interface ShurjoToken {
  token?: string;
  store_id?: string;
}

interface ShurjoPayResponse {
  checkout_url?: string;
  message?: string;
}

interface ShurjoVerificationEntry {
  bank_status?: string;
  bank_trx_id?: string;
  amount?: string;
  order_id?: string;
}

export class ShurjopayGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'ShurjoPay',
      slug: 'shurjopay',
      version: '1.0.0',
      description: 'ShurjoPay payment gateway integration for Bangladesh',
      author: 'EdgePay Gateway Plugin Suite (AGPLv3) — EdgePay port',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'username', label: 'Username', type: 'text' as const, required: true },
      { name: 'password', label: 'Password', type: 'password' as const, required: true },
      { name: 'prefix', label: 'Order Prefix', type: 'text' as const, required: true },
      {
        name: 'store_mode', label: 'Mode', type: 'select' as const, required: true,
        options: [
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'live', label: 'Live' },
        ],
        default: 'sandbox',
      },
    ];
  }

  private async getToken(baseUrl: string, credentials: Credentials, ctx?: GatewayContext): Promise<ShurjoToken> {
    const cache = new TokenCache(ctx?.kv);
    const cacheKey = `shurjopay:token:${baseUrl}:${credentials.username ?? ''}`;
    const cachedToken = await cache.get(cacheKey);
    // token response also carries store_id; cache the pair as JSON via token slot
    if (cachedToken) {
      try {
        return JSON.parse(cachedToken) as ShurjoToken;
      } catch {
        /* fall through to grant */
      }
    }

    const res = await gwJson<ShurjoToken>({
      url: `${baseUrl}/api/get_token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username ?? '',
        password: credentials.password ?? '',
      }),
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null || !res.data.token) {
      throw new Error('shurjoPay: authentication failed');
    }
    await cache.put(cacheKey, JSON.stringify(res.data), 3300);
    return res.data;
  }

  async initiate(params: InitiateParams, credentials: Credentials, ctx?: GatewayContext): Promise<InitiateResult> {
    const mode = credentials.store_mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    const tokenData = await this.getToken(baseUrl, credentials, ctx);
    const token = tokenData.token ?? '';
    if (token === '') {
      throw new Error('shurjoPay: authentication failed (empty token)');
    }
    const storeId = tokenData.store_id ?? '';

    const meta = (params.metadata ?? {}) as Record<string, unknown>;
    const separator = params.redirect_url.includes('?') ? '&' : '?';

    const res = await gwJson<ShurjoPayResponse>({
      url: `${baseUrl}/api/secret-pay`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody({
        prefix: credentials.prefix ?? '',
        token,
        return_url: `${params.redirect_url}${separator}status=success`,
        cancel_url: `${params.cancel_url}${separator}status=cancel`,
        store_id: storeId,
        amount: Number(params.amount).toFixed(2),
        order_id: params.trx_id,
        currency: 'BDT',
        customer_name: String(meta.customer_name ?? 'Customer'),
        customer_address: 'Bangladesh',
        customer_phone: String(meta.customer_phone ?? '01700000000'),
        customer_city: 'Dhaka',
        client_ip: '127.0.0.1',
        discount_amount: '0',
        disc_percent: '0',
        customer_email: String(meta.customer_email ?? 'customer@example.com'),
        customer_state: 'Dhaka',
        customer_postcode: '1000',
        customer_country: 'BD',
        shipping_address: '',
        shipping_city: '',
        shipping_country: '',
        received_person_name: '',
        shipping_phone_number: String(meta.customer_phone ?? '01700000000'),
      }),
      timeoutMs: 20000,
    });

    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`shurjoPay: HTTP ${res.status}`);
    }
    if (res.data === null || !res.data.checkout_url) {
      throw new Error(`shurjoPay: initiation error (${res.data?.message ?? 'missing checkout URL'})`);
    }

    return {
      redirect_url: res.data.checkout_url,
      session_id: params.trx_id,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, ctx?: GatewayContext): Promise<VerifyResult> {
    const cb = callbackData as Record<string, unknown>;

    // Upstream extracts order_id from a combined "status?order_id=..." value
    // or a direct order_id / GET param; port keeps the same fallbacks.
    const statusRaw = String(cb.status ?? '');
    let status = statusRaw;
    let orderId = '';
    if (statusRaw.includes('?order_id=')) {
      const [st, oid] = statusRaw.split('?order_id=');
      status = st;
      orderId = oid;
    } else if (cb.order_id !== undefined) {
      orderId = String(cb.order_id);
    }

    if (orderId === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'pending' as const };
    }

    if (status !== 'success') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const mode = credentials.store_mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    let token: string;
    try {
      const tokenData = await this.getToken(baseUrl, credentials, ctx);
      token = tokenData.token ?? '';
    } catch {
      token = '';
    }
    if (token === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const res = await gwJson<ShurjoVerificationEntry[]>({
      url: `${baseUrl}/api/verification`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ order_id: orderId }),
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null || !Array.isArray(res.data)) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const entry = res.data[0];
    if (entry && String(entry.bank_status ?? '').toLowerCase() === 'success') {
      return {
        success: true,
        gateway_trx_id: String(entry.bank_trx_id ?? orderId),
        amount: entry.amount ?? null,
        status: 'completed' as const,
        trx_id: orderId,
      };
    }

    return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
  }
}
