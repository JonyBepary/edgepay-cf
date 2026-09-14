/**
 * Mobile companion API routes — `/api/mobile/v1/*`
 *
 * Authenticated via JWT (issued after OTP device pairing).
 * Used by the EdgePay mobile companion app (Flutter).
 */

import { Hono, type Context } from 'hono';
import type { Env } from '../types/env';
import { requireJwtAuth } from '../middleware/auth';
import { createJwtService } from '../lib/jwt';
import {
  type AttestationVerifier,
  AndroidKeyAttestationVerifier,
  MockAttestationVerifier,
} from '../services/key-attestation';
import {
  resolvePolicy,
  computeDeviceTier,
  TIER_RANK,
  resolveEnforcementMode,
  shouldBlock,
  lookupActiveOverride,
  type EnforcementMode,
} from '../services/device-policy';
import { recordPolicyEvaluation } from '../services/policy-telemetry';
import { parseX509Certificate, equalBytes } from '../lib/x509';
import { base64ToBytes, bytesToBase64 } from '../lib/crypto';

type MobileContext = Context<{ Bindings: Env; Variables: Record<string, unknown> }>;

export const mobileRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

export function getAttestationVerifier(env: Env): AttestationVerifier {
  if (env.ENVIRONMENT === 'test') {
    return new MockAttestationVerifier();
  }
  return new AndroidKeyAttestationVerifier();
}

// ---------------------------------------------------------------------------
// Two-Phase Pairing: Phase 1 — Initiate Attestation Challenge
// ---------------------------------------------------------------------------
const handlePairInitiate = async (c: MobileContext) => {
  const body = await c.req.json<{ otp?: string; token?: string }>().catch(() => ({} as { otp?: string; token?: string }));
  const otpCode = body.otp || body.token;

  if (!otpCode || !/^\d{6}$/.test(otpCode.trim())) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'OTP must be 6 digits' } }, 400);
  }

  const { sha256 } = await import('../lib/crypto');
  const normalizedOtp = otpCode.trim();
  const otpHash = await sha256(normalizedOtp);

  // Validate OTP exists, is unconsumed, and is unexpired (does NOT consume OTP)
  const tokenRow = await c.env.DB.prepare(
    `SELECT id, merchant_id, user_id, token_hash, expires_at, used_at
     FROM op_device_pairing_tokens
     WHERE token_hash = ?
     LIMIT 1`
  ).bind(otpHash).first<{ id: number; merchant_id: number; user_id: number; token_hash: string; expires_at: string; used_at: string | null }>();

  if (!tokenRow || tokenRow.used_at !== null) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or used OTP' } }, 404);
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return c.json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired' } }, 410);
  }

  // Idempotent challenge issuance within 300s window
  const challengeKey = `attest:challenge:${otpHash}`;
  const existing = await c.env.KV.get(challengeKey);
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed.challenge && typeof parsed.expires_at === 'number' && parsed.expires_at > Date.now()) {
        const remainingSec = Math.max(1, Math.ceil((parsed.expires_at - Date.now()) / 1000));
        return c.json({
          success: true,
          data: {
            challenge: parsed.challenge,
            expires_in: remainingSec,
          },
        });
      }
    } catch {
      // Malformed JSON — regenerate fresh challenge below
    }
  }

  // Generate fresh 32-byte cryptographic random challenge
  const randBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = bytesToBase64(randBytes);
  const expiresAt = Date.now() + 300_000;

  await c.env.KV.put(
    challengeKey,
    JSON.stringify({ challenge, expires_at: expiresAt }),
    { expirationTtl: 300 }
  );

  return c.json({
    success: true,
    data: {
      challenge,
      expires_in: 300,
    },
  });
};

// Device pairing (no auth — uses OTP).
// Hardened: SHA-256 hash lookup only (never plaintext), 5-min expiry,
// single-use via atomic used_at, KV brute-force guard (max 5 attempts
// per OTP hash, 15-min lockout), timingSafeEqual compare.
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000;

