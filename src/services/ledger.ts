/**
 * Ledger Service — v0.2.1: per-tenant LedgerDO posting protocol.
 *
 * v0.2.0 (reviewed) kept per-account DOs and fanned each posting out to
 * N account DOs plus a D1 batch — three systems with no atomicity
 * between them, patched with best-effort rollbacks. The review's
 * verdict: per-account DOs solve a contention problem this system does
 * not have, at the cost of the atomicity problem it does.
 *
 * v0.2.1: ONE LedgerDO per merchant owns the merchant's entire book.
 * `post()` is now a thin adapter: resolve the tenant's chart, build the
 * canonical PostingPayload, and make a single idempotent RPC into the
 * DO. The DO (see src/do/ledger-do.ts) enforces:
 *   - Σdebits == Σcredits          (shape validation)
 *   - tx_id dedup                  (webhook redelivery / retries can't double-post)
 *   - per-account balance guard    (the check v0.2.0 shipped disabled)
 *   - two-phase D1 (pending -> posted) with idempotent replay
 *
 * The D1 tables op_ledger_transactions / op_ledger_entries remain as
 * the audit mirror (written by the DO via services/ledger-audit.ts);
 * op_ledger_postings is the protocol's book of record.
 */

import type { Env } from '../types/env';
import type { Money } from '../lib/money';
import { fromMinorUnits, toMinorUnits } from '../lib/money';
import { randomUuid } from '../lib/crypto';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../lib/ledger-chart';
import type {
  LedgerDOStub,
  PostingEntry,
  PostingPayload,
  PostingReferenceType,
  PostingResult,
} from '../types/ledger';
import { PostingValidationError } from '../types/ledger';

export type LedgerAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type LedgerDirection = 'debit' | 'credit';
export type LedgerRefType = PostingReferenceType;

export interface PostEntryInput {
  account_id: number;         // D1 op_ledger_accounts.id
  direction: LedgerDirection;
  amount: Money;
}

export interface PostTransactionInput {
  merchant_id: number;
  reference_type: LedgerRefType;
  reference_id: string | null;
  description: string;
  entries: PostEntryInput[];
}

export interface PostOptions {
  /**
   * Deterministic idempotency key. Supply it for anything replayable
   * (payment intent id, refund id, ...); omit for one-shot adjustments.
   */
  idempotency_key?: string;
}

interface AccountRow {
  id: number;
  merchant_id: number;
  code: string;
  name: string;
  type: LedgerAccountType;
  currency: string;
}

/** Resolve the per-tenant LedgerDO stub (one DO per merchant). */
export function getLedgerDO(env: Env, merchantId: number): LedgerDOStub {
  const id = env.LEDGER_DO.idFromName(`merchant-${merchantId}`);
  return env.LEDGER_DO.get(id) as unknown as LedgerDOStub;
}

/** Strict Money -> integer minor units (rejects >2dp / non-numeric / unsafe). */
export function moneyToMinorStrict(amount: Money): number {
  if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`invalid money value '${amount}'`);
  }
  const minor = toMinorUnits(amount);
  if (!Number.isInteger(minor) || !Number.isSafeInteger(minor)) {
    throw new Error(`money value '${amount}' is not representable in minor units`);
  }
  return minor;
}

export class LedgerService {
  constructor(private readonly env: Env) {}

  /**
   * Post a balanced transaction through the tenant's LedgerDO.
   * Idempotent when `opts.idempotency_key` is supplied: the DO dedups
   * by tx_id and returns { status: 'duplicate' } on replay.
   *
   * The DO returns structured failures (it must never throw across
   * blockConcurrencyWhile — see types/ledger.ts); THIS is where they
   * become exceptions again, on the worker side where throwing is safe.
   */
  async post(input: PostTransactionInput, opts: PostOptions = {}): Promise<PostingResult> {
    const payload = await this.buildPayload(input, opts.idempotency_key);
    const stub = getLedgerDO(this.env, input.merchant_id);
    const result = await stub.postTransaction(payload);
    if (result.status === 'failed') {
      throw new PostingValidationError(
        result.error_code ?? 'INTERNAL',
        result.error ?? 'posting failed',
      );
    }
    return result;
  }

