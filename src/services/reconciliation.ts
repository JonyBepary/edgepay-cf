/**
 * Reconciliation service — the recovery half of the posting protocol.
 *
 * The protocol guarantees at most one committed posting per tx_id and a
 * durable 'pending' row in D1 for anything not fully converged. This
 * module closes the loop:
 *
 *   reconcilePendingPostings() — replay pending rows into the tenant's
 *     LedgerDO (idempotent: posts if the DO rolled back, heals the D1
 *     audit trail if the DO committed but step F failed). Runs hourly
 *     (cron) and daily (sweep workflow).
 *
 *   verifyAllMerchants() — property that must always hold: the DO's
 *     aggregated balances equal the D1 audit mirror's aggregation, and
 *     Σdebits == Σcredits per merchant. Drift PAGES (never just logs).
 *
 *   sweepStuckRefunds() — the refund trigger story: instance-per-refund
 *     workflows created at refund creation, re-driven here when a
 *     refund sits unresolved > 24h. After MAX_WORKFLOW_ATTEMPTS the
 *     refund pages for manual intervention.
 *
 *   triggerRefundReconciliation() / triggerDailySweep() — the ONLY two
 *     places that create workflow instances (defined trigger paths —
 *     review fix #3).
 */

import type { Env } from '../types/env';
import type { PostingPayload, PostingErrorCode, LedgerDOStub } from '../types/ledger';
import { getLedgerDO } from './ledger';
import { writeLedgerAuditTrail } from './ledger-audit';
import { page, metric } from '../lib/observability';

/** A posting younger than this may still be in flight — don't replay it. */
const PENDING_GRACE_MS = 30_000;
/** Max replay attempts before a pending posting is quarantined as rejected. */
const MAX_PENDING_ATTEMPTS = 5;
/** Refunds older than this with no resolution get the workflow re-driven. */
const REFUND_STUCK_MS = 24 * 60 * 60 * 1000;
/** Max workflow re-drives before a stuck refund pages for a human. */
export const MAX_REFUND_WORKFLOW_ATTEMPTS = 3;

export interface PendingReconcileResult {
  replayed: number;
  healed: number;
  rejected: number;
  failed: number;
  remaining: number;
}

/** Failure codes that are DETERMINISTIC — a replay can never succeed. */
const DETERMINISTIC_FAILURE_CODES: ReadonlySet<PostingErrorCode> = new Set([
  'UNBALANCED',
  'INSUFFICIENT_FUNDS',
  'UNKNOWN_ACCOUNT',
  'INVALID',
  'CURRENCY_MISMATCH',
  'REJECTED_TX_ID',
]);

export async function reconcilePendingPostings(
  env: Env,
  opts: { graceMs?: number; limit?: number } = {},
): Promise<PendingReconcileResult> {
  const graceMs = opts.graceMs ?? PENDING_GRACE_MS;
  const limit = opts.limit ?? 200;
  const cutoff = new Date(Date.now() - graceMs).toISOString();

  const result: PendingReconcileResult = { replayed: 0, healed: 0, rejected: 0, failed: 0, remaining: 0 };

  const pending = await env.DB
    .prepare(
      `SELECT tx_id, merchant_id, payload_json, attempts
       FROM op_ledger_postings
       WHERE status = 'pending' AND created_at < ?
       ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(cutoff, limit)
    .all<{ tx_id: string; merchant_id: number; payload_json: string; attempts: number }>();

  for (const row of pending.results) {
    const payload = JSON.parse(row.payload_json) as PostingPayload;

    // postTransaction returns structured failures (never throws across
    // the DO's blockConcurrencyWhile — a throw would break the input gate).
    let posted: Awaited<ReturnType<LedgerDOStub['postTransaction']>>;
    try {
      posted = await getLedgerDO(env, row.merchant_id).postTransaction(payload);
    } catch (err) {
      // Transport-level failure (DO restarting, RPC canceled) — transient
      const message = err instanceof Error ? err.message : String(err);
      await bumpAttempts(env, row.tx_id, message);
      result.failed++;
      continue;
    }

    if (posted.status === 'failed') {
      const code = posted.error_code ?? 'INTERNAL';
      const message = posted.error ?? 'posting failed';

      if (DETERMINISTIC_FAILURE_CODES.has(code)) {
        // Deterministic validation failure — quarantine as rejected so it
        // can't spin forever (operator can inspect + re-issue manually).
        await env.DB
          .prepare(`UPDATE op_ledger_postings SET status = 'rejected', error = ?, attempts = attempts + 1 WHERE tx_id = ?`)
          .bind(`[${code}] ${message}`, row.tx_id)
          .run();
        result.rejected++;
        page(env, 'LEDGER_POSTING_REJECTED', { tx_id: row.tx_id, merchant_id: row.merchant_id, error: `[${code}] ${message}` });
      } else if (row.attempts + 1 >= MAX_PENDING_ATTEMPTS) {
        await env.DB
          .prepare(`UPDATE op_ledger_postings SET status = 'rejected', error = ?, attempts = attempts + 1 WHERE tx_id = ?`)
          .bind(`exhausted retries: ${message}`, row.tx_id)
          .run();
        result.rejected++;
        page(env, 'LEDGER_POSTING_EXHAUSTED', { tx_id: row.tx_id, merchant_id: row.merchant_id, error: message });
      } else {
        // Transient (D1 hiccup, DO restart) — bump attempts, retry next cycle
        await bumpAttempts(env, row.tx_id, message);
        result.failed++;
      }
      continue;
    }

    if (posted.status === 'duplicate') {
      // DO committed on a prior attempt but step F (audit trail) never
      // landed — write it now. This is the heal path.
      await writeLedgerAuditTrail(env, payload, posted.posted_at);
      result.healed++;
      metric(env, 'ledger_posting_healed', { merchant_id: row.merchant_id });
    } else {
      result.replayed++;
    }
  }

  const remaining = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM op_ledger_postings WHERE status = 'pending'`)
    .first<{ n: number }>();
  result.remaining = remaining?.n ?? 0;

  return result;
}

