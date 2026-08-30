/**
 * PortWallet gateway adapter — hand port of EdgePay-Gateway-Plugin/portwallet.
 *
 * Flow (Bearer-token invoice + IPN check):
 *   1. POST /payment/v2/invoice with Bearer base64(appKey:md5(secret+timestamp))
 *      -> data.invoice_id + payment redirect
 *   2. Callback carries invoice_id; server-side verification via
 *      GET /payment/v2/invoice/ipn/{invoice_id}/{amount}
 *
 * PORT-SECURITY vs upstream:
 *   - sandbox "SIM_" fake-success fallbacks in initiate/verify stripped —
 *     API failures now throw / fail closed (never fake money movement).
 *   - bearer token is derived per call (md5 of secret+unix timestamp — the
 *     provider's mandated scheme, legacy hash in lib/hash.ts).
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
import { gwJson } from '../kit/http';
import { md5Hex } from '../../lib/hash';

const SANDBOX_URL = 'https://api-sandbox.portwallet.com';
const LIVE_URL = 'https://api.portwallet.com';

interface PortwalletInvoiceResponse {
  data?: {
    invoice_id?: string;
    payment_url?: string;
    status?: string;
  };
  status?: string;
}

export class PortWalletGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'PortWallet',
      slug: 'portwallet',
      version: '1.0.0',
      description: 'PortWallet payment gateway integration for Bangladesh',
      author: 'EdgePay Gateway Plugin Suite (AGPLv3) — EdgePay port',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'app_key', label: 'App Key', type: 'text' as const, required: true },
      { name: 'secret_key', label: 'Secret Key', type: 'password' as const, required: true },
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

  private async bearerToken(appKey: string, secretKey: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const authHash = await md5Hex(`${secretKey}${timestamp}`);
    return `Bearer ${btoa(`${appKey}:${authHash}`)}`;
  }

  async initiate(params: InitiateParams, credentials: Credentials, _ctx?: GatewayContext): Promise<InitiateResult> {
    const appKey = credentials.app_key ?? '';
    const secretKey = credentials.secret_key ?? '';
    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';

    if (appKey === '' || secretKey === '') {
      throw new Error('PortWallet: missing App Key or Secret Key.');
    }

    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;
    const authorization = await this.bearerToken(appKey, secretKey);
    const amountDecimal = Number(params.amount).toFixed(2);

    const res = await gwJson<PortwalletInvoiceResponse>({
      url: `${baseUrl}/payment/v2/invoice`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
      },
      body: JSON.stringify({
        order: {
          amount: Number(amountDecimal),
          currency: params.currency,
          redirect_url: params.redirect_url,
          ipn_url: params.redirect_url,
          reference: params.trx_id,
        },
        product: {
          name: `Payment Ref: ${params.trx_id}`,
          description: 'Payment Transaction',
        },
        billing: {
          customer: {
            name: 'Customer',
            email: 'customer@example.com',
            phone: '01700000000',
            address: {
              street: 'Dhaka',
              city: 'Dhaka',
              state: 'Dhaka',
              zipcode: 1200,
              country: 'BGD',
            },
          },
        },
      }),
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null) {
      throw new Error(`PortWallet: HTTP ${res.status} ${res.text}`);
    }

    const data = res.data.data ?? {};
    const paymentUrl = data.payment_url ?? data.invoice_id;

    return {
      redirect_url: (paymentUrl || undefined) as string | undefined,
      session_id: data.invoice_id,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, _ctx?: GatewayContext): Promise<VerifyResult> {
    const cb = callbackData as Record<string, unknown>;
    const appKey = credentials.app_key ?? '';
    const secretKey = credentials.secret_key ?? '';
    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';

    const invoiceId = String(cb.invoice_id ?? cb.gateway_trx_id ?? '');
    const amount = String(cb.amount ?? '0.00');

    if (invoiceId === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    // SIM_ prefixed IDs only exist in upstream's sandbox simulator — stripped
    // from this port; treat them as failures rather than fake successes.
    if (invoiceId.startsWith('SIM_') || amount.startsWith('SIM_')) {
      return { success: false, gateway_trx_id: invoiceId, amount: null, status: 'failed' as const };
    }

    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;
    const authorization = await this.bearerToken(appKey, secretKey);
    const amountDecimal = Number.isNaN(Number(amount)) ? '0.00' : Number(amount).toFixed(2);

    const res = await gwJson<PortwalletInvoiceResponse>({
      url: `${baseUrl}/payment/v2/invoice/ipn/${encodeURIComponent(invoiceId)}/${encodeURIComponent(amountDecimal)}`,
      method: 'GET',
      headers: { Authorization: authorization },
      timeoutMs: 15000,
    });

    if (res.status !== 200 || res.data === null) {
      return { success: false, gateway_trx_id: invoiceId, amount: amountDecimal, status: 'failed' as const };
    }

    const data = (res.data.data ?? {}) as Record<string, unknown>;
    const status = String(data.status ?? '').toUpperCase();
    const success = status === 'APPROVED' || status === 'VALID' || status === 'COMPLETED';

    return {
      success,
      gateway_trx_id: invoiceId,
      amount: amountDecimal,
      status: success ? ('completed' as const) : ('failed' as const),
    };
  }
}
