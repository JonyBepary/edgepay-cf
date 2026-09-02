import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { createJwtService } from '../src/lib/jwt';
import type { Env } from '../src/types/env';

describe('Mobile Notification Tenant & Device Isolation (EDGE-P3-003 / V3-001)', () => {
  let merchantAId: number;
  let merchantBId: number;
  let deviceAId: number;
  let deviceBId: number;
  let jwtA: string;
  let jwtB: string;
  let notificationIdA: number;

  beforeAll(async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const now = new Date().toISOString();

    // 1. Create Merchant A & Admin User & Paired Device
    const uuidA = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO op_merchants (uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, 'Merchant A', 'merchant-a', 'a@example.com', 'Asia/Dhaka', 'BDT', ?, 'active', 0, ?, ?)`
    ).bind(uuidA, crypto.randomUUID(), now, now).run();
    const rowA = await db.prepare(`SELECT id FROM op_merchants WHERE uuid = ?`).bind(uuidA).first<{ id: number }>();
    merchantAId = rowA!.id;

    const userInsA = await db.prepare(
      `INSERT INTO op_merchant_users (merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, 'User A', 'a@example.com', 'hash_a', 'pass_a', 'active', ?, ?)`
    ).bind(merchantAId, crypto.randomUUID(), now, now).run();
    const userAId = Number(userInsA.meta?.last_row_id ?? 1);

    const devInsA = await db.prepare(
      `INSERT INTO op_paired_devices (merchant_id, user_id, uuid, device_name, status, created_at)
       VALUES (?, ?, ?, 'Device A', 'active', ?)`
    ).bind(merchantAId, userAId, crypto.randomUUID(), now).run();
    deviceAId = Number(devInsA.meta?.last_row_id ?? 1);

    // 2. Create Merchant B & Admin User & Paired Device
    const uuidB = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO op_merchants (uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, 'Merchant B', 'merchant-b', 'b@example.com', 'Asia/Dhaka', 'BDT', ?, 'active', 0, ?, ?)`
    ).bind(uuidB, crypto.randomUUID(), now, now).run();
    const rowB = await db.prepare(`SELECT id FROM op_merchants WHERE uuid = ?`).bind(uuidB).first<{ id: number }>();
    merchantBId = rowB!.id;

    const userInsB = await db.prepare(
      `INSERT INTO op_merchant_users (merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, 'User B', 'b@example.com', 'hash_b', 'pass_b', 'active', ?, ?)`
    ).bind(merchantBId, crypto.randomUUID(), now, now).run();
    const userBId = Number(userInsB.meta?.last_row_id ?? 2);

    const devInsB = await db.prepare(
      `INSERT INTO op_paired_devices (merchant_id, user_id, uuid, device_name, status, created_at)
       VALUES (?, ?, ?, 'Device B', 'active', ?)`
    ).bind(merchantBId, userBId, crypto.randomUUID(), now).run();
    deviceBId = Number(devInsB.meta?.last_row_id ?? 2);

    // 3. Create Notification for Merchant A (bound to deviceAId)
    const notifIns = await db.prepare(
      `INSERT INTO op_mobile_notifications (merchant_id, device_id, event, payload, read_at, created_at)
       VALUES (?, ?, 'payment.created', '{"amount":"100.00"}', NULL, ?)`
    ).bind(merchantAId, deviceAId, now).run();
    notificationIdA = Number(notifIns.meta?.last_row_id ?? 1);

    // 4. Generate JWT tokens
    const jwtService = createJwtService(env as unknown as Env);
    jwtA = await jwtService.issueAccessToken({
      sub: String(userAId),
      merchant_id: merchantAId,
      device_id: deviceAId,
      scope: ['read', 'write'],
    });
    jwtB = await jwtService.issueAccessToken({
      sub: String(userBId),
      merchant_id: merchantBId,
      device_id: deviceBId,
      scope: ['read', 'write'],
    });
  });

  it('prevents Merchant B from acknowledging Merchant A notification', async () => {
    const res = await SELF.fetch('https://edgepay-cf.bm-jonybepary.workers.dev/api/mobile/v1/notifications/acknowledgements', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtB}`,
      },
      body: JSON.stringify({ notification_ids: [notificationIdA] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { acknowledged: number } }>();
    expect(json.success).toBe(true);
    // Merchant B has 0 affected rows
    expect(json.data.acknowledged).toBe(0);

    // Verify in DB that notification A is still unread
    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db.prepare(
      `SELECT read_at FROM op_mobile_notifications WHERE id = ?`
    ).bind(notificationIdA).first<{ read_at: string | null }>();
    expect(row?.read_at).toBeNull();
  });

  it('allows Merchant A to acknowledge their own notification', async () => {
    const res = await SELF.fetch('https://edgepay-cf.bm-jonybepary.workers.dev/api/mobile/v1/notifications/acknowledgements', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtA}`,
      },
      body: JSON.stringify({ notification_ids: [notificationIdA] }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { acknowledged: number } }>();
    expect(json.success).toBe(true);
    expect(json.data.acknowledged).toBe(1);

    // Verify in DB that notification A is now read
    const db = (env as unknown as { DB: D1Database }).DB;
    const row = await db.prepare(
      `SELECT read_at FROM op_mobile_notifications WHERE id = ?`
    ).bind(notificationIdA).first<{ read_at: string | null }>();
    expect(row?.read_at).not.toBeNull();
  });
});
