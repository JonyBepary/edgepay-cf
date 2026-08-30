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

  // Invalidate KV domain cache
  await c.env.KV.delete(`domain:${body.domain}`);

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
  return c.json({ success: true, data: rows });
});

adminApiRoutes.put('/sms-templates/:id', requireScope('admin'), async (c) => {
  const merchantId = c.get('merchantId')!;
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json<{ regex_pattern?: string; status?: string }>();

  await c.env.DB.prepare(

    `UPDATE op_sms_templates SET regex_pattern = ?, status = ?, updated_at = ? WHERE id = ? AND merchant_id = ?`
).bind(body.regex_pattern, body.status ?? 'active', new Date().toISOString(), id, merchantId).run();

  return c.json({ success: true });
});

// Devices
adminApiRoutes.get('/devices', async (c) => {
  const merchantId = c.get('merchantId')!;
  const rows = await c.env.DB.prepare(

    `SELECT id, uuid, device_name, status, last_heartbeat_at, created_at
     FROM op_paired_devices WHERE merchant_id = ? ORDER BY created_at DESC`
).bind(merchantId).all();
  return c.json({ success: true, data: rows });
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
  return c.json({ success: true, data: rows });
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