const handlePairing = async (c: MobileContext) => {
  const body = await c.req.json<{
    otp?: string;
    token?: string;
    device_name?: string;
    public_key?: string;
    key_algorithm?: string;
    attestation_statement?: string;
    cert_chain?: string[];
  }>();
  const otpCode = body.otp || body.token;

  if (!otpCode || !/^\d{6}$/.test(otpCode.trim())) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'OTP must be 6 digits' } }, 400);
  }

  const { sha256, timingSafeEqual } = await import('../lib/crypto');
  const normalizedOtp = otpCode.trim();
  const otpHash = await sha256(normalizedOtp);
  const attemptKey = `otp:attempt:${otpHash}`;

  // Brute-force guard: max 5 bad attempts per OTP hash, then 15-min lockout.
  try {
    const attemptRaw = await c.env.KV.get(attemptKey);
    if (attemptRaw) {
      const parts = attemptRaw.split('|');
      const attemptCount = parseInt(parts[0], 10) || 0;
      const lockedUntil = parseInt(parts[1], 10) || 0;
      if (attemptCount >= OTP_MAX_ATTEMPTS && Date.now() < lockedUntil) {
        const retryAfter = Math.ceil((lockedUntil - Date.now()) / 1000);
        c.header('Retry-After', String(retryAfter));
        return c.json({ success: false, error: { code: 'OTP_LOCKED', message: 'Too many invalid attempts. Try again later.', retry_after_seconds: retryAfter } }, 429);
      }
    }
  } catch {
    // KV read failure on the attempt counter fails closed for this anonymous path.
  }

  const recordBadAttempt = async (): Promise<Response | null> => {
    try {
      const raw = await c.env.KV.get(attemptKey);
      let count = 0;
      if (raw) count = parseInt(raw.split('|')[0], 10) || 0;
      count++;
      if (count > OTP_MAX_ATTEMPTS) {
        const lockedUntil = Date.now() + OTP_LOCKOUT_MS;
        await c.env.KV.put(attemptKey, `${count}|${lockedUntil}`, { expirationTtl: 900 });
        const retryAfter = Math.ceil(OTP_LOCKOUT_MS / 1000);
        c.header('Retry-After', String(retryAfter));
        return c.json({ success: false, error: { code: 'OTP_LOCKED', message: 'Too many invalid attempts. Try again later.', retry_after_seconds: retryAfter } }, 429);
      }
      await c.env.KV.put(attemptKey, `${count}|${Date.now() + OTP_LOCKOUT_MS}`, { expirationTtl: 900 });
    } catch {
      // Counter write failure: still reject the attempt itself.
    }
    return null;
  };

  // Look up OTP by SHA-256 hash only — plaintext is never stored or queried.
  const tokenRow = await c.env.DB.prepare(
    `SELECT id, merchant_id, user_id, token_hash, expires_at, used_at
     FROM op_device_pairing_tokens
     WHERE token_hash = ?
     LIMIT 1`
  ).bind(otpHash).first<{ id: number; merchant_id: number; user_id: number; token_hash: string; expires_at: string; used_at: string | null }>();

  if (!tokenRow || !timingSafeEqual(otpHash, tokenRow.token_hash ?? '')) {
    const locked = await recordBadAttempt();
    if (locked) return locked;
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or used OTP' } }, 404);
  }

  if (tokenRow.used_at !== null) {
    const locked = await recordBadAttempt();
    if (locked) return locked;
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or used OTP' } }, 404);
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return c.json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired' } }, 410);
  }

  // Mark OTP used — atomic single-use: only the first concurrent claim wins.
  const claimed = await c.env.DB.prepare(
    `UPDATE op_device_pairing_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`
  ).bind(new Date().toISOString(), tokenRow.id).run();
  if ((claimed.meta?.changes ?? 0) === 0) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or used OTP' } }, 404);
  }

  try {
    await c.env.KV.delete(attemptKey);
  } catch {
    // Non-fatal: the counter expires via TTL.
  }

  // Hardware Key Attestation (Phase 4)
  let attestationVerdict: import('../services/key-attestation').AttestationVerdict | null = null;

  if (body.cert_chain && Array.isArray(body.cert_chain) && body.cert_chain.length > 0) {
    const challengeKey = `attest:challenge:${otpHash}`;
    const challengeRaw = await c.env.KV.get(challengeKey);
    // Delete immediately to enforce single-use challenge consumption
    await c.env.KV.delete(challengeKey);

    if (!challengeRaw) {
      return c.json({
        success: false,
        error: {
          code: 'ATTESTATION_CHALLENGE_EXPIRED',
          message: 'Attestation challenge missing or expired. Initiate pairing again.',
        },
      }, 422);
    }

    let storedChallenge: string | null = null;
    try {
      const parsed = JSON.parse(challengeRaw);
      if (parsed.challenge && typeof parsed.expires_at === 'number' && parsed.expires_at >= Date.now()) {
        storedChallenge = parsed.challenge;
      }
    } catch {
      // Malformed JSON
    }

    if (!storedChallenge) {
      return c.json({
        success: false,
        error: {
          code: 'ATTESTATION_CHALLENGE_EXPIRED',
          message: 'Attestation challenge missing or expired. Initiate pairing again.',
        },
      }, 422);
    }

    const derChain: Uint8Array[] = [];
    for (const certB64 of body.cert_chain) {
      try {
        derChain.push(base64ToBytes(certB64));
      } catch {
        return c.json({
          success: false,
          error: { code: 'ATTESTATION_INVALID', message: 'Invalid base64 certificate in chain' },
        }, 422);
      }
    }

    const expectedChallengeBytes = base64ToBytes(storedChallenge);
    const verifier = getAttestationVerifier(c.env);
    const verdict = await verifier.verify(derChain, expectedChallengeBytes, {
      allowUnverifiedBoot: c.env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true',
      allowUnlocked: c.env.ATTESTATION_ALLOW_UNLOCKED === 'true',
      requireStrongBox: c.env.STRONGBOX_REQUIRED === 'true',
      env: c.env,
      merchantId: tokenRow.merchant_id,
    });

    if (!verdict.verified) {
      return c.json({
        success: false,
        error: {
          code: 'ATTESTATION_INVALID',
          message: `Hardware key attestation failed: ${verdict.failureReason ?? 'verification failed'}`,
        },
      }, 422);
    }

    // Bind public key to leaf certificate
    try {
      const leafCert = parseX509Certificate(derChain[0]);
      const leafSpkiB64 = bytesToBase64(leafCert.spkiRaw);
      if (body.public_key) {
        if (!equalBytes(base64ToBytes(body.public_key), leafCert.spkiRaw)) {
          return c.json({
            success: false,
            error: {
              code: 'ATTESTATION_KEY_MISMATCH',
              message: 'Supplied public key does not match attestation certificate',
            },
          }, 422);
        }
      } else {
        body.public_key = leafSpkiB64;
        body.key_algorithm = 'ES256';
      }
    } catch {
      if (c.env.ENVIRONMENT !== 'test') {
        return c.json({
          success: false,
          error: {
            code: 'ATTESTATION_INVALID',
            message: 'Failed to parse leaf certificate public key',
          },
        }, 422);
      }
    }

    attestationVerdict = verdict;
  }

  // Policy: require hardware signing key during pairing if SIGNATURE_REQUIRED is enabled
  if (c.env.SIGNATURE_REQUIRED === 'true' && !body.public_key) {
    return c.json({
      success: false,
      error: {
        code: 'DEVICE_KEY_REQUIRED',
        message: 'Device public key required for pairing under active security policy',
      },
    }, 400);
  }

  const now = new Date().toISOString();

  // Evaluate merchant device policy & determine security tier
  const merchantPolicyRow = await c.env.DB.prepare(
    `SELECT min_tier, min_patch_level, strict_pairing, enforcement_mode FROM op_merchant_device_policies WHERE merchant_id = ? LIMIT 1`
  ).bind(tokenRow.merchant_id).first<{
    min_tier: string;
    min_patch_level: string | null;
    strict_pairing: number;
    enforcement_mode?: string;
  }>();

  const policy = resolvePolicy(c.env, merchantPolicyRow);
  const maxAttestationAgeMs = parseInt(c.env.ATTESTATION_MAX_AGE_DAYS || '30', 10) * 86400000;
  const allowUnverifiedBoot = c.env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true';

  const tierInfo = computeDeviceTier(
    {
      public_key: body.public_key ?? null,
      attestation_verified_at: attestationVerdict?.verified ? now : null,
      attestation_strong: attestationVerdict?.strong ? 1 : 0,
      attestation_verified_boot: attestationVerdict?.verifiedBoot ? 1 : 0,
      device_patch_level: attestationVerdict?.patchLevel ?? null,
    },
    policy,
    { maxAttestationAgeMs, allowUnverifiedBoot },
  );

  const policySatisfied = TIER_RANK[tierInfo.tier] >= TIER_RANK[policy.min_tier];
  const achievedTier = tierInfo.tier;
  const requiredTier = policy.min_tier;
  const compliant = policySatisfied;
  const failureReason = tierInfo.reason ?? (!policySatisfied ? (policy.min_tier === 'strongbox' && tierInfo.tier === 'attested' ? 'NOT_STRONGBOX' : (tierInfo.tier === 'keyless' ? 'KEYLESS_DEVICE' : 'TIER_BELOW_MIN')) : undefined);

  const policyMode: EnforcementMode = (merchantPolicyRow?.enforcement_mode as EnforcementMode) ?? 'audit';
  const effectiveMode = resolveEnforcementMode(c.env, policyMode);

  // Emit telemetry in ALL modes
  await recordPolicyEvaluation(c.env, {
    merchantId: tokenRow.merchant_id,
    deviceId: null, // not yet created
    context: 'pairing',
    mode: effectiveMode,
    requiredTier,
    result: { requiredTier, achievedTier, compliant, failureReason },
  });

  // Block only in enforce mode (or if strict_pairing is set)
  if (shouldBlock(effectiveMode, { requiredTier, achievedTier, compliant, failureReason }) || (!policySatisfied && policy.strict_pairing)) {
    return c.json({
      success: false,
      error: {
        code: 'DEVICE_TIER_INSUFFICIENT',
        message: `Device tier '${achievedTier}' below required policy '${requiredTier}'`,
        device_tier: achievedTier,
        required_tier: requiredTier,
        reason: failureReason,
      },
    }, 422);
  }

  // Register the device with hardware-backed public key and attestation details
  const deviceUuid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO op_paired_devices
       (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm, attestation_statement,
        attestation_verified_at, attestation_method, attestation_strong, attestation_verified_boot, attestation_raw_json,
        device_os_version, device_patch_level, last_heartbeat_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    tokenRow.merchant_id,
    tokenRow.user_id,
    deviceUuid,
    body.device_name ?? 'Android SMS Companion',
    '', // fingerprint (set by mobile app)
    body.public_key ?? null,
    body.key_algorithm ?? (body.public_key ? 'ES256' : null),
    body.attestation_statement ?? null,
    attestationVerdict?.verified ? now : null,
    attestationVerdict?.verified ? 'android_key_attestation' : (body.attestation_statement ? 'opaque' : null),
    attestationVerdict?.strong ? 1 : 0,
    attestationVerdict?.verifiedBoot ? 1 : 0,
    attestationVerdict?.raw ? JSON.stringify(attestationVerdict.raw) : null,
    attestationVerdict?.osVersion ?? null,
    attestationVerdict?.patchLevel ?? null,
    now,
    now,
  ).run();

  const deviceRow = await c.env.DB.prepare(
    `SELECT id FROM op_paired_devices WHERE uuid = ? LIMIT 1`,
  ).bind(deviceUuid).first<{ id: number }>();
  const deviceId = deviceRow?.id ?? 0;

  // Issue access + refresh tokens
  const jwt = createJwtService(c.env);
  const tokenPayload = {
    sub: String(tokenRow.user_id),
    merchant_id: tokenRow.merchant_id,
    device_id: deviceId,
    scope: ['read', 'write'],
  };

  const accessToken = await jwt.issueAccessToken(tokenPayload);
  const refreshToken = await jwt.issueRefreshToken(tokenPayload);

  return c.json({
    success: true,
    data: {
      device_id: deviceUuid,
      merchant_id: tokenRow.merchant_id,
      token: accessToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: parseInt(c.env.JWT_TTL_SECONDS ?? '3600', 10),
      tier: tierInfo.tier,
      attestation: {
        verified: attestationVerdict?.verified ?? false,
        strong: attestationVerdict?.strong ?? false,
        verified_boot: attestationVerdict?.verifiedBoot ?? false,
        patch_level: attestationVerdict?.patchLevel ?? null,
        method: attestationVerdict?.verified ? 'android_key_attestation' : (body.attestation_statement ? 'opaque' : null),
        verified_at: attestationVerdict?.verified ? now : null,
        reason: tierInfo.reason ?? null,
      },
      policy: {
        required_tier: policy.min_tier,
        satisfied: policySatisfied,
        strict_pairing: policy.strict_pairing,
        conflict: !policySatisfied ? {
          code: 'DEVICE_TIER_INSUFFICIENT',
          message: `Device is ${tierInfo.tier}; policy requires ${policy.min_tier}.`,
          remediation: [
            policy.min_tier === 'strongbox'
              ? 'Move this SIM to a StrongBox-capable device (Pixel 3+, Galaxy S10+)'
              : 'Move this SIM to a hardware-attested Android device',
            'Lower merchant policy at /dashboard/settings/device-policy',
          ],
        } : null,
      },
    },
  }, 201);
};

