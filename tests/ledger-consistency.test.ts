/**
 * Ledger concurrency + consistency property tests — the second half of the
 * review's test demands, against the REAL LedgerDO + D1:
 *
 *   1. N-parallel postings to the same tenant: all succeed, balances are
 *      EXACT (no lost update, no double-apply) — blockConcurrencyWhile is
 *      the single-writer guarantee.
 *   2. N-parallel postings with the SAME tx_id: exactly one 'posted', the
 *      rest 'duplicate' — webhook redelivery storms cannot double-post.
 *   3. Randomized property test under failure injection: after a stream of
 *      random balanced postings with injected crashes at every protocol
 *      seam, then reconciliation:
 *        - D1-aggregated balances == DO balances, per account
 *        - Σdebits == Σcredits (trial balance)
 *        - zero pending rows remain
 *      This is the standing invariant production reconciliation checks
 *      (verifyAllMerchants), exercised with adversarial timing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import type { LedgerDOStub } from '../src/types/ledger';
import { LedgerService, getLedgerDO, type PostTransactionInput } from '../src/services/ledger';
import { reconcilePendingPostings } from '../src/services/reconciliation';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

// Distinct merchants per suite (single worker shares state across files)
const M_CONCURRENT = 910002;
const M_SAME_TX = 910003;
const M_PROPERTY = 910004;
const CURRENCY = 'BDT';

function minor(n: number): string {
  return (n / 100).toFixed(2);
}

async function seedMerchant(id: number): Promise<{ ledger: LedgerService; stub: LedgerDOStub; acct: Record<string, number> }> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
    )
    .bind(id, `test-uuid-${id}`, `Test Merchant ${id}`, `test-m-${id}`, `owner+${id}@example.com`, CURRENCY)
    .run();

  const ledger = new LedgerService(tenv);
  await ledger.createDefaultChartOfAccounts(id, CURRENCY);

  const rows = await db
    .prepare(`SELECT id, code FROM op_ledger_accounts WHERE merchant_id = ?`)
    .bind(id)
    .all<{ id: number; code: string }>();
  return { ledger, stub: getLedgerDO(tenv, id), acct: Object.fromEntries(rows.results.map(r => [r.code, r.id])) };
}

/** Balanced 2-leg posting: dr 1010 / cr 4000 (both increase — always valid). */
function captureInput(merchantId: number, acct: Record<string, number>, key: string, amountMinor: number): PostTransactionInput {
  return {
    merchant_id: merchantId,
    reference_type: 'payment',
    reference_id: key,
    description: `capture ${key}`,
    entries: [
      { account_id: acct['1010'], direction: 'debit', amount: minor(amountMinor) },
      { account_id: acct['4000'], direction: 'credit', amount: minor(amountMinor) },
    ],
  };
}

beforeAll(async () => {
  await seedMerchant(M_CONCURRENT);
  await seedMerchant(M_SAME_TX);
  await seedMerchant(M_PROPERTY);
});

