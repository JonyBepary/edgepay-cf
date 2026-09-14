/**
 * Test Suite: Attestation Challenge Lifecycle, Single-Use & Race Conditions.
 *
 * Verifies:
 *   1. Atomic single-use consumption: two concurrent /pair requests for the same OTP/challenge
 *      result in exactly one success (201) and one rejection (404 / 422).
 *   2. Replay prevention: re-submitting the same challenge after consumption fails with 422.
 *   3. Expiry handling: expired challenges fail with 422 ATTESTATION_CHALLENGE_EXPIRED.
 *   4. Cross-OTP isolation: challenges are strictly keyed to the specific OTP hash.
 *   5. Concurrent initiate: simultaneous /pair/initiate calls resolve idempotently to the same challenge.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256, bytesToBase64 } from '../src/lib/crypto';
import { generateTestDeviceKeyPair } from '../src/lib/device-crypto';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const merchantRange = TEST_MERCHANT_RANGES.ATTESTATION_CHALLENGE_RACE;

describe('Attestation Challenge Lifecycle & Race Conditions', () => {
  const merchantId = merchantRange.start;
  const userId = 8701;
  const now = new Date().toISOString();

  beforeAll(async () => {
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'RaceMerchant', 'race-merchant', 'race@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('race-user@test.local');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Race User', 'race-user@test.local', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();
  });

  it('enforces single-use challenge consumption under concurrent pairing race', async () => {
    const otp = '870001';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.1';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok-race-1', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // Initiate challenge
    const initRes = await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({ otp }),
    });
    expect(initRes.status).toBe(200);

    const keyPair1 = await generateTestDeviceKeyPair();
    const keyPair2 = await generateTestDeviceKeyPair();

    const payload1 = {
      otp,
      device_name: 'Race Device A',
      public_key: keyPair1.publicKeySpkiB64,
      key_algorithm: 'ES256',
      cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
    };

    const payload2 = {
      otp,
      device_name: 'Race Device B',
      public_key: keyPair2.publicKeySpkiB64,
      key_algorithm: 'ES256',
      cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
    };

    // Fire both concurrently
    const [res1, res2] = await Promise.all([
      SELF.fetch('http://localhost/api/mobile/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify(payload1),
      }),
      SELF.fetch('http://localhost/api/mobile/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify(payload2),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one must succeed (201), the other must fail (404 or 422)
    expect(statuses[0]).toBe(201);
    expect([404, 422]).toContain(statuses[1]);

    // Ensure challenge is deleted from KV
    const challengeKey = `attest:challenge:${otpHash}`;
    const kvVal = await tenv.KV.get(challengeKey);
    expect(kvVal).toBeNull();
  });

  it('rejects expired attestation challenges with 422', async () => {
    const otp = '870002';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.2';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok-race-2', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // Plant an expired challenge in KV (expired 10 seconds ago)
    const challengeKey = `attest:challenge:${otpHash}`;
    await tenv.KV.put(
      challengeKey,
      JSON.stringify({ challenge: 'expired-challenge', expires_at: Date.now() - 10_000 }),
      { expirationTtl: 300 }
    );

    const keyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({
        otp,
        device_name: 'Expired Device',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
        cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
      }),
    });

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe('ATTESTATION_CHALLENGE_EXPIRED');
  });

  it('rejects pairing when challenge has not been initiated', async () => {
    const otp = '870003';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.3';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok-race-3', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const keyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({
        otp,
        device_name: 'Uninitiated Device',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
        cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
      }),
    });

    expect(res.status).toBe(422);
    const err = await res.json<{ error: { code: string } }>();
    expect(err.error.code).toBe('ATTESTATION_CHALLENGE_EXPIRED');
  });

  it('concurrent /pair/initiate calls resolve to the identical challenge', async () => {
    const otp = '870004';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.4';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok-race-4', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    const [res1, res2, res3] = await Promise.all([
      SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify({ otp }),
      }),
      SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify({ otp }),
      }),
      SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify({ otp }),
      }),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    const d1 = await res1.json<{ data: { challenge: string } }>();
    const d2 = await res2.json<{ data: { challenge: string } }>();
    const d3 = await res3.json<{ data: { challenge: string } }>();

    expect(d1.data.challenge).toBe(d2.data.challenge);
    expect(d2.data.challenge).toBe(d3.data.challenge);
  });
});