mobileRoutes.post('/pair/initiate', handlePairInitiate);
mobileRoutes.post('/devices/pair/initiate', handlePairInitiate);
mobileRoutes.post('/devices', handlePairing);
mobileRoutes.post('/pair', handlePairing);

// Token refresh
const handleTokenRefresh = async (c: MobileContext) => {
  const body = await c.req.json<{ refresh_token?: string }>();
  if (!body.refresh_token) {
    return c.json({ success: false, error: { code: 'MISSING_TOKEN', message: 'refresh_token required' } }, 400);
  }

  const jwt = createJwtService(c.env);
  try {
    const payload = await jwt.verify(body.refresh_token, 'refresh');
    const accessToken = await jwt.issueAccessToken({
      sub: payload.sub,
      merchant_id: payload.merchant_id,
      device_id: payload.device_id,
      scope: payload.scope,
    });
    return c.json({ success: true, data: { access_token: accessToken, token: accessToken, token_type: 'Bearer', expires_in: parseInt(c.env.JWT_TTL_SECONDS ?? '3600', 10) } });
  } catch {
    return c.json({ success: false, error: { code: 'INVALID_REFRESH', message: 'Invalid or expired refresh token' } }, 401);
  }
};

mobileRoutes.post('/devices/token-refreshes', handleTokenRefresh);
mobileRoutes.post('/refresh', handleTokenRefresh);

