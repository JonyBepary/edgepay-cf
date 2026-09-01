/**
 * Automated Production Self-Healing & Bootstrapping Service.
 *
 * Runs automatically on cold-start or first deploy:
 * - Initializes platform merchant
 * - Provisions GAAP double-entry 14 chart of accounts
 * - Configures standard gateways (bKash, Nagad, Rocket, SSLCommerz, Stripe)
 * - Seeds bKash/Nagad wallet numbers in op_manual_gateways
 * - Seeds verified SMS regex templates in op_sms_templates
 * - Sets default companion app device pairing OTP
 * - Registers default mock webhook endpoint
 * - Guarantees 100% idempotent self-healing across re-deploys.
 */

import type { Env } from '../types/env';
import { randomUuid, randomBase64Key, sha256 } from '../lib/crypto';
import { LedgerService } from './ledger';

export interface BootstrapResult {
  merchant_id: number;
  api_key?: string;
  pairing_otp: string;
  bootstrapped: boolean;
}

export async function ensureSystemBootstrapped(env: Env): Promise<BootstrapResult> {
  const now = new Date().toISOString();

  // 1. Check if platform merchant exists
  let merchant = await env.DB.prepare(
    `SELECT id, uuid FROM op_merchants WHERE is_platform = 1 LIMIT 1`
  ).first<{ id: number; uuid: string }>();

  let merchantId = merchant?.id;
  let newApiKey: string | undefined;

  const adminEmail = env.ADMIN_EMAIL ?? 'admin@edgepay.internal';
  const defaultPhone = env.DEFAULT_MFS_NUMBER ?? '01815300789';
  const initialOtp = env.DEFAULT_PAIRING_OTP ?? '123456';
  const defaultWebhook = env.DEFAULT_WEBHOOK_URL ?? (env.APP_URL ? `${env.APP_URL}/mock-webhook` : '');

  if (!merchantId) {
    const merchantUuid = randomUuid();
    const webhookSecret = randomBase64Key(32);
    
    await env.DB.prepare(
      `INSERT INTO op_merchants
         (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
       VALUES (?, 'EdgePay Platform', 'edgepay-platform', ?, 'Asia/Dhaka', 'BDT', ?, NULL, 'active', 1, ?, ?)`
    ).bind(merchantUuid, adminEmail, webhookSecret, now, now).run();

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
    const { hashPassword } = await import('../lib/crypto');
    const passwordHash = await hashPassword('AdminPass123456!');

    await env.DB.prepare(
      `INSERT INTO op_merchant_users
         (merchant_id, uuid, name, email, email_hash, phone, phone_hash, password_hash,
          two_factor_enabled, role_id, status, language, timezone, created_at, updated_at)
       VALUES (?, ?, 'Platform Admin', ?, ?, NULL, NULL, ?, 0, NULL, 'active', 'en', 'Asia/Dhaka', ?, ?)`
    ).bind(merchantId, adminUserUuid, adminEmail, emailHash, passwordHash, now, now).run();
  }

  // 2. Ensure default ledger chart of accounts
  const ledger = new LedgerService(env);
  const accountCount = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM op_ledger_accounts WHERE merchant_id = ?`
  ).bind(merchantId).first<{ count: number }>();

  if (!accountCount || accountCount.count === 0) {
    await ledger.createDefaultChartOfAccounts(merchantId, 'BDT');
  }

  // 3. Ensure default gateways
  const defaultGateways = [
    { slug: 'bkash', name: 'bKash Personal / Agent', type: 'manual', currencies: '["BDT"]', priority: 1 },
    { slug: 'nagad', name: 'Nagad Personal / Agent', type: 'manual', currencies: '["BDT"]', priority: 2 },
    { slug: 'rocket', name: 'DBBL Rocket', type: 'manual', currencies: '["BDT"]', priority: 3 },
    { slug: 'sslcommerz', name: 'SSLCommerz', type: 'api', currencies: '["BDT","USD"]', priority: 4 },
    { slug: 'stripe', name: 'Stripe Global Cards', type: 'api', currencies: '["USD","EUR","GBP","BDT"]', priority: 5 },
  ];

  for (const gw of defaultGateways) {
    const existingGw = await env.DB.prepare(
      `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
    ).bind(merchantId, gw.slug).first<{ id: number }>();

    if (!existingGw) {
      await env.DB.prepare(
        `INSERT INTO op_gateways 
           (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      ).bind(merchantId, gw.slug, gw.name, gw.type, gw.priority, gw.currencies, now, now).run();

      const gwRow = await env.DB.prepare(
        `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
      ).bind(merchantId, gw.slug).first<{ id: number }>();

      const newGwId = gwRow?.id;
      if (gw.slug === 'bkash' && newGwId) {
        await env.DB.prepare(
          `INSERT INTO op_manual_gateways (gateway_id, merchant_id, account_name, account_number, instructions, created_at)
           VALUES (?, ?, 'personal', ?, ?, ?)`
        ).bind(newGwId, merchantId, defaultPhone, `Send Money to bKash Personal Number: ${defaultPhone}`, now).run();
      } else if (gw.slug === 'nagad' && newGwId) {
        await env.DB.prepare(
          `INSERT INTO op_manual_gateways (gateway_id, merchant_id, account_name, account_number, instructions, created_at)
           VALUES (?, ?, 'personal', ?, ?, ?)`
        ).bind(newGwId, merchantId, defaultPhone, `Send Money to Nagad Personal Number: ${defaultPhone}`, now).run();
      }
    }
  }

  // 4. Ensure SMS regex templates
  const defaultTemplates = [
    {
      gateway_slug: 'bkash',
      name: 'bKash Received Money',
      regex: 'You have received Tk (?<amount>[0-9,.]+)\\s+from\\s+(?<sender>[0-9+]+)\\..*?TrxID\\s+(?<trx_id>[A-Z0-9]+)',
      sample: 'You have received Tk 500.00 from 01711223344. Fee Tk 0.00. Balance Tk 15,200.00. TrxID 9A8B7C6D5E at 31/08/2026 03:00'
    },
    {
      gateway_slug: 'bkash',
      name: 'bKash Merchant Payment',
      regex: 'Payment Tk (?<amount>[0-9,.]+)\\s+from\\s+(?<sender>[0-9+]+)\\s+successful.*?TrxID\\s+(?<trx_id>[A-Z0-9]+)',
      sample: 'Payment Tk 500.00 from 01711223344 successful. Fee Tk 0.00. Balance Tk 15,200.00. TrxID 9A8B7C6D5E at 31/08/2026 03:00'
    },
    {
      gateway_slug: 'nagad',
      name: 'Nagad Received / Cash In',
      regex: '(?:Cash In|Payment|Received).*?Tk\\s+(?<amount>[0-9,.]+).*?from\\s+(?<sender>[0-9+]+).*?TxnID:\\s+(?<trx_id>[A-Z0-9]+)',
      sample: 'Cash In of Tk 500.00 is successful from 01811223344. Fee Tk 0.00. Balance Tk 10,500.00. TxnID: NG9A8B7C at 31/08/2026 03:00'
    },
    {
      gateway_slug: 'rocket',
      name: 'DBBL Rocket Received',
      regex: '(?:TxnId|Txn):\\s*(?<trx_id>[0-9]+).*?Tk\\s*(?<amount>[0-9,.]+).*?From:\\s*(?<sender>[0-9+]+)',
      sample: 'TxnId: 1234567890 Tk 500.00 From: 01911223344'
    }
  ];

  for (const tmpl of defaultTemplates) {
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

  // 5. Ensure device pairing OTP (FK-safe: requires a real user row)
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

  // 6. Ensure default webhook
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

    await env.KV.put('system:root_api_key', newApiKey);
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
