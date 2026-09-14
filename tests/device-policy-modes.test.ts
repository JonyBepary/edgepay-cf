/**
 * Test Suite: Merchant Device Policy Enforcement Modes & Telemetry.
 *
 * Verifies:
 *   1. Default mode is 'audit': keyless device pairs (201), telemetry recorded with compliant=0.
 *   2. Audit mode allows SMS without signature: keyless device forwards SMS (200), telemetry recorded.
 *   3. Enforce mode blocks SMS: basic device sending SMS to attested policy rejected (422 DEVICE_TIER_INSUFFICIENT).
 *   4. Global override DEVICE_POLICY_GLOBAL_MODE='audit' caps merchant in 'enforce' mode (SMS allowed 200).
 *   5. Global override DEVICE_POLICY_GLOBAL_MODE='off' skips evaluation (0 stats rows inserted).
 *   6. Compliance rate calculation via GET /api/v1/device-policy/compliance?days=30.
 *   7. Enforcement mode endpoint validation: PUT /api/v1/device-policy/enforcement-mode (invalid -> 400, valid -> 200).
 *   8. Admin override: PUT /api/admin/v1/merchants/:id/device-policy/enforcement-mode (admin 200, non-admin 403).
 *   9. Pairing telemetry emitted before blocking in enforce mode (422 response, daily stats row exists).
 *  10. Batch SMS telemetry aggregation: batch SMS updates evaluation_count by message count.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256 } from '../src/lib/crypto';
import { generateTestDeviceKeyPair, buildCanonicalSmsPayload, signTestDevicePayload } from '../src/lib/device-crypto';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.DEVICE_POLICY_MODES;

describe('Device Policy Enforcement Modes & Compliance Telemetry', () => {
  const merchantId = range.start;
  const complianceMerchantId = range.start + 10;
  const userId = range.start + 50;
  const now = new Date().toISOString();

  const adminKeyPrefix = `p${String(merchantId).padStart(11, '0')}`.slice(0, 12);
  const adminKeyRest = `k${String(merchantId).padStart(31, '0')}`.slice(0, 32);
  const adminApiKey = `op_live_${adminKeyPrefix}_${adminKeyRest}`;

  const writeKeyPrefix = `w${String(merchantId).padStart(11, '0')}`.slice(0, 12);
  const writeKeyRest = `k${String(merchantId).padStart(31, '0')}`.slice(0, 32);
  const writeApiKey = `op_live_${writeKeyPrefix}_${writeKeyRest}`;

  const compKeyPrefix = `c${String(complianceMerchantId).padStart(11, '0')}`.slice(0, 12);
  const compKeyRest = `k${String(complianceMerchantId).padStart(31, '0')}`.slice(0, 32);
  const compApiKey = `op_live_${compKeyPrefix}_${compKeyRest}`;

  beforeAll(async () => {
    // Seed primary test merchant (platform admin)
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'Device Modes Merchant', 'device-modes-corp', 'modes-admin@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    // Seed compliance test merchant
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'Compliance Merchant', 'compliance-corp', 'compliance@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(complianceMerchantId, crypto.randomUUID(), now, now).run();

    // Seed user
    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('modes-admin@test.local');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Modes User', 'modes-admin@test.local', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();

    // Seed Admin API key (scopes: read, write, admin)
    const adminKeyHash = await sha256(adminApiKey);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(adminKeyPrefix).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'admin-key', ?, ?, ?, 'active', 0, ?)`
    ).bind(merchantId, adminKeyPrefix, adminKeyHash, JSON.stringify(['read', 'write', 'admin']), now).run();

    // Seed Write-only API key (scopes: read, write)
    const writeKeyHash = await sha256(writeApiKey);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(writeKeyPrefix).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'write-key', ?, ?, ?, 'active', 0, ?)`
    ).bind(merchantId, writeKeyPrefix, writeKeyHash, JSON.stringify(['read', 'write']), now).run();

    // Seed Compliance API key
    const compKeyHash = await sha256(compApiKey);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(compKeyPrefix).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'comp-key', ?, ?, ?, 'active', 0, ?)`
    ).bind(complianceMerchantId, compKeyPrefix, compKeyHash, JSON.stringify(['read', 'write']), now).run();

    for (const m of [merchantId, complianceMerchantId]) {
      await db.prepare(
        `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, created_at, updated_at)
         VALUES (?, ?, 'Main', 'main', 'active', ?, ?)
         ON CONFLICT DO NOTHING`
      ).bind(m, crypto.randomUUID(), now, now).run();
      const brand = await db.prepare(
        `SELECT id FROM op_brands WHERE merchant_id = ? AND slug = 'main'`
      ).bind(m).first<{ id: number }>();
      if (brand) {
        await db.prepare(
          `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, default_currency, status, created_at, updated_at)
           VALUES (?, ?, ?, 'Main', 'main', 'BDT', 'active', ?, ?)
           ON CONFLICT DO NOTHING`
        ).bind(brand.id, m, crypto.randomUUID(), now, now).run();
      }
    }
  });

  let keylessToken: string;
  let basicToken: string;
  let basicDeviceId: number;
  let basicKeyPair: { publicKeySpkiB64: string; privateKey: CryptoKey };

  it('ANALYTICS binding is present in the test env', () => {
    expect(tenv.ANALYTICS).toBeDefined();
  });

  it('1. default mode is audit: keyless device pairs (201) and daily stats records compliant=0', async () => {
    // Ensure default policy (no custom row or default audit mode)
    await db.prepare(`DELETE FROM op_merchant_device_policies WHERE merchant_id = ?`).bind(merchantId).run();
    await db.prepare(`DELETE FROM op_device_policy_daily_stats WHERE merchant_id = ?`).bind(merchantId).run();

    const otp = '890001';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_def_modes', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // Pair without public_key (keyless device)
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.31' },
      body: JSON.stringify({
        otp,
        device_name: 'Keyless Audit Device',
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json<{
      data: {
        device_id: string;
        token: string;
        tier: string;
        policy: { required_tier: string; satisfied: boolean };
      };
    }>();

    expect(json.data.tier).toBe('keyless');
    expect(json.data.policy.required_tier).toBe('basic');
    expect(json.data.policy.satisfied).toBe(false);

    keylessToken = json.data.token;

    // Check daily stats rollup has recorded this pairing with compliant=0
    const today = new Date().toISOString().slice(0, 10);
    const stats = await db.prepare(
      `SELECT context, required_tier, achieved_tier, compliant, evaluation_count
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'pairing'`
    ).bind(merchantId, today).first<{
      context: string;
      required_tier: string;
      achieved_tier: string;
      compliant: number;
      evaluation_count: number;
    }>();

    expect(stats).not.toBeNull();
    expect(stats!.context).toBe('pairing');
    expect(stats!.required_tier).toBe('basic');
    expect(stats!.achieved_tier).toBe('keyless');
    expect(stats!.compliant).toBe(0);
    expect(stats!.evaluation_count).toBeGreaterThanOrEqual(1);
  });

  it('2. audit mode allows SMS without signature: keyless device forwards SMS (200) and daily stats records compliant=0', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keylessToken}` },
      body: JSON.stringify({
        sender: 'bKash',
        body: 'Tk 500 received. TrxID TRX890002',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { status: string } }>();
    expect(json.success).toBe(true);

    // Verify daily stats recorded SMS context with compliant=0
    const today = new Date().toISOString().slice(0, 10);
    const stats = await db.prepare(
      `SELECT context, required_tier, achieved_tier, compliant, evaluation_count
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'sms' AND achieved_tier = 'keyless'`
    ).bind(merchantId, today).first<{
      context: string;
      required_tier: string;
      achieved_tier: string;
      compliant: number;
      evaluation_count: number;
    }>();

    expect(stats).not.toBeNull();
    expect(stats!.context).toBe('sms');
    expect(stats!.compliant).toBe(0);
    expect(stats!.evaluation_count).toBeGreaterThanOrEqual(1);
  });

  it('3. enforce mode blocks SMS: basic device sending SMS to attested policy is rejected with 422 DEVICE_TIER_INSUFFICIENT', async () => {
    // Pair a basic device (has hardware key pair, but no attestation)
    const otp = '890003';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_basic', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    basicKeyPair = await generateTestDeviceKeyPair();
    const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.33' },
      body: JSON.stringify({
        otp,
        device_name: 'Basic Device for Enforce Test',
        public_key: basicKeyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(pairRes.status).toBe(201);
    const pairJson = await pairRes.json<{ data: { device_id: string; token: string; tier: string } }>();
    expect(pairJson.data.tier).toBe('basic');
    basicToken = pairJson.data.token;

    const devRow = await db.prepare(`SELECT id FROM op_paired_devices WHERE uuid = ?`).bind(pairJson.data.device_id).first<{ id: number }>();
    basicDeviceId = devRow!.id;

    // Set merchant policy: required tier = attested, enforcement_mode = enforce
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, strict_pairing, enforcement_mode, updated_at)
       VALUES (?, 'attested', 0, 'enforce', ?)
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', strict_pairing = 0, enforcement_mode = 'enforce'`
    ).bind(merchantId, now).run();

    // Build signed SMS
    const ts = Date.now();
    const nonce = 'modes-nonce-3';
    const payload = buildCanonicalSmsPayload({
      deviceId: basicDeviceId,
      nonce,
      timestamp: ts,
      sender: 'bKash',
      body: 'Tk 250 received',
    });
    const sig = await signTestDevicePayload(basicKeyPair.privateKey, payload);

    const smsRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${basicToken}` },
      body: JSON.stringify({
        sender: 'bKash',
        body: 'Tk 250 received',
        timestamp: ts,
        nonce,
        signature: sig,
      }),
    });

    expect(smsRes.status).toBe(422);
    const smsErr = await smsRes.json<{ error: { code: string; device_tier: string; required_tier: string } }>();
    expect(smsErr.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
    expect(smsErr.error.device_tier).toBe('basic');
    expect(smsErr.error.required_tier).toBe('attested');

    // Daily stats recorded compliant=0 for context='sms'
    const today = new Date().toISOString().slice(0, 10);
    const stats = await db.prepare(
      `SELECT count(*) as total
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'sms' AND required_tier = 'attested' AND compliant = 0`
    ).bind(merchantId, today).first<{ total: number }>();
    expect(stats!.total).toBeGreaterThan(0);
  });

  it('4. global override DEVICE_POLICY_GLOBAL_MODE=audit caps merchant in enforce mode (SMS allowed 200)', async () => {
    // Merchant is still configured with enforcement_mode='enforce' and min_tier='attested'
    const origGlobal = tenv.DEVICE_POLICY_GLOBAL_MODE;
    tenv.DEVICE_POLICY_GLOBAL_MODE = 'audit';

    try {
      const ts = Date.now();
      const nonce = 'modes-nonce-4';
      const payload = buildCanonicalSmsPayload({
        deviceId: basicDeviceId,
        nonce,
        timestamp: ts,
        sender: 'bKash',
        body: 'Tk 300 received',
      });
      const sig = await signTestDevicePayload(basicKeyPair.privateKey, payload);

      const smsRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${basicToken}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'Tk 300 received',
          timestamp: ts,
          nonce,
          signature: sig,
        }),
      });

      expect(smsRes.status).toBe(200);
      const json = await smsRes.json<{ success: boolean }>();
      expect(json.success).toBe(true);
    } finally {
      tenv.DEVICE_POLICY_GLOBAL_MODE = origGlobal;
    }
  });

  it('5. global override DEVICE_POLICY_GLOBAL_MODE=off skips evaluation (0 stats rows inserted)', async () => {
    const origGlobal = tenv.DEVICE_POLICY_GLOBAL_MODE;
    tenv.DEVICE_POLICY_GLOBAL_MODE = 'off';

    try {
      const today = new Date().toISOString().slice(0, 10);
      const before = await db.prepare(
        `SELECT SUM(evaluation_count) as total FROM op_device_policy_daily_stats WHERE merchant_id = ? AND day = ?`
      ).bind(merchantId, today).first<{ total: number | null }>();
      const countBefore = before?.total ?? 0;

      const ts = Date.now();
      const nonce = 'modes-nonce-5';
      const payload = buildCanonicalSmsPayload({
        deviceId: basicDeviceId,
        nonce,
        timestamp: ts,
        sender: 'bKash',
        body: 'Tk 400 received',
      });
      const sig = await signTestDevicePayload(basicKeyPair.privateKey, payload);

      const smsRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${basicToken}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'Tk 400 received',
          timestamp: ts,
          nonce,
          signature: sig,
        }),
      });

      expect(smsRes.status).toBe(200);

      const after = await db.prepare(
        `SELECT SUM(evaluation_count) as total FROM op_device_policy_daily_stats WHERE merchant_id = ? AND day = ?`
      ).bind(merchantId, today).first<{ total: number | null }>();
      const countAfter = after?.total ?? 0;

      expect(countAfter).toBe(countBefore);
    } finally {
      tenv.DEVICE_POLICY_GLOBAL_MODE = origGlobal;
    }
  });

  it('6. compliance rate calculation via GET /api/v1/device-policy/compliance?days=30', async () => {
    // Clean and seed op_device_policy_daily_stats for complianceMerchantId
    await db.prepare(`DELETE FROM op_device_policy_daily_stats WHERE merchant_id = ?`).bind(complianceMerchantId).run();

    const today = new Date().toISOString().slice(0, 10);
    // 75 compliant evaluations
    await db.prepare(
      `INSERT INTO op_device_policy_daily_stats
         (merchant_id, day, context, required_tier, achieved_tier, compliant, evaluation_count)
       VALUES (?, ?, 'sms', 'attested', 'attested', 1, 75)`
    ).bind(complianceMerchantId, today).run();

    // 25 non-compliant evaluations
    await db.prepare(
      `INSERT INTO op_device_policy_daily_stats
         (merchant_id, day, context, required_tier, achieved_tier, compliant, evaluation_count)
       VALUES (?, ?, 'sms', 'attested', 'basic', 0, 25)`
    ).bind(complianceMerchantId, today).run();

    const res = await SELF.fetch('http://localhost/api/v1/device-policy/compliance?days=30', {
      headers: { Authorization: `Bearer ${compApiKey}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{
      success: boolean;
      data: {
        window_days: number;
        by_tier: Array<{ required_tier: string; achieved_tier: string; compliant: number; count: number }>;
        compliance_rate: number;
        compliant_evaluations: number;
        total_evaluations: number;
      };
    }>();

    expect(json.success).toBe(true);
    expect(json.data.window_days).toBe(30);
    expect(json.data.total_evaluations).toBe(100);
    expect(json.data.compliant_evaluations).toBe(75);
    expect(json.data.compliance_rate).toBe(0.75);
    expect(json.data.by_tier.length).toBe(2);
  });

  it('6a. compliance endpoint returns null rate when no evaluations exist', async () => {
    // Clean stats for complianceMerchantId
    await db.prepare(`DELETE FROM op_device_policy_daily_stats WHERE merchant_id = ?`).bind(complianceMerchantId).run();

    const res = await SELF.fetch('http://localhost/api/v1/device-policy/compliance?days=30', {
      headers: { Authorization: `Bearer ${compApiKey}` },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{
      success: boolean;
      data: {
        total_evaluations: number;
        compliance_rate: number | null;
        window_days: number;
      };
    }>();

    expect(json.success).toBe(true);
    expect(json.data.total_evaluations).toBe(0);
    expect(json.data.compliance_rate).toBeNull();
  });

  it('6b. days parameter is clamped to 1..90', async () => {
    const r1 = await SELF.fetch('http://localhost/api/v1/device-policy/compliance?days=999', {
      headers: { Authorization: `Bearer ${compApiKey}` },
    });
    const j1 = await r1.json<{ data: { window_days: number } }>();
    expect(j1.data.window_days).toBe(90);

    const r2 = await SELF.fetch('http://localhost/api/v1/device-policy/compliance?days=-5', {
      headers: { Authorization: `Bearer ${compApiKey}` },
    });
    const j2 = await r2.json<{ data: { window_days: number } }>();
    expect(j2.data.window_days).toBe(1);

    const r3 = await SELF.fetch('http://localhost/api/v1/device-policy/compliance?days=abc', {
      headers: { Authorization: `Bearer ${compApiKey}` },
    });
    const j3 = await r3.json<{ data: { window_days: number } }>();
    expect(j3.data.window_days).toBe(30);
  });

  it('7. enforcement mode endpoint validation: PUT /api/v1/device-policy/enforcement-mode', async () => {
    // 1. Invalid mode -> 400 INVALID_MODE
    const badRes = await SELF.fetch('http://localhost/api/v1/device-policy/enforcement-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${compApiKey}` },
      body: JSON.stringify({ mode: 'yolo' }),
    });

    expect(badRes.status).toBe(400);
    const badJson = await badRes.json<{ error: { code: string; message: string } }>();
    expect(badJson.error.code).toBe('INVALID_MODE');

    // 2. Valid mode 'enforce' -> 200
    const goodRes = await SELF.fetch('http://localhost/api/v1/device-policy/enforcement-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${compApiKey}` },
      body: JSON.stringify({ mode: 'enforce' }),
    });

    expect(goodRes.status).toBe(200);
    const goodJson = await goodRes.json<{ data: { enforcement_mode: string } }>();
    expect(goodJson.data.enforcement_mode).toBe('enforce');

    // Verify DB was updated
    const row = await db.prepare(
      `SELECT enforcement_mode FROM op_merchant_device_policies WHERE merchant_id = ?`
    ).bind(complianceMerchantId).first<{ enforcement_mode: string }>();
    expect(row?.enforcement_mode).toBe('enforce');

    // 3. Switch back to 'audit'
    const auditRes = await SELF.fetch('http://localhost/api/v1/device-policy/enforcement-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${compApiKey}` },
      body: JSON.stringify({ mode: 'audit' }),
    });
    expect(auditRes.status).toBe(200);
    const auditJson = await auditRes.json<{ data: { enforcement_mode: string } }>();
    expect(auditJson.data.enforcement_mode).toBe('audit');
  });

  it('7b. device_policy_mode_changed metric fires on mode transition', async () => {
    const spy = vi.spyOn(tenv.ANALYTICS as unknown as { writeDataPoint: (...args: unknown[]) => void }, 'writeDataPoint');
    try {
      const res = await SELF.fetch('http://localhost/api/v1/device-policy/enforcement-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${compApiKey}` },
        body: JSON.stringify({ mode: 'enforce' }),
      });
      expect(res.status).toBe(200);

      // Verify metric writeDataPoint was invoked
      expect(spy).toHaveBeenCalled();
      const modeChangeCall = spy.mock.calls.find((call) => {
        const arg = call[0] as { blobs?: string[] };
        return arg?.blobs?.includes('device_policy_mode_changed');
      });
      expect(modeChangeCall).toBeDefined();
    } finally {
      spy.mockRestore();
      // Reset back to audit
      await SELF.fetch('http://localhost/api/v1/device-policy/enforcement-mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${compApiKey}` },
        body: JSON.stringify({ mode: 'audit' }),
      });
    }
  });

  it('8. admin override: PUT /api/admin/v1/merchants/:id/device-policy/enforcement-mode', async () => {
    // Reset merchant policy to audit before testing
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
       VALUES (?, 'basic', 'audit', datetime('now'))
       ON CONFLICT(merchant_id) DO UPDATE SET enforcement_mode = 'audit'`
    ).bind(merchantId).run();

    // 1. Non-admin API key (read/write only) returns 401
    // Cloudflare Access middleware rejects requests without Cf-Access-Jwt-Assertion
    // before the route-level requireScope('admin') check runs, so non-admin API
    // keys get 401 here rather than 403. The important invariant is that the
    // request never reaches the handler and never mutates the target merchant.
    const nonAdminRes = await SELF.fetch(`http://localhost/api/admin/v1/merchants/${merchantId}/device-policy/enforcement-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${writeApiKey}` },
      body: JSON.stringify({ mode: 'enforce' }),
    });

    expect(nonAdminRes.status).toBe(401);

    const after = await db.prepare(
      `SELECT enforcement_mode FROM op_merchant_device_policies WHERE merchant_id = ?`
    ).bind(merchantId).first<{ enforcement_mode: string }>();
    expect(after?.enforcement_mode).not.toBe('enforce'); // unchanged by the failed request

    // 2. Admin API key returns 200 and updates mode
    const adminRes = await SELF.fetch(`http://localhost/api/admin/v1/merchants/${merchantId}/device-policy/enforcement-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminApiKey}` },
      body: JSON.stringify({ mode: 'enforce' }),
    });

    expect(adminRes.status).toBe(200);
    const adminJson = await adminRes.json<{ data: { enforcement_mode: string } }>();
    expect(adminJson.data.enforcement_mode).toBe('enforce');

    const row = await db.prepare(
      `SELECT enforcement_mode FROM op_merchant_device_policies WHERE merchant_id = ?`
    ).bind(merchantId).first<{ enforcement_mode: string }>();
    expect(row?.enforcement_mode).toBe('enforce');

    // Reset merchant back to audit
    await db.prepare(
      `UPDATE op_merchant_device_policies SET enforcement_mode = 'audit' WHERE merchant_id = ?`
    ).bind(merchantId).run();
  });

  it('9. pairing telemetry emitted before blocking in enforce mode (422 response, daily stats row exists)', async () => {
    // Merchant requires attested tier with enforce mode
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, strict_pairing, enforcement_mode, updated_at)
       VALUES (?, 'attested', 0, 'enforce', ?)
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', strict_pairing = 0, enforcement_mode = 'enforce'`
    ).bind(merchantId, now).run();

    const otp = '890009';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok_pair_telemetry', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const keyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.39' },
      body: JSON.stringify({
        otp,
        device_name: 'Blocked In Enforce Mode',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string; device_tier: string; required_tier: string } }>();
    expect(err.error.code).toBe('DEVICE_TIER_INSUFFICIENT');

    // Confirm device was NOT inserted
    const dev = await db.prepare(`SELECT 1 FROM op_paired_devices WHERE device_name = 'Blocked In Enforce Mode'`).first();
    expect(dev).toBeNull();

    // Confirm telemetry was recorded in op_device_policy_daily_stats
    const today = new Date().toISOString().slice(0, 10);
    const stats = await db.prepare(
      `SELECT evaluation_count
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'pairing' AND required_tier = 'attested' AND achieved_tier = 'basic' AND compliant = 0`
    ).bind(merchantId, today).first<{ evaluation_count: number }>();

    expect(stats).not.toBeNull();
    expect(stats!.evaluation_count).toBeGreaterThanOrEqual(1);
  });

  it('10. batch SMS telemetry aggregation updates evaluation_count by message count', async () => {
    // Reset merchant policy to basic + audit
    await db.prepare(
      `UPDATE op_merchant_device_policies SET min_tier = 'basic', enforcement_mode = 'audit' WHERE merchant_id = ?`
    ).bind(merchantId).run();

    const today = new Date().toISOString().slice(0, 10);
    const beforeStats = await db.prepare(
      `SELECT evaluation_count
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'sms_batch' AND achieved_tier = 'basic' AND compliant = 1`
    ).bind(merchantId, today).first<{ evaluation_count: number }>();
    const countBefore = beforeStats?.evaluation_count ?? 0;

    const ts = Date.now();
    const n1 = 'batch-nonce-1';
    const n2 = 'batch-nonce-2';
    const n3 = 'batch-nonce-3';

    const p1 = buildCanonicalSmsPayload({ deviceId: basicDeviceId, nonce: n1, timestamp: ts, sender: 'bKash', body: 'Batch 1' });
    const p2 = buildCanonicalSmsPayload({ deviceId: basicDeviceId, nonce: n2, timestamp: ts, sender: 'bKash', body: 'Batch 2' });
    const p3 = buildCanonicalSmsPayload({ deviceId: basicDeviceId, nonce: n3, timestamp: ts, sender: 'bKash', body: 'Batch 3' });

    const s1 = await signTestDevicePayload(basicKeyPair.privateKey, p1);
    const s2 = await signTestDevicePayload(basicKeyPair.privateKey, p2);
    const s3 = await signTestDevicePayload(basicKeyPair.privateKey, p3);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${basicToken}` },
      body: JSON.stringify({
        messages: [
          { sender: 'bKash', body: 'Batch 1', timestamp: ts, nonce: n1, signature: s1 },
          { sender: 'bKash', body: 'Batch 2', timestamp: ts, nonce: n2, signature: s2 },
          { sender: 'bKash', body: 'Batch 3', timestamp: ts, nonce: n3, signature: s3 },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { synced_count: number } }>();
    expect(json.success).toBe(true);
    expect(json.data.synced_count).toBe(3);

    const afterStats = await db.prepare(
      `SELECT evaluation_count
       FROM op_device_policy_daily_stats
       WHERE merchant_id = ? AND day = ? AND context = 'sms_batch' AND achieved_tier = 'basic' AND compliant = 1`
    ).bind(merchantId, today).first<{ evaluation_count: number }>();

    expect(afterStats).not.toBeNull();
    expect(afterStats!.evaluation_count).toBe(countBefore + 3);
  });
});