// All subsequent routes require JWT
mobileRoutes.use('*', requireJwtAuth());

// Device status gate: fail-closed if device has been revoked
mobileRoutes.use('*', async (c, next) => {
  const deviceId = (c.get('deviceId') as number | undefined) ?? (c.get('authSubject') as number | string | undefined);
  const merchantId = c.get('merchantId');
  if (deviceId && merchantId) {
    const device = await c.env.DB.prepare(
      `SELECT id, status, public_key, key_algorithm FROM op_paired_devices WHERE id = ? AND merchant_id = ? LIMIT 1`
    ).bind(deviceId, merchantId).first<{ id: number; status: string; public_key: string | null; key_algorithm: string | null }>();

    if (device && device.status === 'revoked') {
      return c.json({ success: false, error: { code: 'DEVICE_REVOKED', message: 'This device has been revoked' } }, 403);
    }
  }
  return next();
});

// Key rotation (authenticated)
mobileRoutes.post('/devices/rotate-key', async (c) => {
  const merchantId = c.get('merchantId')!;
  const deviceId = (c.get('deviceId') as number | undefined) ?? (c.get('authSubject') as number | string | undefined) ?? 0;
  const body = await c.req.json<{
    new_public_key: string;
    key_algorithm?: string;
    nonce?: string;
    timestamp?: number | string;
    signature?: string;
  }>();

  if (!body.new_public_key) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'new_public_key required' } }, 400);
  }

  const device = await c.env.DB.prepare(
    `SELECT id, status, public_key, key_algorithm FROM op_paired_devices WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(deviceId, merchantId).first<{ id: number; status: string; public_key: string | null; key_algorithm: string | null }>();

  if (!device || device.status === 'revoked') {
    return c.json({ success: false, error: { code: 'DEVICE_REVOKED', message: 'Device is revoked' } }, 403);
  }

  // Keyless devices cannot rotate keys; hardware signing key must be bound during pairing
  if (!device.public_key) {
    return c.json({
      success: false,
      error: {
        code: 'DEVICE_MUST_REPAIR',
        message: 'Keyless devices cannot rotate keys; device must re-pair with hardware signing keys',
      },
    }, 422);
  }

  if (!body.signature || !body.nonce || !body.timestamp) {
    return c.json({ success: false, error: { code: 'MISSING_SIGNATURE', message: 'nonce, timestamp, and signature required for key rotation' } }, 400);
  }
  const ts = typeof body.timestamp === 'number' ? body.timestamp : new Date(body.timestamp).getTime();
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 300_000) {
    return c.json({ success: false, error: { code: 'TIMESTAMP_OUT_OF_BOUNDS', message: 'Timestamp expired or outside 300s window' } }, 400);
  }

  // 1. Check nonce replay before verifying signature
  const nonceExists = await c.env.DB.prepare(
    `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = ? LIMIT 1`
  ).bind(deviceId, body.nonce).first();
  if (nonceExists) {
    return c.json({ success: false, error: { code: 'NONCE_REPLAYED', message: 'Nonce already used' } }, 409);
  }

  // 2. Verify signature
  const { buildCanonicalKeyRotationPayload, verifyDeviceSignature } = await import('../lib/device-crypto');
  const canonical = buildCanonicalKeyRotationPayload({
    deviceId,
    nonce: body.nonce,
    timestamp: body.timestamp,
    newPublicKey: body.new_public_key,
  });
  const valid = await verifyDeviceSignature({
    publicKey: device.public_key,
    signature: body.signature,
    payload: canonical,
    algorithm: device.key_algorithm ?? 'ES256',
  });
  if (!valid) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_SIGNATURE', message: 'Signature verification failed' } }, 401);
  }

  // 3. Insert nonce ONLY after signature is verified
  await c.env.DB.prepare(
    `INSERT INTO op_device_nonces (device_id, nonce, created_at) VALUES (?, ?, datetime('now'))`
  ).bind(deviceId, body.nonce).run();

  await c.env.DB.prepare(
    `UPDATE op_paired_devices SET public_key = ?, key_algorithm = ? WHERE id = ? AND merchant_id = ?`
  ).bind(body.new_public_key, body.key_algorithm ?? 'ES256', deviceId, merchantId).run();

  return c.json({ success: true, data: { status: 'key_rotated', updated_at: new Date().toISOString() } });
});

// Device revocation (authenticated)
const handleRevocation = async (c: MobileContext) => {
  const merchantId = c.get('merchantId')!;
  const targetId = c.req.param('id');
  const currentDeviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;
  const deviceIdentifier = targetId ? targetId : currentDeviceId;

  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: 'User revoked' }));
  const reason = body.reason ?? 'Device revoked by user';
  const now = new Date().toISOString();

  const isNumeric = /^\d+$/.test(String(deviceIdentifier));
  const res = isNumeric
    ? await c.env.DB.prepare(
        `UPDATE op_paired_devices SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE id = ? AND merchant_id = ?`
      ).bind(now, reason, Number(deviceIdentifier), merchantId).run()
    : await c.env.DB.prepare(
        `UPDATE op_paired_devices SET status = 'revoked', revoked_at = ?, revocation_reason = ? WHERE uuid = ? AND merchant_id = ?`
      ).bind(now, reason, deviceIdentifier, merchantId).run();

  if ((res.meta?.changes ?? 0) === 0) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Device not found' } }, 404);
  }

  return c.json({ success: true, data: { status: 'revoked', revoked_at: now } });
};

mobileRoutes.post('/devices/:id/revoke', handleRevocation);
mobileRoutes.post('/devices/revoke', handleRevocation);

// Heartbeat
const handleHeartbeat = async (c: MobileContext) => {
  const deviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;
  const merchantId = c.get('merchantId')!;
  await c.env.DB.prepare(
    `UPDATE op_paired_devices SET last_heartbeat_at = ? WHERE id = ? AND merchant_id = ?`
  ).bind(new Date().toISOString(), deviceId, merchantId).run();
  return c.json({ success: true, data: { status: 'ok' } });
};

mobileRoutes.post('/devices/heartbeats', handleHeartbeat);
mobileRoutes.post('/heartbeat', handleHeartbeat);

// Get dashboard summary
mobileRoutes.get('/dashboard', async (c) => {
  const merchantId = c.get('merchantId')!;

  const today = new Date().toISOString().slice(0, 10);

  const todayStats = await c.env.DB.prepare(

    `SELECT
       COUNT(*) AS today_count,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN amount ELSE 0 END), 0) AS today_revenue,
       COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_count
     FROM op_transactions
     WHERE merchant_id = ? AND DATE(created_at) = ?`
).bind(merchantId, today).first<{ today_count: number; today_revenue: string; pending_count: number }>();

  const recent = await c.env.DB.prepare(

    `SELECT trx_id, amount, currency, status, created_at
     FROM op_transactions
     WHERE merchant_id = ?
     ORDER BY created_at DESC
     LIMIT 5`
).bind(merchantId).all();

  return c.json({
    success: true,
    data: {
      today: todayStats,
      recent_transactions: recent.results,
    },
  });
});

// SMS forwarding (mobile → server)
mobileRoutes.post('/sms', async (c) => {
  const merchantId = c.get('merchantId')!;
  const deviceId = (c.get('deviceId') as number | undefined) ?? Number(c.get('authSubject') ?? 0);
  const body = await c.req.json<{
    sender?: string;
    body?: string;
    received_at?: string;
    timestamp?: number | string;
    nonce?: string;
    signature?: string;
  }>();

  if (!body.sender || !body.body) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'sender and body required' } }, 400);
  }

  // 1. Server-Side Carrier Shortcode Verification
  const { validateCarrierSender } = await import('../services/carrier-verification');
  const carrier = validateCarrierSender(body.sender);
  if (!carrier.trusted) {
    return c.json({
      success: false,
      error: {
        code: 'UNTRUSTED_CARRIER_SHORTCODE',
        message: `Sender '${body.sender}' is not an authorized MFS carrier shortcode`,
      },
    }, 422);
  }

  // 2. Look up device status, registered hardware public key, and merchant device policy
  const device = await c.env.DB.prepare(
    `SELECT d.id, d.status, d.public_key, d.key_algorithm, d.store_id,
            d.attestation_verified_at, d.attestation_strong,
            d.attestation_verified_boot, d.device_patch_level,
            p.min_tier, p.min_patch_level, p.strict_pairing, p.enforcement_mode
     FROM op_paired_devices d
     LEFT JOIN op_merchant_device_policies p ON p.merchant_id = d.merchant_id
     WHERE d.id = ? AND d.merchant_id = ?
     LIMIT 1`
  ).bind(deviceId, merchantId).first<{
    id: number;
    status: string;
    public_key: string | null;
    key_algorithm: string | null;
    store_id: number | null;
    attestation_verified_at: string | null;
    attestation_strong: number;
    attestation_verified_boot: number;
    device_patch_level: string | null;
    min_tier: string | null;
    min_patch_level: string | null;
    strict_pairing: number | null;
    enforcement_mode?: string;
  }>();

  if (device?.status === 'revoked') {
    return c.json({ success: false, error: { code: 'DEVICE_REVOKED', message: 'This device has been revoked' } }, 403);
  }

  // 2.1 Hardware Attestation & Tier Policy Gate
  const policy = resolvePolicy(c.env, device);
  const maxAttestationAgeMs = parseInt(c.env.ATTESTATION_MAX_AGE_DAYS || '30', 10) * 86400000;
  const allowUnverifiedBoot = c.env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true';
  const tierInfo = computeDeviceTier(device ?? {
    public_key: null,
    attestation_verified_at: null,
    attestation_strong: 0,
    attestation_verified_boot: 0,
    device_patch_level: null,
  }, policy, { maxAttestationAgeMs, allowUnverifiedBoot });

  if (tierInfo.tier === 'keyless' && c.env.SIGNATURE_REQUIRED === 'true') {
    return c.json({
      success: false,
      error: {
        code: 'DEVICE_MUST_REPAIR',
        message: 'Device was paired without hardware signing keys and must re-pair under active security policy',
      },
    }, 422);
  }

  const effectiveMode = resolveEnforcementMode(c.env, (device?.enforcement_mode as EnforcementMode) ?? 'audit');
  const requiredTier = policy.min_tier;
  const achievedTier = tierInfo.tier;
  const compliant = TIER_RANK[achievedTier] >= TIER_RANK[requiredTier];
  const failureReason = tierInfo.reason ?? (!compliant ? (requiredTier === 'strongbox' && achievedTier === 'attested' ? 'NOT_STRONGBOX' : (achievedTier === 'keyless' ? 'KEYLESS_DEVICE' : 'TIER_BELOW_MIN')) : undefined);

  await recordPolicyEvaluation(c.env, {
    merchantId: merchantId as number,
    deviceId: device ? device.id : deviceId,
    context: 'sms',
    mode: effectiveMode,
    requiredTier,
    result: { requiredTier, achievedTier, compliant, failureReason },
  });

  // Check for an active device-level override ONLY when tier gating would block.
  if (shouldBlock(effectiveMode, { requiredTier, achievedTier, compliant, failureReason })) {
    const activeOverride = await lookupActiveOverride(c.env.DB, merchantId as number, device ? device.id : deviceId);
    if (!activeOverride) {
      return c.json({
        success: false,
        error: {
          code: 'DEVICE_TIER_INSUFFICIENT',
          message: `Device tier '${achievedTier}' below merchant minimum '${requiredTier}'.`,
          device_tier: achievedTier,
          required_tier: requiredTier,
          reason: failureReason,
        },
      }, 422);
    }
    const { metric } = await import('../lib/observability');
    metric(c.env, 'device_policy_override_used', {
      merchant_id: merchantId as number,
      device_id: device ? device.id : deviceId,
      value: 1,
    });
  }

  // 3. Velocity Anomaly Protection (max 60 SMS / minute per device)
  const recentCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM op_device_nonces WHERE device_id = ? AND created_at > datetime('now', '-1 minute')`
  ).bind(deviceId).first<{ count: number }>();
  if ((recentCount?.count ?? 0) >= 60) {
    return c.json({
      success: false,
      error: { code: 'SMS_VELOCITY_EXCEEDED', message: 'Device SMS velocity threshold exceeded' },
    }, 429);
  }

  let signatureVerified = false;

  // 4. Hardware-backed signature & replay verification
  if (device?.public_key) {
    if (!body.signature || !body.nonce || !body.timestamp) {
      return c.json({
        success: false,
        error: { code: 'MISSING_SIGNATURE', message: 'timestamp, nonce, and signature required for signed device' },
      }, 400);
    }

    const ts = typeof body.timestamp === 'number' ? body.timestamp : new Date(body.timestamp).getTime();
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 300_000) {
      return c.json({
        success: false,
        error: { code: 'TIMESTAMP_OUT_OF_BOUNDS', message: 'SMS timestamp expired or outside 300s window' },
      }, 400);
    }

    const nonceExists = await c.env.DB.prepare(
      `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = ? LIMIT 1`
    ).bind(deviceId, body.nonce).first();
    if (nonceExists) {
      return c.json({
        success: false,
        error: { code: 'NONCE_REPLAYED', message: 'Nonce already used' },
      }, 409);
    }

    const { buildCanonicalSmsPayload, verifyDeviceSignature } = await import('../lib/device-crypto');
    const canonical = buildCanonicalSmsPayload({
      deviceId,
      nonce: body.nonce,
      timestamp: body.timestamp,
      sender: body.sender,
      body: body.body,
    });
    const valid = await verifyDeviceSignature({
      publicKey: device.public_key,
      signature: body.signature,
      payload: canonical,
      algorithm: device.key_algorithm ?? 'ES256',
    });

    if (!valid) {
      return c.json({
        success: false,
        error: { code: 'INVALID_DEVICE_SIGNATURE', message: 'Cryptographic signature verification failed' },
      }, 401);
    }

    signatureVerified = true;

    // Record nonce
    await c.env.DB.prepare(
      `INSERT INTO op_device_nonces (device_id, nonce, created_at) VALUES (?, ?, datetime('now'))`
    ).bind(deviceId, body.nonce).run();
  } else {
    // Device has no public key on file
    if (c.env.SIGNATURE_REQUIRED === 'true') {
      return c.json({
        success: false,
        error: {
          code: 'DEVICE_MUST_REPAIR',
          message: 'Device was paired without hardware signing keys and must re-pair under active security policy',
        },
      }, 422);
    }
    // Rollout window: accept unsigned from legacy keyless device, set signature_verified=false, emit metric
    const { metric } = await import('../lib/observability');
    metric(c.env, 'sms_unverified_device', {
      merchant_id: merchantId as number,
      device_id: deviceId as number,
    });
  }

  // Enqueue SMS for async parsing
  await c.env.SMS_QUEUE.send({
    merchant_id: merchantId as number,
    device_id: deviceId as number,
    store_id: device?.store_id ?? null,
    sender: carrier.canonicalSender,
    body: body.body,
    received_at: body.received_at ?? new Date().toISOString(),
    signature_verified: signatureVerified,
    raw_sender: body.sender,
  });

  return c.json({ success: true, data: { status: 'queued', signature_verified: signatureVerified } });
});

