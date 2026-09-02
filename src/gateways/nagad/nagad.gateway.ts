/**
 * Nagad Merchant API gateway adapter.
 *
 * Port of EdgePay's PHP NagadMerchantApiGateway.
 * Nagad uses RSA signature verification (different from HMAC gateways).
 *
 * Flow:
 *   1. Initiate: POST /api/merchant/initiate (RSA encrypted payload)
 *   2. Customer redirects to Nagad checkout
 *   3. Callback: Nagad calls back with merchant_id, order_id, payment_ref_id
 *   4. Verify: POST /api/merchant/verify (RSA signed)
 *
 * RSA: Nagad uses PKCS#1 v1.5 with SHA-256 — supported by Web Crypto
 * subtle.importKey / subtle.sign / subtle.verify.
 *
 * Note: In a production deployment, you'd store the Nagad-provided public
 * and private keys as base64 strings in the gateway config (encrypted at
 * rest via AES-256-GCM). The private key is used for signing requests;
 * the public key for verifying callbacks.
 */

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type Credentials } from '../base';
import { base64ToBytes, bytesToBase64 } from '../../lib/crypto';
import { gwJson } from '../kit/http';

const SANDBOX_BASE = 'https://sandbox-ssl.mynagad.com/api/1.0';
const LIVE_BASE = 'https://api.mynagad.com/api/1.0';

export class NagadGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'Nagad Merchant API',
      slug: 'nagad-merchant-api',
      version: '1.0.0',
      description: 'Nagad merchant API integration with RSA signatures',
      author: 'EdgePay Core',
      type: 'gateway',
      supported_currencies: ['BDT'],
      capabilities: ['verification'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'merchant_id', label: 'Merchant ID', type: 'text', required: true, placeholder: '68XXXX...' },
      { name: 'public_key', label: 'Nagad Public Key (PEM or base64)', type: 'textarea', required: true, help: 'Used to verify Nagad callbacks' },
      { name: 'private_key', label: 'Your Private Key (PEM or base64)', type: 'textarea', required: true, help: 'Used to sign outbound requests' },
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

  async initiate(params: InitiateParams, credentials: Credentials): Promise<InitiateResult> {
    const baseUrl = credentials.mode === 'live' ? LIVE_BASE : SANDBOX_BASE;

    // Build payload
    const merchantId = credentials.merchant_id;
    if (!merchantId) throw new Error('Nagad: missing merchant_id');
    const datetime = new Date().toISOString();
    const orderId = params.trx_id;
    const challenge = crypto.randomUUID().replace(/-/g, '');

    // Encrypt sensitive payload with Nagad's public key (RSA-OAEP-SHA256)
    const sensitiveData = JSON.stringify({
      merchantId,
      datetime,
      orderId,
      challenge,
    });

    const publicKey = await this.importPublicKey(credentials.public_key);
    const encryptedSensitive = await crypto.subtle.encrypt(
      { name: 'RSA-OAEP' },
      publicKey,
      new TextEncoder().encode(sensitiveData),
    );

    // Sign the encryptedSensitive with our private key (RSA-PKCS1-v1_5 + SHA-256)
    const privateKey = await this.importPrivateKey(credentials.private_key);
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      privateKey,
      new Uint8Array(encryptedSensitive),
    );

    const response = await gwJson<{
      status?: string;
      callBackUrl?: string;
      paymentReferenceId?: string;
      message?: string;
    }>({
      url: `${baseUrl}/merchant/initiate`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        datetime,
        orderId,
        challenge,
        sensitiveData: bytesToBase64(new Uint8Array(encryptedSensitive)),
        signature: bytesToBase64(new Uint8Array(signature)),
      }),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      throw new Error(`Nagad initiate failed: ${response.status} ${response.text}`);
    }

    const data = response.data;

    if (data.status !== 'Success' || !data.callBackUrl) {
      throw new Error(`Nagad error: ${data.message ?? 'Unknown'}`);
    }

    return {
      redirect_url: data.callBackUrl,
      session_id: data.paymentReferenceId ?? undefined,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials): Promise<VerifyResult> {
    const baseUrl = credentials.mode === 'live' ? LIVE_BASE : SANDBOX_BASE;
    const merchantId = credentials.merchant_id;
    const orderId = String(callbackData.mer_reference ?? callbackData.order_id ?? '').trim();
    const paymentRefId = String(callbackData.payment_ref_id ?? callbackData.paymentReferenceId ?? '').trim();

    if (!orderId || !paymentRefId) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: 'Missing Nagad callback params' };
    }

    // Build verify request — same RSA signature pattern
    const datetime = new Date().toISOString();
    const sensitiveData = JSON.stringify({
      merchantId,
      orderId,
      datetime,
      paymentRefId,
    });

    const privateKey = await this.importPrivateKey(credentials.private_key);
    const signature = await crypto.subtle.sign(
      { name: 'RSASSA-PKCS1-v1_5' },
      privateKey,
      new TextEncoder().encode(sensitiveData),
    );

    const response = await gwJson<{
      status?: string;
      orderId?: string;
      amount?: string;
      trxID?: string;
      message?: string;
    }>({
      url: `${baseUrl}/merchant/verify`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantId,
        orderId,
        paymentRefId,
        datetime,
        sensitiveData,
        signature: bytesToBase64(new Uint8Array(signature)),
      }),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: `Nagad verify failed: ${response.status}` };
    }

    const data = response.data;

    const success = data.status === 'Success';

    return {
      success,
      gateway_trx_id: data.trxID ?? '',
      amount: data.amount ?? null,
      currency: 'BDT',
      status: success ? 'completed' : 'failed',
      trx_id: orderId,
    };
  }

  /**
   * Import a Nagad public key (PEM format or base64 DER).
   * Nagad publishes their public key as a self-signed X.509 cert in PEM.
   */
  private async importPublicKey(pemOrBase64: string): Promise<CryptoKey> {
    const spkiDer = pemToDer(pemOrBase64);
    return crypto.subtle.importKey(
      'spki',
      spkiDer,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
  }

  private async importPrivateKey(pemOrBase64: string): Promise<CryptoKey> {
    const pkcs8Der = pemToDer(pemOrBase64);
    return crypto.subtle.importKey(
      'pkcs8',
      pkcs8Der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
}

/**
 * Convert PEM (base64 with -----BEGIN/END----- headers) to a Uint8Array
 * suitable for subtle.importKey. Also accepts raw base64.
 */
function pemToDer(pemOrBase64: string): Uint8Array {
  const trimmed = pemOrBase64.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    const b64 = trimmed
      .replace(/-----BEGIN [A-Z ]+-----/g, '')
      .replace(/-----END [A-Z ]+-----/g, '')
      .replace(/\s+/g, '');
    return base64ToBytes(b64);
  }
  // Assume raw base64 DER
  return base64ToBytes(trimmed);
}
