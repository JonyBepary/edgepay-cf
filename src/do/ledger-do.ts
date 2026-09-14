/**
 * LedgerDO — ONE Durable Object per merchant, owning ALL of that
 * merchant's ledger accounts (review fix #1 + phase 2 transactional outbox).
 *
 * Why per-tenant and not per-account:
 *   A payment posts to >= 2 accounts (clearing + revenue + fees). With
 *   per-account DOs that is a fan-out to N DOs plus a D1 write — three
 *   systems with no atomicity between them: D1 could succeed while DO #2
 *   fails (history says posted, balances wrong), or DOs could succeed
 *   while D1 fails (balances moved with no audit trail — worse), or a
 *   partial fan-out breaks the trial balance until reconciliation.
 *
 *   Per-account DOs solve a contention problem this system does not
 *   have, at the cost of the atomicity problem it does.
 *
 * Phase 2 — Transactional Outbox Pattern:
 *   Previously the DO wrote a D1 write-ahead row ('pending') on the
 *   hot path, then committed locally, then wrote D1 audit ('posted').
 *   That coupling stalled the DO's single-threaded input gate on two
 *   external D1 network hops per posting.
 *
 *   In the Outbox model:
 *   1. DO writes journal + balances + outbox_events locally in SQLite
 *      inside `this.ctx.storage.transactionSync`. This is 100% atomic
 *      and synchronous with zero network latency on the payment hot-path.
 *   2. DO schedules an alarm (guarded kick) to drain outbox events
 *      asynchronously in bounded D1 batches.
 *   3. D1 is an async audit mirror / read model. DO SQLite is the
 *      authoritative book of record.
 *
 * Storage (SQLite-backed DO, INTEGER minor units so SQL aggregation is
 * numerically correct):
 *   accounts(code, name, type, currency, balance_minor, updated_at)
 *   posted_transactions(tx_id PK, ...)   <- tx_id dedup registry
 *   journal_entries(id, tx_id, account_code, direction, amount_minor, ...)
 *   outbox_events(id, event_id, event_type, payload_json, status, ...)
 *
 * TEST SEAMS: __testInjectFault() is a one-shot failure-injection hook
 * used exclusively by the consistency property tests. It is part of the
 * documented test surface, not an auth bypass.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env, D1PreparedStatement } from '../types/env';
import type {
  LedgerDOStub,
  PostingEntry,
  PostingPayload,
  PostingResult,
} from '../types/ledger';
import { PostingValidationError } from '../types/ledger';
import { DEFAULT_CHART_OF_ACCOUNTS, isDebitNormal } from '../lib/ledger-chart';
import { buildLedgerAuditStatements, writeLedgerAuditTrail } from '../services/ledger-audit';

const MAX_AMOUNT_MINOR = 9_000_000_000_000; // 90M in minor units — far above any single BD/AF payment

interface AccountRow {
  code: string;
  name: string;
  type: string;
  currency: string;
  balance_minor: number;
}

interface OutboxRow {
  id: number;
  event_id: string;
  event_type: string;
  payload_json: string;
  retry_count: number;
}

/** Per-tenant snapshot cadence for the DO alarm (per-merchant scheduled work). */
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Outbox drain tuning. All in ms unless noted. */
const OUTBOX_DRAIN_KICK_MS = 100;               // post-commit nudge
const OUTBOX_DRAIN_RETRY_MS = 1_000;            // first backoff step
const OUTBOX_DRAIN_MAX_BACKOFF_MS = 60_000;     // cap
const OUTBOX_BATCH_POSTINGS = 20;               // max postings per drain
const OUTBOX_MAX_STATEMENTS = 100;              // D1 batch bound (hard limit)
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // synced row TTL
const OUTBOX_STUCK_RETRY_THRESHOLD = 10;        // alert above this
const OUTBOX_STUCK_AGE_MS = 5 * 60 * 1000;      // alert above this age

