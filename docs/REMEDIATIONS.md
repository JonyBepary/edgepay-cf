# EdgePay-CF Audit & Remediation Ledger

This document tracks all security findings, remediations, and verification test suites across the EdgePay-CF audit series.

## Status Summary
- **Verified Money-Path P0s**: 100% Fixed & Tested
- **Test Automation Battery**: 29 test suites, 252 tests, 0 skips, 100% green
- **Static Analysis & Typecheck**: ESLint 9 (0 warnings), TypeScript (0 errors), zero `as any` in `src/`
- **Hygiene & Verification Gate**: Direct filesystem tree scan + JSONC config parser + release archive builder & verifier (`npm run package`)

---

## Remediation Tracking Table

| Finding ID | Severity | Category | Status | File(s) Modified | Verification Test ID |
|---|---|---|---|---|---|
| **EDGE-P0-001** | P0 | Secret Hygiene | FIXED | `.dev.vars`, `wrangler secret put` | Production JWT_SECRET rotated with 256-bit CSPRNG entropy via wrangler; local .dev.vars rotated |
| **EDGE-P0-002** | P0 | Ledger Reversal | FIXED | `src/services/ledger.ts`, `src/services/refund.ts` | `tests/ledger-consistency.test.ts` |
| **EDGE-P0-003** | P0 | Unbounded Refunds | FIXED | `src/services/refund.ts` | `tests/payment-integrity.test.ts`, `tests/refund-ordering.test.ts` |
| **EDGE-P0-004** | P0 | Callback Amount Binding | FIXED | `src/services/payment.ts` | `tests/catalog-port.test.ts`, `tests/gateways.test.ts` |
| **EDGE-P0-005** | P0 | Bootstrap & Install Chain | PARTIAL | `src/services/bootstrap.ts`, `src/controllers/install.ts` | `tests/tenant-routing.test.ts` |
| **EDGE-P0-006** | P0 | Stored XSS & CSP | FIXED | `src/controllers/checkout.ts`, `src/middleware/security-headers.ts` | `tests/smoke.test.ts`, `tests/api-middleware.test.ts` |
| **EDGE-P0-007** | P0 | SMS Corroboration NULL Amount | FIXED | `src/services/sms-corroboration.ts` | `tests/sms-corroboration-edgecases.test.ts` |
| **EDGE-P1-001** | P1 | Idempotency Concurrency | FIXED | `src/middleware/idempotency.ts` | `tests/payment-integrity.test.ts` |
| **EDGE-P1-002** | P1 | OTP Rate Limiting | FIXED | `src/index.ts`, `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` |
| **EDGE-P1-003** | P1 | Payload Size Cap | FIXED | `src/index.ts` | `tests/payload-cap.test.ts` |
| **EDGE-P1-004** | P1 | Outbound SSRF Protection | FIXED | `src/lib/url-guard.ts`, `src/services/webhook-dispatcher.ts` | `tests/url-guard.test.ts`, `tests/ssrf-webhook-test.test.ts` |
| **EDGE-P1-005** | P1 | Tenant Enumeration | FIXED | `src/controllers/admin-api.ts` | `tests/tenant-routing.test.ts` |
| **EDGE-P1-006** | P1 | State Machine Regression | PARTIAL | `src/services/payment.ts` | `tests/payment-edgecases.test.ts` |
| **EDGE-P1-007** | P1 | Intent Creation Race | OPEN | `src/services/payment.ts` | (30-day roadmap: UNIQUE constraint) |
| **EDGE-P1-008** | P1 | Write Scope Enforcement | FIXED | `src/controllers/api.ts` | `tests/api-middleware.test.ts` |
| **EDGE-P1-009** | P1 | Test Suite Integrity | FIXED | `tests/` | 29 test suites green (252 tests) |
| **EDGE-P1-010** | P1 | KV Rate Limiter Grouping | PARTIAL | `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` |
| **EDGE-P2-001** | P2 | CSRF Middleware Mounting | OPEN | `src/middleware/csrf.ts` | (30-day roadmap) |
| **EDGE-P2-005** | P2 | Rate Limiter Fail-Open | PARTIAL | `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` |
| **EDGE-P2-006** | P2 | Analytics Engine Telemetry | FIXED | `wrangler.jsonc`, `src/lib/observability.ts` | `tests/smoke.test.ts` |
| **EDGE-P2-007** | P2 | Webhook Outbox Pattern | OPEN | `src/services/webhook-dispatcher.ts` | (90-day roadmap: outbox table) |
| **EDGE-P2-015** | P2 | ReDoS Pattern Screen | OPEN | `src/controllers/admin-api.ts` | (30-day roadmap: regex allowlist) |
| **EDGE-P2-016** | P2 | Gateway Enablement Default | OPEN | `src/gateways/enabled.ts` | (30-day roadmap: fail-closed default) |
| **EDGE-P2-017** | P2 | PBKDF2 Iteration Count | OPEN | `src/lib/crypto.ts` | (30-day roadmap: 600K iterations) |
| **EDGE-P2-018** | P2 | Money Bounds Schema | FIXED | `src/lib/money.ts` | `tests/money.test.ts` |
| **EDGE-P3-002** | P3 | Mobile Heartbeat Scoping | FIXED | `src/controllers/mobile.ts` | `tests/mobile-heartbeat.test.ts` |
| **EDGE-P3-003** | P3 | Mobile Notification Tenant Scoping | FIXED | `src/controllers/mobile.ts`, `src/middleware/auth.ts` | `tests/mobile-notifications.test.ts` |
| **NEW-P2-001** | P2 | Refund Cumulative Bound Race | FIXED | `src/services/refund.ts` | `tests/payment-integrity.test.ts`, `tests/refund-ordering.test.ts` |
| **NEW-P2-002** | P2 | Decimal Amount Comparison | FIXED | `src/lib/money.ts`, `src/services/payment.ts` | `tests/money.test.ts` |
| **NEW-P2-003** | P2 | Gateway Amount Verification | FIXED | `src/gateways/` | `tests/catalog-port.test.ts` |
| **NEW-P2-004** | P2 | Admin Provisioning Claim Token | FIXED | `src/controllers/admin-api.ts` | `tests/audit-poc-r4.test.ts` |
| **NEW-P2-005** | P2 | Checkout Rate Limits | FIXED | `src/index.ts`, `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` |
| **NEW-P3-001** | P3 | SMS Dead Operand | FIXED | `src/services/sms-corroboration.ts` | `tests/sms-parser-adversarial.test.ts` |
| **NEW-P3-002** | P3 | ESLint Pipeline | FIXED | `eslint.config.js` | 0 errors, 0 warnings |
| **V3-001** | P3 | False Claim Remediation | FIXED | `src/controllers/mobile.ts`, `src/middleware/auth.ts` | `tests/mobile-notifications.test.ts` |
| **V3-002** | P2 | sendTest SSRF Enforcement | FIXED | `src/services/webhook-dispatcher.ts`, `src/controllers/api.ts` | `tests/ssrf-webhook-test.test.ts` |
| **V3-003** | P1 | Refund Ghost-Call Ordering | FIXED | `src/services/refund.ts` | `tests/refund-ordering.test.ts` |
| **V3-004** | P2 | Claim Token Plaintext KV Staging | OPEN | `src/controllers/admin-api.ts` | (30-day roadmap: encrypt-at-rest) |
| **V3-005** | P2 | Bounded Payload Cap | FIXED | `src/index.ts` | `tests/payload-cap.test.ts` |
| **V3-006** | P2 | CF-Connecting-IP & Route Keying | FIXED | `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` |
| **V3-007** | P2 | SSRF Opt-In Flag | FIXED | `src/types/env.ts`, `src/controllers/api.ts`, `src/queues/webhook-consumer.ts` | `tests/ssrf-webhook-test.test.ts` |
| **V3-008** | P2 | Auto-Bootstrap First-Request Lockout | OPEN | `src/services/bootstrap.ts` | (30-day roadmap) |
| **V3-009** | P2 | Strict Typed Middleware | FIXED | `src/controllers/admin-api.ts`, `src/controllers/api.ts`, `src/middleware/auth.ts` | `src/` (tsc --noEmit) |
| **V3-010** | P2 | Claim Route Platform Admin Scope | FIXED | `src/controllers/admin-api.ts` | `tests/audit-poc-r4.test.ts` |
| **V3-011** | P3 | Machine-Readable Tracking Ledger | FIXED | `docs/REMEDIATIONS.md`, `scripts/verify-remediations.mjs` | `node scripts/verify-remediations.mjs` |
| **V4-001** | P3 | Verifiable Test Citations | FIXED | `docs/REMEDIATIONS.md`, `tests/` | `tests/refund-ordering.test.ts`, `tests/ssrf-webhook-test.test.ts` |
| **V4-002** | P2 | Telemetry & Observability Fallback | FIXED | `wrangler.jsonc`, `src/lib/observability.ts` | `tests/smoke.test.ts` |
| **V4-003** | P3 | Finding ID Collision Resolution | FIXED | `docs/REMEDIATIONS.md` | Non-colliding registry mapped |
| **V4-004** | P2 | State File Cleanse & Secret Rotation | FIXED | `.gitignore`, `sms-phone-mockup/` | Local file purged; production JWT_SECRET rotated |
| **V4-005** | P2 | 411 Length Required for Chunked Bodies | FIXED | `src/index.ts` | `tests/payload-cap.test.ts` |
| **V4-007** | P4 | Asset URL Path Prefix Stripping | FIXED | `src/index.ts` | `tests/assets-serving.test.ts` |
| **V4-010** | P4 | Payload Cap Covering DELETE | FIXED | `src/index.ts` | `tests/payload-cap.test.ts` |
| **V4-011** | P3 | Automated Audit Gate in CI | FIXED | `.github/workflows/audit-gate.yml` | `scripts/verify-remediations.mjs` |
| **V5-001** | P1 | Artifact Credential Purge | FIXED | `sms-phone-mockup/.companion-state.json.example` | File replaced with template; production JWT_SECRET rotated |
| **V5-002** | P2 | Production Telemetry Binding | PARTIAL | `wrangler.jsonc`, `src/lib/observability.ts` | Active in dev/staging; dashboard enablement guidance in prod |
| **V5-003** | P2 | Direct Filesystem Tree Scan Gate | FIXED | `scripts/verify-config.mjs` | Direct scan across git and archive |
| **V5-004** | P3 | Parser Header Heuristic Fix | FIXED | `scripts/verify-remediations.mjs` | Regex exact-table-header matcher |
| **V5-005** | P3 | Direct Claim Gate Coverage | FIXED | `tests/audit-poc-r4.test.ts` | Platform admin claim gate covered |
| **V5-006** | P3 | Discriminating Heartbeat Test | FIXED | `tests/mobile-heartbeat.test.ts` | Sentinel change & cross-tenant negative |
| **V5-007** | P3 | Gateway Registry Seam Instrumentation | FIXED | `tests/refund-ordering.test.ts` | `gatewayRegistry.resolve` spied |
| **V5-008** | P4 | Unhedged Asset Assertion | FIXED | `tests/assets-serving.test.ts` | Strict 200 + text/css assertions |
| **V5-009** | P4 | Synchronized Documentation Metrics | FIXED | `TEST_RESULTS.md`, `docs/REMEDIATIONS.md` | Counts exact across artifacts (252 tests) |
| **V5-010** | P4 | Test Environment Isolation | FIXED | `vitest.config.ts`, `.dev.vars.example` | Verified in test harness |
| **V5-011** | P4 | Bodyless DELETE 411 Contract | FIXED | `src/index.ts` | Documented for API consumers |
| **V6-001** | P1 | Packaging Gate & Release Script | FIXED | `scripts/package-release.mjs`, `package.json` | Automated pre-packaging gate |
| **V6-002** | P3 | Dev Secret Rotation | FIXED | `.dev.vars` | Rotated with fresh 256-bit CSPRNG keys |
| **V6-003** | P3 | Package Tree Hygiene Gate | FIXED | `scripts/package-release.mjs`, `scripts/verify-config.mjs` | Release packaging verifies clean tree |
| **V6-004** | P4 | Documentation Metrics Sync | FIXED | `docs/REMEDIATIONS.md`, `TEST_RESULTS.md` | 252 tests synchronized |
| **V6-005** | P4 | PoC Count Normalization | FIXED | `tests/audit-poc-r4.test.ts` | 14 test cases covering 15 scenarios |
| **V6-006** | P3 | Citation Relevance Verification | FIXED | `scripts/verify-remediations.mjs`, `tests/smoke.test.ts` | All citations strictly verified |
| **R-3** | P4 | Simulator Localhost Default | FIXED | `sms-phone-mockup/public/index.html` | Default target set to localhost:8787 |
| **R-4** | P4 | State File Single Match | FIXED | `scripts/verify-config.mjs` | Single boolean matcher eliminates duplicate error |
| **V7-001** | P1 | Release Archive & Clean Tree Builder | FIXED | `scripts/package-release.mjs` | Builds dist/edgepay-cf-release.zip strictly excluding .dev.vars |
| **V7-002** | P2 | JSONC Config Parser | FIXED | `scripts/verify-config.mjs` | Strips comments to verify active bindings |
| **V7-003** | P3 | Discriminating Telemetry Test | FIXED | `tests/smoke.test.ts` | Explicit writeDataPoint argument assertions |
| **V7-004** | P3 | Ledger Metrics & Provenance Sync | FIXED | `docs/REMEDIATIONS.md`, `TEST_RESULTS.md` | Synchronized 252 tests across all documentation |
| **V7-005** | P4 | Forwarding Relay URL Validation | FIXED | `sms-phone-mockup/server.js` | Protocol validation (http/https only) |
