/**
 * SMS queue consumer — parses incoming SMS to extract payment confirmations.
 *
 * Pipeline (v0.2.1):
 *   1. Receive SMS from mobile companion app via /api/mobile/v1/sms
 *   2. Enqueue for parsing (this consumer)
 *   3. Apply per-gateway regex template; on miss, Workers AI fallback
 *   4. CORROBORATE the extraction against open (awaiting_verification)
 *      transactions — exact amount match, unambiguous order, sender-ID
 *      gateway verification (see services/sms-corroboration.ts).
 *      The v0.2.0 bug this closes: any amount+trx_id match auto-confirmed
 *      the LATEST transaction with that amount — an ambiguous or
 *      complete-but-wrong extraction could confirm the wrong order.
 *   5. Corroborated -> complete transaction + post ledger (the ledger
 *      posting is itself idempotent per payment intent, so a redelivered
 *      queue message cannot double-post).
 *   6. Not corroborated -> manual review queue + parse-miss metric.
 */

import type { Env, SmsMessage } from '../types/env';
import { corroborateSmsPayment, senderToGatewaySlug, type OpenOrderCandidate, type SmsExtraction } from '../services/sms-corroboration';
import { metric } from '../lib/observability';

/** Only transactions created within this window are matchable. */
const MATCH_WINDOW_MS = 30 * 60 * 1000;

export class SmsQueueConsumer {
  async process(
    batch: { messages: Message<SmsMessage>[] },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await Promise.allSettled(
      batch.messages.map(msg => this.processOne(msg, env, ctx)),
    );
  }

  private async processOne(
    msg: Message<SmsMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const sms = msg.body;
    const now = new Date().toISOString();

    try {
      // Persist the SMS
      const result = await env.DB
        .prepare(
          `INSERT INTO op_sms_data (merchant_id, sender, body, match_status, created_at)
           VALUES (?, ?, ?, 'pending', ?)`,
        )
        .bind(sms.merchant_id, sms.sender, sms.body, now)
        .run();

      const smsId = result.meta?.last_row_id ?? 0;

      // --- Parse: regex templates first, Workers AI fallback on miss ---
      const { SmsParserService } = await import('../services/sms-parser');
      const parser = new SmsParserService(env);
      const extraction: SmsExtraction = await parser.parse(sms.body, sms.sender, sms.merchant_id);

      await env.DB
        .prepare(
          `UPDATE op_sms_data
           SET parsed_amount = ?, parsed_trx_id = ?, parsed_at = ?, match_status = 'parsed', template_id = NULL
           WHERE id = ?`,
        )
        .bind(extraction.amount, extraction.trx_id, now, smsId)
        .run();

      if (extraction.parser === 'none') {
        metric(env, 'sms_parse_miss', { merchant_id: sms.merchant_id, value: 1 });
        await env.DB
          .prepare(`UPDATE op_sms_data SET match_status = 'no_match' WHERE id = ?`)
          .bind(smsId)
          .run();
        await msg.ack();
        return;
      }

      // --- Corroborate against OPEN transactions before confirming ---
      const openOrders = await this.loadOpenOrders(env, sms.merchant_id);
      const verifiedGateway = senderToGatewaySlug(sms.sender);
      const decision = corroborateSmsPayment(extraction, openOrders, verifiedGateway);

      if (decision.action === 'confirm') {
        const { PaymentService } = await import('../services/payment');
        const service = new PaymentService(env);
        await service.completeTransaction(
          decision.order.transaction_row_id,
          decision.order.payment_intent_id,
          extraction.trx_id ?? `sms-${smsId}`,
        );
        await env.DB
          .prepare(`UPDATE op_sms_data SET match_status = 'matched' WHERE id = ?`)
          .bind(smsId)
          .run();
        metric(env, 'sms_confirmed', {
          merchant_id: sms.merchant_id,
          gateway: decision.gateway_slug,
          extra: decision.gateway_source,
        });
      } else {
        // Manual review — NEVER auto-confirm without corroboration
        await env.DB
          .prepare(`UPDATE op_sms_data SET match_status = 'needs_manual_review' WHERE id = ?`)
          .bind(smsId)
          .run();
        metric(env, 'sms_manual_review', {
          merchant_id: sms.merchant_id,
          extra: decision.reason,
          value: 1,
        });
      }

      await msg.ack();
    } catch (err) {
      console.error('SMS processing failed:', err);
      await msg.retry({ delaySeconds: 60 });
    }
  }

  /** Open (awaiting_verification) transactions in the match window. */
  private async loadOpenOrders(env: Env, merchantId: number): Promise<OpenOrderCandidate[]> {
    const since = new Date(Date.now() - MATCH_WINDOW_MS).toISOString();
    const rows = await env.DB
      .prepare(
        `SELECT t.id, t.payment_intent_id, t.amount, t.currency, t.gateway_trx_id, pi.metadata, g.slug AS gateway_slug
         FROM op_transactions t
         JOIN op_payment_intents pi ON pi.id = t.payment_intent_id
         LEFT JOIN op_gateways g ON g.id = t.gateway_id
         WHERE t.merchant_id = ? AND t.status IN ('pending', 'awaiting_verification', 'processing', 'created') AND t.created_at >= ?
         ORDER BY t.created_at DESC LIMIT 50`,
      )
      .bind(merchantId, since)
      .all<{
        id: number;
        payment_intent_id: number;
        amount: string;
        currency: string;
        gateway_trx_id: string | null;
        metadata: string | null;
        gateway_slug: string | null;
      }>();
    return rows.results.map(r => {
      let meta: Record<string, unknown> = {};
      try {
        if (r.metadata) meta = JSON.parse(r.metadata);
      } catch {}
      return {
        transaction_row_id: r.id,
        payment_intent_id: r.payment_intent_id,
        amount: r.amount,
        currency: r.currency,
        gateway_slug: r.gateway_slug,
        customer_trx_id: (meta.customer_trx_id as string) ?? r.gateway_trx_id ?? null,
        customer_phone: (meta.customer_phone as string) ?? null,
      };
    });
  }
}

export const smsQueueHandler = new SmsQueueConsumer();