export class LedgerDO extends DurableObject<Env> {
  /** TEST-ONLY one-shot failure injection (consumed at the injected point). */
  private faults: {
    fail_d1_pending?: boolean;
    fail_do_writes?: boolean;
    fail_d1_posted?: boolean;
    fail_outbox_drain?: boolean;
  } | null = null;

  /** Cached tenant ID for this DO instance. */
  private merchantId: number | null = null;

  /** In-memory chart-seed guard — skips the INSERT OR IGNORE fan-out after
   *  the first posting per isolate (resets on eviction; always idempotent). */
  private seededCurrency: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Table bootstrap runs ONCE per isolate in the constructor;
    // blockConcurrencyWhile holds the input gate until the tables exist.
    ctx.blockConcurrencyWhile(async () => {
      this.ensureTables();
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (!currentAlarm) {
        await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_INTERVAL_MS);
      }
    });
  }

  // ------------------------------------------------------------------
  // THE posting path (Transactional Outbox)
  // ------------------------------------------------------------------

  /**
   * Post one balanced transaction atomically via transactional outbox.
   * Serialized by blockConcurrencyWhile — this is the single writer for
   * the merchant's entire book.
   *
   * Local commit is 100% atomic inside transactionSync. No D1 network
   * RPC on the hot path.
   *
   * NEVER THROWS: if the blockConcurrencyWhile closure throws, workerd
   * marks the DO's input gate BROKEN and every subsequent call to this
   * tenant's ledger fails until eviction. Failures are returned as structured
   * results; LedgerService re-scaffolds them into exceptions worker-side.
   */
  async postTransaction(payload: PostingPayload): Promise<PostingResult> {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        return await this.postInner(payload);
      } catch (err) {
        if (err instanceof PostingValidationError) {
          return {
            status: 'failed' as const,
            tx_id: payload.tx_id ?? '',
            posted_at: new Date().toISOString(),
            error_code: err.code,
            error: err.message.replace(/^\[[A-Z_]+\]\s*/, ''),
          };
        }
        // Transient / unexpected (injected fault, storage issue):
        const message = err instanceof Error ? err.message : String(err);
        return {
          status: 'failed' as const,
          tx_id: payload.tx_id ?? '',
          posted_at: new Date().toISOString(),
          error_code: 'INTERNAL' as const,
          error: message,
        };
      }
    });
  }

  private async postInner(payload: PostingPayload): Promise<PostingResult> {
    const postedAt = new Date().toISOString();

    this.seedChart(payload.currency);

    // A. Shape validation — pure, no side effects
    validatePostingShape(payload);

    // B. Dedup by tx_id (idempotent replay: webhook redelivery, workflow
    //    retry, reconciliation heal, client retry — all converge here)
    const existing = this.rows(
      `SELECT posted_at FROM posted_transactions WHERE tx_id = ?`,
      payload.tx_id,
    ) as Array<{ posted_at: string }>;
    if (existing.length > 0) {
      return {
        status: 'duplicate',
        tx_id: payload.tx_id,
        posted_at: existing[0].posted_at,
        ledger_transaction_id: null,
      };
    }

    // C. Balance check — per-account balances may never go below zero on
    //    the account's normal side. Throws INSUFFICIENT_FUNDS before anything
    //    is written.
    const deltas = this.checkBalances(payload.entries, payload.currency);

    // D. Atomic local commit: journal + balances + outbox event.
    //    transactionSync guarantees all-or-nothing in DO SQLite. No D1 RPC
    //    on the hot path. The DO is the source of truth.
    if (this.faults?.fail_do_writes) {
      this.faults = null;
      throw new Error('INJECTED:fail_do_writes');
    }

    if (typeof payload.merchant_id === 'number' && payload.merchant_id > 0) {
      this.merchantId = payload.merchant_id;
    }
    const merchantId = this.getMerchantId() ?? payload.merchant_id;
    const eventId = `m${merchantId}:posting:${payload.tx_id}`;
    const outboxPayload = JSON.stringify({ ...payload, posted_at: postedAt });

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO posted_transactions (tx_id, reference_type, reference_id, currency, description, posted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        payload.tx_id,
        payload.reference_type,
        payload.reference_id ?? null,
        payload.currency,
        payload.description ?? null,
        postedAt,
      );

      for (const e of payload.entries) {
        this.ctx.storage.sql.exec(
          `INSERT INTO journal_entries (tx_id, account_code, direction, amount_minor, posted_at)
           VALUES (?, ?, ?, ?, ?)`,
          payload.tx_id,
          e.account_code,
          e.direction,
          e.amount_minor,
          postedAt,
        );
      }

      for (const [code, delta] of deltas) {
        this.ctx.storage.sql.exec(
          `UPDATE accounts SET balance_minor = balance_minor + ?, updated_at = ? WHERE code = ?`,
          delta,
          postedAt,
          code,
        );
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO outbox_events (event_id, event_type, payload_json, status, created_at)
         VALUES (?, 'POSTING', ?, 'pending', ?)`,
        eventId,
        outboxPayload,
        postedAt,
      );
    });

    // E. Nudge the drain alarm (or synchronously write audit if reverted to pre-outbox behavior).
    let synchronousLedgerTxId: number | null = null;
    if (this.env.LEDGER_OUTBOX_ENABLED === 'false') {
      // OPERATIONAL REVERSION NOTICE: This flag provides "asynchronous-write with
      // synchronous read-back", NOT true pre-outbox behavior. The DO transactionSync
      // has already committed locally. If writeLedgerAuditTrail throws here, the DO
      // state remains committed, the outbox row remains 'pending', and reconciliation
      // will re-drain it. Use ONLY as a temporary break-glass reversion if outbox alarms
      // fail, NOT as a general "safe mode".
      const audit = await writeLedgerAuditTrail(this.env, payload, postedAt);
      synchronousLedgerTxId = audit.ledger_transaction_id;
      this.ctx.storage.sql.exec(
        `UPDATE outbox_events SET status = 'synced', synced_at = ? WHERE event_id = ?`,
        postedAt,
        eventId,
      );
    } else {
      await this.kickOutboxAlarm();
    }

    return {
      status: 'posted',
      tx_id: payload.tx_id,
      posted_at: postedAt,
      ledger_transaction_id: synchronousLedgerTxId,
    };
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async getBalances(): Promise<AccountRow[]> {
    return this.rows(
      `SELECT code, name, type, currency, balance_minor FROM accounts ORDER BY code`,
    ) as AccountRow[];
  }

  async getTransactionStatus(tx_id: string): Promise<{ exists: boolean; posted_at: string | null }> {
    const rows = this.rows(
      `SELECT posted_at FROM posted_transactions WHERE tx_id = ?`,
      tx_id,
    ) as Array<{ posted_at: string }>;
    return {
      exists: rows.length > 0,
      posted_at: rows[0]?.posted_at ?? null,
    };
  }

  /**
   * Trial balance: Σdebits == Σcredits, and each account's stored balance
   * equals the balance derived from its journal. Runs entirely inside the
   * DO in INTEGER minor units (no TEXT lexical-aggregation hazard).
   */
  async trialBalance(): Promise<{
    balanced: boolean;
    total_debit_minor: number;
    total_credit_minor: number;
    accounts: Array<{
      code: string;
      name: string;
      type: string;
      balance_minor: number;
      derived_balance_minor: number;
    }>;
  }> {
    const totals = this.rows(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_minor ELSE 0 END), 0) AS total_debit,
         COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS total_credit
       FROM journal_entries`,
    ) as Array<{ total_debit: number; total_credit: number }>;

    const derived = new Map<string, number>();
    for (const r of this.rows(
      `SELECT account_code,
              SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END) AS net
       FROM journal_entries GROUP BY account_code`,
    ) as Array<{ account_code: string; net: number }>) {
      derived.set(r.account_code, Number(r.net));
    }

    const accounts = (this.rows(
      `SELECT code, name, type, balance_minor FROM accounts ORDER BY code`,
    ) as AccountRow[]).map(a => ({
      code: a.code,
      name: a.name,
      type: a.type,
      balance_minor: Number(a.balance_minor),
      derived_balance_minor: isDebitNormal(a.type as 'asset' | 'liability' | 'equity' | 'revenue' | 'expense')
        ? derived.get(a.code) ?? 0
        : -(derived.get(a.code) ?? 0),
    }));

    const totalDebit = Number(totals[0]?.total_debit ?? 0);
    const totalCredit = Number(totals[0]?.total_credit ?? 0);
    const balanced =
      totalDebit === totalCredit &&
      accounts.every(a => a.balance_minor === a.derived_balance_minor);

    return {
      balanced,
      total_debit_minor: totalDebit,
      total_credit_minor: totalCredit,
      accounts,
    };
  }

  // ------------------------------------------------------------------
  // Outbox drain & Alarm
  // ------------------------------------------------------------------

  /** Guarded alarm nudge. Never shortens an existing backoff. */
  private async kickOutboxAlarm(): Promise<void> {
    const now = Date.now();
    const current = await this.ctx.storage.getAlarm();
    // If an in-flight backoff alarm is already scheduled (within max backoff window), do not shorten it.
    if (current !== null && current > now && current - now <= OUTBOX_DRAIN_MAX_BACKOFF_MS) {
      return;
    }
    const target = now + OUTBOX_DRAIN_KICK_MS;
    if (current === null || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /**
   * Drain a bounded batch of pending outbox events to D1.
   * Idempotent: every D1 statement uses INSERT OR IGNORE / ON CONFLICT keyed on tx_id,
   * so a partial drain followed by a retry converges.
   *
   * Never throws — errors are recorded per-event and retried with
   * exponential backoff.
   *
   * @param opts.force - When true, bypass next_retry_at backoff. Use ONLY in tests
   *                     and one-off reconciliation, never in the alarm path.
   */
  async drainOutbox(opts: { force?: boolean } = {}): Promise<{ drained: number; failed: number }> {
    const force = opts.force ?? true;
    const now = Date.now();

    const pending = force
      ? (this.ctx.storage.sql.exec(
          `SELECT id, event_id, event_type, payload_json, retry_count
             FROM outbox_events
            WHERE status = 'pending'
            ORDER BY id ASC
            LIMIT ?`,
          OUTBOX_BATCH_POSTINGS,
        ).toArray() as unknown as OutboxRow[])
      : (this.ctx.storage.sql.exec(
          `SELECT id, event_id, event_type, payload_json, retry_count
             FROM outbox_events
            WHERE status = 'pending'
              AND (next_retry_at IS NULL OR next_retry_at <= ?)
            ORDER BY id ASC
            LIMIT ?`,
          now,
          OUTBOX_BATCH_POSTINGS,
        ).toArray() as unknown as OutboxRow[]);

    if (pending.length === 0) return { drained: 0, failed: 0 };

    let merchantId = this.getMerchantId();
    if (!merchantId && pending.length > 0) {
      try {
        const p = JSON.parse(pending[0].payload_json) as { merchant_id?: number };
        if (typeof p.merchant_id === 'number' && p.merchant_id > 0) {
          merchantId = p.merchant_id;
          this.merchantId = merchantId;
        }
      } catch {
        // ignore parse error
      }
    }

    if (!merchantId) {
      this.markOutboxRetry(pending.map(p => p.id), 'NO_MERCHANT_CONTEXT');
      return { drained: 0, failed: pending.length };
    }

    // Compose a single D1 batch, bounded by statement count.
    const stmts: D1PreparedStatement[] = [];
    const included: OutboxRow[] = [];
    for (const row of pending) {
      const payload = JSON.parse(row.payload_json) as PostingPayload & { posted_at: string };
      const rowMerchantId = payload.merchant_id ?? merchantId;
      const batch = buildLedgerAuditStatements(
        this.env,
        rowMerchantId,
        payload,
        payload.posted_at,
      );
      if (stmts.length + batch.length > OUTBOX_MAX_STATEMENTS) break;
      stmts.push(...batch);
      included.push(row);
    }

    if (included.length === 0) {
      // A single posting exceeds OUTBOX_MAX_STATEMENTS.
      this.markOutboxRetry([pending[0].id], 'BATCH_TOO_LARGE');
      return { drained: 0, failed: 1 };
    }

    if (this.faults?.fail_outbox_drain) {
      this.faults = null;
      this.markOutboxRetry(included.map(r => r.id), 'INJECTED:fail_outbox_drain');
      return { drained: 0, failed: included.length };
    }

    try {
      await this.env.DB.batch(stmts);
    } catch (err) {
      this.markOutboxRetry(included.map(r => r.id), String(err));
      return { drained: 0, failed: included.length };
    }

    const syncedAt = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const row of included) {
        this.ctx.storage.sql.exec(
          `UPDATE outbox_events
              SET status = 'synced', synced_at = ?, last_error = NULL,
                  next_retry_at = NULL
            WHERE id = ?`,
          syncedAt,
          row.id,
        );
      }
    });

    return { drained: included.length, failed: 0 };
  }

  /** Record a retry with capped exponential backoff. Never throws. */
  private markOutboxRetry(ids: number[], error: string): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const row = this.ctx.storage.sql.exec(
          `SELECT retry_count FROM outbox_events WHERE id = ?`,
          id,
        ).toArray()[0] as { retry_count: number } | undefined;
        const retries = (row?.retry_count ?? 0) + 1;
        const backoff = Math.min(
          OUTBOX_DRAIN_MAX_BACKOFF_MS,
          OUTBOX_DRAIN_RETRY_MS * 2 ** Math.min(retries, 10),
        );
        this.ctx.storage.sql.exec(
          `UPDATE outbox_events
              SET retry_count = ?, last_error = ?, next_retry_at = ?
            WHERE id = ?`,
          retries,
          error.slice(0, 500),
          now + backoff,
          id,
        );
      }
    });
  }

  /**
   * Delete synced outbox rows older than OUTBOX_RETENTION_MS.
   * Throttled: runs at most once per hour.
   */
  private async maybeCleanupOutbox(): Promise<void> {
    const last = Number(await this.ctx.storage.get('lastOutboxCleanupAt') ?? 0);
    if (Date.now() - last < 60 * 60 * 1000) return;
    const cutoff = new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString();
    this.ctx.storage.sql.exec(
      `DELETE FROM outbox_events WHERE status = 'synced' AND synced_at < ?`,
      cutoff,
    );
    await this.ctx.storage.put('lastOutboxCleanupAt', Date.now());
  }

  /** Cheap observability surface for the reconciliation sweep. */
  async outboxStats(): Promise<{
    pending: number;
    stuck: number;
    max_age_seconds: number;
    max_retry: number;
  }> {
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec(
      `SELECT status, retry_count, created_at FROM outbox_events WHERE status = 'pending'`,
    ).toArray() as unknown as Array<{ status: string; retry_count: number; created_at: string }>;

    let maxAge = 0;
    let maxRetry = 0;
    let stuck = 0;
    for (const r of rows) {
      const ageMs = now - Date.parse(r.created_at);
      if (ageMs > maxAge) maxAge = ageMs;
      if (r.retry_count > maxRetry) maxRetry = r.retry_count;
      if (ageMs > OUTBOX_STUCK_AGE_MS || r.retry_count >= OUTBOX_STUCK_RETRY_THRESHOLD) {
        stuck++;
      }
    }
    return {
      pending: rows.length,
      stuck,
      max_age_seconds: Math.floor(maxAge / 1000),
      max_retry: maxRetry,
    };
  }

  /** Retrieve recent posted transaction IDs within a time window. */
  async recentPostedTxIds(sinceIso?: string): Promise<string[]> {
    const cutoff = sinceIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return (this.ctx.storage.sql.exec(
      `SELECT tx_id FROM posted_transactions WHERE posted_at > ?`,
      cutoff,
    ).toArray() as unknown as Array<{ tx_id: string }>).map(r => r.tx_id);
  }

  /** Combined DO alarm: drain outbox, snapshot balances if due, and retention sweep. */
  async alarm(): Promise<void> {
    // 1. Drain outbox first — payments depend on it more than on snapshots.
    try {
      await this.drainOutbox({ force: false });
    } catch (err) {
      console.error('alarm:drainOutbox unexpected', err);
    }

    // 2. Snapshot if due.
    const lastSnapshot = Number(await this.ctx.storage.get('lastSnapshotAt') ?? 0);
    if (Date.now() - lastSnapshot >= SNAPSHOT_INTERVAL_MS) {
      try {
        await this.snapshotBalances();
        await this.ctx.storage.put('lastSnapshotAt', Date.now());
      } catch (err) {
        console.error('alarm:snapshotBalances failed', err);
      }
    }

    // 3. Retention.
    try {
      await this.maybeCleanupOutbox();
    } catch (err) {
      console.error('alarm:cleanupOutbox failed', err);
    }

    // 4. Reschedule: backoff if work pending, else next snapshot.
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const next = this.ctx.storage.sql.exec(
      `SELECT MIN(COALESCE(next_retry_at, ?)) AS next_at
         FROM outbox_events
        WHERE status = 'pending'`,
      now,
    ).toArray()[0] as { next_at: number | null } | undefined;

    let target: number;
    if (next?.next_at !== null && next?.next_at !== undefined && next.next_at <= now) {
      target = now + OUTBOX_DRAIN_KICK_MS;
    } else if (next?.next_at !== null && next?.next_at !== undefined) {
      target = next.next_at;
    } else {
      const lastSnapshot = Number(await this.ctx.storage.get('lastSnapshotAt') ?? 0);
      target = lastSnapshot + SNAPSHOT_INTERVAL_MS;
    }

    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /** Snapshot all account balances into D1 (idempotent per day via PK). */
  async snapshotBalances(): Promise<{ snapshot_at: string; accounts: number }> {
    const accounts = this.rows(
      `SELECT code, currency, balance_minor FROM accounts`,
    ) as Array<{ code: string; currency: string; balance_minor: number }>;
    const asOf = new Date().toISOString();
    const asOfDate = asOf.slice(0, 10);

    const merchantId = this.getMerchantId();
    if (merchantId === null) {
      // No valid merchant identity — skip D1 write safely.
      return { snapshot_at: asOf, accounts: accounts.length };
    }
    if (accounts.length > 0) {
      await this.env.DB.batch(
        accounts.map(a =>
          this.env.DB
            .prepare(
              `INSERT OR IGNORE INTO op_ledger_balance_snapshots
                 (merchant_id, account_code, currency, balance_minor, as_of)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(merchantId, a.code, a.currency, Number(a.balance_minor), asOfDate),
        ),
      );
    }
    return { snapshot_at: asOf, accounts: accounts.length };
  }

  /** Extract the tenant id from the DO id name ("merchant-{id}") or cached state. */
  private getMerchantId(): number | null {
    if (this.merchantId !== null && this.merchantId > 0) return this.merchantId;
    const rawName = this.ctx.id.name ?? '';
    if (!rawName.startsWith('merchant-')) return null;
    const id = Number(rawName.slice('merchant-'.length));
    if (Number.isInteger(id) && id > 0) {
      this.merchantId = id;
      return id;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // TEST-ONLY failure injection
  // ------------------------------------------------------------------

  async __testInjectFault(faults: {
    fail_d1_pending?: boolean;
    fail_do_writes?: boolean;
    fail_d1_posted?: boolean;
    fail_outbox_drain?: boolean;
  }): Promise<void> {
    // Fault injection is NEVER available in production — throw unconditionally.
    if (this.env.ENVIRONMENT === 'production') {
      throw new Error('fault injection disabled in production');
    }
    this.faults = faults;
  }

  async __testInspectOutbox(): Promise<Array<{
    id: number;
    event_id: string;
    event_type: string;
    status: string;
    retry_count: number;
    last_error: string | null;
    next_retry_at: number | null;
    synced_at: string | null;
  }>> {
    if (this.env.ENVIRONMENT === 'production') throw new Error('disabled in production');
    return this.rows(
      `SELECT id, event_id, event_type, status, retry_count, last_error, next_retry_at, synced_at
       FROM outbox_events ORDER BY id ASC`,
    ) as unknown as Array<{
      id: number;
      event_id: string;
      event_type: string;
      status: string;
      retry_count: number;
      last_error: string | null;
      next_retry_at: number | null;
      synced_at: string | null;
    }>;
  }

  async __testSetOutboxSynced(id: number, syncedAt: string): Promise<void> {
    if (this.env.ENVIRONMENT === 'production') throw new Error('disabled in production');
    this.ctx.storage.sql.exec(`UPDATE outbox_events SET status = 'synced', synced_at = ? WHERE id = ?`, syncedAt, id);
  }

  async __testGetAlarm(): Promise<number | null> {
    if (this.env.ENVIRONMENT === 'production') throw new Error('disabled in production');
    return await this.ctx.storage.getAlarm();
  }

  async __testSetAlarm(target: number): Promise<void> {
    if (this.env.ENVIRONMENT === 'production') throw new Error('disabled in production');
    await this.ctx.storage.setAlarm(target);
  }

  async __testTriggerAlarm(): Promise<void> {
    if (this.env.ENVIRONMENT === 'production') throw new Error('disabled in production');
    await this.ctx.storage.delete('lastOutboxCleanupAt');
    await this.alarm();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Balance check. Returns the per-account signed deltas to apply.
   * Sign convention: balances are stored positive on the account's normal
   * side (asset/expense = debit-normal; liability/equity/revenue =
   * credit-normal). An entry in the direction of the normal side
   * increases the balance; against it decreases. No resulting balance
   * may go below zero.
   */
  private checkBalances(entries: PostingEntry[], currency: string): Map<string, number> {
    const codes = [...new Set(entries.map(e => e.account_code))];
    const placeholders = codes.map(() => '?').join(', ');
    const accountMap = new Map<string, AccountRow>();
    for (const r of this.rows(
      `SELECT code, name, type, currency, balance_minor FROM accounts WHERE code IN (${placeholders})`,
      ...codes,
    ) as AccountRow[]) {
      accountMap.set(r.code, r);
    }

    const deltas = new Map<string, number>();
    for (const e of entries) {
      const acct = accountMap.get(e.account_code);
      if (!acct) {
        throw new PostingValidationError('UNKNOWN_ACCOUNT', `account ${e.account_code} is not in this tenant's chart`);
      }
      if (acct.currency !== currency) {
        throw new PostingValidationError(
          'CURRENCY_MISMATCH',
          `account ${e.account_code} is ${acct.currency}, posting is ${currency}`,
        );
      }
      const increases = e.direction === 'debit' ? isDebitNormal(acct.type as 'asset') : !isDebitNormal(acct.type as 'asset');
      const sign = increases ? 1 : -1;
      deltas.set(e.account_code, (deltas.get(e.account_code) ?? 0) + sign * e.amount_minor);
    }

    for (const [code, delta] of deltas) {
      const current = Number(accountMap.get(code)!.balance_minor);
      if (current + delta < 0) {
        throw new PostingValidationError(
          'INSUFFICIENT_FUNDS',
          `account ${code} balance would go negative (${current + delta})`,
        );
      }
    }
    return deltas;
  }

  /**
   * Create the DO's SQLite tables if missing. Idempotent — called once
   * per isolate from the constructor's blockConcurrencyWhile.
   */
  private ensureTables(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS accounts (
         code TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
         currency TEXT NOT NULL,
         balance_minor INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS posted_transactions (
         tx_id TEXT PRIMARY KEY,
         reference_type TEXT NOT NULL,
         reference_id TEXT,
         currency TEXT NOT NULL,
         description TEXT,
         posted_at TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS journal_entries (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         tx_id TEXT NOT NULL,
         account_code TEXT NOT NULL,
         direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
         amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
         posted_at TEXT NOT NULL
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_journal_tx ON journal_entries(tx_id)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_journal_account ON journal_entries(account_code)`,
    );

    // Durable outbox: every posting commits an event here in the SAME
    // transactionSync as the journal + balance writes. The alarm drains
    // these to D1. event_id is deterministic per posting so re-entrant
    // commits are impossible.
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS outbox_events (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         event_id      TEXT    NOT NULL UNIQUE,
         event_type    TEXT    NOT NULL,
         payload_json  TEXT    NOT NULL,
         status        TEXT    NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','synced')),
         retry_count   INTEGER NOT NULL DEFAULT 0,
         last_error    TEXT,
         created_at    TEXT    NOT NULL,
         synced_at     TEXT,
         next_retry_at INTEGER
       )`,
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_outbox_pending
         ON outbox_events(status, next_retry_at)`,
    );
  }

  /**
   * Seed the default chart of accounts (14 rows, INSERT OR IGNORE).
   */
  private seedChart(currency: string): void {
    if (this.seededCurrency === currency) return;
    for (const a of DEFAULT_CHART_OF_ACCOUNTS) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO accounts (code, name, type, currency, balance_minor, updated_at)
         VALUES (?, ?, ?, ?, 0, NULL)`,
        a.code,
        a.name,
        a.type,
        currency,
      );
    }
    this.seededCurrency = currency;
  }

  /**
   * Raw SQL read helper. Returns unknown[] — every caller narrows with a
   * single as T[] cast.
   */
  private rows(sql: string, ...params: unknown[]): unknown[] {
    return this.ctx.storage.sql.exec(sql, ...params).toArray() as unknown as unknown[];
  }
}

// ------------------------------------------------------------------
// Pure shape validation — exported for unit testing
// ------------------------------------------------------------------

/**
 * Validate the transaction's structural invariants (pure — no storage):
 *   - >= 2 entries
 *   - every amount is a positive safe integer of minor units
 *   - Σdebits == Σcredits EXACTLY (the double-entry equation)
 */
export function validatePostingShape(payload: PostingPayload): void {
  if (!payload.tx_id || typeof payload.tx_id !== 'string') {
    throw new PostingValidationError('INVALID', 'tx_id is required');
  }
  if (!Array.isArray(payload.entries) || payload.entries.length < 2) {
    throw new PostingValidationError('INVALID', 'a posting requires at least 2 entries');
  }

  let debits = 0;
  let credits = 0;
  for (const e of payload.entries) {
    if (e.direction !== 'debit' && e.direction !== 'credit') {
      throw new PostingValidationError('INVALID', `bad direction '${e.direction}'`);
    }
    if (!Number.isInteger(e.amount_minor) || e.amount_minor <= 0 || e.amount_minor > MAX_AMOUNT_MINOR) {
      throw new PostingValidationError(
        'INVALID',
        `amount_minor for ${e.account_code} must be a positive integer <= ${MAX_AMOUNT_MINOR}`,
      );
    }
    if (typeof e.account_code !== 'string' || e.account_code.length === 0) {
      throw new PostingValidationError('INVALID', 'account_code is required on every entry');
    }
    if (e.direction === 'debit') debits += e.amount_minor;
    else credits += e.amount_minor;
  }

  if (debits !== credits) {
    throw new PostingValidationError(
      'UNBALANCED',
      `debits (${debits}) != credits (${credits})`,
    );
  }
}

export type { LedgerDOStub };
