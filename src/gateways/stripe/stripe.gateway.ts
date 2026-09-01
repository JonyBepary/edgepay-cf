/**
 * Stripe payment gateway adapter.
 *
 * Implements:
 *   - initiate: creates a PaymentIntent via Stripe API, returns client_secret
 *   - verify:   retrieves PaymentIntent status
 *   - verifyWebhook: HMAC-SHA256 signature verification using Stripe-Signature header
 *   - refund:   POST /v1/refunds
 *
 * Stripe signature format:
 *   t=<timestamp>,v1=<signature>,v0=<previous_signature>
 *   Computed as: HMAC-SHA256(timestamp + '.' + raw_body, webhook_signing_secret)
 */

import { BaseGatewayAdapter, type GatewayMetadata, type GatewayField, type InitiateParams, type InitiateResult, type VerifyResult, type RefundResult, type VerifyWebhookInput, type Credentials } from '../base';
import { hmacSha256, timingSafeEqual } from '../../lib/crypto';
import { toMinorUnits, fromMinorUnits } from '../../lib/money';
import { gwJson } from '../kit/http';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';
const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'BDT', 'INR', 'SGD'];

export class StripeGateway extends BaseGatewayAdapter {
  metadata(): GatewayMetadata {
    return {
      name: 'Stripe',
      slug: 'stripe',
      version: '1.0.0',
      description: 'Stripe payment gateway — global cards + wallets',
      author: 'EdgePay Core',
      type: 'gateway',
      supported_currencies: SUPPORTED_CURRENCIES,
      capabilities: ['refund', 'webhook', 'subscription'],
    };
  }

  fields(): GatewayField[] {
    return [
      { name: 'publishable_key', label: 'Publishable Key', type: 'text', required: true, placeholder: 'pk_live_...' },
      { name: 'secret_key', label: 'Secret Key', type: 'password', required: true, placeholder: 'sk_live_...' },
      { name: 'webhook_secret', label: 'Webhook Signing Secret', type: 'password', required: true, placeholder: 'whsec_...' },
    ];
  }

