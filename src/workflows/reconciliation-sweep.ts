/**
 * Reconciliation Sweep Workflow — the daily deep pass (review fix #3:
 * "what sweeps stuck refunds?").
 *
 * Runs the full reconciliation battery as durable, retryable steps:
 *   1. replay-pending-postings — heal anything the posting protocol's
 *      two-phase D1 write left pending (crash windows, D1 hiccups)
 *   2. verify-ledger-consistency — the standing property: D1-aggregated
 *      balances == DO balances for every active merchant; drift PAGES
 *   3. sweep-stuck-refunds — re-drive refund workflows that never
 *      resolved, page for refunds past the re-drive limit
 *   4. record-run — audit row in op_reconciliation_runs
 *
 * Triggered daily (cron `0 2 * * *` -> scheduled() -> triggerDailySweep)
 * with an idempotent instance id `sweep-{YYYY-MM-DD}`, and available
 * ad-hoc via POST /api/admin/v1/reconcile.
 *
 * Failure policy: each step retries 3x with backoff; exhausting them
 * halts the instance as ERRORED, which pages (alert on errored
 * instances — the same policy as the refund workflow).
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../types/env';
import {
  reconcilePendingPostings,
  verifyAllMerchants,
  sweepStuckRefunds,
} from '../services/reconciliation';
import { page } from '../lib/observability';

export interface SweepParams {
  date: string;
}

const STEP_RETRIES = { limit: 3, delay: '30 seconds' as const, backoff: 'exponential' as const };

export class ReconciliationSweepWorkflow extends WorkflowEntrypoint<Env, SweepParams> {
  async run(_event: WorkflowEvent<SweepParams>, step: WorkflowStep): Promise<{
    pending: { replayed: number; healed: number; rejected: number; failed: number; remaining: number };
    consistency: { checked: number; drift_count: number };
    refunds: { retriggered: number; stuck: number };
  }> {
    const env = this.env;

    try {
      const pending = await step.do(
        'replay-pending-postings',
        { retries: STEP_RETRIES, timeout: '5 minutes' },
        async () => reconcilePendingPostings(env, { limit: 500 }),
      );

      const consistency = await step.do(
        'verify-ledger-consistency',
        { retries: STEP_RETRIES, timeout: '5 minutes' },
        async () => {
          const r = await verifyAllMerchants(env);
          // Workflow step results must be Rpc-serializable — stringify the
          // free-form drift detail while keeping the counts numeric.
          return {
            checked: r.checked,
            drift_count: r.drift_count,
            drifts: r.drifts.map(d => ({ merchant_id: d.merchant_id, detail: JSON.stringify(d.detail) })),
          };
        },
      );

      const refunds = await step.do(
        'sweep-stuck-refunds',
        { retries: STEP_RETRIES, timeout: '5 minutes' },
        async () => sweepStuckRefunds(env),
      );

      // op_reconciliation_runs audit row is written by runReconciliation's
      // wrapper when triggered via cron/ops; the workflow records it again
      // with trigger='daily' so the run is attributable to the workflow.
      await step.do(
        'record-run',
        { retries: STEP_RETRIES, timeout: '30 seconds' },
        async () => {
          const ranAt = new Date().toISOString();
          await env.DB
            .prepare(
              `INSERT INTO op_reconciliation_runs
                 (ran_at, trigger, pending_replayed, pending_healed, pending_rejected,
                  pending_failed, pending_remaining, merchants_checked, drift_count,
                  refunds_retriggered, details_json)
               VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              ranAt,
              pending.replayed,
              pending.healed,
              pending.rejected,
              pending.failed,
              pending.remaining,
              consistency.checked,
              consistency.drift_count,
              refunds.retriggered,
              JSON.stringify({ drifts: consistency.drifts, stuck_refunds: refunds.stuck }),
            )
            .run();
        },
      );

      return { pending, consistency, refunds };
    } catch (err) {
      // Terminal failure observability: a step exhausted retries and the
      // instance will halt as `errored`. Page here so the DLQ is visible
      // without inventing a Workflow.onError API (no such hook exists).
      page(env, 'RECONCILIATION_SWEEP_FAILED', {
        error: err instanceof Error ? err.message : String(err),
        date: _event.payload?.date ?? 'unknown',
      });
      throw err;
    }
  }
}
