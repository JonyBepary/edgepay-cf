/**
 * Admin API routes — `/api/admin/v1/*`
 *
 * Authenticated via Bearer API keys with admin scope.
 * Used by the EdgePay admin dashboard (HTML UI).
 */

import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { requireBearerApiAuth, requireScope, getAuthenticatedMerchantId, getTargetMerchantId, type ApiVariables } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { RefundService } from '../services/refund';
import { runReconciliation } from '../services/reconciliation';
import { grantDeviceOverride, revokeDeviceOverride } from '../services/device-policy';

export const adminApiRoutes = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

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

// Gates — update destination number, label, status
adminApiRoutes.patch('/gates/:id', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const gateId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(gateId) || gateId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_GATE_ID', message: 'Gate ID must be a positive integer' } }, 400);
  }

  interface GateUpdateBody {
    label?: string;
    mfs_number?: string | null;
    status?: 'active' | 'paused' | 'archived';
  }
  const body: GateUpdateBody = await c.req.json<GateUpdateBody>().catch(() => ({}));

  if (body.label === undefined && body.mfs_number === undefined && body.status === undefined) {
    return c.json({ success: false, error: { code: 'NO_FIELDS', message: 'At least one field (label, mfs_number, status) must be provided' } }, 400);
  }

  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || body.label.trim().length === 0 || body.label.length > 200) {
      return c.json({ success: false, error: { code: 'INVALID_LABEL', message: 'Label must be a string between 1 and 200 characters' } }, 400);
    }
  }

  if (body.mfs_number !== undefined && body.mfs_number !== null) {
    if (typeof body.mfs_number !== 'string' || !/^[+]?[0-9]{6,20}$/.test(body.mfs_number)) {
      return c.json({ success: false, error: { code: 'INVALID_MFS_NUMBER', message: 'mfs_number must be 6-20 digits, optionally starting with +' } }, 400);
    }
  }

  if (body.status !== undefined) {
    if (!['active', 'paused', 'archived'].includes(body.status)) {
      return c.json({ success: false, error: { code: 'INVALID_STATUS', message: "status must be one of 'active', 'paused', 'archived'" } }, 400);
    }
  }

  const before = await c.env.DB.prepare(
    `SELECT id, label, mfs_number, status FROM op_gates WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(gateId, merchantId).first<{ id: number; label: string; mfs_number: string | null; status: string }>();

  if (!before) {
    return c.json({ success: false, error: { code: 'GATE_NOT_FOUND', message: 'Gate not found' } }, 404);
  }

  // Build the UPDATE dynamically from the provided fields only.
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.label !== undefined) { sets.push('label = ?'); binds.push(body.label.trim()); }
  if (body.mfs_number !== undefined) { sets.push('mfs_number = ?'); binds.push(body.mfs_number); }
  if (body.status !== undefined) { sets.push('status = ?'); binds.push(body.status); }
  sets.push("updated_at = datetime('now')");
  binds.push(gateId, merchantId);

  await c.env.DB.prepare(
    `UPDATE op_gates SET ${sets.join(', ')} WHERE id = ? AND merchant_id = ?`
  ).bind(...binds).run();

  const after = await c.env.DB.prepare(
    `SELECT id, label, mfs_number, status FROM op_gates WHERE id = ? LIMIT 1`
  ).bind(gateId).first();

  // Audit log entry
  await c.env.DB.prepare(
    `INSERT INTO op_audit_logs (
       merchant_id, actor_id, actor_type, action, entity_type, entity_id,
       old_values, new_values, ip_address, user_agent, signature, created_at
     ) VALUES (?, ?, ?, 'gate.updated', 'gate', ?, ?, ?, ?, ?, 'system', datetime('now'))`
  ).bind(
    merchantId,
    c.get('authSubject') ?? 0,
    'admin',
    String(gateId),
    JSON.stringify(before),
    JSON.stringify(after),
    c.req.header('cf-connecting-ip') ?? null,
    c.req.header('user-agent') ?? null,
  ).run();

  return c.json({ success: true, data: after });
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

// Merchant Device Policy (Admin override)
adminApiRoutes.get('/merchants/:id/device-policy', async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const row = await c.env.DB.prepare(
    `SELECT min_tier, min_patch_level, strict_pairing, enforcement_mode, updated_at, updated_by
     FROM op_merchant_device_policies WHERE merchant_id = ? LIMIT 1`
  ).bind(merchantId).first<{
    min_tier: string;
    min_patch_level: string | null;
    strict_pairing: number;
    enforcement_mode: string | null;
    updated_at: string;
    updated_by: number | null;
  }>();

  return c.json({
    success: true,
    data: {
      min_tier: row?.min_tier ?? 'basic',
      min_patch_level: row?.min_patch_level ?? null,
      strict_pairing: row ? row.strict_pairing === 1 : false,
      enforcement_mode: row?.enforcement_mode ?? 'audit',
      updated_at: row?.updated_at ?? null,
      updated_by: row?.updated_by ?? null,
    },
  });
});

adminApiRoutes.put('/merchants/:id/device-policy/enforcement-mode', requireScope('admin'), async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ mode?: string }>();

  const validModes = ['off', 'audit', 'enforce'];
  if (!body.mode || !validModes.includes(body.mode)) {
    return c.json({
      success: false,
      error: { code: 'INVALID_MODE', message: `mode must be one of: ${validModes.join(', ')}` },
    }, 400);
  }

  const mode = body.mode;
  const now = new Date().toISOString();
  const authSubject = Number(c.get('authSubject') ?? 0);

  const previousRow = await c.env.DB.prepare(
    `SELECT enforcement_mode FROM op_merchant_device_policies WHERE merchant_id = ? LIMIT 1`
  ).bind(merchantId).first<{ enforcement_mode: string }>();
  const previousMode = previousRow?.enforcement_mode ?? 'audit';

  await c.env.DB.prepare(
    `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at, updated_by)
     VALUES (?, 'basic', ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       enforcement_mode = excluded.enforcement_mode,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).bind(merchantId, mode, now, authSubject || null).run();

  if (previousMode !== mode) {
    const { metric, page } = await import('../lib/observability');
    metric(c.env, 'device_policy_mode_changed', {
      merchant_id: merchantId,
      value: 1,
      extra: `${previousMode}->${mode}`,
    });
    if (previousMode === 'enforce' && mode === 'audit') {
      page(c.env, 'DEVICE_POLICY_ENFORCE_REVERTED', {
        merchant_id: merchantId,
        previous_mode: previousMode,
        new_mode: mode,
      });
    }
  }

  const updated = await c.env.DB.prepare(
    `SELECT min_tier, min_patch_level, strict_pairing, enforcement_mode, updated_at, updated_by
     FROM op_merchant_device_policies WHERE merchant_id = ? LIMIT 1`
  ).bind(merchantId).first<{
    min_tier: string;
    min_patch_level: string | null;
    strict_pairing: number;
    enforcement_mode: string;
    updated_at: string;
    updated_by: number | null;
  }>();

  return c.json({
    success: true,
    data: {
      min_tier: updated?.min_tier ?? 'basic',
      min_patch_level: updated?.min_patch_level ?? null,
      strict_pairing: updated ? updated.strict_pairing === 1 : false,
      enforcement_mode: updated?.enforcement_mode ?? mode,
      updated_at: updated?.updated_at ?? now,
      updated_by: updated?.updated_by ?? (authSubject || null),
    },
  });
});

