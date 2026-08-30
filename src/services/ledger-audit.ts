/**
 * D1 side of the ledger posting protocol — write-ahead row + audit trail.
 *
 * Both functions are IDEMPOTENT and are intentionally usable from BOTH
 * the LedgerDO (normal posting, steps D and F) and the reconciliation
 * service (replay / heal path). They never touch DO state.
 *
 * The audit mirror keeps the existing op_ledger_transactions /
 * op_ledger_entries tables (TEXT Money) so existing reporting keeps
 * working; op_ledger_postings is the protocol's book of record.
 */

import type { Env } from '../types/env';
import type { PostingPayload } from '../types/ledger';

/**
 * Step D — insert the write-ahead posting row with status='pending'.
 *
 * ON CONFLICT DO NOTHING: a pending row from a crashed earlier attempt
 * (same tx_id) is exactly the state reconciliation will replay, so the
 * insert must not fail. Returns the existing row's status when a row
 * was already present (null when freshly inserted):
 *   - 'pending'  → stale attempt or in-flight replay: proceed
 *   - 'posted'   → D1 ahead of DO (hard-crash window): proceed and heal
 *   - 'rejected' → poison guard: this tx_id was already deterministically
 *                  rejected; refuse rather than silently resurrect it
 */
export async function insertPendingPosting(
  env: Env,
  payload: PostingPayload,
  createdAtIso: string,
): Promise<'pending' | 'posted' | 'rejected' | null> {
  const inserted = await env.DB
    .prepare(
      `INSERT INTO op_ledger_postings
         (tx_id, merchant_id, reference_type, reference_id, currency, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(tx_id) DO NOTHING`,
    )
    .bind(
      payload.tx_id,
      payload.merchant_id,
      payload.reference_type,
      payload.reference_id,
      payload.currency,
      JSON.stringify(payload),
      createdAtIso,
    )
    .run();

  if (inserted.meta?.changes && inserted.meta.changes > 0) {
    return null; // fresh insert
  }

  const existing = await env.DB
    .prepare(`SELECT status FROM op_ledger_postings WHERE tx_id = ?`)
    .bind(payload.tx_id)
    .first<{ status: 'pending' | 'posted' | 'rejected' }>();

  return existing?.status ?? 'pending';
}

/**
 * Step F — write the D1 audit trail and flip the posting row to 'posted'.
 *
 * Everything is one D1 batch (atomic) and every statement is idempotent:
 *   1. transaction header — ON CONFLICT(uuid = tx_id) DO NOTHING
 *   2. one entry insert per journal line — guarded by NOT EXISTS on
 *      (ledger_transaction_id, account_id, direction, amount)
 *   3. UPDATE op_ledger_postings → status='posted'
 *
 * Replay safety: re-running this batch after a partial failure is a no-op
 * for statements that already landed, and completes the ones that didn't.
 */
export async function writeLedgerAuditTrail(
  env: Env,
  payload: PostingPayload,
  postedAtIso: string,
): Promise<{ ledger_transaction_id: number }> {
  const statements = [
    // 1. Header (uuid doubles as the protocol tx_id → natural dedup)
    env.DB
      .prepare(
        `INSERT INTO op_ledger_transactions
           (merchant_id, uuid, reference_type, reference_id, description, status, posted_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'posted', ?, ?)
         ON CONFLICT(uuid) DO NOTHING`,
      )
      .bind(
        payload.merchant_id,
        payload.tx_id,
        payload.reference_type,
        payload.reference_id,
        payload.description,
        postedAtIso,
        postedAtIso,
      ),
  ];

  // 2. Journal entries — each guarded so a replay never double-inserts
  for (const e of payload.entries) {
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO op_ledger_entries
             (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, created_at)
           SELECT t.merchant_id, t.id, ?, ?, ?, ?, ?
           FROM op_ledger_transactions t
           WHERE t.uuid = ?
             AND NOT EXISTS (
               SELECT 1 FROM op_ledger_entries le
               WHERE le.ledger_transaction_id = t.id
                 AND le.account_id = ?
                 AND le.direction = ?
                 AND le.amount = ?
             )`,
        )
        .bind(
          e.d1_account_id,
          e.direction,
          e.amount,
          payload.currency,
          postedAtIso,
          payload.tx_id,
          e.d1_account_id,
          e.direction,
          e.amount,
        ),
    );
  }

  // 3. Flip the write-ahead row
  statements.push(
    env.DB
      .prepare(
        `UPDATE op_ledger_postings
         SET status = 'posted', posted_at = ?, attempts = attempts + 1, error = NULL
         WHERE tx_id = ?`,
      )
      .bind(postedAtIso, payload.tx_id),
  );

  await env.DB.batch(statements);

  const row = await env.DB
    .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
    .bind(payload.tx_id)
    .first<{ id: number }>();

  return { ledger_transaction_id: row?.id ?? 0 };
}
