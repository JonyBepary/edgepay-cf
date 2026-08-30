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
      // SSRF protection — block private + loopback IPs
      if (!isAllowedWebhookUrl(webhook.url)) {
        await this.logDelivery(env, webhook, 0, 0, false, 'blocked_ssrf');
        await msg.ack();
        return;
      }

      const jsonPayload = JSON.stringify(webhook.payload);
      const signature = await hmacSha256(jsonPayload, webhook.secret);
      const timestamp = Math.floor(Date.now() / 1000);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-EdgePay-Signature': signature,
          'X-EdgePay-Timestamp': String(timestamp),
          'User-Agent': 'EdgePay-Webhook/1.0-cf',
        },
        body: jsonPayload,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const elapsedMs = Date.now() - startTime;
      const success = response.status >= 200 && response.status < 300;

      await this.logDelivery(env, webhook, response.status, elapsedMs, success, undefined);

      if (success) {
        await msg.ack();
      } else {
        // Retry on 4xx (except 410 Gone) and 5xx
        if (response.status === 410 || response.status === 422) {
          // Permanent failure — don't retry
          await msg.ack();
        } else {
          // Exponential backoff: 60s, 300s, 1800s
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
         (merchant_id, event, url, direction, status_code, response_time_ms, attempt, status, payload_hash, gateway, created_at)
       VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, '', ?, ?)`
).bind(webhook.merchant_id,
        webhook.event,
        webhook.url,
        statusCode,
        elapsedMs,
        webhook.attempt,
        success ? 'delivered' : 'failed',
        'system',
        new Date().toISOString(),).run();
  }
}

/**
 * SSRF protection — block private and loopback URLs.
 * Port of EdgePay's UrlValidator::isValidWebhookUrl.
 */
export function isAllowedWebhookUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // Only HTTPS allowed (HTTP allowed only on localhost for dev)
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    return false;
  }

  // Block common private ranges
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.16.') ||
    hostname.startsWith('172.17.') ||
    hostname.startsWith('172.18.') ||
    hostname.startsWith('172.19.') ||
    hostname.startsWith('172.20.') ||
    hostname.startsWith('172.21.') ||
    hostname.startsWith('172.22.') ||
    hostname.startsWith('172.23.') ||
    hostname.startsWith('172.24.') ||
    hostname.startsWith('172.25.') ||
    hostname.startsWith('172.26.') ||
    hostname.startsWith('172.27.') ||
    hostname.startsWith('172.28.') ||
    hostname.startsWith('172.29.') ||
    hostname.startsWith('172.30.') ||
    hostname.startsWith('172.31.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('169.254.') ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    return false;
  }

  return true;
}

export const webhookQueueHandler = new WebhookQueueConsumer();
