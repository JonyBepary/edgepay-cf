/**
 * Installation wizard routes — /install/*
 *
 * Multi-step wizard:
 *   1. Requirements check
 *   2. Database connection test + schema import
 *   3. Admin account creation
 *   4. Key generation + install lock
 *
 * On Workers, we don't have filesystem, so the install lock lives in KV.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { hashPassword, randomBase64Key, randomUuid, base64ToBytes } from '../lib/crypto';
import { gatewaySelection } from '../gateways/enabled';

export const installRoutes = new Hono<{ Bindings: Env }>();

/**
 * Secret posture for the pre-install requirements check.
 * Reports LENGTH-CLASS ONLY ('ok' | 'weak' | 'missing') — never content —
 * and the route 302-redirects to / once the platform is installed, so
 * this surfaces only during first-run setup (a deploy-button user's
 * very first stop). JWT_SECRET is a raw string (>= 32 chars enforced by
 * lib/jwt.ts); APP_KEY / ENCRYPTION_KEY are base64-encoded 32-byte keys.
 */
function secretPosture(value: string | undefined, kind: 'raw' | 'base64'): 'ok' | 'weak' | 'missing' {
  if (!value) return 'missing';
  if (kind === 'raw') {
    return value.length >= 32 ? 'ok' : 'weak';
  }
  try {
    return base64ToBytes(value).length >= 32 ? 'ok' : 'weak';
  } catch {
    return 'weak';
  }
}

// Step 0: requirements check
installRoutes.get('/', async (c) => {
  const installed = await c.env.KV.get('system:installed');
  const acceptHeader = c.req.header('Accept') || '';
  const isJsonReq = acceptHeader.includes('application/json') || c.req.query('format') === 'json';
  if (installed === 'true') {
    if (!isJsonReq) {
      return c.redirect('/');
    }
    return c.json({ success: true, message: 'Platform is already installed and locked.' });
  }

  // v0.2.3: surface the gateway-plugin selection (ENABLED_GATEWAYS) so
  // the deployer immediately sees which gateways their deployment can
  // configure — including typo feedback for dropped aliases.
  const gateways = gatewaySelection(c.env.ENABLED_GATEWAYS);

  return c.json({
    success: true,
    data: {
      requirements: {
        workers_runtime: 'ok',
        d1_database: c.env.DB ? 'ok' : 'missing',
        kv_namespace: c.env.KV ? 'ok' : 'missing',
        r2_bucket: c.env.R2 ? 'ok' : 'missing',
        webhook_queue: c.env.WEBHOOK_QUEUE ? 'ok' : 'missing',
      },
      secrets: {
        jwt_secret: secretPosture(c.env.JWT_SECRET, 'raw'),
        app_key: secretPosture(c.env.APP_KEY, 'base64'),
        encryption_key: secretPosture(c.env.ENCRYPTION_KEY, 'base64'),
      },
      gateways: {
        enabled: gateways.enabled,
        dropped_aliases: gateways.dropped,
        all_enabled: gateways.allEnabled,
      },
      version: c.env.APP_VERSION,
    },
  });
});

