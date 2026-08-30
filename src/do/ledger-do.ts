/**
 * LedgerDO — ONE Durable Object per merchant, owning ALL of that
 * merchant's ledger accounts (review fix #1: the posting protocol).
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
 * Storage (SQLite-backed DO, INTEGER minor units so SQL aggregation is
 * numerically correct):
 *   accounts(code, name, type, currency, balance_minor, updated_at)
 *   posted_transactions(tx_id PK, ...)   <- tx_id dedup registry
 *   journal_entries(id, tx_id, account_code, direction, amount_minor, ...)
 *
 * Posting protocol — every step inside blockConcurrencyWhile (see
 * docs/POSTING-PROTOCOL.md for the full failure matrix):
 *   A. shape validation (pure)
 *   B. tx_id dedup (the dedup v0.2.0 was missing — webhook redelivery
 *      or a workflow retry could double-post)
 *   C. per-account balance check (THE GUARD v0.2.0 shipped commented
 *      out — without it this DO is a serialized accumulator, not a guard)
 *   D. D1 write-ahead row: op_ledger_postings status='pending'
 *   E. DO journal + balances
 *   F. D1 audit trail + postings -> 'posted'
 *
 * Throughput: one request + a few SQLite ops + one D1 batch sustains far
 * more than any single merchant's payment rate. Do not split per-account.
 *
 * TEST SEAMS: __testInjectFault() is a one-shot failure-injection hook
 * used exclusively by the consistency property tests. It is part of the
 * documented test surface, not an auth bypass.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types/env';
import type {
  LedgerDOStub,
  PostingEntry,
  PostingPayload,
  PostingResult,
} from '../types/ledger';
import { PostingValidationError } from '../types/ledger';
import { DEFAULT_CHART_OF_ACCOUNTS, isDebitNormal } from '../lib/ledger-chart';
import { insertPendingPosting, writeLedgerAuditTrail } from '../services/ledger-audit';

const MAX_AMOUNT_MINOR = 9_000_000_000_000; // 90M in minor units — far above any single BD/AF payment

interface AccountRow {
  code: string;
  name: string;
  type: string;
  currency: string;
  balance_minor: number;
}

/** Per-tenant snapshot cadence for the DO alarm (per-merchant scheduled work). */
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class LedgerDO extends DurableObject<Env> {
  /** TEST-ONLY one-shot failure injection (consumed at the injected point). */
  private faults: {
    fail_d1_pending?: boolean;
    fail_do_writes?: boolean;
    fail_d1_posted?: boolean;
  } | null = null;

  /** In-memory chart-seed guard — skips the INSERT OR IGNORE fan-out after
   *  the first posting per isolate (resets on eviction; always idempotent). */
  private seededCurrency: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // v0.2.2 (audit §3 — DO best practices: "use blockConcurrencyWhile for
    // one-time initialization"): table bootstrap used to run 5 × CREATE
    // TABLE IF NOT EXISTS on EVERY RPC (ensureSeeded per request). It now
    // runs ONCE per isolate in the constructor; blockConcurrencyWhile holds
    // the input gate until the tables exist, so no RPC can ever observe a
    // missing table.
    ctx.blockConcurrencyWhile(async () => {
      this.ensureTables();
    });
  }

  // ------------------------------------------------------------------
  // THE posting path
  // ------------------------------------------------------------------

  /**
   * Post one balanced transaction atomically.
   * Serialized by blockConcurrencyWhile — this is the single writer for
   * the merchant's entire book. Everything (including the two D1 hops)
   * happens inside the block, so the check at step C can never race
   * against a concurrent posting.
   *
   * NEVER THROWS: if the blockConcurrencyWhile closure throws, workerd
   * marks the DO's input gate BROKEN and every subsequent call to this
   * tenant's ledger fails until eviction (empirically confirmed by the
   * real-workerd test suite). Failures are returned as structured
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
        // Transient / unexpected (D1 hiccup, injected fault, bug):
        // retryable — reconciliation replays pending rows.
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
      };
    }

    // C. Balance check — the guard v0.2.0 shipped disabled. Resulting
    //    per-account balances may never go below zero on the account's
    //    normal side. Throws INSUFFICIENT_FUNDS before anything is written.
    const deltas = this.checkBalances(payload.entries, payload.currency);

    // D. D1 write-ahead row (status='pending'). If this throws, nothing
    //    anywhere has changed and the caller may safely retry.
    if (this.faults?.fail_d1_pending) {
      this.faults = null;
      throw new Error('INJECTED:fail_d1_pending');
    }
    const prior = await insertPendingPosting(this.env, payload, postedAt);
    if (prior === 'rejected') {
      // Poison guard: this tx_id was already deterministically rejected by
      // reconciliation; refuse rather than silently resurrect it.
      throw new PostingValidationError(
        'REJECTED_TX_ID',
        `tx_id ${payload.tx_id} was previously rejected`,
      );
    }
    // prior === 'posted' → D1 ahead of DO (hard-crash window) — proceed and heal.

    // E. Journal + balances inside the DO. IMPORTANT (empirically confirmed
    //    against real workerd by the integration tests): when this event
    //    COMPLETES — even returning a structured failure — these writes
    //    COMMIT. There is NO throw/rollback story to lean on (and a throw
    //    would break the DO's input gate). Correctness therefore rests on
    //    the dedup at step B plus the reconciliation heal path, which
    //    together make every ordering of DO-committed / D1-pending converge.
    if (this.faults?.fail_do_writes) {
      this.faults = null;
      throw new Error('INJECTED:fail_do_writes');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO posted_transactions (tx_id, reference_type, reference_id, currency, description, posted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      payload.tx_id,
      payload.reference_type,
      payload.reference_id,
      payload.currency,
      payload.description,
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

    // F. D1 audit trail + pending -> posted. If this fails, the DO state
    //    from E stands committed while the pending row remains —
    //    reconciliation replays, hits the dedup at step B, and rewrites
    //    the audit trail (the heal path). No rollback involved.
    if (this.faults?.fail_d1_posted) {
      this.faults = null;
      throw new Error('INJECTED:fail_d1_posted');
    }
    const { ledger_transaction_id } = await writeLedgerAuditTrail(
      this.env,
      payload,
      postedAt,
    );

    return {
      status: 'posted',
      tx_id: payload.tx_id,
      posted_at: postedAt,
      ledger_transaction_id,
    };
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async getBalances(): Promise<AccountRow[]> {
    // Tables are guaranteed by the constructor's blockConcurrencyWhile —
    // no per-RPC seeding tax. Accounts appear after the first posting.
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
  // DO alarm — per-merchant scheduled work (balance snapshot), replacing
  // global-cron fan-out for anything that is naturally per-tenant.
  // ------------------------------------------------------------------

  async alarm(): Promise<void> {
    try {
      await this.snapshotBalances();
    } finally {
      // Always reschedule — a failed snapshot must not kill the cadence.
      await this.ctx.storage.setAlarm(Date.now() + SNAPSHOT_INTERVAL_MS);
    }
  }

  /** Snapshot all account balances into D1 (idempotent per day via PK). */
  async snapshotBalances(): Promise<{ snapshot_at: string; accounts: number }> {
    const accounts = this.rows(
      `SELECT code, currency, balance_minor FROM accounts`,
    ) as Array<{ code: string; currency: string; balance_minor: number }>;
    const asOf = new Date().toISOString();

    const merchantId = Number(this.ctx.id.name?.replace(/^merchant-/, '') ?? 0) || 0;
    if (accounts.length > 0) {
      await this.env.DB.batch(
        accounts.map(a =>
          this.env.DB
            .prepare(
              `INSERT OR IGNORE INTO op_ledger_balance_snapshots
                 (merchant_id, account_code, currency, balance_minor, as_of)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .bind(merchantId, a.code, a.currency, Number(a.balance_minor), asOf),
        ),
      );
    }
    return { snapshot_at: asOf, accounts: accounts.length };
  }

  // ------------------------------------------------------------------
  // TEST-ONLY failure injection
  // ------------------------------------------------------------------

  async __testInjectFault(faults: {
    fail_d1_pending?: boolean;
    fail_do_writes?: boolean;
    fail_d1_posted?: boolean;
  }): Promise<void> {
    this.faults = faults;
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
   * per isolate from the constructor's blockConcurrencyWhile (v0.2.2).
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
  }

  /**
   * Seed the default chart of accounts (14 rows, INSERT OR IGNORE).
   * v0.2.2: guarded per isolate by `seededCurrency` so the fan-out runs on
   * the first posting per isolate instead of every posting (it re-runs
   * after eviction — and is still self-healing if the chart gains accounts,
   * since INSERT OR IGNORE only ever adds missing accounts at balance 0).
   * Accounts are seeded with the FIRST posting's currency — the DO is
   * single-currency per merchant by design. A posting in a different
   * currency is rejected with CURRENCY_MISMATCH by checkBalances rather
   * than corrupting balances.
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
   * single `as T[]` cast (safe: the SQL and the cast sit on adjacent lines).
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
