/**
 * Automated Production Self-Healing & Bootstrapping Service.
 *
 * Fully configurable via `src/config/platform.ts` and `wrangler.jsonc` (vars / secrets).
 * Supports explicit null / none / nil value ranges for zero-hardcoding before deploy.
 */

import type { Env } from '../types/env';
import { randomUuid, randomBase64Key, sha256 } from '../lib/crypto';
import { LedgerService } from './ledger';
import { getPlatformConfig } from '../config/platform';

export interface BootstrapResult {
  merchant_id: number;
  api_key?: string;
  pairing_otp: string;
  bootstrapped: boolean;
}

export async function ensureSystemBootstrapped(env: Env): Promise<BootstrapResult> {
  const now = new Date().toISOString();
  const cfg = getPlatformConfig(env);

  const adminEmail = cfg.admin.email ?? 'admin@edgepay.internal';
  const defaultPhone = cfg.mfs.defaultPhone;
  const initialOtp = cfg.mfs.pairingOtp;
  const defaultWebhook = cfg.financial.webhookUrl;

  // 1. Check if platform merchant exists
  let merchant = await env.DB.prepare(
    `SELECT id, uuid FROM op_merchants WHERE is_platform = 1 LIMIT 1`
  ).first<{ id: number; uuid: string }>();

  let merchantId = merchant?.id;
  let newApiKey: string | undefined;

  if (!merchantId) {
    const merchantUuid = randomUuid();
    const webhookSecret = randomBase64Key(32);
    
    await env.DB.prepare(
      `INSERT INTO op_merchants
         (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'edgepay-platform', ?, ?, ?, ?, NULL, 'active', 1, ?, ?)`
    ).bind(
      merchantUuid,
      cfg.app.name + ' Platform',
      adminEmail,
      cfg.admin.timezone,
      cfg.financial.defaultCurrency,
      webhookSecret,
      now,
      now
    ).run();

    const row = await env.DB.prepare(
      `SELECT id FROM op_merchants WHERE uuid = ? LIMIT 1`
    ).bind(merchantUuid).first<{ id: number }>();
    merchantId = row?.id ?? 1;
  }

  // 1.5. Ensure default admin user for platform merchant
  const existingAdminUser = await env.DB.prepare(
    `SELECT id FROM op_merchant_users WHERE merchant_id = ? LIMIT 1`
  ).bind(merchantId).first<{ id: number }>();

  if (!existingAdminUser) {
    const adminUserUuid = randomUuid();
    const emailHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(adminEmail))))
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const { hashPassword, getPbkdf2Iterations } = await import('../lib/crypto');
    const initialAdminPass = cfg.admin.password ?? (cfg.app.environment === 'production' ? randomUuid() + '!Aa1' : 'AdminPass123456!');
    const passwordHash = await hashPassword(initialAdminPass, getPbkdf2Iterations(env));

    await env.DB.prepare(
      `INSERT INTO op_merchant_users
         (merchant_id, uuid, name, email, email_hash, phone, phone_hash, password_hash,
          two_factor_enabled, role_id, status, language, timezone, created_at, updated_at)
       VALUES (?, ?, 'Platform Admin', ?, ?, ?, NULL, ?, 0, NULL, 'active', ?, ?, ?, ?)`
    ).bind(
      merchantId,
      adminUserUuid,
      adminEmail,
      emailHash,
      defaultPhone,
      passwordHash,
      cfg.admin.language,
      cfg.admin.timezone,
      now,
      now
    ).run();
  }

  // 2. Ensure default ledger chart of accounts
  const ledger = new LedgerService(env);
  const accountCount = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM op_ledger_accounts WHERE merchant_id = ?`
  ).bind(merchantId).first<{ count: number }>();

  if (!accountCount || accountCount.count === 0) {
    await ledger.createDefaultChartOfAccounts(merchantId, cfg.financial.defaultCurrency);
  }

  // 3. Ensure configured seed gateways
  for (const gw of cfg.gateways.defaultSeedGateways) {
    const existingGw = await env.DB.prepare(
      `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
    ).bind(merchantId, gw.slug).first<{ id: number }>();

    if (!existingGw) {
      await env.DB.prepare(
        `INSERT INTO op_gateways 
           (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      ).bind(merchantId, gw.slug, gw.name, gw.type, gw.priority, JSON.stringify(gw.currencies), now, now).run();

      const gwRow = await env.DB.prepare(
        `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
      ).bind(merchantId, gw.slug).first<{ id: number }>();

      const newGwId = gwRow?.id;
      if (gw.type === 'manual' && newGwId) {
        const phone = defaultPhone ?? '';
        const instructions = phone ? `Send Money to ${gw.name} Number: ${phone}` : `Contact merchant for ${gw.name} payment details`;
        await env.DB.prepare(
          `INSERT INTO op_manual_gateways (gateway_id, merchant_id, account_name, account_number, instructions, created_at)
           VALUES (?, ?, 'personal', ?, ?, ?)`
        ).bind(newGwId, merchantId, phone, instructions, now).run();
      }
    }
  }

  // 4. Ensure SMS regex templates
  for (const tmpl of cfg.gateways.defaultSmsTemplates) {
    const existingTmpl = await env.DB.prepare(
      `SELECT id FROM op_sms_templates WHERE merchant_id = ? AND name = ? LIMIT 1`
    ).bind(merchantId, tmpl.name).first<{ id: number }>();

    if (!existingTmpl) {
      await env.DB.prepare(
        `INSERT INTO op_sms_templates
           (merchant_id, gateway_slug, name, regex_pattern, sample_sms, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(merchantId, tmpl.gateway_slug, tmpl.name, tmpl.regex, tmpl.sample, now, now).run();
    }
  }

  // 5. Ensure device pairing OTP (FK-safe: bound to real admin user)
  const existingOtp = await env.DB.prepare(
    `SELECT token FROM op_device_pairing_tokens WHERE merchant_id = ? AND token = ? LIMIT 1`
  ).bind(merchantId, initialOtp).first<{ token: string }>();

  if (!existingOtp) {
    const otpUser = await env.DB.prepare(
      `SELECT id FROM op_merchant_users WHERE merchant_id = ? LIMIT 1`
    ).bind(merchantId).first<{ id: number }>();
    if (otpUser) {
      const otpExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      await env.DB.prepare(
        `INSERT INTO op_device_pairing_tokens
           (merchant_id, user_id, token, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(merchantId, otpUser.id, initialOtp, otpExpiresAt, now).run();
    }
  }

  // 6. Ensure default webhook (only if configured)
  if (defaultWebhook) {
    const existingWebhook = await env.DB.prepare(
      `SELECT id FROM op_webhooks WHERE merchant_id = ? LIMIT 1`
    ).bind(merchantId).first<{ id: number }>();

    if (!existingWebhook) {
      const secret = `whsec_${randomBase64Key(24).replace(/[^a-zA-Z0-9]/g, '')}`;
      await env.DB.prepare(
        `INSERT INTO op_webhooks (merchant_id, url, secret, events, status, created_at, updated_at)
         VALUES (?, ?, ?, '["*"]', 'active', ?, ?)`
      ).bind(merchantId, defaultWebhook, secret, now, now).run();
    }
  }

  // 7. Ensure active API Key
  const existingKey = await env.DB.prepare(
    `SELECT key_prefix FROM op_api_keys WHERE merchant_id = ? AND status = 'active' LIMIT 1`
  ).bind(merchantId).first<{ key_prefix: string }>();

  if (!existingKey) {
    const keyPrefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const keyRest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    newApiKey = `op_live_${keyPrefix}_${keyRest}`;
    const keyHash = await sha256(newApiKey);

    await env.DB.prepare(
      `INSERT INTO op_api_keys
         (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
       VALUES (?, 'Auto-Provisioned Root Key', ?, ?, ?, 'active', ?)`
    ).bind(
      merchantId,
      keyPrefix,
      keyHash,
      JSON.stringify(['read', 'write', 'admin', '*']),
      now
    ).run();
  }

  await env.KV.put('system:bootstrapped', 'true');
  await env.KV.put('system:installed', 'true');

  return {
    merchant_id: merchantId,
    api_key: newApiKey,
    pairing_otp: initialOtp,
    bootstrapped: true,
  };
}
