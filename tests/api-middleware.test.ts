/**
 * API middleware tests (v0.2.2 — audit P2).
 *
 * Covers:
 *   1. CORS fail-closed allowlist — only origins in ALLOWED_ORIGINS get
 *      Access-Control-Allow-Origin; everything else gets nothing. The test
 *      worker is configured with ALLOWED_ORIGINS="https://allowed.example"
 *      (vitest.config.ts miniflare bindings).
 *   2. The previously-dead security-headers middleware, now mounted on
 *      /api/* and /webhook/* (nonce CSP + frame/nosniff/referrer headers).
 *   3. The zod request schemas backing POST /payments and POST /refunds.
 *   4. Miniflare binding MERGE semantics — the single overridden var must
 *      not wipe the wrangler.toml [vars] (health reports APP_VERSION).
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { createPaymentSchema, createRefundSchema } from '../src/lib/validation';

describe('CORS — fail-closed origin allowlist (audit P2)', () => {
  it('does NOT set Access-Control-Allow-Origin for a disallowed origin', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('echoes the allowed origin when it is allowlisted', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      headers: { Origin: 'https://allowed.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
  });

  it('preflight from a disallowed origin gets NO CORS origin grant', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    // The browser gate is Access-Control-Allow-Origin — hono's cors sets
    // Allow-Methods unconditionally on prelights, but without ACAO the
    // browser rejects the preflight. Assert the actual security boundary:
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('preflight from an allowed origin is granted', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://allowed.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://allowed.example');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });

  it('still answers requests with no Origin header (server-to-server)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('security headers on JSON surfaces (audit P2 — mounted middleware)', () => {
  it('sets a nonce CSP on /api/* responses', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('sets X-Frame-Options, nosniff and Referrer-Policy on /api/*', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it('sets the same hardening on /webhook/* responses', async () => {
    // Any webhook POST — signature failure is expected; headers must still be set.
    const res = await SELF.fetch('http://localhost/webhook/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'evt_test' }),
    });
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy();
  });
});

describe('zod request schemas (audit P2)', () => {
  it('accepts a valid payment creation body', () => {
    const parsed = createPaymentSchema.safeParse({
      amount: '100.50',
      currency: 'BDT',
      description: 'test order',
      gateway_id: 1,
      expires_in_seconds: 900,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts lowercase currency (upper-cased by the handler)', () => {
    const parsed = createPaymentSchema.safeParse({ amount: '10.00', currency: 'bdt' });
    expect(parsed.success).toBe(true);
  });

  it('rejects amounts with 3+ fraction digits, negatives and non-numeric', () => {
    expect(createPaymentSchema.safeParse({ amount: '10.555', currency: 'BDT' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ amount: '-5.00', currency: 'BDT' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ amount: 'abc', currency: 'BDT' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ currency: 'BDT' }).success).toBe(false);
  });

  it('rejects malformed currencies and out-of-range fields', () => {
    expect(createPaymentSchema.safeParse({ amount: '10.00', currency: 'BD' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ amount: '10.00', currency: 'BDT', expires_in_seconds: 1 }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ amount: '10.00', currency: 'BDT', gateway_id: -1 }).success).toBe(false);
  });

  it('refund schema requires transaction_id and validates optional amount', () => {
    expect(createRefundSchema.safeParse({ transaction_id: 'op_123' }).success).toBe(true);
    expect(createRefundSchema.safeParse({ transaction_id: 'op_123', amount: '5.00', reason: 'dup' }).success).toBe(true);
    expect(createRefundSchema.safeParse({}).success).toBe(false);
    expect(createRefundSchema.safeParse({ transaction_id: 'op_123', amount: '5.555' }).success).toBe(false);
  });
});

describe('miniflare bindings merge (test-infrastructure guard)', () => {
  it('the ALLOWED_ORIGINS test override does NOT wipe wrangler.toml [vars]', async () => {
    // If miniflare `bindings` REPLACED (instead of merged with) the wrangler
    // vars, APP_VERSION would be undefined here.
    const res = await SELF.fetch('http://localhost/api/v1/health');
    const body = await res.json() as { data: { version: string; environment: string } };
    expect(body.data.version).toBe('0.2.3');
    expect(body.data.environment).toBe('production');
  });
});
