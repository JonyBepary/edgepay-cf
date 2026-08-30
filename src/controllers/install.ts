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
  if (installed === 'true') {
    return c.redirect('/');
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

  await c.env.DB.prepare(

    `INSERT INTO op_merchants
       (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?)`
).bind(merchantUuid,
      body.merchant_name,
      body.merchant_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      body.merchant_email,
      body.timezone ?? 'UTC',
      body.currency ?? 'BDT',
      webhookSecret,
      now,
      now,).run();

  const merchantId = (await c.env.DB.prepare(`SELECT last_insert_rowid() AS id`).first<{ id: number }>())?.id ?? 0;

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

  // 3. Create default ledger chart of accounts
  const { LedgerService } = await import('../services/ledger');
  const ledger = new LedgerService(c.env);
  await ledger.createDefaultChartOfAccounts(merchantId, body.currency ?? 'BDT');

  // 4. Seed default currencies (if not done by migrations)
  // (Migration handles initial data — no action needed here)

  // 5. Mark installed (KV flag)
  await c.env.KV.put('system:installed', 'true');

  return c.json({
    success: true,
    data: {
      merchant_id: merchantId,
      admin_uuid: adminUuid,
      install_completed: true,
      next_steps: [
        'Set the following secrets via wrangler secret put: JWT_SECRET, APP_KEY, ENCRYPTION_KEY',
        'Log in to the admin panel at /admin',
        'Configure your first payment gateway under /admin/gateways',
      ],
    },
  });
});
