/**
 * Outbound webhook queue consumer.
 *
 * Pulls WebhookMessage batches from the WEBHOOK_QUEUE and POSTs each to
 * the merchant's endpoint with HMAC-SHA256 signature. Failed deliveries
 * are retried by the queue (max_retries=3 with exponential backoff).
 * Permanently-failed messages go to the DLQ for admin inspection.
 */

import type { Env, WebhookMessage } from '../types/env';
import { hmacSha256 } from '../lib/crypto';
import { isAllowedWebhookUrl } from '../lib/url-guard';

const HTTP_TIMEOUT_MS = 15000;

export class WebhookQueueConsumer {
  async process(
    batch: { messages: Message<WebhookMessage>[] },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    await Promise.allSettled(
      batch.messages.map(msg => this.processOne(msg, env, ctx)),
    );
  }

  private async processOne(
    msg: Message<WebhookMessage>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const { body: webhook } = msg;
    const startTime = Date.now();

    try {
      // SSRF protection — block private + loopback + encoded IPs (EDGE-P1-004 / V3-007 fix)
      if (!isAllowedWebhookUrl(webhook.url, env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
        await this.logDelivery(env, webhook, 0, 0, false, 'blocked_ssrf');
        await msg.ack();
        return;
      }

      const jsonPayload = JSON.stringify(webhook.payload);
      const signature = await hmacSha256(jsonPayload, webhook.secret);
      const timestamp = Math.floor(Date.now() / 1000);
      const deliveryId = `whdel_${crypto.randomUUID()}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EdgePay-Signature': signature,
          'X-EdgePay-Timestamp': String(timestamp),
          'X-EdgePay-Delivery-ID': deliveryId,
          'X-EdgePay-Event': webhook.event,
          'User-Agent': 'EdgePay-Webhook/1.0-cf',
        },
        body: jsonPayload,
        redirect: 'error',
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const elapsedMs = Date.now() - startTime;
      const success = response.status >= 200 && response.status < 300;

      await this.logDelivery(env, webhook, response.status, elapsedMs, success, undefined);

      if (success) {
        await msg.ack();
      } else {
        // Client errors (4xx) are permanent client configuration failures — do not waste retry queue
        if (response.status >= 400 && response.status < 500) {
          await msg.ack();
        } else {
          // 5xx Server errors — Exponential backoff: 60s, 300s, 1800s
          const delay = [60, 300, 1800][Math.min(webhook.attempt - 1, 2)];
          await msg.retry({ delaySeconds: delay });
        }
      }
    } catch (err) {
      const elapsedMs = Date.now() - startTime;
      await this.logDelivery(env, webhook, 0, elapsedMs, false, err instanceof Error ? err.message : String(err));
      // Network error — retry
      const delay = [60, 300, 1800][Math.min(webhook.attempt - 1, 2)];
      await msg.retry({ delaySeconds: delay });
    }
  }

  private async logDelivery(
    env: Env,
    webhook: WebhookMessage,
    statusCode: number,
    elapsedMs: number,
    success: boolean,
    _error: string | undefined,
  ): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO op_webhook_deliveries
         (merchant_id, webhook_id, event, url, status_code, response_time_ms, success, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      webhook.merchant_id,
      webhook.webhook_id,
      webhook.event,
      webhook.url,
      statusCode,
      elapsedMs,
      success ? 1 : 0,
      new Date().toISOString(),
    ).run();
  }
}

export const webhookQueueHandler = new WebhookQueueConsumer();
