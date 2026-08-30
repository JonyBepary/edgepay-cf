/**
 * LedgerDO posting-protocol integration tests — REAL Durable Object + REAL
 * D1 (vitest-pool-workers runs these inside workerd with the actual
 * bindings from wrangler.toml; no mocks of the consistency surface).
 *
 * This is the test suite the review demanded for the two critical fixes:
 *   - fix #1 (atomicity): one per-tenant LedgerDO owns the whole chart;
 *     a multi-account posting is a single serialized call
 *   - fix #2 (the disabled balance guard): per-account balance validation
 *     is enforced BEFORE any write
 *
 * Plus the failure-injection matrix for the protocol's crash windows
 * (see docs/POSTING-PROTOCOL.md):
 *   - D (D1 pending) fails  -> nothing changed anywhere
 *   - E (DO writes) fails   -> pending row remains, DO clean, replay posts
 *   - F (D1 audit/posted) fails -> pending row remains, replay heals
 *
 * Concurrency + the randomized consistency property test live in
 * tests/ledger-consistency.test.ts (same merchant isolation scheme).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import type { LedgerDOStub, PostingPayload } from '../src/types/ledger';
import {
  LedgerService,
  getLedgerDO,
  type PostTransactionInput,
} from '../src/services/ledger';
import { reconcilePendingPostings } from '../src/services/reconciliation';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

// Unique merchant per FILE (single worker shares D1 + DO namespace across files)
const MERCHANT = 910001;
const CURRENCY = 'BDT';

/** Deterministic test amounts in minor units (paisa). */
const AMOUNT = 100_00;      // 100.00 BDT
const FEE = 2_50;           //   2.50 BDT

let ledger: LedgerService;
let stub: LedgerDOStub;
/** account_id (D1) by chart code */
let acct: Record<string, number>;

function paymentInput(txKey: string, amount = AMOUNT, fee = FEE): PostTransactionInput {
  const entries = [
    { account_id: acct['1010'], direction: 'debit' as const, amount: minor(amount) },
    { account_id: acct['4000'], direction: 'credit' as const, amount: minor(amount) },
  ];
  if (fee > 0) {
    entries.push({ account_id: acct['5000'], direction: 'debit' as const, amount: minor(fee) });
    entries.push({ account_id: acct['1010'], direction: 'credit' as const, amount: minor(fee) });
  }
  return {
    merchant_id: MERCHANT,
    reference_type: 'payment',
    reference_id: txKey,
    description: `test payment ${txKey}`,
    entries,
  };
}

/** integer minor units -> Money decimal string */
function minor(n: number): string {
  return (n / 100).toFixed(2);
}

function rawPayload(txId: string, entries: Array<{ account_code: string; direction: 'debit' | 'credit'; amountMinor: number }>, currency = CURRENCY): PostingPayload {
  return {
    tx_id: txId,
    merchant_id: MERCHANT,
    reference_type: 'payment',
    reference_id: txId,
    description: `raw ${txId}`,
    currency,
    entries: entries.map(e => ({
      account_code: e.account_code,
      d1_account_id: acct[e.account_code] ?? 0,
      direction: e.direction,
      amount: minor(e.amountMinor),
      amount_minor: e.amountMinor,
    })),
  };
}

beforeAll(async () => {
  // Seed the merchant + the default chart (D1 rows = the audit mirror +
  // id->code resolution the LedgerService needs)
  await db
    .prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    )
    .bind(MERCHANT, `test-uuid-${MERCHANT}`, `Test Merchant ${MERCHANT}`, `test-m-${MERCHANT}`, `owner+${MERCHANT}@example.com`, CURRENCY)
    .run();

  ledger = new LedgerService(tenv);
  await ledger.createDefaultChartOfAccounts(MERCHANT, CURRENCY);

  const rows = await db
    .prepare(`SELECT id, code FROM op_ledger_accounts WHERE merchant_id = ?`)
    .bind(MERCHANT)
    .all<{ id: number; code: string }>();
  acct = Object.fromEntries(rows.results.map(r => [r.code, r.id]));

  stub = getLedgerDO(tenv, MERCHANT);
});

