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
import { csrfMiddleware } from './middleware/csrf';
import { requireSecrets, SECRETS_ERROR_CODE } from './lib/secrets-guard';
import { page, metric } from './lib/observability';
import { randomBytes, bytesToBase64 } from './lib/crypto';
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

// P1: secrets guard — runs BEFORE any DB/crypto/bootstrap work, on every
// request (including /install and /api/v1/health — misconfigured secrets
// must fail closed everywhere). requireSecrets() pages SECRETS_MISCONFIGURED
// itself (field names only, never values) and throws; we translate the throw
// to a 503 JSON envelope so the payment path never crashes on a throw.
app.use('*', async (c, next) => {
  try {
    requireSecrets(c.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : SECRETS_ERROR_CODE;
    return c.json({
      success: false,
      error: { code: SECRETS_ERROR_CODE, message },
    }, 503);
  }
  return next();
});

// P1: production boot asserts — probe surfaces 503 per-request while
// misconfigured; the payment path itself NEVER throws/crashes on this.
// Missing native RateLimit bindings or Cloudflare Access config in
// ENVIRONMENT=production pages once per isolate + emits a metric per
// detection, and the readiness probe (/api/v1/health) serves 503 until fixed.
let bootAssertPaged = false;
app.use('*', async (c, next) => {
  const env = c.env as Env | undefined;
  if (env?.ENVIRONMENT === 'production') {
    const missing: string[] = [];
    if (!env.RATE_LIMIT_READ) missing.push('RATE_LIMIT_READ');
    if (!env.RATE_LIMIT_WRITE) missing.push('RATE_LIMIT_WRITE');
    if (!env.CF_ACCESS_TEAM_DOMAIN?.trim()) missing.push('CF_ACCESS_TEAM_DOMAIN');
    if (!env.CF_ACCESS_AUD_TAG?.trim()) missing.push('CF_ACCESS_AUD_TAG');
    if (missing.length > 0) {
      try {
        metric(env, 'boot.misconfigured', { extra: missing.join(',') });
        if (!bootAssertPaged) {
          bootAssertPaged = true;
          page(env, 'BOOT_MISCONFIGURED', { fields: missing, environment: 'production' });
        }
      } catch { /* telemetry never breaks the request path */ }
      const pathname = new URL(c.req.url).pathname;
      if (pathname === '/api/v1/health') {
        return c.json({
          success: false,
          error: {
            code: 'BOOT_MISCONFIGURED',
            message: `Production boot misconfigured: ${missing.join(', ')}`,
          },
        }, 503);
      }
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
// P1: no wildcard anywhere — the origin callback echoes ONLY an explicitly
// listed origin, otherwise no Access-Control-Allow-Origin header is emitted.
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
// P1: Vary: Origin on every /api/* response so shared caches never serve a
// CORS response minted for one origin to another origin.
app.use('/api/*', async (c, next) => {
  await next();
  try {
    const existing = c.res.headers.get('Vary');
    if (!existing) {
      c.header('Vary', 'Origin');
    } else if (!existing.split(',').map((s) => s.trim().toLowerCase()).includes('origin')) {
      c.header('Vary', `${existing}, Origin`);
    }
  } catch { /* immutable headers (ASSETS passthrough) — safe to skip */ }
});

// v0.2.2 (audit P2): the nonce-CSP middleware (security-headers.ts) was
// written but never mounted — dead code. It is now mounted on the JSON
// surfaces (/api/* and /webhook/*): responses there never contain scripts,
// so the strict policy is pure defense-in-depth (a reflected HTML payload
// cannot execute). NOT mounted on HTML routes (P1): those carry their own
// nonce CSP — serveAssetDirect() embeds the per-request cspNonce minted
// above (script-src nonce + pinned cdnjs GSAP 3.12.5 + razorpay, no
// unsafe-inline scripts), and the dynamic checkout template consumes the
// same nonce via c.get('cspNonce') (controllers/checkout.ts). The Razorpay
// redirect form keeps its explicit checkout.razorpay.com allowlist.
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
 * not configured -> 503 ACCESS_NOT_CONFIGURED; JWKS unreachable -> 503.
 * The only non-JWT path is the break-glass service token, which emits a
 * PAGE-level audit alarm on every use. There is no disable switch and no
 * Bearer-token bypass — an Authorization header alone NEVER satisfies this
 * gate (P0-3). Wired in index.ts only; the verification logic lives in
 * middleware/cloudflare-access.ts.
 */
app.use('/api/admin/*', accessAuthMiddleware());

// P1: CSRF — double-submit cookie gate for browser POST surfaces.
// Mounted on /checkout/*, /merchant/*, /admin/*. Exemptions live inside
// csrfMiddleware itself: /api/* (bearer auth), /webhook/* (HMAC), /install/*
// (no session yet), plus safe methods (GET/HEAD/OPTIONS only mint cookies).
// Missing/mismatched X-CSRF-Token -> 403 CSRF_TOKEN_INVALID.
app.use('/checkout/*', csrfMiddleware as unknown as Parameters<typeof app.use>[1]);
app.use('/merchant/*', csrfMiddleware as unknown as Parameters<typeof app.use>[1]);
app.use('/admin/*', csrfMiddleware as unknown as Parameters<typeof app.use>[1]);

// P1: per-request CSP nonce for HTML surfaces. Generated BEFORE handlers so
// serveAssetDirect() can embed it in its CSP header AND dynamic checkout HTML
// (controllers/checkout.ts renderCheckoutHTML) can consume it via
// c.get('cspNonce') for nonce-bearing <script>/<style> tags. Scalar's
// /api/reference route mints its own nonce (see api-reference.ts) and is
// untouched by this middleware.
app.use('/checkout*', async (c, next) => {
  try {
    c.set('cspNonce', bytesToBase64(randomBytes(16)));
  } catch { /* Variables typing — nonce header still applied below */ }
  await next();
});
app.use('/merchant*', async (c, next) => {
  try {
    c.set('cspNonce', bytesToBase64(randomBytes(16)));
  } catch { /* Variables typing — nonce header still applied below */ }
  await next();
});
app.use('/admin*', async (c, next) => {
  try {
    c.set('cspNonce', bytesToBase64(randomBytes(16)));
  } catch { /* Variables typing — nonce header still applied below */ }
  await next();
});

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

// Pinned CDN base for the CSP script-src allowlist. GSAP 3.12.5 is the only
// cdnjs payload the static shells load (with SRI in the HTML); the versioned
// path prefix pins it so a CDN-side major-version swap cannot silently widen
// what this payment platform executes. Razorpay's checkout.js is kept as the
// second explicit host — card/redirect flows need it.
const PINNED_CDNJS_GSAP = 'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/';
const RAZORPAY_CHECKOUT_HOST = 'https://checkout.razorpay.com';

function buildAssetCsp(nonce: string | null): string {
  const scriptSrc = nonce
    ? `script-src 'self' 'nonce-${nonce}' ${PINNED_CDNJS_GSAP} ${RAZORPAY_CHECKOUT_HOST}`
    : `script-src 'self' ${PINNED_CDNJS_GSAP} ${RAZORPAY_CHECKOUT_HOST}`;
  return [
    `default-src 'self'`,
    // P1: nonce covers scripts -> 'unsafe-inline' dropped here (no
    // unsafe-inline in script-src). style-src KEEPS 'unsafe-inline': the
    // static shells ship inline <style> blocks that cannot carry a nonce
    // without a frontend rebuild — same split as /api/reference.
    scriptSrc,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com`,
    `img-src 'self' data: https:`,
    `connect-src 'self' https:`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `object-src 'none'`,
  ].join('; ');
}

// P1: read the per-request CSP nonce minted by the HTML-surface middleware
// above (also consumed by controllers/checkout.ts renderCheckoutHTML via
// c.get('cspNonce')). Null when absent — buildAssetCsp() then emits the
// pinned-CDN policy without a nonce rather than reintroducing unsafe-inline.
function nonceOf(c: { get: (key: string) => unknown }): string | null {
  try {
    const v = c.get('cspNonce');
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function serveAssetDirect(assets: { fetch: typeof fetch } | undefined, path: string, cspNonce: string | null = null): Promise<Response> {
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
      'Content-Security-Policy': buildAssetCsp(cspNonce),
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
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html', nonceOf(c));
});
app.get('/merchant/*', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html', nonceOf(c));
});

// 2. Platform Admin Console
app.get('/admin', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html', nonceOf(c));
});
app.get('/admin/*', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html', nonceOf(c));
});

// 3. Customer Hosted Checkout
app.get('/checkout', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/checkout/index.html', nonceOf(c));
});

// Checkout Session Intent & Verification API / UI
app.get('/checkout/:token', async (c) => {
  const accept = c.req.header('Accept') || '';
  if (accept.includes('text/html') || !accept.includes('application/json')) {
    return serveAssetDirect(c.env.ASSETS, '/checkout/index.html', nonceOf(c));
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
    // P0-2: unknown token on the legacy op_payments surface — fail closed.
    // Never fall back to a fabricated amount/merchant/completed status.
    return c.json({
      success: false,
      error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' },
    }, 404);
  } catch {
    return c.json({
      success: false,
      error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' },
    }, 404);
  }
});

app.post('/checkout/:token/verify', async (c) => {
  // P0-1: legacy surface routes through the same corroboration rules as
  // checkoutRoutes.handleCustomerTrxVerify — a customer TrxID alone NEVER
  // completes a payment. Completion requires an exact carrier-SMS match
  // (UPPER(TRIM) + exact decimal cmp). Otherwise awaiting_sms/processing.
  const token = c.req.param('token');
  try {
    const body = (await c.req.json().catch(() => ({}))) as { trx_id?: string; sender?: string; sender_phone?: string };
    const rawTrx = body.trx_id;
    if (typeof rawTrx !== 'string') {
      return c.json({ success: false, error: { code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID' } }, 400);
    }
    const normalizedTrxId = rawTrx.trim().toUpperCase();
    if (normalizedTrxId.length < 4 || normalizedTrxId.length > 64 || !/^[A-Z0-9]+$/.test(normalizedTrxId.replace(/[_:-]/g, ''))) {
      return c.json({ success: false, error: { code: 'INVALID_TRX_ID', message: 'Please enter a valid Transaction ID' } }, 400);
    }
    // Reject server-generated synthetic IDs (legacy bypass artifacts).
    if (
      normalizedTrxId.startsWith('TRX') ||
      normalizedTrxId.startsWith('EDGEPAY') ||
      normalizedTrxId.startsWith('OP_') ||
      normalizedTrxId.includes('LIVE')
    ) {
      return c.json({ success: false, error: { code: 'INVALID_TRX_ID', message: 'Please enter the Transaction ID from your payment confirmation message' } }, 400);
    }
    const senderPhone = (body.sender_phone ?? body.sender)?.toString().trim() || null;

    const intent = await c.env.DB.prepare(
      `SELECT pi.id, pi.merchant_id, pi.amount, pi.currency, pi.status, pi.metadata,
              t.id AS trx_db_id, t.gateway_trx_id
       FROM op_payment_intents pi
       LEFT JOIN op_transactions t ON t.payment_intent_id = pi.id
       WHERE pi.token = ? LIMIT 1`
    ).bind(token).first<{
      id: number; merchant_id: number; amount: string; currency: string;
      status: string; metadata: string | null; trx_db_id: number | null; gateway_trx_id: string | null;
    }>();

    if (!intent) {
      return c.json({ success: false, error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' } }, 404);
    }

    if (intent.status === 'completed') {
      return c.json({ success: true, data: { status: 'completed', trx_id: intent.gateway_trx_id ?? normalizedTrxId } });
    }

    // TRX_ALREADY_USED — claimed by another completed payment.
    const usedTrx = await c.env.DB.prepare(
      `SELECT t.id FROM op_transactions t
       WHERE t.gateway_trx_id = ? AND t.status = 'completed' AND t.payment_intent_id != ? LIMIT 1`
    ).bind(normalizedTrxId, intent.id).first();
    if (usedTrx) {
      return c.json({
        success: false,
        error: { code: 'TRX_ALREADY_USED', message: 'This Transaction ID has already been claimed for another completed payment.' },
      }, 409);
    }

    // Exact SMS corroboration: UPPER(TRIM) match + exact decimal cmp.
    const matchingSms = await c.env.DB.prepare(
      `SELECT id, parsed_amount, parsed_trx_id FROM op_sms_data
       WHERE merchant_id = ? AND UPPER(TRIM(parsed_trx_id)) = ?
         AND match_status IN ('pending', 'parsed', 'needs_manual_review', 'no_match')
       ORDER BY created_at DESC LIMIT 1`
    ).bind(intent.merchant_id, normalizedTrxId).first<{ id: number; parsed_amount: string; parsed_trx_id: string }>();

    if (matchingSms) {
      const { cmp } = await import('./lib/money');
      if (!matchingSms.parsed_amount || cmp(matchingSms.parsed_amount, intent.amount) !== 0) {
        return c.json({
          success: false,
          error: { code: 'AMOUNT_MISMATCH', message: 'The payment received does not match the order amount.' },
        }, 400);
      }
      let txId = intent.trx_db_id;
      if (!txId) {
        const txRow = await c.env.DB.prepare(
          `SELECT id FROM op_transactions WHERE payment_intent_id = ? LIMIT 1`
        ).bind(intent.id).first<{ id: number }>();
        txId = txRow?.id ?? null;
      }
      if (txId) {
        const { PaymentService } = await import('./services/payment');
        await new PaymentService(c.env).completeTransaction(txId, intent.id, normalizedTrxId);
        await c.env.DB.prepare(`UPDATE op_sms_data SET match_status = 'matched' WHERE id = ?`).bind(matchingSms.id).run();
        return c.json({ success: true, data: { status: 'completed', trx_id: normalizedTrxId, amount: intent.amount, currency: intent.currency } });
      }
    }

    // No corroborating SMS yet — record claim, stay awaiting_sms/processing.
    let meta: Record<string, unknown> = {};
    try { if (intent.metadata) meta = JSON.parse(intent.metadata); } catch { /* keep empty */ }
    meta.customer_trx_id = normalizedTrxId;
    meta.customer_phone = senderPhone;
    meta.customer_submitted_at = new Date().toISOString();
    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE op_payment_intents SET metadata = ?, status = 'processing', updated_at = ? WHERE id = ?`).bind(JSON.stringify(meta), nowIso, intent.id),
      c.env.DB.prepare(`UPDATE op_transactions SET gateway_trx_id = ?, status = 'awaiting_verification', updated_at = ? WHERE payment_intent_id = ?`).bind(normalizedTrxId, nowIso, intent.id),
    ]);
    return c.json({ success: true, data: { status: 'awaiting_sms', trx_id: normalizedTrxId } });
  } catch (err) {
    // P0-1: never fail open to completed.
    console.warn('CHECKOUT_VERIFY_FAILED', { token, err: String(err) });
    return c.json({ success: false, error: { code: 'VERIFY_FAILED', message: 'Verification unavailable, please retry' }, status: 'pending' }, 500);
  }
});

app.get('/checkout/:token/status', async (c) => {
  const token = c.req.param('token');
  try {
    const payment = await c.env.DB.prepare(
      `SELECT pi.status FROM op_payment_intents pi WHERE pi.token = ? LIMIT 1`
    ).bind(token).first<{ status: string }>();
    if (!payment) {
      return c.json({ success: false, error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' }, status: 'pending' }, 404);
    }
    return c.json({ status: payment.status });
  } catch {
    return c.json({ success: false, error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' }, status: 'pending' }, 404);
  }
});

// 4. Payment Return & Gateway Webhook Callback Handler (P0-2 hardened)
// Unsigned callbacks NEVER complete: they stay pending and are logged as
// CALLBACK_UNSIGNED_REJECTED. Signed callbacks must pass adapter
// verifyWebhook (HMAC) or adapter.verify before any state change.
async function paymentCallbackHandler(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  const method = c.req.method;
  const url = new URL(c.req.url);
  const token = c.req.param('token') || url.searchParams.get('token') || '';
  const trxId = url.searchParams.get('trx_id') || url.searchParams.get('tran_id') || url.searchParams.get('val_id') || '';
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

  const rawTrx =
    (bodyData.trx_id as string) ||
    (bodyData.tran_id as string) ||
    (bodyData.val_id as string) ||
    trxId ||
    '';
  const effectiveTrxId = rawTrx ? String(rawTrx).trim().toUpperCase().slice(0, 64) : '';

  const respondPending = (reason: string) => {
    console.warn('CALLBACK_UNSIGNED_REJECTED', { token: token || null, reason });
    if (isApi) {
      return c.json({
        success: true,
        message: 'Payment callback received — awaiting gateway verification',
        token,
        trx_id: effectiveTrxId || null,
        status: 'pending',
        timestamp: new Date().toISOString(),
      });
    }
    if (token) {
      return c.redirect(
        `/checkout?token=${encodeURIComponent(token)}&status=pending${effectiveTrxId ? `&trx_id=${encodeURIComponent(effectiveTrxId)}` : ''}`
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
    .status-badge { display: inline-block; background: #FEF3C7; color: #92400E; font-weight: 600; padding: 4px 14px; border-radius: 99px; font-size: 13px; margin-bottom: 12px; }
    .trx { font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 600; margin: 16px 0; background: #F5F6F2; padding: 8px 12px; border-radius: 8px; }
    .btn { display: inline-block; background: #B26E14; color: #FFF; text-decoration: none; font-weight: 600; padding: 10px 20px; border-radius: 8px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">PENDING</div>
    <h2 style="margin: 0 0 8px;">Payment Callback Received</h2>
    <p style="color: #5D6672; font-size: 14px; margin: 0;">Awaiting gateway verification. Your transaction stays pending until the signed confirmation arrives.</p>
    <div class="trx">Reference: ${effectiveTrxId || 'n/a'}</div>
    <a href="/merchant" class="btn">Return to Merchant Dashboard</a>
  </div>
</body>
</html>`);
  };

  // No token → nothing to verify against; stay pending (never completed).
  if (!token) return respondPending('missing_token');

  // Resolve intent + gateway so we can require a real signature check.
  let intentRow: { id: number; gateway_slug: string | null } | null = null;
  try {
    intentRow = await c.env.DB.prepare(
      `SELECT pi.id, g.slug AS gateway_slug
       FROM op_payment_intents pi
       LEFT JOIN op_gateways g ON g.id = pi.gateway_id
       WHERE pi.token = ? LIMIT 1`
    ).bind(token).first<{ id: number; gateway_slug: string | null }>();
  } catch {
    return respondPending('intent_lookup_failed');
  }
  if (!intentRow) {
    if (isApi) {
      return c.json({ success: false, error: { code: 'INTENT_NOT_FOUND', message: 'Invalid checkout token' }, status: 'pending' }, 404);
    }
    return c.html('<h1>Invalid checkout token</h1>', 404);
  }

  // Require signature evidence: HMAC/signature headers or gateway-signed fields.
  // Without one of these the callback is unsigned → pending, no DB mutation.
  const headers = c.req.header();
  const headerKeys = Object.keys(headers ?? {}).map((k) => k.toLowerCase());
  const hasSignatureHeader = headerKeys.some((k) =>
    k.includes('signature') || k.includes('sign') || k === 'x-edgepay-signature' || k.startsWith('paypal-transmission')
  );
  const signedBodyKeys = ['signature', 'sign', 'hmac', 'razorpay_signature', 'pay_signature', 'webhook_signature'];
  const hasSignedField =
    signedBodyKeys.some((k) => bodyData[k] != null && String(bodyData[k]).trim() !== '') ||
    ['razorpay_signature', 'signature', 'sign'].some((k) => url.searchParams.get(k) != null);
  if (!hasSignatureHeader && !hasSignedField) {
    return respondPending('missing_signature');
  }

  // Verify via the gateway adapter (verifyWebhook/HMAC first, verify fallback).
  try {
    const { gatewayRegistry } = await import('./gateways');
    const { decrypt } = await import('./lib/crypto');
    const slug = intentRow.gateway_slug;
    if (!slug || !gatewayRegistry.has(slug)) return respondPending('unknown_gateway');
    const adapter = gatewayRegistry.resolve(slug);

    const gwRow = await c.env.DB.prepare(
      `SELECT pi.merchant_id, pi.gateway_id FROM op_payment_intents pi WHERE pi.id = ? LIMIT 1`
    ).bind(intentRow.id).first<{ merchant_id: number; gateway_id: number }>();
    const credentials: Record<string, string> = {};
    if (gwRow) {
      const credRows = await c.env.DB.prepare(
        `SELECT field_name, field_value FROM op_gateway_configs WHERE gateway_id = ? AND merchant_id = ?`
      ).bind(gwRow.gateway_id, gwRow.merchant_id).all<{ field_name: string; field_value: string }>();
      for (const row of credRows.results ?? []) {
        try { credentials[row.field_name] = await decrypt(row.field_value, c.env.ENCRYPTION_KEY); } catch { /* skip */ }
      }
    }

    const rawBody = method === 'POST' && Object.keys(bodyData).length > 0 ? JSON.stringify(bodyData) : url.search;
    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) lowerHeaders[k.toLowerCase()] = String(v);
    let verified = false;
    try {
      verified = await adapter.verifyWebhook({ rawBody, headers: lowerHeaders, credentials, ctx: { kv: c.env.KV } });
    } catch { verified = false; }
    if (!verified) {
      // Fall back to synchronous verify() for redirect-style callbacks that
      // carry provider-signed fields (still a cryptographic/provider check —
      // never the raw ?status= query param).
      const callbackData: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...bodyData };
      try {
        const { PaymentService } = await import('./services/payment');
        const result = await new PaymentService(c.env).handleCallback(intentRow.id, callbackData);
        const statusOut = result.success ? result.status : 'pending';
        if (isApi) {
          return c.json({ success: result.success, token, trx_id: effectiveTrxId || null, status: statusOut, timestamp: new Date().toISOString() });
        }
        if (token) return c.redirect(`/checkout?token=${encodeURIComponent(token)}&status=${encodeURIComponent(statusOut)}${effectiveTrxId ? `&trx_id=${encodeURIComponent(effectiveTrxId)}` : ''}`);
        return respondPending('verify_failed');
      } catch { return respondPending('verify_failed'); }
    }

    // Webhook signature valid → delegate completion (amount/trx binding enforced inside).
    const { PaymentService } = await import('./services/payment');
    const callbackData: Record<string, unknown> = { ...Object.fromEntries(url.searchParams), ...bodyData };
    const result = await new PaymentService(c.env).handleCallback(intentRow.id, callbackData);
    const statusOut = result.success ? result.status : 'pending';
    if (isApi) {
      return c.json({ success: result.success, token, trx_id: effectiveTrxId || null, status: statusOut, timestamp: new Date().toISOString() });
    }
    return c.redirect(`/checkout?token=${encodeURIComponent(token)}&status=${encodeURIComponent(statusOut)}${effectiveTrxId ? `&trx_id=${encodeURIComponent(effectiveTrxId)}` : ''}`);
  } catch (err) {
    console.warn('CALLBACK_VERIFY_ERROR', { token, err: String(err) });
    return respondPending('verify_error');
  }
}

app.all('/callback', paymentCallbackHandler);
app.all('/checkout/:token/callback', paymentCallbackHandler);
app.all('/payment/callback', paymentCallbackHandler);

// 6. Surface Aliases & Design System
app.get('/design-system', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/design-system/index.html', nonceOf(c));
});
app.get('/frontend', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/design-system/index.html', nonceOf(c));
});
app.get('/frontend/checkout', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/checkout/index.html', nonceOf(c));
});
app.get('/frontend/merchant', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/merchant/index.html', nonceOf(c));
});
app.get('/frontend/admin', async (c) => {
  return serveAssetDirect(c.env.ASSETS, '/admin/index.html', nonceOf(c));
});
app.get('/frontend/:app', async (c) => {
  const appName = c.req.param('app');
  return serveAssetDirect(c.env.ASSETS, `/${appName}/index.html`, nonceOf(c));
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
