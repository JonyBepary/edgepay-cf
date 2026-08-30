/**
 * DBBL Rocket gateway adapter — hand port of OwnPay-Gateway-Plugin/rocket.
 *
 * Flow: auto-submit form POST with an MD5 concat signature (provider-
 * mandated legacy hash — see lib/hash.ts; never used for anything internal).
 *
 * PORT-SECURITY vs upstream:
 *   - upstream verifyWebhook() was `return true;` (accept-all) — ported
 *     FAIL-CLOSED. Payments complete via the checkout callback + the
 *     server-side hash check in verify() below.
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
import { buildAutoSubmitForm } from '../kit/form';
import { md5Hex, timingSafeEqual } from '../../lib/hash';

const SANDBOX_URL = 'https://sandbox.dutchbanglabank.com/rocket/checkout/process';
const LIVE_URL = 'https://rocket.dutchbanglabank.com/rocket/checkout/process';

export class RocketGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'DBBL Rocket',
      slug: 'rocket',
      version: '1.0.0',
      description: 'DBBL Rocket payment gateway integration',
      author: 'OwnPay Gateway Plugin Suite (AGPLv3) — EdgePay port',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'merchant_id', label: 'Merchant ID', type: 'text' as const, required: true },
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

  async initiate(params: InitiateParams, credentials: Credentials, _ctx?: GatewayContext): Promise<InitiateResult> {
    const mode = credentials.mode === 'live' ? 'live' : 'sandbox';
    const url = mode === 'live' ? LIVE_URL : SANDBOX_URL;

    const merchantId = credentials.merchant_id ?? '';
    const secretKey = credentials.secret_key ?? '';
    const amount = Number(params.amount).toFixed(2);

    // Provider-mandated signature: md5(merchantId . trxId . amount . secret)
    const secureHash = await md5Hex(`${merchantId}${params.trx_id}${amount}${secretKey}`);

    const fields: Record<string, string> = {
      merchant_id: merchantId,
      order_id: params.trx_id,
      amount,
      hash: secureHash,
      redirect_url: params.redirect_url,
    };

    return { form_html: buildAutoSubmitForm(url, fields), session_id: params.trx_id };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials, _ctx?: GatewayContext): Promise<VerifyResult> {
    const cb = callbackData as Record<string, unknown>;
    const orderId = String(cb.order_id ?? '');
    const status = String(cb.status ?? '');
    const amount = String(cb.amount ?? '');
    const hash = String(cb.hash ?? '');

    if (orderId === '') {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };
    }

    const merchantId = credentials.merchant_id ?? '';
    const secretKey = credentials.secret_key ?? '';

    // Response signature: md5(merchantId . orderId . amount . status . secret)
    const generatedHash = await md5Hex(`${merchantId}${orderId}${amount}${status}${secretKey}`);
    const success = timingSafeEqual(generatedHash, hash) && status === 'success';

    return {
      success,
      gateway_trx_id: String(cb.transaction_id ?? orderId),
      amount: amount || null,
      status: success ? ('completed' as const) : ('failed' as const),
      trx_id: orderId,
    };
  }

  async verifyWebhook(_input: { rawBody: string; headers: Record<string, string>; credentials: Credentials }): Promise<boolean> {
    // upstream stub returned true — ported fail-closed (see header comment)
    return false;
  }
}