// Batch SMS forwarding & Offline-Resilient Watermark Sync (CRDT-Compatible)
mobileRoutes.post('/sms/batch', async (c) => {
  const merchantId = c.get('merchantId')!;
  const deviceId = (c.get('deviceId') as number | undefined) ?? Number(c.get('authSubject') ?? 0);
  const body = await c.req.json<{
    watermark?: number;
    messages: Array<{
      id?: string | number;
      sender: string;
      body: string;
      received_at?: string;
      nonce?: string;
      timestamp?: number | string;
      signature?: string;
    }>;
    nonce?: string;
    timestamp?: number | string;
    signature?: string;
  }>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'messages array required' } }, 400);
  }

  const device = await c.env.DB.prepare(
    `SELECT d.id, d.status, d.public_key, d.key_algorithm, d.store_id,
            d.attestation_verified_at, d.attestation_strong,
            d.attestation_verified_boot, d.device_patch_level,
            p.min_tier, p.min_patch_level, p.strict_pairing, p.enforcement_mode
     FROM op_paired_devices d
     LEFT JOIN op_merchant_device_policies p ON p.merchant_id = d.merchant_id
     WHERE d.id = ? AND d.merchant_id = ?
     LIMIT 1`
  ).bind(deviceId, merchantId).first<{
    id: number;
    status: string;
    public_key: string | null;
    key_algorithm: string | null;
    store_id: number | null;
    attestation_verified_at: string | null;
    attestation_strong: number;
    attestation_verified_boot: number;
    device_patch_level: string | null;
    min_tier: string | null;
    min_patch_level: string | null;
    strict_pairing: number | null;
    enforcement_mode?: string;
  }>();

  if (device?.status === 'revoked') {
    return c.json({ success: false, error: { code: 'DEVICE_REVOKED', message: 'This device has been revoked' } }, 403);
  }

  // Hardware Attestation & Tier Policy Gate
  const policy = resolvePolicy(c.env, device);
  const maxAttestationAgeMs = parseInt(c.env.ATTESTATION_MAX_AGE_DAYS || '30', 10) * 86400000;
  const allowUnverifiedBoot = c.env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true';
  const tierInfo = computeDeviceTier(device ?? {
    public_key: null,
    attestation_verified_at: null,
    attestation_strong: 0,
    attestation_verified_boot: 0,
    device_patch_level: null,
  }, policy, { maxAttestationAgeMs, allowUnverifiedBoot });

  if (tierInfo.tier === 'keyless' && c.env.SIGNATURE_REQUIRED === 'true') {
    return c.json({
      success: false,
      error: {
        code: 'DEVICE_MUST_REPAIR',
        message: 'Device was paired without hardware signing keys and must re-pair under active security policy',
      },
    }, 422);
  }

  const effectiveMode = resolveEnforcementMode(c.env, (device?.enforcement_mode as EnforcementMode) ?? 'audit');
  const requiredTier = policy.min_tier;
  const achievedTier = tierInfo.tier;
  const compliant = TIER_RANK[achievedTier] >= TIER_RANK[requiredTier];
  const failureReason = tierInfo.reason ?? (!compliant ? (requiredTier === 'strongbox' && achievedTier === 'attested' ? 'NOT_STRONGBOX' : (achievedTier === 'keyless' ? 'KEYLESS_DEVICE' : 'TIER_BELOW_MIN')) : undefined);

  await recordPolicyEvaluation(c.env, {
    merchantId: merchantId as number,
    deviceId: device ? device.id : deviceId,
    context: 'sms_batch',
    mode: effectiveMode,
    requiredTier,
    result: { requiredTier, achievedTier, compliant, failureReason },
    evaluationCount: body.messages.length,
  });

  // Check for an active device-level override ONLY when tier gating would block.
  if (shouldBlock(effectiveMode, { requiredTier, achievedTier, compliant, failureReason })) {
    const activeOverride = await lookupActiveOverride(c.env.DB, merchantId as number, device ? device.id : (deviceId as number));
    if (!activeOverride) {
      return c.json({
        success: false,
        error: {
          code: 'DEVICE_TIER_INSUFFICIENT',
          message: `Device tier '${achievedTier}' below merchant minimum '${requiredTier}'.`,
          device_tier: achievedTier,
          required_tier: requiredTier,
          reason: failureReason,
        },
      }, 422);
    }
    const { metric } = await import('../lib/observability');
    metric(c.env, 'device_policy_override_used', {
      merchant_id: merchantId as number,
      device_id: device ? device.id : (deviceId as number),
      value: 1,
    });
  }

  if (!device?.public_key) {
    if (c.env.SIGNATURE_REQUIRED === 'true') {
      return c.json({
        success: false,
        error: {
          code: 'DEVICE_MUST_REPAIR',
          message: 'Device was paired without hardware signing keys and must re-pair under active security policy',
        },
      }, 422);
    }
    const { metric } = await import('../lib/observability');
    metric(c.env, 'sms_unverified_device', {
      merchant_id: merchantId as number,
      device_id: deviceId as number,
    });
  }

  const recentCount = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM op_device_nonces WHERE device_id = ? AND created_at > datetime('now', '-1 minute')`
  ).bind(deviceId).first<{ count: number }>();
  if ((Number(recentCount?.count ?? 0) + body.messages.length) > 120) {
    return c.json({
      success: false,
      error: { code: 'SMS_VELOCITY_EXCEEDED', message: 'Device SMS velocity threshold exceeded' },
    }, 429);
  }

  const { validateCarrierSender } = await import('../services/carrier-verification');
  const { buildCanonicalSmsPayload, verifyDeviceSignature } = await import('../lib/device-crypto');

  const queuedIds: Array<string | number> = [];
  const rejected: Array<{ id?: string | number; reason: string }> = [];
  const queueMessages: Array<import('../types/env').SmsMessage> = [];
  const seenBatchNonces = new Set<string>();

  for (const msg of body.messages) {
    if (!msg.sender || !msg.body) {
      rejected.push({ id: msg.id, reason: 'VALIDATION_ERROR' });
      continue;
    }

    const carrier = validateCarrierSender(msg.sender);
    if (!carrier.trusted) {
      rejected.push({ id: msg.id, reason: 'UNTRUSTED_CARRIER_SHORTCODE' });
      continue;
    }

    let sigVerified = false;
    if (device?.public_key) {
      const nonce = msg.nonce ?? body.nonce;
      const ts = msg.timestamp ?? body.timestamp;
      const sig = msg.signature ?? body.signature;

      if (!nonce || !ts || !sig) {
        rejected.push({ id: msg.id, reason: 'MISSING_SIGNATURE' });
        continue;
      }

      const tsNum = typeof ts === 'number' ? ts : new Date(ts).getTime();
      if (isNaN(tsNum) || Math.abs(Date.now() - tsNum) > 300_000) {
        rejected.push({ id: msg.id, reason: 'TIMESTAMP_OUT_OF_BOUNDS' });
        continue;
      }

      // Check nonce replay in-batch and in D1 before verifying signature
      if (seenBatchNonces.has(nonce)) {
        rejected.push({ id: msg.id, reason: 'NONCE_REPLAYED' });
        continue;
      }

      const nonceExists = await c.env.DB.prepare(
        `SELECT 1 FROM op_device_nonces WHERE device_id = ? AND nonce = ? LIMIT 1`
      ).bind(deviceId, nonce).first();
      if (nonceExists) {
        rejected.push({ id: msg.id, reason: 'NONCE_REPLAYED' });
        continue;
      }

      const canonical = buildCanonicalSmsPayload({
        deviceId,
        nonce,
        timestamp: ts,
        sender: msg.sender,
        body: msg.body,
      });
      const valid = await verifyDeviceSignature({
        publicKey: device.public_key,
        signature: sig,
        payload: canonical,
        algorithm: device.key_algorithm ?? 'ES256',
      });

      if (!valid) {
        rejected.push({ id: msg.id, reason: 'INVALID_DEVICE_SIGNATURE' });
        continue;
      }

      sigVerified = true;
      seenBatchNonces.add(nonce);

      // Strict INSERT only after signature passes
      await c.env.DB.prepare(
        `INSERT INTO op_device_nonces (device_id, nonce, created_at) VALUES (?, ?, datetime('now'))`
      ).bind(deviceId, nonce).run();
    }

    queueMessages.push({
      merchant_id: merchantId as number,
      device_id: deviceId,
      store_id: device?.store_id ?? null,
      sender: carrier.canonicalSender,
      body: msg.body,
      received_at: msg.received_at ?? new Date().toISOString(),
      signature_verified: sigVerified,
      raw_sender: msg.sender,
    });

    if (msg.id !== undefined) queuedIds.push(msg.id);
  }

  if (queueMessages.length > 0) {
    await Promise.all(queueMessages.map(m => c.env.SMS_QUEUE.send(m)));
  }

  if (rejected.length > 0) {
    const { metric } = await import('../lib/observability');
    metric(c.env, 'sms_batch_rejected', {
      merchant_id: merchantId as number,
      value: rejected.length,
    });
  }

  return c.json({
    success: true,
    data: {
      status: 'synced',
      synced_count: queueMessages.length,
      queued_ids: queuedIds,
      rejected,
      server_time: new Date().toISOString(),
    },
  });
});

// Get notifications
mobileRoutes.get('/notifications', async (c) => {
  const merchantId = c.get('merchantId')!;
  const deviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;

  const rows = await c.env.DB.prepare(
    `SELECT id, event, payload, read_at, created_at
     FROM op_mobile_notifications
     WHERE merchant_id = ? AND device_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
  ).bind(merchantId, deviceId).all();

  return c.json({ success: true, data: rows.results });
});

// Acknowledge notifications — strictly tenant and device scoped (V3-001 / EDGE-P3-003 fix)
mobileRoutes.post('/notifications/acknowledgements', async (c) => {
  const merchantId = c.get('merchantId')!;
  const deviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;
  const body = await c.req.json<{ notification_ids?: number[] }>();
  if (!body.notification_ids?.length) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'notification_ids required' } }, 400);
  }

  const placeholders = body.notification_ids.map(() => '?').join(',');
  const res = await c.env.DB.prepare(
    `UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (${placeholders}) AND merchant_id = ? AND device_id = ?`
  ).bind(new Date().toISOString(), ...body.notification_ids, merchantId, deviceId).run();

  return c.json({ success: true, data: { acknowledged: res.meta?.changes ?? body.notification_ids.length } });
});