adminApiRoutes.put('/merchants/:id/device-policy', requireScope('admin'), async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{
    min_tier?: string;
    min_patch_level?: string | null;
    strict_pairing?: boolean;
    enforcement_mode?: string;
  }>();

  const validTiers = ['basic', 'attested', 'strongbox'];
  const minTier = body.min_tier ?? 'basic';
  if (!validTiers.includes(minTier)) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: `min_tier must be one of: ${validTiers.join(', ')}` },
    }, 400);
  }

  if (body.min_patch_level !== undefined && body.min_patch_level !== null) {
    if (typeof body.min_patch_level !== 'string' || !/^\d{4}-\d{2}$/.test(body.min_patch_level)) {
      return c.json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'min_patch_level must be in YYYY-MM format or null' },
      }, 400);
    }
  }

  const validModes = ['off', 'audit', 'enforce'];
  const enforcementMode = body.enforcement_mode ?? 'audit';
  if (body.enforcement_mode !== undefined && !validModes.includes(body.enforcement_mode)) {
    return c.json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: `enforcement_mode must be one of: ${validModes.join(', ')}` },
    }, 400);
  }

  const strictPairing = body.strict_pairing ? 1 : 0;
  const now = new Date().toISOString();
  const authSubject = Number(c.get('authSubject') ?? 0);

  await c.env.DB.prepare(
    `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, min_patch_level, strict_pairing, enforcement_mode, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       min_tier = excluded.min_tier,
       min_patch_level = excluded.min_patch_level,
       strict_pairing = excluded.strict_pairing,
       enforcement_mode = excluded.enforcement_mode,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  ).bind(merchantId, minTier, body.min_patch_level ?? null, strictPairing, enforcementMode, now, authSubject || null).run();

  return c.json({
    success: true,
    data: {
      min_tier: minTier,
      min_patch_level: body.min_patch_level ?? null,
      strict_pairing: body.strict_pairing ?? false,
      enforcement_mode: enforcementMode,
      updated_at: now,
      updated_by: authSubject || null,
    },
  });
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
  const merchantId = getAuthenticatedMerchantId(c);
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
      merchant_id: merchantId,
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
  const merchantId = getTargetMerchantId(c);
  const { LedgerService } = await import('../services/ledger');
  const ledger = new LedgerService(c.env);
  const [trial, consistency] = await Promise.all([
    ledger.trialBalance(merchantId),
    ledger.verifyDurableObjectConsistency(merchantId),
  ]);
  return c.json({ success: true, data: { trial_balance: trial, consistency } });
});

// Platform check middleware: only platform merchant (is_platform = 1) can manage other tenants (V3-009 typed)
const requirePlatformAdmin: MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> = async (c, next) => {
  const merchantId = c.get('merchantId');
  if (!merchantId) {
    return c.json({ success: false, error: { code: 'FORBIDDEN', message: 'Platform authentication required' } }, 403);
  }
  const row = (await c.env.DB.prepare(
    `SELECT is_platform FROM op_merchants WHERE id = ? LIMIT 1`
  ).bind(merchantId).first()) as { is_platform: number } | null;
  if (!row || row.is_platform !== 1) {
    return c.json({ success: false, error: { code: 'FORBIDDEN', message: 'Platform administrator privileges required' } }, 403);
  }
  return next();
};

// List all merchants (Platform Admin only)
adminApiRoutes.get('/merchants', requireScope('admin'), requirePlatformAdmin, async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, uuid, name, slug, email, timezone, default_currency, status, is_platform, created_at
     FROM op_merchants ORDER BY id ASC`
  ).all();
  return c.json({ success: true, data: rows.results });
});

