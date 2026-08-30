# Test Results — EdgePay-CF v0.2.3 (Deploy Button + Gateway Selection + API Reference)

## Summary

```
Test Files  11 passed (11)
Tests       104 passed (104)   — stable across 3 consecutive runs
Typecheck   0 errors (tsc --noEmit, strict)
Duration    ~5s
Stack       wrangler 4.127.1 / workerd 1.20260828.1 /
            vitest 4.1.11 / @cloudflare/vitest-plugin 1.1.2 /
            hono 4.13.5 / zod 3.25.76 / @hono/zod-validator 0.9.0 /
            @scalar/hono-api-reference 0.12.0 (workerd-safe: HTML-only rendering)
Config      wrangler deploy --dry-run PASS (prod, dev, staging)
```

## What v0.2.3 added

### Deploy to Cloudflare button

- README badge + `deploy.workers.cloudflare.com/?url=<repo>` (template URL:
  replace `JonyBepary`).
- `package.json → cloudflare` metadata (label/products/categories/docs_url) +
  `cloudflare.bindings` descriptions for every setup-page field — including
  the gateway-plugin selector `ENABLED_GATEWAYS` and the three required
  secrets with generation commands.
- `scripts.deploy = "npm run db:migrations:apply && wrangler deploy"` with
  `db:migrations:apply = "wrangler d1 migrations apply DB --remote"` —
  migrations target the **binding name** so they hit whatever D1 the button
  provisions (all other db:* scripts migrated to binding names too).
- `.dev.vars.example` added (dotenv template; its keys are the deploy-button
  secret fields).

### Gateway-plugin selection (ENABLED_GATEWAYS platform gate)

- `src/gateways/enabled.ts`: pure parser (aliases, dedup, separators,
  case-insensitive), memoized env accessor, `isGatewayEnabled`/
  `assertGatewayEnabled`. Fail-closed: unknown-only lists enable NOTHING;
  unset/`all` = every adapter (v0.2.2 back-compat).
- Enforcement at NEW-operation entry points only:
  `PaymentService.executePayment` (422 GATEWAY_DISABLED), merchant refund API
  (422), inbound `/webhook/{gateway}` (404 UNKNOWN_GATEWAY, indistinguishable
  from unregistered). In-flight callback + refund workflows deliberately
  exempt (never strand money).