// Step 1: create super-admin + initial merchant
installRoutes.post('/', async (c) => {
  const installed = await c.env.KV.get('system:installed');
  if (installed === 'true') {
    return c.json({ success: false, error: { code: 'ALREADY_INSTALLED' } }, 400);
  }

  const body = await c.req.json<{
    merchant_name?: string;
    merchant_email?: string;
    admin_name?: string;
    admin_email?: string;
    admin_password?: string;
    timezone?: string;
    currency?: string;
  }>();

  if (!body.merchant_name || !body.admin_email || !body.admin_password) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'merchant_name, admin_email, admin_password required' } }, 400);
  }

  if (body.admin_password.length < 12) {
    return c.json({ success: false, error: { code: 'WEAK_PASSWORD', message: 'Password must be at least 12 characters' } }, 400);
  }

  // 1. Create the platform merchant
  const merchantUuid = randomUuid();
  const webhookSecret = randomBase64Key(32);
  const now = new Date().toISOString();
  const merchantEmail = body.merchant_email ?? body.admin_email;

  await c.env.DB.prepare(
    `INSERT INTO op_merchants
       (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?)`
  ).bind(
    merchantUuid,
    body.merchant_name,
    body.merchant_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    merchantEmail,
    body.timezone ?? 'Asia/Dhaka',
    body.currency ?? 'BDT',
    webhookSecret,
    now,
    now,
  ).run();

  const merchantRow = await c.env.DB.prepare(
    `SELECT id FROM op_merchants WHERE uuid = ? LIMIT 1`
  ).bind(merchantUuid).first<{ id: number }>();
  const merchantId = merchantRow?.id ?? 1;

  // 2. Create super-admin user.
  //    PBKDF2 cost is env-configurable (PBKDF2_ITERATIONS): strictly-free-tier
  //    deployments cannot afford 600K iterations inside the 10ms CPU budget.
  const adminUuid = randomUuid();
  const pbkdf2Cost = Number(c.env.PBKDF2_ITERATIONS ?? '') || undefined;
  const passwordHash = await hashPassword(body.admin_password, pbkdf2Cost);
  const emailHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.admin_email)).then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''));

  await c.env.DB.prepare(

    `INSERT INTO op_merchant_users
       (merchant_id, uuid, name, email, email_hash, phone, phone_hash, password_hash,
        two_factor_enabled, role_id, status, language, timezone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, NULL, 'active', ?, ?, ?, ?)`
).bind(merchantId,
      adminUuid,
      body.admin_name ?? 'Administrator',
      body.admin_email,
      emailHash,
      passwordHash,
      'en',
      body.timezone ?? 'UTC',
      now,
      now,).run();

  const userRow = await c.env.DB.prepare(
    `SELECT id FROM op_merchant_users WHERE uuid = ? LIMIT 1`
  ).bind(adminUuid).first<{ id: number }>();
  const adminUserId = userRow?.id ?? 1;

  // 3. Create default ledger chart of accounts
  const { LedgerService } = await import('../services/ledger');
  const ledger = new LedgerService(c.env);
  await ledger.createDefaultChartOfAccounts(merchantId, body.currency ?? 'BDT');

  // 4. Generate initial Merchant API Key (admin, read, write scopes)
  const { sha256 } = await import('../lib/crypto');
  const keyPrefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const keyRest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const apiKey = `op_live_${keyPrefix}_${keyRest}`;
  const keyHash = await sha256(apiKey);

  await c.env.DB.prepare(
    `INSERT INTO op_api_keys
       (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
     VALUES (?, 'Primary Admin Key', ?, ?, ?, 'active', ?)`
  ).bind(
    merchantId,
    keyPrefix,
    keyHash,
    JSON.stringify(['read', 'write', 'admin', '*']),
    now
  ).run();

  // 5. Seed default gateways from centralized configuration
  const { getPlatformConfig } = await import('../config/platform');
  const cfg = getPlatformConfig(c.env);

  for (const gw of cfg.gateways.defaultSeedGateways) {
    await c.env.DB.prepare(
      `INSERT INTO op_gateways 
         (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
    ).bind(merchantId, gw.slug, gw.name, gw.type, gw.priority, JSON.stringify(gw.currencies), now, now).run();
  }

  // 6. Seed default SMS regex templates from centralized configuration
  for (const tmpl of cfg.gateways.defaultSmsTemplates) {
    await c.env.DB.prepare(
      `INSERT INTO op_sms_templates
         (merchant_id, gateway_slug, name, regex_pattern, sample_sms, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(merchantId, tmpl.gateway_slug, tmpl.name, tmpl.regex, tmpl.sample, now, now).run();
  }

  // 7. Seed initial companion device pairing OTP using CSPRNG
  const initialOtp = cfg.mfs.pairingOtp;
  const otpExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  await c.env.DB.prepare(
    `INSERT INTO op_device_pairing_tokens
       (merchant_id, user_id, token, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(merchantId, adminUserId, initialOtp, otpExpiresAt, now).run();

  // 8. Mark installed (KV flag)
  await c.env.KV.put('system:installed', 'true');

  return c.json({
    success: true,
    data: {
      merchant_id: merchantId,
      admin_uuid: adminUuid,
      api_key: apiKey,
      device_pairing_otp: initialOtp,
      install_completed: true,
      message: 'Setup complete! Use the API key for backend requests and the OTP to pair the Android companion app.',
      next_steps: [
        `Use 'Authorization: Bearer ${apiKey}' for all /api/v1/* requests`,
        `Use pairing OTP '${initialOtp}' to connect the Android SMS forwarding app`,
        'Checkout is ready with bKash, Nagad, and Rocket support',
      ],
    },
  });
});

// Step 2: Bootstrap/generate an API key using admin credentials (safe fallback for installed instances)
installRoutes.post('/bootstrap-key', async (c) => {
  const body = await c.req.json<{ admin_email?: string; admin_password?: string }>();
  if (!body.admin_email || !body.admin_password) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'admin_email and admin_password required' } }, 400);
  }

  const emailHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.admin_email)).then(b => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''));
  const user = await c.env.DB.prepare(
    `SELECT id, merchant_id, password_hash FROM op_merchant_users WHERE email_hash = ? AND status = 'active' LIMIT 1`
  ).bind(emailHash).first<{ id: number; merchant_id: number; password_hash: string }>();

  if (!user) {
    return c.json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid admin credentials' } }, 401);
  }

  const { verifyPassword, sha256 } = await import('../lib/crypto');
  const valid = await verifyPassword(body.admin_password, user.password_hash);
  if (!valid) {
    return c.json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid admin credentials' } }, 401);
  }

  // Create a new admin API key for this merchant
  const keyPrefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const keyRest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const apiKey = `op_live_${keyPrefix}_${keyRest}`;
  const keyHash = await sha256(apiKey);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO op_api_keys
       (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
     VALUES (?, 'Admin Bootstrap Key', ?, ?, ?, 'active', ?)`
  ).bind(
    user.merchant_id,
    keyPrefix,
    keyHash,
    JSON.stringify(['read', 'write', 'admin', '*']),
    now
  ).run();

  return c.json({
    success: true,
    data: {
      merchant_id: user.merchant_id,
      api_key: apiKey,
      message: 'New API key generated successfully. Use as Authorization: Bearer <api_key> for /api/v1/* requests.'
    }
  });
});