// One-time credential claim for newly provisioned merchants (Platform Admin only)
adminApiRoutes.post('/merchants/claim', requireScope('admin'), requirePlatformAdmin, async (c) => {
  const body = await c.req.json<{ claim_token?: string }>();
  if (!body.claim_token) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'claim_token is required' } }, 400);
  }
  const key = `claim:${body.claim_token}`;
  const creds = await c.env.KV.get(key);
  if (!creds) {
    return c.json({ success: false, error: { code: 'INVALID_CLAIM', message: 'Claim token is invalid or expired' } }, 404);
  }
  await c.env.KV.delete(key);

  let payloadStr = creds;
  if (!creds.startsWith('{')) {
    if (!c.env.ENCRYPTION_KEY) {
      return c.json({ success: false, error: { code: 'CONFIG_ERROR', message: 'ENCRYPTION_KEY required to decrypt claim payload' } }, 500);
    }
    const { decrypt } = await import('../lib/crypto');
    try {
      payloadStr = await decrypt(creds, c.env.ENCRYPTION_KEY);
    } catch (decErr) {
      console.error('Failed to decrypt claim credentials payload:', decErr);
      return c.json({ success: false, error: { code: 'DECRYPTION_FAILED', message: 'Failed to decrypt claim credentials' } }, 400);
    }
  }

  try {
    const data = JSON.parse(payloadStr);
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: false, error: { code: 'CORRUPT_CLAIM_PAYLOAD', message: 'Claim payload is invalid or corrupt' } }, 400);
  }
});

