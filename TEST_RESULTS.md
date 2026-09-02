# Test Results — EdgePay-CF v0.4.0 (Remediation & Quality Verification)

## Summary

```text
Test Files  29 passed (29)
Tests       248 passed (248) — 100% green across all unit, integration, security, and PoC suites
Typecheck   0 errors (tsc --noEmit, strict mode)
Lint        0 errors, 0 warnings (ESLint 9 flat config)
Audit Gate  node scripts/verify-remediations.mjs & node scripts/verify-config.mjs (PASS)
Runtime     Cloudflare Workers (workerd) via @cloudflare/vitest-plugin
```

## Quality & Security Invariants Covered

1. **Money-Path Invariants (100% Fixed & Tested)**:
   - Double-entry ledger postings (`tests/ledger-do.test.ts`, `tests/ledger-consistency.test.ts`)
   - Reserve-then-call refund atomicity with registry instrumentation (`tests/refund-ordering.test.ts`, `tests/payment-integrity.test.ts`, `tests/audit-poc-r4.test.ts`)
   - Decimal exact comparisons & boundary verification (`tests/money.test.ts`)
   - Mandatory gateway amount checks & callback bindings (`tests/catalog-port.test.ts`, `tests/gateways.test.ts`)
   - Idempotency key scoping across tenants (`tests/payment-integrity.test.ts`)

2. **Edge Security & Routing**:
   - 128 KB bounded payload cap with 411 Length Required on chunked streams (`tests/payload-cap.test.ts`, `tests/audit-poc-r4.test.ts`)
   - Outbound SSRF protection on test & live endpoints (`tests/ssrf-webhook-test.test.ts`, `tests/url-guard.test.ts`)
   - Tenant isolation & domain routing (`tests/tenant-routing.test.ts`)
   - Strict security headers & nonce CSP on all JSON/HTML surfaces (`tests/api-middleware.test.ts`, `tests/assets-serving.test.ts`, `tests/audit-poc-r4.test.ts`)
   - Static asset prefix rewriting returning 200 and CSS content-type (`tests/assets-serving.test.ts`, `tests/audit-poc-r4.test.ts`)

3. **Mobile Companion & Tenant Isolation**:
   - Device & tenant scoped notification acknowledgements (`tests/mobile-notifications.test.ts`)
   - Discriminating device scoped heartbeats with sentinel change verification and cross-tenant isolation (`tests/mobile-heartbeat.test.ts`, `tests/audit-poc-r4.test.ts`)
   - Platform administrator gate on one-time merchant claim tokens (`tests/audit-poc-r4.test.ts`)
   - JWT validation, algorithm pinning, and audience checking (`tests/access-jwt.test.ts`, `tests/jwt.test.ts`)

4. **Automated Verification Pipeline**:
   - `scripts/verify-remediations.mjs` verifies all 64 ledger claims with non-colliding IDs and relevance checks
   - `scripts/verify-config.mjs` performs direct recursive filesystem tree scanning to ensure no live credential state files ship
   - `.github/workflows/audit-gate.yml` enforces continuous compliance in CI