  /**
   * Reverse a posted transaction by posting inverse entries.
   * Idempotent: the reversal's tx_id is derived from the original's
   * uuid, so a workflow retry or a reconciliation replay cannot
   * double-reverse.
   */
  async reverse(ledgerTransactionId: number, reason: string): Promise<PostingResult> {
    const original = await this.env.DB
      .prepare(
        `SELECT id, merchant_id, uuid, reference_type, reference_id, description
         FROM op_ledger_transactions WHERE id = ? AND status = 'posted' LIMIT 1`,
      )
      .bind(ledgerTransactionId)
      .first<{
        id: number;
        merchant_id: number;
        uuid: string;
        reference_type: LedgerRefType;
        reference_id: string | null;
        description: string;
      }>();

    if (!original) {
      // Already reversed (or never existed) — idempotent no-op signal.
      throw new Error('Ledger transaction not found or already reversed');
    }

    const entries = await this.env.DB
      .prepare(
        `SELECT le.account_id, le.direction, le.amount
         FROM op_ledger_entries le WHERE le.ledger_transaction_id = ?`,
      )
      .bind(ledgerTransactionId)
      .all<{ account_id: number; direction: LedgerDirection; amount: Money }>();

    const reversedEntries: PostEntryInput[] = entries.results.map(e => ({
      account_id: e.account_id,
      direction: e.direction === 'debit' ? 'credit' : 'debit',
      amount: e.amount,
    }));

    const result = await this.post(
      {
        merchant_id: original.merchant_id,
        reference_type: 'adjustment',
        reference_id: String(original.id),
        description: `REVERSAL of #${original.id}: ${reason}`,
        entries: reversedEntries,
      },
      { idempotency_key: `m${original.merchant_id}:reversal:${original.uuid}` },
    );

    // Idempotent status flip (no-op if a prior attempt already did it)
    await this.env.DB
      .prepare(`UPDATE op_ledger_transactions SET status = 'reversed' WHERE id = ? AND status = 'posted'`)
      .bind(ledgerTransactionId)
      .run();

    return result;
  }

  /** Strongly-consistent account balance, straight from the tenant's DO. */
  async getAccountBalance(accountId: number, merchantId: number): Promise<Money> {
    const acct = await this.env.DB
      .prepare(`SELECT code FROM op_ledger_accounts WHERE id = ? AND merchant_id = ? LIMIT 1`)
      .bind(accountId, merchantId)
      .first<{ code: string }>();
    if (!acct) return '0.00';
    const balances = await getLedgerDO(this.env, merchantId).getBalances();
    const row = balances.find(b => b.code === acct.code);
    return row ? fromMinorUnits(row.balance_minor) : '0.00';
  }

  /**
   * Trial balance from the DO — the authoritative book, aggregated in
   * INTEGER minor units (TEXT SUM() in SQL is lexically wrong; we never
   * rely on it for correctness).
   */
  async trialBalance(merchantId: number): Promise<{
    balanced: boolean;
    total_debits: Money;
    total_credits: Money;
  }> {
    const t = await getLedgerDO(this.env, merchantId).trialBalance();
    return {
      balanced: t.balanced,
      total_debits: fromMinorUnits(t.total_debit_minor),
      total_credits: fromMinorUnits(t.total_credit_minor),
    };
  }

  /**
   * Cross-check the DO's authoritative balances against the D1 audit
   * mirror (JS aggregation via decimal.js — never SQL SUM on TEXT).
   * Aggregated in JS by design: with TEXT money this is the only
   * correct way; the DO itself already aggregates in integers.
   */
  async verifyDurableObjectConsistency(merchantId: number): Promise<{
    consistent: boolean;
    discrepancies: Array<{ account_id: number; code: string; d1_balance: Money; do_balance: Money }>;
  }> {
    const [accounts, entries, doBalances, doTrial] = await Promise.all([
      this.env.DB
        .prepare(`SELECT id, code FROM op_ledger_accounts WHERE merchant_id = ?`)
        .bind(merchantId)
        .all<{ id: number; code: string }>(),
      this.env.DB
        .prepare(
          `SELECT le.account_id, le.direction, le.amount
           FROM op_ledger_entries le
           JOIN op_ledger_accounts la ON la.id = le.account_id
           WHERE le.merchant_id = ?`,
        )
        .bind(merchantId)
        .all<{ account_id: number; direction: LedgerDirection; amount: Money }>(),
      getLedgerDO(this.env, merchantId).getBalances(),
      getLedgerDO(this.env, merchantId).trialBalance(),
    ]);

    const codeById = new Map(accounts.results.map(a => [a.id, a.code]));

    // D1-derived balances per account code, in minor units (JS + Decimal)
    const d1Minor = new Map<string, number>();
    for (const e of entries.results) {
      const code = codeById.get(e.account_id) ?? String(e.account_id);
      d1Minor.set(code, (d1Minor.get(code) ?? 0) + toMinorUnits(e.amount) * (e.direction === 'debit' ? 1 : -1));
    }

    // DO-derived (signed per normal side, matching how balance_minor is stored)
    const doByCode = new Map(doBalances.map(b => [b.code, b]));
    const discrepancies: Array<{ account_id: number; code: string; d1_balance: Money; do_balance: Money }> = [];
    for (const [code, doBalance] of doByCode) {
      const d1Signed = d1Minor.get(code) ?? 0;
      const doSigned = doBalance.type === 'asset' || doBalance.type === 'expense' ? doBalance.balance_minor : -doBalance.balance_minor;
      if (d1Signed !== doSigned) {
        discrepancies.push({
          account_id: accounts.results.find(a => a.code === code)?.id ?? 0,
          code,
          d1_balance: fromMinorUnits(d1Signed),
          do_balance: fromMinorUnits(doBalance.balance_minor),
        });
      }
    }

    return {
      consistent: discrepancies.length === 0 && doTrial.balanced,
      discrepancies,
    };
  }