describe('LedgerDO posting protocol — happy path + D1 convergence', () => {
  it('posts a balanced payment: DO balances + trial balance + D1 audit trail all agree', async () => {
    const result = await ledger.post(paymentInput('pay-happy-1'), { idempotency_key: `m${MERCHANT}:payment:pay-happy-1` });

    expect(result.status).toBe('posted');
    expect(result.tx_id).toBe(`m${MERCHANT}:payment:pay-happy-1`);

    // DO balances (minor units): 1010 (asset) +AMOUNT-FEE, 4000 (revenue) +AMOUNT, 5000 (expense) +FEE
    const balances = await stub.getBalances();
    const byCode = Object.fromEntries(balances.map(b => [b.code, b.balance_minor]));
    expect(byCode['1010']).toBe(AMOUNT - FEE);
    expect(byCode['4000']).toBe(AMOUNT);
    expect(byCode['5000']).toBe(FEE);

    // Trial balance: Σdebits == Σcredits AND stored == derived-from-journal
    const trial = await stub.trialBalance();
    expect(trial.balanced).toBe(true);
    expect(trial.total_debit_minor).toBe(AMOUNT + FEE);
    expect(trial.total_credit_minor).toBe(AMOUNT + FEE);

    // D1 write-ahead row flipped to posted
    const posting = await db
      .prepare(`SELECT status, payload_json FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(result.tx_id)
      .first<{ status: string; payload_json: string }>();
    expect(posting?.status).toBe('posted');

    // D1 audit mirror: 1 transaction header + 4 entries
    const tx = await db
      .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
      .bind(result.tx_id)
      .first<{ id: number }>();
    expect(tx?.id).toBeGreaterThan(0);
    const entries = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_entries WHERE ledger_transaction_id = ?`)
      .bind(tx!.id)
      .first<{ n: number }>();
    expect(entries?.n).toBe(4);
  });

  it('is idempotent by tx_id: a replayed webhook/retry returns duplicate and posts nothing', async () => {
    const first = await ledger.post(paymentInput('pay-dup-1', 50_00, 0), { idempotency_key: `m${MERCHANT}:payment:pay-dup-1` });
    expect(first.status).toBe('posted');

    const second = await ledger.post(paymentInput('pay-dup-1', 50_00, 0), { idempotency_key: `m${MERCHANT}:payment:pay-dup-1` });
    expect(second.status).toBe('duplicate');
    expect(second.posted_at).toBe(first.posted_at);

    // No double-post: exactly one posted D1 transaction for this tx_id
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_transactions WHERE uuid = ?`)
      .bind(first.tx_id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });
});

describe('LedgerDO validation guards (fix #1/#2 — the guard v0.2.0 shipped disabled)', () => {
  // NOTE: postTransaction NEVER throws (a throw inside blockConcurrencyWhile
  // breaks the DO's input gate — see types/ledger.ts). Validation failures
  // come back as structured results; LedgerService re-scaffolds exceptions.

  it('rejects an unbalanced transaction BEFORE any write', async () => {
    const r = await stub.postTransaction(
      rawPayload('bad-unbalanced', [
        { account_code: '1010', direction: 'debit', amountMinor: 100_00 },
        { account_code: '4000', direction: 'credit', amountMinor: 99_00 },
      ]),
    );
    expect(r.status).toBe('failed');
    expect(r.error_code).toBe('UNBALANCED');

    // And nothing landed in D1 (no pending row for a rejected tx)
    const row = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind('bad-unbalanced')
      .first();
    expect(row).toBeNull();
  });

  it('rejects a posting that would drive an account negative (INSUFFICIENT_FUNDS)', async () => {
    // 1010 currently holds AMOUNT-FEE + 50_00 from earlier tests. Credit it
    // (payout direction) far beyond its balance.
    const r = await stub.postTransaction(
      rawPayload('bad-overdraft', [
        { account_code: '1010', direction: 'credit', amountMinor: 1_000_000_00 },
        { account_code: '4000', direction: 'debit', amountMinor: 1_000_000_00 },
      ]),
    );
    expect(r.status).toBe('failed');
    expect(r.error_code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects an unknown account code', async () => {
    const r = await stub.postTransaction(
      rawPayload('bad-account', [
        { account_code: '9999', direction: 'debit', amountMinor: 100 },
        { account_code: '4000', direction: 'credit', amountMinor: 100 },
      ]),
    );
    expect(r.status).toBe('failed');
    expect(r.error_code).toBe('UNKNOWN_ACCOUNT');
  });

  it('rejects a currency that does not match the tenant chart', async () => {
    const r = await stub.postTransaction(
      rawPayload(
        'bad-currency',
        [
          { account_code: '1010', direction: 'debit', amountMinor: 100 },
          { account_code: '4000', direction: 'credit', amountMinor: 100 },
        ],
        'USD',
      ),
    );
    expect(r.status).toBe('failed');
    expect(r.error_code).toBe('CURRENCY_MISMATCH');
  });

  it('the DO stays healthy after validation failures (input gate never breaks)', async () => {
    // The regression this guards against: any throw out of
    // blockConcurrencyWhile poisons the DO for all subsequent calls.
    const bad = await stub.postTransaction(
      rawPayload('bad-unbalanced-2', [
        { account_code: '1010', direction: 'debit', amountMinor: 10 },
        { account_code: '4000', direction: 'credit', amountMinor: 5 },
      ]),
    );
    expect(bad.status).toBe('failed');

    // The SAME DO must immediately accept a valid posting.
    const good = await ledger.post(paymentInput('post-reject-1', 10_00, 0), {
      idempotency_key: `m${MERCHANT}:payment:post-reject-1`,
    });
    expect(good.status).toBe('posted');
  });
});

describe('Posting protocol failure matrix (crash-window injection)', () => {
  it('D fails (D1 pending write): nothing changed anywhere; a clean retry posts', async () => {
    const key = 'inj-d1-pending';
    await stub.__testInjectFault({ fail_d1_pending: true });

    await expect(
      ledger.post(paymentInput(key), { idempotency_key: `m${MERCHANT}:payment:${key}` }),
    ).rejects.toThrow('INJECTED:fail_d1_pending');

    // No pending row, DO untouched
    const row = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(`m${MERCHANT}:payment:${key}`)
      .first();
    expect(row).toBeNull();
    const status = await stub.getTransactionStatus(`m${MERCHANT}:payment:${key}`);
    expect(status.exists).toBe(false);

    // Fault is one-shot: retrying the SAME tx_id posts cleanly
    const retry = await ledger.post(paymentInput(key), { idempotency_key: `m${MERCHANT}:payment:${key}` });
    expect(retry.status).toBe('posted');
  });

  it('E fails (DO writes): pending row survives, DO stays clean, reconciliation replays to posted', async () => {
    const key = 'inj-do-writes';
    const txId = `m${MERCHANT}:payment:${key}`;
    await stub.__testInjectFault({ fail_do_writes: true });

    await expect(
      ledger.post(paymentInput(key), { idempotency_key: txId }),
    ).rejects.toThrow('INJECTED:fail_do_writes');

    // D1 keeps the write-ahead pending row; the DO never applied it
    const row = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending');
    expect((await stub.getTransactionStatus(txId)).exists).toBe(false);

    // Reconciliation replays the exact payload — idempotent, converges
    const result = await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    expect(result.replayed).toBeGreaterThanOrEqual(1);

    const after = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(after?.status).toBe('posted');
    expect((await stub.getTransactionStatus(txId)).exists).toBe(true);
  });

  it('F fails (D1 audit/posted flip): pending row survives, replay heals both sides', async () => {
    const key = 'inj-d1-posted';
    const txId = `m${MERCHANT}:payment:${key}`;
    await stub.__testInjectFault({ fail_d1_posted: true });

    await expect(
      ledger.post(paymentInput(key), { idempotency_key: txId }),
    ).rejects.toThrow('INJECTED:fail_d1_posted');

    // The DO event COMPLETED (with a structured failure, not a throw — throws
    // break the input gate), so the DO's own writes COMMITTED while the D1
    // row stayed pending. This is exactly the state the dedup+heal path
    // exists for.
    const row = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(row?.status).toBe('pending');
    expect((await stub.getTransactionStatus(txId)).exists).toBe(true); // DO applied

    // Reconciliation replays -> DO dedup returns 'duplicate' -> the audit
    // trail is rewritten and the posting row flips to posted (the heal path).
    const healed = await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    expect(healed.healed).toBeGreaterThanOrEqual(1);

    const after = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(after?.status).toBe('posted');
  });

  it('heal path: DO committed while the D1 row was left pending -> duplicate + audit-trail rewrite', async () => {
    // Simulate the exotic window (ops reset / partial external repair) by
    // posting cleanly, then flipping the posting row back to pending.
    const key = 'heal-duplicate';
    const txId = `m${MERCHANT}:payment:${key}`;
    const posted = await ledger.post(paymentInput(key, 25_00, 0), { idempotency_key: txId });
    expect(posted.status).toBe('posted');

    await db
      .prepare(`UPDATE op_ledger_postings SET status = 'pending' WHERE tx_id = ?`)
      .bind(txId)
      .run();

    const result = await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    // Replay hits the DO dedup -> 'duplicate' -> reconciliation rewrites the
    // audit trail and flips the row back to posted.
    expect(result.healed).toBeGreaterThanOrEqual(1);

    const after = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(after?.status).toBe('posted');
  });

  it('quarantines deterministically-invalid pending rows as rejected (no infinite replay)', async () => {
    // Manufacture a pending row whose payload is invalid (unbalanced)
    const txId = `m${MERCHANT}:payment:poison`;
    const poison = rawPayload('poison', [
      { account_code: '1010', direction: 'debit', amountMinor: 100 },
      { account_code: '4000', direction: 'credit', amountMinor: 90 },
    ]);
    await db
      .prepare(
        `INSERT INTO op_ledger_postings (tx_id, merchant_id, reference_type, reference_id, currency, payload_json, status, created_at)
         VALUES (?, ?, 'payment', ?, ?, ?, 'pending', ?)`,
      )
      .bind(txId, MERCHANT, 'poison', CURRENCY, JSON.stringify(poison), new Date().toISOString())
      .run();

    const result = await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    expect(result.rejected).toBeGreaterThanOrEqual(1);

    const after = await db
      .prepare(`SELECT status, error FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string; error: string }>();
    expect(after?.status).toBe('rejected');
    expect(after?.error).toMatch(/UNBALANCED/);
  });
});

describe('Post-protocol invariants (always, after everything above)', () => {
  it('DO trial balance is balanced and the D1 audit mirror agrees with the DO', async () => {
    const trial = await stub.trialBalance();
    expect(trial.balanced).toBe(true);

    const consistency = await ledger.verifyDurableObjectConsistency(MERCHANT);
    expect(consistency.consistent).toBe(true);
    expect(consistency.discrepancies).toHaveLength(0);
  });

  it('no posting rows are left pending after reconciliation', async () => {
    await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_postings WHERE status = 'pending'`)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
