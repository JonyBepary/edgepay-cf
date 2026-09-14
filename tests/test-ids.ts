/**
 * Test Suite Merchant ID & Tenant Range Allocations.
 *
 * In Cloudflare Workers Vitest testing (vitest.config.ts), all test files share
 * a single workerd process and its storage (maxWorkers: 1, isolate: false).
 * To guarantee tenant and Durable Object isolation across test suites,
 * each test file MUST use its allocated merchant ID range.
 *
 * DO NOT reuse or cross-allocate IDs between test suites.
 */

export const TEST_MERCHANT_RANGES = {
  LEDGER_DO: { start: 910001, end: 910099, file: 'tests/ledger-do.test.ts' },
  PAYMENT_INTEGRITY: { start: 920001, end: 929999, file: 'tests/payment-integrity.test.ts' },
  OUTBOX_DRAIN: { start: 930001, end: 939999, file: 'tests/outbox-drain.test.ts' },
  REFUND_ORDERING: { start: 940001, end: 949999, file: 'tests/refund-ordering.test.ts' },
  SSRF_WEBHOOK: { start: 950001, end: 959999, file: 'tests/ssrf-webhook-test.test.ts' },
  MOBILE_HEARTBEAT: { start: 960001, end: 969999, file: 'tests/mobile-heartbeat.test.ts' },
  AUDIT_POC_R4_PLATFORM: { start: 970001, end: 979999, file: 'tests/audit-poc-r4.test.ts' },
  AUDIT_POC_R4_REFUND: { start: 980001, end: 989999, file: 'tests/audit-poc-r4.test.ts' },
  AUDIT_POC_R4_TENANTS: { start: 990001, end: 999999, file: 'tests/audit-poc-r4.test.ts' },
  SMS_HARDENING: { start: 850001, end: 859999, file: 'tests/sms-hardening.test.ts' },
  KEY_ATTESTATION: { start: 860001, end: 869999, file: 'tests/key-attestation.test.ts' },
  ATTESTATION_CHALLENGE_RACE: { start: 870001, end: 879999, file: 'tests/attestation-challenge-race.test.ts' },
  DEVICE_POLICY: { start: 880001, end: 889999, file: 'tests/device-policy.test.ts' },
  DEVICE_POLICY_MODES: { start: 890001, end: 899999, file: 'tests/device-policy-modes.test.ts' },
  DEVICE_POLICY_OVERRIDES: { start: 900001, end: 909999, file: 'tests/device-policy-overrides.test.ts' },
  HIERARCHY: { start: 910100, end: 919999, file: 'tests/hierarchy.test.ts' },
} as const;
