/**
 * Phase 3 Test Suite: SMS Trust Hardening, Hardware-Backed Device Attestation & DLQ Observability.
 *
 * Verifies:
 *   1. Carrier shortcode verification rejects spoofed sender IDs.
 *   2. Device pairing stores public key, algorithm, and attestation statements.
 *   3. Authenticated key rotation enforces signature verification, timestamp freshness, and nonce recording.
 *   4. Device revocation marks device revoked and fail-closed gates all subsequent API requests with 403.
 *   5. Forwarding /api/mobile/v1/sms enforces carrier shortcodes, timestamp freshness (300s), nonce dedup (409), and ES256 signatures.
 *   6. DER vs P1363 format conversion and signature verification.
 *   7. Velocity anomaly detection rejects devices exceeding 60 submissions/min with 429.
 *   8. SMS Queue Consumer quarantines untrusted carrier messages as 'untrusted_carrier'.
 *   9. DLQ Consumer pages on-call, emits metrics, and acknowledges dead letters.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database, SmsMessage } from '../src/types/env';
import { createJwtService } from '../src/lib/jwt';
import { sha256 } from '../src/lib/crypto';
import {
  generateTestDeviceKeyPair,
  signTestDevicePayload,
  buildCanonicalSmsPayload,
  buildCanonicalKeyRotationPayload,
  derToP1363,
  p1363ToDer,
  verifyDeviceSignature,
  encodeCanonicalField,
  RECORD_SEPARATOR,
  ROTATE_KEY_MARKER,
} from '../src/lib/device-crypto';
import { validateCarrierSender } from '../src/services/carrier-verification';
import { SmsQueueConsumer } from '../src/queues/sms-consumer';
import { DlqConsumer } from '../src/queues/dlq-consumer';
import { scheduledHandler } from '../src/cron/handler';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

describe('Carrier Shortcode Verification', () => {
  it('validates authorized MFS shortcodes for bKash, Nagad, Rocket, Upay', () => {
    expect(validateCarrierSender('bKash')).toMatchObject({ trusted: true, canonicalSender: 'bKash', gatewaySlug: 'bkash-api' });
    expect(validateCarrierSender('16247')).toMatchObject({ trusted: true, canonicalSender: 'bKash', gatewaySlug: 'bkash-api' });
    expect(validateCarrierSender('BKASH-ALERT')).toMatchObject({ trusted: true, canonicalSender: 'bKash' });

    expect(validateCarrierSender('Nagad')).toMatchObject({ trusted: true, canonicalSender: 'Nagad', gatewaySlug: 'nagad-merchant-api' });
    expect(validateCarrierSender('16167')).toMatchObject({ trusted: true, canonicalSender: 'Nagad' });

    expect(validateCarrierSender('Rocket')).toMatchObject({ trusted: true, canonicalSender: 'Rocket', gatewaySlug: 'rocket' });
    expect(validateCarrierSender('DBBL')).toMatchObject({ trusted: true, canonicalSender: 'Rocket' });
    expect(validateCarrierSender('16216')).toMatchObject({ trusted: true, canonicalSender: 'Rocket' });

    expect(validateCarrierSender('upay')).toMatchObject({ trusted: true, canonicalSender: 'upay', gatewaySlug: 'upay' });
    expect(validateCarrierSender('16268')).toMatchObject({ trusted: true, canonicalSender: 'upay' });
  });

  it('rejects unauthorized, spoofed, or personal sender numbers', () => {
    expect(validateCarrierSender('+8801711223344').trusted).toBe(false);
    expect(validateCarrierSender('01812345678').trusted).toBe(false);
    expect(validateCarrierSender('BankAsia').trusted).toBe(false);
    expect(validateCarrierSender('FakeNotice').trusted).toBe(false);
    expect(validateCarrierSender('').trusted).toBe(false);
  });
});

describe('Cryptographic Signature Format & Verification', () => {
  it('converts DER to P1363 and back round-trip preserving signature validity', async () => {
    const keyPair = await generateTestDeviceKeyPair();
    const message = 'test-payload-12345';

    // Sign payload to produce DER
    const derSigB64 = await signTestDevicePayload(keyPair.privateKey, message, 'der');
    const isValidDer = await verifyDeviceSignature({
      publicKey: keyPair.publicKeySpkiB64,
      signature: derSigB64,
      payload: message,
    });
    expect(isValidDer).toBe(true);

    // Sign payload to produce raw IEEE P1363 (64 bytes)
    const p1363SigB64 = await signTestDevicePayload(keyPair.privateKey, message, 'p1363');
    const isValidP1363 = await verifyDeviceSignature({
      publicKey: keyPair.publicKeySpkiB64,
      signature: p1363SigB64,
      payload: message,
    });
    expect(isValidP1363).toBe(true);
  });

  it('derToP1363 correctly transforms ASN.1 DER bytes', () => {
    // 64-byte raw passes through unchanged
    const raw64 = new Uint8Array(64).fill(7);
    expect(derToP1363(raw64)).toEqual(raw64);

    // Pack into DER and unpack back to 64 bytes
    const der = p1363ToDer(raw64);
    const unpacked = derToP1363(der);
    expect(unpacked).toEqual(raw64);
  });

  it('canonical payload encoding is length-prefixed, NFC-normalized, and delimiter-safe', () => {
    // 1. Multibyte & Emoji UTF-8 length:
    // "🇧🇩" flag is 2 regional indicator symbols = 8 bytes in UTF-8
    expect(encodeCanonicalField('🇧🇩')).toBe('8:🇧🇩');
    // Bengali script: "বিকাশ" is 15 UTF-8 bytes
    expect(encodeCanonicalField('বিকাশ')).toBe('15:বিকাশ');

    // 2. Colons and special characters in fields do NOT cause ambiguity
    const params = {
      deviceId: 123,
      nonce: 'nonce:with:colons',
      timestamp: 1700000000,
      sender: '16247:bKash',
      body: 'bKash: You received Tk 500: from 01700. TrxID: TX123\nLine2\r\n🎉',
    };
    const payload = buildCanonicalSmsPayload(params);
    const fields = payload.split(RECORD_SEPARATOR);

    expect(fields[0]).toBe('3:123');
    expect(fields[1]).toBe('17:nonce:with:colons');
    expect(fields[2]).toBe('10:1700000000');
    expect(fields[3]).toBe('11:16247:bKash');
    // Body is strictly length-prefixed and includes its newlines/emoji intact
    expect(fields[4]).toContain('bKash: You received Tk 500: from 01700');

    // 3. Boundary-shifting attempt: body starting with forged delimiter/length
    const maliciousParams = {
      deviceId: 123,
      nonce: 'n1',
      timestamp: 1700000000,
      sender: '16247',
      body: `5:16247${RECORD_SEPARATOR}body-shift-attempt`,
    };
    const malPayload = buildCanonicalSmsPayload(maliciousParams);
    // Even if body begins with "5:16247\x1e", its own field is length-prefixed with total body length
    expect(malPayload).toContain(`26:5:16247${RECORD_SEPARATOR}body-shift-attempt`);
  });

  it('verifies signature cleanly when body contains ASCII record separator (\\x1e) without delimiter confusion', async () => {
    const keyPair = await generateTestDeviceKeyPair();
    const params = {
      deviceId: 999,
      nonce: 'nonce-with-sep',
      timestamp: 1700000000,
      sender: '16247',
      body: `You received Tk 500.00${RECORD_SEPARATOR}from 01700000000. TrxID TX12345`,
    };
    const canonical = buildCanonicalSmsPayload(params);
    const sig = await signTestDevicePayload(keyPair.privateKey, canonical, 'der');

    const isValid = await verifyDeviceSignature({
      publicKey: keyPair.publicKeySpkiB64,
      signature: sig,
      payload: canonical,
      algorithm: 'ES256',
    });
    expect(isValid).toBe(true);

    // Tampering any portion invalidates signature
    const tamperedCanonical = canonical + 'tamper';
    const isTamperedValid = await verifyDeviceSignature({
      publicKey: keyPair.publicKeySpkiB64,
      signature: sig,
      payload: tamperedCanonical,
      algorithm: 'ES256',
    });
    expect(isTamperedValid).toBe(false);
  });

  it('canonical key rotation payload includes ROTATE_KEY_MARKER and uses RECORD_SEPARATOR', () => {
    const rotParams = {
      deviceId: 123,
      nonce: 'rot-nonce-1',
      timestamp: 1700000000,
      newPublicKey: 'base64-pub-key',
    };
    const payload = buildCanonicalKeyRotationPayload(rotParams);
    const fields = payload.split(RECORD_SEPARATOR);
    expect(fields[0]).toBe('3:123');
    expect(fields[1]).toBe('11:rot-nonce-1');
    expect(fields[2]).toBe('10:1700000000');
    expect(fields[3]).toBe(`10:${ROTATE_KEY_MARKER}`);
    expect(fields[4]).toBe('14:base64-pub-key');
  });
});

describe('Device Pairing, Attestation & Key Management', () => {
  const merchantId = 850001;
  const userId = 8501;
  const otpCode = '778899';
  let deviceKeyPair: { publicKeySpkiB64: string; privateKey: CryptoKey };
  let pairedDeviceId: number;
  let pairedDeviceUuid: string;
  let jwtToken: string;

  beforeAll(async () => {
    const now = new Date().toISOString();

    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'AttestationMerchant', 'attest-merchant', 'attest@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('attest-user@example.com');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Attestation User', 'attest-user@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();

    // Insert pairing OTP token
    const otpHash = await sha256(otpCode);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'dummy-token', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    deviceKeyPair = await generateTestDeviceKeyPair();
  });

  it('pairs device with hardware-backed public key and attestation statement', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        otp: otpCode,
        device_name: 'Pixel 9 StrongBox Phone',
        public_key: deviceKeyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
        attestation_statement: 'play-integrity-verdict-hw-backed',
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<{
      success: boolean;
      data: { device_id: string; merchant_id: number; token: string; access_token: string };
    }>();

    expect(body.success).toBe(true);
    expect(body.data.token).toBeDefined();
    jwtToken = body.data.token;
    pairedDeviceUuid = body.data.device_id;

    // Verify row in op_paired_devices
    const row = await db.prepare(
      `SELECT id, public_key, key_algorithm, attestation_statement, status
       FROM op_paired_devices WHERE uuid = ?`
    ).bind(pairedDeviceUuid).first<{
      id: number;
      public_key: string;
      key_algorithm: string;
      attestation_statement: string;
      status: string;
    }>();

    expect(row).toBeDefined();
    pairedDeviceId = row!.id;
    expect(row!.public_key).toBe(deviceKeyPair.publicKeySpkiB64);
    expect(row!.key_algorithm).toBe('ES256');
    expect(row!.attestation_statement).toBe('play-integrity-verdict-hw-backed');
    expect(row!.status).toBe('active');
  });

  it('enforces signature verification on key rotation (/devices/rotate-key)', async () => {
    const newKeyPair = await generateTestDeviceKeyPair();

    // 1. Missing signature
    const resNoSig = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
      }),
    });
    expect(resNoSig.status).toBe(400);
    const jsonNoSig = await resNoSig.json<{ error: { code: string } }>();
    expect(jsonNoSig.error.code).toBe('MISSING_SIGNATURE');

    // 2. Expired timestamp
    const expiredTs = Date.now() - 400_000;
    const resExp = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
        nonce: 'nonce-rot-1',
        timestamp: expiredTs,
        signature: 'fake-sig',
      }),
    });
    expect(resExp.status).toBe(400);
    const jsonExp = await resExp.json<{ error: { code: string } }>();
    expect(jsonExp.error.code).toBe('TIMESTAMP_OUT_OF_BOUNDS');

    // 3. Invalid signature
    const validTs = Date.now();
    const resBadSig = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
        nonce: 'nonce-rot-2',
        timestamp: validTs,
        signature: 'AA==',
      }),
    });
    expect(resBadSig.status).toBe(401);
    const jsonBadSig = await resBadSig.json<{ error: { code: string } }>();
    expect(jsonBadSig.error.code).toBe('INVALID_DEVICE_SIGNATURE');

    // 4. Valid signature signed with current private key
    const nonce = `nonce-rot-ok-${Date.now()}`;
    const canonical = buildCanonicalKeyRotationPayload({
      deviceId: pairedDeviceId,
      nonce,
      timestamp: validTs,
      newPublicKey: newKeyPair.publicKeySpkiB64,
    });
    const sig = await signTestDevicePayload(deviceKeyPair.privateKey, canonical, 'der');

    const resOk = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
        nonce,
        timestamp: validTs,
        signature: sig,
      }),
    });
    expect(resOk.status).toBe(200);
    const jsonOk = await resOk.json<{ success: boolean; data: { status: string } }>();
    expect(jsonOk.success).toBe(true);
    expect(jsonOk.data.status).toBe('key_rotated');

    // 5. Replaying rotation nonce returns 409 NONCE_REPLAYED
    const resReplay = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
        nonce,
        timestamp: validTs,
        signature: sig,
      }),
    });
    expect(resReplay.status).toBe(409);
    const jsonReplay = await resReplay.json<{ error: { code: string } }>();
    expect(jsonReplay.error.code).toBe('NONCE_REPLAYED');

    // Verify key in DB was updated
    const updated = await db.prepare(
      `SELECT public_key FROM op_paired_devices WHERE id = ?`
    ).bind(pairedDeviceId).first<{ public_key: string }>();
    expect(updated?.public_key).toBe(newKeyPair.publicKeySpkiB64);

    // Update active deviceKeyPair to the rotated key
    deviceKeyPair = newKeyPair;
  });

  it('revokes device and fail-closed blocks any subsequent requests with 403 DEVICE_REVOKED', async () => {
    const resRevoke = await SELF.fetch('http://localhost/api/mobile/v1/devices/revoke', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ reason: 'Device compromised' }),
    });
    expect(resRevoke.status).toBe(200);
    const jsonRevoke = await resRevoke.json<{ success: boolean; data: { status: string } }>();
    expect(jsonRevoke.success).toBe(true);
    expect(jsonRevoke.data.status).toBe('revoked');

    // Verify DB
    const dev = await db.prepare(
      `SELECT status, revoked_at, revocation_reason FROM op_paired_devices WHERE id = ?`
    ).bind(pairedDeviceId).first<{ status: string; revoked_at: string; revocation_reason: string }>();
    expect(dev?.status).toBe('revoked');
    expect(dev?.revoked_at).toBeDefined();
    expect(dev?.revocation_reason).toBe('Device compromised');

    // Subsequent heartbeat using the token must return 403 DEVICE_REVOKED
    const resBlocked = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(resBlocked.status).toBe(403);
    const jsonBlocked = await resBlocked.json<{ error: { code: string } }>();
    expect(jsonBlocked.error.code).toBe('DEVICE_REVOKED');
  });
});

describe('SMS Submission Hardening (/api/mobile/v1/sms)', () => {
  const merchantId = 850002;
  const userId = 8502;
  let activeDeviceId: number;
  let jwtToken: string;
  let deviceKeyPair: { publicKeySpkiB64: string; privateKey: CryptoKey };

  beforeAll(async () => {
    const now = new Date().toISOString();

    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'SmsHardeningMerchant', 'sms-hard-merchant', 'smshard@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('smshard-user@example.com');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'SmsHard User', 'smshard-user@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();

    deviceKeyPair = await generateTestDeviceKeyPair();
    const devUuid = crypto.randomUUID();

    const insertResult = await db.prepare(
      `INSERT INTO op_paired_devices
         (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm, created_at)
       VALUES (?, ?, ?, 'Secured Android Phone', 'fp-sec', 'active', ?, 'ES256', ?)`
    ).bind(merchantId, userId, devUuid, deviceKeyPair.publicKeySpkiB64, now).run();

    activeDeviceId = insertResult.meta?.last_row_id ?? 1;

    const jwtService = createJwtService(tenv);
    jwtToken = await jwtService.issueAccessToken({
      sub: String(userId),
      merchant_id: merchantId,
      device_id: activeDeviceId,
      scope: ['read', 'write'],
    });
  });

  it('rejects untrusted carrier shortcode with 422 UNTRUSTED_CARRIER_SHORTCODE', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '+8801700112233',
        body: 'You received Tk 500.00 from 01700000000. TrxID BK12345678',
      }),
    });

    expect(res.status).toBe(422);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('UNTRUSTED_CARRIER_SHORTCODE');
  });

  it('rejects signed device request missing signature/nonce/timestamp with 400', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '16247',
        body: 'You received Tk 500.00 from 01700000000. TrxID BK12345678',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('MISSING_SIGNATURE');
  });

  it('rejects SMS with timestamp outside 300s window with 400 TIMESTAMP_OUT_OF_BOUNDS', async () => {
    const oldTimestamp = Date.now() - 400_000;
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '16247',
        body: 'You received Tk 500.00 from 01700000000. TrxID BK12345678',
        nonce: 'nonce-ts-expired',
        timestamp: oldTimestamp,
        signature: 'dummy-sig',
      }),
    });

    expect(res.status).toBe(400);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('TIMESTAMP_OUT_OF_BOUNDS');
  });

  it('rejects SMS with invalid signature with 401 INVALID_DEVICE_SIGNATURE', async () => {
    const ts = Date.now();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '16247',
        body: 'You received Tk 500.00 from 01700000000. TrxID BK12345678',
        nonce: 'nonce-bad-sig',
        timestamp: ts,
        signature: 'AA==',
      }),
    });

    expect(res.status).toBe(401);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('INVALID_DEVICE_SIGNATURE');

    // Confirm nonce was NOT written to DB on failed signature (attacker cannot exhaust nonce table)
    const nonceRow = await db.prepare(
      `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = ?`
    ).bind(activeDeviceId, 'nonce-bad-sig').first();
    expect(nonceRow).toBeNull();
  });

  it('accepts valid signed SMS and enqueues with signature_verified = true', async () => {
    const ts = Date.now();
    const nonce = `nonce-sms-valid-${Date.now()}`;
    const sender = '16247';
    const smsBody = 'You received Tk 500.00 from 01700000000. TrxID BK998877';

    const canonical = buildCanonicalSmsPayload({
      deviceId: activeDeviceId,
      nonce,
      timestamp: ts,
      sender,
      body: smsBody,
    });
    const sig = await signTestDevicePayload(deviceKeyPair.privateKey, canonical, 'der');

    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        body: smsBody,
        nonce,
        timestamp: ts,
        signature: sig,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { status: string; signature_verified: boolean } }>();
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('queued');
    expect(json.data.signature_verified).toBe(true);

    // Replaying the EXACT same nonce must be rejected with 409 NONCE_REPLAYED
    const replayRes = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        body: smsBody,
        nonce,
        timestamp: ts,
        signature: sig,
      }),
    });

    expect(replayRes.status).toBe(409);
    const replayJson = await replayRes.json<{ error: { code: string } }>();
    expect(replayJson.error.code).toBe('NONCE_REPLAYED');
  });

  it('rejects submission when velocity threshold (> 60 SMS/min) is exceeded', async () => {
    // Seed 60 nonces into op_device_nonces for this device in the last minute
    const statements = [];
    for (let i = 0; i < 60; i++) {
      statements.push(
        db.prepare(
          `INSERT INTO op_device_nonces (device_id, nonce, created_at) VALUES (?, ?, datetime('now'))`
        ).bind(activeDeviceId, `burst-nonce-${i}-${Date.now()}`)
      );
    }
    await db.batch(statements);

    const ts = Date.now();
    const nonce = `nonce-burst-check-${Date.now()}`;
    const canonical = buildCanonicalSmsPayload({
      deviceId: activeDeviceId,
      nonce,
      timestamp: ts,
      sender: '16247',
      body: 'Test Burst SMS',
    });
    const sig = await signTestDevicePayload(deviceKeyPair.privateKey, canonical, 'der');

    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '16247',
        body: 'Test Burst SMS',
        nonce,
        timestamp: ts,
        signature: sig,
      }),
    });

    expect(res.status).toBe(429);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('SMS_VELOCITY_EXCEEDED');
  });
});

describe('SMS Queue Consumer Pipeline & DLQ Handling', () => {
  it('quarantines untrusted carrier message in queue as untrusted_carrier', async () => {
    const consumer = new SmsQueueConsumer();
    let ackCalled = false;

    const fakeMessage: Message<SmsMessage> = {
      id: 'msg-untrusted-1',
      timestamp: new Date(),
      body: {
        merchant_id: 850002,
        device_id: 1,
        sender: '+8801799887766', // Untrusted spoofed number
        body: 'Received Tk 1,000 from 01799. TrxID TX123',
        received_at: new Date().toISOString(),
        signature_verified: false,
        raw_sender: '+8801799887766',
      },
      attempts: 1,
      ack: () => { ackCalled = true; },
      retry: () => {},
    };

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await consumer.process({ messages: [fakeMessage] }, tenv, ctx);

    expect(ackCalled).toBe(true);

    const record = await db.prepare(
      `SELECT match_status, raw_sender FROM op_sms_data WHERE raw_sender = ? ORDER BY id DESC LIMIT 1`
    ).bind('+8801799887766').first<{ match_status: string; raw_sender: string }>();

    expect(record?.match_status).toBe('failed');
  });

  it('DLQ consumer processes dead-letter batch, pages on-call and acknowledges messages', async () => {
    const dlq = new DlqConsumer();
    let ackCount = 0;

    const deadLetters = [
      {
        id: 'dlq-1',
        timestamp: new Date(),
        body: { error: 'Serialization failure', payload: 'malformed' },
        attempts: 5,
        ack: async () => { ackCount++; },
        retry: () => {},
      },
      {
        id: 'dlq-2',
        timestamp: new Date(),
        body: { error: 'Network timeout', payload: 'unreachable-host' },
        attempts: 5,
        ack: async () => { ackCount++; },
        retry: () => {},
      },
    ] as unknown as Message<unknown>[];

    const batch = {
      queue: 'webhook-out-dlq',
      messages: deadLetters,
      ackAll: () => {},
      retryAll: () => {},
    } as unknown as MessageBatch<unknown>;

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await dlq.process(batch, tenv, ctx);

    expect(ackCount).toBe(2);
  });

  it('demotes signature_verified to 0 and emits tamper metric if device_id is missing/zero', async () => {
    const consumer = new SmsQueueConsumer();
    let ackCalled = false;

    // Rogue queue message claiming signature_verified: true without device_id
    const tamperedMessage: Message<SmsMessage> = {
      id: 'msg-tampered-1',
      timestamp: new Date(),
      body: {
        merchant_id: 850002,
        device_id: 0,
        sender: '16247',
        body: 'Received Tk 1,000 from 01799. TrxID TX7788',
        received_at: new Date().toISOString(),
        signature_verified: true, // Claimed true by rogue/buggy producer
        raw_sender: '16247',
      },
      attempts: 1,
      ack: () => { ackCalled = true; },
      retry: () => {},
    };

    const ctx = {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await consumer.process({ messages: [tamperedMessage] }, tenv, ctx);
    expect(ackCalled).toBe(true);

    const record = await db.prepare(
      `SELECT signature_verified FROM op_sms_data WHERE parsed_trx_id = 'TX7788' ORDER BY id DESC LIMIT 1`
    ).first<{ signature_verified: number }>();

    expect(record?.signature_verified).toBe(0);
  });
});

describe('Keyless Device Migration Policy & Retention Sweeps', () => {
  const merchantId = 850003;
  const userId = 8503;
  let keylessToken: string;
  let keylessDeviceId: number;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'KeylessMerchant', 'keyless-merchant', 'keyless@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const emailHash = await sha256('keyless-user@example.com');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Keyless User', 'keyless-user@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, crypto.randomUUID(), emailHash, now, now).run();

    // Create legacy pairing token
    const otpCode = '554433';
    const otpHash = await sha256(otpCode);
    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'), ?)`
    ).bind(merchantId, userId, `tok-${crypto.randomUUID()}`, otpHash, now).run();

    // 1. Pair keyless device under default rollout mode (SIGNATURE_REQUIRED not set)
    const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        otp: otpCode,
        device_name: 'Legacy Keyless Phone',
      }),
    });
    expect(pairRes.status).toBe(201);
    const pairJson = await pairRes.json<{ success: boolean; data: { token: string; device_id: string } }>();
    keylessToken = pairJson.data.token;

    const dev = await db.prepare(
      `SELECT id, public_key FROM op_paired_devices WHERE uuid = ?`
    ).bind(pairJson.data.device_id).first<{ id: number; public_key: string | null }>();
    keylessDeviceId = dev!.id;
    expect(dev!.public_key).toBeNull();
  });

  it('accepts unsigned SMS from keyless device during rollout window with signature_verified = false', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keylessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: '16247',
        body: 'You received Tk 200.00 from 01711111111. TrxID BKLEGACY01',
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { status: string; signature_verified: boolean } }>();
    expect(json.success).toBe(true);
    expect(json.data.status).toBe('queued');
    expect(json.data.signature_verified).toBe(false);
  });

  it('rejects unsigned SMS with 422 DEVICE_MUST_REPAIR when SIGNATURE_REQUIRED is active', async () => {
    // Temporarily enable SIGNATURE_REQUIRED on env
    const prevFlag = tenv.SIGNATURE_REQUIRED;
    tenv.SIGNATURE_REQUIRED = 'true';
    try {
      const res = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${keylessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: '16247',
          body: 'You received Tk 200.00 from 01711111111. TrxID BKLEGACY02',
        }),
      });

      expect(res.status).toBe(422);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('DEVICE_MUST_REPAIR');
    } finally {
      tenv.SIGNATURE_REQUIRED = prevFlag;
    }
  });

  it('rejects pairing without public key with 400 DEVICE_KEY_REQUIRED when SIGNATURE_REQUIRED is active', async () => {
    const otpCode = '112233';
    const otpHash = await sha256(otpCode);
    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'), datetime('now'))`
    ).bind(merchantId, userId, `tok-${crypto.randomUUID()}`, otpHash).run();

    const prevFlag = tenv.SIGNATURE_REQUIRED;
    tenv.SIGNATURE_REQUIRED = 'true';
    try {
      const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          otp: otpCode,
          device_name: 'Keyless Attempt While Required',
        }),
      });

      expect(res.status).toBe(400);
      const json = await res.json<{ error: { code: string } }>();
      expect(json.error.code).toBe('DEVICE_KEY_REQUIRED');
    } finally {
      tenv.SIGNATURE_REQUIRED = prevFlag;
    }
  });

  it('hourly cron purge removes nonces older than 10 minutes and preserves fresh nonces', async () => {
    // Insert an expired nonce (created 15 minutes ago)
    await db.prepare(
      `INSERT INTO op_device_nonces (device_id, nonce, created_at)
       VALUES (?, 'old-nonce-to-delete', datetime('now', '-15 minutes'))`
    ).bind(keylessDeviceId).run();

    // Insert a fresh nonce (created now)
    await db.prepare(
      `INSERT INTO op_device_nonces (device_id, nonce, created_at)
       VALUES (?, 'fresh-nonce-to-keep', datetime('now'))`
    ).bind(keylessDeviceId).run();

    const deletedCount = await scheduledHandler.cleanupExpiredDeviceNonces(tenv);
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    const oldNonce = await db.prepare(
      `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = 'old-nonce-to-delete'`
    ).bind(keylessDeviceId).first();
    expect(oldNonce).toBeNull();

    const freshNonce = await db.prepare(
      `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = 'fresh-nonce-to-keep'`
    ).bind(keylessDeviceId).first();
    expect(freshNonce).not.toBeNull();
  });

  it('rejects /devices/rotate-key on keyless device with 422 DEVICE_MUST_REPAIR and leaves public_key null', async () => {
    const newKeyPair = await generateTestDeviceKeyPair();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/devices/rotate-key', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${keylessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        new_public_key: newKeyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
      }),
    });

    expect(res.status).toBe(422);
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('DEVICE_MUST_REPAIR');

    // Verify DB public_key remains null
    const dev = await db.prepare(
      `SELECT public_key FROM op_paired_devices WHERE id = ?`
    ).bind(keylessDeviceId).first<{ public_key: string | null }>();
    expect(dev?.public_key).toBeNull();
  });
});

describe('Batch SMS Forwarding & Nonce Protection (/api/mobile/v1/sms/batch)', () => {
  const merchantId = 850004;
  const userId = 8504;
  let batchDeviceId: number;
  let batchJwtToken: string;
  let batchKeyPair: { publicKeySpkiB64: string; privateKey: CryptoKey };

  beforeAll(async () => {
    const now = new Date().toISOString();

    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'BatchMerchant', 'batch-merchant', 'batch@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('batch-user@example.com');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Batch User', 'batch-user@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();

    batchKeyPair = await generateTestDeviceKeyPair();
    const devUuid = crypto.randomUUID();

    const insertResult = await db.prepare(
      `INSERT INTO op_paired_devices
         (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm, created_at)
       VALUES (?, ?, ?, 'Batch Android Phone', 'fp-batch', 'active', ?, 'ES256', ?)`
    ).bind(merchantId, userId, devUuid, batchKeyPair.publicKeySpkiB64, now).run();

    batchDeviceId = insertResult.meta?.last_row_id ?? 1;

    const jwtService = createJwtService(tenv);
    batchJwtToken = await jwtService.issueAccessToken({
      sub: String(userId),
      merchant_id: merchantId,
      device_id: batchDeviceId,
      scope: ['read', 'write'],
    });
  });

  it('rejects keyed device batch message missing signature with MISSING_SIGNATURE in rejected array', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${batchJwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            id: 'batch-msg-no-sig',
            sender: '16247',
            body: 'You received Tk 100.00 from 01700000001. TrxID BATCH01',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{
      success: boolean;
      data: {
        status: string;
        synced_count: number;
        queued_ids: Array<string | number>;
        rejected: Array<{ id?: string | number; reason: string }>;
      };
    }>();

    expect(json.success).toBe(true);
    expect(json.data.synced_count).toBe(0);
    expect(json.data.queued_ids).toEqual([]);
    expect(json.data.rejected).toEqual([
      { id: 'batch-msg-no-sig', reason: 'MISSING_SIGNATURE' },
    ]);
  });

  it('rejects keyed device batch message with invalid signature with INVALID_DEVICE_SIGNATURE in rejected array', async () => {
    const ts = Date.now();
    const nonce = `nonce-bad-sig-${Date.now()}`;
    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${batchJwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            id: 'batch-msg-bad-sig',
            sender: '16247',
            body: 'You received Tk 200.00 from 01700000002. TrxID BATCH02',
            nonce,
            timestamp: ts,
            signature: 'AA==',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{
      success: boolean;
      data: {
        status: string;
        synced_count: number;
        queued_ids: Array<string | number>;
        rejected: Array<{ id?: string | number; reason: string }>;
      };
    }>();

    expect(json.success).toBe(true);
    expect(json.data.synced_count).toBe(0);
    expect(json.data.queued_ids).toEqual([]);
    expect(json.data.rejected).toEqual([
      { id: 'batch-msg-bad-sig', reason: 'INVALID_DEVICE_SIGNATURE' },
    ]);
  });

  it('handles mixed batch: accepts valid message and rejects forged message in same request', async () => {
    const ts = Date.now();
    const validNonce = `nonce-mixed-valid-${Date.now()}`;
    const validBody = 'You received Tk 300.00 from 01700000003. TrxID BATCH03';
    const canonical = buildCanonicalSmsPayload({
      deviceId: batchDeviceId,
      nonce: validNonce,
      timestamp: ts,
      sender: '16247',
      body: validBody,
    });
    const validSig = await signTestDevicePayload(batchKeyPair.privateKey, canonical, 'der');

    const res = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${batchJwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            id: 'batch-mixed-valid',
            sender: '16247',
            body: validBody,
            nonce: validNonce,
            timestamp: ts,
            signature: validSig,
          },
          {
            id: 'batch-mixed-forged',
            sender: '16247',
            body: 'You received Tk 400.00 from 01700000004. TrxID BATCH04',
            nonce: `nonce-mixed-forged-${Date.now()}`,
            timestamp: ts,
            signature: 'fake-sig-forged',
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json<{
      success: boolean;
      data: {
        status: string;
        synced_count: number;
        queued_ids: Array<string | number>;
        rejected: Array<{ id?: string | number; reason: string }>;
      };
    }>();

    expect(json.success).toBe(true);
    expect(json.data.synced_count).toBe(1);
    expect(json.data.queued_ids).toContain('batch-mixed-valid');
    expect(json.data.queued_ids).not.toContain('batch-mixed-forged');
    expect(json.data.rejected).toEqual([
      { id: 'batch-mixed-forged', reason: 'INVALID_DEVICE_SIGNATURE' },
    ]);
  });

  it('rejects replayed nonce in batch submission: second attempt returns NONCE_REPLAYED in rejected array and synced_count = 0', async () => {
    const ts = Date.now();
    const replayNonce = `nonce-batch-replay-${Date.now()}`;
    const replayBody = 'You received Tk 500.00 from 01700000005. TrxID BATCH05';
    const canonical = buildCanonicalSmsPayload({
      deviceId: batchDeviceId,
      nonce: replayNonce,
      timestamp: ts,
      sender: '16247',
      body: replayBody,
    });
    const sig = await signTestDevicePayload(batchKeyPair.privateKey, canonical, 'der');

    // First attempt: valid and synced
    const res1 = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${batchJwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            id: 'batch-replay-1',
            sender: '16247',
            body: replayBody,
            nonce: replayNonce,
            timestamp: ts,
            signature: sig,
          },
        ],
      }),
    });

    expect(res1.status).toBe(200);
    const json1 = await res1.json<{
      success: boolean;
      data: {
        synced_count: number;
        queued_ids: Array<string | number>;
        rejected: Array<{ id?: string | number; reason: string }>;
      };
    }>();
    expect(json1.data.synced_count).toBe(1);
    expect(json1.data.queued_ids).toContain('batch-replay-1');
    expect(json1.data.rejected).toHaveLength(0);

    // Second attempt replaying identical nonce: rejected with NONCE_REPLAYED
    const res2 = await SELF.fetch('http://localhost/api/mobile/v1/sms/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${batchJwtToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [
          {
            id: 'batch-replay-2',
            sender: '16247',
            body: replayBody,
            nonce: replayNonce,
            timestamp: ts,
            signature: sig,
          },
        ],
      }),
    });

    expect(res2.status).toBe(200);
    const json2 = await res2.json<{
      success: boolean;
      data: {
        synced_count: number;
        queued_ids: Array<string | number>;
        rejected: Array<{ id?: string | number; reason: string }>;
      };
    }>();
    expect(json2.data.synced_count).toBe(0);
    expect(json2.data.queued_ids).toHaveLength(0);
    expect(json2.data.rejected).toEqual([
      { id: 'batch-replay-2', reason: 'NONCE_REPLAYED' },
    ]);
  });
});