  async initiate(params: InitiateParams, credentials: Credentials): Promise<InitiateResult> {
    const secretKey = credentials.secret_key;
    if (!secretKey) throw new Error('Stripe: missing secret_key');

    // Convert amount to minor units (Stripe uses cents for USD, but 0-decimal for JPY)
    const exponent = ZERO_DECIMAL_CURRENCIES.includes(params.currency.toUpperCase()) ? 0 : 2;
    const amountMinor = toMinorUnits(params.amount, exponent);

    // Stripe rejects metadata as JSON — must be flattened to metadata[key]=value keys
    const metadataFields: Record<string, string> = {
      'metadata[edgepay_trx_id]': params.trx_id,
    };
    if (params.metadata) {
      for (const [k, v] of Object.entries(params.metadata)) {
        if (v !== undefined && v !== null) {
          metadataFields[`metadata[${k}]`] = String(v);
        }
      }
    }

    const response = await gwJson<{ id: string; client_secret: string; status: string }>({
      url: `${STRIPE_API_BASE}/payment_intents`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-04-10',
      },
      body: new URLSearchParams({
        amount: String(amountMinor),
        currency: params.currency.toLowerCase(),
        'automatic_payment_methods[enabled]': 'true',
        ...metadataFields,
      }).toString(),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      const error = response.data as { error?: { message?: string } } | null;
      throw new Error(`Stripe API error: ${error?.error?.message ?? response.text ?? String(response.status)}`);
    }

    const data = response.data;

    return {
      session_id: data.id,
      // Client uses Stripe.js with the client_secret to render payment UI
      redirect_url: `${params.redirect_url}?payment_intent=${data.id}&client_secret=${encodeURIComponent(data.client_secret)}`,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials): Promise<VerifyResult> {
    const secretKey = credentials.secret_key;
    const paymentIntentId = String(callbackData.payment_intent ?? '').trim();
    if (!paymentIntentId) {
      return {
        success: false,
        gateway_trx_id: '',
        amount: null,
        status: 'failed',
        error: 'Missing payment_intent',
      };
    }

    const response = await gwJson<{
      id: string;
      status: 'succeeded' | 'processing' | 'requires_payment_method' | 'canceled';
      amount: number;
      currency: string;
      latest_charge?: string;
    }>({
      url: `${STRIPE_API_BASE}/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${secretKey}` },
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      return {
        success: false,
        gateway_trx_id: '',
        amount: null,
        status: 'failed',
        error: `Stripe retrieve failed: ${response.status}`,
      };
    }

    const data = response.data;

    const exponent = ZERO_DECIMAL_CURRENCIES.includes(data.currency.toUpperCase()) ? 0 : 2;
    const amount = fromMinorUnits(data.amount, exponent);

    const statusMap: Record<string, VerifyResult['status']> = {
      succeeded: 'completed',
      processing: 'pending',
      requires_payment_method: 'failed',
      canceled: 'cancelled',
    };

    return {
      success: data.status === 'succeeded',
      gateway_trx_id: data.latest_charge ?? data.id,
      amount,
      currency: data.currency.toUpperCase(),
      status: statusMap[data.status] ?? 'pending',
    };
  }

  async verifyWebhook(input: VerifyWebhookInput): Promise<boolean> {
    const signingSecret = input.credentials.webhook_secret;
    if (!signingSecret) return false;

    // Header lookup is case-insensitive — normalize keys
    const headerKey = Object.keys(input.headers).find(k => k.toLowerCase() === 'stripe-signature');
    const sigHeader = headerKey ? input.headers[headerKey] : undefined;
    if (!sigHeader) return false;

    // Parse "t=1234567890,v1=abc123...,v0=def456..."
    const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
      const eq = p.indexOf('=');
      if (eq === -1) return acc;
      const k = p.slice(0, eq).trim();
      const v = p.slice(eq + 1).trim();
      if (k) acc[k] = v;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const v1Signature = parts['v1'];
    if (!timestamp || !v1Signature) return false;

    // Validate timestamp is numeric
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;

    // Reject timestamps outside 5-minute tolerance (replay protection)
    // Use integer seconds and check both past and future drift
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > 300) return false;

    // Compute expected signature: HMAC-SHA256(timestamp + '.' + rawBody, signingSecret)
    const signedPayload = `${timestamp}.${input.rawBody}`;
    const expectedSig = await hmacSha256(signedPayload, signingSecret);

    return timingSafeEqual(expectedSig, v1Signature);
  }

  async refund(gatewayTrxId: string, amount: string, credentials: Credentials): Promise<RefundResult> {
    const secretKey = credentials.secret_key;
    if (!secretKey) return { success: false, error: 'Missing secret_key' };
    if (!gatewayTrxId) return { success: false, error: 'Missing gateway transaction ID' };

    // Validate amount is a proper money string
    let amountMinor: number;
    try {
      // Stripe refund amount is in minor units; determine exponent conservatively as 2
      // For zero-decimal currencies the charge amount was already validated at initiate,
      // but refund without currency context defaults to 2 — caller should ensure correctness.
      amountMinor = toMinorUnits(amount, 2);
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : 'Invalid amount' };
    }

    // gatewayTrxId may be a charge (ch_...) or payment_intent (pi_...)
    // Stripe's /v1/refunds accepts either `charge` or `payment_intent`
    const refundFields: Record<string, string> = {
      amount: String(amountMinor),
    };
    if (gatewayTrxId.startsWith('ch_')) {
      refundFields['charge'] = gatewayTrxId;
    } else {
      refundFields['payment_intent'] = gatewayTrxId;
    }

    const response = await gwJson<{ id: string; status: string }>({
      url: `${STRIPE_API_BASE}/refunds`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(refundFields).toString(),
      timeoutMs: 15000,
    });

    if (!response.ok || response.data === null) {
      const error = response.data as { error?: { message?: string } } | null;
      return { success: false, error: error?.error?.message ?? response.text ?? String(response.status) };
    }

    const data = response.data;
    return {
      success: data.status === 'succeeded' || data.status === 'pending',
      refund_id: data.id,
    };
  }
}

const ZERO_DECIMAL_CURRENCIES = [
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
];
