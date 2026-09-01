/**
 * Admin API routes — `/api/admin/v1/*`
 *
 * Authenticated via Bearer API keys with admin scope.
 * Used by the EdgePay admin dashboard (HTML UI).
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { requireBearerApiAuth, requireScope } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { RefundService } from '../services/refund';
import { runReconciliation } from '../services/reconciliation';

export const adminApiRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().trim();
}

async function invalidateDomainCache(env: Env, hostname: string): Promise<void> {
  const normalized = normalizeHostname(hostname);
  await Promise.all([
    env.KV.delete(`domain:${normalized}`),
    env.KV.delete(`domain-v2:${normalized}`),
  ]);
}

adminApiRoutes.use('*', requireBearerApiAuth(['admin']));
// Per-API-KEY rate limiting via the native Ratelimit binding
adminApiRoutes.use('*', rateLimitMiddleware);

// Domains - verify
adminApiRoutes.post('/domains/verifications', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const body = await c.req.json<{ domain?: string }>();

  if (!body.domain) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'domain required' } }, 400);
  }

  const domain = await c.env.DB.prepare(

    `SELECT id, verification_token, dns_verified, status FROM op_domains WHERE domain = ? AND merchant_id = ? LIMIT 1`
).bind(body.domain, merchantId).first<{ id: number; verification_token: string; dns_verified: number; status: string }>();

  if (!domain) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Domain not registered' } }, 404);
  }

  // Verify DNS TXT record via Cloudflare DNS API
  const verificationRecord = `_edgepay-verification.${body.domain}`;
  const dnsResult = await verifyDnsTxt(verificationRecord);

  const verified = dnsResult.includes(domain.verification_token);

  await c.env.DB.prepare(

    `UPDATE op_domains SET dns_verified = ?, status = ?, updated_at = ? WHERE id = ?`
).bind(verified ? 1 : 0, verified ? 'active' : 'pending', new Date().toISOString(), domain.id).run();

  // Invalidate KV domain cache (both prefix variants, normalized)
  await invalidateDomainCache(c.env, body.domain);

  return c.json({
    success: true,
    data: { verified, expected_token: domain.verification_token, lookup: verificationRecord },
  });
});

// SMS templates
adminApiRoutes.get('/sms-templates', async (c) => {
  const merchantId = c.get('merchantId')!;
  const rows = await c.env.DB
    .prepare(
      `SELECT id, gateway_slug, name, regex_pattern, sample_sms, status, created_at
       FROM op_sms_templates WHERE merchant_id = ? ORDER BY created_at DESC`,
    )
    .bind(merchantId)
    .all();
  return c.json({ success: true, data: rows.results });
});

adminApiRoutes.put('/sms-templates/:id', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ regex_pattern?: string; status?: string }>();

  await c.env.DB.prepare(
    `UPDATE op_sms_templates 
     SET regex_pattern = COALESCE(?, regex_pattern), 
         status = COALESCE(?, status), 
         updated_at = ? 
     WHERE id = ? AND merchant_id = ?`
  ).bind(
    body.regex_pattern ?? null,
    body.status ?? null,
    new Date().toISOString(),
    id,
    merchantId,
  ).run();

  return c.json({ success: true });
});

// Devices
adminApiRoutes.get('/devices', async (c) => {
  const merchantId = c.get('merchantId')!;
  const rows = await c.env.DB.prepare(

    `SELECT id, uuid, device_name, status, last_heartbeat_at, created_at
     FROM op_paired_devices WHERE merchant_id = ? ORDER BY created_at DESC`
).bind(merchantId).all();
  return c.json({ success: true, data: rows.results });
});

adminApiRoutes.delete('/devices/:id', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const id = parseInt(c.req.param('id'), 10);

  await c.env.DB.prepare(

    `DELETE FROM op_paired_devices WHERE id = ? AND merchant_id = ?`
).bind(id, merchantId).run();

  return c.json({ success: true });
});

// SMS queues
adminApiRoutes.get('/sms-queues', async (c) => {
  const merchantId = c.get('merchantId')!;
  const rows = await c.env.DB.prepare(

    `SELECT id, sender, body, match_status, created_at
     FROM op_sms_data WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 100`
).bind(merchantId).all();
  return c.json({ success: true, data: rows.results });
});

adminApiRoutes.post('/sms-queues/:id/retries', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const id = parseInt(c.req.param('id'), 10);

  // Re-enqueue for parsing
  const sms = await c.env.DB.prepare(

    `SELECT sender, body FROM op_sms_data WHERE id = ? AND merchant_id = ? LIMIT 1`
).bind(id, merchantId).first<{ sender: string; body: string }>();

  if (!sms) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'SMS not found' } }, 404);
  }

  await c.env.SMS_QUEUE.send({
    merchant_id: merchantId,
    device_id: 0,
    sender: sms.sender,
    body: sms.body,
    received_at: new Date().toISOString(),
  });

  return c.json({ success: true });
});

/**
 * Verify a DNS TXT record via Cloudflare DNS-over-HTTPS API.
 * This is a free public endpoint — no API key required.
 */
