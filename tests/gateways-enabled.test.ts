/**
 * Gateway-plugin selection tests (v0.2.3 — ENABLED_GATEWAYS platform gate).
 *
 * Covers:
 *   1. The pure parser: defaults, aliases, dedup, separators, case/whitespace
 *      tolerance, typo feedback, and the FAIL-CLOSED rule (an explicit list of
 *      only-unknown tokens enables NOTHING — never silently everything).
 *   2. Memoized env access + the isGatewayEnabled / assertGatewayEnabled
 *      helpers (422 GATEWAY_DISABLED error contract).
 *   3. Route wiring: GET /api/v1/gateways requires bearer auth; the install
 *      requirements check surfaces the selection; POST /webhook/{slug} for an
 *      unregistered slug stays a clean 404.
 */

import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  parseEnabledGateways,
  gatewaySelection,
  isGatewayEnabled,
  assertGatewayEnabled,
  IMPLEMENTED_GATEWAY_SLUGS,
} from '../src/gateways/enabled';
import { GatewayDisabledError } from '../src/lib/error';

const ALL = [...IMPLEMENTED_GATEWAY_SLUGS];

describe('parseEnabledGateways — the pure parser', () => {
  it('unset / blank means ALL gateways (v0.2.2 back-compat)', () => {
    for (const raw of [undefined, null, '', '   ']) {
      const sel = parseEnabledGateways(raw as string | undefined | null);
      expect(sel.enabled).toEqual(ALL);
      expect(sel.allEnabled).toBe(true);
      expect(sel.dropped).toEqual([]);
    }
  });

  it('"all" / "*" mean ALL gateways', () => {
    for (const raw of ['all', 'ALL', '*']) {
      const sel = parseEnabledGateways(raw);
      expect(sel.enabled).toEqual(ALL);
      expect(sel.allEnabled).toBe(true);
    }
  });

  it('maps friendly aliases to canonical registry slugs', () => {
    expect(parseEnabledGateways('bkash').enabled).toEqual(['bkash-api']);
    expect(parseEnabledGateways('nagad').enabled).toEqual(['nagad-merchant-api']);
    expect(parseEnabledGateways('nagad-merchant-api').enabled).toEqual(['nagad-merchant-api']);
  });

  it('accepts the canonical slug AND the alias in one list', () => {
    const sel = parseEnabledGateways('stripe,bkash,bkash-api');
    expect(sel.enabled).toEqual(['stripe', 'bkash-api']); // deduped, order preserved
  });

  it('splits on commas, semicolons and/or whitespace; case-insensitive', () => {
    expect(parseEnabledGateways(' STRIPE , PayPal;razorpay  nagad ').enabled).toEqual([
      'stripe',
      'paypal',
      'razorpay',
      'nagad-merchant-api',
    ]);
  });

  it('collects unknown tokens as dropped (typo feedback, not a crash)', () => {
    const sel = parseEnabledGateways('stripe,stripe-checkout,pypl');
    expect(sel.enabled).toEqual(['stripe']);
    expect(sel.dropped).toEqual(['stripe-checkout', 'pypl']);
  });

  it('FAILS CLOSED: only-unknown lists enable NOTHING', () => {
    const sel = parseEnabledGateways('bogus,alsobogus');
    expect(sel.enabled).toEqual([]);
    expect(sel.allEnabled).toBe(false);
    expect(sel.dropped).toEqual(['bogus', 'alsobogus']);
  });
});

describe('gatewaySelection — memoized env access', () => {
  it('returns the SAME object for the same raw value (memoized)', () => {
    const a = gatewaySelection('stripe,paypal');
    const b = gatewaySelection('stripe,paypal');
    expect(a).toBe(b);
  });

  it('re-parses when the raw value changes', () => {
    const a = gatewaySelection('stripe');
    const b = gatewaySelection('paypal');
    expect(a).not.toBe(b);
    expect(b.enabled).toEqual(['paypal']);
  });
});

describe('isGatewayEnabled / assertGatewayEnabled', () => {
  it('isGatewayEnabled reflects the parsed selection', () => {
    const env = { ENABLED_GATEWAYS: 'stripe,bkash' };
    expect(isGatewayEnabled(env, 'stripe')).toBe(true);
    expect(isGatewayEnabled(env, 'bkash-api')).toBe(true);
    expect(isGatewayEnabled(env, 'razorpay')).toBe(false);
  });

  it('assertGatewayEnabled throws 422 GATEWAY_DISABLED with the slug', () => {
    const env = { ENABLED_GATEWAYS: 'stripe' };
    expect(() => assertGatewayEnabled(env, 'razorpay')).toThrow(GatewayDisabledError);
    try {
      assertGatewayEnabled(env, 'razorpay');
    } catch (err) {
      const e = err as GatewayDisabledError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('GATEWAY_DISABLED');
      expect(e.message).toContain('razorpay');
    }
    // Enabled slug must NOT throw
    expect(() => assertGatewayEnabled(env, 'stripe')).not.toThrow();
  });
});

describe('route wiring (SELF worker — ENABLED_GATEWAYS unset = full catalog default)', () => {
  it('GET /api/v1/gateways requires bearer auth (401 envelope)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/gateways');
    expect(res.status).toBe(401);
    const body = await res.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error.code).toBeDefined();
  });

  it('GET /install surfaces the gateway selection + secret posture', async () => {
    await (env as unknown as { KV: KVNamespace }).KV.delete('system:installed');
    // Unique per-call client IP: the /install/* surface is rate limited at
    // 3/hour per IP — unique IPs keep the test deterministic across runs.
    const ip = `203.0.113.${(Math.random() * 254 + 1) | 0}`;
    const res = await SELF.fetch('http://localhost/install', {
      headers: { 'CF-Connecting-IP': ip, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: {
        requirements: Record<string, string>;
        secrets: Record<string, string>;
        gateways: { enabled: string[]; dropped_aliases: string[]; all_enabled: boolean };
        version: string;
      };
    };
    expect(body.success).toBe(true);
    // GET /install surfaces the configured gateway selection
    expect(body.data.gateways.enabled.length).toBeGreaterThan(0);
    expect(body.data.gateways.enabled).toContain('stripe');
    expect(body.data.gateways.enabled).toContain('bkash-api');
    expect(body.data.gateways.dropped_aliases).toEqual([]);
    // Secret posture reports length CLASS only, never content
    for (const key of ['jwt_secret', 'app_key', 'encryption_key']) {
      expect(['ok', 'weak', 'missing']).toContain(body.data.secrets[key]);
    }
    expect(body.data.version).toBe('0.4.5');
  });

  it('POST /webhook/{unregistered} stays a clean 404 UNKNOWN_GATEWAY', async () => {
    const res = await SELF.fetch('http://localhost/webhook/not-a-gateway', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('UNKNOWN_GATEWAY');
  });
});
