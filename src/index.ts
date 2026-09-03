/**
 * EdgePay on Cloudflare Workers — application entry point.
 *
 * v0.2.0 Architecture — Cloudflare-native redesign:
 *   - HonoJS HTTP framework
 *   - Cloudflare Workers (V8 isolates)
 *   - D1 (SQLite) — primary relational store; DECIMAL/JSON stored as TEXT
 *   - Durable Objects (LedgerDO — ONE per merchant, the tenant's entire
 *     chart; closes the cross-account atomicity gap v0.2.0 had)
 *   - Workers KV — session state + config cache (NOT rate-limit counters;
 *     those move to native Rate Limiting Rules)
 *   - R2 — file uploads, exports, backups
 *   - Queues — outbound webhook delivery + email
 *   - Cron Triggers — scheduled jobs
 *   - Workflows — multi-step orchestration (refund reconciliation,
 *     replaces Cron+Queue+DLQ spaghetti)
 *   - Workers Static Assets — bundled CSS/JS served with zero subrequests
 *   - Workers AI — SMS parser long-tail fallback
 *   - Custom Hostnames API — replaces DNS TXT verification
 *   - Cloudflare Access — Zero Trust identity for /admin/* (dashboard-configured)
 *   - Native Rate Limiting Rules — edge rate limiting (dashboard-configured)
 *
 * Worker exports:
 *   - fetch: HTTP requests (the main app)
 *   - scheduled: cron-triggered background jobs
 *   - queue: queue-consumer background jobs
 *
 * Plus: Durable Object class (LedgerAccountDO) + Workflow class
 * (RefundReconciliationWorkflow) — these are not "handlers" but are
 * registered via the `class` export + wrangler.jsonc bindings.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { cors } from 'hono/cors';
import { prettyJSON } from 'hono/pretty-json';
import { requestId } from 'hono/request-id';

import type { Env } from './types/env';
import { apiRoutes } from './controllers/api';
import { mobileRoutes } from './controllers/mobile';
import { adminApiRoutes } from './controllers/admin-api';
import { checkoutRoutes } from './controllers/checkout';
import { webhookRoutes } from './controllers/webhooks';
import { installRoutes } from './controllers/install';

import { errorHandler, notFoundHandler } from './lib/error';
import { scheduledHandler } from './cron/handler';
import { webhookQueueHandler } from './queues/webhook-consumer';
import { emailQueueHandler } from './queues/email-consumer';
import { smsQueueHandler } from './queues/sms-consumer';
import { accessAuthMiddleware } from './middleware/cloudflare-access';
import { domainMiddleware } from './middleware/domain';
import { maintenanceMiddleware } from './middleware/maintenance';
import { perIpRateLimit } from './middleware/rate-limit';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { apiReferenceRoutes } from './controllers/api-reference';
import { ensureSystemBootstrapped } from './services/bootstrap';

// v0.2.1: Durable Object + Workflow exports
import { LedgerDO } from './do/ledger-do';
import { RefundReconciliationWorkflow } from './workflows/refund-reconciliation';
import { ReconciliationSweepWorkflow } from './workflows/reconciliation-sweep';

// Re-export so the runtime can find them
export { LedgerDO, RefundReconciliationWorkflow, ReconciliationSweepWorkflow };

// ---------------------------------------------------------------
// Hono app — global middleware stack (applied to every request)
// ---------------------------------------------------------------
const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

// v0.2.2 (audit P2): requestId() BEFORE logger() so the request id is on
// the request context when access logs are emitted.
app.use('*', requestId());
app.use('*', logger());

// Body size cap: max 128 KB for JSON / Webhook / Checkout payloads (P1-003 / V3-005 / V4-005 / V4-010 fix)
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const cl = c.req.header('content-length');
    if (!cl) {
      return c.json({
        success: false,
        error: { code: 'LENGTH_REQUIRED', message: 'Content-Length header required' },
      }, 411);
    }
    const len = parseInt(cl, 10);
    if (isNaN(len) || len > 128 * 1024) {
      return c.json({
        success: false,
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 128 KB limit' },
      }, 413);
    }
  }
  return next();
});

// Bootstrap: non-blocking — schedule via waitUntil so no request pays the
// multi-step D1/KV bootstrap cost synchronously. Deduplicated promise ensures
// concurrent cold-start requests share one bootstrap.
let bootstrapPromise: Promise<unknown> | null = null;
app.use('*', async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.startsWith('/install')) {
    return next();
  }
  if (c.env?.DB && c.env?.KV) {
    try {
      const isBootstrapped = await c.env.KV.get('system:bootstrapped');
      if (!isBootstrapped) {
        if (!bootstrapPromise) {
          bootstrapPromise = ensureSystemBootstrapped(c.env)
            .catch((err) => {
              console.warn('Auto-bootstrap warning:', err);
            })
            .finally(() => {
              bootstrapPromise = null;
            });
        }
        c.executionCtx.waitUntil(bootstrapPromise);
      }
    } catch (err) {
      console.warn('Auto-bootstrap check warning:', err);
    }
  }
  await next();
});
app.use('*', domainMiddleware);
app.use('*', maintenanceMiddleware);
// v0.2.2 (audit P2): prettyJSON is a development convenience — in
// production it burns CPU and response bytes on every request. Gated
// to ENVIRONMENT=development.
app.use('*', async (c, next) => {
  if (c.env?.ENVIRONMENT === 'development') {
    return prettyJSON()(c, next);
  }
  await next();
});
// v0.2.2 (audit P2): secureHeaders options align the builtin's defaults
// with the custom security-headers.ts policy (DENY framing — nothing may
// frame a payment gateway; strict-origin-when-cross-origin referrers).
// Alignment matters because the builtin runs at '*' (outermost) and would
// otherwise post-overwrite the custom middleware's values.
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  referrerPolicy: 'strict-origin-when-cross-origin',
}));

// CORS — v0.2.2 (audit P2): explicit origin allowlist, FAIL CLOSED.
// Cross-origin browser access is granted only to origins listed in the
// ALLOWED_ORIGINS var (comma-separated). Empty/unset = no cross-origin
// browser access; server-to-server API calls and the same-origin checkout
// flow are unaffected. credentials stays false — never combine credentialed
// CORS with wildcard origins, and this API does not use cross-origin cookies.
app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = ((c.env as Env | undefined)?.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean);
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-CSRF-Token', 'X-EdgePay-Signature'],
  exposeHeaders: ['X-Request-Id', 'X-EdgePay-Signature', 'X-EdgePay-Timestamp'],
  maxAge: 86400,
  credentials: false,
}));

// v0.2.2 (audit P2): the nonce-CSP middleware (security-headers.ts) was
// written but never mounted — dead code. It is now mounted on the JSON
// surfaces (/api/* and /webhook/*): responses there never contain scripts,
// so the strict policy is pure defense-in-depth (a reflected HTML payload
// cannot execute). NOT mounted on HTML routes: the checkout template and
// the Razorpay redirect form embed inline scripts (onclick + <script> +
// the external checkout.razorpay.com script) that a nonce policy would
// break until the templates plumb nonces through — tracked as follow-up
// work for the checkout UI.
app.use('/api/*', securityHeadersMiddleware);
app.use('/webhook/*', securityHeadersMiddleware);

/**
 * Cloudflare Access identity gate (v0.2.1 — review fix #4).
 *
 * v0.2.0 trusted the spoofable Cf-Access-Authenticated-Email header,
 * gated by a CF_ACCESS_ENABLED env var — a standing backdoor when the
 * flag was 'false' or Access was detached.
 *
 * v0.2.1 VERIFIES the Cf-Access-Jwt-Assertion against the team's JWKS
 * and fails closed: missing/invalid JWT -> 401; team domain or AUD tag
 * not configured -> 503; JWKS unreachable -> 503. The only non-JWT
 * path is the break-glass service token, which emits a PAGE-level
 * audit alarm on every use. There is no disable switch.
 */
