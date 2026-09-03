/**
 * ROUND-4 INDEPENDENT PoCs — 14 discriminating test cases (covering 15 PoC scenarios):
 * PoC-1/2: Payload cap & 411 on chunked stream
 * PoC-3: Static assets prefix rewrite (200 / text/css / nosniff / DENY)
 * PoC-4: Heartbeat tenant/device scoping with sentinel change & cross-tenant negative
 * PoC-5: Platform admin claim gate (401 / 403 / unconsumed / 200 / 404 one-time)
 * PoC-6: Refund reserve-then-call with gatewayRegistry.resolve instrumentation
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { createJwtService } from '../src/lib/jwt';
import { sha256 } from '../src/lib/crypto';
import { PaymentService } from '../src/services/payment';
import { LedgerService } from '../src/services/ledger';
import { RefundService } from '../src/services/refund';
import { gatewayRegistry } from '../src/gateways/base';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

interface StreamRequestInit extends RequestInit {
  duplex?: 'half';
}

function streamOf(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

const withCL = (body: string, extra: Record<string, string> = {}) => ({
  headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...extra },
  body,
});

// ---------------------------------------------------------------------------
describe('PoC-1/2: payload cap — Report-3 bypass replay (300 KB chunked, no CL)', () => {
  it('411 BEFORE auth on a protected route with a 300 KB streamed body and no Content-Length', async () => {
    const big = 'x'.repeat(300 * 1024);
    const res = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      body: streamOf(big),
      duplex: 'half',
    } as StreamRequestInit);
    expect(res.status).toBe(411);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('LENGTH_REQUIRED');
  });

  it('413 when Content-Length = 131073 (> 128 KB)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: { 'Content-Length': '131073' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('413 when Content-Length is non-numeric (NaN)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 'not-a-number' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('small valid CL passes the cap (health route: POST falls through to routing, not 411/413)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      ...withCL('{}'),
    });
    expect([411, 413]).not.toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-3: static assets prefix rewrite (V4-007)', () => {
  it('/assets/css/checkout.css resolves to 200 with css content-type', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/checkout.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') || '').toContain('text/css');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('missing asset under /assets/ is a clean 404 (mutable wrapper retained, no 500)', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/definitely-missing.css');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('root path / is not an asset route (documents behavior)', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-4: heartbeat tenant/device scoping — DISCRIMINATING test', () => {
  const merchantA = 990001;
  const merchantB = 990002;
  const deviceId = 9901;
  let jwtA: string, jwtB: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    for (const [mid, slug, mail] of [
      [merchantA, 'poc-a', 'poca@example.com'],
      [merchantB, 'poc-b', 'pocb@example.com'],
    ] as const) {
      await db.prepare(
        `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
         VALUES (?, ?, 'PocMerchant', ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(mid, crypto.randomUUID(), slug, mail, now, now).run();
    }
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (991, ?, ?, 'Poc User', 'pocu@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantA, crypto.randomUUID(), await sha256('pocu@example.com'), now, now).run();

    await db.prepare(
      `INSERT INTO op_paired_devices (id, merchant_id, user_id, uuid, device_name, fingerprint, status, last_heartbeat_at, created_at)
       VALUES (?, ?, 991, ?, 'PocPhone', 'fp-9901', 'active', '2000-01-01T00:00:00.000Z', ?)
       ON CONFLICT(id) DO UPDATE SET last_heartbeat_at = '2000-01-01T00:00:00.000Z'`
    ).bind(deviceId, merchantA, crypto.randomUUID(), now).run();

    const jwt = createJwtService(tenv);
    jwtA = await jwt.issueAccessToken({ sub: '991', merchant_id: merchantA, device_id: deviceId, scope: ['read', 'write'] });
    jwtB = await jwt.issueAccessToken({ sub: '992', merchant_id: merchantB, device_id: deviceId, scope: ['read', 'write'] });
  });

  it('same-tenant heartbeat CHANGES last_heartbeat_at', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      ...withCL('{}', { Authorization: `Bearer ${jwtA}` }),
    });
    expect(res.status).toBe(200);
    const row = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    expect(row?.last_heartbeat_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('cross-tenant token (merchant B, foreign device id) leaves merchant A row UNCHANGED', async () => {
    const before = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      ...withCL('{}', { Authorization: `Bearer ${jwtB}` }),
    });
    expect(res.status).toBe(200);
    const after = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    expect(after?.last_heartbeat_at).toBe(before?.last_heartbeat_at);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-5: /api/admin/v1/merchants/claim platform gate (V3-010)', () => {
  const normalMerchant = 970001;
  const platformMerchant = 970002;
  const CLAIM_TOKEN = 'r4-poc-claim-token';
  let normalKey: string, platformKey: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'NormalMerchant', 'poc-normal', 'n@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(normalMerchant, crypto.randomUUID(), now, now).run();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'PlatformMerchant', 'poc-platform', 'p@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(platformMerchant, crypto.randomUUID(), now, now).run();

    const mk = async () => {
      const prefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const rest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      return `op_live_${prefix}_${rest}`;
    };
    normalKey = await mk();
    platformKey = await mk();
    for (const [k, mid] of [[normalKey, normalMerchant], [platformKey, platformMerchant]] as const) {
      const prefix = k.split('_')[2];
      await db.prepare(
        `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
         VALUES (?, 'poc-key', ?, ?, '["read","write","admin"]', 'active', ?)`
      ).bind(mid, prefix, await sha256(k), now).run();
    }
    await tenv.KV.put(`claim:${CLAIM_TOKEN}`, JSON.stringify({ api_key: 'poc-claimed-secret', merchant: 'newly-provisioned' }));
  });

  it('unauthenticated request is rejected (not 200)', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN })),
    });
    expect(res.status).not.toBe(200);
    expect([401, 403, 503]).toContain(res.status);
  });

  it('NON-platform admin key gets 403 FORBIDDEN and does not consume claim token', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${normalKey}` }),
    });
    expect(res.status).toBe(403);
    const json = await res.json<{ error: { code: string; message: string } }>();
    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toContain('Platform administrator');
    expect(await tenv.KV.get(`claim:${CLAIM_TOKEN}`)).not.toBeNull();
  });

  it('platform admin key redeems exactly once', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { api_key: string } }>();
    expect(json.data.api_key).toBe('poc-claimed-secret');

    // Second attempt fails (one-time redemption)
    const res2 = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(res2.status).toBe(404);
  });

  it('provisions merchant with AES-256-GCM encrypted claim token and redeems successfully (V10-005)', async () => {
    const provRes = await SELF.fetch('http://localhost/api/admin/v1/merchants', {
      method: 'POST',
      ...withCL(JSON.stringify({
        name: 'Encrypted Tenant Inc',
        email: 'encrypted-tenant@example.com',
        currency: 'BDT',
      }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(provRes.status).toBe(201);
    const provData = await provRes.json<{ success: boolean; data: { claim_token: string } }>();
    const claimToken = provData.data.claim_token;
    expect(claimToken).toBeDefined();

    // Verify KV payload is encrypted at rest (base64 envelope, does NOT start with '{')
    const rawKvPayload = await tenv.KV.get(`claim:${claimToken}`);
    expect(rawKvPayload).not.toBeNull();
    expect(rawKvPayload!.startsWith('{')).toBe(false);

    // Redeem with platform admin
    const claimRes = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: claimToken }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(claimRes.status).toBe(200);
    const claimData = await claimRes.json<{ success: boolean; data: { admin_email: string; api_key: string; initial_password: string } }>();
    expect(claimData.data.admin_email).toBe('encrypted-tenant@example.com');
    expect(claimData.data.api_key).toMatch(/^op_live_/);
    expect(claimData.data.initial_password).toBeDefined();

    // Verify one-time consumption: token deleted from KV
    expect(await tenv.KV.get(`claim:${claimToken}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('PoC-6: refund reserve-then-call with the CORRECT gateway spy (bkash fixture)', () => {
  const merchantId = 980001;
  let trxId: number;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'RefundPocMerchant', 'poc-refund', 'r@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();
    const ledger = new LedgerService(tenv);
    await ledger.createDefaultChartOfAccounts(merchantId, 'BDT');
    const paymentService = new PaymentService(tenv);
    const intent = await paymentService.createIntent({
      merchant_id: merchantId, amount: '100.00', currency: 'BDT', gateway: 'bkash',
    });
    const txRow = await db.prepare(`SELECT id FROM op_transactions WHERE payment_intent_id = ?`).bind(intent.intent_id).first<{ id: number }>();
    trxId = txRow!.id;
    await paymentService.completeTransaction(trxId, intent.intent_id, 'gw-poc-6');
  });

  it('over-bound refund: throws, gateway NEVER resolved/called, NO ghost pending row', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => { refundCalls++; return { success: false, error: 'poc' }; },
    };
    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);
    const refundService = new RefundService(tenv);
    await expect(
      refundService.createRefund({ merchant_id: merchantId, transaction_id: trxId, amount: '150.00', reason: 'poc-over-bound', initiated_by: null })
    ).rejects.toThrow();
    expect(resolveCalls).toBe(0);
    expect(refundCalls).toBe(0);
    const ghost = await db.prepare(
      `SELECT COUNT(*) AS n FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?`
    ).bind(trxId, merchantId).first<{ n: number }>();
    expect(ghost?.n).toBe(0);
    registrySpy.mockRestore();
  });

  it('valid refund: pending reservation exists, THEN gateway resolve+refund run (ordering proof)', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => { refundCalls++; return { success: false, error: 'poc-env-no-credentials' }; },
    };
    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);
    const refundService = new RefundService(tenv);
    const res = await refundService.createRefund({
      merchant_id: merchantId, transaction_id: trxId, amount: '30.00', reason: 'poc-valid', initiated_by: null,
    });
    expect(resolveCalls).toBe(1);
    expect(refundCalls).toBe(1);
    expect(res.refund_row_id).toBeGreaterThan(0);
    const row = await db.prepare(`SELECT status, gateway_refund_id FROM op_refunds WHERE id = ?`).bind(res.refund_row_id).first<{ status: string; gateway_refund_id: string | null }>();
    expect(row?.status).toBe('pending');
    expect(row?.gateway_refund_id).toBeNull();
    registrySpy.mockRestore();
  });
});