/** Transient-failure bookkeeping: bump attempts (quarantine decision is the caller's). */
async function bumpAttempts(env: Env, txId: string, message: string): Promise<void> {
  await env.DB
    .prepare(`UPDATE op_ledger_postings SET attempts = attempts + 1, error = ? WHERE tx_id = ?`)
    .bind(message, txId)
    .run();
}

export interface ConsistencyVerifyResult {
  checked: number;
  drift_count: number;
  drifts: Array<{ merchant_id: number; detail: unknown }>;
}

/**
 * The standing property test, in production: for every active merchant,
 * D1-aggregated balances == DO balances, and each merchant's book is
 * internally balanced. Any drift PAGES — reconciliation drift is an
 * incident, not a log line.
 */
export async function verifyAllMerchants(env: Env): Promise<ConsistencyVerifyResult> {
  const { LedgerService } = await import('./ledger');
  const ledger = new LedgerService(env);

  const merchants = await env.DB
    .prepare(`SELECT id FROM op_merchants WHERE status = 'active' AND is_platform = 0`)
    .all<{ id: number }>();

  const out: ConsistencyVerifyResult = { checked: 0, drift_count: 0, drifts: [] };

  for (const m of merchants.results) {
    out.checked++;
    const consistency = await ledger.verifyDurableObjectConsistency(m.id);
    if (!consistency.consistent) {
      out.drift_count++;
      out.drifts.push({ merchant_id: m.id, detail: consistency.discrepancies });
      page(env, 'LEDGER_RECONCILIATION_DRIFT', {
        merchant_id: m.id,
        discrepancies: consistency.discrepancies,
      });
    }
  }
  return out;
}

export interface RefundSweepResult {
  retriggered: number;
  stuck: number;
}

/**
 * The refund sweep half of the trigger story: refunds that have sat
 * unresolved past the workflow's ~24h poll window get their workflow
 * re-driven (idempotently, new instance id per attempt). After
 * MAX_REFUND_WORKFLOW_ATTEMPTS the refund pages for manual review —
 * this is the explicit "errored instances are the DLQ" policy.
 */
