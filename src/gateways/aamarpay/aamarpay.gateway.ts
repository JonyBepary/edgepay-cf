/**
 * Aamarpay gateway adapter — hand port of the EdgePay gateway suite
 *
 * Flow (hosted checkout, JSON):
 *   1. POST /jsonpost.php (store credentials + signature in body) -> payment_url
 *   2. Customer pays on the Aamarpay hosted page
 *   3. Callback carries `session`/`opt_a`; server-side verification via
 *      GET /api/v1/trxcheck/request.php?request_id=...
 *
 * PORT-NOTES:
 *   - upstream defaults customer fields when metadata is absent — kept, with
 *     metadata pass-through (customer_email/phone/name from params.metadata).
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

const SANDBOX_URL = 'https://sandbox.aamarpay.com';
const LIVE_URL = 'https://secure.aamarpay.com';

interface AamarpaySessionResponse {
  payment_url?: string;
}

interface AamarpayStatusResponse {
  pay_status?: string;
  status_code?: string;
  bank_trxid?: string;
  amount?: string;
  pg_txnid?: string;
}

export class AamarpayGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'Aamarpay',
      slug: 'aamarpay',
      version: '1.0.0',
      description: 'Aamarpay payment gateway integration',
      author: 'EdgePay Gateway Suite (AGPLv3)',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'store_id', label: 'Store ID', type: 'text' as const, required: true },
      { name: 'signature_key', label: 'Signature Key', type: 'password' as const, required: true },
      {
        name: 'mode', label: 'Mode', type: 'select' as const, required: true,
        options: [
          { value: 'sandbox', label: 'Sandbox' },
          { value: 'live', label: 'Live' },
        ],
        default: 'sandbox',
      },
    ];
  }

  async initiate(params: InitiateParams, credentials: Credentials, _ctx?: GatewayContext): Promise<InitiateResult> {
    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    const meta = (params.metadata ?? {}) as Record<string, unknown>;
    const email = String(meta.customer_email ?? 'customer@example.com');
    const phone = String(meta.customer_phone ?? '01700000000');
    const name = String(meta.customer_name ?? 'Customer');

    const separator = params.redirect_url.includes('?') ? '&' : '?';
    const trxId = params.trx_id;

    const res = await gwJson<AamarpaySessionResponse>({
      url: `${baseUrl}/jsonpost.php`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: credentials.store_id ?? '',
        tran_id: trxId,
        success_url: `${params.redirect_url}${separator}session=${encodeURIComponent(trxId)}`,
        fail_url: params.cancel_url,
        cancel_url: params.cancel_url,
        amount: params.amount,
        currency: params.currency,
        signature_key: credentials.signature_key ?? '',
        desc: `Payment ${trxId}`,
        cus_name: name,
        cus_email: email,
        cus_phone: phone,
        cus_add1: 'Dhaka',
        cus_add2: 'Dhaka',
        cus_city: 'Dhaka',
        cus_state: 'Dhaka',
        cus_postcode: '1200',
        cus_country: 'Bangladesh',
        type: 'json',
        opt_a: trxId,
      }),
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null || !res.data.payment_url) {
      throw new Error(`aamarpay: initiation failed (${res.status}) ${res.text}`);
    }

    return {
      redirect_url: res.data.payment_url,
      session_id: trxId,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, _ctx?: GatewayContext): Promise<VerifyResult> {
    const cb = callbackData as Record<string, unknown>;
    let trxId = String(cb.session ?? cb.pay_status ?? '');
    if (trxId === '' && cb.opt_a !== undefined) {
      trxId = String(cb.opt_a);
    }

    if (trxId === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    const res = await gwJson<AamarpayStatusResponse>({
      url: `${baseUrl}/api/v1/trxcheck/request.php?${formBody({
        request_id: trxId,
        store_id: credentials.store_id ?? '',
        signature_key: credentials.signature_key ?? '',
        type: 'json',
      })}`,
      method: 'GET',
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const paid = res.data.pay_status === 'Successful' && res.data.status_code === '2';

    return {
      success: paid,
      gateway_trx_id: String(res.data.bank_trxid ?? ''),
      amount: (res.data.amount as string | undefined) ?? null,
      status: paid ? ('completed' as const) : ('failed' as const),
      trx_id: (res.data.pg_txnid as string | undefined) ?? trxId,
    };
  }
}
