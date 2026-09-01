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

// Device pairing (no auth — uses OTP)
const handlePairing = async (c: MobileContext) => {
  const body = await c.req.json<{ otp?: string; token?: string; device_name?: string }>();
  const otpCode = body.otp || body.token;

  if (!otpCode || !/^\d{6}$/.test(otpCode.trim())) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'OTP must be 6 digits' } }, 400);
  }

  // Look up OTP in pairing tokens table
  const tokenRow = await c.env.DB.prepare(
    `SELECT id, merchant_id, user_id, expires_at, used_at
     FROM op_device_pairing_tokens
     WHERE token = ? AND used_at IS NULL
     LIMIT 1`
  ).bind(otpCode.trim()).first<{ id: number; merchant_id: number; user_id: number; expires_at: string }>();

  if (!tokenRow) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'Invalid or used OTP' } }, 404);
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return c.json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired' } }, 410);
  }

  // Mark OTP used
  await c.env.DB.prepare(
    `UPDATE op_device_pairing_tokens SET used_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), tokenRow.id).run();

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
  const deviceId = c.get('authSubject')!;
  await c.env.DB.prepare(
    `UPDATE op_paired_devices SET last_heartbeat_at = ? WHERE id = ?`
  ).bind(new Date().toISOString(), deviceId).run();
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
  const deviceId = c.get('authSubject')!;

  const rows = await c.env.DB.prepare(

    `SELECT id, event, payload, read_at, created_at
     FROM op_mobile_notifications
     WHERE merchant_id = ? AND device_id = ?
     ORDER BY created_at DESC
     LIMIT 50`
).bind(merchantId, deviceId).all();

  return c.json({ success: true, data: rows.results });
});

// Acknowledge notifications
mobileRoutes.post('/notifications/acknowledgements', async (c) => {
  const body = await c.req.json<{ notification_ids?: number[] }>();
  if (!body.notification_ids?.length) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'notification_ids required' } }, 400);
  }

  const placeholders = body.notification_ids.map(() => '?').join(',');
  await c.env.DB.prepare(

    `UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (${placeholders})`
).bind(new Date().toISOString(), ...body.notification_ids).run();

  return c.json({ success: true, data: { acknowledged: body.notification_ids.length } });
});
