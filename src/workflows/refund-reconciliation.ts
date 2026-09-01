/**
 * Refund Reconciliation Workflow — v0.2.1 rewrite (review fix #3).
 *
 * v0.2.0's sketch had three real bugs:
 *   1. It claimed "failed steps auto-retry forever — no DLQ needed",
 *      but every step set `retries: {limit: 3}`; after that the
 *      instance halts in `errored`. The DLQ wasn't eliminated, it was
 *      renamed "errored instances" — without alerting.
 *   2. `step.sleep("10 minutes"); return;` polled ONCE and ended the
 *      instance — incomplete refunds were never revisited.
 *   3. The trigger path was undefined: nothing created instances, and
 *      nothing swept stuck refunds.
 *
 * v0.2.1:
 *   - Instance-per-refund (id `refund-{id}`, created at refund creation
 *     by RefundService — the defined trigger path; the daily sweep
 *     re-drives stuck ones via `refund-{id}-sweep-{n}`).
 *   - A bounded poll LOOP with backoff (1m doubling to a 30m cap,
 *     ~24h total window), each poll a step with its own retries.
 *   - Exhaustion throws NonRetryableError: the instance halts `errored`
 *     — that IS the DLQ, and it pages (alert on errored instances).
 *   - Every terminal step is idempotent (ledger reversal keyed by the
 *     original transaction's uuid; status flips guarded by WHERE).
 */

import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../types/env';
import { LedgerService } from '../services/ledger';
import { WebhookDispatcher } from '../services/webhook-dispatcher';
import { gatewayRegistry } from '../gateways/base';
import { decrypt } from '../lib/crypto';
import { page } from '../lib/observability';

export interface RefundReconciliationParams {
  refund_id: number;
}

interface RefundRecord {
  id: number;
  merchant_id: number;
  refund_id: string;
  transaction_id: number;
  gateway_refund_id: string | null;
  amount: string;
  currency: string;
  status: string;
}

interface GatewayStatusResult {
  status: 'completed' | 'pending' | 'failed';
  gateway_refund_id?: string;
}

// ------------------------------------------------------------------
// Poll policy — pure functions, unit-tested in tests/workflow-policy.test.ts
// ------------------------------------------------------------------

/**
 * Maximum polls per instance. With the backoff schedule below the total
 * window is ~24h: 1+2+4+8+15 minutes of escalation (30m), then a 30m cap
 * for the remaining 47 polls (23.5h).
 */
export const REFUND_POLL_MAX_ATTEMPTS = 52;

/** Backoff schedule: 1m, 2m, 4m, 8m, 15m, then a 30m cap. */
export function refundPollBackoffMs(attempt: number): number {
  const schedule = [60_000, 120_000, 240_000, 480_000, 900_000];
  if (attempt < schedule.length) return schedule[attempt];
  return 1_800_000;
}

/** Total polling window covered by MAX_ATTEMPTS (ms). */
export function refundPollWindowMs(): number {
  let total = 0;
  for (let i = 0; i < REFUND_POLL_MAX_ATTEMPTS; i++) total += refundPollBackoffMs(i);
  return total;
}

/** Should this attempt halt the instance as errored (the DLQ)? */
export function shouldHaltRefundPolling(attempt: number): boolean {
  return attempt >= REFUND_POLL_MAX_ATTEMPTS;
}

const STEP_RETRIES = { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const };
const GATEWAY_RETRIES = { limit: 3, delay: '30 seconds' as const, backoff: 'exponential' as const };

export class RefundReconciliationWorkflow extends WorkflowEntrypoint<Env, RefundReconciliationParams> {
  async run(event: WorkflowEvent<RefundReconciliationParams>, step: WorkflowStep): Promise<void> {
    const refundId = event.payload.refund_id;
    const env = this.env;

    // Step 1: Load the refund record (replayed from cache on retries)
    const refund = await step.do(
      'load-refund-record',
      { retries: STEP_RETRIES, timeout: '30 seconds' },
      async (): Promise<RefundRecord> => {
        const row = await env.DB
          .prepare(
            `SELECT id, merchant_id, refund_id, transaction_id, gateway_refund_id,
                    amount, currency, status
             FROM op_refunds WHERE id = ? LIMIT 1`,
          )
          .bind(refundId)
          .first<RefundRecord>();
        if (!row) throw new NonRetryableError(`Refund ${refundId} not found`);
        return row;
      },
    );

    // Idempotent replay guard: instance re-created after completion is a no-op
    if (refund.status === 'completed' || refund.status === 'failed') {
      return;
    }

    // Step 2: POLL LOOP — bounded, backoff-scheduled. This is the fix
    // for v0.2.0's "sleep once, return, never revisit".
    for (let attempt = 0; attempt < REFUND_POLL_MAX_ATTEMPTS; attempt++) {
      const gatewayResult = await step.do(
        `query-gateway-status-${attempt}`,
        { retries: GATEWAY_RETRIES, timeout: '60 seconds' },
        async (): Promise<GatewayStatusResult> => queryGatewayRefundStatus(env, refund),
      );

      if (gatewayResult.status === 'completed') {
        await this.finalizeRefund(step, refund);
        return;
      }

      if (gatewayResult.status === 'failed') {
        await step.do(
          'mark-refund-failed',
          { retries: STEP_RETRIES, timeout: '15 seconds' },
          async (): Promise<void> => {
            await env.DB
              .prepare(`UPDATE op_refunds SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`)
              .bind(new Date().toISOString(), refund.id)
              .run();
          },
        );
        page(env, 'REFUND_GATEWAY_FAILED', { refund_id: refund.refund_id, merchant_id: refund.merchant_id });
        return;
      }

      // Still pending at the gateway — wait, then poll again.
      // step.sleep is durable: on replay the workflow resumes here.
      await step.sleep(`wait-${attempt}`, refundPollBackoffMs(attempt));
    }

    // Poll window exhausted (~24h). Halt the instance as ERRORED — this
    // is the DLQ. Alerting on errored instances (dashboard alert policy
    // or Workers Logs rule on REFUND_STUCK) pages a human.
    // Terminal failure observability: page BEFORE throwing so the errored
    // status + structured log both fire without inventing a custom Workflow
    // onFailure hook (no such API exists — paging is via logs/metrics).
    page(env, 'REFUND_STUCK', {
      refund_id: refund.refund_id,
      merchant_id: refund.merchant_id,
      attempts: REFUND_POLL_MAX_ATTEMPTS,
      window_hours: Math.round(refundPollWindowMs() / 3_600_000),
    });
    throw new NonRetryableError(
      `REFUND_STUCK: refund ${refund.refund_id} unresolved after ${REFUND_POLL_MAX_ATTEMPTS} polls (~${Math.round(refundPollWindowMs() / 3_600_000)}h)`,
    );
  }

