/**
 * Refund Service — v0.2.1 (review fix #3: the DEFINED trigger path).
 *
 * Refund lifecycle:
 *   1. createRefund()      — validates the transaction is refundable,
 *                            calls the gateway adapter's refund() when
 *                            supported, writes the op_refunds row, and
 *                            IMMEDIATELY creates the per-refund workflow
 *                            instance (id `refund-{id}` — idempotent).
 *   2. RefundReconciliationWorkflow — polls the gateway until terminal,
 *                            posts the (idempotent) ledger reversal,
 *                            dispatches the webhook, flips status.
 *   3. sweepStuckRefunds() — daily re-drive for anything unresolved.
 *
 * There is exactly one place refunds are created and exactly one place
 * instances are triggered — no cron-scan fan-out, no orphan refunds.
 */

import type { Env } from '../types/env';
import type { Money } from '../lib/money';
import { gatewayRegistry } from '../gateways/base';
import { decrypt } from '../lib/crypto';
import { triggerRefundReconciliation } from './reconciliation';
import { page } from '../lib/observability';

export interface CreateRefundInput {
  merchant_id: number;
  transaction_id: number;
  amount: Money;
  reason?: string;
  initiated_by: number | null;
}

export interface CreateRefundResult {
  refund_row_id: number;
  refund_id: string;
  gateway_refund_id: string | null;
  workflow_instance_id: string;
  workflow_created: boolean;
}

export class RefundService {
  constructor(private readonly env: Env) {}

  async createRefund(input: CreateRefundInput): Promise<CreateRefundResult> {
    const env = this.env;
    const now = new Date().toISOString();

    // 1. The transaction must exist, be completed, and belong to the merchant
    const tx = await env.DB
      .prepare(
        `SELECT t.id, t.trx_id, t.amount, t.currency, t.status, t.merchant_id,
                t.gateway_trx_id, g.slug AS gateway_slug, pi.id AS payment_intent_id
         FROM op_transactions t
         JOIN op_payment_intents pi ON pi.id = t.payment_intent_id
         LEFT JOIN op_gateways g ON g.id = t.gateway_id
         WHERE t.id = ? AND t.merchant_id = ? LIMIT 1`,
      )
      .bind(input.transaction_id, input.merchant_id)
      .first<{
        id: number;
        trx_id: string;
        amount: Money;
        currency: string;
        status: string;
        merchant_id: number;
        gateway_trx_id: string | null;
        gateway_slug: string | null;
        payment_intent_id: number;
      }>();

    if (!tx) {
      throw new Error('Transaction not found for this merchant');
    }
    if (tx.status !== 'completed') {
      throw new Error(`Only completed transactions can be refunded (status: ${tx.status})`);
    }

    // Enforce cumulative refund bounds: amount <= captured - sum(prior refunds)
    const priorRefunds = await env.DB
      .prepare(
        `SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) as total_refunded
         FROM op_refunds 
         WHERE transaction_id = ? AND merchant_id = ? AND status IN ('completed', 'pending', 'processing')`
      )
      .bind(input.transaction_id, input.merchant_id)
      .first<{ total_refunded: number }>();

    const totalRefunded = priorRefunds?.total_refunded ?? 0;
    const requestedRefund = parseFloat(input.amount);
    const capturedAmount = parseFloat(tx.amount);

    if (isNaN(requestedRefund) || requestedRefund <= 0) {
      throw new Error('Refund amount must be a positive decimal');
    }

    if (totalRefunded + requestedRefund > capturedAmount + 0.001) {
      throw new Error(
        `Refund amount (${input.amount}) exceeds remaining refundable amount (${(capturedAmount - totalRefunded).toFixed(2)})`
      );
    }

    // 2. Ask the gateway to issue the refund (best effort — manual
    //    gateways return unsupported and the refund is processed off-band;
    //    the workflow polls and eventually pages if it never settles).
    let gatewayRefundId: string | null = null;
    try {
      if (tx.gateway_slug && tx.gateway_trx_id) {
        const adapter = gatewayRegistry.resolve(tx.gateway_slug);
        const credentials = await this.loadCredentials(tx.payment_intent_id);
        const result = await adapter.refund(tx.gateway_trx_id, input.amount, credentials, { kv: this.env.KV });
        if (result.success && result.refund_id) {
          gatewayRefundId = result.refund_id;
        }
      }
    } catch (err) {
      // Refund initiation failed at the gateway — record the refund row
      // anyway (status pending) so the workflow + sweep track it; page so
      // an operator sees the failed initiation immediately.
      page(env, 'REFUND_INITIATION_FAILED', {
        transaction_id: input.transaction_id,
        merchant_id: input.merchant_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 3. Atomically persist the refund row with conditional bound check (NEW-P2-001 fix)
    const refundPublicId = `rfnd_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const inserted = await env.DB
      .prepare(
        `INSERT INTO op_refunds
           (merchant_id, refund_id, transaction_id, gateway_refund_id, amount,
            currency, reason, status, initiated_by, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
         WHERE (
           SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) FROM op_refunds
           WHERE transaction_id = ? AND merchant_id = ?
             AND status IN ('completed', 'pending', 'processing')
         ) + CAST(? AS NUMERIC) <= (SELECT CAST(amount AS NUMERIC) FROM op_transactions WHERE id = ?) + 0.001`,
      )
      .bind(
        input.merchant_id,
        refundPublicId,
        input.transaction_id,
        gatewayRefundId,
        input.amount,
        tx.currency,
        input.reason ?? null,
        input.initiated_by,
        now,
        now,
        input.transaction_id,
        input.merchant_id,
        input.amount,
        input.transaction_id,
      )
      .run();

    if (!inserted.meta?.changes || inserted.meta.changes === 0) {
      throw new Error(`Refund amount (${input.amount}) exceeds remaining refundable amount`);
    }

    const refundRowId = inserted.meta?.last_row_id ?? 0;

    // 4. THE trigger path — instance-per-refund, idempotent by instance id
    const trigger = await triggerRefundReconciliation(env, refundRowId);

    return {
      refund_row_id: refundRowId,
      refund_id: refundPublicId,
      gateway_refund_id: gatewayRefundId,
      workflow_instance_id: trigger.instance_id,
      workflow_created: trigger.created,
    };
  }

  private async loadCredentials(paymentIntentId: number): Promise<Record<string, string>> {
    const rows = await this.env.DB
      .prepare(
        `SELECT gc.field_name, gc.field_value FROM op_gateway_configs gc
         JOIN op_payment_intents pi ON pi.gateway_id = gc.gateway_id
         WHERE pi.id = ?`,
      )
      .bind(paymentIntentId)
      .all<{ field_name: string; field_value: string }>();

    const credentials: Record<string, string> = {};
    for (const row of rows.results) {
      try {
        credentials[row.field_name] = await decrypt(row.field_value, this.env.ENCRYPTION_KEY);
      } catch {
        /* skip undecryptable fields */
      }
    }
    return credentials;
  }
}