// Create / Provision a new merchant tenant (Platform Admin only)
adminApiRoutes.post('/merchants', requireScope('admin'), requirePlatformAdmin, async (c) => {
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

    // Provision default Main brand and store hierarchy (Core invariant)
    const { HierarchyService } = await import('../services/hierarchy');
    const hierarchyService = new HierarchyService(c.env.DB);
    const { storeId } = await hierarchyService.provisionDefaultHierarchy(newMerchantId, body.currency ?? 'BDT');

    // 1. Provision default admin user for merchant
    const adminUserUuid = crypto.randomUUID();
    const emailHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.email))))
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const { hashPassword, getPbkdf2Iterations, randomNumericOtp, randomBase64Key, sha256 } = await import('../lib/crypto');
    const initialPassword = crypto.randomUUID() + '!Aa1';
    const passwordHash = await hashPassword(initialPassword, getPbkdf2Iterations(c.env));

    await c.env.DB.prepare(
      `INSERT INTO op_merchant_users
         (merchant_id, uuid, name, email, email_hash, phone, phone_hash, password_hash,
          two_factor_enabled, role_id, status, language, timezone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 0, NULL, 'active', 'en', ?, ?, ?)`
    ).bind(newMerchantId, adminUserUuid, body.name + ' Admin', body.email, emailHash, passwordHash, body.timezone ?? 'Asia/Dhaka', now, now).run();

    const adminUserRow = await c.env.DB.prepare(
      `SELECT id FROM op_merchant_users WHERE uuid = ? LIMIT 1`
    ).bind(adminUserUuid).first<{ id: number }>();
    if (!adminUserRow?.id) throw new Error('Failed to retrieve newly created merchant admin user ID');
    const adminUserId = adminUserRow.id;

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

      // Auto-bind seeded gateway to Main store as a default gate
      if (gwId) {
        await hierarchyService.createGate({
          store_id: storeId,
          merchant_id: newMerchantId,
          gateway_id: gwId,
          label: gw.name,
          currency: body.currency ?? 'BDT',
          mfs_number: defaultPhone ?? null,
        });
      }
    }

    // 5. Seed companion pairing OTP using CSPRNG.
    // Stored as SHA-256 hash only (never plaintext); 5-minute expiry; single-use via used_at.
    const pairingOtp = randomNumericOtp(6);
    const pairingOtpHash = await sha256(pairingOtp);
    const otpExpiresAt = new Date(Date.now() + 300 * 1000).toISOString();
    await c.env.DB.prepare(
      `INSERT INTO op_device_pairing_tokens
         (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(newMerchantId, adminUserId, pairingOtpHash, pairingOtpHash, otpExpiresAt, now).run();

    // 6. Generate One-Time Claim Token for credentials (V3-004 encrypted at rest)
    const claimToken = randomBase64Key(24).replace(/[^a-zA-Z0-9]/g, '');
    const rawClaimPayload = JSON.stringify({
      merchant_id: newMerchantId,
      admin_email: body.email,
      initial_password: initialPassword,
      api_key: apiKey,
      pairing_otp: pairingOtp,
      webhook_secret: webhookSecret,
    });

    if (!c.env.ENCRYPTION_KEY) {
      return c.json({ success: false, error: { code: 'SECURITY_ERROR', message: 'ENCRYPTION_KEY required for secure merchant provisioning' } }, 500);
    }
    const { encrypt } = await import('../lib/crypto');
    let storedClaimPayload: string;
    try {
      storedClaimPayload = await encrypt(rawClaimPayload, c.env.ENCRYPTION_KEY);
    } catch (encErr) {
      console.error('Failed to encrypt claim payload:', encErr);
      return c.json({ success: false, error: { code: 'ENCRYPTION_FAILED', message: 'Failed to encrypt merchant claim credentials' } }, 500);
    }

    await c.env.KV.put(
      `claim:${claimToken}`,
      storedClaimPayload,
      { expirationTtl: 900 }
    );

    return c.json({
      success: true,
      data: {
        merchant_id: newMerchantId,
        uuid: merchantUuid,
        name: body.name,
        slug,
        email: body.email,
        claim_token: claimToken,
        claim_url: `/api/admin/v1/merchants/claim`,
        claim_expires_in: '15 minutes',
        created_at: now,
      }
    }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Merchant provisioning error:', err);
    return c.json({ success: false, error: { code: 'PROVISION_ERROR', message: msg } }, 500);
  }
});

// List all gateways configured for a merchant (Platform Admin only)
adminApiRoutes.get('/merchants/:id/gateways', requireScope('admin'), requirePlatformAdmin, async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }

  const rows = await c.env.DB.prepare(
    `SELECT g.id, g.slug, g.name, g.type, g.status, g.priority, g.supported_currencies,
            mg.account_number, mg.payment_number, mg.account_name
     FROM op_gateways g
     LEFT JOIN op_manual_gateways mg ON mg.gateway_id = g.id
     WHERE g.merchant_id = ?
     ORDER BY g.priority ASC, g.id ASC`
  ).bind(merchantId).all();

  return c.json({ success: true, data: rows.results ?? [] });
});

// List all gates configured for a merchant (Platform Admin only)
adminApiRoutes.get('/merchants/:id/gates', requireScope('admin'), requirePlatformAdmin, async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }

  const rows = await c.env.DB.prepare(
    `SELECT g.*, gw.slug as gateway_slug, gw.type as gateway_type, s.name as store_name
     FROM op_gates g
     JOIN op_gateways gw ON gw.id = g.gateway_id
     JOIN op_stores s ON s.id = g.store_id
     WHERE g.merchant_id = ?
     ORDER BY g.id ASC`
  ).bind(merchantId).all();

  return c.json({ success: true, data: rows.results ?? [] });
});

// Create a gate for a merchant (Platform Admin only)
adminApiRoutes.post('/merchants/:id/gates', requireScope('admin'), requirePlatformAdmin, async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }

  const merchant = await c.env.DB.prepare(
    `SELECT id, default_currency FROM op_merchants WHERE id = ? LIMIT 1`
  ).bind(merchantId).first<{ id: number; default_currency: string }>();
  if (!merchant) {
    return c.json({ success: false, error: { code: 'MERCHANT_NOT_FOUND', message: 'Merchant not found' } }, 404);
  }

  interface CreateGateBody {
    gateway_id?: number;
    store_id?: number;
    label?: string;
    currency?: string;
    mfs_number?: string | null;
  }
  const body: CreateGateBody = await c.req.json<CreateGateBody>().catch(() => ({} as CreateGateBody));

  if (!body.gateway_id) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'gateway_id is required' } }, 400);
  }

  const gw = await c.env.DB.prepare(
    `SELECT id, name FROM op_gateways WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(body.gateway_id, merchantId).first<{ id: number; name: string }>();
  if (!gw) {
    return c.json({ success: false, error: { code: 'GATEWAY_NOT_FOUND', message: 'Gateway not found for this merchant' } }, 404);
  }

  const { HierarchyService } = await import('../services/hierarchy');
  const svc = new HierarchyService(c.env.DB);

  let storeId = body.store_id;
  if (!storeId) {
    const mainStore = await svc.resolveMainStore(merchantId);
    if (!mainStore) {
      return c.json({ success: false, error: { code: 'STORE_NOT_FOUND', message: 'Merchant has no default Main store' } }, 404);
    }
    storeId = mainStore.id;
  } else {
    const store = await svc.getStore(storeId, merchantId);
    if (!store) {
      return c.json({ success: false, error: { code: 'STORE_NOT_FOUND', message: 'Store not found for this merchant' } }, 404);
    }
  }

  const label = body.label?.trim() || gw.name;
  const currency = body.currency || merchant.default_currency || 'BDT';

  const gate = await svc.createGate({
    store_id: storeId,
    merchant_id: merchantId,
    gateway_id: body.gateway_id,
    label,
    currency,
    mfs_number: body.mfs_number ?? null,
  });

  return c.json({ success: true, data: gate }, 201);
});

