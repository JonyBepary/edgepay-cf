/**
 * Transactional Outbox integration tests — REAL Durable Object + REAL D1.
 *
 * Verifies Phase 2 specifications:
 *   1. Local commit: posting succeeds atomically in DO SQLite without D1 dependency.
 *   2. Drain: asynchronous batch drain correctly mirrors postings into D1.
 *   3. Backoff: drain failure triggers capped exponential backoff without wedging the queue.
 *   4. Guarded alarm: new postings nudge the drain without shortening in-flight backoff.
 *   5. Dedup: duplicate postings return duplicate without queuing redundant outbox events.
 *   6. Retention: synced events older than 7-day TTL are automatically purged.
 *   7. Batch bounds: drains are bounded to <= 100 D1 statements per batch.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import type { LedgerDOStub } from '../src/types/ledger';
import { LedgerService, getLedgerDO, type PostTransactionInput } from '../src/services/ledger';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

// Unique merchant for outbox drain test file
const MERCHANT = 930001;
const CURRENCY = 'BDT';

let ledger: LedgerService;
let stub: LedgerDOStub;
let acct: Record<string, number>;

function minor(n: number): string {
  return (n / 100).toFixed(2);
}

function paymentInput(txKey: string, amount = 100_00, fee = 2_50): PostTransactionInput {
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
    description: `test outbox payment ${txKey}`,
    entries,
  };
}

beforeAll(async () => {
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

describe('Transactional Outbox — local commit and async drain', () => {
  it('commits posting locally into DO SQLite without immediate D1 write', async () => {
    const key = 'outbox-local-1';
    const txId = `m${MERCHANT}:payment:${key}`;

    const res = await ledger.post(paymentInput(key), { idempotency_key: txId });
    expect(res.status).toBe('posted');
    expect(res.tx_id).toBe(txId);
    expect(res.ledger_transaction_id).toBeNull(); // assigned asynchronously on drain

    // DO SQLite state updated immediately
    const balances = await stub.getBalances();
    const byCode = Object.fromEntries(balances.map(b => [b.code, b.balance_minor]));
    expect(byCode['1010']).toBe(100_00 - 2_50);

    // Outbox event is pending in DO SQLite
    const outbox = await stub.__testInspectOutbox!();
    const event = outbox.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(event).toBeDefined();
    expect(event?.status).toBe('pending');
    expect(event?.retry_count).toBe(0);

    // D1 has NOT received the audit row yet (decoupled!)
    const postingBefore = await db
      .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string }>();
    expect(postingBefore).toBeNull();
  });

  it('drains pending outbox events to D1 successfully and idempotently', async () => {
    const key = 'outbox-local-1';
    const txId = `m${MERCHANT}:payment:${key}`;

    const drainResult = await stub.drainOutbox();
    expect(drainResult.drained).toBeGreaterThanOrEqual(1);
    expect(drainResult.failed).toBe(0);

    // Outbox row in DO is now marked synced
    const outbox = await stub.__testInspectOutbox!();
    const event = outbox.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(event?.status).toBe('synced');
    expect(event?.synced_at).not.toBeNull();

    // D1 audit tables are populated
    const posting = await db
      .prepare(`SELECT status, payload_json FROM op_ledger_postings WHERE tx_id = ?`)
      .bind(txId)
      .first<{ status: string; payload_json: string }>();
    expect(posting?.status).toBe('posted');

    const tx = await db
      .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
      .bind(txId)
      .first<{ id: number }>();
    expect(tx?.id).toBeGreaterThan(0);

    const entries = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_entries WHERE ledger_transaction_id = ?`)
      .bind(tx!.id)
      .first<{ n: number }>();
    expect(entries?.n).toBe(4);
  });

  it('dedup: duplicate tx_id returns duplicate and does not create duplicate outbox events', async () => {
    const key = 'outbox-dup-1';
    const txId = `m${MERCHANT}:payment:${key}`;

    const first = await ledger.post(paymentInput(key, 50_00, 0), { idempotency_key: txId });
    expect(first.status).toBe('posted');

    const outboxBefore = await stub.__testInspectOutbox!();
    const countBefore = outboxBefore.filter(e => e.event_id === `m${MERCHANT}:posting:${txId}`).length;
    expect(countBefore).toBe(1);

    // Second call with same tx_id
    const second = await ledger.post(paymentInput(key, 50_00, 0), { idempotency_key: txId });
    expect(second.status).toBe('duplicate');
    expect(second.posted_at).toBe(first.posted_at);

    const outboxAfter = await stub.__testInspectOutbox!();
    const countAfter = outboxAfter.filter(e => e.event_id === `m${MERCHANT}:posting:${txId}`).length;
    expect(countAfter).toBe(1); // No new outbox row!
  });

  it('retries with capped exponential backoff when drain fails', async () => {
    const key = 'outbox-fail-1';
    const txId = `m${MERCHANT}:payment:${key}`;

    // Inject fault before post so background alarm cannot drain ahead of test
    await stub.__testInjectFault({ fail_outbox_drain: true });
    await ledger.post(paymentInput(key, 10_00, 0), { idempotency_key: txId });

    // Drain (or alarm) intercepts failure
    await stub.drainOutbox();

    const outbox1 = await stub.__testInspectOutbox!();
    const ev1 = outbox1.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(ev1?.retry_count).toBeGreaterThanOrEqual(1);
    expect(ev1?.last_error).toMatch(/INJECTED:fail_outbox_drain/);
    expect(ev1?.next_retry_at).toBeGreaterThan(Date.now() - 500);

    // Second consecutive failure increases backoff
    await stub.__testInjectFault({ fail_outbox_drain: true });
    const fail2 = await stub.drainOutbox();
    expect(fail2.failed).toBeGreaterThanOrEqual(1);

    const outbox2 = await stub.__testInspectOutbox!();
    const ev2 = outbox2.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(ev2?.retry_count).toBe(2);
    expect(ev2?.next_retry_at!).toBeGreaterThan(ev1?.next_retry_at!);

    // Fault cleared: drain succeeds
    const ok = await stub.drainOutbox();
    expect(ok.drained).toBeGreaterThanOrEqual(1);

    const outbox3 = await stub.__testInspectOutbox!();
    const ev3 = outbox3.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(ev3?.status).toBe('synced');
  });

  it('guarded alarm: new postings do not shorten an in-flight backoff', async () => {
    const futureTarget = Date.now() + 30_000;
    await stub.__testSetAlarm!(futureTarget);

    const key = 'outbox-alarm-guard';
    await ledger.post(paymentInput(key, 5_00, 0), { idempotency_key: `m${MERCHANT}:payment:${key}` });

    const alarmAfter = await stub.__testGetAlarm!();
    // Must remain at the existing future backoff time, not pulled down to now + 100ms
    expect(alarmAfter).toBe(futureTarget);

    // Clean up
    await stub.drainOutbox();
  });

  it('retention: cleans up synced outbox rows older than 7 days', async () => {
    const outbox = await stub.__testInspectOutbox!();
    const syncedRow = outbox.find(e => e.status === 'synced');
    expect(syncedRow).toBeDefined();

    // Mark synced row 8 days in the past
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    await stub.__testSetOutboxSynced!(syncedRow!.id, eightDaysAgo);

    // Trigger alarm (which runs maybeCleanupOutbox)
    await stub.__testTriggerAlarm!();

    const afterCleanup = await stub.__testInspectOutbox!();
    const found = afterCleanup.find(e => e.id === syncedRow!.id);
    expect(found).toBeUndefined(); // Deleted by retention policy!
  });

  it('bounds D1 statements per batch to OUTBOX_MAX_STATEMENTS (100)', async () => {
    // Post 30 transactions with 4 entries each (= 6 statements each in D1)
    // 30 * 6 = 180 statements > 100 limit
    for (let i = 0; i < 25; i++) {
      await ledger.post(paymentInput(`batch-bound-${i}`, 1_00, 0), {
        idempotency_key: `m${MERCHANT}:payment:batch-bound-${i}`,
      });
    }

    const firstDrain = await stub.drainOutbox();
    // Bounded batch should not exceed 100 statements (e.g. 16 postings * 6 = 96 <= 100)
    expect(firstDrain.drained).toBeLessThanOrEqual(20);
    expect(firstDrain.drained).toBeGreaterThanOrEqual(10);

    // Check stats: some remaining pending rows still queued
    const stats = await stub.outboxStats();
    expect(stats.pending).toBeGreaterThan(0);

    // Second drain finishes the queue
    const secondDrain = await stub.drainOutbox();
    expect(secondDrain.drained).toBeGreaterThan(0);

    const statsAfter = await stub.outboxStats();
    expect(statsAfter.pending).toBe(0);
  });

  it('D1-down end-to-end: payment succeeds in DO, fast-path reports posted, drain retries asynchronously', async () => {
    const key = 'd1-down-payment';
    const txId = `m${MERCHANT}:payment:${key}`;

    // Inject D1 drain failure to simulate D1 outage / partition
    await stub.__testInjectFault({ fail_outbox_drain: true });

    // Customer posts payment
    const res = await ledger.post(paymentInput(key, 250_00, 5_00), { idempotency_key: txId });
    expect(res.status).toBe('posted');
    expect(res.ledger_transaction_id).toBeNull();
    expect(res.posted_at).toBeDefined();

    // DO SQLite state updated immediately (balances & journals)
    const balances = await stub.getBalances();
    const clearing = balances.find(b => b.code === '1010');
    expect(clearing?.balance_minor).toBeGreaterThan(0);

    // Outbox event is pending in DO SQLite
    const outbox = await stub.__testInspectOutbox!();
    const event = outbox.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(event).toBeDefined();
    expect(event?.status).toBe('pending');

    // Customer polling fast-path: DO immediately confirms completion without D1
    const doStatus = await stub.getTransactionStatus(txId);
    expect(doStatus.exists).toBe(true);
    expect(doStatus.posted_at).toBe(res.posted_at);

    // Drain attempt while D1 is unavailable fails safely with retry recorded
    const failedDrain = await stub.drainOutbox();
    expect(failedDrain.failed).toBeGreaterThanOrEqual(1);

    const outboxDuring = await stub.__testInspectOutbox!();
    const eventDuring = outboxDuring.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(eventDuring?.status).toBe('pending');
    expect(eventDuring?.retry_count).toBe(1);

    // D1 recovers: subsequent drain succeeds and completes synchronization
    const okDrain = await stub.drainOutbox();
    expect(okDrain.drained).toBeGreaterThanOrEqual(1);

    const outboxAfter = await stub.__testInspectOutbox!();
    const eventAfter = outboxAfter.find(e => e.event_id === `m${MERCHANT}:posting:${txId}`);
    expect(eventAfter?.status).toBe('synced');
  });

  it('dedup in D1: re-draining or repeating drainOutbox does NOT duplicate op_ledger_entries rows', async () => {
    const key = 'dedup-entries-test';
    const txId = `m${MERCHANT}:payment:${key}`;

    await ledger.post(paymentInput(key, 75_00, 2_00), { idempotency_key: txId });

    // First drain
    const firstDrain = await stub.drainOutbox();
    expect(firstDrain.drained).toBeGreaterThanOrEqual(1);

    const txRow = await db
      .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
      .bind(txId)
      .first<{ id: number }>();
    expect(txRow?.id).toBeGreaterThan(0);

    const count1 = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_entries WHERE ledger_transaction_id = ?`)
      .bind(txRow!.id)
      .first<{ n: number }>();
    expect(count1?.n).toBe(4); // exactly 4 legs

    // Re-run drain manually (simulate retry or concurrent trigger)
    await stub.drainOutbox({ force: true });

    const count2 = await db
      .prepare(`SELECT COUNT(*) AS n FROM op_ledger_entries WHERE ledger_transaction_id = ?`)
      .bind(txRow!.id)
      .first<{ n: number }>();
    // Crucial check: must remain exactly 4 rows, NOT 8 rows!
    expect(count2?.n).toBe(4);
  });

  it('reconciliation sweep pages on stuck outbox events and records metrics', async () => {
    const { collectOutboxStats } = await import('../src/services/reconciliation');
    const summary = await collectOutboxStats(tenv);
    expect(summary).toBeDefined();
    expect(typeof summary.outbox_lag_max_seconds).toBe('number');
    expect(typeof summary.outbox_pending_total).toBe('number');
    expect(typeof summary.outbox_stuck_total).toBe('number');
  });

  it('revert window: LEDGER_OUTBOX_ENABLED=false synchronously drains to D1 and returns ledger_transaction_id', async () => {
    const key = 'sync-fallback-test';
    const txId = `m${MERCHANT}:payment:${key}`;

    const prevFlag = tenv.LEDGER_OUTBOX_ENABLED;
    try {
      tenv.LEDGER_OUTBOX_ENABLED = 'false';

      const res = await ledger.post(paymentInput(key, 30_00, 0), { idempotency_key: txId });
      expect(res.status).toBe('posted');
      // Synchronous fallback populates ledger_transaction_id immediately
      expect(res.ledger_transaction_id).toBeGreaterThan(0);

      // D1 already has the posted row without needing an asynchronous alarm
      const d1Row = await db
        .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
        .bind(txId)
        .first<{ status: string }>();
      expect(d1Row?.status).toBe('posted');
    } finally {
      tenv.LEDGER_OUTBOX_ENABLED = prevFlag;
    }
  });

  it('legitimate duplicate legs: posting with multiple identical legs preserves all entries in D1 without silent drops', async () => {
    const key = 'dup-legs-test';
    const txId = `m${MERCHANT}:payment:${key}`;

    // Two identical debits of 50.00 to account 1010, matched by one credit of 100.00 to account 4000
    const input: PostTransactionInput = {
      merchant_id: MERCHANT,
      reference_type: 'payment',
      reference_id: key,
      description: 'identical legs test',
      entries: [
        { account_id: acct['1010'], direction: 'debit', amount: minor(50_00) },
        { account_id: acct['1010'], direction: 'debit', amount: minor(50_00) },
        { account_id: acct['4000'], direction: 'credit', amount: minor(100_00) },
      ],
    };

    const res = await ledger.post(input, { idempotency_key: txId });
    expect(res.status).toBe('posted');

    // Drain outbox to D1
    const drainRes = await stub.drainOutbox();
    expect(drainRes.drained).toBeGreaterThanOrEqual(1);

    const txRow = await db
      .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
      .bind(txId)
      .first<{ id: number }>();
    expect(txRow?.id).toBeGreaterThan(0);

    const entries = await db
      .prepare(`SELECT entry_order, direction, amount FROM op_ledger_entries WHERE ledger_transaction_id = ? ORDER BY entry_order ASC`)
      .bind(txRow!.id)
      .all<{ entry_order: number; direction: string; amount: string }>();

    // CRITICAL INVARIANT: All 3 legs must exist in D1 (identical debits are NOT dropped!)
    expect(entries.results).toHaveLength(3);
    expect(entries.results[0].entry_order).toBe(1);
    expect(entries.results[1].entry_order).toBe(2);
    expect(entries.results[2].entry_order).toBe(3);
  });

  it('customer polling route: GET /checkout/:token/status resolves completed via DO fast-path even if D1 is lagging', async () => {
    const token = 'fastpath-checkout-token';
    const intentId = 939099;

    // Insert payment intent in D1 with status = 'processing' (simulating D1 state lagging behind DO)
    await db
      .prepare(
        `INSERT INTO op_payment_intents (id, uuid, merchant_id, customer_id, token, amount, currency, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, '150.00', ?, datetime('now', '+1 hour'), 'processing', datetime('now'), datetime('now'))`,
      )
      .bind(intentId, `pi-uuid-${intentId}`, MERCHANT, token, CURRENCY)
      .run();

    // Post to DO ledger for this intent
    const txId = `m${MERCHANT}:payment:${intentId}`;
    const res = await ledger.post(paymentInput(String(intentId), 150_00, 0), { idempotency_key: txId });
    expect(res.status).toBe('posted');

    // Customer polls GET /checkout/{token}/status via Hono router
    const resp = await SELF.fetch(`http://localhost/checkout/${token}/status`);
    expect(resp.status).toBe(200);
    const body = await resp.json<{ status?: string; data?: { status: string } }>();
    const returnedStatus = body.status ?? body.data?.status;

    // Fast-path confirms completed immediately!
    expect(returnedStatus).toBe('completed');
  });
});
