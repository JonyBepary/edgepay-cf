/**
 * Webhook SSRF validation regression tests (V3-002, V3-007, EDGE-P1-004).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256 } from '../src/lib/crypto';
import { WebhookDispatcher } from '../src/services/webhook-dispatcher';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

describe('Webhook SSRF & sendTest Validation (V3-002 / V3-007)', () => {
  const merchantId = 950001;
  let apiKey: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'SSRFTestMerchant', 'ssrf-test', 'ssrf@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const prefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const rest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    apiKey = `op_live_${prefix}_${rest}`;
    const hash = await sha256(apiKey);

    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
       VALUES (?, 'test-key', ?, ?, '["read","write","admin","*"]', 'active', ?)`
    ).bind(merchantId, prefix, hash, now).run();
  });

  it('rejects internal / localhost URL with 400 on POST /api/v1/webhooks/tests', async () => {
    const blockedUrls = [
      'http://127.0.0.1:8080/hook',
      'http://localhost/webhook',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/admin',
      'http://192.168.1.1/webhook',
    ];

    for (const url of blockedUrls) {
      const res = await SELF.fetch('http://localhost/api/v1/webhooks/tests', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(JSON.stringify({ url }))),
        },
        body: JSON.stringify({ url }),
      });

      expect(res.status).toBe(400);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('INVALID_URL');
    }
  });

  it('WebhookDispatcher.sendTest rejects blocked URLs before inserting into DB', async () => {
    const dispatcher = new WebhookDispatcher(tenv);
    const badUrl = 'http://127.0.0.1:9000/internal-test';

    const result = await dispatcher.sendTest(merchantId, badUrl);
    expect(result.success).toBe(false);
    expect(result.error).toContain('SSRF protection');

    // Confirm no row was persisted in op_webhooks
    const row = await db.prepare(
      `SELECT id FROM op_webhooks WHERE merchant_id = ? AND url = ?`
    ).bind(merchantId, badUrl).first();
    expect(row).toBeNull();
  });
});
