/**
 * Dead-Letter Queue (DLQ) Consumer — observability & poison pill alerting.
 *
 * Cloudflare Queues routes messages that exceed max_retries to the
 * configured dead_letter_queue (wrangler.jsonc: webhook-out-dlq,
 * email-out-dlq, sms-parse-dlq).
 *
 * Rather than letting failed messages silently die, this consumer:
 *   1. Emits a PAGE-severity alert to notify on-call (Logpush / Workers Logs / PagerDuty).
 *   2. Emits an Analytics Engine metric for DLQ rate monitoring.
 *   3. Logs structured diagnostic details with message IDs and payload samples.
 *   4. Acknowledges the dead letters to prevent infinite delivery loops.
 */

import type { Env } from '../types/env';
import { page, metric } from '../lib/observability';

export class DlqConsumer {
  async process(
    batch: MessageBatch<unknown>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const queueName = batch.queue ?? 'unknown-dlq';
    const messageCount = batch.messages.length;

    // 1. Emit PAGE alert for on-call alerting
    page(env, 'DLQ_POISON_PILL', {
      queue: queueName,
      message_count: messageCount,
      sample_ids: batch.messages.slice(0, 5).map((m) => m.id),
      timestamp: new Date().toISOString(),
    });

    // 2. Emit metric to Analytics Engine
    metric(env, 'dlq_message_received', {
      gateway: queueName,
      value: messageCount,
    });

    // 3. Structured log with diagnostic payload
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'DLQ_MESSAGES_RECEIVED',
        queue: queueName,
        count: messageCount,
        messages: batch.messages.map((m) => ({
          id: m.id,
          timestamp: m.timestamp,
          attempts: m.attempts,
          body_preview:
            typeof m.body === 'object'
              ? JSON.stringify(m.body).slice(0, 500)
              : String(m.body).slice(0, 500),
        })),
        timestamp: new Date().toISOString(),
      }),
    );

    // 4. Acknowledge messages in DLQ to terminate pipeline
    await Promise.all(batch.messages.map((m) => m.ack()));
  }
}

export const dlqConsumer = new DlqConsumer();