// ---------------------------------------------------------------
// GET /api/admin/v1/merchants/:id/devices/:deviceId/policy-override
// ---------------------------------------------------------------
adminApiRoutes.get('/merchants/:id/devices/:deviceId/policy-override', requireScope('admin'), async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const deviceId = parseInt(c.req.param('deviceId'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' } }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT id, authorized_by, authorized_at, reason, acknowledged_tier,
            required_tier, expires_at, revoked_at, revoked_by, revocation_reason
     FROM op_device_policy_overrides
     WHERE merchant_id = ? AND device_id = ?
     ORDER BY id DESC
     LIMIT 1`
  ).bind(merchantId, deviceId).first();
  return c.json({ success: true, data: row ?? null });
});

// ---------------------------------------------------------------
// POST /api/admin/v1/merchants/:id/devices/:deviceId/policy-override
// ---------------------------------------------------------------
adminApiRoutes.post('/merchants/:id/devices/:deviceId/policy-override', requireScope('admin'), async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const deviceId = parseInt(c.req.param('deviceId'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' } }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown; expires_in_days?: unknown };
  const authType = c.get('authType');
  const authSubject = Number(c.get('authSubject') ?? 0);

  let authorizedBy: number | null = null;
  if (authType === 'bearer' && authSubject > 0) {
    const keyRow = await c.env.DB.prepare(
      `SELECT created_by FROM op_api_keys WHERE id = ? LIMIT 1`
    ).bind(authSubject).first<{ created_by: number | null }>();
    authorizedBy = keyRow?.created_by ?? null;
  } else {
    authorizedBy = authSubject || null;
  }

  if (!authorizedBy) {
    return c.json({
      success: false,
      error: { code: 'NO_ACTOR_RESOLVED', message: 'Cannot attribute this action to a user' },
    }, 400);
  }

  const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
  const userAgent = c.req.header('user-agent') || null;

  const res = await grantDeviceOverride(c.env.DB, c.env, {
    merchantId,
    deviceId,
    authorizedBy,
    actorType: 'admin',
    reason: body.reason,
    expiresInDays: body.expires_in_days,
    ipAddress,
    userAgent,
  });

  if (!res.success) {
    return c.json({ success: false, error: res.error }, res.status as 400 | 403 | 404 | 409 | 429 | 500);
  }

  return c.json({ success: true, data: res.data }, 201);
});

// ---------------------------------------------------------------
// POST /api/admin/v1/merchants/:id/devices/:deviceId/policy-override/revoke
// ---------------------------------------------------------------
adminApiRoutes.post('/merchants/:id/devices/:deviceId/policy-override/revoke', requireScope('admin'), async (c) => {
  const merchantId = parseInt(c.req.param('id'), 10);
  const deviceId = parseInt(c.req.param('deviceId'), 10);
  if (!Number.isInteger(merchantId) || merchantId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_MERCHANT_ID', message: 'merchant_id must be a positive integer' } }, 400);
  }
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' } }, 400);
  }

  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const authType = c.get('authType');
  const authSubject = Number(c.get('authSubject') ?? 0);

  let revokedBy: number | null = null;
  if (authType === 'bearer' && authSubject > 0) {
    const keyRow = await c.env.DB.prepare(
      `SELECT created_by FROM op_api_keys WHERE id = ? LIMIT 1`
    ).bind(authSubject).first<{ created_by: number | null }>();
    revokedBy = keyRow?.created_by ?? null;
  } else {
    revokedBy = authSubject || null;
  }

  if (!revokedBy) {
    return c.json({
      success: false,
      error: { code: 'NO_ACTOR_RESOLVED', message: 'Cannot attribute this action to a user' },
    }, 400);
  }

  const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
  const userAgent = c.req.header('user-agent') || null;

  const res = await revokeDeviceOverride(c.env.DB, c.env, {
    merchantId,
    deviceId,
    revokedBy,
    actorType: 'admin',
    reason: body.reason,
    ipAddress,
    userAgent,
  });

  if (!res.success) {
    return c.json({ success: false, error: res.error }, res.status as 400 | 403 | 404 | 409 | 429 | 500);
  }

  return c.json({ success: true, data: res.data }, 200);
});