  /**
   * Create the default chart of accounts for a new merchant (D1 rows —
   * the audit mirror + reporting joins; the DO seeds its own copy from
   * the same shared chart on the merchant's first posting).
   */
  async createDefaultChartOfAccounts(merchantId: number, currency: string): Promise<void> {
    const now = new Date().toISOString();
    const stmts = DEFAULT_CHART_OF_ACCOUNTS.map(a =>
      this.env.DB
        .prepare(
          `INSERT INTO op_ledger_accounts (merchant_id, code, name, type, currency, is_system, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(merchantId, a.code, a.name, a.type, currency, now, now),
    );
    await this.env.DB.batch(stmts);
  }

  /** Resolve an account by code + currency. */
  async getAccountByCode(merchantId: number, code: string, currency: string): Promise<AccountRow | null> {
    return this.env.DB
      .prepare(
        `SELECT id, merchant_id, code, name, type, currency
         FROM op_ledger_accounts WHERE merchant_id = ? AND code = ? AND currency = ? LIMIT 1`,
      )
      .bind(merchantId, code, currency)
      .first<AccountRow>();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async buildPayload(input: PostTransactionInput, idempotencyKey?: string): Promise<PostingPayload> {
    // Resolve D1 account rows (id -> code) for the audit mirror
    const accountIds = [...new Set(input.entries.map(e => e.account_id))];
    const placeholders = accountIds.map(() => '?').join(', ');
    const accountRows = await this.env.DB
      .prepare(
        `SELECT id, merchant_id, code, name, type, currency
         FROM op_ledger_accounts WHERE merchant_id = ? AND id IN (${placeholders})`,
      )
      .bind(input.merchant_id, ...accountIds)
      .all<AccountRow>();

    const byId = new Map(accountRows.results.map(a => [a.id, a]));
    const currency = accountRows.results[0]?.currency ?? 'BDT';

    const entries: PostingEntry[] = input.entries.map(e => {
      const acct = byId.get(e.account_id);
      if (!acct) {
        throw new Error(`Unknown ledger account ${e.account_id} for merchant ${input.merchant_id}`);
      }
      return {
        account_code: acct.code,
        d1_account_id: acct.id,
        direction: e.direction,
        amount: e.amount,
        amount_minor: moneyToMinorStrict(e.amount),
      };
    });

    return {
      tx_id: idempotencyKey ?? `m${input.merchant_id}:${input.reference_type}:${input.reference_id ?? randomUuid()}`,
      merchant_id: input.merchant_id,
      reference_type: input.reference_type,
      reference_id: input.reference_id,
      description: input.description,
      currency,
      entries,
    };
  }
}

/**
 * Post a payment-completion entry. Idempotent per payment intent: the
 * tx_id is `m{merchant}:payment:{intentId}`, so a webhook redelivery,
 * an SMS race, or a workflow retry can never double-post a payment.
 */
export async function postPaymentLedgerEntry(
  env: Env,
  merchantId: number,
  paymentIntentId: number,
  amount: Money,
  fee: Money,
  currency: string,
): Promise<{ ledger_transaction_id: number; tx_id: string; status: string }> {
  const ledger = new LedgerService(env);

  const [clearingAccount, revenueAccount, feeExpenseAccount] = await Promise.all([
    ledger.getAccountByCode(merchantId, '1010', currency),
    ledger.getAccountByCode(merchantId, '4000', currency),
    ledger.getAccountByCode(merchantId, '5000', currency),
  ]);

  if (!clearingAccount || !revenueAccount || !feeExpenseAccount) {
    throw new Error('Default ledger accounts not initialized for merchant');
  }

  const entries: PostEntryInput[] = [
    { account_id: clearingAccount.id, direction: 'debit', amount },
    { account_id: revenueAccount.id, direction: 'credit', amount },
  ];

  if (fee !== '0.00') {
    entries.push({ account_id: feeExpenseAccount.id, direction: 'debit', amount: fee });
    entries.push({ account_id: clearingAccount.id, direction: 'credit', amount: fee });
  }

  const result = await ledger.post(
    {
      merchant_id: merchantId,
      reference_type: 'payment',
      reference_id: String(paymentIntentId),
      description: `Payment ${paymentIntentId} — ${amount} ${currency}`,
      entries,
    },
    { idempotency_key: `m${merchantId}:payment:${paymentIntentId}` },
  );

  return { ledger_transaction_id: result.ledger_transaction_id ?? 0, tx_id: result.tx_id, status: result.status };
}
