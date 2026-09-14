/**
 * Test Suite: Phase 5a — Device-Level Policy Overrides.
 *
 * Merchant range: 900001 - 909999 (TEST_MERCHANT_RANGES.DEVICE_POLICY_OVERRIDES).
 *
 * Verifies:
 *   1. Override grants, appears in GET, and bypasses enforce-mode SMS block.
 *   2. Expired override does not bypass.
 *   3. Revoked override does not bypass.
 *   4. Override does not bypass keyless signature requirement (SIGNATURE_REQUIRED='true').
 *   5. Reason length validation (length >= 10, <= 500).
 *   6. Expiry value validation (must be 30, 60, or 90).
 *   7. Quota enforced at 20 active overrides (429 OVERRIDE_QUOTA_EXCEEDED).
 *   8. Duplicate active override rejected (409 OVERRIDE_ALREADY_ACTIVE).
 *   9. Non-admin role rejected (403 FORBIDDEN).
 *  10. Admin API override grant (POST /api/admin/v1/merchants/:id/devices/:deviceId/policy-override).
 *  11. GET returns null when no override exists.
 *  12. Device not found returns 404 (non-existent device and foreign merchant device).
 */

import { describe, it, expect, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256 } from '../src/lib/crypto';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.DEVICE_POLICY_OVERRIDES;

/** Helper to seed merchant, admin user, admin API key, and read API key */
async function setupTestMerchant(mId: number, name = 'Override Merchant') {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(mId, crypto.randomUUID(), name, `slug-${mId}`, `m${mId}@test.local`, now, now).run();

  await db.prepare(
    `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, created_at, updated_at)
     VALUES (?, ?, 'Main', 'main', 'active', ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(mId, crypto.randomUUID(), now, now).run();
  const brand = await db.prepare(
    `SELECT id FROM op_brands WHERE merchant_id = ? AND slug = 'main'`
  ).bind(mId).first<{ id: number }>();
  if (brand) {
    await db.prepare(
      `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, default_currency, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Main', 'main', 'BDT', 'active', ?, ?)
       ON CONFLICT DO NOTHING`
    ).bind(brand.id, mId, crypto.randomUUID(), now, now).run();
  }

  const userId = mId + 50;
  const emailHash = await sha256(`user-${userId}@test.local`);
  await db.prepare(
    `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Test User', ?, ?, 'hash', 'active', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(userId, mId, crypto.randomUUID(), `user-${userId}@test.local`, emailHash, now, now).run();

  // Admin API key
  const adminPrefix = `a${String(mId).padStart(11, '0')}`.slice(0, 12);
  const adminRest = `k${String(mId).padStart(31, '0')}`.slice(0, 32);
  const adminApiKey = `op_live_${adminPrefix}_${adminRest}`;
  const adminKeyHash = await sha256(adminApiKey);
  await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(adminPrefix).run();
  await db.prepare(
    `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
     VALUES (?, 'admin-key', ?, ?, ?, 'active', ?, ?)`
  ).bind(mId, adminPrefix, adminKeyHash, JSON.stringify(['read', 'write', 'admin']), userId, now).run();

  // Read-only API key
  const readPrefix = `r${String(mId).padStart(11, '0')}`.slice(0, 12);
  const readRest = `k${String(mId).padStart(31, '0')}`.slice(0, 32);
  const readApiKey = `op_live_${readPrefix}_${readRest}`;
  const readKeyHash = await sha256(readApiKey);
  await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(readPrefix).run();
  await db.prepare(
    `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
     VALUES (?, 'read-key', ?, ?, ?, 'active', ?, ?)`
  ).bind(mId, readPrefix, readKeyHash, JSON.stringify(['read']), userId, now).run();

  return { merchantId: mId, userId, adminApiKey, readApiKey };
}

/** Helper to pair a keyless device and return integer deviceId and JWT token */
async function pairKeylessDevice(merchantId: number, userId: number, deviceName = 'Keyless Device') {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = await sha256(otp);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 600_000).toISOString();

  await db.prepare(
    `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(merchantId, userId, `tok_${otp}`, otpHash, expiresAt, now).run();

  const ipLastByte = ((merchantId * 7) % 240) + 1;
  const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${ipLastByte}` },
    body: JSON.stringify({
      otp,
      device_name: deviceName,
    }),
  });

  expect(res.status).toBe(201);
  const json = await res.json<{ data: { device_id: string; token: string } }>();
  const deviceUuid = json.data.device_id;

  const deviceRow = await db.prepare(
    `SELECT id FROM op_paired_devices WHERE uuid = ? LIMIT 1`
  ).bind(deviceUuid).first<{ id: number }>();

  if (!deviceRow?.id) {
    throw new Error(`Failed to resolve device integer ID for uuid: ${deviceUuid}`);
  }

  return { deviceId: deviceRow.id, token: json.data.token };
}

