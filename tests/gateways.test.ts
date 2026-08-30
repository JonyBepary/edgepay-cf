/**
 * Gateway adapter tests — verify each implementation has correct metadata
 * and signature verification logic.
 *
 * These are pure unit tests — no Worker invocation, no D1, no KV.
 * They exercise the gateway adapter classes directly.
 */

import { describe, it, expect } from 'vitest';
import { StripeGateway } from '../src/gateways/stripe/stripe.gateway';
import { RazorpayGateway } from '../src/gateways/razorpay/razorpay.gateway';
import { BkashApiGateway } from '../src/gateways/bkash/bkash.gateway';
import { PayPalGateway } from '../src/gateways/paypal/paypal.gateway';
import { NagadGateway } from '../src/gateways/nagad/nagad.gateway';

describe('Stripe gateway', () => {
  const gateway = new StripeGateway();

  it('has correct metadata', () => {
    const meta = gateway.metadata();
    expect(meta.slug).toBe('stripe');
    expect(meta.name).toBe('Stripe');
    expect(meta.capabilities).toContain('refund');
    expect(meta.capabilities).toContain('webhook');
    expect(meta.supported_currencies).toContain('USD');
    expect(meta.supported_currencies.length).toBeGreaterThan(5);
  });

  it('requires publishable_key, secret_key, webhook_secret fields', () => {
    const fields = gateway.fields();
    const names = fields.map(f => f.name);
    expect(names).toContain('publishable_key');
    expect(names).toContain('secret_key');
    expect(names).toContain('webhook_secret');
  });

  it('reports refund + webhook as supported capabilities', () => {
    expect(gateway.supports('refund')).toBe(true);
    expect(gateway.supports('webhook')).toBe(true);
    expect(gateway.supports('subscription')).toBe(true);
    expect(gateway.supports('nonexistent_capability')).toBe(false);
  });
});

describe('Razorpay gateway', () => {
  const gateway = new RazorpayGateway();

  it('has correct metadata', () => {
    const meta = gateway.metadata();
    expect(meta.slug).toBe('razorpay');
    expect(meta.supported_currencies).toContain('INR');
  });

  it('verifies a valid HMAC-SHA256 signature', async () => {
    // Reproduce the signature computation: HMAC-SHA256(orderId + '|' + paymentId, keySecret)
    const orderId = 'order_test123';
    const paymentId = 'pay_test456';
    const keySecret = 'test_secret_key';

    const message = `${orderId}|${paymentId}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keySecret);
    const key = await crypto.subtle.importKey(
      'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    const result = await gateway.verify(
      {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: sigHex,
        trx_id: 'op_test_trx_1',
      },
      { key_id: 'rzp_test_key', key_secret: keySecret },
    );

    expect(result.success).toBe(true);
  });

  it('rejects invalid signatures', async () => {
    const result = await gateway.verify(
      {
        razorpay_order_id: 'order_test',
        razorpay_payment_id: 'pay_test',
        razorpay_signature: 'invalid_signature_hex',
      },
      { key_id: 'rzp_test_key', key_secret: 'test_secret_key' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Signature mismatch');
  });
});

describe('bKash API gateway', () => {
  const gateway = new BkashApiGateway();

  it('has correct metadata', () => {
    const meta = gateway.metadata();
    expect(meta.slug).toBe('bkash-api');
    expect(meta.supported_currencies).toEqual(['BDT']);
    expect(meta.capabilities).toContain('verification');
  });

  it('declares 5 required credential fields', () => {
    const fields = gateway.fields();
    expect(fields.length).toBe(5);
    const names = fields.map(f => f.name);
    expect(names).toEqual(['app_key', 'app_secret', 'username', 'password', 'mode']);
  });
});

describe('PayPal gateway', () => {
  const gateway = new PayPalGateway();

  it('has correct metadata', () => {
    const meta = gateway.metadata();
    expect(meta.slug).toBe('paypal');
    expect(meta.capabilities).toContain('refund');
    expect(meta.capabilities).toContain('webhook');
    expect(meta.supported_currencies).toContain('USD');
  });

  it('requires client_id, client_secret, webhook_id, mode fields', () => {
    const fields = gateway.fields();
    const names = fields.map(f => f.name);
    expect(names).toContain('client_id');
    expect(names).toContain('client_secret');
    expect(names).toContain('webhook_id');
    expect(names).toContain('mode');
  });
});

describe('Nagad gateway', () => {
  const gateway = new NagadGateway();

  it('has correct metadata', () => {
    const meta = gateway.metadata();
    expect(meta.slug).toBe('nagad-merchant-api');
    expect(meta.supported_currencies).toEqual(['BDT']);
    expect(meta.capabilities).toContain('verification');
  });

  it('requires merchant_id, public_key, private_key, mode fields', () => {
    const fields = gateway.fields();
    const names = fields.map(f => f.name);
    expect(names).toContain('merchant_id');
    expect(names).toContain('public_key');
    expect(names).toContain('private_key');
    expect(names).toContain('mode');
  });
});

describe('Gateway registry', () => {
  it('registers all 5 built-in gateways', async () => {
    const { gatewayRegistry } = await import('../src/gateways/index');
    expect(gatewayRegistry.has('stripe')).toBe(true);
    expect(gatewayRegistry.has('paypal')).toBe(true);
    expect(gatewayRegistry.has('bkash-api')).toBe(true);
    expect(gatewayRegistry.has('razorpay')).toBe(true);
    expect(gatewayRegistry.has('nagad-merchant-api')).toBe(true);
    expect(gatewayRegistry.list().length).toBe(5);
  });
});
