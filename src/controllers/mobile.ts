/**
 * Mobile companion API routes — `/api/mobile/v1/*`
 *
 * Authenticated via JWT (issued after OTP device pairing).
 * Used by the EdgePay mobile companion app (Flutter).
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { requireJwtAuth } from '../middleware/auth';
import { createJwtService } from '../lib/jwt';

export const mobileRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

// Device pairing (no auth — uses OTP)
mobileRoutes.post('/devices', async (c) => {
  const body = await c.req.json<{ otp?: string; device_name?: string }>();

  if (!body.otp || !/^\d{6}$/.test(body.otp)) {
    return c.json({ success: false, error: { code: 'INVALID_OTP', message: 'OTP must be 6 digits' } }, 400);
  }

  // Look up OTP in pairing tokens table
  const tokenRow = await c.env.DB.prepare(

    `SELECT id, merchant_id, user_id, expires_at, used_at
     FROM op_device_pairing_tokens
     WHERE token = ? AND used_at IS NULL
     LIMIT 1`
).bind(body.otp).first<{ id: number; merchant_id: number; user_id: number; expires_at: string }>();

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
).bind(tokenRow.merchant_id,
      tokenRow.user_id,
      deviceUuid,
      body.device_name ?? 'Unknown device',
      '', // fingerprint (set by mobile app)
      new Date().toISOString(),
      new Date().toISOString(),).run();

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
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: parseInt(c.env.JWT_TTL_SECONDS ?? '3600', 10),
    },
  }, 201);
});

// Token refresh
mobileRoutes.post('/devices/token-refreshes', async (c) => {
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
    return c.json({ success: true, data: { access_token: accessToken, token_type: 'Bearer', expires_in: parseInt(c.env.JWT_TTL_SECONDS ?? '3600', 10) } });
  } catch {
    return c.json({ success: false, error: { code: 'INVALID_REFRESH', message: 'Invalid or expired refresh token' } }, 401);
  }
});

// All subsequent routes require JWT
mobileRoutes.use('*', requireJwtAuth());

// Heartbeat
mobileRoutes.post('/devices/heartbeats', async (c) => {
  const deviceId = c.get('authSubject')!;
  await c.env.DB.prepare(

    `UPDATE op_paired_devices SET last_heartbeat_at = ? WHERE id = ?`
).bind(new Date().toISOString(), deviceId).run();
  return c.json({ success: true, data: { status: 'ok' } });
});

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
      recent_transactions: recent,
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

  return c.json({ success: true, data: rows });
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