export async function sweepStuckRefunds(env: Env): Promise<RefundSweepResult> {
  const cutoff = new Date(Date.now() - REFUND_STUCK_MS).toISOString();
  const result: RefundSweepResult = { retriggered: 0, stuck: 0 };

  const stuck = await env.DB
    .prepare(
      `SELECT id, refund_id, workflow_attempts FROM op_refunds
       WHERE status = 'pending' AND created_at < ? AND workflow_attempts < ?`,
    )
    .bind(cutoff, MAX_REFUND_WORKFLOW_ATTEMPTS)
    .all<{ id: number; refund_id: string; workflow_attempts: number }>();

  for (const r of stuck.results) {
    await triggerRefundReconciliation(env, r.id, `sweep-${r.workflow_attempts + 1}`);
    await env.DB
      .prepare(`UPDATE op_refunds SET workflow_attempts = workflow_attempts + 1, last_workflow_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), r.id)
      .run();
    result.retriggered++;
  }

  // Anything still pending beyond the last allowed attempt: page.
  const terminal = await env.DB
    .prepare(
      `SELECT id, refund_id FROM op_refunds
       WHERE status = 'pending' AND created_at < ? AND workflow_attempts >= ?`,
    )
    .bind(cutoff, MAX_REFUND_WORKFLOW_ATTEMPTS)
    .all<{ id: number; refund_id: string }>();

  for (const r of terminal.results) {
    result.stuck++;
    page(env, 'REFUND_STUCK_MANUAL_REVIEW', { refund_id: r.refund_id, refund_row: r.id });
  }

  return result;
}

// ------------------------------------------------------------------
// Workflow triggers — the ONLY places instances are created
// ------------------------------------------------------------------

export interface TriggerResult {
  instance_id: string;
  created: boolean;
}

/**
 * Trigger the refund reconciliation workflow for one refund.
 * Instance-per-refund: id `refund-{id}` (or `refund-{id}-{suffix}` for
 * sweep re-drives) so replays and re-drives are idempotent by id.
 */
export async function triggerRefundReconciliation(
  env: Env,
  refundId: number,
  suffix?: string,
): Promise<TriggerResult> {
  const instanceId = `refund-${refundId}${suffix ? `-${suffix}` : ''}`;
  try {
    await env.REFUND_WORKFLOW.create({ id: instanceId, params: { refund_id: refundId } });
    return { instance_id: instanceId, created: true };
  } catch (err) {
    if (String(err).toLowerCase().includes('already exists')) {
      return { instance_id: instanceId, created: false };
    }
    throw err;
  }
}

/** Trigger the daily reconciliation sweep (idempotent per UTC day). */
export async function triggerDailySweep(env: Env, dateStr?: string): Promise<TriggerResult> {
  const date = dateStr ?? new Date().toISOString().slice(0, 10);
  const instanceId = `sweep-${date}`;
  try {
    await env.SWEEP_WORKFLOW.create({ id: instanceId, params: { date } });
    return { instance_id: instanceId, created: true };
  } catch (err) {
    if (String(err).toLowerCase().includes('already exists')) {
      return { instance_id: instanceId, created: false };
    }
    throw err;
  }
}

// ------------------------------------------------------------------
// Combined run — used by the hourly cron, the sweep workflow, and the
// manual ops endpoint. Writes an op_reconciliation_runs audit row.
// ------------------------------------------------------------------

export interface ReconciliationRunSummary {
  ran_at: string;
  trigger: 'hourly' | 'daily' | 'manual';
  pending: PendingReconcileResult;
  consistency: ConsistencyVerifyResult | null;
  refunds: RefundSweepResult | null;
}

export async function runReconciliation(
  env: Env,
  trigger: 'hourly' | 'daily' | 'manual',
  _opts: { withSweep?: boolean } = {},
): Promise<ReconciliationRunSummary> {
  const ranAt = new Date().toISOString();
  const pending = await reconcilePendingPostings(env);

  const consistency = trigger === 'hourly' ? null : await verifyAllMerchants(env);
  const refunds = trigger === 'hourly' ? null : await sweepStuckRefunds(env);

  const summary: ReconciliationRunSummary = { ran_at: ranAt, trigger, pending, consistency, refunds };

  await env.DB
    .prepare(
      `INSERT INTO op_reconciliation_runs
         (ran_at, trigger, pending_replayed, pending_healed, pending_rejected,
          pending_failed, pending_remaining, merchants_checked, drift_count,
          refunds_retriggered, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      ranAt,
      trigger,
      pending.replayed,
      pending.healed,
      pending.rejected,
      pending.failed,
      pending.remaining,
      consistency?.checked ?? 0,
      consistency?.drift_count ?? 0,
      refunds?.retriggered ?? 0,
      JSON.stringify({ drifts: consistency?.drifts ?? [], stuck_refunds: refunds?.stuck ?? 0 }),
    )
    .run();

  metric(env, 'reconciliation_run', {
    trigger,
    replayed: pending.replayed,
    healed: pending.healed,
    rejected: pending.rejected,
    drift: consistency?.drift_count ?? 0,
  });

  return summary;
}