async function verifyDnsTxt(record: string): Promise<string[]> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(record)}&type=TXT`,
      { headers: { 'Accept': 'application/dns-json' } },
    );

    if (!response.ok) return [];

    const data = await response.json() as {
      Answer?: Array<{ data: string }>;
    };

    return data.Answer?.map(a => a.data) ?? [];
  } catch {
    return [];
  }
}

// ================================================================
// v0.2.1 — Refunds (the defined workflow trigger path) + reconciliation
// ================================================================

// Create a refund: writes the refund row, asks the gateway to refund
// when supported, and creates the per-refund workflow instance
// (`refund-{id}`) that polls until terminal and posts the idempotent
// ledger reversal.
adminApiRoutes.post('/refunds', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId') as number | null;
  const body = await c.req.json<{ transaction_id?: number; amount?: string; reason?: string }>();

  if (!body.transaction_id || !body.amount) {
    return c.json(
      { success: false, error: { code: 'VALIDATION_ERROR', message: 'transaction_id and amount are required' } },
      400,
    );
  }

  const service = new RefundService(c.env);
  try {
    const result = await service.createRefund({
      merchant_id: merchantId ?? 0,
      transaction_id: body.transaction_id,
      amount: body.amount,
      reason: body.reason,
      initiated_by: c.get('authSubject') as number | null ?? null,
    });
    return c.json({ success: true, data: result }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('not found') ? 404 : 422;
    return c.json({ success: false, error: { code: 'REFUND_REJECTED', message } }, status);
  }
});

// Manual reconciliation trigger — same battery the daily sweep runs
// (pending replay + consistency verify + refund sweep).
adminApiRoutes.post('/reconcile', requireScope('admin'), async (c) => {
  const summary = await runReconciliation(c.env, 'manual', { withSweep: true });
  return c.json({ success: true, data: summary });
});

// Ledger state inspection for operators.
adminApiRoutes.get('/ledger/trial-balance', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId') as number | null;
  if (!merchantId) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'merchant context required' } }, 400);
  }
  const { LedgerService } = await import('../services/ledger');
  const ledger = new LedgerService(c.env);
  const [trial, consistency] = await Promise.all([
    ledger.trialBalance(merchantId),
    ledger.verifyDurableObjectConsistency(merchantId),
  ]);
  return c.json({ success: true, data: { trial_balance: trial, consistency } });
});

// List all merchants (Platform Admin)
adminApiRoutes.get('/merchants', requireScope('admin'), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, uuid, name, slug, email, timezone, default_currency, status, is_platform, created_at
     FROM op_merchants ORDER BY id ASC`
  ).all();
  return c.json({ success: true, data: rows.results });
});