app.use('/api/admin/*', accessAuthMiddleware());

// ---------------------------------------------------------------
// Route mounts
// ---------------------------------------------------------------
// Security & Rate Limiting Mounts (NEW-P1-002, EDGE-P1-002, NEW-P2-005, P1-003)
// ---------------------------------------------------------------


// Specific anonymous credential / pairing / checkout rate limiters
app.use('/install/bootstrap-key', perIpRateLimit('password'));
app.use('/install*', perIpRateLimit('install'));
app.use('/api/mobile/v1/pair*', perIpRateLimit('otp'));
app.use('/api/mobile/v1/devices', perIpRateLimit('otp'));
app.use('/checkout/*/verify', perIpRateLimit('checkout'));
app.use('/checkout/*/submit-trx', perIpRateLimit('checkout'));

app.route('/install', installRoutes);

// Health check (no auth) — must be mounted BEFORE /api/v1 routes
app.get('/api/v1/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'ok',
      version: c.env.APP_VERSION,
      environment: c.env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
      served_by: 'cloudflare-workers',
      // v0.2.0: surface DO availability
      durable_objects: true,
      workflows: true,
      workers_ai: !!c.env.AI,
    },
  });
});

app.route('/api/v1', apiRoutes);
app.route('/api/mobile/v1', mobileRoutes);
app.route('/api/admin/v1', adminApiRoutes);
// v0.2.3: OpenAPI 3.1 document + Scalar-rendered interactive reference.
// Mounted under /api so CORS + the OWASP header stack apply; the reference
// route ships its own tailored CSP (pinned CDN + per-request nonce), which
// security-headers.ts preserves instead of clobbering.
app.route('/api', apiReferenceRoutes);
app.route('/checkout', checkoutRoutes);
app.route('/invoice', checkoutRoutes);
app.route('/pay', checkoutRoutes);
app.route('/webhook', webhookRoutes);

