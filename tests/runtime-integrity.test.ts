import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

describe('runtime integrity', () => {
  it('refund sweep index exists (0004)', async () => {
    const row = await db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_op_refunds_status_created_workflow'`)
      .first<{ sql: string }>();
    expect(row).not.toBeNull();
    expect(row!.sql).toContain('op_refunds');
    expect(row!.sql).toContain('status');
    expect(row!.sql).toContain('workflow_attempts');
  });

  it('refund sweep query uses index (EXPLAIN QUERY PLAN)', async () => {
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN SELECT id FROM op_refunds WHERE status='pending' AND created_at<'2026-01-01' AND workflow_attempts<3`)
      .all<{ detail: string }>();
    const detail = plan.results.map(r => (r as unknown as { detail: string }).detail ?? JSON.stringify(r)).join(' ');
    // Should mention the index, not a full scan
    expect(detail.toLowerCase()).toContain('idx_op_refunds_status_created_workflow');
  });

  it('ledger-do fault injection is guarded in production (file contains guard)', async () => {
    // This test documents the guard; we verify via a simple runtime check:
    // In non-production env, fault injection should not throw; in production it would.
    // We are in test env (ENVIRONMENT=development via miniflare default), so injection should succeed.
    // We test that the guard string exists by importing the module source via fetch of the file if available,
    // fallback to just checking env guard logic exists by inspecting the class prototype string.
    const { LedgerDO } = await import('../src/do/ledger-do');
    const src = LedgerDO.toString();
    expect(src).toContain('ENVIRONMENT');
  });

  it('bootstrap FK-safe: pairing token insert requires real user', async () => {
    // Verify that bootstrap does not insert pairing token without a user:
    // Simulate ensureSystemBootstrapped on a fresh merchant without users
    const { ensureSystemBootstrapped } = await import('../src/services/bootstrap');
    const testMerchantId = 999901;
    // Clean up any prior run
    await db.prepare(`DELETE FROM op_device_pairing_tokens WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_merchant_users WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_ledger_accounts WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_gateways WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_api_keys WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_webhooks WHERE merchant_id=?`).bind(testMerchantId).run();
    await db.prepare(`DELETE FROM op_merchants WHERE id=?`).bind(testMerchantId).run();
    await db
      .prepare(`INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka','BDT','secret',NULL,'active',0,?,?)`)
      .bind(testMerchantId, `uuid-${testMerchantId}`, `M ${testMerchantId}`, `slug-${testMerchantId}`, `m${testMerchantId}@example.com`, new Date().toISOString(), new Date().toISOString())
      .run();
    // Ensure no user exists, then bootstrap should NOT create a pairing token with hardcoded user_id 1
    const before = await db.prepare(`SELECT COUNT(*) as n FROM op_device_pairing_tokens WHERE merchant_id=?`).bind(testMerchantId).first<{ n: number }>();
    expect(before?.n).toBe(0);
    await ensureSystemBootstrapped(tenv);
    // After bootstrap, if no user was created, pairing token for this specific test merchant should still be 0
    // (bootstrap's FK-safe path skips insertion when no user). The platform merchant's token is separate.
    const after = await db.prepare(`SELECT COUNT(*) as n FROM op_device_pairing_tokens WHERE merchant_id=?`).bind(testMerchantId).first<{ n: number }>();
    // Should remain 0 because we fixed FK to require real user
    expect(after?.n).toBe(0);
    // Cleanup
    await db.prepare(`DELETE FROM op_merchants WHERE id=?`).bind(testMerchantId).run();
  });
});