// Create / Provision a new merchant tenant (Platform Admin)
adminApiRoutes.post('/merchants', requireScope('admin'), async (c) => {
  try {
    const body = await c.req.json<{
      name?: string;
      email?: string;
      currency?: string;
      timezone?: string;
      phone?: string;
    }>();

    if (!body.name || !body.email) {
      return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name and email are required' } }, 400);
    }

    const merchantUuid = crypto.randomUUID();
    const webhookSecret = crypto.randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    await c.env.DB.prepare(
      `INSERT INTO op_merchants
         (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', 0, ?, ?)`
    ).bind(
      merchantUuid,
      body.name,
      slug,
      body.email,
      body.timezone ?? 'Asia/Dhaka',
      body.currency ?? 'BDT',
      webhookSecret,
      now,
      now
    ).run();

    const merchantRow = await c.env.DB.prepare(
      `SELECT id FROM op_merchants WHERE uuid = ? LIMIT 1`
    ).bind(merchantUuid).first<{ id: number }>();
    const newMerchantId = merchantRow?.id;
    if (!newMerchantId) throw new Error('Failed to retrieve new merchant ID');

    // 1. Provision default admin user for merchant
    const adminUserUuid = crypto.randomUUID();
    const emailHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.email))))
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const { hashPassword, randomNumericOtp, sha256 } = await import('../lib/crypto');
    const initialPassword = crypto.randomUUID() + '!Aa1';
    const passwordHash = await hashPassword(initialPassword);

    await c.env.DB.prepare(
      `INSERT INTO op_merchant_users
         (merchant_id, uuid, name, email, email_hash, phone, phone_hash, password_hash,
          two_factor_enabled, role_id, status, language, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, NULL, 'active', 'en', ?, ?, ?)`
    ).bind(newMerchantId, adminUserUuid, body.name + ' Admin', body.email, emailHash, passwordHash, body.timezone ?? 'Asia/Dhaka', now, now).run();

    const adminUserRow = await c.env.DB.prepare(
      `SELECT id FROM op_merchant_users WHERE uuid = ? LIMIT 1`
    ).bind(adminUserUuid).first<{ id: number }>();
    const adminUserId = adminUserRow?.id ?? 1;

    // 2. Provision default ledger chart of accounts
    const { LedgerService } = await import('../services/ledger');
    const ledger = new LedgerService(c.env);
    await ledger.createDefaultChartOfAccounts(newMerchantId, body.currency ?? 'BDT');

    // 3. Generate Primary API Key
    const keyPrefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const keyRest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const apiKey = `op_live_${keyPrefix}_${keyRest}`;
    const keyHash = await sha256(apiKey);

    await c.env.DB.prepare(
      `INSERT INTO op_api_keys
         (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
       VALUES (?, 'Primary Live Key', ?, ?, ?, 'active', ?)`
    ).bind(
      newMerchantId,
      keyPrefix,
      keyHash,
      JSON.stringify(['read', 'write', 'admin', '*']),
      now
    ).run();

    // 4. Seed default gateways from centralized configuration
    const { getPlatformConfig } = await import('../config/platform');
    const cfg = getPlatformConfig(c.env);
    const defaultPhone = body.phone ?? cfg.mfs.defaultPhone ?? null;

    for (const gw of cfg.gateways.defaultSeedGateways) {
      await c.env.DB.prepare(
        `INSERT INTO op_gateways 
           (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
      ).bind(newMerchantId, gw.slug, gw.name, gw.type, gw.priority, JSON.stringify(gw.currencies), now, now).run();

      const gwRow = await c.env.DB.prepare(
        `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
      ).bind(newMerchantId, gw.slug).first<{ id: number }>();

      const gwId = gwRow?.id;
      if (gw.type === 'manual' && gwId) {
        const phone = defaultPhone ?? '';
        const instructions = phone ? `Send Money to ${gw.name} Number: ${phone}` : `Contact merchant for ${gw.name} payment details`;
        await c.env.DB.prepare(
          `INSERT INTO op_manual_gateways (gateway_id, merchant_id, account_name, account_number, instructions, created_at)
           VALUES (?, ?, 'personal', ?, ?, ?)`
        ).bind(gwId, newMerchantId, phone, instructions, now).run();
      }
    }

    // 5. Seed companion pairing OTP using CSPRNG
    const pairingOtp = randomNumericOtp(6);
    const otpExpiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO op_device_pairing_tokens
         (merchant_id, user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(newMerchantId, adminUserId, pairingOtp, otpExpiresAt, now).run();

    return c.json({
      success: true,
      data: {
        merchant_id: newMerchantId,
        uuid: merchantUuid,
        name: body.name,
        slug,
        email: body.email,
        api_key: apiKey,
        pairing_otp: pairingOtp,
        webhook_secret: webhookSecret,
        created_at: now,
      }
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Merchant provisioning error:', err);
    return c.json({ success: false, error: { code: 'PROVISION_ERROR', message: msg } }, 500);
  }
});
