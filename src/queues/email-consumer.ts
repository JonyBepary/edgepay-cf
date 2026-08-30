/**
 * Email queue consumer — processes outbound emails.
 *
 * EdgePay's PHP original uses SMTP via vlucas/phpmailer. On Workers we
 * have two options:
 *   1. Send via a third-party API (SendGrid, Mailgun, Postmark, Resend)
 *   2. Send via Cloudflare Email Workers (limited; not for transactional)
 *
 * Recommended: Resend (resend.com) — simple HTTP API, free tier 3000/mo.
 *
 * Set the RESEND_API_KEY secret via wrangler secret put to enable.
 */

import type { Env, EmailMessage } from '../types/env';

export class EmailQueueConsumer {
  async process(
    batch: { messages: Message<EmailMessage>[] },
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // If no API key configured, log + ack (skip sending)
    const apiKey = await env.KV.get('resend:api_key');
    if (!apiKey) {
      console.warn('Email sending skipped — no Resend API key configured');
      for (const msg of batch.messages) await msg.ack();
      return;
    }

    await Promise.allSettled(
      batch.messages.map(msg => this.processOne(msg, env, ctx, apiKey)),
    );
  }

  private async processOne(
    msg: Message<EmailMessage>,
    env: Env,
    _ctx: ExecutionContext,
    apiKey: string,
  ): Promise<void> {
    const email = msg.body;

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: env.SMTP_FROM ?? 'EdgePay <noreply@edgepay.org>',
          to: [email.to],
          subject: email.subject,
          html: email.html_body,
          text: email.text_body,
        }),
      });

      if (response.ok) {
        await msg.ack();
      } else if (response.status >= 400 && response.status < 500) {
        // Permanent failure
        await msg.ack();
      } else {
        // Retry
        await msg.retry({ delaySeconds: 60 });
      }
    } catch {
      await msg.retry({ delaySeconds: 60 });
    }
  }
}

export const emailQueueHandler = new EmailQueueConsumer();