describe('N-parallel postings (serialized by the per-tenant LedgerDO)', () => {
  it('20 concurrent DISTINCT postings: every one lands exactly once, balances are exact', async () => {
    const { ledger, stub, acct } = { ledger: new LedgerService(tenv), stub: getLedgerDO(tenv, M_CONCURRENT), acct: (await chartIds(M_CONCURRENT)) };
    const N = 20;
    const AMOUNT_EACH = 10_00;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ledger.post(captureInput(M_CONCURRENT, acct, `cc-${i}`, AMOUNT_EACH), {
          idempotency_key: `m${M_CONCURRENT}:payment:cc-${i}`,
        }),
      ),
    );

    expect(results.every(r => r.status === 'posted')).toBe(true);

    const balances = await stub.getBalances();
    const byCode = Object.fromEntries(balances.map(b => [b.code, b.balance_minor]));
    expect(byCode['1010']).toBe(N * AMOUNT_EACH); // exact — no lost update
    expect(byCode['4000']).toBe(N * AMOUNT_EACH);

    const trial = await stub.trialBalance();
    expect(trial.balanced).toBe(true);

    // D1 mirror agrees
    const consistency = await ledger.verifyDurableObjectConsistency(M_CONCURRENT);
    expect(consistency.consistent).toBe(true);
  });

  it('20 concurrent postings with the SAME tx_id: exactly one posted, 19 duplicates, no double-apply', async () => {
    const ledger = new LedgerService(tenv);
    const acct = await chartIds(M_SAME_TX);
    const stub = getLedgerDO(tenv, M_SAME_TX);
    const N = 20;
    const AMOUNT_EACH = 7_00;
    const key = 'same-tx-storm';

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        ledger.post(captureInput(M_SAME_TX, acct, key, AMOUNT_EACH), {
          idempotency_key: `m${M_SAME_TX}:payment:${key}`,
        }),
      ),
    );

    const posted = results.filter(r => r.status === 'posted');
    const duplicates = results.filter(r => r.status === 'duplicate');
    expect(posted).toHaveLength(1);
    expect(duplicates).toHaveLength(N - 1);

    const balances = await stub.getBalances();
    const byCode = Object.fromEntries(balances.map(b => [b.code, b.balance_minor]));
    expect(byCode['1010']).toBe(AMOUNT_EACH); // applied ONCE
    expect(byCode['4000']).toBe(AMOUNT_EACH);

    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_entries le JOIN op_ledger_transactions t ON t.id = le.ledger_transaction_id WHERE t.uuid = ?`)
      .bind(`m${M_SAME_TX}:payment:${key}`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(2); // exactly one journal, two legs
  });
});

/**
 * Randomized consistency property under failure injection.
 *
 * Seeded PRNG (mulberry32) -> reproducible on failure.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Property: D1-aggregated balances == DO balances under injected crashes', () => {
  it('survives a 30-posting stream with faults at every seam, then converges after reconciliation', async () => {
    const rand = mulberry32(0xc0ffee);
    const ledger = new LedgerService(tenv);
    const stub = getLedgerDO(tenv, M_PROPERTY);
    const acct = await chartIds(M_PROPERTY);

    const N = 30;
    let expectedTotal = 0; // only postings that actually land somewhere
    let injected = 0;

    for (let i = 0; i < N; i++) {
      const amountMinor = 1_00 + Math.floor(rand() * 500_00); // 1.00 .. 501.00
      const key = `pp-${i}`;
      const input = captureInput(M_PROPERTY, acct, key, amountMinor);
      const txId = `m${M_PROPERTY}:payment:${key}`;

      // ~1/3 of postings hit an injected fault at a random seam
      const roll = rand();
      let faultKind: 'none' | 'd' | 'e' | 'f' = 'none';
      if (roll < 0.33) {
        const seam = rand();
        faultKind = seam < 0.34 ? 'd' : seam < 0.67 ? 'e' : 'f';
        injected++;
        if (faultKind === 'd') await stub.__testInjectFault({ fail_d1_pending: true });
        else if (faultKind === 'e') await stub.__testInjectFault({ fail_do_writes: true });
        else await stub.__testInjectFault({ fail_d1_posted: true });
      }

      try {
        await ledger.post(input, { idempotency_key: txId });
        expectedTotal += amountMinor; // posted now
      } catch (err) {
        // Injected faults (and only those) are tolerated here — anything
        // else is a real failure that fails the test below.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('INJECTED:')) throw err;
        // A step-D failure leaves NOTHING anywhere (no pending row — the
        // client would retry later); it must not count toward totals.
        // E/F failures leave a pending row that reconciliation lands.
        if (faultKind !== 'd') expectedTotal += amountMinor;
      }
    }

    expect(injected).toBeGreaterThanOrEqual(5); // the stream really was adversarial

    // Reconcile to convergence (graceMs 0 — replay everything pending)
    const recon = await reconcilePendingPostings(tenv, { graceMs: -2000 }) // cutoff 2s ahead: immune to same-millisecond insert/cutoff races;
    expect(recon.remaining).toBe(0);
    expect(recon.rejected).toBe(0); // every posting in this stream is valid

    // PROPERTY 1: per-account D1-aggregated balances == DO balances
    const consistency = await ledger.verifyDurableObjectConsistency(M_PROPERTY);
    expect(consistency.consistent).toBe(true);
    expect(consistency.discrepancies).toHaveLength(0);

    // PROPERTY 2: trial balance — Σdebits == Σcredits, stored == derived
    const trial = await stub.trialBalance();
    expect(trial.balanced).toBe(true);

    // PROPERTY 3: expected totals — every posting that landed somewhere was
    // applied EXACTLY once (no double-apply, no loss)
    expect(trial.total_debit_minor).toBe(expectedTotal);
    expect(trial.total_credit_minor).toBe(expectedTotal);
  });
});

async function chartIds(merchantId: number): Promise<Record<string, number>> {
  const rows = await db
    .prepare(`SELECT id, code FROM op_ledger_accounts WHERE merchant_id = ?`)
    .bind(merchantId)
    .all<{ id: number; code: string }>();
  return Object.fromEntries(rows.results.map(r => [r.code, r.id]));
}
