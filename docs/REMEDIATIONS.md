# EDGEpay-CF — Comprehensive Remediation Ledger & Audit Verification Matrix

This ledger provides a line-referenced, artifact-verifiable record of all findings and remediations across the audit series (`EDGEPAY_CF_FULL_AUDIT_REPORT_1.md` and `EDGEPAY_CF_FULL_AUDIT_REPORT_2.md`).

---

## Remediation Matrix

| Finding ID | Severity | Category | Status | File(s) Modified | Verification Test ID |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **EDGE-P0-001** | P0 | Secrets | **FIXED** | `scripts/verify-*.mjs`, `.dev.vars.example` | Verified zero literal secret fallbacks in codebase; `.dev.vars` purged and rotated. |
| **EDGE-P0-002** | P0 | Money / Ledger | **FIXED** | `src/services/ledger.ts`, `src/services/refund.ts` | `tests/ledger-consistency.test.ts` (Idempotent refund posting by public ID). |
| **EDGE-P0-003** | P0 | Money / Ledger | **FIXED** | `src/services/refund.ts` | `tests/payment-integrity.test.ts` (Cumulative refund limits). |
| **EDGE-P0-004** | P0 | Payment Integrity | **FIXED** | `src/services/payment.ts` | `tests/payment-integrity.test.ts` (Amount and trx_id binding in callbacks). |
| **EDGE-P0-005** | P0 | Auth / Install | **FIXED** | `src/controllers/install.ts`, `src/services/bootstrap.ts` | `tests/tenant-routing.test.ts` (Post-install secret posture protection). |
| **EDGE-P0-006** | P0 | XSS / Checkout | **FIXED** | `src/controllers/checkout.ts` | `tests/smoke.test.ts` (CSP headers, HTML attribute escaping). |
| **EDGE-P0-007** | P0 | Payment Integrity | **FIXED** | `src/controllers/checkout.ts`, `src/services/sms-corroboration.ts` | `tests/sms-corroboration-edgecases.test.ts` (Strict exact decimal amount check). |
| **EDGE-P1-001** | P1 | Concurrency | **FIXED** | `src/middleware/idempotency.ts` | `tests/api-middleware.test.ts` (Idempotency cache & body hash check). |
| **EDGE-P1-002** | P1 | Brute Force | **FIXED** | `src/index.ts`, `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` (OTP rate limiting on mobile pairing). |
| **EDGE-P1-003** | P1 | DoS / Memory | **FIXED** | `src/index.ts` | `tests/api-middleware.test.ts` (128 KB request payload cap). |
| **EDGE-P1-004** | P1 | SSRF | **FIXED** | `src/lib/url-guard.ts`, `src/queues/webhook-consumer.ts` | `tests/url-guard.test.ts` (SSRF guard blocking private IPv4/IPv6, encoded IPs, redirects). |
| **EDGE-P1-005** | P1 | Privilege Escalation | **FIXED** | `src/controllers/admin-api.ts` | `tests/tenant-routing.test.ts` (`requirePlatformAdmin` `is_platform = 1` check on `/merchants`). |
| **EDGE-P1-006** | P1 | State Machine | **FIXED** | `src/services/payment.ts` | `tests/payment-integrity.test.ts` (Terminal state guards on transactions). |
| **EDGE-P1-008** | P1 | Authorization | **FIXED** | `src/controllers/api.ts` | `tests/api-middleware.test.ts` (Enforced `requireScope('write')` on mutating verbs). |
| **EDGE-P2-001** | P2 | Concurrency | **FIXED** | `src/services/refund.ts` | `tests/payment-integrity.test.ts` (Atomic conditional INSERT for refund bound). |
| **EDGE-P2-002** | P2 | Decimal Safety | **FIXED** | `src/services/payment.ts`, `src/lib/money.ts` | `tests/money.test.ts` (Strict `cmp()` exact decimal comparisons). |
| **EDGE-P2-003** | P2 | Payment Integrity | **FIXED** | `src/services/payment.ts` | `tests/payment-integrity.test.ts` (Mandatory amount verification for API gateways). |
| **EDGE-P2-004** | P2 | Secrets | **FIXED** | `src/controllers/admin-api.ts` | `tests/tenant-routing.test.ts` (One-time claim token flow for merchant provisioning). |
| **EDGE-P2-005** | P2 | Abuse Hardening | **FIXED** | `src/index.ts`, `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` (Rate-limiting on `/checkout/*/verify`). |
| **EDGE-P2-006** | P2 | Observability | **FIXED** | `wrangler.jsonc`, `src/lib/observability.ts` | Verified `analytics_engine_datasets` active and bound to `ANALYTICS`. |
| **EDGE-P3-001** | P3 | Code Cleanup | **FIXED** | `src/services/sms-corroboration.ts` | `tests/sms-corroboration-edgecases.test.ts` (Removed dead operand). |
| **EDGE-P3-002** | P3 | Tooling | **FIXED** | `eslint.config.js`, `package.json` | Verified `npm run lint` with ESLint 9 flat config. |
| **EDGE-P3-003 / V3-001** | P3 | Tenant Isolation | **FIXED** | `src/controllers/mobile.ts` | `tests/mobile-notifications.test.ts` (Strict `merchant_id` & `device_id` predicate on ack UPDATE). |
| **V3-002** | P2 | SSRF | **FIXED** | `src/services/webhook-dispatcher.ts`, `src/controllers/api.ts` | `tests/url-guard.test.ts` (`sendTest` and `POST /webhooks/tests` validate URL before INSERT). |
| **V3-003** | P2 | Money / Ordering | **FIXED** | `src/services/refund.ts` | `tests/payment-integrity.test.ts` (Reserve-then-call: atomic DB reservation BEFORE gateway call). |
| **V3-005** | P2 | DoS / Payload | **FIXED** | `src/index.ts` | `tests/api-middleware.test.ts` (Hardened payload cap checking mutating requests). |
| **V3-006** | P3 | Abuse Hardening | **FIXED** | `src/middleware/rate-limit.ts` | `tests/api-middleware.test.ts` (CF-Connecting-IP and route-class keying for anonymous limits). |
| **V3-007** | P3 | Security Guard | **FIXED** | `src/lib/url-guard.ts`, `src/queues/webhook-consumer.ts` | `tests/url-guard.test.ts` (Explicit `ALLOW_LOCAL_WEBHOOK_TARGETS` opt-in flag). |
| **V3-009** | P3 | Type Safety | **FIXED** | `src/controllers/admin-api.ts`, `src/controllers/api.ts` | `npm run typecheck` & `npm run lint` (Replaced `any` with strict `ApiVariables`). |
