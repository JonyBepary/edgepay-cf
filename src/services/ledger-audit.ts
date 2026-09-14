/**
 * D1 side of the ledger posting protocol — outbox drain + audit trail.
 *
 * In the outbox model, the DO is the authoritative book of record.
 * D1 is an asynchronously drained audit mirror and read model.
 *
 * Both buildLedgerAuditStatements and writeLedgerAuditTrail are IDEMPOTENT
 * and safe to retry without double-inserting.
 */

import type { Env, D1PreparedStatement } from '../types/env';
import type { PostingPayload } from '../types/ledger';

/**
 * Step D (legacy / replay) — insert the write-ahead posting row with status='pending'.
 *
 * Retained for reconciliation replay of legacy or un-migrated pending postings.
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
 * Build (but do not execute) the D1 statements that mirror a posting
 * into the audit read-model. Callers batch these across many postings
 * so the outbox drain is a single atomic D1 round-trip.
 *
 * Idempotent: every statement uses INSERT OR IGNORE / ON CONFLICT keyed on tx_id
 * (or (tx_id, account_code, direction) for entries). Re-running the
 * drain after a partial success is safe.
 */
export function buildLedgerAuditStatements(
  env: Env,
  merchantId: number,
  payload: PostingPayload,
  postedAtIso: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    // 1. Audit registry: written as 'posted' directly (no 'pending' phase).
    // If a legacy pending row exists, update it to posted.
    env.DB
      .prepare(
        `INSERT INTO op_ledger_postings
           (tx_id, merchant_id, reference_type, reference_id, currency, payload_json, status, created_at, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)
         ON CONFLICT(tx_id) DO UPDATE SET
           status = 'posted',
           posted_at = excluded.posted_at,
           error = NULL`,
      )
      .bind(
        payload.tx_id,
        merchantId,
        payload.reference_type,
        payload.reference_id ?? null,
        payload.currency,
        JSON.stringify(payload),
        postedAtIso,
        postedAtIso,
      ),

    // 2. Transaction header: uuid doubles as tx_id for dedup
    env.DB
      .prepare(
        `INSERT INTO op_ledger_transactions
           (merchant_id, uuid, reference_type, reference_id, description, status, posted_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'posted', ?, ?)
         ON CONFLICT(uuid) DO NOTHING`,
      )
      .bind(
        merchantId,
        payload.tx_id,
        payload.reference_type,
        payload.reference_id ?? null,
        payload.description ?? '',
        postedAtIso,
        postedAtIso,
      ),
  ];

  // 3. Journal entries: guarded by entry_order so legitimate duplicate legs
  // (e.g. two separate debits to 1010 of the same amount) are preserved,
  // while replay of the entire drain batch remains strictly idempotent.
  payload.entries.forEach((e, entryIndex) => {
    const entryOrder = entryIndex + 1;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO op_ledger_entries
             (merchant_id, ledger_transaction_id, account_id, direction, amount, currency, entry_order, created_at)
           SELECT t.merchant_id, t.id, ?, ?, ?, ?, ?, ?
           FROM op_ledger_transactions t
           WHERE t.uuid = ?
             AND NOT EXISTS (
               SELECT 1 FROM op_ledger_entries le
               WHERE le.ledger_transaction_id = t.id
                 AND le.entry_order = ?
             )`,
        )
        .bind(
          e.d1_account_id,
          e.direction,
          e.amount,
          payload.currency,
          entryOrder,
          postedAtIso,
          payload.tx_id,
          entryOrder,
        ),
    );
  });

  return statements;
}

/**
 * Legacy / helper: write the D1 audit trail and flip the posting row to 'posted'.
 * Composes buildLedgerAuditStatements into an atomic env.DB.batch call.
 */
export async function writeLedgerAuditTrail(
  env: Env,
  payload: PostingPayload,
  postedAtIso: string,
): Promise<{ ledger_transaction_id: number }> {
  const statements = buildLedgerAuditStatements(env, payload.merchant_id, payload, postedAtIso);
  await env.DB.batch(statements);

  const row = await env.DB
    .prepare(`SELECT id FROM op_ledger_transactions WHERE uuid = ?`)
    .bind(payload.tx_id)
    .first<{ id: number }>();

  return { ledger_transaction_id: row?.id ?? 0 };
}
