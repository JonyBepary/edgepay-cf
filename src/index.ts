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
app.use('*', async (c, next) => {
  if (c.env?.DB && c.env?.KV) {
    const isBootstrapped = await c.env.KV.get('system:bootstrapped');
    if (!isBootstrapped) {
      try {
        await ensureSystemBootstrapped(c.env);
      } catch (err) {
        console.warn('Auto-bootstrap check warning:', err);
      }
    }
  }
  await next();
});
app.use('*', maintenanceMiddleware);
app.use('*', domainMiddleware);
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
// Install is anonymous + low-QPS — per-IP KV limiter (3/hour). Authenticated
// APIs use the native Ratelimit binding per API key instead (mounted in
// their controllers, after bearer auth). Mounted BEFORE installRoutes so it
// intercepts requests to /install and /install/*.
app.use('/install*', perIpRateLimit('install'));
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
// pure-asset requests are delegated to the ASSETS binding here.
// ---------------------------------------------------------------
app.get('/assets/*', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
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
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const queueName = batch.queue ?? 'unknown';
    if (queueName === 'webhook-out') {
      ctx.waitUntil(webhookQueueHandler.process(
        batch as unknown as Parameters<typeof webhookQueueHandler.process>[0], env, ctx,
      ));
    } else if (queueName === 'email-out') {
      ctx.waitUntil(emailQueueHandler.process(
        batch as unknown as Parameters<typeof emailQueueHandler.process>[0], env, ctx,
      ));
    } else if (queueName === 'sms-parse') {
      ctx.waitUntil(smsQueueHandler.process(
        batch as unknown as Parameters<typeof smsQueueHandler.process>[0], env, ctx,
      ));
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
