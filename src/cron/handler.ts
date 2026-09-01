/**
 * Cron trigger handler — port of EdgePay's 9 PHP cron jobs.
 *
 * Wrangler.toml [triggers.crons] maps 3 schedules to this handler
 * (v0.2.1 — consolidated from 5: refund reconciliation is now
 * instance-per-refund workflow-driven, and per-merchant scheduled work
 * runs on DO alarms, so the 6-hourly cron and the every-minute cron
 * are gone. This also frees cron quota on the free plan — 5 crons is
 * the entire ACCOUNT limit there.)
 *   every 5 min  -> intent expiry, SMS verification queue
 *   hourly       -> currency update, domain re-verification, pending
 *                   posting replay (the posting protocol's fast-heal pass)
 *   daily 2am    -> reconciliation sweep workflow (consistency verify +
 *                   stuck refund re-drive + run audit) + update check
 *
 * The handler dispatches based on the cron expression.
 */

import type { Env } from '../types/env';
// ScheduledController / ExecutionContext come from workers-types globals.

export class ScheduledHandler {
  async run(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    const now = new Date().toISOString();

    console.log(JSON.stringify({
      level: 'info',
      message: 'cron_triggered',
      cron,
      scheduled_time: new Date(controller.scheduledTime).toISOString(),
      timestamp: now,
    }));

    try {
      switch (cron) {
        case '*/5 * * * *':
          await this.runEvery5Minutes(env);
          break;
        case '0 * * * *':
          await this.runHourly(env);
          break;
        case '0 2 * * *':
          await this.runDaily(env);
          break;
        default:
          console.warn(`Unknown cron expression: ${cron}`);
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'cron_failed',
        cron,
        error: err instanceof Error ? err.message : String(err),
        timestamp: now,
      }));
      // Cron triggers retry once automatically if this throws
      // Do NOT call controller.noRetry() — we want retry on failure
    }
  }

  /** Every 5 minutes — expiry + SMS verification */
  private async runEvery5Minutes(env: Env): Promise<void> {
    await Promise.allSettled([
      this.expirePendingIntents(env),
      this.processPendingSmsVerifications(env),
    ]);
  }

  /** Hourly — exchange rates, domain re-verification, and the posting
   *  protocol's fast-heal pass: replay any op_ledger_postings still
   *  pending so a crashed step F converges within the hour (the daily
   *  sweep does the full consistency verification). */
  private async runHourly(env: Env): Promise<void> {
    await Promise.allSettled([
      this.updateExchangeRates(env),
      this.reverifyDomains(env),
      this.replayPendingPostings(env),
    ]);
  }

  /** Daily — trigger the reconciliation sweep workflow (idempotent per
   *  UTC day) + update check. The sweep itself is a Workflow: durable,
   * step-retried, and observable in the Workflows dashboard. */
  private async runDaily(env: Env): Promise<void> {
    await Promise.allSettled([
      this.triggerSweep(env),
      this.checkForUpdates(env),
    ]);
  }

  private async triggerSweep(env: Env): Promise<void> {
    const { triggerDailySweep } = await import('../services/reconciliation');
    const result = await triggerDailySweep(env);
    console.log(JSON.stringify({
      level: 'info',
      event: 'sweep_workflow_triggered',
      instance_id: result.instance_id,
      created: result.created,
      timestamp: new Date().toISOString(),
    }));
  }

  // ---------------------------------------------------------------
  // Individual job implementations
  // ---------------------------------------------------------------

  /**
   * Expire payment intents that have passed their expires_at timestamp
   * without being completed. Port of EdgePay's intent expiry logic.
   */
  private async expirePendingIntents(env: Env): Promise<void> {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(
      `UPDATE op_payment_intents
       SET status = 'expired', updated_at = ?
       WHERE status IN ('pending', 'processing') AND expires_at < ?`,
    ).bind(now, now).run();

    if (result.meta?.changes && result.meta.changes > 0) {
      // Also mark their transactions as expired
      await env.DB.prepare(
        `UPDATE op_transactions
         SET status = 'expired', updated_at = ?
         WHERE payment_intent_id IN (
           SELECT id FROM op_payment_intents WHERE status = 'expired' AND updated_at = ?
         )`,
      ).bind(now, now).run();
    }
  }

  /**
   * Posting-protocol fast-heal pass: replay op_ledger_postings rows
   * still 'pending' (crashed step D/F, D1 hiccups). Full verification
   * runs in the daily sweep workflow.
   */
  private async replayPendingPostings(env: Env): Promise<void> {
    const { reconcilePendingPostings } = await import('../services/reconciliation');
    const result = await reconcilePendingPostings(env, { limit: 200 });
    if (result.replayed > 0 || result.healed > 0 || result.rejected > 0) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'hourly_posting_replay',
        ...result,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  /**
   * Process pending SMS verifications — match parsed SMS to pending
   * manual-gateway transactions.
   */
  private async processPendingSmsVerifications(env: Env): Promise<void> {
    const pending = await env.DB.prepare(
      `SELECT id, merchant_id, sender, body, parsed_amount, parsed_trx_id, parsed_at
       FROM op_sms_data
       WHERE match_status = 'pending'
       ORDER BY created_at DESC
       LIMIT 50`,
    ).all();

    for (const sms of (pending.results ?? []) as Array<{ id: number; merchant_id: number; sender: string; body: string }>) {
      try {
        await env.SMS_QUEUE.send({
          merchant_id: sms.merchant_id,
          device_id: 0,
          sender: sms.sender,
          body: sms.body,
          received_at: new Date().toISOString(),
        });
      } catch {
        // Continue processing batch
      }
    }
  }

  /**
   * Update exchange rates from open ER API.
   * Port of EdgePay's CurrencyUpdateJob.
   */
  private async updateExchangeRates(env: Env): Promise<void> {
    try {
      const response = await fetch('https://open.er-api.com/v6/latest/USD');
      if (!response.ok) return;

      const data = await response.json() as { rates: Record<string, number> };
      const now = new Date().toISOString();
      const stmts = Object.entries(data.rates).map(([currency, rate]) =>
        env.DB.prepare(
          `INSERT INTO op_exchange_rates (base, target, rate, source, updated_at)
           VALUES ('USD', ?, ?, 'open.er-api.com', ?)
           ON CONFLICT(base, target) DO UPDATE SET rate = ?, source = ?, updated_at = ?`,
        ).bind(currency, String(rate), now, String(rate), 'open.er-api.com', now),
      );

      // Batch in chunks of 50 (D1 batch limit)
      for (let i = 0; i < stmts.length; i += 50) {
        await env.DB.batch(stmts.slice(i, i + 50));
      }
    } catch (err) {
      console.error('Currency update failed:', err);
    }
  }

  /**
   * Verify ledger trial balance per merchant.
   *
   * v0.2.1: trial-balance verification moved into the daily reconciliation
   * sweep workflow (services/reconciliation.ts -> verifyAllMerchants),
   * which PAGES on drift instead of logging. The hourly cron runs the
   * cheaper pending-posting replay instead.
   */

  /**
   * Re-verify DNS records for pending custom domains.
   * Port of EdgePay's DnsVerificationJob.
   */
  private async reverifyDomains(env: Env): Promise<void> {
    const pending = await env.DB.prepare(
      `SELECT id, merchant_id, domain, verification_token FROM op_domains
       WHERE status = 'pending' OR (status = 'active' AND dns_verified = 0)`,
    ).all<{ id: number; merchant_id: number; domain: string; verification_token: string }>();

    for (const d of pending.results) {
      try {
        const records = await lookupTxtRecords(`_edgepay-verification.${d.domain}`);
        const verified = records.some(r => r.includes(d.verification_token));

        if (verified) {
          await env.DB.prepare(
            `UPDATE op_domains SET dns_verified = 1, status = 'active', updated_at = ? WHERE id = ?`,
          ).bind(new Date().toISOString(), d.id).run();
          // Invalidate KV cache (both prefix variants, normalized)
          const normalized = d.domain.toLowerCase().trim();
          await Promise.all([
            env.KV.delete(`domain:${normalized}`),
            env.KV.delete(`domain-v2:${normalized}`),
          ]);
        }
      } catch (err) {
        console.error(`DNS verification failed for ${d.domain}:`, err);
      }
    }
  }

  /**
   * Refund reconciliation is workflow-driven as of v0.2.1:
   *   - RefundService.createRefund() creates the instance-per-refund
   *     workflow at refund creation (the defined trigger path)
   *   - the workflow polls the gateway in a bounded loop and posts the
   *     idempotent ledger reversal
   *   - the daily sweep re-drives refunds stuck > 24h
   * No cron-scan refund job remains.
   */

  /**
   * Check for EdgePay-CF updates.
   * Port of EdgePay's UpdateCheckJob.
   */
  private async checkForUpdates(env: Env): Promise<void> {
    try {
      const response = await fetch('https://api.github.com/repos/JonyBepary/edgepay-cf/releases/latest');
      if (!response.ok) return;

      const data = await response.json() as { tag_name: string; published_at: string };
      await env.KV.put('system:latest_version', JSON.stringify({
        version: data.tag_name,
        checked_at: new Date().toISOString(),
      }));
    } catch (err) {
      console.error('Update check failed:', err);
    }
  }

  /** Optional HTTP trigger — removed in v0.2.1 (manual invocation is
   * POST /api/admin/v1/reconcile, behind verified Cloudflare Access). */
}

async function lookupTxtRecords(record: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record)}&type=TXT`,
      { headers: { 'Accept': 'application/dns-json' } },
    );
    if (!response.ok) return [];
    const data = await response.json() as { Answer?: Array<{ data: string }> };
    return data.Answer?.map(a => a.data) ?? [];
  } catch {
    return [];
  }
}

// Singleton export
export const scheduledHandler = new ScheduledHandler();
