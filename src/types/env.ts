/**
 * Cloudflare Workers environment bindings.
 *
 * This file declares the shape of `env` available in every Worker fetch() handler,
 * scheduled() cron handler, and queue() consumer. Secrets (JWT_SECRET, APP_KEY,
 * ENCRYPTION_KEY, SMTP password, gateway API keys) MUST be set via
 * `wrangler secret put NAME` — never in wrangler.jsonc.
 */

/**
 * D1Database binding — primary relational store.
 *
 * Declared locally (subset of the runtime surface) so this file stays the
 * Env's single source of truth; `results` is REQUIRED here because every
 * call site treats `.all<T>().results` as present (D1 always returns it).
 */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
  binding(...values: unknown[]): D1PreparedStatement;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(col?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T>;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: {
    duration: number;
    changes: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    rows_read: number;
    rows_written: number;
    served_by: string;
    internal_stats?: unknown;
  };
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

// KV / R2 / Queues / ExecutionContext / ScheduledController / Message /
// Fetcher shapes come from the @cloudflare/workers-types globals — no local
// duplicates here (the local copies had drifted out of sync with the real
// generic signatures and produced type errors).

/**
 * The full env shape passed to every Worker handler.
 */
export interface Env {
  // Non-secret vars (from wrangler.jsonc "vars")
  ENVIRONMENT: 'development' | 'staging' | 'production';
  APP_NAME: string;
  APP_VERSION: string;
  APP_URL: string;
  APP_DOMAIN: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  DEFAULT_CURRENCY: string;
  DEFAULT_TIMEZONE: string;
  DEFAULT_LANGUAGE: string;
  JWT_ISSUER: string;
  JWT_TTL_SECONDS: string;
  REFRESH_TOKEN_TTL_SECONDS: string;
  WEBHOOK_MAX_RETRIES: string;
  WEBHOOK_BACKOFF_MS: string;
  RATE_LIMIT_WINDOW_SECONDS: string;
  RATE_LIMIT_MAX_REQUESTS: string;
  // CORS origin allowlist, comma-separated. Empty/undefined
  // = fail closed (no cross-origin browser access). Read by cors() in index.ts.
  ALLOWED_ORIGINS?: string;
  // Gateway-plugin selector — comma-separated gateway slugs/aliases.
  ENABLED_GATEWAYS?: string;

  // Optional bootstrap configuration overrides (defaults used if absent)
  DEFAULT_MFS_NUMBER?: string;
  DEFAULT_PAIRING_OTP?: string;
  ADMIN_EMAIL?: string;
  DEFAULT_WEBHOOK_URL?: string;

  // Secrets — set via `wrangler secret put`
  JWT_SECRET: string;
  APP_KEY: string;              // base64-encoded 32-byte key (HMAC operations)
  ENCRYPTION_KEY: string;       // base64-encoded 32-byte AES-256-GCM key

  // SMTP (optional — set if email sending is enabled)
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;

  // Cloudflare API token (for DNS verification + Custom Hostnames)
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;

  // Cloudflare Access — the admin surface FAILS CLOSED unless these are
  // configured (validated against the team's JWKS; the email header is
  // never trusted). Undefined / empty string = misconfigured = 503, not open.
  CF_ACCESS_TEAM_DOMAIN?: string;   // e.g. 'myteam.cloudflareaccess.com'
  CF_ACCESS_AUD_TAG?: string;       // the Access application's AUD tag

  // Break-glass service token (secrets) — the ONLY non-JWT path into
  // /api/admin/*; every use emits a PAGE-level audit alarm.
  BREAK_GLASS_CLIENT_ID?: string;
  BREAK_GLASS_CLIENT_SECRET?: string;

  // Workers AI (optional — the binding is commented out in wrangler.jsonc
  // until first deploy; SMS parsing falls back to manual review without it)
  AI?: Ai;

  // Service bindings
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  WEBHOOK_QUEUE: Queue<WebhookMessage>;
  EMAIL_QUEUE: Queue<EmailMessage>;
  SMS_QUEUE: Queue<SmsMessage>;

  // Durable Object binding — ONE per-tenant LedgerDO per merchant.
  // Owns the merchant's entire chart; posting is a single atomic call
  // (see src/do/ledger-do.ts + docs/POSTING-PROTOCOL.md).
  LEDGER_DO: DurableObjectNamespace;

  // Workers Workflows — refund reconciliation (instance-per-refund)
  // and the daily reconciliation sweep.
  REFUND_WORKFLOW: WorkflowBinding<{ refund_id: number }>;
  SWEEP_WORKFLOW: WorkflowBinding<{ date: string }>;

  // Native Ratelimit bindings — per-API-KEY limits (the primitive edge
  // rules can't express). Optional so tests/dev run without them;
  // absence is degraded mode (allowed + metric), never a hard failure.
  RATE_LIMIT_READ?: RateLimitBinding;
  RATE_LIMIT_WRITE?: RateLimitBinding;

  // Analytics Engine — per-merchant metrics without touching D1
  // (parse-miss rate, webhook lag, reconciliation runs, paging events).
  ANALYTICS?: AnalyticsEngineDataset;

  // Workers Static Assets binding — serves checkout CSS/JS with zero subrequests
  ASSETS: Fetcher;

  // PBKDF2 password-hash cost override. Default 600,000 (OWASP 2023).
  // STRICT FREE TIER NOTE: the free plan's 10ms CPU budget cannot finish
  // 600K iterations (worklog Task 1 confirmed blocker) — deployments that
  // must stay strictly free set a lower cost (e.g. "100000") and lean on
  // Cloudflare Access in front of every admin surface + per-IP rate limits
  // as the primary gates. Stored hashes embed their own iteration count, so
  // verification always uses the cost each hash was created with.
  PBKDF2_ITERATIONS?: string;
}

// Worker-internal message envelopes
export interface WebhookMessage {
  webhook_id: number;
  merchant_id: number;
  url: string;
  secret: string;
  event: string;
  payload: Record<string, unknown>;
  attempt: number;
  next_attempt_at?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html_body: string;
  text_body?: string;
  merchant_id: number;
  template_name: string;
}

export interface SmsMessage {
  merchant_id: number;
  device_id: number;
  sender: string;
  body: string;
  received_at: string;
}

// Minimal shapes of the platform bindings we use (kept local so this
// file stays the single source of truth for the Env shape).
// KVNamespace / R2Bucket / Queue / Fetcher resolve to the workers-types
// globals declared above via @cloudflare/workers-types.

/** Workflows binding (create + status). */
interface WorkflowBinding<P = unknown> {
  create(options?: { id?: string; params?: P }): Promise<WorkflowInstanceHandle>;
}

interface WorkflowInstanceHandle {
  id: string;
  status(): Promise<string>;
}

/** Workers Ratelimit binding. */
interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/** Analytics Engine dataset binding. */
interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    blobs?: Array<string | number | null>;
    doubles?: Array<number>;
    indexes?: Array<string>;
  }): void;
}

// Workers AI shim (loaded only if [ai] binding is configured)
interface Ai {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}