describe('Phase 5a — Device-Level Policy Overrides', () => {
  it('1. Override grants, appears in GET, and bypasses enforce-mode SMS block', async () => {
    const mId = range.start + 10;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Grant & Bypass Merchant');

    // Pair keyless device first while policy is in default audit mode
    const { deviceId, token: keylessToken } = await pairKeylessDevice(mId, userId, 'Test 1 Keyless');

    // Merchant policy: min_tier='attested', enforcement_mode='enforce'
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
       VALUES (?, 'attested', 'enforce', datetime('now'))
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', enforcement_mode = 'enforce'`
    ).bind(mId).run();

    // POST /sms initially rejected with 422 DEVICE_TIER_INSUFFICIENT
    const initialSms = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keylessToken}` },
      body: JSON.stringify({ sender: 'bKash', body: 'Tk 500 received. TrxID TRX900001' }),
    });
    expect(initialSms.status).toBe(422);
    const initialJson = await initialSms.json<{ error: { code: string } }>();
    expect(initialJson.error.code).toBe('DEVICE_TIER_INSUFFICIENT');

    // Grant override
    const grantRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({
        reason: 'Legacy phone at counter 1, physically controlled',
        expires_in_days: 30,
      }),
    });
    expect(grantRes.status).toBe(201);
    const grantJson = await grantRes.json<{
      data: {
        id: number;
        merchant_id: number;
        device_id: number;
        authorized_by: number;
        reason: string;
        acknowledged_tier: string;
        required_tier: string;
        expires_at: string;
      };
    }>();
    expect(grantJson.data.id).toBeGreaterThan(0);
    expect(grantJson.data.device_id).toBe(deviceId);
    expect(grantJson.data.merchant_id).toBe(mId);
    expect(grantJson.data.authorized_by).toBe(userId);
    expect(grantJson.data.acknowledged_tier).toBe('keyless');
    expect(grantJson.data.required_tier).toBe('attested');

    // GET /api/v1/devices/:id/policy-override returns the active override
    const getRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json<{ data: { id: number; reason: string } }>();
    expect(getJson.data.id).toBe(grantJson.data.id);

    // Spy on Analytics Engine for device_policy_override_used
    const spy = vi.spyOn(tenv.ANALYTICS as unknown as { writeDataPoint: (...args: unknown[]) => void }, 'writeDataPoint');
    try {
      // POST /sms now succeeds with 200
      const allowedSms = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keylessToken}` },
        body: JSON.stringify({ sender: 'bKash', body: 'Tk 500 received. TrxID TRX900002' }),
      });
      expect(allowedSms.status).toBe(200);

      // Verify daily stats has compliant = 0 (override does not alter facts)
      const today = new Date().toISOString().slice(0, 10);
      const statRow = await db.prepare(
        `SELECT compliant, evaluation_count FROM op_device_policy_daily_stats
         WHERE merchant_id = ? AND day = ? AND context = 'sms' AND achieved_tier = 'keyless'`
      ).bind(mId, today).first<{ compliant: number; evaluation_count: number }>();
      expect(statRow).toBeDefined();
      expect(statRow!.compliant).toBe(0);

      // Verify device_policy_override_used was emitted
      expect(spy).toHaveBeenCalled();
      const overrideUsedCall = spy.mock.calls.find((call) => {
        const arg = call[0] as { blobs?: string[] };
        return arg?.blobs?.includes('device_policy_override_used');
      });
      expect(overrideUsedCall).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('2. Expired override does not bypass', async () => {
    const mId = range.start + 20;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Expired Override Merchant');

    const { deviceId, token } = await pairKeylessDevice(mId, userId, 'Test 2 Keyless');

    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
       VALUES (?, 'attested', 'enforce', datetime('now'))
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', enforcement_mode = 'enforce'`
    ).bind(mId).run();

    // Grant override
    const grantRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Temporary override for hardware repair', expires_in_days: 30 }),
    });
    expect(grantRes.status).toBe(201);

    // Manually expire the override
    await db.prepare(
      `UPDATE op_device_policy_overrides SET expires_at = datetime('now', '-1 day') WHERE merchant_id = ? AND device_id = ?`
    ).bind(mId, deviceId).run();

    // SMS must now be rejected with 422
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sender: 'bKash', body: 'Tk 500 received. TrxID TRX900021' }),
    });
    expect(res.status).toBe(422);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
  });

  it('3. Revoked override does not bypass', async () => {
    const mId = range.start + 30;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Revoked Override Merchant');

    const { deviceId, token } = await pairKeylessDevice(mId, userId, 'Test 3 Keyless');

    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
       VALUES (?, 'attested', 'enforce', datetime('now'))
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', enforcement_mode = 'enforce'`
    ).bind(mId).run();

    // Grant override
    const grantRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Will be revoked shortly in test suite', expires_in_days: 30 }),
    });
    expect(grantRes.status).toBe(201);
    const grantJson = await grantRes.json<{ data: { id: number } }>();

    // Revoke override
    const revokeRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Device lost or replaced' }),
    });
    expect(revokeRes.status).toBe(200);
    const revokeJson = await revokeRes.json<{ data: { revoked_at: string; revocation_reason: string } }>();
    expect(revokeJson.data.revoked_at).toBeTruthy();
    expect(revokeJson.data.revocation_reason).toBe('Device lost or replaced');

    // Assert row in D1 is preserved (not deleted)
    const row = await db.prepare(
      `SELECT id, revoked_at, revocation_reason FROM op_device_policy_overrides WHERE id = ?`
    ).bind(grantJson.data.id).first<{ id: number; revoked_at: string | null; revocation_reason: string | null }>();
    expect(row).toBeDefined();
    expect(row!.revoked_at).not.toBeNull();
    expect(row!.revocation_reason).toBe('Device lost or replaced');

    // SMS must now be rejected with 422
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sender: 'bKash', body: 'Tk 500 received. TrxID TRX900031' }),
    });
    expect(res.status).toBe(422);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
  });

  it('4. Override does not bypass keyless signature requirement', async () => {
    const mId = range.start + 40;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Signature Required Merchant');

    const { deviceId, token } = await pairKeylessDevice(mId, userId, 'Test 4 Keyless');

    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
       VALUES (?, 'basic', 'enforce', datetime('now'))
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'basic', enforcement_mode = 'enforce'`
    ).bind(mId).run();

    // Grant override
    const grantRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Attempting to bypass signature required', expires_in_days: 30 }),
    });
    expect(grantRes.status).toBe(201);

    // Turn on SIGNATURE_REQUIRED
    const prevFlag = tenv.SIGNATURE_REQUIRED;
    tenv.SIGNATURE_REQUIRED = 'true';
    try {
      const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sender: 'bKash', body: 'Tk 500 received. TrxID TRX900041' }),
      });
      expect(res.status).toBe(422);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('DEVICE_MUST_REPAIR');
    } finally {
      tenv.SIGNATURE_REQUIRED = prevFlag;
    }
  });

  it('5. Reason length validation', async () => {
    const mId = range.start + 50;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Reason Validation Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 5 Keyless');

    // Too short (< 10)
    const shortRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'short', expires_in_days: 30 }),
    });
    expect(shortRes.status).toBe(400);
    const shortJson = await shortRes.json<{ error: { code: string } }>();
    expect(shortJson.error.code).toBe('REASON_REQUIRED');

    // Missing reason
    const missingRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ expires_in_days: 30 }),
    });
    expect(missingRes.status).toBe(400);
    const missingJson = await missingRes.json<{ error: { code: string } }>();
    expect(missingJson.error.code).toBe('REASON_REQUIRED');
  });

  it('6. Expiry value validation', async () => {
    const mId = range.start + 60;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Expiry Validation Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 6 Keyless');

    // 45 days (invalid)
    const res45 = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Valid length reason for 45 days test', expires_in_days: 45 }),
    });
    expect(res45.status).toBe(400);
    const json45 = await res45.json<{ error: { code: string } }>();
    expect(json45.error.code).toBe('INVALID_EXPIRY');

    // 91 days (invalid)
    const res91 = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Valid length reason for 91 days test', expires_in_days: 91 }),
    });
    expect(res91.status).toBe(400);
    const json91 = await res91.json<{ error: { code: string } }>();
    expect(json91.error.code).toBe('INVALID_EXPIRY');

    // 90 days (valid)
    const res90 = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Valid length reason for 90 days test', expires_in_days: 90 }),
    });
    expect(res90.status).toBe(201);
  });

  it('7. Quota enforced at 20 active overrides', async () => {
    const mId = range.start + 70;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Quota Merchant');

    // Direct D1 seed of 20 distinct devices and active overrides
    const now = new Date().toISOString();
    for (let i = 1; i <= 20; i++) {
      const devId = mId * 100 + i;
      await db.prepare(
        `INSERT INTO op_paired_devices (id, merchant_id, user_id, uuid, device_name, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?)`
      ).bind(devId, mId, userId, crypto.randomUUID(), `Bulk Device ${i}`, now).run();

      await db.prepare(
        `INSERT INTO op_device_policy_overrides
           (merchant_id, device_id, authorized_by, authorized_at, reason, acknowledged_tier, required_tier, expires_at)
         VALUES (?, ?, ?, ?, 'Seeded quota override', 'keyless', 'basic', datetime('now', '+30 days'))`
      ).bind(mId, devId, userId, now).run();
    }

    // Pair a 21st device
    const { deviceId: dev21 } = await pairKeylessDevice(mId, userId, 'Device 21');

    // 21st grant attempt must fail with 429
    const res21 = await SELF.fetch(`http://localhost/api/v1/devices/${dev21}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Attempting 21st override exceeding quota', expires_in_days: 30 }),
    });
    expect(res21.status).toBe(429);
    const json21 = await res21.json<{ error: { code: string } }>();
    expect(json21.error.code).toBe('OVERRIDE_QUOTA_EXCEEDED');
  });

  it('8. Duplicate active override rejected', async () => {
    const mId = range.start + 80;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'Duplicate Override Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 8 Keyless');

    // First grant -> 201
    const res1 = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'First grant for duplicate check', expires_in_days: 30 }),
    });
    expect(res1.status).toBe(201);
    const json1 = await res1.json<{ data: { id: number } }>();

    // Second grant for same device -> 409
    const res2 = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Second grant attempt duplicate', expires_in_days: 30 }),
    });
    expect(res2.status).toBe(409);
    const json2 = await res2.json<{ error: { code: string; override_id?: number } }>();
    expect(json2.error.code).toBe('OVERRIDE_ALREADY_ACTIVE');
    expect(json2.error.override_id).toBe(json1.data.id);
  });

  it('9. Non-admin role rejected', async () => {
    const mId = range.start + 90;
    const { readApiKey, userId } = await setupTestMerchant(mId, 'Non Admin Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 9 Keyless');

    // Call grant with read-only API key -> 403 FORBIDDEN
    const res = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readApiKey}` },
      body: JSON.stringify({ reason: 'Read only key attempting override grant', expires_in_days: 30 }),
    });
    expect(res.status).toBe(403);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('FORBIDDEN');
  });

  it('10. Admin API override grant', async () => {
    const platformMerchantId = range.start + 100;
    const targetMerchantId = range.start + 105;

    // Platform merchant with is_platform = 1
    const { adminApiKey: platformApiKey } = await setupTestMerchant(platformMerchantId, 'Platform Admin');
    await db.prepare(`UPDATE op_merchants SET is_platform = 1 WHERE id = ?`).bind(platformMerchantId).run();

    // Target merchant & device
    const { userId: targetUserId } = await setupTestMerchant(targetMerchantId, 'Target Merchant');
    const { deviceId: targetDeviceId } = await pairKeylessDevice(targetMerchantId, targetUserId, 'Target Device');

    // Call Admin API POST /api/admin/v1/merchants/:id/devices/:deviceId/policy-override
    const res = await SELF.fetch(
      `http://localhost/api/admin/v1/merchants/${targetMerchantId}/devices/${targetDeviceId}/policy-override`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${platformApiKey}` },
        body: JSON.stringify({
          reason: 'Granted by platform admin for enterprise exception',
          expires_in_days: 60,
        }),
      },
    );
    expect(res.status).toBe(201);
    const json = await res.json<{ data: { id: number; merchant_id: number; device_id: number } }>();
    expect(json.data.merchant_id).toBe(targetMerchantId);
    expect(json.data.device_id).toBe(targetDeviceId);

    // Verify D1 row
    const row = await db.prepare(
      `SELECT id, merchant_id, device_id FROM op_device_policy_overrides WHERE id = ?`
    ).bind(json.data.id).first<{ id: number; merchant_id: number; device_id: number }>();
    expect(row).toBeDefined();
    expect(row!.merchant_id).toBe(targetMerchantId);
    expect(row!.device_id).toBe(targetDeviceId);
  });

  it('11. GET returns null when no override', async () => {
    const mId = range.start + 110;
    const { adminApiKey, userId } = await setupTestMerchant(mId, 'No Override Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 11 Keyless');

    const res = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      headers: { Authorization: `Bearer ${adminApiKey}` },
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: unknown }>();
    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it('12. Device not found returns 404', async () => {
    const mId = range.start + 120;
    const foreignMId = range.start + 125;
    const { adminApiKey } = await setupTestMerchant(mId, 'Merchant A');
    const { userId: foreignUserId } = await setupTestMerchant(foreignMId, 'Merchant B');
    const { deviceId: foreignDeviceId } = await pairKeylessDevice(foreignMId, foreignUserId, 'Foreign Device');

    // Non-existent device ID
    const resNonExistent = await SELF.fetch(`http://localhost/api/v1/devices/99999999/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Non existent device override test', expires_in_days: 30 }),
    });
    expect(resNonExistent.status).toBe(404);
    const jsonNonExistent = await resNonExistent.json<{ error: { code: string } }>();
    expect(jsonNonExistent.error.code).toBe('DEVICE_NOT_FOUND');

    // Foreign merchant device ID
    const resForeign = await SELF.fetch(`http://localhost/api/v1/devices/${foreignDeviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Foreign merchant device override test', expires_in_days: 30 }),
    });
    expect(resForeign.status).toBe(404);
    const jsonForeign = await resForeign.json<{ error: { code: string } }>();
    expect(jsonForeign.error.code).toBe('DEVICE_NOT_FOUND');
  });

  it('13. authorized_by attributes to creator user ID, not API key ID, and rejects unresolvable actor', async () => {
    const mId = range.start + 130;
    const { userId, adminApiKey } = await setupTestMerchant(mId, 'Attribution Merchant');
    const { deviceId } = await pairKeylessDevice(mId, userId, 'Test 13 Keyless');

    // Get the API key's own integer ID from op_api_keys
    const keyPrefix = adminApiKey.slice('op_live_'.length, 'op_live_'.length + 12);
    const keyRow = await db.prepare(`SELECT id, created_by FROM op_api_keys WHERE key_prefix = ?`).bind(keyPrefix).first<{ id: number; created_by: number }>();
    expect(keyRow).toBeDefined();
    expect(keyRow!.id).not.toBe(userId);
    expect(keyRow!.created_by).toBe(userId);

    // Grant override with adminApiKey
    const grantRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Valid creator attribution test', expires_in_days: 30 }),
    });
    expect(grantRes.status).toBe(201);
    const grantJson = await grantRes.json<{ data: { authorized_by: number; id: number } }>();

    // Assert authorized_by matches userId, NOT keyRow.id
    expect(grantJson.data.authorized_by).toBe(userId);
    expect(grantJson.data.authorized_by).not.toBe(keyRow!.id);

    // Also assert directly in the database table
    const dbRow = await db.prepare(`SELECT authorized_by FROM op_device_policy_overrides WHERE id = ?`).bind(grantJson.data.id).first<{ authorized_by: number }>();
    expect(dbRow?.authorized_by).toBe(userId);

    // Revoke the override so the device can test again
    await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ reason: 'Revoke for next test' }),
    });

    // Create an API key with created_by = NULL (unattributable actor)
    const orphanPrefix = `o${String(mId).padStart(11, '0')}`.slice(0, 12);
    const orphanRest = `k${String(mId).padStart(31, '0')}`.slice(0, 32);
    const orphanApiKey = `op_live_${orphanPrefix}_${orphanRest}`;
    const orphanKeyHash = await sha256(orphanApiKey);
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'orphan-key', ?, ?, ?, 'active', NULL, ?)`
    ).bind(mId, orphanPrefix, orphanKeyHash, JSON.stringify(['read', 'write', 'admin']), new Date().toISOString()).run();

    // Attempt override grant with the orphan key -> must reject with 400 NO_ACTOR_RESOLVED
    const orphanRes = await SELF.fetch(`http://localhost/api/v1/devices/${deviceId}/policy-override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orphanApiKey}` },
      body: JSON.stringify({ reason: 'Orphan key grant attempt', expires_in_days: 30 }),
    });
    expect(orphanRes.status).toBe(400);
    const orphanJson = await orphanRes.json<{ error: { code: string } }>();
    expect(orphanJson.error.code).toBe('NO_ACTOR_RESOLVED');
  });
});
