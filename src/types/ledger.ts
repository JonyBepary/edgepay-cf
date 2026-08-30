/**
 * Ledger posting protocol — shared types.
 *
 * THE PROTOCOL (review fix #1 + #2) — see docs/POSTING-PROTOCOL.md:
 *
 *   LedgerDO.postTransaction(payload) runs inside blockConcurrencyWhile:
 *     A. validate shape (balanced: Σdebits == Σcredits, ≥2 entries, positive amounts)
 *     B. dedup by tx_id against the DO's posted_transactions table
 *     C. balance check against per-account running balances (THE re-enabled guard)
 *     D. D1: INSERT op_ledger_postings status='pending'   (write-ahead row)
 *     E. DO: SQLite journal + balances                    (single writer)
 *     F. D1: audit-trail batch + postings status='posted' (idempotent)
 *
 * Failure semantics:
 *   - D fails → throw → nothing changed anywhere (client may retry, same tx_id)
 *   - E fails → throw → DO rolls back, pending row remains → reconciliation replays
 *   - F fails → DO committed, pending row remains → reconciliation heals
 *     (replay returns 'duplicate' → reconciliation rewrites the audit trail)
 *   - hard crash anywhere → pending row → replay is idempotent either way
 *
 * One Durable Object per merchant owns ALL of that merchant's accounts,
 * so a multi-account posting (clearing + revenue + fees) is ONE atomic
 * DO call — there is no cross-DO fan-out and therefore no atomicity gap.
 */

export type PostingReferenceType = 'payment' | 'refund' | 'fee' | 'adjustment' | 'transfer';

export interface PostingEntry {
  /** Chart code inside the tenant's LedgerDO, e.g. '1010' (Gateway Clearing) */
  account_code: string;
  /** D1 op_ledger_accounts.id — used only for the D1 audit mirror */
  d1_account_id: number;
  direction: 'debit' | 'credit';
  /** Money decimal string (audit mirror) */
  amount: string;
  /** INTEGER minor units — authoritative inside the DO */
  amount_minor: number;
}

export interface PostingPayload {
  /** Globally unique idempotency key: 'm{merchant_id}:{kind}:{reference}' */
  tx_id: string;
  merchant_id: number;
  reference_type: PostingReferenceType;
  reference_id: string | null;
  description: string;
  currency: string;
  entries: PostingEntry[];
}

export type PostingStatus = 'posted' | 'duplicate' | 'failed';

/**
 * The RPC result contract.
 *
 * CRITICAL PLATFORM CONSTRAINT (found by the real-workerd tests): if the
 * closure passed to blockConcurrencyWhile() THROWS, workerd marks the DO's
 * input gate broken — every subsequent call to the merchant's LedgerDO
 * fails until eviction. A single unbalanced payload would take the whole
 * tenant's ledger down. So postTransaction NEVER throws: validation and
 * transient failures come back as { status: 'failed', error_code, error }
 * and the WORKER side (LedgerService) re-scaffolds them into exceptions,
 * where throwing is harmless.
 */
export interface PostingResult {
  status: PostingStatus;
  tx_id: string;
  posted_at: string;
  /** D1 op_ledger_transactions.id (audit mirror row), when available */
  ledger_transaction_id?: number;
  /** status === 'failed' only: structured code for routing/reconciliation */
  error_code?: PostingErrorCode;
  /** status === 'failed' only: human-readable detail (no [CODE] prefix) */
  error?: string;
}

export type PostingErrorCode =
  | 'UNBALANCED'
  | 'INSUFFICIENT_FUNDS'
  | 'UNKNOWN_ACCOUNT'
  | 'INVALID'
  | 'CURRENCY_MISMATCH'
  | 'REJECTED_TX_ID'
  /** Transient: D1 hiccup, injected fault, anything unexpected. Retryable. */
  | 'INTERNAL';

/**
 * Validation error thrown by the DO. RPC propagation flattens custom
 * properties, so the code travels inside the message as '[CODE] detail'.
 */
export class PostingValidationError extends Error {
  constructor(
    public readonly code: PostingErrorCode,
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
    this.name = 'PostingValidationError';
  }
}

/** Parse a posting error thrown across an RPC boundary back into its code. */
export function parsePostingErrorCode(err: unknown): PostingErrorCode | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /^\[([A-Z_]+)\]/.exec(msg);
  if (!m) return null;
  const code = m[1] as PostingErrorCode;
  const valid: PostingErrorCode[] = [
    'UNBALANCED',
    'INSUFFICIENT_FUNDS',
    'UNKNOWN_ACCOUNT',
    'INVALID',
    'CURRENCY_MISMATCH',
    'REJECTED_TX_ID',
    'INTERNAL',
  ];
  return valid.includes(code) ? code : null;
}

/** Typed RPC surface of the per-tenant LedgerDO. */
export interface LedgerDOStub {
  /** NEVER throws — failures return { status: 'failed', error_code } (see PostingResult). */
  postTransaction(payload: PostingPayload): Promise<PostingResult>;
  getBalances(): Promise<Array<{
    code: string;
    name: string;
    type: string;
    currency: string;
    balance_minor: number;
  }>>;
  getTransactionStatus(tx_id: string): Promise<{ exists: boolean; posted_at: string | null }>;
  trialBalance(): Promise<{
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
  }>;
  snapshotBalances(): Promise<{ snapshot_at: string; accounts: number }>;
  /** TEST-ONLY: one-shot failure injection for the consistency property test */
  __testInjectFault(faults: {
    fail_d1_pending?: boolean;
    fail_do_writes?: boolean;
    fail_d1_posted?: boolean;
  }): Promise<void>;
}