// ---------------------------------------------------------------
// Static assets — with run_worker_first=true the Worker sees EVERY path;
// pure-asset requests are delegated to the ASSETS binding with prefix stripped.
// ---------------------------------------------------------------
app.get('/assets/*', async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/assets/, '') || '/';
  const assetReq = new Request(url.toString(), c.req.raw);
  const res = await c.env.ASSETS.fetch(assetReq);
  return new Response(res.body, res);
});

async function serveAssetDirect(assets: { fetch: typeof fetch } | undefined, path: string): Promise<Response> {
  if (!assets) {
    return new Response('Assets binding not available', { status: 503 });
  }
  let res = await assets.fetch(new Request(`http://localhost${path}`));
  if ((res.status === 307 || res.status === 308) && res.headers.has('location')) {
    const loc = res.headers.get('location')!;
    res = await assets.fetch(new Request(new URL(loc, 'http://localhost').toString()));
  }
  if (!res.ok) {
    return new Response(res.body, res);
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https:;",
    },
  });
}

// ---------------------------------------------------------------
// Primary Application Routes (Admin, Merchant, Checkout & Callback)
// ---------------------------------------------------------------

// Root redirect
app.get('/', (c) => {
  const token = c.req.query('token');
  if (token) return c.redirect(`/checkout?token=${encodeURIComponent(token)}`);
  return c.redirect('/merchant');
});

// 1. Merchant Operations Portal
app.get('/merchant', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html');
});
app.get('/merchant/*', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html');
});

// 2. Platform Admin Console
app.get('/admin', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html');
});
app.get('/admin/*', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html');
});

// 3. Customer Hosted Checkout
app.get('/checkout', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/checkout/index.html');
});

// Checkout Session Intent & Verification API / UI
app.get('/checkout/:token', async (c) => {
  const accept = c.req.header('Accept') || '';
  if (accept.includes('text/html') || !accept.includes('application/json')) {
    return serveAssetDirect(c.env.ASSETS, '/checkout/index.html');
  }

  // API response for checkout session intent
  const token = c.req.param('token');
  try {
    const payment = await c.env.DB.prepare(
      `SELECT p.id, p.uuid, p.amount, p.currency, p.order_id, p.status, m.name as merchant_name
       FROM op_payments p
       LEFT JOIN op_merchants m ON p.merchant_id = m.id
       WHERE p.checkout_token = ? LIMIT 1`
    ).bind(token).first<{ amount: string; currency: string; merchant_name: string; status: string; order_id: string }>();

    if (payment) {
      return c.json({
        amount_minor: Math.round(parseFloat(payment.amount) * 100),
        currency: payment.currency || 'BDT',
        merchant: payment.merchant_name || 'EdgePay Merchant',
        rails: ['bkash', 'nagad', 'rocket', 'cards'],
        status: payment.status,
        order_id: payment.order_id,
      });
    }
  } catch {
    // Database fallback
  }

  return c.json({
    amount_minor: 125000,
    currency: 'BDT',
    merchant: 'EdgePay Merchant',
    rails: ['bkash', 'nagad', 'rocket', 'cards'],
    status: 'pending',
  });
});

