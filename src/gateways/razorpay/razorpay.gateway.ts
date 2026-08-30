/**
 * Razorpay payment gateway adapter.
 *
 * Port of EdgePay's PHP RazorpayGateway.
 * Flow:
 *   1. initiate: POST /v1/orders (Basic Auth: key_id:key_secret)
 *   2. Returns form HTML with embedded Razorpay Checkout.js script
 *   3. After payment, Razorpay redirects with razorpay_order_id,
 *      razorpay_payment_id, razorpay_signature
 *   4. verify: HMAC-SHA256(order_id + '|' + payment_id, key_secret)
 */

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type RefundResult, type VerifyWebhookInput, type Credentials } from '../base';
import { hmacSha256, timingSafeEqual } from '../../lib/crypto';
import { toMinorUnits, fromMinorUnits } from '../../lib/money';

const API_BASE = 'https://api.razorpay.com/v1';
const SUPPORTED_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'SGD', 'AED', 'BDT'];

export class RazorpayGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'Razorpay',
      slug: 'razorpay',
      version: '1.0.0',
      description: 'Razorpay payment gateway integration',
      author: 'EdgePay Core',
      type: 'gateway',
      supported_currencies: SUPPORTED_CURRENCIES,
      capabilities: ['refund', 'webhook'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'key_id', label: 'Key ID', type: 'text', required: true, placeholder: 'rzp_live_...' },
      { name: 'key_secret', label: 'Key Secret', type: 'password', required: true },
      { name: 'webhook_secret', label: 'Webhook Secret', type: 'password', required: false },
    ];
  }

  async initiate(params: InitiateParams, credentials: Credentials): Promise<InitiateResult> {
    const keyId = credentials.key_id;
    const keySecret = credentials.key_secret;
    if (!keyId || !keySecret) throw new Error('Razorpay: missing key_id or key_secret');

    const amountMinor = toMinorUnits(params.amount, 2);
    const basicAuth = btoa(`${keyId}:${keySecret}`);

    const response = await fetch(`${API_BASE}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountMinor,
        currency: params.currency.toUpperCase(),
        receipt: params.trx_id,
        payment_capture: 1,
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { error?: { description?: string } };
      throw new Error(`Razorpay create order failed: ${err?.error?.description ?? response.status}`);
    }

    const data = await response.json() as { id: string };

    // Build auto-submit form (same approach as PHP original)
    const formHtml = `
    <form action="${escapeHtml(params.redirect_url)}" method="POST" id="razorpay-form">
      <script src="https://checkout.razorpay.com/v1/checkout.js"
        data-key="${escapeHtml(keyId)}"
        data-amount="${amountMinor}"
        data-currency="${escapeHtml(params.currency.toUpperCase())}"
        data-order_id="${escapeHtml(data.id)}"
        data-buttontext="Pay with Razorpay"
        data-name="EdgePay Merchant"
        data-theme.color="#1890FF">
      </script>
      <input type="hidden" name="razorpay_order_id" value="${escapeHtml(data.id)}">
      <input type="hidden" name="trx_id" value="${escapeHtml(params.trx_id)}">
    </form>
    <script>document.getElementById("razorpay-form").submit();</script>`;

    return {
      form_html: formHtml,
      session_id: data.id,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials): Promise<VerifyResult> {
    const orderId = String(callbackData.razorpay_order_id ?? '');
    const paymentId = String(callbackData.razorpay_payment_id ?? '');
    const signature = String(callbackData.razorpay_signature ?? '');

    if (!orderId || !paymentId || !signature) {
      return { success: false, gateway_trx_id: '', amount: null, status: 'failed', error: 'Missing Razorpay callback params' };
    }

    const keySecret = credentials.key_secret;
    const expectedSig = await hmacSha256(`${orderId}|${paymentId}`, keySecret);

    if (!timingSafeEqual(expectedSig, signature)) {
      return { success: false, gateway_trx_id: paymentId, amount: null, status: 'failed', error: 'Signature mismatch' };
    }

    // Fetch payment details for amount verification
    const basicAuth = btoa(`${credentials.key_id}:${keySecret}`);
    const response = await fetch(`${API_BASE}/payments/${paymentId}`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
    });

    let amount: string | null = null;
    if (response.ok) {
      const data = await response.json() as { amount: number; currency: string; status: string };
      amount = fromMinorUnits(data.amount, 2);
    }

    return {
      success: true,
      gateway_trx_id: paymentId,
      amount,
      status: 'completed',
      trx_id: String(callbackData.trx_id ?? ''),
    };
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<boolean> {
    const webhookSecret = input.credentials.webhook_secret;
    if (!webhookSecret) return false;

    const sigHeader = input.headers['x-razorpay-signature'] ?? input.headers['X-Razorpay-Signature'];
    if (!sigHeader) return false;

    const expectedSig = await hmacSha256(input.rawBody, webhookSecret);
    return timingSafeEqual(expectedSig, sigHeader);
  }

  async refund(gatewayTrxId: string, amount: string, credentials: Credentials): Promise<RefundResult> {
    const basicAuth = btoa(`${credentials.key_id}:${credentials.key_secret}`);
    const response = await fetch(`${API_BASE}/payments/${gatewayTrxId}/refund`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: toMinorUnits(amount, 2),
      }),
    });

    if (!response.ok) {
      const err = await response.json() as { error?: { description?: string } };
      return { success: false, error: err?.error?.description ?? response.statusText };
    }

    const data = await response.json() as { id: string; status: string };
    return {
      success: data.status === 'processed' || data.status === 'pending',
      refund_id: data.id,
    };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
