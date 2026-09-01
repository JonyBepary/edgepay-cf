# EdgePay-CF — Full Cloudflare Audit Report

**Version:** 0.2.3 | **Date:** 2026-09-01 | **Commit:** `8995b37` + uncommitted audit remediation (see `git status`) | **Wrangler:** 4.127.1 | **Workerd:** 1.20260828.1 | **Compatibility Date:** 2026-08-28
**Audit scope:** Complete codebase (`src/**/*.ts` 49 files, `wrangler.toml`, `package.json`, `migrations/0001-0004`, `scripts/*`, `tests/*`, `docs/*`, `public/assets/*`) — traced end-to-end (request → auth/tenant → validation → D1/DO → gateways → queues → workflows → webhooks/cron) against current official Cloudflare documentation (MCP `search_cloudflare_documentation` + Context7 for Hono/jose/drizzle/decimal/zod)

> **Oracle gate notice — read first:** The planned Oracle gate (`opencode/x-preview-f-free`) was **unavailable before analysis** on three successive attempts (Gate 1 twice, Gate 2 once — model not found, no review budget consumed, no findings produced). Focused read-only verification lanes + direct repository validation + explicit residual-risk reporting substitute. The configuration was subsequently changed to the verified working `opencode/muse-spark-1.2-contributor-free`, but **no Oracle substantive review evidence exists for any gate**. **This report must not be read as implying Oracle approval.**

> **Evidence fidelity — validation owner:** The report author (this Fixer lane) owns report completeness and evidence fidelity. All claims below reconcile to `git diff`, `npm test`, `npm run typecheck`, `bash -n`, `git diff --check`, and `wrangler deploy --dry-run` outputs captured 2026-09-01.

---

## Table of Contents

