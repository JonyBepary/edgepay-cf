/**
 * Merchant API routes — `/api/v1/*`
 *
 * Authenticated via Bearer API keys. Three scopes: read, write, admin.
 * All routes require a merchant_id context (from domain middleware or
 * resolved from the API key).
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { requireBearerApiAuth, requireScope, getAuthenticatedMerchantId, type ApiVariables } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { createIdempotencyMiddleware, idempotencyMiddleware } from '../middleware/idempotency';
import { PaymentService } from '../services/payment';
import { ValidationError } from '../lib/error';
import { createPaymentSchema, createRefundSchema } from '../lib/validation';
import { gatewayRegistry, gatewaySelection, catalogCounts, catalogFind } from '../gateways';
import { GatewayNotPortedError } from '../gateways/planned';
import { RefundNotSupportedError } from '../services/refund';
import type { WebhookMessage } from '../types/env';
import { zValidator } from '@hono/zod-validator';
import { randomToken } from '../lib/crypto';
import {
  resolvePolicy,
  computeDeviceTier,
  TIER_RANK,
  grantDeviceOverride,
  revokeDeviceOverride,
} from '../services/device-policy';

export const apiRoutes = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

// All routes require bearer auth with read, write, or admin scope
apiRoutes.use('*', requireBearerApiAuth(['read', 'write', 'admin']));

// Enforce write scope on all mutating HTTP methods (POST, PUT, PATCH, DELETE) — EDGE-P1-008 / V3-009 fix
apiRoutes.use('*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    return requireScope('write')(c, next);
  }
  return next();
});

// Per-API-KEY rate limiting via the native Ratelimit binding (mounted
// AFTER auth so the counter keys on the api key id, not the IP)
apiRoutes.use('*', rateLimitMiddleware);

// ---------------------------------------------------------------
// POST /api/v1/payments — initiate a new payment
// v0.2.2 (audit P2): zod-validated body (typed c.req.valid('json'));
// failures map onto the pre-existing 400 VALIDATION_ERROR contract.
// ---------------------------------------------------------------
apiRoutes.post(
  '/payments',
  idempotencyMiddleware,
  zValidator('json', createPaymentSchema, (result, _c) => {
    if (!result.success) {
      throw new ValidationError('Request body validation failed', result.error.issues);
    }
  }),
  async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);

  const body = c.req.valid('json');

  const service = new PaymentService(c.env);
  const result = await service.createIntent({
    merchant_id: merchantId as number,
    amount: body.amount,
    currency: body.currency.toUpperCase(),
    description: body.description,
    customer: body.customer,
    gateway_id: body.gateway_id,
    gateway: body.gateway || body.gateway_slug,
    metadata: body.metadata,
    expires_in_seconds: body.expires_in_seconds,
  });

  return c.json({
    success: true,
    data: {
      intent_id: result.intent_id,
      token: result.token,
      checkout_url: result.checkout_url,
    },
  }, 201);
  },
);

// ---------------------------------------------------------------
// GET /api/v1/payments — list payments for merchant console
// ---------------------------------------------------------------
apiRoutes.get('/payments', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const status = c.req.query('status');

  let sql = `SELECT t.id, t.trx_id, t.amount, t.currency, t.status,
                    t.created_at, t.updated_at,
                    g.slug AS gateway_slug, g.name AS gateway_name
             FROM op_transactions t
             LEFT JOIN op_gateways g ON g.id = t.gateway_id
             WHERE t.merchant_id = ?`;
  const params: unknown[] = [merchantId];

  if (status) {
    sql += ` AND t.status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY t.id DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  const paymentList = ((rows.results || []) as Record<string, unknown>[]).map((p) => {
    const rawAmount = typeof p.amount === 'string' ? parseFloat(p.amount) : typeof p.amount === 'number' ? p.amount : 0;
    const createdAt = typeof p.created_at === 'string' ? p.created_at : new Date().toISOString();
    const minAgo = Math.max(0, Math.round((Date.now() - new Date(createdAt).getTime()) / 60000));
    // Server-resolved rail — never hardcoded: the gateway slug recorded
    // on the transaction selects the rail, with its display name as label.
    const rail = typeof p.gateway_slug === 'string' && p.gateway_slug ? p.gateway_slug : 'unknown';
    const railLabel = typeof p.gateway_name === 'string' && p.gateway_name ? p.gateway_name : rail;
    return {
      id: typeof p.trx_id === 'string' && p.trx_id ? p.trx_id : 'edgepay_trx_' + String(p.id),
      rail,
      rail_label: railLabel,
      amount: rawAmount,
      status: (p.status as string) || 'completed',
      minutes: minAgo,
      created_at: createdAt,
    };
  });

  return c.json({ success: true, payments: paymentList, data: paymentList });
});

// ---------------------------------------------------------------
// GET /api/v1/payments/{payment_id} — fetch a payment intent
// ---------------------------------------------------------------
apiRoutes.get('/payments/:payment_id', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const paymentId = parseInt(c.req.param('payment_id'), 10);

  const intent = await c.env.DB.prepare(

    `SELECT id, uuid, token, amount, currency, description, status,
            metadata, expires_at, completed_at, created_at
     FROM op_payment_intents
     WHERE id = ? AND merchant_id = ?
     LIMIT 1`
).bind(paymentId, merchantId).first();

  if (!intent) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Payment not found' } }, 404);
  }

  return c.json({ success: true, data: intent });
});

// ---------------------------------------------------------------
// GET /api/v1/transactions — list transactions
// ---------------------------------------------------------------
apiRoutes.get('/transactions', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);
  const offset = parseInt(c.req.query('offset') ?? '0', 10);
  const status = c.req.query('status');

  let sql = `SELECT id, trx_id, gateway_id, gateway_trx_id, amount, currency,
                    fee, net_amount, status, gateway_type, created_at, updated_at
             FROM op_transactions WHERE merchant_id = ?`;
  const params: unknown[] = [merchantId];

  if (status) {
    sql += ` AND status = ?`;
    params.push(status);
  }
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ success: true, data: rows.results });
});

// ---------------------------------------------------------------
// GET /api/v1/transactions/{trx_id} — fetch a transaction
// ---------------------------------------------------------------
apiRoutes.get('/transactions/:trx_id', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const trxId = c.req.param('trx_id');

  const tx = await c.env.DB.prepare(

    `SELECT * FROM op_transactions WHERE trx_id = ? AND merchant_id = ? LIMIT 1`
).bind(trxId, merchantId).first();

  if (!tx) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } }, 404);
  }

  return c.json({ success: true, data: tx });
});

// ---------------------------------------------------------------
// POST /api/v1/refunds — issue a refund
// v0.2.2 (audit P2): zod-validated body (typed c.req.valid('json'));
// failures map onto the pre-existing 400 VALIDATION_ERROR contract.
// v0.3.x: idempotency is REQUIRED for refunds (X-Idempotency-Key) to
// prevent double-refund on retry; uses the same D1 idempotency table as
// payments (tenant-scoped, body-hash checked, 4xx not cached, concurrent-safe).
// ---------------------------------------------------------------
apiRoutes.post(
  '/refunds',
  createIdempotencyMiddleware({ required: true }),
  requireScope('write'),
  zValidator('json', createRefundSchema, (result, _c) => {
    if (!result.success) {
      throw new ValidationError('Request body validation failed', result.error.issues);
    }
  }),
  async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const body = c.req.valid('json');

  const tx = await c.env.DB.prepare(

    `SELECT t.id, t.trx_id, t.amount, t.currency, t.status, g.slug AS gateway_slug, t.gateway_trx_id
     FROM op_transactions t
     JOIN op_gateways g ON g.id = t.gateway_id
     WHERE t.trx_id = ? AND t.merchant_id = ?
     LIMIT 1`
  ).bind(body.transaction_id, merchantId).first<{
    id: number;
    trx_id: string;
    amount: string;
    currency: string;
    status: string;
    gateway_slug: string;
    gateway_trx_id: string;
  }>();

  if (!tx) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Transaction not found' } }, 404);
  }

  if (tx.status !== 'completed') {
    throw new ValidationError(`Cannot refund transaction with status: ${tx.status}`);
  }

  const refundAmount = body.amount ?? tx.amount;

  // v0.2.3: NEW refunds are gated by ENABLED_GATEWAYS.
  if (!gatewaySelection(c.env.ENABLED_GATEWAYS).enabled.includes(tx.gateway_slug)) {
    return c.json({
      success: false,
      error: {
        code: 'GATEWAY_DISABLED',
        message: `Gateway '${tx.gateway_slug}' is not enabled on this deployment (ENABLED_GATEWAYS).`,
      },
    }, 422);
  }

  const { RefundService } = await import('../services/refund');
  const refundService = new RefundService(c.env);
  
  try {
    const result = await refundService.createRefund({
      merchant_id: merchantId,
      transaction_id: tx.id,
      amount: refundAmount,
      reason: body.reason,
      initiated_by: c.get('authSubject') as number | null ?? null,
    });

    return c.json({
      success: true,
      data: {
        refund_id: result.refund_id,
        transaction_id: tx.trx_id,
        amount: refundAmount,
        currency: tx.currency,
        status: 'pending',
        gateway_refund_id: result.gateway_refund_id,
        workflow_instance_id: result.workflow_instance_id,
      },
    }, 202);
  } catch (err) {
    // Typed fail-closed errors keep their codes — an unsupported refund
    // is 422 REFUND_NOT_SUPPORTED (not generic), a quarantined gateway
    // is 422 GATEWAY_NOT_PORTED (not a silent stub resolution).
    if (err instanceof RefundNotSupportedError) {
      return c.json({
        success: false,
        error: { code: 'REFUND_NOT_SUPPORTED', message: err.message },
      }, 422);
    }
    if (err instanceof GatewayNotPortedError) {
      return c.json({
        success: false,
        error: { code: 'GATEWAY_NOT_PORTED', message: err.message },
      }, 422);
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({
      success: false,
      error: { code: 'REFUND_REJECTED', message },
    }, 422);
  }
  },
);

// ---------------------------------------------------------------
// GET /api/v1/refunds/:id — refund status (bearer-scoped to merchant)
// ---------------------------------------------------------------
apiRoutes.get('/refunds/:id', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const refundId = c.req.param('id');

  const row = await c.env.DB.prepare(
    `SELECT r.refund_id, r.amount, r.currency, r.reason, r.status,
            r.gateway_refund_id, r.transaction_id,
            t.trx_id AS transaction_trx_id, r.created_at, r.updated_at
     FROM op_refunds r
     LEFT JOIN op_transactions t ON t.id = r.transaction_id
     WHERE r.refund_id = ? AND r.merchant_id = ?
     LIMIT 1`
  ).bind(refundId, merchantId).first();

  if (!row) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Refund not found' } }, 404);
  }

  return c.json({ success: true, data: row });
});

// ---------------------------------------------------------------
// GET /api/v1/customers — list customers
// ---------------------------------------------------------------
apiRoutes.get('/customers', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '20', 10), 100);

  const rows = await c.env.DB.prepare(

    `SELECT id, uuid, created_at FROM op_customers WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?`
).bind(merchantId, limit).all();

  return c.json({ success: true, data: rows.results });
});

// ---------------------------------------------------------------
// GET /api/v1/api-keys — list current merchant's API keys
// ---------------------------------------------------------------
apiRoutes.get('/api-keys', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const rows = await c.env.DB.prepare(

    `SELECT id, name, key_prefix, scopes, status, last_used_at, expires_at, created_at
     FROM op_api_keys
     WHERE merchant_id = ?
     ORDER BY created_at DESC`
).bind(merchantId).all();

  return c.json({ success: true, data: rows.results });
});

// ---------------------------------------------------------------
// POST /api/v1/api-keys — generate a new API key (returns the secret ONCE)
// ---------------------------------------------------------------
apiRoutes.post('/api-keys', requireScope('admin'), async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const body = await c.req.json<{ name?: string; scopes?: string[] }>();

  if (!body.name) throw new ValidationError('name is required');
  const scopes = body.scopes ?? ['read', 'write'];

  // Generate key: op_live_<prefix>_<rest>
  const prefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const rest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const apiKey = `op_live_${prefix}_${rest}`;
  const { sha256 } = await import('../lib/crypto');
  const keyHash = await sha256(apiKey);

  await c.env.DB.prepare(

    `INSERT INTO op_api_keys
       (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
).bind(merchantId,
      body.name,
      prefix,
      keyHash,
      JSON.stringify(scopes),
      c.get('authSubject') ?? 0,
      new Date().toISOString(),).run();

  return c.json({
    success: true,
    data: {
      api_key: apiKey,    // Only returned ONCE at creation
      key_prefix: prefix,
      scopes,
    },
  }, 201);
});

// ---------------------------------------------------------------
// PATCH /api/v1/api-keys/:id — revoke an API key (admin scope)
// Idempotent: revoking an already-revoked key succeeds.
// ---------------------------------------------------------------
apiRoutes.patch('/api-keys/:id', requireScope('admin'), async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid API key id');

  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM op_api_keys WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(id, merchantId).first<{ id: number; status: string }>();

  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'API key not found' } }, 404);
  }

  if (existing.status !== 'revoked') {
    await c.env.DB.prepare(
      `UPDATE op_api_keys SET status = 'revoked' WHERE id = ? AND merchant_id = ?`
    ).bind(id, merchantId).run();
  }

  return c.json({ success: true, data: { id, status: 'revoked' } });
});

// ---------------------------------------------------------------
// DELETE /api/v1/api-keys/:id — revoke alias (admin scope)
// Frontend merchant island issues DELETE; canonical revoke is PATCH
// above. Same handler semantics: idempotent, merchant-scoped, 404
// when the key does not belong to this merchant.
// ---------------------------------------------------------------
apiRoutes.delete('/api-keys/:id', requireScope('admin'), async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid API key id');

  const existing = await c.env.DB.prepare(
    `SELECT id, status FROM op_api_keys WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(id, merchantId).first<{ id: number; status: string }>();

  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'API key not found' } }, 404);
  }

  if (existing.status !== 'revoked') {
    await c.env.DB.prepare(
      `UPDATE op_api_keys SET status = 'revoked' WHERE id = ? AND merchant_id = ?`
    ).bind(id, merchantId).run();
  }

  return c.json({ success: true, data: { id, status: 'revoked' } });
});

// ---------------------------------------------------------------
// POST /api/v1/api-keys/:id/rotate — rotate an API key (admin scope)
//
// Atomic: the replacement key is inserted and the old key revoked in a
// single D1 batch, with the revoke conditional on the old key still
// being active (concurrent rotations can't double-issue). The new
// secret is returned ONCE. Revocation is immediate: the op_api_keys
// schema has no replaced_by column for a grace window.
// ---------------------------------------------------------------
apiRoutes.post('/api-keys/:id/rotate', requireScope('admin'), async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid API key id');

  const existing = await c.env.DB.prepare(
    `SELECT id, name, scopes, status FROM op_api_keys WHERE id = ? AND merchant_id = ? LIMIT 1`
  ).bind(id, merchantId).first<{ id: number; name: string; scopes: string; status: string }>();

  if (!existing) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'API key not found' } }, 404);
  }

  if (existing.status !== 'active') {
    return c.json({
      success: false,
      error: { code: 'API_KEY_NOT_ACTIVE', message: `Only active keys can be rotated (status: ${existing.status})` },
    }, 422);
  }

  let scopes: string[];
  try {
    scopes = JSON.parse(existing.scopes || '[]') as string[];
  } catch {
    scopes = ['read', 'write'];
  }

  const prefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const rest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const apiKey = `op_live_${prefix}_${rest}`;
  const { sha256 } = await import('../lib/crypto');
  const keyHash = await sha256(apiKey);
  const now = new Date().toISOString();

  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO op_api_keys
         (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(merchantId, existing.name, prefix, keyHash, JSON.stringify(scopes), c.get('authSubject') ?? 0, now),
    c.env.DB.prepare(
      `UPDATE op_api_keys SET status = 'revoked' WHERE id = ? AND merchant_id = ? AND status = 'active'`
    ).bind(id, merchantId),
  ]);

  if (!results[1]?.meta?.changes) {
    return c.json({
      success: false,
      error: { code: 'CONFLICT', message: 'API key was modified concurrently; fetch the current key list and retry' },
    }, 409);
  }

  return c.json({
    success: true,
    data: {
      id: results[0]?.meta?.last_row_id,
      api_key: apiKey,    // Only returned ONCE at rotation
      key_prefix: prefix,
      scopes,
      rotated_from: id,
      revocation: 'immediate',
    },
  }, 201);
});

// ---------------------------------------------------------------
// GET /api/v1/webhooks — list merchant webhooks
// ---------------------------------------------------------------
apiRoutes.get('/webhooks', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const rows = await c.env.DB.prepare(
    `SELECT id, url, events, status, created_at, updated_at
     FROM op_webhooks
     WHERE merchant_id = ?
     ORDER BY created_at DESC`
  ).bind(merchantId).all();
  return c.json({ success: true, data: rows.results });
});

// ---------------------------------------------------------------
// POST /api/v1/webhooks — register a webhook
// ---------------------------------------------------------------
apiRoutes.post('/webhooks', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const body = await c.req.json<{ url?: string; events?: string[] }>();
  if (!body.url) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'url is required' } }, 400);
  }

  const { isAllowedWebhookUrl } = await import('../lib/url-guard');
  if (!isAllowedWebhookUrl(body.url, c.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
    return c.json({ success: false, error: { code: 'INVALID_URL', message: 'Webhook URL must be a valid public HTTPS endpoint' } }, 400);
  }

  const secret = `whsec_${randomToken(24)}`;
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    `INSERT INTO op_webhooks (merchant_id, url, secret, events, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind(merchantId, body.url, JSON.stringify(body.events || ['*']), now, now).run();
  
  return c.json({
    success: true,
    data: {
      id: res.meta?.last_row_id,
      url: body.url,
      secret,
      events: body.events || ['*'],
      status: 'active'
    }
  }, 201);
});

// ---------------------------------------------------------------
// DELETE /api/v1/webhooks/{id} — delete a webhook
// ---------------------------------------------------------------
apiRoutes.delete('/webhooks/:id', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const id = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare(
    `DELETE FROM op_webhooks WHERE id = ? AND merchant_id = ?`
  ).bind(id, merchantId).run();
  return c.json({ success: true });
});

// ---------------------------------------------------------------
// POST /api/v1/webhooks/tests — send a test webhook
// ---------------------------------------------------------------
apiRoutes.post('/webhooks/tests', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  let body: { url?: string } = {};
  try { body = await c.req.json(); } catch { /* optional body */ }

  if (body?.url) {
    const { isAllowedWebhookUrl } = await import('../lib/url-guard');
    if (!isAllowedWebhookUrl(body.url, c.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
      return c.json({ success: false, error: { code: 'INVALID_URL', message: 'Webhook URL must be a valid public HTTPS endpoint' } }, 400);
    }
  }

  const { WebhookDispatcher } = await import('../services/webhook-dispatcher');
  const dispatcher = new WebhookDispatcher(c.env);
  const result = await dispatcher.sendTest(merchantId as number, body?.url);
  return c.json({ success: result.success, error: result.error });
});