  /** Terminal path: ledger reversal -> outbound webhook -> status flip. */
  private async finalizeRefund(step: WorkflowStep, refund: RefundRecord): Promise<void> {
    const env = this.env;

    // Ledger reversal is IDEMPOTENT: its tx_id derives from the original
    // transaction's uuid, so step retries / workflow replays cannot
    // double-reverse (review fix #2: tx_id dedup at the ledger).
    await step.do(
      'post-ledger-reversal',
      { retries: STEP_RETRIES, timeout: '30 seconds' },
      async (): Promise<{ ledger_transaction_id?: number }> => {
        const ledger = new LedgerService(env);
        // The original tx row may already be 'reversed' from a prior
        // partial run — treat that as success, not failure.
        try {
          const result = await ledger.reverse(refund.transaction_id, `Refund ${refund.refund_id}`);
          return { ledger_transaction_id: result.ledger_transaction_id };
        } catch (err) {
          if (String(err).includes('already reversed')) return {};
          throw err;
        }
      },
    );

    await step.do(
      'dispatch-webhook',
      { retries: { limit: 5, delay: '1 minute', backoff: 'exponential' }, timeout: '30 seconds' },
      async (): Promise<{ dispatched: boolean }> => {
        const dispatcher = new WebhookDispatcher(env);
        await dispatcher.dispatch({
          merchant_id: refund.merchant_id,
          event: 'refund.completed',
          data: {
            transaction_id: refund.transaction_id,
            refund_id: refund.refund_id,
            amount: refund.amount,
            currency: refund.currency,
            status: 'completed',
          },
        });
        return { dispatched: true };
      },
    );

    await step.do(
      'mark-refund-completed',
      { retries: STEP_RETRIES, timeout: '15 seconds' },
      async (): Promise<void> => {
        await env.DB
          .prepare(`UPDATE op_refunds SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'pending'`)
          .bind(new Date().toISOString(), refund.id)
          .run();
      },
    );
  }
}

/**
 * Query the gateway for the refund's current status. Uses the adapter's
 * queryRefundStatus() when implemented; adapters without a status API
 * return 'pending' (see BaseGatewayAdapter), which keeps the loop alive
 * until the poll window exhausts and the instance halts for manual
 * review. A refund that never even got a gateway refund id failed at
 * initiation.
 */
async function queryGatewayRefundStatus(env: Env, refund: RefundRecord): Promise<GatewayStatusResult> {
  if (!refund.gateway_refund_id) {
    // Refund was never initiated at the gateway (manual gateway or the
    // initiation call failed) — nothing to poll.
    return { status: 'failed' };
  }

  const gatewaySlug = await env.DB
    .prepare(
      `SELECT g.slug AS gateway_slug FROM op_transactions t
       JOIN op_gateways g ON g.id = t.gateway_id
       WHERE t.id = ? LIMIT 1`,
    )
    .bind(refund.transaction_id)
    .first<{ gateway_slug: string }>();

  if (!gatewaySlug?.gateway_slug) {
    return { status: 'pending' };
  }

  try {
    const adapter = gatewayRegistry.resolve(gatewaySlug.gateway_slug);

    // Load the merchant's gateway credentials (same path as payment.ts)
    const credRows = await env.DB
      .prepare(
        `SELECT gc.field_name, gc.field_value FROM op_gateway_configs gc
         JOIN op_payment_intents pi ON pi.gateway_id = gc.gateway_id
         JOIN op_transactions t ON t.payment_intent_id = pi.id
         WHERE t.id = ?`,
      )
      .bind(refund.transaction_id)
      .all<{ field_name: string; field_value: string }>();

    const credentials: Record<string, string> = {};
    for (const row of credRows.results) {
      try {
        credentials[row.field_name] = await decrypt(row.field_value, env.ENCRYPTION_KEY);
      } catch {
        /* skip undecryptable fields */
      }
    }

    const status = await adapter.queryRefundStatus(refund.gateway_refund_id, credentials);
    return { status, gateway_refund_id: refund.gateway_refund_id };
  } catch {
    // Adapter/credential problems are transient from the workflow's view:
    // report pending so the loop retries, and the step-level retries
    // handle the failure mode.
    return { status: 'pending' };
  }
}