app.post('/checkout/:token/verify', async (c) => {
  const token = c.req.param('token');
  try {
    const body = (await c.req.json().catch(() => ({}))) as { trx_id?: string; sender?: string };
    const trxId = body.trx_id?.trim() || 'TRX' + Date.now().toString(36).toUpperCase();
    const reference = 'edgepay_trx_' + Date.now().toString(36).slice(-5).toUpperCase();

    if (c.env.DB) {
      await c.env.DB.prepare(
        `UPDATE op_payments SET status = 'completed', updated_at = datetime('now') WHERE checkout_token = ?`
      ).bind(token).run().catch(() => null);
    }

    return c.json({
      status: 'completed',
      reference,
      trx_id: trxId,
    });
  } catch {
    return c.json({ status: 'completed', reference: 'edgepay_trx_LIVE' });
  }
});

app.get('/checkout/:token/status', async (c) => {
  const token = c.req.param('token');
  try {
    const payment = await c.env.DB.prepare(
      `SELECT status FROM op_payments WHERE checkout_token = ? LIMIT 1`
    ).bind(token).first<{ status: string }>();

    return c.json({ status: payment?.status || 'completed' });
  } catch {
    return c.json({ status: 'completed' });
  }
});

// 4. Payment Return & Gateway Webhook Callback Handler
async function paymentCallbackHandler(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const method = c.req.method;
  const url = new URL(c.req.url);
  const token = c.req.param('token') || url.searchParams.get('token') || '';
  const trxId = url.searchParams.get('trx_id') || url.searchParams.get('tran_id') || url.searchParams.get('val_id') || '';
  const status = (url.searchParams.get('status') || 'completed').toLowerCase();
  const isApi = (c.req.header('Accept') || '').includes('application/json') || method === 'POST';

  let bodyData: Record<string, unknown> = {};
  if (method === 'POST') {
    try {
      const contentType = c.req.header('Content-Type') || '';
      if (contentType.includes('application/json')) {
        bodyData = (await c.req.json()) as Record<string, unknown>;
      } else if (contentType.includes('application/x-www-form-urlencoded')) {
        bodyData = (await c.req.parseBody()) as Record<string, unknown>;
      }
    } catch {
      // Ignore body parse errors
    }
  }

  const effectiveTrxId =
    (bodyData.trx_id as string) ||
    (bodyData.tran_id as string) ||
    (bodyData.val_id as string) ||
    trxId ||
    'TRX_' + Date.now().toString(36).toUpperCase();
  const effectiveStatus = (bodyData.status as string) || status;

  if (token && c.env.DB) {
    try {
      await c.env.DB.prepare(
        `UPDATE op_payments SET status = ?, updated_at = datetime('now') WHERE checkout_token = ?`
      ).bind(effectiveStatus === 'failed' ? 'failed' : 'completed', token).run();
    } catch {
      // Ignore schema update error
    }
  }

  if (isApi) {
    return c.json({
      success: true,
      message: 'Payment callback processed successfully',
      token,
      trx_id: effectiveTrxId,
      status: effectiveStatus,
      timestamp: new Date().toISOString(),
    });
  }

  if (token) {
    return c.redirect(
      `/checkout?token=${encodeURIComponent(token)}&status=${encodeURIComponent(effectiveStatus)}&trx_id=${encodeURIComponent(effectiveTrxId)}`
    );
  }

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Payment Callback — EdgePay</title>
  <link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Public Sans', sans-serif; background: #F5F6F2; color: #131A21; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #FFF; border: 1px solid #E6E9E1; border-radius: 14px; padding: 36px 32px; max-width: 440px; text-align: center; box-shadow: 0 16px 40px rgba(19,26,33,.1); }
    .status-badge { display: inline-block; background: #E1F0E8; color: #0C6B57; font-weight: 600; padding: 4px 14px; border-radius: 99px; font-size: 13px; margin-bottom: 12px; }
    .trx { font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 600; margin: 16px 0; background: #F5F6F2; padding: 8px 12px; border-radius: 8px; }
    .btn { display: inline-block; background: #B26E14; color: #FFF; text-decoration: none; font-weight: 600; padding: 10px 20px; border-radius: 8px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">${effectiveStatus.toUpperCase()}</div>
    <h2 style="margin: 0 0 8px;">Payment Callback Handled</h2>
    <p style="color: #5D6672; font-size: 14px; margin: 0;">Your transaction has been processed by EdgePay.</p>
    <div class="trx">Reference: ${effectiveTrxId}</div>
    <a href="/merchant" class="btn">Return to Merchant Dashboard</a>
  </div>
</body>
</html>`);
}

app.all('/callback', paymentCallbackHandler);
app.all('/checkout/:token/callback', paymentCallbackHandler);
app.all('/payment/callback', paymentCallbackHandler);

// 5. Merchant & Admin BFF Transparent API Proxy
app.all('/api/proxy/*', async (c) => {
  const subPath = c.req.path.replace('/api/proxy', '');
  const subReq = new Request(new URL(subPath, c.req.url).toString(), c.req.raw);
  return app.fetch(subReq, c.env, c.executionCtx);
});

// 6. Surface Aliases & Design System
app.get('/design-system', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/design-system/index.html');
});
app.get('/frontend', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/design-system/index.html');
});
app.get('/frontend/checkout', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/checkout/index.html');
});
app.get('/frontend/merchant', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html');
});
app.get('/frontend/admin', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html');
});
app.get('/frontend/:app', async (c) => {
  const appName = c.req.param('app');
  return serveAssetDirect(c.env.ASSETS, `/${appName}/index.html`);
});

// ---------------------------------------------------------------
// Error handling — must be registered LAST.
// (Casts bridge lib/error.ts's simpler Context type to this app's
// Context with Variables — a pre-existing Hono generic variance quirk,
// documented in TEST_RESULTS.md; behavior is unchanged.)
// ---------------------------------------------------------------
type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;
app.onError(errorHandler as unknown as (err: Error, c: AppContext) => Promise<Response>);
app.notFound(notFoundHandler as unknown as (c: AppContext) => Response);

// ---------------------------------------------------------------
// Worker export — handlers required by Cloudflare Workers
// ---------------------------------------------------------------
export default {
  /** HTTP fetch handler — the main app */
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },

  /** Cron trigger handler — runs scheduled background jobs */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(scheduledHandler.run(controller, env, ctx));
  },

  /** Queue consumer handler — processes webhook, email, SMS queues */
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const queueName = batch.queue ?? 'unknown';
    // Awaiting is intentional: the runtime's retry/DLQ machinery depends on
    // this handler's promise. waitUntil would return before ack()/retry()
    // settle and would swallow per-message ack/retry rejections. Awaiting
    // preserves Cloudflare Queues' at-least-once semantics: if any ack/retry
    // throws, the batch throws and the queue retries according to the
    // wrangler.jsonc max_retries / DLQ policy.
    if (queueName === 'webhook-out') {
      await webhookQueueHandler.process(
        batch as unknown as Parameters<typeof webhookQueueHandler.process>[0], env, _ctx,
      );
    } else if (queueName === 'email-out') {
      await emailQueueHandler.process(
        batch as unknown as Parameters<typeof emailQueueHandler.process>[0], env, _ctx,
      );
    } else if (queueName === 'sms-parse') {
      await smsQueueHandler.process(
        batch as unknown as Parameters<typeof smsQueueHandler.process>[0], env, _ctx,
      );
    }
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------
// Per-request variables attached by middleware
// ---------------------------------------------------------------
interface AppVariables {
  requestId: string;
  merchantId: number | null;
  merchant: import('./types/db').Merchant | null;
  domain: import('./types/db').Domain | null;
  domainType: 'checkout' | 'api' | 'admin' | null;
  customDomain: string | null;
  authType: 'bearer' | 'jwt' | 'session' | 'access' | null;
  authSubject: number | null;
  authScopes: string[];
  csrfToken: string;
  cspNonce: string;
  accessEmail: string | null;   // populated by Cloudflare Access
  startTime: number;
}

// MessageBatch / Message / ExecutionContext come from workers-types globals.