// ---------------------------------------------------------------
// GET /api/v1/webhooks/deliveries — recent webhook deliveries
// ---------------------------------------------------------------
apiRoutes.get('/webhooks/deliveries', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);

  const rows = await c.env.DB.prepare(

    `SELECT id, event, url, direction, status_code, response_time_ms, attempt, status, created_at
     FROM op_webhook_deliveries
     WHERE merchant_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
).bind(merchantId, limit).all();

  return c.json({ success: true, data: rows.results });
});

// ---------------------------------------------------------------
// POST /api/v1/webhooks/deliveries/:id/retry — re-enqueue a failed
// outbound delivery onto WEBHOOK_QUEUE (bearer-scoped to merchant).
// Only outbound deliveries with a live endpoint (for the HMAC secret)
// can be retried; the delivery flips to 'retrying' with attempt + 1.
// ---------------------------------------------------------------
apiRoutes.post('/webhooks/deliveries/:id/retry', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) throw new ValidationError('Invalid delivery id');

  const delivery = await c.env.DB.prepare(
    `SELECT id, event, url, direction, attempt, status
     FROM op_webhook_deliveries
     WHERE id = ? AND merchant_id = ?
     LIMIT 1`
  ).bind(id, merchantId).first<{
    id: number; event: string; url: string; direction: string; attempt: number; status: string;
  }>();

  if (!delivery) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Delivery not found' } }, 404);
  }

  if (delivery.direction !== 'outbound') {
    return c.json({
      success: false,
      error: { code: 'CANNOT_RETRY_INBOUND', message: 'Only outbound deliveries can be retried' },
    }, 422);
  }

  const endpoint = await c.env.DB.prepare(
    `SELECT id, secret FROM op_webhooks WHERE merchant_id = ? AND url = ? LIMIT 1`
  ).bind(merchantId, delivery.url).first<{ id: number; secret: string }>();

  if (!endpoint) {
    return c.json({
      success: false,
      error: { code: 'WEBHOOK_ENDPOINT_MISSING', message: 'No active endpoint for this delivery URL; re-register the webhook first' },
    }, 422);
  }

  const message: WebhookMessage = {
    webhook_id: endpoint.id,
    merchant_id: merchantId as number,
    url: delivery.url,
    secret: endpoint.secret,
    event: delivery.event,
    payload: {
      event: delivery.event,
      redelivery_of: delivery.id,
      retried_at: new Date().toISOString(),
    },
    attempt: delivery.attempt + 1,
  };

  await c.env.WEBHOOK_QUEUE.send(message);
  await c.env.DB.prepare(
    `UPDATE op_webhook_deliveries SET status = 'retrying', attempt = attempt + 1 WHERE id = ? AND merchant_id = ?`
  ).bind(id, merchantId).run();

  return c.json({
    success: true,
    data: { id, status: 'retrying', attempt: delivery.attempt + 1 },
  });
});

// ---------------------------------------------------------------
// GET /api/v1/gateways — gateway-plugin catalog for THIS deployment
//
// v0.2.3: reflects the ENABLED_GATEWAYS platform gate so integrators
// and the admin UI can render exactly what this deployment can use:
// which adapters are enabled (with their credential field definitions —
// names/labels only, never values), which aliases were dropped as
// unrecognized (typo feedback), and how many adapters remain pending
// in the port backlog. Auth: any bearer key (read scope suffices).
// ---------------------------------------------------------------
apiRoutes.get('/gateways', async (c) => {
  const selection = gatewaySelection(c.env.ENABLED_GATEWAYS);

  // Quarantine: planned (not-yet-ported) adapters stay hidden unless the
  // caller explicitly opts in with ?include=planned. Explicit opt-in only
  // lists them with status 'planned' — operations against them still fail
  // closed (GatewayNotPortedError / 422) via assertGatewayPorted.
  const includeTokens = (c.req.query('include') ?? '')
    .split(/[,;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const includePlanned = includeTokens.includes('planned');

  const entries = selection.enabled
    .filter((slug) => gatewayRegistry.has(slug))
    .map((slug) => {
      const adapter = gatewayRegistry.resolve(slug);
      const meta = adapter.metadata();
      return {
        slug: meta.slug,
        name: meta.name,
        version: meta.version,
        description: meta.description,
        supported_currencies: meta.supported_currencies,
        capabilities: meta.capabilities,
        // catalog status: implemented | ported | planned (planned adapters
        // reject payments with a clear error until their port lands)
        status: catalogFind(slug)?.status ?? 'ported',
        config_fields: adapter.fields().map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          required: f.required,
        })),
      };
    });

  const planned_count = entries.filter((e) => e.status === 'planned').length;
  const enabled = includePlanned ? entries : entries.filter((e) => e.status !== 'planned');

  return c.json({
    success: true,
    data: {
      enabled,
      all_enabled: selection.allEnabled,
      dropped_aliases: selection.dropped,
      catalog: catalogCounts(),
      planned_count,
    },
  });
});

// ---------------------------------------------------------------
// GET /api/v1/merchant/summary — bearer-scoped merchant overview:
// today's revenue / transaction count / pending count plus the 5 most
// recent transactions. Reuses the mobile dashboard SQL.
// ---------------------------------------------------------------
apiRoutes.get('/merchant/summary', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);

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

// ---------------------------------------------------------------
// GET /api/v1/devices — merchant-scoped devices with security tier
// ---------------------------------------------------------------
apiRoutes.get('/devices', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const devices = await c.env.DB.prepare(
    `SELECT d.id, d.uuid, d.device_name, d.status, d.public_key, d.key_algorithm,
            d.attestation_verified_at, d.attestation_strong, d.attestation_verified_boot,
            d.device_os_version, d.device_patch_level, d.last_heartbeat_at, d.created_at,
            p.min_tier, p.min_patch_level, p.strict_pairing
     FROM op_paired_devices d
     LEFT JOIN op_merchant_device_policies p ON p.merchant_id = d.merchant_id
     WHERE d.merchant_id = ?
     ORDER BY d.created_at DESC`
  ).bind(merchantId).all<{
    id: number;
    uuid: string;
    device_name: string;
    status: string;
    public_key: string | null;
    key_algorithm: string | null;
    attestation_verified_at: string | null;
    attestation_strong: number;
    attestation_verified_boot: number;
    device_os_version: number | null;
    device_patch_level: string | null;
    last_heartbeat_at: string;
    created_at: string;
    min_tier: string | null;
    min_patch_level: string | null;
    strict_pairing: number | null;
  }>();

  const maxAttestationAgeMs = parseInt(c.env.ATTESTATION_MAX_AGE_DAYS || '30', 10) * 86400000;
  const allowUnverifiedBoot = c.env.ATTESTATION_ALLOW_UNVERIFIED_BOOT === 'true';

  const enriched = (devices.results ?? []).map((d) => {
    const policy = resolvePolicy(c.env, d);
    const tierInfo = computeDeviceTier(d, policy, { maxAttestationAgeMs, allowUnverifiedBoot });
    const satisfied = TIER_RANK[tierInfo.tier] >= TIER_RANK[policy.min_tier];
    return {
      id: d.id,
      device_name: d.device_name,
      tier: tierInfo.tier,
      tier_reason: tierInfo.reason ?? null,
      policy_required_tier: policy.min_tier,
      policy_satisfied: satisfied,
      attestation: {
        verified_at: d.attestation_verified_at,
        strong: d.attestation_strong === 1,
        verified_boot: d.attestation_verified_boot === 1,
        patch_level: d.device_patch_level,
        os_version: d.device_os_version,
      },
      last_heartbeat_at: d.last_heartbeat_at,
      status: d.status,
    };
  });

  return c.json({ success: true, data: enriched });
});

// ---------------------------------------------------------------
// GET /api/v1/device-policy — merchant-scoped trust policy
// ---------------------------------------------------------------
apiRoutes.get('/device-policy', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
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

// ---------------------------------------------------------------
// GET /api/v1/device-policy/compliance — compliance aggregation
// ---------------------------------------------------------------
apiRoutes.get('/device-policy/compliance', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const daysParam = parseInt(c.req.query('days') ?? '30', 10);
  const days = Math.min(Math.max(isNaN(daysParam) ? 30 : daysParam, 1), 90);

  const stats = await c.env.DB.prepare(
    `SELECT required_tier, achieved_tier, compliant, SUM(evaluation_count) AS count
     FROM op_device_policy_daily_stats
     WHERE merchant_id = ?
       AND day >= date('now', '-' || ? || ' days')
     GROUP BY required_tier, achieved_tier, compliant
     ORDER BY count DESC`
  ).bind(merchantId, String(days)).all<{
    required_tier: string;
    achieved_tier: string;
    compliant: number;
    count: number;
  }>();

  const byTier = (stats.results ?? []).map((r) => ({
    required_tier: r.required_tier,
    achieved_tier: r.achieved_tier,
    compliant: r.compliant,
    count: Number(r.count),
  }));

  const totalEvaluations = byTier.reduce((sum, r) => sum + r.count, 0);
  const compliantEvaluations = byTier.filter((r) => r.compliant === 1).reduce((sum, r) => sum + r.count, 0);
  const complianceRate = totalEvaluations > 0 ? Number((compliantEvaluations / totalEvaluations).toFixed(4)) : null;

  return c.json({
    success: true,
    data: {
      window_days: days,
      by_tier: byTier,
      compliance_rate: complianceRate,
      compliant_evaluations: compliantEvaluations,
      total_evaluations: totalEvaluations,
    },
  });
});

// ---------------------------------------------------------------
// PUT /api/v1/device-policy/enforcement-mode — update enforcement mode
// ---------------------------------------------------------------
apiRoutes.put('/device-policy/enforcement-mode', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
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

// ---------------------------------------------------------------
// PUT /api/v1/device-policy — configure merchant trust policy
// ---------------------------------------------------------------
apiRoutes.put('/device-policy', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
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

// ---------------------------------------------------------------
// GET /api/v1/devices/:id/policy-override
// ---------------------------------------------------------------
apiRoutes.get('/devices/:id/policy-override', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const deviceId = parseInt(c.req.param('id'), 10);
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
// POST /api/v1/devices/:id/policy-override
// ---------------------------------------------------------------
apiRoutes.post('/devices/:id/policy-override', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const deviceId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' } }, 400);
  }

  // Caller role check: owner or admin required
  // EdgePay-CF does not model owner/admin/read/write as user roles; authorization
  // is scope-based (op_api_keys.scopes). Override management requires the `admin`
  // scope, which is the closest equivalent to an "owner or admin" role. A future
  // role model can replace this check without changing the endpoint contract.
  const scopes = c.get('authScopes') ?? [];
  if (!scopes.includes('*') && !scopes.includes('admin')) {
    return c.json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } }, 403);
  }

  const authType = c.get('authType'); // 'bearer' | 'jwt' | ...
  const authSubject = Number(c.get('authSubject') ?? 0);

  let authorizedBy: number | null = null;
  if (authType === 'bearer' && authSubject > 0) {
    // API key ID → creator user ID
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

  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown; expires_in_days?: unknown };
  const actorType = c.get('authType') === 'bearer' ? 'api_key' : 'admin';
  const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
  const userAgent = c.req.header('user-agent') || null;

  const res = await grantDeviceOverride(c.env.DB, c.env, {
    merchantId,
    deviceId,
    authorizedBy,
    actorType,
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
// POST /api/v1/devices/:id/policy-override/revoke
// ---------------------------------------------------------------
apiRoutes.post('/devices/:id/policy-override/revoke', async (c) => {
  const merchantId = getAuthenticatedMerchantId(c);
  const deviceId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return c.json({ success: false, error: { code: 'INVALID_DEVICE_ID', message: 'deviceId must be a positive integer' } }, 400);
  }

  // Caller role check: owner or admin required
  // EdgePay-CF does not model owner/admin/read/write as user roles; authorization
  // is scope-based (op_api_keys.scopes). Override management requires the `admin`
  // scope, which is the closest equivalent to an "owner or admin" role. A future
  // role model can replace this check without changing the endpoint contract.
  const scopes = c.get('authScopes') ?? [];
  if (!scopes.includes('*') && !scopes.includes('admin')) {
    return c.json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin role required' } }, 403);
  }

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

  const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
  const actorType = c.get('authType') === 'bearer' ? 'api_key' : 'admin';
  const ipAddress = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || null;
  const userAgent = c.req.header('user-agent') || null;

  const res = await revokeDeviceOverride(c.env.DB, c.env, {
    merchantId,
    deviceId,
    revokedBy,
    actorType,
    reason: body.reason,
    ipAddress,
    userAgent,
  });

  if (!res.success) {
    return c.json({ success: false, error: res.error }, res.status as 400 | 403 | 404 | 409 | 429 | 500);
  }

  return c.json({ success: true, data: res.data }, 200);
});

