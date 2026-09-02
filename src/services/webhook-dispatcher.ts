/**
 * Webhook dispatcher service — port of EdgePay's PHP WebhookDispatcher.
 *
 * EdgePay's PHP original makes outbound HTTP POSTs synchronously inside
 * the request lifecycle (3 retries with 1m/5m/30m backoff). That's
 * incompatible with Workers' 30s CPU limit — we MUST push deliveries
 * to a Queue.
 *
 * Strategy:
 *   1. dispatch() enqueues a WebhookMessage to WEBHOOK_QUEUE
 *   2. Queue consumer (queues/webhook-consumer.ts) makes the HTTP POST
 *   3. If the POST fails, queue retries with exponential backoff
 *      (Cloudflare Queues support max_retries + dead-letter queue)
 *
 * Payload signing: HMAC-SHA256 of JSON body with merchant's webhook_secret.
 */

import type { Env, WebhookMessage } from '../types/env';
import { hmacSha256 } from '../lib/crypto';

export interface DispatchPayload {
  merchant_id: number;
  event: string;
  data: Record<string, unknown>;
}

export class WebhookDispatcher {
  constructor(private readonly env: Env) {}

  /**
   * Enqueue outbound webhook deliveries to all active webhook endpoints
   * subscribed to the given event.
   */
  async dispatch(input: DispatchPayload): Promise<void> {
    const webhooks = await this.env.DB.prepare(

      `SELECT id, url, secret, events FROM op_webhooks
       WHERE merchant_id = ? AND status = 'active'`
).bind(input.merchant_id).all<{ id: number; url: string; secret: string; events: string }>();

    if (webhooks.results.length === 0) return;

    const payload = this.buildPayload(input.event, input.data);

    // Filter subscribed webhooks
    const subscribedWebhooks = webhooks.results.filter(w => {
      const subscribedEvents = JSON.parse(w.events || '[]') as string[];
      return subscribedEvents.length === 0 ||
             subscribedEvents.includes('*') ||
             subscribedEvents.includes(input.event);
    });

    // Build messages and send in batch
    const messages: WebhookMessage[] = subscribedWebhooks.map(w => ({
      webhook_id: w.id,
      merchant_id: input.merchant_id,
      url: w.url,
      secret: w.secret,
      event: input.event,
      payload,
      attempt: 1,
    }));

    if (messages.length > 0) {
      // Queue.sendBatch takes MessageSendRequest envelopes ({ body }), not bare bodies
      await this.env.WEBHOOK_QUEUE.sendBatch(messages.map(body => ({ body })));
    }
  }

  /**
   * Build the standardized outbound webhook payload.
   */
  buildPayload(event: string, data: Record<string, unknown>): Record<string, unknown> {
    return {
      event,
      transaction_id: data.transaction_id ?? '',
      gateway_trx_id: data.gateway_trx_id ?? '',
      amount: data.amount ?? '0.00',
      currency: data.currency ?? 'BDT',
      fee: data.fee ?? '0.00',
      gateway: data.gateway ?? '',
      gateway_type: data.gateway_type ?? 'unknown',
      status: data.status ?? '',
      customer: {
        name: data.customer_name ?? '',
        email: data.customer_email ?? '',
        phone: data.customer_phone ?? '',
      },
      metadata: data.metadata ?? {},
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Sign an outbound payload — used by the queue consumer.
   */
  async signPayload(payloadJson: string, secret: string): Promise<string> {
    return hmacSha256(payloadJson, secret);
  }

  /**
   * Send a test webhook to the merchant's first active endpoint.
   * Useful for the developer hub UI.
   */
  async sendTest(merchantId: number, targetUrl?: string): Promise<{ success: boolean; error?: string }> {
    let webhook = await this.env.DB.prepare(
      `SELECT id, url, secret FROM op_webhooks
       WHERE merchant_id = ? AND status = 'active'
       ORDER BY created_at ASC LIMIT 1`
    ).bind(merchantId).first<{ id: number; url: string; secret: string }>();

    if (!webhook) {
      const urlToUse = targetUrl || this.env.DEFAULT_WEBHOOK_URL;
      if (!urlToUse) {
        return { success: false, error: 'No webhook endpoint registered for merchant' };
      }

      const { isAllowedWebhookUrl } = await import('../lib/url-guard');
      if (!isAllowedWebhookUrl(urlToUse, this.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
        return { success: false, error: 'Target webhook URL is blocked by SSRF protection' };
      }

      const secret = `whsec_${crypto.randomUUID().replace(/-/g, '')}`;
      const now = new Date().toISOString();
      const ins = await this.env.DB.prepare(
        `INSERT INTO op_webhooks (merchant_id, url, secret, events, status, created_at, updated_at)
         VALUES (?, ?, ?, '["*"]', 'active', ?, ?)`
      ).bind(merchantId, urlToUse, secret, now, now).run();
      webhook = {
        id: Number(ins.meta?.last_row_id ?? 1),
        url: urlToUse,
        secret,
      };
    }

    const testPayload = this.buildPayload('webhook.test', {
      transaction_id: `TEST-${crypto.randomUUID().slice(0, 8)}`,
      amount: '0.00',
      currency: 'BDT',
      gateway: 'test',
      gateway_type: 'test',
      status: 'test',
    });

    const message: WebhookMessage = {
      webhook_id: webhook.id,
      merchant_id: merchantId,
      url: webhook.url,
      secret: webhook.secret,
      event: 'webhook.test',
      payload: testPayload,
      attempt: 1,
    };

    await this.env.WEBHOOK_QUEUE.send(message);
    return { success: true };
  }
}
