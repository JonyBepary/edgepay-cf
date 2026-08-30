/**
 * SSLCommerz gateway adapter — hand port of OwnPay-Gateway-Plugin/sslcommerz.
 *
 * Flow (hosted checkout, form-encoded):
 *   1. POST /gwprocess/v4/api.php (store credentials in body) -> GatewayPageURL
 *   2. Customer pays on SSLCommerz hosted page
 *   3. Callback redirects back; server-side validation via
 *      GET /validator/api/validationserverAPI.php?val_id=...
 *
 * PORT-NOTES:
 *   - upstream hardcodes placeholder customer contact fields ('Customer',
 *     customer@example.com, 01700000000) — kept for fidelity; real customer
 *     details flow through the platform's PII layer, not the gateway session.
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

const SANDBOX_URL = 'https://sandbox.sslcommerz.com';
const LIVE_URL = 'https://securepay.sslcommerz.com';

interface SslczSessionResponse {
  status?: string;
  failedreason?: string;
  GatewayPageURL?: string;
}

interface SslczValidationResponse {
  status?: string;
  bank_tran_id?: string;
  amount?: string;
  currency?: string;
  tran_id?: string;
  val_id?: string;
}

export class SslCommerzGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'SSLCommerz',
      slug: 'sslcommerz',
      version: '1.0.0',
      description: 'SSLCommerz payment gateway for Bangladesh',
      author: 'OwnPay Gateway Plugin Suite (AGPLv3) — EdgePay port',
      type: 'gateway',
      supported_currencies: ['BDT', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'store_id', label: 'Store ID', type: 'text' as const, required: true },
      { name: 'store_passwd', label: 'Store Password', type: 'password' as const, required: true },
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

    const res = await gwJson<SslczSessionResponse>({
      url: `${baseUrl}/gwprocess/v4/api.php`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({
        store_id: credentials.store_id ?? '',
        store_passwd: credentials.store_passwd ?? '',
        total_amount: params.amount,
        currency: params.currency,
        tran_id: params.trx_id,
        success_url: params.redirect_url,
        fail_url: params.cancel_url,
        cancel_url: params.cancel_url,
        cus_name: 'Customer',
        cus_email: 'customer@example.com',
        cus_phone: '01700000000',
        product_name: 'Payment',
        product_category: 'payment',
        product_profile: 'general',
        shipping_method: 'NO',
      }),
      timeoutMs: 15000,
    });

    if (res.data === null || res.data.status !== 'SUCCESS') {
      const reason = res.data?.failedreason ?? res.text ?? 'invalid response';
      throw new Error(`sslcommerz: ${reason}`);
    }

    return {
      redirect_url: (res.data.GatewayPageURL || undefined) as string | undefined,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, _ctx?: GatewayContext): Promise<VerifyResult> {
    const cb = callbackData as Record<string, unknown>;
    const valId = String(cb.val_id ?? '');

    if (valId === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const baseUrl = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    const res = await gwJson<SslczValidationResponse>({
      url: `${baseUrl}/validator/api/validationserverAPI.php?${formBody({
        val_id: valId,
        store_id: credentials.store_id ?? '',
        store_passwd: credentials.store_passwd ?? '',
        format: 'json',
      })}`,
      method: 'GET',
      timeoutMs: 10000,
    });

    if (res.data === null) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const valid = res.data.status === 'VALID' || res.data.status === 'VALIDATED';

    return {
      success: valid,
      gateway_trx_id: String(res.data.bank_tran_id ?? ''),
      amount: (res.data.amount as string | undefined) ?? null,
      status: valid ? ('completed' as const) : ('failed' as const),
      trx_id: (res.data.tran_id as string | undefined) ?? valId,
    };
  }
}
