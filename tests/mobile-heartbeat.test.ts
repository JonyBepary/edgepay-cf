/**
 * Mobile Device Heartbeat & Tenant Scoping Discriminating Tests (EDGE-P3-002, V5-006).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { createJwtService } from '../src/lib/jwt';
import { sha256 } from '../src/lib/crypto';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

describe('Mobile Device Heartbeat & Tenant Scoping (EDGE-P3-002 / V5-006)', () => {
  const merchantA = 960001;
  const merchantB = 960002;
  const deviceId = 9601;
  let jwtTokenA: string;
  let jwtTokenB: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    for (const [mid, slug, mail] of [
      [merchantA, 'hb-merchant-a', 'hba@example.com'],
      [merchantB, 'hb-merchant-b', 'hbb@example.com'],
    ] as const) {
      await db.prepare(
        `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
         VALUES (?, ?, 'HeartbeatMerchant', ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(mid, crypto.randomUUID(), slug, mail, now, now).run();
    }

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('admin-user-hb@example.com');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (961, ?, ?, 'Admin User', 'admin-user-hb@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantA, userUuid, emailHash, now, now).run();

    // Seed sentinel value: 2000-01-01T00:00:00.000Z
    await db.prepare(
      `INSERT INTO op_paired_devices (id, merchant_id, user_id, uuid, device_name, fingerprint, status, last_heartbeat_at, created_at)
       VALUES (?, ?, 961, ?, 'TestPhone', 'fp-9601', 'active', '2000-01-01T00:00:00.000Z', ?)
       ON CONFLICT(id) DO UPDATE SET last_heartbeat_at = '2000-01-01T00:00:00.000Z'`
    ).bind(deviceId, merchantA, crypto.randomUUID(), now).run();

    const jwtService = createJwtService(tenv);
    jwtTokenA = await jwtService.issueAccessToken({
      sub: '961',
      merchant_id: merchantA,
      device_id: deviceId,
      scope: ['read', 'write'],
    });

    jwtTokenB = await jwtService.issueAccessToken({
      sub: '962',
      merchant_id: merchantB,
      device_id: deviceId,
      scope: ['read', 'write'],
    });
  });

  it('same-tenant token CHANGES last_heartbeat_at from sentinel value', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtTokenA}`,
        'Content-Type': 'application/json',
        'Content-Length': '2',
      },
      body: '{}',
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean }>();
    expect(json.success).toBe(true);

    const deviceRow = await db.prepare(
      `SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ? AND merchant_id = ?`
    ).bind(deviceId, merchantA).first<{ last_heartbeat_at: string }>();

    expect(deviceRow?.last_heartbeat_at).toBeDefined();
    expect(deviceRow?.last_heartbeat_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('cross-tenant token (merchant B, foreign device id) leaves merchant A row UNCHANGED', async () => {
    const before = await db.prepare(
      `SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ? AND merchant_id = ?`
    ).bind(deviceId, merchantA).first<{ last_heartbeat_at: string }>();

    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtTokenB}`,
        'Content-Type': 'application/json',
        'Content-Length': '2',
      },
      body: '{}',
    });

    expect(res.status).toBe(200);

    const after = await db.prepare(
      `SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ? AND merchant_id = ?`
    ).bind(deviceId, merchantA).first<{ last_heartbeat_at: string }>();

    expect(after?.last_heartbeat_at).toBe(before?.last_heartbeat_at);
  });
});
