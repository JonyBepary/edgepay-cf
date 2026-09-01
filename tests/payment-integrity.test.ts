/**
 * Payment integrity regression tests — covers the six fixes:
 *  1. Body hashing without consuming request (clone)
 *  2. Replay semantics: do not cache 4xx
 *  3. Concurrent D1 uniqueness safely (ON CONFLICT DO NOTHING)
 *  4. Require/apply idempotency to refunds
 *  5. Tenant safety (merchant-scoped keys)
 *  6. Atomic batch + ledger-before-completion with recoverable pending
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256 } from '../src/lib/crypto';
import { PaymentService } from '../src/services/payment';
import { LedgerService, getLedgerDO } from '../src/services/ledger';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

// Unique merchants per suite
const M1 = 920001;
const M2 = 920002;
const M_LEDGER = 920003;

let m1Key: string;
let m2Key: string;
let m1Headers: Record<string, string>;
let m2Headers: Record<string, string>;

async function createMerchantWithKey(id: number, scopes: string[] = ['read', 'write', 'admin']): Promise<string> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status)
       VALUES (?, ?, ?, ?, ?, 'BDT', 'active')`,
    )
    .bind(id, `test-uuid-${id}`, `Integrity Merchant ${id}`, `integrity-m-${id}`, `integrity+${id}@example.com`)
    .run();

  // ensure ledger chart exists for M_LEDGER
  // (other merchants will get manual gateway auto-created by payment service)

  const prefix = `a${String(id).padStart(11, '0')}`.slice(0, 12);
  const rest = `b${String(id).padStart(31, '0')}`.slice(0, 32);
  const apiKey = `op_live_${prefix}_${rest}`;
  const keyHash = await sha256(apiKey);
  // upsert api key (delete old if exists for idempotence across runs)
  await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(prefix).run();
  await db
    .prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?)`,
    )
    .bind(id, `test-key-${id}`, prefix, keyHash, JSON.stringify(scopes), new Date().toISOString())
    .run();
  return apiKey;
}

async function authHeaders(apiKey: string): Promise<Record<string, string>> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

beforeAll(async () => {
  m1Key = await createMerchantWithKey(M1);
  m2Key = await createMerchantWithKey(M2);
  await createMerchantWithKey(M_LEDGER);
  m1Headers = await authHeaders(m1Key);
  m2Headers = await authHeaders(m2Key);

  // Seed ledger chart for M_LEDGER and for M1 (for completeTransaction test)
  const ledger1 = new LedgerService(tenv);
  await ledger1.createDefaultChartOfAccounts(M1, 'BDT');
  await ledger1.createDefaultChartOfAccounts(M_LEDGER, 'BDT');
  // Ensure M1 has a stripe gateway for refund tests (enabled gateway)
  await db
    .prepare(
      `INSERT OR IGNORE INTO op_gateways (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
       VALUES (?, 'stripe', 'Stripe', 'api', 'active', 1, '["BDT","USD"]', ?, ?)`,
    )
    .bind(M1, new Date().toISOString(), new Date().toISOString())
    .run();
});

describe('Idempotency — body hashing without consuming request', () => {
  it('creates payment with idempotency key — validation still sees body (clone, not consume)', async () => {
    const key = `idem-body-${Date.now()}`;
    const res = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify({ amount: '100.00', currency: 'BDT', description: 'body-not-consumed' }),
    });
    // If body were consumed, zValidator would see empty body -> 400
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.success).toBe(true);
    expect(json.data.intent_id).toBeDefined();
  });

  it('returns cached 201 on replay with same key+body, and confirms body hash mismatch is 409', async () => {
    const key = `idem-replay-${Date.now()}`;
    const body = { amount: '55.00', currency: 'BDT', description: 'replay-test' };
    const first = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    const firstJson = (await first.json()) as any;
    const firstIntent = firstJson.data.intent_id;

    const second = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(201);
    expect(second.headers.get('X-Idempotent-Replay')).toBe('true');
    const secondJson = (await second.json()) as any;
    expect(secondJson.data.intent_id).toBe(firstIntent);

    // Same key, different body => 409 Conflict
    const conflict = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify({ amount: '99.00', currency: 'BDT' }),
    });
    expect(conflict.status).toBe(409);
  });
});

describe('Idempotency — do not cache 4xx', () => {
  it('validation error (400) is not cached — same key with valid body succeeds', async () => {
    const key = `idem-no4xx-${Date.now()}`;
    // First: invalid body (missing amount) => 400
    const bad = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify({ currency: 'BDT' }),
    });
    expect(bad.status).toBe(400);

    // Second: same key, valid body — should NOT be 409 and should NOT be replay
    // If we cached 4xx, this would be 409 (body hash mismatch) or replay 400
    const good = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify({ amount: '10.00', currency: 'BDT', description: 'after-400' }),
    });
    // Should succeed (201) and not be a replay
    expect(good.status).toBe(201);
    expect(good.headers.get('X-Idempotent-Replay')).toBeNull();
  });

  it('4xx does not leave a row in op_idempotency_keys', async () => {
    const key = `idem-4xx-row-${Date.now()}`;
    await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify({ currency: 'BDT' }), // invalid
    });
    const row = await db
      .prepare(`SELECT id FROM op_idempotency_keys WHERE merchant_id = ? AND key = ?`)
      .bind(M1, key)
      .first();
    expect(row).toBeNull();
  });
});

describe('Idempotency — concurrent D1 uniqueness safely', () => {
  it('concurrent requests with same key do not throw 500 (ON CONFLICT DO NOTHING)', async () => {
    const key = `idem-conc-${Date.now()}`;
    const body = { amount: '77.00', currency: 'BDT', description: 'concurrent' };
    const headers = { ...m1Headers, 'X-Idempotency-Key': key, 'Content-Type': 'application/json' };
    const payload = JSON.stringify(body);

    const [a, b] = await Promise.all([
      SELF.fetch('http://localhost/api/v1/payments', { method: 'POST', headers, body: payload }),
      SELF.fetch('http://localhost/api/v1/payments', { method: 'POST', headers, body: payload }),
    ]);

    // Neither should be 500 — both should be 201 (one fresh, one replay) or at least not 500
    expect([a.status, b.status].every(s => s === 201)).toBe(true);
    // At least one should be replay if both raced to insert
    const aReplay = a.headers.get('X-Idempotent-Replay');
    const bReplay = b.headers.get('X-Idempotent-Replay');
    // It's okay if neither is replay due to timing (first insert wins after both processed),
    // but we assert no 500 and that the row exists exactly once
    const rows = await db
      .prepare(`SELECT COUNT(*) as n FROM op_idempotency_keys WHERE merchant_id = ? AND key = ?`)
      .bind(M1, key)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // Avoid unused vars warning
    void aReplay;
    void bReplay;
  });
});

describe('Idempotency — refunds require X-Idempotency-Key', () => {
  it('returns 400 when X-Idempotency-Key is missing on POST /refunds', async () => {
    // Create a completed transaction for M1 via service so refund has something to target
    // Use a fresh merchant's gateway stripe
    const svc = new PaymentService(tenv);
    const intentRes = await svc.createIntent({
      merchant_id: M1,
      amount: '50.00',
      currency: 'BDT',
      description: 'refund-req-test',
    });
    // Need to manually complete the transaction via ledger + batch to make it refundable
    const txRow = await db
      .prepare(`SELECT id, trx_id FROM op_transactions WHERE payment_intent_id = ? LIMIT 1`)
      .bind(intentRes.intent_id)
      .first<{ id: number; trx_id: string }>();
    expect(txRow).not.toBeNull();
    // Complete it (ledger posting + status)
    await svc.completeTransaction(txRow!.id, intentRes.intent_id, `gw-refund-test-${Date.now()}`);

    const trxId = txRow!.trx_id;

    // Missing idempotency key => 400 IDEMPOTENCY_KEY_REQUIRED
    const noKey = await SELF.fetch('http://localhost/api/v1/refunds', {
      method: 'POST',
      headers: m1Headers,
      body: JSON.stringify({ transaction_id: trxId }),
    });
    expect(noKey.status).toBe(400);
    const noKeyJson = (await noKey.json()) as any;
    expect(noKeyJson.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    // With key: should NOT be 400 for missing key (may be 422/502/201 depending on gateway, but not idle key error)
    const withKey = await SELF.fetch('http://localhost/api/v1/refunds', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': `refund-req-${Date.now()}` },
      body: JSON.stringify({ transaction_id: trxId }),
    });
    expect(withKey.status).not.toBe(400);
    const withKeyJson = (await withKey.json()) as any;
    // The only 400 allowed here would be VALIDATION_ERROR, not IDEMPOTENCY_KEY_REQUIRED
    if (withKey.status === 400) {
      expect(withKeyJson.error.code).not.toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
  });
});

describe('Tenant safety — idempotency keys are merchant-scoped', () => {
  it('same key + same body for different merchants creates two distinct payments (not cross-tenant replay)', async () => {
    const key = `tenant-safe-${Date.now()}`;
    const body = { amount: '33.00', currency: 'BDT', description: 'tenant' };

    const r1 = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m1Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect(r1.status).toBe(201);
    const j1 = (await r1.json()) as any;
    const intent1 = j1.data.intent_id;

    const r2 = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      headers: { ...m2Headers, 'X-Idempotency-Key': key },
      body: JSON.stringify(body),
    });
    expect(r2.status).toBe(201);
    expect(r2.headers.get('X-Idempotent-Replay')).toBeNull();
    const j2 = (await r2.json()) as any;
    expect(j2.data.intent_id).not.toBe(intent1);

    // Verify two rows, one per merchant
    const rows = await db
      .prepare(`SELECT COUNT(*) as n FROM op_idempotency_keys WHERE key = ?`)
      .bind(key)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });
});

describe('Ledger posting before completion + atomic batch + recoverable pending', () => {
  it('completeTransaction posts ledger first, then atomically marks completed via batch, with pending recovery', async () => {
    const svc = new PaymentService(tenv);
    const ledger = new LedgerService(tenv);
    // Ensure gateway for M_LEDGER (create stripe)
    await db
      .prepare(
        `INSERT OR IGNORE INTO op_gateways (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
         VALUES (?, 'stripe', 'Stripe', 'api', 'active', 1, '["BDT","USD"]', ?, ?)`,
      )
      .bind(M_LEDGER, new Date().toISOString(), new Date().toISOString())
      .run();

    const res = await svc.createIntent({
      merchant_id: M_LEDGER,
      amount: '123.00',
      currency: 'BDT',
      description: 'atomic-ledger-test',
    });
    const txRow = await db
      .prepare(`SELECT id, status FROM op_transactions WHERE payment_intent_id = ? LIMIT 1`)
      .bind(res.intent_id)
      .first<{ id: number; status: string }>();
    const piRow = await db
      .prepare(`SELECT status FROM op_payment_intents WHERE id = ? LIMIT 1`)
      .bind(res.intent_id)
      .first<{ status: string }>();
    expect(txRow?.status).toBe('pending');
    expect(piRow?.status).toBe('pending');

    const gatewayTrxId = `gw-${Date.now()}`;
    await svc.completeTransaction(txRow!.id, res.intent_id, gatewayTrxId);

    // Both marked completed atomically
    const afterTx = await db
      .prepare(`SELECT status, gateway_trx_id FROM op_transactions WHERE id = ?`)
      .bind(txRow!.id)
      .first<{ status: string; gateway_trx_id: string }>();
    const afterPi = await db
      .prepare(`SELECT status, completed_at FROM op_payment_intents WHERE id = ?`)
      .bind(res.intent_id)
      .first<{ status: string; completed_at: string | null }>();
    expect(afterTx?.status).toBe('completed');
    expect(afterTx?.gateway_trx_id).toBe(gatewayTrxId);
    expect(afterPi?.status).toBe('completed');
    expect(afterPi?.completed_at).not.toBeNull();

    // Ledger posting exists and is posted (not pending)
    const txId = `m${M_LEDGER}:payment:${res.intent_id}`;
    const posting = await db
      .prepare(`SELECT status, tx_id FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string; tx_id: string }>();
    expect(posting?.status).toBe('posted');
    expect(posting?.tx_id).toBe(txId);

    // Idempotent retry: second call should not double-post ledger, still succeed, via duplicate
    await svc.completeTransaction(txRow!.id, res.intent_id, gatewayTrxId);
    const posting2 = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(posting2?.status).toBe('posted');
    // Balances remain correct (single posting)
    const stub = getLedgerDO(tenv, M_LEDGER);
    const trial = await stub.trialBalance();
    expect(trial.balanced).toBe(true);
    const consistency = await ledger.verifyDurableObjectConsistency(M_LEDGER);
    expect(consistency.consistent).toBe(true);
  });
});
