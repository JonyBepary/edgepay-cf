# Configuration Reference

Every knob EdgePay-CF exposes, where it lives, and what it does. Three layers:

1. **Vars** (`wrangler.toml → [vars]`, or the Deploy to Cloudflare setup page) —
   non-secret configuration, per environment.
2. **Secrets** (`wrangler secret put NAME`, `.dev.vars` locally, or the setup
   page fields sourced from `.dev.vars.example`) — sensitive values, never in
   the repo.
3. **Bindings** (`wrangler.toml`) — Cloudflare resources the Worker attaches to;
   provisioned automatically by the deploy button.

> Environment rule (from the
> [Wrangler environments docs](https://developers.cloudflare.com/workers/wrangler/environments/)):
> **vars and bindings are not inherited** — `env.dev` / `env.staging` declare
> their own complete sets. When you add a var, add it to all three blocks.

## Vars

| Var | Default | Purpose |
|-----|---------|---------|
| `ENVIRONMENT` | `production` | `development` \| `staging` \| `production`. Gates dev-only behavior (e.g. pretty-printed JSON). |
| `APP_NAME` | `EdgePay` | Display name; feeds the OpenAPI document title. |
| `APP_VERSION` | (release) | Surfaced by `/api/v1/health` and the OpenAPI `info.version`. |
| `APP_URL` / `APP_DOMAIN` | worker URL | Base for checkout/callback URLs and the OpenAPI `servers` entry. Set to your custom domain when you attach one. |
| `LOG_LEVEL` | `info` | `debug`…`error`; structured JSON logs via `wrangler tail`. |
| `DEFAULT_CURRENCY` | `BDT` | Fallback currency for merchants/intents. |
| `DEFAULT_TIMEZONE` / `DEFAULT_LANGUAGE` | `Asia/Dhaka` / `en` | Merchant defaults. |
| `JWT_ISSUER` | `edgepay-cf` | `iss` claim of mobile-companion JWTs. |
| `JWT_TTL_SECONDS` | `3600` | Access-token lifetime. |
| `REFRESH_TOKEN_TTL_SECONDS` | `2592000` | Refresh-token lifetime (30 days). |
| `WEBHOOK_MAX_RETRIES` | `3` | Outbound delivery attempts before the DLQ. |
| `WEBHOOK_BACKOFF_MS` | `60000` | Backoff base between attempts. |
| `RATE_LIMIT_WINDOW_SECONDS` / `RATE_LIMIT_MAX_REQUESTS` | `60` / `120` | Fallback (per-IP KV) limiter shape. |
| `SESSION_TTL_SECONDS` | `86400` | Admin session lifetime. |
| `CF_ACCESS_TEAM_DOMAIN` | *(empty)* | Zero Trust team domain for the admin surface. Empty = admin API 503 (fail closed). |
| `CF_ACCESS_AUD_TAG` | *(empty)* | AUD tag of the Access application covering `/api/admin/*`. |
| `ALLOWED_ORIGINS` | *(empty)* | CORS origin allowlist, comma-separated. Empty = no cross-origin browser calls (fail closed); server-to-server and same-origin checkout are unaffected. |
| `ENABLED_GATEWAYS` | all five | **Gateway-plugin selector** — comma-separated slugs/aliases (`stripe,paypal,bkash,razorpay,nagad`). Unset/`all` = every adapter; unknown-only lists enable nothing (fail closed). See [GATEWAYS.md](GATEWAYS.md). |

## Secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| `JWT_SECRET` | ✅ | HS256 key for mobile JWTs. ≥32 chars, enforced at runtime. `openssl rand -hex 32`. |
| `APP_KEY` | ✅ | HMAC signing key. `openssl rand -base64 32`. |
| `ENCRYPTION_KEY` | ✅ | AES-256-GCM key encrypting gateway credentials + PII. **Back it up — loss is unrecoverable.** `openssl rand -base64 32`. |
| `BREAK_GLASS_CLIENT_ID` / `_SECRET` | optional | Emergency admin service token; every use pages an audit alarm. |
| `CF_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_ZONE_ID` | optional | Custom-hostname provisioning (Cloudflare for SaaS). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM` | optional | Outbound email (consumer also speaks Resend). |
| `PBKDF2_ITERATIONS` | situational | Iterations for NEW password hashes. Default 600K exceeds the free plan's 10ms CPU — strictly-free deployments set `100000`. Stored hashes self-describe their cost. |

Locally, secrets live in `.dev.vars` (template: `.dev.vars.example`; `wrangler
dev` loads it automatically). In production use `wrangler secret put NAME` or
the deploy-button setup page. The pre-install `GET /install` check reports each
required secret's *length class* (`ok`/`weak`/`missing`) — never its content.

## Bindings

| Binding | Type | Used for |
|---------|------|----------|
| `DB` | D1 | All relational state (53 tables). Migrations target the **binding name**: `wrangler d1 migrations apply DB --remote`. |
| `KV` | KV | Domain cache, sessions, install lock, per-IP rate counters. |
| `R2` | R2 bucket | Uploads, exports, backups. |
| `WEBHOOK_QUEUE` / `EMAIL_QUEUE` / `SMS_QUEUE` | Queue producers | Outbound webhook deliveries, email, async SMS parsing. |
| `LEDGER_DO` | Durable Object | One per-tenant ledger per merchant; the serialization point for all postings ([POSTING-PROTOCOL.md](POSTING-PROTOCOL.md)). |
| `REFUND_WORKFLOW` / `SWEEP_WORKFLOW` | Workflows | Instance-per-refund reconciliation; daily sweep. |
| `RATE_LIMIT_READ` / `RATE_LIMIT_WRITE` | Ratelimit | Per-API-key limits (120 reads/min, 30 writes/min). Absent = degraded allow + metric, never silent fail-open. |
| `ANALYTICS` | Analytics Engine | Parse-miss rate, webhook lag, reconciliation runs, paging events — metrics without touching D1. |
| `ASSETS` | Static assets | Checkout CSS/JS, served with zero subrequests; `run_worker_first` keeps API routes unshadowed. |
| `AI` | Workers AI *(opt-in)* | SMS long-tail fallback parsing. Commented out in `wrangler.toml` until first deploy (the test runner cannot emulate it) — uncomment and redeploy. |

## Deploy-button wiring

The pieces that make the Deploy to Cloudflare flow work, and where they live:

| Mechanism | Location | Effect |
|-----------|----------|--------|
| Button + badge URL | `README.md` | `deploy.workers.cloudflare.com/?url=<your public repo>` |
| Field descriptions | `package.json → cloudflare.bindings` | Shown next to each var/secret on the setup page |
| Secrets template | `.dev.vars.example` | The set of secret fields the setup page offers |
| Deploy script | `package.json → scripts.deploy` | `npm run db:migrations:apply && wrangler deploy` — migrations run against whatever D1 the button provisioned (binding-referenced) |
| Resource defaults | `wrangler.toml` | Names + placeholder IDs; the button provisions and rewrites IDs |

See [DEPLOYMENT.md](DEPLOYMENT.md) for the end-to-end walkthrough.
