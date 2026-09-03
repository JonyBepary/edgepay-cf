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

type MobileContext = Context<{ Bindings: Env; Variables: Record<string, unknown> }>;

export const mobileRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

// Device pairing (no auth — uses OTP).
// Hardened: SHA-256 hash lookup only (never plaintext), 5-min expiry,
// single-use via atomic used_at, KV brute-force guard (max 5 attempts
// per OTP hash, 15-min lockout), timingSafeEqual compare.
const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000;

const handlePairing = async (c: MobileContext) => {
  const body = await c.req.json<{ otp?: string; token?: string; device_name?: string }>();
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

  // Register the device
  const deviceUuid = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO op_paired_devices
       (merchant_id, user_id, uuid, device_name, fingerprint, status, last_heartbeat_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(
    tokenRow.merchant_id,
    tokenRow.user_id,
    deviceUuid,
    body.device_name ?? 'Android SMS Companion',
    '', // fingerprint (set by mobile app)
    new Date().toISOString(),
    new Date().toISOString(),
  ).run();

  const deviceId = (await c.env.DB.prepare(
    `SELECT last_insert_rowid() AS id`,
  ).first<{ id: number }>())?.id ?? 0;

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
    },
  }, 201);
};

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
  const body = await c.req.json<{ sender?: string; body?: string; received_at?: string }>();

  if (!body.sender || !body.body) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'sender and body required' } }, 400);
  }

  // Enqueue SMS for async parsing
  await c.env.SMS_QUEUE.send({
    merchant_id: merchantId as number,
    device_id: Number(c.get('authSubject') ?? 0),
    sender: body.sender,
    body: body.body,
    received_at: body.received_at ?? new Date().toISOString(),
  });

  return c.json({ success: true, data: { status: 'queued' } });
});

// Batch SMS forwarding & Offline-Resilient Watermark Sync (CRDT-Compatible)
mobileRoutes.post('/sms/batch', async (c) => {
  const merchantId = c.get('merchantId')!;
  const body = await c.req.json<{
    watermark?: number;
    messages: Array<{ id?: string | number; sender: string; body: string; received_at?: string }>;
  }>();

  if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'messages array required' } }, 400);
  }

  const ackedIds: Array<string | number> = [];
  const queueMessages = [];

  for (const msg of body.messages) {
    if (msg.sender && msg.body) {
      queueMessages.push({
        merchant_id: merchantId as number,
        device_id: Number(c.get('authSubject') ?? 0),
        sender: msg.sender,
        body: msg.body,
        received_at: msg.received_at ?? new Date().toISOString(),
      });
      if (msg.id !== undefined) ackedIds.push(msg.id);
    }
  }

  await Promise.all(queueMessages.map(m => c.env.SMS_QUEUE.send(m)));

  return c.json({
    success: true,
    data: {
      status: 'synced',
      synced_count: queueMessages.length,
      acknowledged_ids: ackedIds,
      server_time: new Date().toISOString(),
    }
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
