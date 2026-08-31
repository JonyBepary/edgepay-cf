/**
 * Merchant API routes — `/api/v1/*`
 *
 * Authenticated via Bearer API keys. Three scopes: read, write, admin.
 * All routes require a merchant_id context (from domain middleware or
 * resolved from the API key).
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { requireBearerApiAuth, requireScope } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { PaymentService } from '../services/payment';
import { ValidationError } from '../lib/error';
import { createPaymentSchema, createRefundSchema } from '../lib/validation';
import { gatewayRegistry, gatewaySelection, catalogCounts, catalogFind } from '../gateways';
import { zValidator } from '@hono/zod-validator';
import { randomToken } from '../lib/crypto';

export const apiRoutes = new Hono<{ Bindings: Env; Variables: Record<string, unknown> }>();

// All routes require bearer auth with read+write scope (or admin)
apiRoutes.use('*', requireBearerApiAuth(['read', 'write', 'admin']));
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
  const merchantId = c.get('merchantId');
  if (!merchantId) throw new Error('Merchant context not resolved');

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
// GET /api/v1/payments/{payment_id} — fetch a payment intent
// ---------------------------------------------------------------
apiRoutes.get('/payments/:payment_id', async (c) => {
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
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
// ---------------------------------------------------------------
apiRoutes.post(
  '/refunds',
  requireScope('write'),
  zValidator('json', createRefundSchema, (result, _c) => {
    if (!result.success) {
      throw new ValidationError('Request body validation failed', result.error.issues);
    }
  }),
  async (c) => {
  const merchantId = c.get('merchantId')!;
  const body = c.req.valid('json');

  const tx = await c.env.DB.prepare(

    `SELECT t.id, t.trx_id, t.amount, t.currency, t.status, g.slug AS gateway_slug, t.gateway_trx_id
     FROM op_transactions t
     JOIN op_gateways g ON g.id = t.gateway_id
     WHERE t.trx_id = ? AND t.merchant_id = ?
     LIMIT 1`
).bind(body.transaction_id, merchantId).first<{
    id: number;
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

  // v0.2.3: NEW refunds are gated by ENABLED_GATEWAYS. (In-flight refund
  // workflows keep polling their adapter even after a gateway is disabled —
  // blocking mid-flight reconciliation would strand funds.)
  if (!gatewaySelection(c.env.ENABLED_GATEWAYS).enabled.includes(tx.gateway_slug)) {
    return c.json({
      success: false,
      error: {
        code: 'GATEWAY_DISABLED',
        message: `Gateway '${tx.gateway_slug}' is not enabled on this deployment (ENABLED_GATEWAYS).`,
      },
    }, 422);
  }

  // Issue refund via gateway (static import — see top of file)
  const adapter = gatewayRegistry.resolve(tx.gateway_slug);

  // Load credentials (simplified — in production cache these)
  const credRows = await c.env.DB.prepare(

    `SELECT gc.field_name, gc.field_value
     FROM op_gateway_configs gc
     JOIN op_transactions t ON t.gateway_id = gc.gateway_id
     WHERE t.id = ? AND gc.merchant_id = ?`
).bind(tx.id, merchantId).all<{ field_name: string; field_value: string }>();

  const { decrypt } = await import('../lib/crypto');
  const credentials: Record<string, string> = {};
  for (const row of credRows.results) {
    try {
      credentials[row.field_name] = await decrypt(row.field_value, c.env.ENCRYPTION_KEY);
    } catch { /* skip */ }
  }

  const refundResult = await adapter.refund(tx.gateway_trx_id, refundAmount, credentials, { kv: c.env.KV });
  if (!refundResult.success) {
    return c.json({
      success: false,
      error: { code: 'REFUND_FAILED', message: refundResult.error ?? 'Refund failed' },
    }, 502);
  }

  // Create refund record
  const refundTrxId = `ref_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await c.env.DB.prepare(

    `INSERT INTO op_refunds
       (merchant_id, refund_id, transaction_id, gateway_refund_id, amount, currency, reason, status, initiated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
).bind(merchantId,
      refundTrxId,
      tx.id,
      refundResult.refund_id ?? null,
      refundAmount,
      tx.currency,
      body.reason ?? null,
      c.get('authSubject') ?? 0,
      new Date().toISOString(),
      new Date().toISOString(),).run();

  return c.json({
    success: true,
    data: {
      refund_id: refundTrxId,
      gateway_refund_id: refundResult.refund_id,
      amount: refundAmount,
      currency: tx.currency,
      status: 'completed',
    },
  }, 201);
  },
);

// ---------------------------------------------------------------
// GET /api/v1/customers — list customers
// ---------------------------------------------------------------
apiRoutes.get('/customers', async (c) => {
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
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
// GET /api/v1/webhooks — list merchant webhooks
// ---------------------------------------------------------------
apiRoutes.get('/webhooks', async (c) => {
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
  const body = await c.req.json<{ url?: string; events?: string[] }>();
  if (!body.url) {
    return c.json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'url is required' } }, 400);
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
  const merchantId = c.get('merchantId')!;
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
  const merchantId = c.get('merchantId')!;
  let body: { url?: string } = {};
  try { body = await c.req.json(); } catch { /* optional body */ }
  const { WebhookDispatcher } = await import('../services/webhook-dispatcher');
  const dispatcher = new WebhookDispatcher(c.env);
  const result = await dispatcher.sendTest(merchantId as number, body?.url);
  return c.json({ success: result.success, error: result.error });
});

// ---------------------------------------------------------------
// GET /api/v1/webhooks/deliveries — recent webhook deliveries
// ---------------------------------------------------------------
apiRoutes.get('/webhooks/deliveries', async (c) => {
  const merchantId = c.get('merchantId')!;
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

  const enabled = selection.enabled
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

  return c.json({
    success: true,
    data: {
      enabled,
      all_enabled: selection.allEnabled,
      dropped_aliases: selection.dropped,
      catalog: catalogCounts(),
    },
  });
});