- `GET /api/v1/gateways` catalog route (auth'd): enabled adapters with
  metadata + credential-field definitions (names only), `dropped_aliases`
  typo feedback, `pending_count`.
- `GET /install` requirements check now also reports the gateway selection and
  secret POSTURE (length class only — ok/weak/missing, never content).

### OpenAPI 3.1 + Scalar API reference

- `src/openapi.ts` — hand-maintained OpenAPI 3.1 document (single source of
  truth for the wire contract), built per request from APP_URL/APP_NAME/
  APP_VERSION: 30+ paths across 8 tags, 3 security schemes, shared schemas
  (Money as decimal string, error envelope), outbound webhook events declared
  in the top-level `webhooks` section.
- `src/controllers/api-reference.ts` — `GET /api/openapi.json` +
  `GET /api/reference` (Scalar via `@scalar/hono-api-reference`, CDN pinned
  to `@scalar/api-reference@1.67.0`). Per-request nonce generated in the
  route, embedded on both script tags by Scalar's `nonce` option, mirrored
  into a tailored CSP (`script-src 'self' 'nonce-…' https://cdn.jsdelivr.net`
  — still no unsafe-inline scripts; `style-src 'unsafe-inline'` only).
- `src/middleware/security-headers.ts` now PRESERVES a route-set CSP instead
  of clobbering it (all other /api/* responses keep the strict default —
  pinned by test).

### Latent config bug fixed (same class as the audit's P0)

`[env.dev.vars]`/`[env.staging.vars]` previously declared only 5 of 18 vars —
**vars are non-inheritable** (Wrangler environments docs), so dev/staging
Workers ran with `APP_NAME`/`DEFAULT_CURRENCY`/`JWT_ISSUER`/… undefined at
runtime. Both environments now declare the complete var set (verified in
dry-run output: `SESSION_TTL_SECONDS`, `ENABLED_GATEWAYS`, … present for dev
and staging). APP_VERSION bumped to 0.2.3 everywhere (wrangler.toml ×3,
package.json, openapi info, tests).

### New test suites (22 tests)

- `tests/gateways-enabled.test.ts` (15): parser semantics (defaults, `all`/
  `*`, alias mapping, dedup, separators, case/whitespace, typo feedback,
  fail-closed), memoization identity, helper contracts (422
  GATEWAY_DISABLED), route wiring (catalog requires auth, install check
  surfaces selection + posture with unique client IPs to stay off the 3/hour
  limiter, unregistered webhook 404).
- `tests/api-reference.test.ts` (8): document validity (3.1.0, version,
  servers, 16 representative paths, ≥25 total, 3 auth schemes, 3 outbound
  webhook events), strict CSP retained on the JSON document, Scalar HTML
  with pinned CDN, nonce consistency between script tags AND the CSP header,
  fresh nonce per request, script-src never contains unsafe-inline, OWASP
  headers still set on the docs page.
- Updated `tests/api-middleware.test.ts` APP_VERSION pin 0.2.2 → 0.2.3 (the
  merge-semantics guard now proves ENABLED_GATEWAYS survives the miniflare
  binding override too).

---

# Prior release: v0.2.2 (Audit Fixes)

## Summary

```
Test Files  9 passed (9)
Tests       82 passed (82)     — stable across 3 consecutive runs
Typecheck   0 errors (tsc --noEmit, strict)
Duration    ~4.5s
Stack       wrangler 4.127.1 / workerd 1.20260828.1 /
            vitest 4.1.11 / @cloudflare/vitest-plugin 1.1.2 /
            hono 4.13.5 / zod 3.25.76 / @hono/zod-validator 0.9.0
Config      wrangler deploy --dry-run PASS (prod, dev, staging)
```

## What v0.2.2 changed (the audit's fixes, implemented and verified)

### Branding normalization (audit §7 — reproduced faithfully)

The audited state was recreated from the v0.2.1 tree: ordered sed
(`BRAND_NORMALIZATION → 
BRAND_NORMALIZATION`) across the same 40 files, then the four intentional
retentions restored exactly as §7 documents them:

| Retained | Where |
|---|---|
| `op_` table prefix + "original upstream schema" comment | `migrations/0001_initial_schema.sql:3-5` |
| `legacy_trx_id` dual-read fallback in the Stripe extractor | `src/controllers/webhooks.ts` |
| Historical upstream reference, annotated "(now EdgePay)" | `README.md:3` |
| Historical SQL comments | `migrations/` |

Post-rename grep count matches §7's verification (4 intentional hits).
`package.json` + `package-lock.json` parse clean.

### P0 — Environment isolation (was: `env.LEDGER_DO is undefined` on `--env dev`)

- `env.dev` and `env.staging` now declare EVERY binding: D1 (+ preview DB),
  KV, R2, `durable_objects`, both Workflows, all 3 Queue producers +
  consumers (incl. DLQ), both Ratelimit bindings, Analytics Engine, assets,
  placement, observability.
- Verified empirically: `wrangler deploy --dry-run --env dev` now lists
  `env.LEDGER_DO (LedgerDO)`, both Workflows, Queues, Rate Limits, ASSETS.
- **Documented deviation from the audit's snippet:** `[[env.dev.migrations]]`
  is intentionally NOT repeated — per the current Wrangler configuration docs
  the DO `[[migrations]]` block is NOT in the non-inheritable keys list (it is
  inherited); repeating tag `v1` risks a duplicate-tag error. Dev/staging
  dry-runs confirm inheritance works.
- `preview_database_id` added to the prod (and env) D1 blocks.

### P1 — Compatibility & observability

- `compatibility_date`: `2024-10-22` → **`2026-08-28`**. **Documented
  deviation:** the audit targeted `2026-08-30`, but no released workerd knows
  a date that new yet (latest published: `1.20260829.1`). `2026-08-28` is the
  newest date supported by BOTH runtimes this repo uses (the pinned test
  stack: miniflare `5.20260828.0-alpha` / workerd `1.20260828.1`, and
  wrangler `4.127.1`'s bundled workerd). Bump together with devDependencies.
- `nodejs_compat_v2` behavior is default-on from 2026-08-04; the explicit
  `nodejs_compat` flag is kept (forward-safe, documents intent).
- Observability split per current docs: `[observability.logs]
  head_sampling_rate = 1` + `[observability.traces] enabled = true,
  head_sampling_rate = 0.01`. (Docs-verified: the traces nested key is
  current; logs sampling accepts the nested form.)
- Dependency stack modernized: wrangler `3.114.17` → `4.127.1`; the test
  runner migrated from the legacy `@cloudflare/vitest-pool-workers`
  `defineWorkersConfig` API to the current **`@cloudflare/vitest-plugin`
  `cloudflareTest()`** Vite plugin (the migration path Cloudflare documents).
  Old `singleWorker: true, isolatedStorage: false` maps to native
  `maxWorkers: 1, isolate: false` (docs-recommended for shared-state tests).
- `cloudflare:test` types now load via
  `"types": ["@cloudflare/vitest-plugin/types"]`.

### P2 — Library hygiene (all 7 items)

1. **drizzle-orm removed** — was installed but never imported (grep → 0).
2. **zod ADOPTED** — new `src/lib/validation.ts` schemas +
   `@hono/zod-validator` on the money-critical routes (`POST /payments`,
   `POST /refunds`). Typed `c.req.valid('json')`; the validator hook maps
   failures onto the existing `400 VALIDATION_ERROR` contract (response
   shape unchanged). Pinned by 7 schema unit tests.
3. **prettyJSON gated** to `ENVIRONMENT=development` (prod pays no
   pretty-print CPU/bytes).
4. **requestId() before logger()** — request id available to access logs.
5. **CORS fail-closed allowlist** — `origin: '*'` replaced by an
   `ALLOWED_ORIGINS` (comma-separated) check; empty/unset = no cross-origin
   browser access. Server-to-server calls and same-origin checkout
   unaffected. Pinned by 5 tests (allowed echo, disallowed no-ACAO,
   preflight both ways, no-Origin).
6. **jose hardening** — `aud:"mobile"` now SET at signing and REQUIRED at
   verify; `algorithms: ['HS256']` pinned (HS384 token rejected, test-pinned);
   HS256 secret must be ≥ 32 chars at `createJwtService` (test-pinned).
7. **decimal.js** — isolated `MoneyDecimal = Decimal.clone({precision: 30,
   rounding: ROUND_HALF_UP})` (no more global `Decimal.set` mutation;
   test PROVES money math survives a trashed global config), and
   `toMinorUnits` now converts via `toFixed(0) + parseInt` with a loud
   `RangeError` past 2^53 (old `.toNumber()` silently corrupted; boundary
   exactness at `Number.MAX_SAFE_INTEGER` test-pinned).
8. **security-headers middleware mounted** (was dead code) on the JSON
   surfaces `/api/*` + `/webhook/*` — nonce CSP, `X-Frame-Options: DENY`,
   nosniff, Referrer-Policy, Permissions-Policy. NOT mounted on HTML routes
   on purpose: checkout/Razorpay templates embed inline scripts that a nonce
   policy would break until the templates plumb nonces through (follow-up
   work). The global `secureHeaders()` builtin is aligned (DENY /
   strict-origin-when-cross-origin) so it cannot post-overwrite the custom
   policy. Pinned by 3 tests.

### §3 DO row — ensureSeeded per request → constructor (once per isolate)

`LedgerDO` now creates its SQLite tables in a constructor
`blockConcurrencyWhile` (the docs-recommended one-time-init pattern); read
RPCs lost their per-call `CREATE TABLE IF NOT EXISTS` tax entirely, and the
14-row chart seed is guarded per-isolate (`seededCurrency`). All 14
ledger-do + 3 ledger-consistency tests still pass — the posting protocol's
semantics are unchanged.

**Documented decision — blockConcurrencyWhile stays around the posting
critical section.** The audit's §3 row notes the docs' "use
blockConcurrencyWhile sparingly / prefer storage.transaction" guidance as a
throughput concern (~200 req/s per DO). It is intentionally NOT restructured:
(a) the DO is per-tenant, so the held window only serializes ONE merchant's
postings — ~200 req/s per merchant is 2 orders above realistic payment rates;
(b) the 6-step protocol's correctness (check-then-write across D1 + DO)
depends on the serialization — `ctx.storage.transaction` cannot cover the
external D1 hops that sit inside the critical section; (c) the protocol is
the centerpiece of the v0.2.1 review fixes and is pinned by 17 tests. The
wasteful part (per-request seeding) is what got fixed.

### Test matrix (82 = 50 carried + 32 new)

| Suite | Tests | Covers |
|---|---|---|
| smoke | 4 | boot, 404 envelope, preflight |
| gateways | 13 | adapter metadata + HMAC verify |
| access-jwt | 10 | Access JWKS (ES256 raw↔DER, RS256, fail-closed) |
| ledger-do | 14 | posting protocol + failure matrix + heal |
| ledger-consistency | 3 | parallel storms + property test |
| workflow-policy | 6 | refund backoff policy |
| **jwt (new)** | 10 | aud, algorithms pin, secret length, type confusion, issuer |
| **money (new)** | 8 | clone isolation, exactness, 2^53 boundary, RangeError |
| **api-middleware (new)** | 14 | CORS fail-closed/allowlist, security headers, zod schemas, binding merge guard |

## What v0.2.1 changed (the review's fixes — carried forward)

1. **Cross-system atomicity gap — CLOSED.** One per-tenant `LedgerDO`
   (SQLite) owns the merchant's ENTIRE chart. A multi-account posting is a
   single serialized RPC — no per-account DO fan-out. Six-step protocol
   (validate → dedup → balance guard → D1 pending → DO journal → D1 posted)
   with an idempotent replay/heal loop in reconciliation.
   Spec: `docs/POSTING-PROTOCOL.md`.
2. **Disabled balance guard — RE-ENABLED.** Per-account balance validation
   runs BEFORE any write (`INSUFFICIENT_FUNDS`, `UNBALANCED`,
   `UNKNOWN_ACCOUNT`, `CURRENCY_MISMATCH` all enforced, test-pinned).
3. **Refund workflow bugs — FIXED.** Bounded poll loop (1m→30m backoff,
   ~24h window), honest retry policy (errored instances ARE the DLQ and
   PAGE), defined trigger paths (instance-per-refund + daily sweep re-drive,
   capped at 3 re-drives before paging for manual review).
4. **Access trust model — HARDENED.** `Cf-Access-Jwt-Assertion` is verified
   against the team JWKS (ES256 raw r||s and RS256, issuer/audience/expiry);
   fail-closed on missing config (503) and JWKS unavailability. The spoofable
   `Cf-Access-Authenticated-Email` header is telemetry only. Break-glass
   service token pages on every use. No env-var bypass exists.
5. **Rate limiting — per-API-key.** Native Ratelimit bindings (read/write
   tiers) keyed on the authenticated API key; graceful degradation when the
   binding is absent; per-IP KV limiter kept only for anonymous routes.
6. **Tests that matter — run against REAL infra.** vitest-pool-workers runs
   inside workerd with real D1, real Durable Objects, real Workflows config.

### Also fixed along the way (pre-existing, runtime-breaking)

- **53× `.prepare(sql, [params])` calls** — D1's `prepare()` takes only SQL;
  the params array was silently dropped, so every such query would have run
  with unbound placeholders and failed at runtime (auth, payments, webhooks,
  install, cron, SMS).
- **D1Result iteration bugs** (`for (const x of d1Result)`) — TypeError at
  runtime; now iterate `.results`.
- **`Queue.sendBatch()` envelope shape** and `message.retry()` options shape.
- **~236 → 0 TypeScript errors** (strict), including the Hono controller
  noise v0.2.0 shipped with.

## Platform discoveries the tests forced (the payoff of real-infra testing)

- **A throw out of `blockConcurrencyWhile` breaks the DO's input gate** —
  every subsequent RPC to that merchant's LedgerDO fails until eviction.
  `postTransaction` therefore NEVER throws; failures are structured results
  and `LedgerService` re-scaffolds exceptions worker-side. Without this, one
  unbalanced webhook payload would take a merchant's ledger down.
- **DO writes commit when the event completes** (even returning a `failed`
  result) — there is no rollback story, and the protocol doesn't need one:
  tx_id dedup + the reconciliation heal path converge every crash ordering.
  The v0.2.0 comments assumed rollback; corrected everywhere.
- **workerd's ECDSA uses raw r||s signatures** (JWS convention), not DER —
  the Access JWT verifier accepts both encodings.

## Test suites

### 1. `tests/ledger-do.test.ts` — posting protocol integration (14)
Real LedgerDO + real D1 inside workerd: happy path convergence (DO balances
= trial balance = D1 audit mirror), idempotent replay, every validation
guard, the full failure-injection matrix (D/E/F seams: nothing-changed,
pending-survives-replay, pending-survives-heal), poison-row quarantine, and
the DO-stays-healthy-after-rejections regression test.

### 2. `tests/ledger-consistency.test.ts` — concurrency + property (3)
- 20 concurrent distinct postings: all land, balances EXACT.
- 20 concurrent same-tx_id postings: exactly 1 posted, 19 duplicates.
- Randomized 30-posting stream (seeded PRNG) with faults injected at every
  seam → reconciliation converges → D1-aggregated == DO balances per account,
  trial balance holds, totals exact, zero pending rows.

### 3. `tests/access-jwt.test.ts` — Access JWT verification (10)
ES256 raw r||s + DER passthrough, RS256, tampered payload, wrong audience,
expired, wrong issuer, unknown kid, wrong key family, malformed tokens.

### 4. `tests/workflow-policy.test.ts` — refund poll policy (6)
Backoff schedule pinned (1m,2m,4m,8m,15m,30m cap), ~24h halt horizon,
sweep re-drive cap.

### 5. `tests/gateways.test.ts` (13) + `tests/smoke.test.ts` (4)
Pre-existing suites, still green.

## How to run

```bash
npm install
npx tsc --noEmit   # 0 errors
npx vitest run     # 50/50
```

## Known limitations

- Workflow *instance-level* behavior (step replay, sleeps) needs a deployed
  Workflows runtime; the poll/halt/sweep policy math — which is what decides
  refunds' fate — is pinned by `tests/workflow-policy.test.ts`.
- The Ratelimit binding is not emulated by miniflare; the middleware's
  degraded mode (allow + metric) is what tests exercise. Deployed wrangler
  config carries the real bindings.
- ~16 pre-existing Hono-typing error patterns in v0.1-era controllers were
  fixed to zero; future controllers should reuse the typed Variables pattern.
