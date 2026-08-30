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
    const exponent = ZERO_DECIMAL_CURRENCIES.includes(params.currency) ? 0 : 2;
    const amountMinor = toMinorUnits(params.amount, exponent);

    const response = await fetch(`${STRIPE_API_BASE}/payment_intents`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-04-10',
      },
      body: new URLSearchParams({
        amount: String(amountMinor),
        currency: params.currency.toLowerCase(),
        automatic_payment_methods: 'enabled',
        metadata: JSON.stringify({
          edgepay_trx_id: params.trx_id,
          ...(params.metadata ?? {}),
        }),
        // Note: Stripe rejects metadata as object — must be flattened to top-level keys
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.json() as { error?: { message?: string } };
      throw new Error(`Stripe API error: ${error?.error?.message ?? response.statusText}`);
    }

    const data = await response.json() as {
      id: string;
      client_secret: string;
      status: string;
    };

    return {
      session_id: data.id,
      // Client uses Stripe.js with the client_secret to render payment UI
      redirect_url: `${params.redirect_url}?payment_intent=${data.id}&client_secret=${encodeURIComponent(data.client_secret)}`,
    };
  }

  async verify(callbackData: Record<string, unknown>, credentials: Credentials): Promise<VerifyResult> {
    const secretKey = credentials.secret_key;
    const paymentIntentId = String(callbackData.payment_intent ?? '');

    const response = await fetch(`${STRIPE_API_BASE}/payment_intents/${paymentIntentId}`, {
      headers: { 'Authorization': `Bearer ${secretKey}` },
    });

    if (!response.ok) {
      return {
        success: false,
        gateway_trx_id: '',
        amount: null,
        status: 'failed',
        error: `Stripe retrieve failed: ${response.status}`,
      };
    }

    const data = await response.json() as {
      id: string;
      status: 'succeeded' | 'processing' | 'requires_payment_method' | 'canceled';
      amount: number;
      currency: string;
      latest_charge?: string;
    };

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

    const sigHeader = input.headers['stripe-signature'] ?? input.headers['Stripe-Signature'];
    if (!sigHeader) return false;

    // Parse "t=1234567890,v1=abc123...,v0=def456..."
    const parts = sigHeader.split(',').reduce<Record<string, string>>((acc, p) => {
      const [k, v] = p.split('=');
      acc[k] = v;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const v1Signature = parts['v1'];
    if (!timestamp || !v1Signature) return false;

    // Reject timestamps older than 5 minutes (replay protection)
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (age > 300) return false;

    // Compute expected signature: HMAC-SHA256(timestamp + '.' + rawBody, signingSecret)
    const signedPayload = `${timestamp}.${input.rawBody}`;
    const expectedSig = await hmacSha256(signedPayload, signingSecret);

    return timingSafeEqual(expectedSig, v1Signature);
  }

  async refund(gatewayTrxId: string, amount: string, credentials: Credentials): Promise<RefundResult> {
    const secretKey = credentials.secret_key;
    if (!secretKey) return { success: false, error: 'Missing secret_key' };

    // gatewayTrxId is the Stripe charge ID (ch_...) or PaymentIntent ID (pi_...)
    const response = await fetch(`${STRIPE_API_BASE}/refunds`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        payment_intent: gatewayTrxId,
        amount: String(toMinorUnits(amount, 2)),
      }).toString(),
    });

    if (!response.ok) {
      const error = await response.json() as { error?: { message?: string } };
      return { success: false, error: error?.error?.message ?? response.statusText };
    }

    const data = await response.json() as { id: string; status: string };
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
