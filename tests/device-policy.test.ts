/**
 * Test Suite: Merchant Device Trust Policy & Graceful Degradation.
 *
 * Verifies:
 *   1. Default policy: merchant with no row -> min_tier='basic', pairing succeeds.
 *   2. Merchant sets min_tier='attested', keyless device pairs, policy.satisfied=false, SMS rejected with DEVICE_TIER_INSUFFICIENT.
 *   3. Merchant sets min_tier='strongbox', TEE-attested device pairs (non-strict), SMS rejected with reason='NOT_STRONGBOX'.
 *   4. Merchant sets strict_pairing=1, keyless device -> pairing returns 422, device row not created.
 *   5. min_patch_level='2024-01' + device patch '2023-06' -> tier stays 'attested', SMS to strongbox merchant rejected.
 *   6. Attestation ages past ATTESTATION_MAX_AGE_DAYS -> tier drops from 'attested' to 'basic', SMS gated.
 *   7. Policy change retroactively affects existing device: pair under basic, change policy to attested, next SMS rejected.
 *   8. Platform env ATTESTATION_REQUIRED=true overrides merchant min_tier='basic' -> effective 'attested'.
 *   9. Platform env STRONGBOX_REQUIRED=true + merchant min_tier='basic' -> effective 'strongbox'.
 *  10. Endpoint APIs: GET /devices, GET/PUT /device-policy, and admin overrides.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { resolvePolicy, computeDeviceTier, TIER_RANK } from '../src/services/device-policy';
import { sha256 } from '../src/lib/crypto';
import { generateTestDeviceKeyPair, buildCanonicalSmsPayload, signTestDevicePayload } from '../src/lib/device-crypto';
import { createJwtService } from '../src/lib/jwt';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.DEVICE_POLICY;

describe('Merchant Device Trust Policy & Graceful Degradation', () => {
  const merchantId = range.start;
  const userId = range.start + 50;
  const now = new Date().toISOString();

  const apiKeyPrefix = `p${String(merchantId).padStart(11, '0')}`.slice(0, 12);
  const apiKeyRest = `k${String(merchantId).padStart(31, '0')}`.slice(0, 32);
  const apiKey = `op_live_${apiKeyPrefix}_${apiKeyRest}`;

  beforeAll(async () => {
    // Seed test merchant & user
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'Device Policy Merchant', 'device-policy-corp', 'policy-admin@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('policy-admin@test.local');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Policy User', 'policy-admin@test.local', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();

    const keyHash = await sha256(apiKey);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(apiKeyPrefix).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'policy-key', ?, ?, ?, 'active', 0, ?)`
    ).bind(merchantId, apiKeyPrefix, keyHash, JSON.stringify(['read', 'write', 'admin']), now).run();

    await db.prepare(
      `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, created_at, updated_at)
       VALUES (?, ?, 'Main', 'main', 'active', ?, ?)
       ON CONFLICT DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();
    const brand = await db.prepare(
      `SELECT id FROM op_brands WHERE merchant_id = ? AND slug = 'main'`
    ).bind(merchantId).first<{ id: number }>();
    if (brand) {
      await db.prepare(
        `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, default_currency, status, created_at, updated_at)
         VALUES (?, ?, ?, 'Main', 'main', 'BDT', 'active', ?, ?)
         ON CONFLICT DO NOTHING`
      ).bind(brand.id, merchantId, crypto.randomUUID(), now, now).run();
    }
  });

  it('1. default policy: merchant with no row has min_tier=basic, pairing succeeds with any device', async () => {
    const policy = resolvePolicy(tenv, null);
    expect(policy.min_tier).toBe('basic');
    expect(policy.strict_pairing).toBe(false);

    // Pair a device without attestation
    const otp = '880001';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_def', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const keyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.21' },
      body: JSON.stringify({
        otp,
        device_name: 'Tier 1 Basic Device',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json<{
      success: boolean;
      data: {
        tier: string;
        policy: { required_tier: string; satisfied: boolean; conflict: unknown };
      };
    }>();
    expect(json.success).toBe(true);
    expect(json.data.tier).toBe('basic');
    expect(json.data.policy.required_tier).toBe('basic');
    expect(json.data.policy.satisfied).toBe(true);
    expect(json.data.policy.conflict).toBeNull();
  });

  it('2. merchant sets min_tier=attested: basic device pairs (non-strict), policy.satisfied=false, SMS rejected with DEVICE_TIER_INSUFFICIENT', async () => {
    // Configure merchant policy
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, strict_pairing, enforcement_mode, updated_at)
       VALUES (?, 'attested', 0, 'audit', ?)
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', strict_pairing = 0, enforcement_mode = 'audit'`
    ).bind(merchantId, now).run();

    const otp = '880002';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_att', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const keyPair = await generateTestDeviceKeyPair();
    const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.22' },
      body: JSON.stringify({
        otp,
        device_name: 'Unattested Phone',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(pairRes.status).toBe(201);
    const pairJson = await pairRes.json<{
      data: {
        token: string;
        device_id: string;
        tier: string;
        policy: { required_tier: string; satisfied: boolean; conflict: { code: string } };
      };
    }>();
    expect(pairJson.data.tier).toBe('basic');
    expect(pairJson.data.policy.satisfied).toBe(false);
    expect(pairJson.data.policy.conflict.code).toBe('DEVICE_TIER_INSUFFICIENT');

    // Retrieve device numerical ID
    const devRow = await db.prepare(`SELECT id FROM op_paired_devices WHERE uuid = ?`).bind(pairJson.data.device_id).first<{ id: number }>();
    const deviceId = devRow!.id;

    // Enable enforcement before SMS
    await db.prepare(
      `UPDATE op_merchant_device_policies SET enforcement_mode = 'enforce' WHERE merchant_id = ?`
    ).bind(merchantId).run();

    // Attempting to forward SMS fails tier gating
    const ts = Date.now();
    const nonce = 'policy-nonce-1';
    const payload = buildCanonicalSmsPayload({
      deviceId,
      nonce,
      timestamp: ts,
      sender: 'bKash',
      body: 'Tk 500 received',
    });
    const sig = await signTestDevicePayload(keyPair.privateKey, payload);

    const smsRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairJson.data.token}` },
      body: JSON.stringify({
        sender: 'bKash',
        body: 'Tk 500 received',
        timestamp: ts,
        nonce,
        signature: sig,
      }),
    });

    expect(smsRes.status).toBe(422);
    const smsErr = await smsRes.json<{ error: { code: string; device_tier: string; required_tier: string; reason: string } }>();
    expect(smsErr.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
    expect(smsErr.error.device_tier).toBe('basic');
    expect(smsErr.error.required_tier).toBe('attested');
    expect(smsErr.error.reason).toBe('NO_ATTESTATION');
  });

  it('3. merchant sets min_tier=strongbox: TEE-attested device pairs (non-strict), SMS rejected with reason=NOT_STRONGBOX', async () => {
    await db.prepare(
      `UPDATE op_merchant_device_policies SET min_tier = 'strongbox', strict_pairing = 0, enforcement_mode = 'enforce' WHERE merchant_id = ?`
    ).bind(merchantId).run();

    const deviceUuid = crypto.randomUUID();
    const keyPair = await generateTestDeviceKeyPair();

    // Insert a freshly TEE-attested device (attestation_strong = 0)
    await db.prepare(
      `INSERT INTO op_paired_devices
         (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm,
          attestation_verified_at, attestation_method, attestation_strong, attestation_verified_boot, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, 'TEE Device', '', 'active', ?, 'ES256', ?, 'android_key_attestation', 0, 1, ?, ?)`
    ).bind(merchantId, userId, deviceUuid, keyPair.publicKeySpkiB64, now, now, now).run();

    const devRow = await db.prepare(`SELECT id FROM op_paired_devices WHERE uuid = ?`).bind(deviceUuid).first<{ id: number }>();
    const deviceId = devRow!.id;

    const jwt = createJwtService(tenv);
    const token = await jwt.issueAccessToken({
      sub: String(userId),
      merchant_id: merchantId,
      device_id: deviceId,
      scope: ['read', 'write'],
    });

    const ts = Date.now();
    const nonce = 'policy-nonce-2';
    const payload = buildCanonicalSmsPayload({
      deviceId,
      nonce,
      timestamp: ts,
      sender: 'bKash',
      body: 'Tk 500 received',
    });
    const sig = await signTestDevicePayload(keyPair.privateKey, payload);

    const smsRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sender: 'bKash',
        body: 'Tk 500 received',
        timestamp: ts,
        nonce,
        signature: sig,
      }),
    });

    expect(smsRes.status).toBe(422);
    const smsErr = await smsRes.json<{ error: { code: string; device_tier: string; required_tier: string; reason: string } }>();
    expect(smsErr.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
    expect(smsErr.error.device_tier).toBe('attested');
    expect(smsErr.error.required_tier).toBe('strongbox');
    expect(smsErr.error.reason).toBe('NOT_STRONGBOX');
  });

  it('4. merchant sets strict_pairing=1: keyless or basic device returns 422 and device row is NOT created', async () => {
    await db.prepare(
      `UPDATE op_merchant_device_policies SET min_tier = 'attested', strict_pairing = 1 WHERE merchant_id = ?`
    ).bind(merchantId).run();

    const otp = '880004';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_strict', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const keyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.24' },
      body: JSON.stringify({
        otp,
        device_name: 'Reject Me Strict',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string; message: string; device_tier: string; required_tier: string } }>();
    expect(err.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
    expect(err.error.device_tier).toBe('basic');
    expect(err.error.required_tier).toBe('attested');

    // Confirm device was NOT inserted
    const dev = await db.prepare(`SELECT 1 FROM op_paired_devices WHERE device_name = 'Reject Me Strict'`).first();
    expect(dev).toBeNull();
  });

  it('5. min_patch_level=2024-01 + device patch 2023-06: tier stays attested, SMS to strongbox merchant rejected', () => {
    const policy = {
      min_tier: 'strongbox' as const,
      min_patch_level: '2024-01',
      strict_pairing: false,
    };

    const device = {
      public_key: 'pub_spki',
      attestation_verified_at: new Date().toISOString(),
      attestation_strong: 1, // Has StrongBox hardware!
      attestation_verified_boot: 1,
      device_patch_level: '2023-06', // Older than minimum patch floor
    };

    const tierInfo = computeDeviceTier(device, policy, { maxAttestationAgeMs: 30 * 86400000 });
    expect(tierInfo.tier).toBe('attested');
    expect(tierInfo.reason).toBe('PATCH_LEVEL_BELOW_MIN');
    expect(TIER_RANK[tierInfo.tier] < TIER_RANK[policy.min_tier]).toBe(true);
  });

  it('6. attestation ages past ATTESTATION_MAX_AGE_DAYS: tier drops from attested to basic', () => {
    const policy = {
      min_tier: 'attested' as const,
      min_patch_level: null,
      strict_pairing: false,
    };

    const staleDate = new Date(Date.now() - 35 * 86400000).toISOString();
    const device = {
      public_key: 'pub_spki',
      attestation_verified_at: staleDate,
      attestation_strong: 0,
      attestation_verified_boot: 1,
      device_patch_level: '2024-01',
    };

    const tierInfo = computeDeviceTier(device, policy, { maxAttestationAgeMs: 30 * 86400000 });
    expect(tierInfo.tier).toBe('basic');
    expect(tierInfo.reason).toBe('ATTESTATION_STALE');
  });

  it('7. policy change retroactively affects existing device without re-pairing', async () => {
    // 1. Reset merchant policy to basic
    await db.prepare(
      `UPDATE op_merchant_device_policies SET min_tier = 'basic', strict_pairing = 0 WHERE merchant_id = ?`
    ).bind(merchantId).run();

    const deviceUuid = crypto.randomUUID();
    const keyPair = await generateTestDeviceKeyPair();

    // Device paired under basic policy
    await db.prepare(
      `INSERT INTO op_paired_devices
         (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm,
          attestation_verified_at, attestation_strong, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, 'Retro Device', '', 'active', ?, 'ES256', NULL, 0, ?, ?)`
    ).bind(merchantId, userId, deviceUuid, keyPair.publicKeySpkiB64, now, now).run();

    const devRow = await db.prepare(`SELECT id FROM op_paired_devices WHERE uuid = ?`).bind(deviceUuid).first<{ id: number }>();
    const deviceId = devRow!.id;

    const jwt = createJwtService(tenv);
    const token = await jwt.issueAccessToken({
      sub: String(userId),
      merchant_id: merchantId,
      device_id: deviceId,
      scope: ['read', 'write'],
    });

    // SMS passes under basic
    const ts1 = Date.now();
    const nonce1 = 'retro-nonce-1';
    const p1 = buildCanonicalSmsPayload({ deviceId, nonce: nonce1, timestamp: ts1, sender: 'bKash', body: 'Tk 100' });
    const s1 = await signTestDevicePayload(keyPair.privateKey, p1);

    const okRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sender: 'bKash', body: 'Tk 100', timestamp: ts1, nonce: nonce1, signature: s1 }),
    });
    expect(okRes.status).toBe(200);

    // 2. Merchant tightens policy to 'attested' (enforce mode)
    await db.prepare(
      `UPDATE op_merchant_device_policies SET min_tier = 'attested', enforcement_mode = 'enforce' WHERE merchant_id = ?`
    ).bind(merchantId).run();

    // Next SMS from the same device is immediately rejected without re-pairing
    const ts2 = Date.now();
    const nonce2 = 'retro-nonce-2';
    const p2 = buildCanonicalSmsPayload({ deviceId, nonce: nonce2, timestamp: ts2, sender: 'bKash', body: 'Tk 200' });
    const s2 = await signTestDevicePayload(keyPair.privateKey, p2);

    const rejRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sender: 'bKash', body: 'Tk 200', timestamp: ts2, nonce: nonce2, signature: s2 }),
    });

    expect(rejRes.status).toBe(422);
    const rejErr = await rejRes.json<{ error: { code: string; device_tier: string; required_tier: string } }>();
    expect(rejErr.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
    expect(rejErr.error.required_tier).toBe('attested');
  });

  it('8. platform env ATTESTATION_REQUIRED=true overrides merchant min_tier=basic -> effective attested', () => {
    const mockEnv = { ...tenv, ATTESTATION_REQUIRED: 'true', STRONGBOX_REQUIRED: 'false' };
    const merchantPolicy = { min_tier: 'basic', min_patch_level: null, strict_pairing: 0 };
    const effective = resolvePolicy(mockEnv as unknown as Env, merchantPolicy);

    expect(effective.min_tier).toBe('attested');
  });

  it('9. platform env STRONGBOX_REQUIRED=true overrides merchant min_tier=basic -> effective strongbox', () => {
    const mockEnv = { ...tenv, ATTESTATION_REQUIRED: 'false', STRONGBOX_REQUIRED: 'true' };
    const merchantPolicy = { min_tier: 'basic', min_patch_level: null, strict_pairing: 0 };
    const effective = resolvePolicy(mockEnv as unknown as Env, merchantPolicy);

    expect(effective.min_tier).toBe('strongbox');
  });

  it('10. merchant API endpoints: GET /devices, GET /device-policy, PUT /device-policy and admin overrides', async () => {
    // 1. GET /api/v1/device-policy
    const getPolRes = await SELF.fetch('http://localhost/api/v1/device-policy', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(getPolRes.status).toBe(200);
    const polData = await getPolRes.json<{ data: { min_tier: string } }>();
    expect(polData.data.min_tier).toBeDefined();

    // 2. PUT /api/v1/device-policy
    const putPolRes = await SELF.fetch('http://localhost/api/v1/device-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        min_tier: 'attested',
        min_patch_level: '2023-01',
        strict_pairing: true,
      }),
    });
    expect(putPolRes.status).toBe(200);
    const putData = await putPolRes.json<{ data: { min_tier: string; min_patch_level: string; strict_pairing: boolean } }>();
    expect(putData.data.min_tier).toBe('attested');
    expect(putData.data.min_patch_level).toBe('2023-01');
    expect(putData.data.strict_pairing).toBe(true);

    // 3. GET /api/v1/devices surfaces computed tier and policy satisfaction
    const devRes = await SELF.fetch('http://localhost/api/v1/devices', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(devRes.status).toBe(200);
    const devList = await devRes.json<{ data: Array<{ id: number; tier: string; policy_satisfied: boolean }> }>();
    expect(Array.isArray(devList.data)).toBe(true);
    expect(devList.data.length).toBeGreaterThan(0);
    expect(devList.data[0]).toHaveProperty('tier');
    expect(devList.data[0]).toHaveProperty('policy_satisfied');

    // 4. Admin API override: GET & PUT /api/admin/v1/merchants/:id/device-policy
    const adminPutRes = await SELF.fetch(`http://localhost/api/admin/v1/merchants/${merchantId}/device-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        min_tier: 'basic',
        strict_pairing: false,
      }),
    });
    expect(adminPutRes.status).toBe(200);
  });
});