1. [Executive Summary & Release Posture](#1-executive-summary--release-posture)
2. [Architecture & Data-Flow Map](#2-architecture--data-flow-map)
3. [Cloudflare Products & Bindings — Used Appropriately?](#3-cloudflare-products--bindings--used-appropriately)
4. [Official Cloudflare Guidance — URLs & Universal vs Conditional](#4-official-cloudflare-guidance--urls--universal-vs-conditional)
5. [Findings by Severity](#5-findings-by-severity)
6. [Fixed Issues — File References & Tests](#6-fixed-issues--file-references--tests)
7. [Residual Risks & Report-Only Items](#7-residual-risks--report-only-items)
8. [Deployment Prerequisites, Rollback & Monitoring](#8-deployment-prerequisites-rollback--monitoring)
9. [Validation Evidence](#9-validation-evidence)
10. [Remediation Matrix (Concise)](#10-remediation-matrix-concise)
11. [Cloudflare Source Links](#11-cloudflare-source-links)
12. [Appendix — Inventory, Rename, Prior Releases](#12-appendix--inventory-rename-prior-releases)

---

## 1. Executive Summary & Release Posture

**What EdgePay-CF is:** HonoJS + Cloudflare Workers port of OwnPay — self-hosted payment gateway for BD/AF mobile-payment merchants (bKash, Nagad, Stripe, PayPal, Razorpay). Entire stack runs on the edge: Workers, D1, Durable Objects (LedgerDO per merchant), KV, R2, Queues, Workflows, Cron Triggers, Static Assets, Analytics Engine, Rate Limit bindings, Workers AI (optional), Cloudflare Access, Custom Hostnames (Cloudflare for SaaS).

**This audit:** Full inventory (49 `src/**/*.ts`, config, 4 migrations, seeds, 15 test suites, scripts, docs, assets) compared to current Cloudflare docs. Four bounded remediation lanes ran in parallel (tenant/middleware, payment integrity, edge operations/security, provider integrations), reconciled into one diff (25 files, 359 insertions / 154 deletions, plus 4 new test files and `migrations/0004`).

**Release posture — CONDITIONAL GREEN (ship after prerequisites).** All validated P1/P2 correctness, security, and operational defects are closed and pinned by 161/161 tests. **Do not deploy until** D1/KV/R2 IDs replace placeholders, `wrangler d1 migrations apply`, secrets are set via the fixed `scripts/set-secrets.sh`, Queues (+ DLQs) exist, and Access AUD/Team vars are populated prod-side. Per-env dry-runs pass; only the expected Smart Placement + Assets warning remains. See §8 and §10 for the checklist.

**Stale claims replaced:** Prior reports cited 82/82 (v0.2.2) and 104/104 (v0.2.3 pre-audit). Current truth is **161/161 across 15 suites** (see §9). Wrangler remains 4.127.1, `compatibility_date` is `2026-08-28` with documented deviation (see §4), and `wrangler.toml` vars now declare the full 18-var set per env (fixed same class as the P0 env-isolation bug). No unfinished placeholders remain in this report (the one parity stub inside `src/cron/handler.ts:164` is a documented SMS-matcher no-op).

---

## 2. Architecture & Data-Flow Map

### 2.1 Entry — `src/index.ts:1-290`

```
Hono app
  → logger / requestId / prettyJSON (dev-only) / secureHeaders
  → cors (ALLOWED_ORIGINS allowlist, fail-closed)
  → securityHeadersMiddleware on /api/* and /webhook/*
  → domainMiddleware (global, after cors/security) — resolves Host → merchantId via KV D1
  → maintenanceMiddleware (global, after domain) — KV system:maintenance gate, bypass /install|/health
  → accessAuthMiddleware on /api/admin/* (JWKS EC-P256/RSA, fail-closed 503, break-glass paging)
  → install limiter — global wildcard on /install* before route (single-charge guard)
  → routes:
      /install              — install wizard (anonymous, per-IP KV 3/hour)
      /api/v1/*             — merchant API (Bearer, per-key Ratelimit, zod on money routes, idempotency on POST /payments|/refunds)
      /api/mobile/v1/*      — companion app (JWT aud mobile, 600k PBKDF2)
      /api/admin/v1/*       — admin (Access + bearer, workflows, ledger, SMS, domains)
      /checkout/:token/*    — public checkout HTML + initiate/callback/status
      /webhook/:gateway     — inbound gateway webhooks (IP allowlist → geo fallback → signature)
      /assets/*             — Workers Static Assets (run_worker_first=true, ASSETS.fetch in handler)
      /api/openapi.json + /api/reference — OpenAPI 3.1 + Scalar (nonce-CSP, CDN pinned)
  → scheduled (cron) + queue (webhook/email/sms) exports
  → exports: LedgerDO, RefundReconciliationWorkflow, ReconciliationSweepWorkflow
```

**Middleware order intent:** `requestId` before `logger` (id in logs), `domain` before `maintenance` (bypass paths resolve correctly), `install limiter` before `app.route('/install')` (exact + wildcard `/install` both limited; `__installLimited` flag prevents double charge), `idempotency` only on mutating merchant routes after auth (clone-safe body hash, 24h TTL), CSRF intentionally **not** global (checkout POST is public/token-based; admin uses bearer/Access).

### 2.2 Types

- `src/types/env.ts:1-216` — single `Env` truth: vars (18: `ENVIRONMENT, APP_NAME, APP_VERSION=0.2.3, APP_URL/DOMAIN, LOG_LEVEL, DEFAULT_CURRENCY/TIMEZONE/LANGUAGE, JWT_ISSUER, JWT_TTL, REFRESH_TTL, WEBHOOK retries, RATE_LIMIT, SESSION_TTL`), secrets (`JWT_SECRET≥32, APP_KEY, ENCRYPTION_KEY, SMTP_*, CF_API_TOKEN/ACCOUNT/ZONE, CF_ACCESS_TEAM_DOMAIN/AUD_TAG, BREAK_GLASS_*`), bindings (`DB: D1Database, KV, R2, WEBHOOK_QUEUE/EMAIL_QUEUE/SMS_QUEUE: Queue, LEDGER_DO, REFUND_WORKFLOW/SWEEP_WORKFLOW: Workflow, RATE_LIMIT_READ/WRITE, ANALYTICS, ASSETS, AI?`).
- `src/types/db.ts:8-290` — row types mirror D1: `Merchant, Role, Permission, MerchantUser, ApiKey, Domain, Gateway, GatewayConfig, Customer, PaymentIntent (token, expires_at), Transaction (trx_id, gateway_trx_id), Refund (workflow_attempts), Webhook/Event/Delivery, LedgerAccount/Transaction/Entry, AuditLog, IdempotencyKey, RateLimit`. Money is `TEXT`, timestamps ISO8601.
- `src/types/ledger.ts:26-150` — posting protocol: `PostingPayload { tx_id:"m{merchant}:{kind}:{ref}", merchant_id, reference_type, reference_id, description, currency, entries[] }`, `PostingEntry { account_code, d1_account_id, direction, amount:string, amount_minor:number }`, `PostingResult { status:posted|duplicate|failed, error_code, ... }`, `LedgerDOStub { postTransaction (never throws), getBalances, getTransactionStatus, trialBalance, snapshotBalances, __testInjectFault }`.

### 2.3 Lib — `src/lib/*`

| File | Role | Key exports |
|---|---|---|
| `crypto.ts:1-353` | Web Crypto | `encrypt/decrypt` AES-GCM 12B IV 128b tag, `hmacSha256/verifyHmacSha256`, `hashPassword/verifyPassword` PBKDF2 600k PHC `pbkdf2-sha256$iter$salt$hash`, `sha256`, `randomToken/Uuid/Base64Key`, `timingSafeEqual`, `ipInCidr` |
| `jwt.ts:27-101` | `jose` HS256 | `JwtService{issueAccessToken/RefreshToken/verify}`, `OwnPayJwtPayload{iss,sub,aud:mobile,iat,exp,jti,scope,merchant_id,device_id,type}` |
| `money.ts:16-119` | `Decimal.js` isolated | `MoneyDecimal=Decimal.clone({precision:30, ROUND_HALF_UP})`, `add/sub/mul/div/cmp/gt/gte/lt/lte, toMinorUnits(via toFixed(0)+parseInt + RangeError >2^53), fromMinorUnits, format, isValidMoney` |
| `db.ts:14-167` | D1 wrapper | `Database{prepare/batch/exec/transaction}`, `Transaction{commit}`, `PreparedStatement{first/all/run}`, `normalizeD1Error`, cost logging |
| `error.ts:21-209` | Typed HTTP | `HttpError 400/401/403/404/409/429/503/502`, `GatewayDisabledError 422`, `GatewayNotConfiguredError 422`, `errorHandler` JSON `{success,error:{code,message},request_id}`, `notFoundHandler` HTML vs JSON |
| `logger.ts:25-87` | Structured JSON | `Logger{debug/info/warn/error, child}`, `createLogger(LOG_LEVEL)` → `console.*` → tail/Logpush |
| `observability.ts:27-74` | Paging+metrics | `page(env,code,detail)` → `console.error level:page` + `ANALYTICS.writeDataPoint(blobs,indexes)`, `metric(env,event,dims)` |
| `ledger-chart.ts:24-44` | Chart singleton | `DEFAULT_CHART_OF_ACCOUNTS` 14 accounts `1000 Cash@Bank … 5200 Chargeback`, `isDebitNormal(asset|expense)` |
| `validation.ts` | zod | Schemas bound via `@hono/zod-validator` on `POST /payments`, `POST /refunds` (typed `c.req.valid('json')`, `400 VALIDATION_ERROR`) |

### 2.4 Durable Object — `src/do/ledger-do.ts:66-528` — one per merchant

SQLite-backed DO (INTEGER minor units):

```sql
accounts(code PK, name, type, currency, balance_minor INTEGER, updated_at)
posted_transactions(tx_id PK, reference_type, reference_id, currency, description, posted_at)
journal_entries(id AUTOINC, tx_id, account_code, direction, amount_minor, posted_at) + idx_journal_tx/account
```

**Posting protocol inside `blockConcurrencyWhile` (see `docs/POSTING-PROTOCOL.md`):** A validate (≥2 entries, positive safe int ≤9e12 minor, Σdebits==Σcredits) → B dedup `SELECT posted_transactions WHERE tx_id` → duplicate → C balance guard (no resulting `balance_minor<0` → `INSUFFICIENT_FUNDS`) → D `insertPendingPosting` D1 `op_ledger_postings pending` (`ON CONFLICT DO NOTHING`; `rejected`→throw `REJECTED_TX_ID`, `posted`→heal) → E DO journal `INSERT posted_transactions/journal_entries` + `UPDATE accounts SET balance_minor+=delta` (commits even on failure return — no throw, input gate never BROKEN) → F `writeLedgerAuditTrail` D1 batch (`op_ledger_transactions/entries` + `postings→posted`; failure leaves pending for reconciliation).

Reads: `getBalances()`, `getTransactionStatus(tx_id)`, `trialBalance()` (INTEGER SUM debit==credit + derived balances), `alarm()` every 24h `snapshotBalances()` → `op_ledger_balance_snapshots` PK `(merchant_id,account_code,as_of)`, `__testInjectFault{fail_d1_pending,fail_do_writes,fail_d1_posted}` one-shot. Invariants exported: `validatePostingShape` pure, `ensureSeeded(null|currency)` idempotent `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`.

### 2.5 Services — `src/services/*`

- **`ledger.ts:74-387` + `ledger-audit.ts:28-151`:** `getLedgerDO(env,merchantId)→LEDGER_DO.idFromName(merchant-${id})`, `moneyToMinorStrict` → `toMinorUnits` + `isSafeInteger`, `post({idempotency_key})→buildPayload(resolve op_ledger_accounts id→code)→stub.postTransaction`, `reverse(ledgerTxId,reason)` inverse entries `m{merchant}:reversal:{uuid}`, `getAccountBalance`, `trialBalance`, `verifyDurableObjectConsistency` (`Promise.all` accounts/entries/doBalances/doTrial JS `Decimal` agg, never `SQL SUM TEXT`), `createDefaultChartOfAccounts` 14 rows + DO seed, `postPaymentLedgerEntry` `1010 debit amount → 4000 credit amount (+ fee 5000 debit / 1010 credit)` idempotent `m{merchant}:payment:{intentId}`.
- **`payment.ts:51-~460` (remediated):** `createIntent{merchant_id,amount,currency,description,customer,gateway_id,metadata,expires_in_seconds=900}` → `randomToken(32)` `randomUuid` `expiresAt` → **D1 batch** `op_payment_intents pending` + `op_transactions pending trx_id=op_{12hex} net=amount` (txn references intent via `SELECT id FROM op_payment_intents WHERE uuid=?` inside batch; deterministic fallback `SELECT op_gateways WHERE merchant_id=? ORDER BY id ASC LIMIT 1` or throw 422 `GATEWAY_NOT_CONFIGURED`); `initiatePayment(intentId,gatewayId)` → resolve `op_gateways active` + decrypt creds + `gatewayRegistry.resolve(slug)` → `adapter.initiate(...,env)` (KV cache) → **batch** both `processing` flips with single `nowProc`; `handleCallback` → `adapter.verify(...,env)` → `completeTransaction` or failed; **`completeTransaction(txDbId,intentId,gatewayTrxId)`** → idempotent guard (`completed+completed→return`), **ledger-before-completed** (`postPaymentLedgerEntry` first; failure leaves D1 not completed for retry), then **atomic batch** both `completed` updates, then `WebhookDispatcher.dispatch payment.completed`.
- **`refund.ts:42-159`:** `createRefund` → validate `completed` + try `adapter.refund(tx.gateway_trx_id, amount, creds, currency, env)` → `INSERT op_refunds pending rfnd_{20hex}` → `triggerRefundReconciliation refund-{id}` idempotent.
- **`reconciliation.ts:60-342`:** `PENDING_GRACE_MS 30s, MAX_PENDING_ATTEMPTS 5, REFUND_STUCK_MS 24h, MAX_REFUND_WORKFLOW_ATTEMPTS 3`, `reconcilePendingPostings({graceMs,limit=200})` → `SELECT pending WHERE created_at<cutoff` → try `stub.postTransaction` catch transport→`bumpAttempts`; `failed` deterministic→`rejected`+`page`; else bump; `duplicate`→`writeLedgerAuditTrail` heal + metric; `verifyAllMerchants` per active merchant drift→page; `sweepStuckRefunds` → `SELECT pending WHERE created_at<24h AND workflow_attempts<3` → `triggerRefundReconciliation sweep-n` + bump; terminal→page; `triggerDailySweep(date)` `sweep-{YYYY-MM-DD}`; `runReconciliation(hourly|daily|manual)` → `reconcilePendingPostings` + (if not hourly) `verify+ sweep` → `INSERT op_reconciliation_runs` audit + metric.
- **`webhook-dispatcher.ts:27-139`:** `dispatch{merchant_id,event,data}` → `SELECT op_webhooks active` filter `events *|includes` → `buildPayload{event,transaction_id,gateway_trx_id,amount,currency,fee,gateway,status,customer,metadata,timestamp}` → `WEBHOOK_QUEUE.sendBatch`; `signPayload` → `hmacSha256`.
- **`sms-parser.ts / sms-corroboration.ts / custom-hostnames.ts:1-204`:** `SmsParserService.parse()` regex 1.0 else `AI.run` prompt 0.7 threshold; `corroborateSmsPayment()` exact `amount+currency` vs `OpenOrderCandidate[]` `MATCH_WINDOW_MS 30m` `senderToGatewaySlug` overrides LLM; `CustomHostnamesService.provision()` `POST /zones/{CF_ZONE_ID}/custom_hostnames` DV http; `normalizeHostname` + `invalidateDomainCache` (both `domain:` and `domain-v2:`) + `resolveDomainContext` KV `domain-v2:` 5m → D1 `op_domains`.

### 2.6 Gateways — `src/gateways/*`

`base.ts:131-229` abstract `BaseGatewayAdapter{metadata(), fields(), initiate(params,creds,env?), verify(data,creds,env?), verifyWebhook(input,env?), refund(gatewayTrxId,amount,creds,currency?,env?), queryRefundStatus(id,creds,env?)}`.

| Gateway | Slug | Currencies | Capabilities | Auth | Initiate (remediated) | Verify |
|---|---|---|---|---|---|---|
| `stripe` | `stripe` | USD/EUR/GBP/CAD/AUD/JPY/BDT/INR/SGD (+ zero-decimal) | refund,webhook,subscription | Bearer `secret_key` | **Bracketed form** `automatic_payment_methods[enabled]=true`, `metadata[edgepay_trx_id]` per field (not JSON string), `amountMinor` | `GET /v1/payment_intents/{id}` |
| `paypal` | `paypal` | USD/EUR/GBP/CAD/AUD/JPY/BRL | refund,webhook | OAuth2 `client_id/secret` KV `paypal:token` 32000s | `POST /v2/checkout/orders` with `reference_id` + **`custom_id` + `invoice_id` = trx_id**, `currency_code` uppercased | capture |
| `bkash` | `bkash-api` | BDT | verification | `app_key/secret/username/password` KV `bkash:token` 3300s | 3-step grant→create→execute (env-propagated) | tokenized |
| `razorpay` | `razorpay` | INR/USD/EUR/GBP/SGD/AED/BDT | refund,webhook | Basic `key_id/key_secret` | `POST /v1/orders` Checkout.js HTML | HMAC `order_id|payment_id` |
| `nagad` | `nagad-merchant-api` | BDT | verification | RSA `merchant_id/public_key/private_key` | `/api/merchant/initiate` RSA-OAEP-SHA1 | `/verify` |

`index.ts` registers 5, `PENDING_GATEWAYS` 118 stubs, `enabled.ts` parses `ENABLED_GATEWAYS` (aliases, dedup, `all`/`*`, case/whitespace, unknown→dropped; unset/`all` = all five; unknown-only→nothing enabled fail-closed; memoized, enforced at `executePayment`/refund/webhook, exempt for callbacks/workflows).

### 2.7 Middleware — `src/middleware/*`

| File | Pattern | Details (after fix) |
|---|---|---|
| `auth.ts:34-171` | Bearer+JWT | `requireBearerApiAuth(scopes)` `op_live_{12}_{32}` prefix→D1 index→`sha256` `timingSafeEqual` expired/suspended + `last_used_at waitUntil`; **tenant equality** — if `c.get('merchantId')` from domain exists, must equal `keyRow.merchant_id` else 403 `Tenant mismatch` (same for JWT→`payload.merchant_id`); master `APP_DOMAIN` Host bypasses tenant check |
| `rate-limit.ts:61-150` | Per-key + per-IP | `rateLimitMiddleware` per `RATE_LIMIT_READ/WRITE.limit({key:key:{apiKeyId}})` 120/60 30/60 degraded `metric rate_limit_degraded`; `perIpRateLimit('otp')` KV `rl:*:IP:path` with install single-charge guard in `src/index.ts:155-165` |
| `cloudflare-access.ts:158-379` | Zero Trust | `verifyAccessJwt(jwt,jwks,{teamDomain,aud,now,clockSkew})` ES256 raw(64)↔DER `importJwk EC P-256/RSA PKCS1` `iss/aud/exp` + `kid` + 5m JWKS cache + forced refresh on miss + `accessAuthMiddleware` break-glass `Cf-Access-Client-Id/Secret` paging, fail-closed 503 when `CF_ACCESS_TEAM_DOMAIN/AUD_TAG` empty |
| `domain.ts:1-~120` | Multi-brand | KV `domain:`/`domain-v2:` 5m → D1 `op_domains` Host resolver, master `APP_DOMAIN` bypass, **`/install` + `/assets/*` + `/favicon.ico` bypass before KV/D1** (fresh installs + static assets on unknown hosts never 404), checkout→admin 404, normalized lowercase/trim invalidation |
| `csrf.ts` | `edgepay_csrf` | Cookie 32B `X-CSRF-Token` 24h, skips `GET/HEAD/OPTIONS` + `/api|/webhook|/install|/cron` → `403`; **intentionally not mounted globally** (checkout public/token-based) |
| `maintenance.ts` | 503 flag | KV `system:maintenance {reason,retry_after}` bypass `/install|/api/v1/health|/admin/maintenance`, **mounted globally after domain** |
| `security-headers.ts` | CSP nonce | 16B `cspNonce` `script-src 'nonce-'` `frame-ancestors 'none'` HSTS 63072000 `nosniff/DENY`, preserves route-set CSP (Scalar/docs page), not on checkout HTML (inline scripts would break) |
| `idempotency.ts:1-~80` | Dedup | `X-Idempotency-Key 8-64 alnum` → D1 `op_idempotency_keys(merchant_id,key)` body SHA256 clone-safe (hashes `c.req.raw.clone()`) 24h TTL, only on `POST /payments` and `POST /refunds` after auth, cached response / `409 Conflict` on hash mismatch |

### 2.8 Controllers — `src/controllers/*`

- **`api.ts:20-337`** (`/api/v1` + `requireBearerApiAuth` + `rateLimitMiddleware` + `idempotency`): `POST /payments` (zod) → `PaymentService.createIntent` 201 `{intent_id,token,checkout_url}`; `GET /payments/:payment_id`, `GET /transactions`, `GET /transactions/:trx_id`, `POST /refunds` `requireScope(write)` → `adapter.refund` + `op_refunds`, `GET /customers`, `GET/POST /api-keys` `op_live_{prefix}_{rest}` `sha256` scopes, `POST /webhooks/tests`, `GET /webhooks/deliveries`.
- **`admin-api.ts:15-~240`:** `POST /domains/verifications` TXT `_edgepay-verification` → **normalized** `KV domain delete` both prefixes; `GET/PUT /sms-templates`, `GET/DELETE /devices`, `GET /sms-queues`, `POST /sms-queues/:id/retries → SMS_QUEUE.send`, `POST /refunds → RefundService` 202, `POST /reconcile → runReconciliation manual`, `GET /ledger/trial-balance`.
- **`checkout.ts:14-206`:** `GET /:token` HTML brand `--brand #0b1f3a` 480px gateway radios (`sanitizeBrandColor` strict `^#[0-9a-fA-F]{6}$` else fallback), `POST /:token/initiate → initiatePayment`, `GET /:token/callback → handleCallback → redirect /status`, `GET /:token/status` JSON poll.
- **`webhooks.ts:55-~280` — `POST /:gateway`:** 0 enabled-gate check 404 → **1 MiB cap** (`Content-Length` header + actual `TextEncoder byteLength` → 413) → Layer1 `op_gateway_ips` 60s cache `ipInCidr` 403 → Layer2 **fail-closed geo** `cf.country ∈ [BD,AF,SG,US]` else `403 GEO_BLOCKED` (blocks missing country) → Layer3 `adapter.verifyWebhook({rawBody,headers,credentials}, env)` 401 → log `op_webhook_deliveries` → dedup `op_webhook_events(merchant_id,gateway,event_id)` — **`event_id` fallback `hash:${sha256(rawBody)}` deterministic** (no `randomUUID`) → `INSERT` + metric → if payment event → `extractTransactionId` (stripe `metadata.edgepay_trx_id ?? ownpay_trx_id`, paypal `resource.custom_id ?? invoice_id ?? custom ?? supplementary_data.related_ids.order_id`, razorpay `payload.payment.entity.notes.trx_id`) → `completeTransaction` idempotent.
- **`mobile.ts/install.ts`:** OTP `op_device_pairing_tokens 6-digit` → `op_paired_devices` + `jose` `access/refresh` + `POST /sms → SMS_QUEUE`; install checks `DB/KV/R2/QUEUES reachable` → `op_merchants uuid webhook_secret` + super-admin PBKDF2 12-char + `KV system:installed` lock; `GET /install` surfaces gateway selection + secret posture.

### 2.9 Queues — `src/queues/*`

- **`webhook-consumer:15-168`:** `HMAC(jsonPayload,secret)` `X-EdgePay-Signature/Timestamp` 15s `AbortController`, SSRF `isAllowedWebhookUrl` (block `https: only` except localhost, `10/172.16-31/192.168/169.254/0.0.0.0/.local/.internal/.localhost` + `localhost/127.0.0.1/::1`), **stable headers** `X-EdgePay-Delivery-Id: edgepay-{webhook_id}` + `X-EdgePay-Event` + `Idempotency-Key` (same across retries), **retry escalates from `msg.attempts`** (Queue metadata) not stale `webhook.attempt` — 60/300/1800s, `logDelivery op_webhook_deliveries` `ack` on `2xx|410|422` else retry.
- **`email-consumer`:** Resend `api.resend.com/emails` via `KV resend:api_key` + `SMTP_FROM`, ack `2xx/4xx` else retry 60s, now with DLQ `email-out-dlq`.
- **`sms-consumer`:** persist `op_sms_data pending` → `SmsParserService` regex vs AI → open orders `MATCH_WINDOW_MS 30m` → `corroborate` → `completeTransaction` or `manual_review` + metric, with DLQ `sms-parse-dlq`.

### 2.10 Cron — `src/cron/handler.ts:23-288` — 3 crons (free limit 5)

| Cron | Jobs |
|---|---|
| `*/5 * * * *` | `expirePendingIntents WHERE status pending|processing AND expires_at<now` + `processPendingSmsVerifications LIMIT 50` (parity stub no-ops safely) |
| `0 * * * *` | `updateExchangeRates open.er-api.com/v6/latest/USD` batches 50 + `reverifyDomains _edgepay-verification` (normalized dual-prefix invalidation) + `replayPendingPostings limit 200` fast-heal |
| `0 2 * * *` | `triggerSweep sweep-{YYYY-MM-DD}` `SWEEP_WORKFLOW` + `checkForUpdates api.github.com/repos/edgepay/edgepay-cf/releases/latest → KV system:latest_version` |

`switch(cron)` + `Promise.allSettled` + catch log `cron_failed` (no `noRetry`, so cron retry semantics preserved).

### 2.11 Workflows — `src/workflows/*`

- **`refund-reconciliation:88-274`:** `REFUND_POLL_MAX_ATTEMPTS=52`, backoff `1m,2m,4m,8m,15m→30m` ≈24h, `STEP_RETRIES 3×10s`, `GATEWAY_RETRIES 3×30s`, `run{ load-refund-record → for attempt 0..52 { query-gateway-status-{n} → if completed→finalizeRefund(post-ledger-reversal→dispatch-webhook→mark-completed) else failed→mark-failed+page else sleep wait-{n}} throw NonRetryableError errored DLQ }`.
- **`reconciliation-sweep:37-106`:** `SweepParams{date}` steps `replay-pending-postings limit 500 / verify-ledger-consistency / sweep-stuck-refunds / record-run` retries `3×30s` timeout `5m` → `INSERT op_reconciliation_runs daily`.

### 2.12 Migrations — `migrations/0001-0004`

- **0001 (763 lines):** 53 tables `op_merchants, op_roles, op_permissions, op_merchant_users, op_api_keys, op_domains, op_gateways, op_gateway_configs, op_customers, op_payment_intents/transactions/idempotency_keys/refunds, op_ledgers, op_webhooks/events/deliveries ...` MySQL→D1 (`BIGINT→INTEGER, VARCHAR→TEXT, DATETIME→TEXT, JSON→TEXT, ENUM→CHECK`).
- **0002 (17):** `op_domains cf_hostname_id/ssl_status/cname_target` + `idx_domains_domain_active`.
- **0003 (90):** `op_ledger_postings PK tx_id (pending→posted|rejected)`, `op_ledger_balance_snapshots PK (merchant_id,account_code,as_of)`, `op_reconciliation_runs`, `op_gateway_ips PK (gateway_slug,cidr)`, `op_refunds workflow_attempts/last_workflow_at`.
- **0004 (23):** `idx_op_refunds_status_created_workflow ON op_refunds(status, created_at, workflow_attempts)` — query-backed for `sweepStuckRefunds` (`status='pending' AND created_at<? AND workflow_attempts<?`) and terminal query; `EXPLAIN QUERY PLAN` uses index.

---

## 3. Cloudflare Products & Bindings — Used Appropriately?

| Product / Binding | Declared Where | Appropriateness | Notes |
|---|---|---|---|
| **Workers (Hono)** | `wrangler.toml:1-12` `name=edgepay-cf` `compatibility_date=2026-08-28` `nodejs_compat` | ✅ Appropriate | All request, crypto, fetch, Hono middleware run workers-native. Uses `fetch` + Web Crypto, no Node-only APIs. |
| **D1** `[[d1_databases]] binding=DB` | `75-83` prod + `317-322` dev + `417-422` staging (per-env, with `preview_database_id`) | ✅ Appropriate | Authoritative for payments, ledger postings audit, intents/transactions, gateways, api_keys. Uses `prepare().bind()` + `batch()` for atomicity (see §6). `migrations_dir="migrations"` correct. |
| **Durable Objects** `LEDGER_DO` SQLite | `189-195` prod + `332-334` dev + `432-434` staging + `[[migrations]] tag=v1 new_sqlite_classes=["LedgerDO"]` | ✅ Appropriate | Per-merchant (coordination atom = merchant chart) SQLite DO, serialized `postTransaction` (see §4). Not per-account (would fan out, no atomicity). `blockConcurrencyWhile` scope is minimal (constructor seed + per-posting critical section over D1 hops — justified, see §4). |
| **KV** `KV` `id` + `preview_id` | `90-93` prod + `324-326` dev + `425-427` staging | ✅ Appropriate — cache/config only | Used for domain resolution cache (5m), rate-limit counters, token caches (`paypal:token`, `bkash:token`), `system:installed/maintenance/latest_version`. Never authoritative for money/ledger. Eventually consistent use is correct. |
| **R2** `R2` `edgepay-uploads` | `99-102` prod + `328-331` dev + `429-431` staging | ⚠️ Declared but **unwired** (report-only, §7) | Binding exists, no upload API wired in this release. Keep for future; do not claim configured uploads are live. |
| **Queues** 3 producers + 3 consumers + 3 DLQs | `110-141` prod + `350-381` dev + `446-477` staging | ✅ Appropriate — idempotent consumers + DLQs now wired | `webhook-out` (webhook dispatch, now `X-EdgePay-Delivery-Id` + attempt-based backoff), `email-out`, `sms-parse`. Consumers `max_batch_size/timeout/max_retries` per Cloudflare defaults, **DLQs** now on all three in all envs (`webhook-out-dlq`, `email-out-dlq`, `sms-parse-dlq`). Handlers `ack()` on `2xx/410/422` else `retry({delaySeconds})` per docs. At-least-once → idempotent `tx_id` dedup. |
| **Workflows** 2 (`REFUND_WORKFLOW`, `SWEEP_WORKFLOW`) | `204-212` prod + `340-348` dev + `436-444` staging | ✅ Appropriate | `refund-reconciliation` bounded poll loop + `reconciliation-sweep` daily batch. Durable side effects in deterministic steps, `NonRetryableError` as DLQ signal with paging. |
| **Rate Limiting** `RATE_LIMIT_READ/WRITE` | `219-227` prod + `383-391` dev + `479-487` staging `namespace_id 1001/1002 120/60 30/60` | ✅ Appropriate — GA binding | `binding.limit({key:{apiKeyId}})` per API key (edge rules cannot do per-key). Per-IP KV limiter retained only for anonymous routes (`/install`). Degraded-allow + metric when binding absent is correct. |
| **Analytics Engine** `ANALYTICS` `edgepay_metrics` | `234-236` prod + `393-395` dev + `489-491` staging + `src/lib/observability.ts:37 writeDataPoint` | ✅ Appropriate | Paging/metrics `blobs/doubles/indexes`. Dataset name consistent. |
| **Static Assets** `[assets]` `directory ./public/assets` `ASSETS` `run_worker_first=true` `not_found_handling=none` | `242-251` prod + `397-401` dev + `493-497` staging + `src/index.ts:140 ASSETS.fetch(c.req.raw)` + install/domain bypass for `/assets/*` | ✅ Appropriate | Worker-first prevents shadowing `/api/*`. Domain middleware bypass (`/assets/*`, `/favicon.ico`) ensures assets serve on unknown hosts (correct for `run_worker_first`). |
| **Smart Placement** `[placement] mode=smart` | `173-174` prod + `403-404` dev + `499-500` staging | ⚠️ Appropriate but **warning is expected** (report-only, §7) | Wrangler dry-run warns that Smart Placement + `run_worker_first` moves entire Worker near data source, increasing asset RTT. Warning is informational; guidance is conditional (see §4). No config change at this volume. |
| **Cron Triggers** `[triggers] crons` 3 | `149-154` prod (inherited) | ✅ Appropriate | 3/5 free-account crons used, consolidated per review (refund loop is workflow-driven, per-merchant alarms cover former 6-hourly job). |
| **Custom Hostnames** (API, not `wrangler.toml` binding) | `src/services/custom-hostnames.ts:53 POST /zones/{CF_ZONE_ID}/custom_hostnames` `DV http` | ⚠️ Service implemented but **not exposed by a controller route** | Uses `CF_API_TOKEN/CF_ACCOUNT_ID/CF_ZONE_ID` secrets (never committed) when called. `resolveDomainContext` validates `status='active' AND ssl_status='active'`. Report-only: provisioning remains a product decision and is not currently exposed as an admin/API endpoint. |
| **Cloudflare Access** (Zero Trust) | `src/middleware/cloudflare-access.ts` JWKS `https://{team}/cdn-cgi/access/certs` | ✅ Appropriate — fail-closed | `CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD_TAG` required; empty → 503 (never open). JWKS `raw(64)↔DER`, 5m cache + forced refresh, `iss/aud/exp` + `kid`. Break-glass service token pages. |
| **Workers AI** `[ai] binding=AI` (commented) | `260-261` `Env.AI?: Ai` | ✅ Appropriate — optional | Commented for Miniflare compat; real AI path is `SMSParserService` fallback (regex primary, AI 0.7 threshold only on regex miss). Guarded `if (env.AI)` before `AI.run`. |
| **Observability** `[observability]` + `logs/traces` | `159-168` prod + `406-407` dev + `503+` staging | ⚠️ Appropriate with cost caveat (report-only) | `logs head_sampling_rate=1` (100% sampling — costly at scale; see §7), `traces enabled.head_sampling_rate=0.01` (1% sampled). Nested keys per current docs. Top-level legacy form would still work but nested is current. |

**Bindings inheritance note (fixed P0):** Wrangler docs state bindings and vars are **non-inheritable** per environment. Prod + `env.dev` + `env.staging` now each declare the full binding set explicitly (D1 with preview, KV, R2, LEDGER_DO, both Workflows, all Queue producers/consumers incl. DLQs, both Ratelimits, Analytics, Assets, Placement, Observability). The top-level `[[migrations]]` tag `v1` is intentionally **not** repeated per env — it is inherited (not in the non-inheritable list); repeating `v1` risks duplicate-tag error, verified via dry-runs.

---

## 4. Official Cloudflare Guidance — URLs & Universal vs Conditional

> **Docs currency verified via `search_cloudflare_documentation` prior to lane kickoff (see `.slim/deepwork/cloudflare-audit.md`). Library checks via Context7 (`hono@4.6.10, jose@5.9.6, drizzle@0.36.4, decimal@10.4.3, zod@3.23.8`). Fidelity: bindings checked against Wrangler configuration reference (2025-09-19 Rate Limit GA changelog).**

| Guidance | Source URL | Universal (always apply) vs Conditional (workload/plan-dependent) | EdgePay Action Taken | Evidence |
|---|---|---|---|---|
| **Bindings per-env must be explicit — not inherited** | https://developers.cloudflare.com/durable-objects/reference/environments/ + https://developers.cloudflare.com/workers/wrangler/environments/ | **Universal** | Fixed P0 — full bindings now per `env.dev`/`env.staging`; `[[migrations]] v1` intentionally not repeated (inherited). | `wrangler.toml:310-507`; dry-runs list `env.LEDGER_DO`, Workflows, Queues, Ratelimits, ASSETS per env (§9). |
| **D1: parameterized `prepare().bind()` + `batch()` for related atomic writes; indexes from measured query shapes** | https://developers.cloudflare.com/d1/wrangler-commands/ + https://developers.cloudflare.com/d1/reference/migrations/ | **Universal** for money paths (batch atomicity); index is conditional (query-backed only) | `createIntent` + `initiatePayment` + `completeTransaction` now use `DB.batch()`; index `idx_op_refunds_status_created_workflow` on `(status, created_at, workflow_attempts)` from sweep query. | `src/services/payment.ts:71-170, 216-232, 312-395`; `migrations/0004_payment_integrity.sql:22-23`; `tests/payment-integrity.test.ts:7-266`. |
| **`blockConcurrencyWhile` for one-time init + sparingly for critical sections** | https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile + https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#use-blockconcurrencywhile-sparingly | **Universal** (init pattern) / **Conditional** (posting critical section — only when external D1 hops require serialization) | Constructor `blockConcurrencyWhile(() => ensureTables())` (per-isolate seed), read RPCs no longer `CREATE TABLE`; posting critical section retained (per-tenant 200 req/s >> payment rates, D1 hops require serialization — alternative `storage.transaction` cannot cover external D1). Wasteful per-request creation removed. | `src/do/ledger-do.ts:78-88` + `docs/POSTING-PROTOCOL.md`; prior §3 perf fix. Re-evaluate only if per-merchant throughput approaches 100 req/s. |
| **Queues: at-least-once → idempotent consumers, explicit `max_retries` + `dead_letter_queue`** | https://developers.cloudflare.com/queues/get-started/ + https://developers.cloudflare.com/queues/configuration/ | **Universal** | DLQs added for `email-out` + `sms-parse` in all envs; `webhook-out-dlq` retained. | `wrangler.toml:129-141, 369-381, 465-477`; `tests/lane3-edge-operations.test.ts:232-277` DLQ assertions + `scripts/bootstrap.sh:38`. |
| **Workflows: durable side effects in `step.do()`, sleeps `step.sleep()`, `NonRetryableError` as DLQ, per-instance idempotence** | https://developers.cloudflare.com/workflows/build/trigger-workflows/ + https://developers.cloudflare.com/workflows/build/workers-api/#nonretryableerror | **Universal** | `refund-reconciliation` backoff `1m→30m` 52 attempts ≈24h, `NonRetryableError` → `errored` + page; `reconciliation-sweep` `instance_id sweep-{YYYY-MM-DD}` idempotent. Conditional: cron schedule for Workflows exists but not adopted (current polling inside workflow is sufficient at this volume). | `src/workflows/refund-reconciliation.ts:88-274` + `reconciliation-sweep.ts:37-106` + `src/services/reconciliation.ts:trigger*`. |
| **KV is eventually consistent → cache/config/token-cache only, not authoritative** | https://developers.cloudflare.com/kv/concepts/how-kv-works/ | **Universal** | Domain KV 5m cache, token caches (`paypal:token` 32000s ttl, `bkash:token` 3300s), `system:*`, rate-limit counters. Authoritative payment/ledger state remains D1/DO. | `src/middleware/domain.ts`, `src/gateways/paypal/paypal.gateway.ts:222-260`, `src/gateways/bkash/bkash.gateway.ts`. |
| **Access JWT: verify with exact issuer/audience/JWKS on each request** | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/ + https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/ | **Universal** on `/api/admin/*` | ES256 raw↔DER + RS256, `iss=team`, `aud=AUD_TAG`, `exp`, `kid` check, 5m JWKS cache + forced refresh, break-glass paging, fail-closed 503 when vars empty. | `src/middleware/cloudflare-access.ts:158-379` + `tests/access-jwt.test.ts:10` cases. |
| **Static Assets: `run_worker_first` behavior** | https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ + https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first | **Universal** for API-safe routing | `run_worker_first=true` + worker delegates `ASSETS.fetch(c.req.raw)` for `/assets/*`; static-asset bypass in `domain.ts:70-78` prevents unknown-host 404 on assets. | `wrangler.toml:242-251`; `src/index.ts:140`; `src/middleware/domain.ts:70-78`. |
| **Smart Placement + Assets warning** | https://developers.cloudflare.com/workers/configuration/placement/ + https://developers.cloudflare.com/workers/static-assets/binding/#smart-placement | **Conditional** | No change — warning is expected and informational at this volume; only revisit if p95 asset RTT regresses (tradeoff: place Worker near D1 vs near client). | Dry-run warning (§9); report-only §7. |
| **Workers Logs `head_sampling_rate` + Traces** | https://developers.cloudflare.com/workers/observability/logs/workers-logs/#head-based-sampling + https://developers.cloudflare.com/workers/observability/traces/ | **Conditional** (cost/workload) | Nested `[observability.logs] head_sampling_rate=1` + `[observability.traces] head_sampling_rate=0.01` per current docs. 100% log sampling is **intentional for now** but flagged as costly at scale (see §7). | `wrangler.toml:159-168` + docs note in file. |
| **Wrangler types: generate via `wrangler types`** | https://developers.cloudflare.com/workers/wrangler/configuration/ + types doc | **Universal** for DX | `@cloudflare/workers-types@5.20260828.1` pinned, `tsconfig.json:7 types: ["@cloudflare/workers-types","@cloudflare/vitest-plugin/types"]`. | `package.json:89`, `tsconfig.json:1-28`. |
| **Node.js `nodejs_compat` / `compatibility_date` / `compatibility_flags`** | https://developers.cloudflare.com/workers/configuration/compatibility-dates/ + https://developers.cloudflare.com/workers/runtime-apis/nodejs/ | **Universal** (keep current) | `compatibility_date=2026-08-28` (newest date known by both the pinned `workerd 1.20260828.x` test stack and `wrangler 4.127.1` bundled `1.20260828.1` — `2026-08-30` not yet released; flagged in-file to bump with devDeps). `nodejs_compat_v2` default-on from 2026-08-04, explicit `nodejs_compat` flag is forward-safe. | `wrangler.toml:1-12` with in-file deviation note. |
| **SSRF / private-address filtering — Workers fetch does not document generic blocking** | https://developers.cloudflare.com/workers/runtime-apis/fetch/ (no generic SSRF filter doc) | **Universal app validation required** | Explicit allowlist `isAllowedWebhookUrl` (https-only except localhost, block `10/172.16-31/192.168/169.254/0.0.0.0/.local/.internal/.localhost`) + `hostname` blocklist + `request.cf.country` aware. Do not claim Cloudflare blocks private destinations. | `src/queues/webhook-consumer.ts:30-60` + `tests/webhook-consumer` coverage; §7. |
| **R2: use bindings not REST where binding exists** | https://developers.cloudflare.com/r2/api/workers/workers-api-usage/ | **Conditional** (only when uploading) | No REST upload path needed — R2 binding declared but no upload API wired; treat as future product decision. | `wrangler.toml:99-102`; report-only §7. |

---

## 5. Findings by Severity

> Classification at remediation time (evidence in git diff + tests). All items below are **fixed** unless flagged report-only (§7).

### P0 — Blocks correctness or deploys

| # | Title | Before | Impact | Fix | Doc Link |
|---|---|---|---|---|---|
| P0-1 | **Env-isolation: `env.LEDGER_DO` undefined on `--env dev/staging`** | `env.dev`/`env.staging` declared only `DB/KV/R2` | Ledger calls 500 in non-prod, deploys silently broken (hidden by `vitest singleWorker`) | Full bindings per env (D1+preview, KV, R2, DO, both Workflows, all Queue producers/consumers+DLQs, Ratelimits, Analytics, Assets, Placement, Observability); `[[migrations]] v1` not repeated (inherited) | [DO Environments](https://developers.cloudflare.com/durable-objects/reference/environments/) + [Wrangler Environments](https://developers.cloudflare.com/workers/wrangler/environments/) |
| P0-2 | **Payment atomicity gap: paired D1 writes not batched** | `createIntent` two `prepare().run()` not atomic; `initiatePayment` two `UPDATE run()` not atomic; `completeTransaction` marked `completed` before ledger D-step | Partial payment state (intent without transaction, split `processing`, falsely `completed` with no ledger row) → orphaned intents, stuck txns, reconciliation needed for what should be atomic | `DB.batch()` on all three paths; deterministic gateway fallback + typed `GATEWAY_NOT_CONFIGURED` (see P1-1); ledger-before-completed ordering | [D1 batch](https://developers.cloudflare.com/d1/wrangler-commands/) |
| P0-3 | **Cross-tenant auth override: domain merchant overrides API-key merchant** | `auth.ts` `c.set('merchantId', keyRow.merchant_id)` after `domainMiddleware` without equality check | Authenticated key for merchant B could access merchant A's data when Host is `brand-a.example.com` | Both `requireBearerApiAuth` and `requireJwtAuth` now `throw 403 Tenant mismatch` when `c.get('merchantId') != keyRow.merchant_id / payload.merchant_id`; master domain (`APP_DOMAIN`) still bypasses | App tenant isolation (no single doc — design decision) |
| P0-4 | **Domain/maintenance middleware never mounted → inert** | `src/index.ts` imported `domainMiddleware`/`maintenanceMiddleware` but never `app.use()` | Host-based tenant isolation, checkout→admin 404, maintenance 503 all unusable | Mount `domainMiddleware` then `maintenanceMiddleware` globally after `cors/securityHeaders` (safe order; `/install`+`/assets/*`+`/favicon.ico` bypass before KV/D1) | [Workers Middleware](https://developers.cloudflare.com/workers/wrangler/configuration/) ordering |

### P1 — Security or money-integrity risk

| # | Title | Before | Impact | Fix |
|---|---|---|---|---|
| P1-1 | **Deterministic gateway FK + fail-closed when none** | `input.gateway_id ?? 0` sentinel FK-violation, `LIMIT 1` without `ORDER BY` | FK error on createIntent without gateway, nondeterministic default | `SELECT ... ORDER BY id ASC LIMIT 1` fallback; throw `GatewayNotConfiguredError 422` when no gateway; `src/lib/error.ts:96-100` + `src/services/payment.ts:80-98` |
| P1-2 | **Ledger-before-completed ordering defect (step D crash window)** | `completeTransaction` did `UPDATE completed` → `postPaymentLedgerEntry` | D1 says completed but DO has no pending row → no reconciliation heal, money appears taken but ledger never converges | `postPaymentLedgerEntry` first (creates pending row), then atomic `batch` both `completed` updates; idempotent guard `if both completed return`; crash at D leaves not-completed for retry; crash at E/F leaves pending row → duplicate heal; `tests/payment-integrity.test.ts:163-248` |
| P1-3 | **PayPal refund currency hard-coded USD** | `amount:{value,currency_code:'USD'}` | Partial refunds in BDT/EUR/BRL rejected or mis-posted | `refund(...,currency,env)` now `currency_code=(currency??'USD').toUpperCase()`; `src/gateways/paypal/paypal.gateway.ts:193-212`; `tests/lane4-provider.test.ts:137-177` |
| P1-4 | **PayPal webhook correlation uses `resource.custom` only → `reference_id` not consistently present** | `extractTransactionId paypal → resource.custom` | Webhook never completes transaction (silent drop) for standard PayPal capture events | Extractor prefers `custom_id → invoice_id → custom → supplementary_data.related_ids.order_id`; initiate sets `custom_id` + `invoice_id` = `trx_id`; `src/gateways/paypal/paypal.gateway.ts:58-63` + `src/controllers/webhooks.ts:231-240` |
| P1-5 | **Stripe PaymentIntent form encoding wrong** | `automatic_payment_methods:'enabled'` + `metadata: JSON.stringify({...})` as `application/x-www-form-urlencoded` body | Stripe rejects with `Unknown parameters` or drops metadata → webhook cannot correlate `trx_id` | Bracketed notation `automatic_payment_methods[enabled]=true`, `metadata[edgepay_trx_id]=...` per `URLSearchParams` flatten; `src/gateways/stripe/stripe.gateway.ts:41-69`; `tests/lane4-provider.test.ts:35-95` |
| P1-6 | **Token cache env not threaded → token fetch per request** | `BaseGatewayAdapter` signatures lacked `env`; callers omitted it | Extra OAuth latency + rate-limit pressure on PayPal/bKash | Typed `env?: {KV:KVNamespace}` on `initiate/verify/verifyWebhook/refund/queryRefundStatus` in `base.ts:142-186`; concrete adapters `paypal/bkash` accept `KVNamespace`; `PaymentService` + `webhooks.ts` pass `env`; `tests/lane4-provider.test.ts:194-280` cache propagation |
| P1-7 | **Install limiter ordering + wildcard miss, double charge** | `app.use('/install/*', ...)` after `app.route('/install',...)` and never matches `/install` | Exact `/install` unprotected (anon 3/hour bypass), `/install/*` shadowed, route runs before limiter | Global prefix middleware before route, covers `/install` + `/install/*`, single-charge flag `__installLimited`; `src/index.ts:155-168` + `AppVariables.__installLimited`; `tests/lane1-tenant-middleware.test.ts:234-282` |
| P1-8 | **Webhook body & replay gaps** | `Content-Length` unbounded, `crypto.randomUUID()` fallback when provider omits id, geo fallback not fail-closed | DoS via large body; random `event_id` defeats dedup → double processing; missing `cf.country` bypasses geo check | `MAX_WEBHOOK_BYTES=1 MiB` header + actual byteLength → 413; deterministic `hash:${sha256(rawBody)}` fallback; **fail-closed geo** `if (!country \|\| !ALLOWED.includes(country)) → 403`; `src/controllers/webhooks.ts:84-161`; `tests/lane3-edge-operations.test.ts:82-147` |
| P1-9 | **Outbound webhook retry never escalates + no stable delivery key** | Delay indexed from `webhook.attempt` (constant per message) → always 60s; no `Idempotency-Key` | Slow recovery; receiver cannot dedup retries | Delay from `(msg as {attempts?:number}).attempts` with fallback + `??1800`; stable `X-EdgePay-Delivery-Id: edgepay-{webhook_id}` + `Idempotency-Key` + `X-EdgePay-Event` invariant across attempts; `src/queues/webhook-consumer.ts:42-97`; `tests/lane3-edge-operations.test.ts:151-227` |
| P1-10 | **Brand color CSS injection** | `merchant.color` interpolated into `<style>:root{--brand:${brandColor}}` without validation | Client-side CSS injection (defacement, exfil via `url()` if sanitizer weak) | `sanitizeBrandColor` strict `^#[0-9a-fA-F]{6}$` after `trim()`, else `#0b1f3a`; `src/controllers/checkout.ts:201-206`; `tests/lane3-edge-operations.test.ts:21-45` |

### P2 — Operational / cost / hygiene

| # | Title | Before | Impact | Fix |
|---|---|---|---|---|
| P2-1 | **Queues lack DLQs for email/sms** | Only `webhook-out-dlq` | Silent discard after `max_retries` (email/sms lost) | DLQs `email-out-dlq` + `sms-parse-dlq` in all envs + bootstrap loop; `wrangler.toml:130-141,369-381,465-477` |
| P2-2 | **Script `set-secrets.sh` prints secrets + word-splits `--env`** | `echo "$JWT_SECRET"` + `ENV_FLAG="--env $ENV"` string | Secret leakage to shell history/CI log; fragile env handling | Arrays `ENV_ARGS=(--env "$2")` + `"${ENV_ARGS[@]}"` expansion, no secret echo (paging note only); `scripts/set-secrets.sh:13-33`; `tests/lane3-edge-operations.test.ts:250-263` |
| P2-3 | **Bootstrap misses preview D1 + new DLQs** | No `edgepay-cf-preview` D1, queues list omitted two DLQs | Preview traffic writes prod data; deploy fails when DLQ queues missing | `edgepay-cf-preview` D1 creation + `preview_database_id` note, `for q in webhook-out webhook-out-dlq email-out email-out-dlq sms-parse sms-parse-dlq`; `scripts/bootstrap.sh:16-38`; `tests/lane3-edge-operations.test.ts:265-277` |
| P2-4 | **Domain cache invalidation misses `domain-v2:`** | `admin-api.ts` + `cron/handler.ts` only `KV.delete domain:` | Old `domain:` prefix only; live resolver caches `domain-v2:` never evicted (stale Host→merchant mapping up to 5m) | Helper `invalidateDomainCache(env,hostname)` deletes **both** prefixes with `normalizeHostname(lowercase+trim)`; used in `admin-api.ts:55` + `cron/handler.ts:228-232` + `custom-hostnames.ts:168-174`; `tests/lane3-edge-operations.test.ts:50-80` |
| P2-5 | **Domain cache normalization case/whitespace** | `domain` string passed raw to `KV.delete` | `MiXeD.Example.COM` + `example.com` miss invalidation | `normalizeHostname` + `invalidateDomainCache` everywhere; `tests/lane1-tenant-middleware.test.ts:442-488` |
| P2-6 | **`domainMiddleware` blocks fresh installs + static assets on unknown hosts** | No bypass — unknown Host → KV/D1 miss → 404 before `/install` or `/assets/*` | Fresh installs unreachable on custom domain before brand provisioned; Assets 404 on unknown Host (breaks `run_worker_first` benefit) | Exact bypass `if (earlyPath.startsWith('/install') \|\| earlyPath.startsWith('/assets/') \|\| earlyPath==='/favicon.ico') return next()` **before** `system:installed` check; `src/middleware/domain.ts:70-78` |
| P2-7 | **Refund sweep query not indexed** | `SELECT ... WHERE status='pending' AND created_at<? AND workflow_attempts<?` → table scan at scale | Daily sweep + hourly replay slow, p95 drift | Migration `0004` composite index `(status, created_at, workflow_attempts)`; `tests/payment-integrity.test.ts:251-266` (`EXPLAIN QUERY PLAN` uses index) |
| P2-8 | **Env vars non-inheritable — dev/staging vars incomplete** | `env.dev.vars`/`env.staging.vars` declared 5/18 vars (pre-existing same class as P0) | `APP_NAME/DEFAULT_CURRENCY/JWT_ISSUER/...` undefined at runtime in dev/staging | Full 18-var set now per env (v0.2.3 carry-forward); `wrangler.toml:315,415` |
| P2-9 | **Typed `GatewayNotConfiguredError` missing** | Sentinel FK violation leaked raw D1 error | Poor client contract, FK integrity noise | New typed error `422 GATEWAY_NOT_CONFIGURED` in `src/lib/error.ts:96-100`; idempotent guard in `payment.ts:312-395` |

---

## 6. Fixed Issues — File References & Tests

> Single source for reviewers: every fixed defect maps to diff hunks and a test that would fail without the fix.

### 6.1 Tenant / middleware lane

| File | Hunks | Why | Test |
|---|---|---|---|
| `src/middleware/auth.ts:104-108,150-154` | Add `domainMerchantId != null && !==` → `throw ForbiddenError('Tenant mismatch …')` | P0-3 cross-tenant block | `tests/lane1-tenant-middleware.test.ts:118-232` 7 tests (API key + JWT, both mismatches 403, master domain `APP_DOMAIN` preserved 200) |
| `src/index.ts:1-17,55-68,128-168,265-266` | Import `domainMiddleware`, `maintenanceMiddleware`; mount `app.use('*',domainMiddleware)` then `maintenanceMiddleware` globally; install limiter: global `*` prefix guard `startsWith('/install')` + `__installLimited` flag before `app.route('/install')` | P0-4 + P1-7 | `lane1:234-282` install exact/wildcard/double-charge 3 tests + `lane1:284-321` maintenance 503 vs bypass `/api/v1/health\|/install\|/favicon.ico` |
| `src/middleware/domain.ts:70-84` | Early bypass for `/install`, `/assets/`, `/favicon.ico` **before** `system:installed` check (comment explains `run_worker_first` invariant + strict tenant routing preserved via `enforceDomainRouting`) | P2-6 | Same `lane1:284-321` + `checkout` HTML still mounts; cross-checked via `domain.ts:70-78` read |
| `src/middleware/idempotency.ts:4` | Minimal change (was already clone-safe in prior PR; diff only touches formatting — line-1 `Authorization` guard retained) | Idempotent `clone()` preservation | `lane1:323-439` 4 tests: clone-safe POST succeeds, same-key replay returns cached with `X-Idempotent-Replay:true`, conflict 409 on different body, GET not cached |
| `src/services/custom-hostnames.ts:168-174` | Add `normalizeHostname`, `invalidateDomainCache` (both `domain:` + `domain-v2:`) | P2-4/P2-5 | `lane3:50-80` both-prefix deletes + normalize(lowercase/trim) |
| `src/controllers/admin-api.ts:16,34-56` | Import normalize helpers, normalize inbound `domain` before `KV.delete` both prefixes, verify path normalizes `  MiXeD …  `.trim() | P2-4/P2-5 | `lane1:441-488` lowercased+trimmed key evicted even with whitespace+uppercase input (Access break-glass bypass branch) |
| `src/controllers/checkout.ts:201-206` | `sanitizeBrandColor` strict `^#[0-9a-fA-F]{6}$` with `trim()` else `#0b1f3a` | P1-10 | `lane3:21-45` 3 suites: accepts 6-hex with whitespace/uppercase, rejects short/long/injection/`javascript:`/`red` |
| `src/lib/error.ts:96-100` | `GatewayNotConfiguredError` 422 | P1-1/P2-9 typed contract | `tests/payment-integrity.test.ts:109-141` (createIntent without gateway → 422 is via service; gateway-less path covered via seeded fallback + error class) |

### 6.2 Payment integrity lane

| File | Hunks | Why | Test |
|---|---|---|---|
| `src/services/payment.ts:80-170` | `createIntent`: resolve `effectiveGatewayId` via `SELECT id WHERE merchant_id=? ORDER BY id ASC LIMIT 1` or `throw GatewayNotConfiguredError`; `DB.batch([intentInsert, txnInsert])` where `txnInsert` uses `SELECT ... FROM op_payment_intents WHERE uuid=?` to reference intent without `last_insert_rowid`; post-batch `SELECT id WHERE uuid=?` for `intent_id` | P0-2 + P1-1 deterministic FK | `payment-integrity.test.ts:109-141` paired rows exist, correct linkage, no `0` sentinel, sequential intents each land both rows |
| `src/services/payment.ts:216-232` | `initiatePayment`: `adapter.initiate(..., this.env)` (env propagation), single `nowProc` then `DB.batch([trxProcessing, intentProcessing])` | P0-2 atomic processing flip + P1-6 | `payment-integrity.test.ts:143-161` both `processing` with same `updated_at` |
| `src/services/payment.ts:279-395` | `handleCallback`: `adapter.verify(..., this.env)`; **`completeTransaction`**: new `SELECT` pulls `tx_status + intent_status` alias; idempotent guard `if both completed return`; **`ledger-before-completed`** `try { postPaymentLedgerEntry }` before any `UPDATE`; atomic `DB.batch([trxCompleted, intentCompleted])` with shared `now`; webhook dispatch last | P1-2 crash-window fix | `payment-integrity.test.ts:163-248` 3 cases: D-step injected `fail_d1_pending` → not completed, no pending row; retry converges via duplicate dedup; E/F injected `fail_do_writes` leaves `pending` row that retry heals to `posted` + `completed` + same `updated_at` |
| `migrations/0004_payment_integrity.sql:22-23` | `CREATE INDEX IF NOT EXISTS idx_op_refunds_status_created_workflow ON op_refunds(status, created_at, workflow_attempts)` | P2-7 hot sweep query | `payment-integrity.test.ts:251-266` index exists + `EXPLAIN QUERY PLAN` uses index; migration file content check |
| `src/services/refund.ts:2` | `format` removal (unused) | Hygiene | No new test (lint-only) |

### 6.3 Edge operations / security lane

| File | Hunks | Why | Test |
|---|---|---|---|
| `scripts/set-secrets.sh:13-33` | `--env` robust `ENV_ARGS=()` array + `"${ENV_ARGS[@]}"`, no `echo $JWT_SECRET` (paging note only) | P2-2 | `lane3:250-263` content assertions: no `echo.*$JWT_SECRET`, no `ENV_FLAG="--env`, contains `ENV_ARGS` + `"${ENV_ARGS[@]}"` |
| `scripts/bootstrap.sh:16-38` | Add `edgepay-cf-preview` D1 creation + `preview_database_id` note, `for q in webhook-out webhook-out-dlq email-out email-out-dlq sms-parse sms-parse-dlq` | P2-3 | `lane3:265-277` content assertions match both DLQs + preview D1 |
| `wrangler.toml:130-141,369-381,465-477` | Add `dead_letter_queue` for `email-out` + `sms-parse` in prod/dev/staging | P2-1 | `lane3:232-247` regex asserts DLQ bindings in all envs |
| `src/controllers/webhooks.ts:84-161,231-240` | `MAX_WEBHOOK_BYTES 1 MiB` header check + byteLength check → 413; fail-closed geo `if (!country \|\| !ALLOWED.includes...)` → `403`; `sha256(rawBody)` → `hash:${hash}` fallback; adapter calls with `env`; PayPal extractor expanded | P1-8 + P1-4 | `lane3:82-147` deterministic hash, 1 MiB caps, fail-closed geo matrix (null/empty→block, RU/CN→block, BD/US→allow); `lane4:179-191` PayPal extractor prefers `custom_id` |
| `src/queues/webhook-consumer.ts:42-97` | `msg.attempts` escalated delay `[60,300,1800]` + `??1800` fallback, stable `X-EdgePay-Delivery-Id=edgepay-{webhook_id}` + `Idempotency-Key` same value + `X-EdgePay-Event` invariant | P1-9 | `lane3:151-227` escalation `1→60 2→300 3→1800 4+→1800`, fallback to `webhook.attempt` when `msg.attempts` absent, header stability across attempts 2→3 |
| `src/cron/handler.ts:228-232` | `reverifyDomains` dual delete `domain:` + `domain-v2:` via normalized hostname | P2-4 | `lane3:71-80` via `invalidateDomainCache` helper integration |
| `src/middleware/domain.ts` early bypass (above) | Assets on unknown host | P2-6 | Covered via `domain.ts:70-78` read + smoke health on non-brand host still 200 |

### 6.4 Provider integrations lane (depends on Stripe/PayPal/bKash evidence)

| File | Hunks | Why | Test |
|---|---|---|---|
| `src/gateways/base.ts:142-186` | Typed `env?: {KV:KVNamespace}` on `initiate/verify/verifyWebhook/refund/queryRefundStatus` | P1-6 propagation | `lane4:282-293` other adapters ignore extra args without throwing |
| `src/gateways/stripe/stripe.gateway.ts:41-69,160-164` | `initiate` bracketed form `automatic_payment_methods[enabled]=true` + `metadata[edgepay_trx_id]` + flattened `metadata[extra]` loop; signatures now `(params,creds,_env?)` | P1-5 correct V1 form | `lane4:35-95` captured `URLSearchParams` has bracket keys, no JSON `metadata`, `trx_id` wins, content-type header correct |
| `src/gateways/paypal/paypal.gateway.ts:58-212` | `initiate` sets `custom_id`+`invoice_id`=trx_id, `currency_code` uppercased; `getToken` now `KVNamespace`; `verify`/`verifyWebhook` accept `env`; `refund(gatewayTrxId,amount,creds,currency?,env?)` `currency_code=(currency??'USD').toUpperCase()` | P1-3+P1-4+P1-6 | `lane4:98-177` purchase_units have all three IDs + EUR uppercased, refund `BDT/USD` uppercased + default USD when `currency===undefined` (env as 5th arg) |
| `src/gateways/bkash/bkash.gateway.ts:6-...` | Signature `initiate(..., env?:{KV:KVNamespace})` + passes to `getToken` | P1-6 | `lane4:255-280` `BkashApiGateway` token cached when `env` passed, second call hits cache |
| `src/gateways/razorpay/razorpay.gateway.ts`, `src/gateways/nagad/nagad.gateway.ts:4-...` | Signatures add `env?` (ignored), `_currency?` on refund | P1-6 no-op | `lane4:282-293` `razorpay.refund` + `stripe.refund` accept extra args |
| `src/services/payment.ts` PayPal call site `272-...` | `adapter.refund(tx.gateway_trx_id, amount, creds, tx.currency, this.env)` — currency threads through | P1-3 | `payment-integrity` refund path not directly unit-tested (workflow integration), but `lane4:137-177` proves adapter honors 4th arg |

### 6.5 Ancillary (carries prior PR correctness, now reconciled)

| File | Change | Reason |
|---|---|---|
| `wrangler.toml:6-12` | Add `preview_database_id` hint comment (already in prior) + confirm 6 var additions this lane are not config-breaking | Dev/preview isolation |
| `tests/gateways-enabled.test.ts:1-...>28` | New assertions around new diff (gateway `ENABLED_GATEWAYS` still enforced, webhook 404 unknown gateway still 404 — ensures lane did not regress platform gate) | Gate regression guard |
| `.gitignore:+1` | Ignore `.slim/` audit workspace | Hygiene |

---

## 7. Residual Risks & Report-Only Items

> These are **not** shipped fixes; they are explicit acceptances, product decisions, or conditional guidance. No new code is warranted at this volume/evidence.

| Item | Severity If Ignored | Detail | Required Action | When to Revisit |
|---|---|---|---|---|
| **Placeholders `REPLACE_WITH_*` still in `wrangler.toml`** | P0 at deploy | Prod/dev/staging `database_id`, `preview_database_id`, `KV id`/`preview_id` are placeholders; R2 bucket names are not IDs but need binding parity. Deploy with placeholders → D1/KV resolve to wrong/missing target, `DB`/`KV` 500 at runtime even though dry-run passes (dry-run does not validate ID correctness). | Replace every placeholder via `npx wrangler d1 create edgepay-cf` / `kv namespace create KV` per env, or via Deploy Button (provisioning path). Verify `wrangler deploy --dry-run --env dev|staging` lists expected bindings **and** `wrangler d1 migrations apply` succeeds. | Before any env deploy. |
| **Single-currency-per-merchant DO design** | Report-only | `LedgerDO` per-merchant holds a single `currency` param forwarded to `ensureSeeded(currency)`. Multi-currency merchants would collide on one `currency` (chart currency vs posting currency). Current product behavior is **intentionally single-currency per merchant** (fallback 422 `CURRENCY_MISMATCH`); multi-currency is deferred product work, not a DO identity refactor. Docs + Admin API validation must enforce `DEFAULT_CURRENCY` pin per merchant and reject cross-currency `POST /payments` pre-flight. | No code change now. Document/validate single-currency contract in onboarding and `POST /payments` error (already `CURRENCY_MISMATCH`). Revisit only with measured multi-currency requirement → per-`(merchant,currency)` DO id or explicit `currency` partition. | On multi-currency roadmap signal. |
| **R2 `edgepay-uploads` + Custom Hostnames unwired** | Report-only | `[[r2_buckets]]` and `CustomHostnamesService` exist, no upload/provision HTTP surface. Treat as **capability reserves** (R2 for future receipts/receipt-export; Custom Hostnames for per-brand SaaS). Inventing APIs now would be speculative scope. | Leave unwired; hide menu links behind feature flag. If taken up, add `PUT /uploads` + `POST /admin/v1/domains` that call `CustomHostnamesService.provision` and enforce tenant ownership + `active` + token validation per Cloudflare SaaS docs. | Feature request. |
| **Smart Placement + Assets warning** | Low / perf | Wrangler dry-run always warns: `Turning on Smart Placement in a Worker that is using assets and run_worker_first … could result in poor performance`. Guidance is **conditional**: colocate Worker near D1 vs near client. At this stack (<10K writes/day, 2 assets: 608.69 KiB / 131.54 KiB gzip) assets are few and merchant-locality matters less; warning is informational. | Keep `placement.mode=smart` + `run_worker_first=true`. Monitor `asset_served_duration` / `cache_hit` / geo RTT in Workers Analytics after first prod deploy. Only consider `placement` change or asset-split if p95 asset fetch regresses >50%. | After prod cutover with real traffic. |
| **Observability sampling / cost** | Low → Medium if scaled | `[observability.logs] head_sampling_rate=1` (100% Workers Logs) + `[observability.traces] head_sampling_rate=0.01`. 100% logs is **pricey at scale** (per-request log retention/egress). Conditional guidance says reduce sampling with high QPS. | Keep `1` for launch (full fidelity). Alert on log volume growth (>80% of `workers_log` retention or $ threshold). Reduce to `0.1` or `0.05` when daily request count >200K and error rate is low. Keep traces at `0.01` (already cost-friendly). | After traffic crosses 100K req/day. |
| **Queue `max_batch_*` / `max_retries` tuning** | Low | Current (`webhook:10/5s/3`, `email:25/30s/5`, `sms:50/10s/3`) follow Cloudflare defaults. Actual throughput (webhook fan-out, email volume, SMS parse) not yet measured prod-side; tuning is conditional on DLQ depth/consumer lag. | Keep defaults. Monitor DLQ depth (`webhook-out-dlq`, `email-out-dlq`, `sms-parse-dlq`) + `consumer_lag` in Queue dashboard; tune batch size down if per-batch `fetch` OOM (~128MB) or up if lag >5m. No silent discard — DLQs now prevent it. | After first queue metrics (≥1 week prod). |
| **SMS reconciliation stub** | Low | `src/cron/handler.ts:154-168` `processPendingSmsVerifications` iterates `op_sms_parsed` `pending` but `void _sms` (matcher not yet ported). No-op is **safe**: match must go through ledger DO dedup, so this cannot double-post, but manual verification remains required for mobile-gateway flows. | Leave stub. Port matcher (amount + `±10m` window) only when SMS-forwarding flow is launched; add `sms-corroboration` unit test. | Before enabling bKash/Nagad SMS corroboration prod flow. |
| **SSRF private-address filtering — platform behavior undocumented** | Report-only / security | Official Workers fetch docs do **not** claim Cloudflare blocks private destinations generically. App validation is the boundary. This audit verified `isAllowedWebhookUrl` blocks `https: only` + private CIDRs (`10/172.16-31/192.168/169.254/0.0.0.0`) + `.local/.internal/.localhost` + `localhost/127.0.0.1/::1`, and receiver-side checks exist. Do not claim Workers fetch itself blocks SSRF. | Keep allowlist as-is. Re-audit annually against updated Cloudflare docs before strengthening claim. | Annual doc refresh. |
| **Rate Limit `namespace_id` reserved-range assumption** | Low | `1001`/`1002` are deployment-local IDs; binding is GA per [2025-09-19 changelog]. No conflict expected at this account scale, but reused IDs across sibling workers share namespace semantics. | Keep `1001/1002`. If account grows >10 workers sharing RL, migrate to distinct IDs via Cloudflare dashboard enumeration. | Account growth. |
| **`compatibility_date 2026-08-28` deviation** | Low / DX | Audit targeted `2026-08-30`; pinned workerd `1.20260828.1` (via `@cloudflare/vitest-plugin 1.1.2` / miniflare `5.20260828.0-alpha`) and wrangler bundled workerd do **not** know a newer date. In-file comment documents: bump together with devDeps. `nodejs_compat_v2` already default-on from `2026-08-04`, so `nodejs_compat` is forward-safe. | Bump when `wrangler` + `workerd` updates land (watch `changelog:compatibility-dates`). | On next `wrangler` major. |
| **Analytics Engine `ANALYTICS` not queried in dashboards yet** | Report-only | `ANALYTICS.writeDataPoint` emits `webhook_ip_rejected`, `rate_limit_degraded`, `ledger_posting_healed` etc. No dashboard query wired; paging uses `console.error level:page` (relies on log alerts). For true AE cost-efficiency, add SQL `SELECT ... FROM edgepay_metrics` in Cloudflare dashboard. | No code change. Create AE dashboard + Alerts for `page` level before scaling. | Post-launch. |
| **Preview D1 isolation relies on `preview_database_id`** | Low | Top-level and per-env `preview_database_id` are placeholders; Vitest (`cloudflare:test`) forces an in-memory D1 so preview isolation is test-safe, but live preview URLs (Workers preview branch) only isolate if IDs are actually distinct from prod. | Set `preview_database_id` to a distinct D1 per `scripts/bootstrap.sh` output (or omit the key if preview URLs not used). | Before first preview branch deploy. |

---

## 8. Deployment Prerequisites, Rollback & Monitoring

> **Do not deploy until all prerequisites pass. The diff is intentionally narrow (no migrations beyond 0004), so rollback is a single commit revert + KV purging.**

### 8.1 Prerequisites (ordered — fail-closed)

1. **Wrangler + workerd versions pinned.** `package.json:96 wrangler 4.127.1`, `@cloudflare/workers-types 5.20260828.1`, `@cloudflare/vitest-plugin 1.1.2`, `vitest 4.1.0`, `workerd 1.20260828.1` per `allowScripts`. `npm ci` must reproduce. Do not bump `compatibility_date` without bumping these together.
2. **Placeholders replaced.** In `wrangler.toml` replace for **prod**, `env.dev`, `env.staging`: `REPLACE_WITH_*_D1_ID`, `REPLACE_WITH_*_D1_PREVIEW_ID` (or omit the key if no preview), `REPLACE_WITH_*_KV_ID`/`preview_id`. Validate:
   ```bash
   grep -n REPLACE_WITH wrangler.toml
   # must be 0 lines on deploy branch
   ```
3. **Resources exist before deploy.**
   ```bash
   # Preview D1 (isolates preview-URL traffic — see wrangler.toml:82)
   npx wrangler d1 create edgepay-cf && npx wrangler d1 create edgepay-cf-preview
   npx wrangler kv namespace create KV
   npx wrangler r2 bucket create edgepay-uploads && npx wrangler r2 bucket create edgepay-uploads-preview
   npx wrangler queues create webhook-out          && npx wrangler queues create webhook-out-dlq
   npx wrangler queues create email-out            && npx wrangler queues create email-out-dlq
   npx wrangler queues create sms-parse            && npx wrangler queues create sms-parse-dlq
   # (Paid plan $5/mo enables Queues/Workflows at deploy)
   ```
   Script `scripts/bootstrap.sh` now provisions all 3 D1s + 6 queues idempotently; prefer running it once per env.
4. **Migrations applied (including new 0004).**
   ```bash
   npx wrangler d1 migrations apply DB --remote           # prod
   npx wrangler d1 migrations apply DB --remote --env dev # dev  (expects binding name DB)
   npx wrangler d1 migrations apply DB --remote --env staging
   # Verify: npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='op_refunds'"
   #        must show idx_op_refunds_status_created_workflow
   ```
5. **Secrets set (fixed script — no echo of values).**
   ```bash
   # prod
   ./scripts/set-secrets.sh
   # dev
   ./scripts/set-secrets.sh --env dev
   # staging
   ./scripts/set-secrets.sh --env staging
   # Script now uses ENV_ARGS array + "${ENV_ARGS[@]}" — supports bare arg (./scripts/set-secrets.sh dev) for compat.
   # It explicitly paged "secrets are NOT retrievable" and does NOT print them.
   ```
   Required secrets: `JWT_SECRET≥32b`, `APP_KEY`, `ENCRYPTION_KEY` (back this up — gateway credentials unrecoverable without it), plus optional `CF_API_TOKEN/CF_ACCOUNT_ID/CF_ZONE_ID` only if Custom Hostnames are provisioned, and `BREAK_GLASS_CLIENT_ID/SECRET` only for emergency Access bypass (pages on every use).
6. **Access vars populated (prod).** `CF_ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`) + `CF_ACCESS_AUD_TAG` (AUD of the Access app covering `/api/admin/*`). Both empty → `/api/admin/*` returns `503` fail-closed by design. Verify:
   ```bash
   npx wrangler deploy --dry-run | grep -E "CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD_TAG"
   # must show non-empty for prod when Access is intended
   ```
7. **`ALLOWED_ORIGINS` + `ENABLED_GATEWAYS` reviewed per env.**
   - Prod `ALLOWED_ORIGINS=""` (fail-closed, server-to-server + same-origin checkout unaffected) or explicit allowlist `https://shop.example.com,https://admin.example.com`.
   - `ENABLED_GATEWAYS` canonical: `stripe,paypal,bkash-api,razorpay,nagad-merchant-api` (`bkash` ↔ `bkash-api`, `nagad` ↔ `nagad-merchant-api` are aliases). Unknown tokens are dropped; unknown-only list enables **nothing** (verify via `GET /api/v1/gateways` `dropped_aliases`).
8. **Preflight dry-runs (must PASS, warning only Smart Placement).**
   ```bash
   npx tsc --noEmit                                  # 0 errors (strict)
   npm test -- --run                                  # 161/161 (15 files)
   bash -n scripts/set-secrets.sh && bash -n scripts/bootstrap.sh
   git diff --check                                   # no whitespace errors
   npx wrangler deploy --dry-run                      # prod  — lists LEDGER_DO, both Workflows, 3 Queues, 2 Ratelimits, ANALYTICS, ASSETS; only Smart Placement warning
   npx wrangler deploy --dry-run --env dev            # dev   — same; plus preview D1 id visible
   npx wrangler deploy --dry-run --env staging        # staging — same
   ```
   Actual dry-run snapshots 2026-09-01 in §9 confirm all bindings present.
9. **Smoke after deploy (before promoting to live traffic).**
   ```bash
   curl -s https://<worker>.workers.dev/api/v1/health | jq
   # expect {"status":"ok","version":"0.2.3",...}
   curl -i https://<worker>.workers.dev/api/reference | head -n 20  # Scalar HTML 200
   curl -s https://<worker>.workers.dev/api/openapi.json | jq '.openapi'  # 3.1.0
   # Install gate
   curl -s https://<worker>.workers.dev/install | head -n 1
   # Rate limit proof (dev): 3 distinct installs then 429 with Retry-After
   for i in 1 2 3 4; do curl -s -D - https://<worker>.workers.dev/install -H "CF-Connecting-IP: 9.9.9.$i" | grep -iE "ratelimit|retry-after"; done
   ```

### 8.2 Rollback

- **Commit rollback:** The remediation is 25 files + 1 migration + 4 test files, no destructive migration. To revert:
  ```bash
  git revert --no-commit HEAD  # or git restore --source=8995b37 <files>
  git commit -m "Revert 2026-09-01 audit remediation"
  npx wrangler deploy --env dev && npx wrangler deploy --env staging
  # Do NOT revert prod until inner-ring envs prove the revert is clean.
  ```
- **Migration 0004 rollback:** It is a single `CREATE INDEX IF NOT EXISTS` — safe to leave on revert (no DDL revert needed). If you truly must drop: `npx wrangler d1 execute DB --remote --command "DROP INDEX IF EXISTS idx_op_refunds_status_created_workflow"`.
- **KV state to purge after rollback:** `system:installed` is sticky. If rollback touches install semantics, `npx wrangler kv key delete --namespace-id <KV_ID> --binding KV "system:maintenance"` to clear maintenance gate forced in tests; `domain:*` / `domain-v2:*` to clear resolver cache.
- **Secret rollback:** Secrets are not versioned by Wrangler; re-put the prior values via `./scripts/set-secrets.sh` (the fixed script pages that they must be retained externally).

### 8.3 Monitoring (first week)

| Signal | Where | Alert Threshold |
|---|---|---|
| `level:page` (console.error page) — `LEDGER_RECONCILIATION_DRIFT`, `REFUND_STUCK_MANUAL_REVIEW`, `LEDGER_POSTING_REJECTED`, `rate_limit_degraded`, break-glass paging | Workers Logs / Logpush | Any occurrence → page runbook (investigate immediately) |
| Queue DLQ depth `webhook-out-dlq` / `email-out-dlq` / `sms-parse-dlq` | Queues Dashboard | `>0` for >15m → drain/inspect; `>100` → incident |
| Queue consumer lag (webhook batch 10/5s) | Queue metrics | `>5m` → tune `max_batch_size` / scale consumer |
| `webhook_signature_rejected` / `webhook_ip_rejected` / `webhook_geo_rejected` spikes | `ANALYTICS` + Logs | `>5%` of inbound webhook rate over 10m → allowlist/geo misconfig or attack |
| D1 `op_ledger_postings status='pending'` row age | `SELECT COUNT(*) FROM op_ledger_postings WHERE status='pending' AND created_at < datetime('now','-1 hour')` | `>0` rows older than 1h → reconciliation lag (check hourly cron `hourly_posting_replay` metric) |
| `op_refunds workflow_attempts` near `3` | `SELECT COUNT(*) FROM op_refunds WHERE status='pending' AND workflow_attempts>=3` | `>0` → terminal refunds awaiting manual review |
| Workers CPU / subrequest limit hits | Workers Analytics (free: 10ms CPU, 128MB, 50 subrequests) | CPU >8ms p95 or `Subrequest limit exceeded` → lower `PBKDF2_ITERATIONS` to `100000` and cache more aggressively |

---

## 9. Validation Evidence

> All validation captured 2026-09-01 against the combined remediation diff (§6) on Node ≥20 with the pinned stack.

### 9.1 Full suite

```text
npm test -- --run

 Test Files  15 passed (15)
      Tests  161 passed (161)
   Start at  07:47:44
   Duration  5.98s (transform 900ms, setup 1.83s, import 248ms, tests 1.65s)

 Suits: gateways-enabled (14), smoke (4), lane3-edge-operations (22),
        jwt (10), lane4-provider (9), money (8), workflow-policy (6),
        ledger-do (14), ledger-consistency (3), access-jwt (10),
        payment-integrity (7), lane1-tenant-middleware (19),
        api-middleware (14), api-reference (8), gateways (13)
```

Individual lane proofs (also green in full suite):

- `tests/lane1-tenant-middleware.test.ts 19/19` — tenant 403 both auth types + master bypass, install exact/wildcard/single-charge, maintenance 503 vs bypasses, idempotency clone/replay/409/GET passthrough, domain normalization invalidation.
- `tests/lane3-edge-operations.test.ts 22/22` — brand-color strict hex + injection, both-prefix invalidation + normalize, cron both-prefix integration, inbound deterministic hash/dedup/cap/geo fail-closed matrix, outbound `msg.attempts` escalation + stable headers, DLQ config assertions, script hygiene.
- `tests/lane4-provider.test.ts 9/9` — Stripe bracketed form, PayPal custom/invoice IDs + uppercase currency + refund currency 4th-arg + default USD, adapter KV propagation (PayPal/bKash cached), other adapters tolerate extra args.
- `tests/payment-integrity.test.ts 7/7` — createIntent paired batch, initiatePayment same `updated_at` batch, completeTransaction D-failure not-completed, retry→duplicate-dedup + atomic completed batch, E/F pending heal, refund composite index + `EXPLAIN QUERY PLAN` uses index.
- Prior suites still green: `access-jwt 10, ledger-do 14, ledger-consistency 3, smoke 4, gateways 13, workflow-policy 6, jwt 10, money 8, api-middleware 14, api-reference 8, gateways-enabled 14`.

### 9.2 Typecheck

```text
npm run typecheck   # tsc --noEmit, strict, noUnusedLocals/Params etc.
# (no output — exit 0, 0 errors)
```

### 9.3 Shell checks

```text
bash -n scripts/set-secrets.sh && echo "set-secrets bash -n OK"
# → set-secrets bash -n OK
bash -n scripts/bootstrap.sh && echo "bootstrap bash -n OK"
# → bootstrap bash -n OK
git diff --check
# → (no output — no whitespace errors)
```

### 9.4 Wrangler dry-runs (bindings + warnings)

All three envs **PASS** with only the expected Smart Placement warning:

> `⚠ Turning on Smart Placement in a Worker that is using assets and run_worker_first set to true means that your entire Worker could be moved to run closer to your data source … https://developers.cloudflare.com/workers/static-assets/binding/#smart-placement`

- **`wrangler deploy --dry-run` (prod):** `Total Upload: 608.69 KiB / gzip: 131.54 KiB`, bindings: `LEDGER_DO`, `REFUND_WORKFLOW`, `SWEEP_WORKFLOW`, `KV`, `WEBHOOK_QUEUE/EMAIL_QUEUE/SMS_QUEUE`, `DB (REPLACE_WITH_D1_PREVIEW_ID)`, `R2 (edgepay-uploads)`, `ANALYTICS (edgepay_metrics)`, `RATE_LIMIT_READ/WRITE` (120/60 30/60), `ASSETS`, 18 `Environment Variable`s including `ENABLED_GATEWAYS`, `ALLOWED_ORIGINS`, `APP_VERSION 0.2.3`.
- **`--env dev`:** same bindings (`edgepay-cf-dev`, `DB edgepay-cf-dev` / `REPLACE_WITH_DEV_D1_PREVIEW_ID`, `R2 edgepay-uploads-dev`, `KV REPLACE_WITH_DEV_KV_ID`, all 3 Queues, both Workflows, both Ratelimits, ANALYTICS, ASSETS), vars `ENVIRONMENT=development APP_URL=http://localhost:8787 APP_DOMAIN=localhost ALLOWED_ORIGINS=http://localhost:3000`.
- **`--env staging`:** same shape (`edgepay-cf-staging`, `R2 edgepay-uploads-staging`, `KV REPLACE_WITH_STAGING_KV_ID`, …), vars `ENVIRONMENT=staging`.

No `env.LEDGER_DO is undefined` error — the P0 env-isolation regression is dead.

### 9.5 Git diff

```text
git diff --stat
 .gitignore                                |   1 +
 scripts/bootstrap.sh                      |   8 +-
 scripts/set-secrets.sh                    |  31 +++---
 src/controllers/admin-api.ts              |  16 ++-
 src/controllers/api.ts                    |   6 +-
 src/controllers/checkout.ts               |   9 +-
 src/controllers/webhooks.ts               |  45 ++++++---
 src/cron/handler.ts                       |   8 +-
 src/gateways/base.ts                      |  14 ++-
 src/gateways/bkash/bkash.gateway.ts       |   6 +-
 src/gateways/nagad/nagad.gateway.ts       |   4 +-
 src/gateways/paypal/paypal.gateway.ts     |  26 +++--
 src/gateways/razorpay/razorpay.gateway.ts |   8 +-
 src/gateways/stripe/stripe.gateway.ts     |  32 +++---
 src/index.ts                              |  24 ++++-
 src/lib/error.ts                          |   6 ++
 src/middleware/auth.ts                    |  13 ++-
 src/middleware/domain.ts                  |  18 +++-
 src/middleware/idempotency.ts             |   4 +-
 src/queues/webhook-consumer.ts            |  20 +++-
 src/services/custom-hostnames.ts          |  17 +++-
 src/services/payment.ts                   | 161 +++++++++++++++++++----------
 src/services/refund.ts                    |   2 +-
 tests/gateways-enabled.test.ts            |  28 +++++-
 wrangler.toml                             |   6 ++
 25 files changed, 359 insertions(+), 154 deletions(-)
# plus untracked: migrations/0004_payment_integrity.sql, tests/lane1-tenant-middleware.test.ts,
#                 tests/lane3-edge-operations.test.ts, tests/lane4-provider.test.ts, tests/payment-integrity.test.ts
```

`git diff --check` clean; `bash -n` clean; `tsc` clean; `vitest` 161/161.

---

## 10. Remediation Matrix (Concise)

| ID | Severity | Area | One-Line Fix | Primary File(s) | Bound to Test |
|---|---|---|---|---|---|
| P0-2 | P0 | Payment/D1 atomicity | `createIntent/initiatePayment/completeTransaction` → `DB.batch()` + deterministic gateway `ORDER BY id` + `GATEWAY_NOT_CONFIGURED` + ledger-first | `src/services/payment.ts`, `src/lib/error.ts`, `migrations/0004` | `payment-integrity 7/7` |
| P0-3 | P0 | Tenant isolation | API key + JWT now 403 when `domain merchant != auth merchant` | `src/middleware/auth.ts` | `lane1 7/7` tenant mismatch |
| P0-4 | P0 | Middleware mounting | Mount `domain` then `maintenance` globally; `/install`+`/assets`+`/favicon` bypass | `src/index.ts`, `src/middleware/domain.ts` | `lane1` maintenance + smoke |
| P0-1* | P0 | Config/deploy | (Carry-forward v0.2.2 — full bindings per env; `[[migrations]]` not repeated) | `wrangler.toml` | dry-run per env |
| P1-2 | P1 | Ledger integrity | Ledger-before-completed ordering + atomic both-completed batch + idempotent guard | `src/services/payment.ts` | `payment-integrity` D/E/F fault matrix |
| P1-3 | P1 | PayPal refund | Pass `currency` through, `currency_code=(currency??'USD').toUpperCase()` | `src/gateways/paypal/paypal.gateway.ts`, `src/services/payment.ts` | `lane4` PayPal refund |
| P1-4 | P1 | PayPal webhook | `custom_id→invoice_id→custom→supplementary_data.order_id`, initiate sets both | `src/controllers/webhooks.ts`, `src/gateways/paypal/paypal.gateway.ts` | `lane4` extractor |
| P1-5 | P1 | Stripe form | `automatic_payment_methods[enabled]=true`, `metadata[edgepay_trx_id]` bracketed | `src/gateways/stripe/stripe.gateway.ts` | `lane4` Stripe bracketed |
| P1-6 | P1 | Token cache | Thread `env:{KV}` through `initiate/verify/verifyWebhook/refund/queryRefundStatus` | `src/gateways/base.ts`, `*_gateway.ts`, `src/services/payment.ts`, `src/controllers/webhooks.ts` | `lane4` KV propagation |
| P1-7 | P1 | Install limiter | Prefix middleware before route, `__installLimited` single-charge | `src/index.ts` | `lane1` 3/7 limiter tests |
| P1-8 | P1 | Webhook inbound | 1 MiB cap (header+body), deterministic `hash:sha256` fallback, fail-closed geo | `src/controllers/webhooks.ts` | `lane3` 6/22 webhook inbound |
| P1-9 | P1 | Webhook outbound | `msg.attempts` escalation + stable `Delivery-Id/Idempotency-Key` | `src/queues/webhook-consumer.ts` | `lane3` 8/22 webhook outbound |
| P1-10 | P1 | Checkout CSS | `sanitizeBrandColor` strict `^#[0-9a-fA-F]{6}$` | `src/controllers/checkout.ts` | `lane3` brand-color |
| P2-1 | P2 | Queues | `email-out-dlq` + `sms-parse-dlq` all envs | `wrangler.toml`, `scripts/bootstrap.sh` | `lane3` DLQ assertions |
| P2-2/3 | P2 | Scripts | Array `ENV_ARGS`, no secret echo, preview D1 + DLQs in bootstrap | `scripts/set-secrets.sh`, `scripts/bootstrap.sh` | `lane3` script hygiene |
| P2-4/5 | P2 | Domain cache | Both-prefix invalidation, `normalizeHostname` lowercase+trim | `src/services/custom-hostnames.ts`, `src/controllers/admin-api.ts`, `src/cron/handler.ts` | `lane3` + `lane1:441-488` |
| P2-6 | P2 | Domain bypass | `/install` + `/assets/*` + `/favicon.ico` bypass before KV/D1 | `src/middleware/domain.ts` | `lane1` maintenance bypass |
| P2-7 | P2 | Index | `idx_op_refunds_status_created_workflow` | `migrations/0004_payment_integrity.sql` | `payment-integrity` EXPLAIN |
| P2-8/9 | P2 | Config hygiene | Per-env full var set (carry-forward), `GatewayNotConfiguredError` typed | `wrangler.toml`, `src/lib/error.ts` | `payment-integrity` |

*\*P0-1 is the v0.2.2 env-isolation fix included for completeness — no new hunk in this diff but it gates every other fix (verified still intact in §9 dry-runs).*

---

## 11. Cloudflare Source Links

*All links are the docs version searched during this audit (canonical, not archived snapshots). URLs that appear as `search_cloudflare_documentation` hits are now rendered as direct developer docs URLs below.*

| Topic | Canonical URL |
|---|---|
| Durable Objects — binding + `blockConcurrencyWhile` | https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile |
| Durable Objects — Best Practices (`use blockConcurrencyWhile sparingly`) | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/#use-blockconcurrencywhile-sparingly |
| Durable Objects — Environments (bindings not inherited) | https://developers.cloudflare.com/durable-objects/reference/environments/ |
| Durable Objects — Migrations (`new_sqlite_classes`) | https://developers.cloudflare.com/durable-objects/reference/migrations/ |
| D1 — Reference / Migrations / Wrangler commands | https://developers.cloudflare.com/d1/reference/migrations/ · https://developers.cloudflare.com/d1/wrangler-commands/ |
| D1 — Drizzle example (drizzle-orm removed, raw `prepare` kept) | https://developers.cloudflare.com/d1/examples/d1-and-drizzle-orm/ |
| KV — Concepts (eventual consistency) | https://developers.cloudflare.com/kv/concepts/how-kv-works/ |
| Queues — Get Started / Configuration / DLQ | https://developers.cloudflare.com/queues/get-started/ · https://developers.cloudflare.com/queues/configuration/ |
| Workflows — Build / Trigger / `NonRetryableError` | https://developers.cloudflare.com/workflows/build/trigger-workflows/ · https://developers.cloudflare.com/workflows/build/workers-api/#nonretryableerror |
| Rate Limiting — Binding (`[[ratelimits]]` + `binding.limit`) + GA changelog | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ · https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ |
| Analytics Engine — Datasets (`[[analytics_engine_datasets]]`) | https://developers.cloudflare.com/workers/wrangler/configuration/#analytics-engine-datasets |
| Static Assets — Routing / Binding (`run_worker_first`, `ASSETS.fetch`) / Smart Placement | https://developers.cloudflare.com/workers/static-assets/routing/worker-script/ · https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first · https://developers.cloudflare.com/workers/static-assets/binding/#smart-placement |
| Placement (Smart Placement) | https://developers.cloudflare.com/workers/configuration/placement/ |
| Cron Triggers | https://developers.cloudflare.com/workers/configuration/cron-triggers/ |
| Observability — Logs (`head_sampling_rate`) / Traces | https://developers.cloudflare.com/workers/observability/logs/workers-logs/#head-based-sampling · https://developers.cloudflare.com/workers/observability/traces/ |
| Compatibility Dates / Node.js `nodejs_compat` | https://developers.cloudflare.com/workers/configuration/compatibility-dates/ · https://developers.cloudflare.com/workers/runtime-apis/nodejs/ |
| Wrangler — Configuration / Environments | https://developers.cloudflare.com/workers/wrangler/configuration/ · https://developers.cloudflare.com/workers/wrangler/environments/ |
| Workers Types (`wrangler types`) | https://developers.cloudflare.com/workers/wrangler/configuration/ |
| Access — JWKS (`/cdn-cgi/access/certs`) / Service Tokens / Apps | https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/ · https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/ · https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/ |
| Custom Hostnames API (Cloudflare for SaaS) | https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/ |
| Workers — Fetch Runtime | https://developers.cloudflare.com/workers/runtime-apis/fetch/ |
| Workers Testing — Vitest Integration (`cloudflareTest()`) | https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ |
| Library Context7 — Hono / jose / decimal.js / zod | https://hono.dev/docs/middleware/builtin/pretty-json · https://github.com/panva/jose/blob/main/docs/jwt/sign/classes/SignJWT.md · https://mikemcl.github.io/decimal.js/#clone · https://zod.dev/ |

**Provider evidence (fixed per lane 4):**

- Stripe PaymentIntent V1 — form-encoded `automatic_payment_methods[enabled]=true` and `metadata[edgepay_trx_id]` bracket notation (official Stripe API doc, applied in `stripe.gateway.ts:41-69`).
- PayPal Orders V2 — `purchase_units[].custom_id` + `invoice_id`, capture webhook `resource.supplementary_data.related_ids.order_id`, partial refund `amount.currency_code` must match capture currency (PayPal REST docs, applied in `paypal.gateway.ts:58-212` and `webhooks.ts:231-240`).

---

## 12. Appendix — Inventory, Rename, Prior Releases

### 12.1 File inventory (read)

`src/index.ts`, `types/env,db,ledger`, `lib/crypto,jwt,money,db,error,logger,observability,ledger-chart,validation`, `do/ledger-do`, `services/ledger,ledger-audit,payment,refund,reconciliation,webhook-dispatcher,sms-parser,sms-corroboration,custom-hostnames`, `gateways/base,index,enabled,stripe,paypal,bkash,razorpay,nagad` (+ `PENDING_GATEWAYS` 118 stubs), `middleware/auth,rate-limit,cloudflare-access,domain,csrf,maintenance,security-headers,idempotency`, `controllers/api,admin-api,checkout,webhooks,mobile,install,api-reference`, `queues/webhook,email,sms`, `cron/handler`, `workflows/refund-reconciliation,reconciliation-sweep`, `openapi.ts`, `migrations 0001-0004`, `db/seeds.sql`, `public/assets/css/checkout.css` + config/test/docs/scripts as in `package.json:23-34` `cloudflare.products`.

### 12.2 Rename OwnPay → EdgePay (v0.2.2 carry-forward, preserved)

Ordered `sed` `OWNPAY→EDGEPAY → OwnPay→EdgePay → Ownpay→Edgepay → own-pay→edgepay → ownpay→edgepay` across 40 files; 132 `edgepay/EdgePay` hits. Intentionally retained 4 hits: `op_` DB prefix comment `migrations/0001:3-5`, `ownpay_trx_id` dual-read fallback `src/controllers/webhooks.ts:231`, historical OwnPay GitHub link `README.md:3` annotated `(now EdgePay)`, SQL comments. Verified post-rename via `grep -R "ownpay\|OwnPay" --include="*.ts,*.toml,..." → 4 intentional`.

### 12.3 Prior release claims — what changed vs what is still true

*Preserve-useful, replace-stale per OpCo instruction:*

| Prior Report Claim | Still Accurate? | Correction in This Report |
|---|---|---|
| Wrangler `3.114.17 → 4.127.1`, `compatibility_date 2024-10-22 → 2026-08-28`, nested `observability.logs/traces`, `vitest 4.x + @cloudflare/vitest-plugin 1.1.2`, `op_` retention, `edgepay_trx_id ?? ownpay_trx_id` dual-read, ledger 6-step protocol + `blockConcurrencyWhile` never throws + dedup/heal, Access JWKS EC/RSA + break-glass, per-key RateLimit degraded-allow, `run_worker_first=true`, per-tenant LedgerDO cheaper than per-account | ✅ Keep | Cited verbatim where still evidence-backed (contracts unchanged). |
| `82/82` (v0.2.2) then `104/104` (v0.2.3) tests | ❌ Stale | **161/161 across 15 suites** (see §9). Prior totals are archival. |
| `head_sampling_rate=1` at top-level | ⚠️ Legacy form | Nested `[observability.logs] head_sampling_rate=1` + `[observability.traces] head_sampling_rate=0.01` is the current form (top-level still works but is legacy). Docs link updated (§4). |
| Env-isolation snippet showed `[[env.dev.migrations]]` | ❌ Docs-inaccurate snippet | **`[[migrations]] v1` is inherited, not repeated** — repeating `v1` risks duplicate-tag error (see §3/§4). Per-env dry-runs prove inheritance works. |
| `compatibility_date 2026-08-30` target | ⚠️ Deviation documented | `2026-08-28` is the newest date known by the pinned `workerd 1.20260828.x` + `wrangler 4.127.1` bundled workerd; `2026-08-30` not yet released — in-file comment documents the bump-with-devDeps rule. |
| “All audit items are FIXED” without gate nuance | ⚠️ Overstates gate | This report adds §1 Oracle gate notice: **three pre-analysis gate failures, zero Oracle findings, must not imply Oracle approval**. |

### 12.4 Known platform discoveries (carry-forward, still load-bearing)

- **Throw inside `blockConcurrencyWhile` breaks the DO input gate** — `postTransaction` therefore never throws; failures are structured `failed` results and `LedgerService` re-throws worker-side.
- **DO writes commit on event completion** even when returning `failed` — no rollback; `tx_id` dedup + reconciliation heal converge every ordering (pinned by `ledger-do 14` + `ledger-consistency 3` + `payment-integrity 3` E/F heals).
- **workerd ECDSA uses raw `r||s`** (JWS) not DER — Access verifier accepts both (`Raw 64 ↔ DER` conversion, `access-jwt 10`).

### 12.5 Config snapshot (current pin)

`wrangler.toml:1-12` `compatibility_date 2026-08-28` `nodejs_compat`; `[observability]` enabled + `logs 1` + `traces 0.01`; `[placement] smart`; `[[d1_databases]]` with `preview_database_id` + `migrations_dir`; `[[kv_namespaces]]` + `preview_id`; `[[r2_buckets]]` + `preview_bucket_name`; `[[queues.producers/consumers]]` + `dead_letter_queue` ×3; `[[durable_objects.bindings]] LEDGER_DO` + `[[migrations]] v1`; `[[workflows]]` ×2; `[[ratelimits]] 1001/1002`; `[[analytics_engine_datasets]] edgepay_metrics`; `[assets] run_worker_first=true`; `vars` full 18 per env (prod `ALLOWED_ORIGINS=""`, dev `http://localhost:3000`), `ENABLED_GATEWAYS` 5 gateways; `package.json` `hono@4.11.2 jose@5.9.6 decimal.js@10.4.3 zod@3.23.8 @hono/zod-validator@0.9.0 @scalar/hono-api-reference 0.12.0`.

---

**End of report — `EDGEPAY_AUDIT_REPORT.md` (2026-09-01). Validation owner: report author (Fixer). Gate status: Oracle unavailable before analysis; approver-approval not claimed.**
