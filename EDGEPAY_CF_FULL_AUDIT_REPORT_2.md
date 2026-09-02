# EDGEpay v0.3.0 (remediation release) — Remediation Verification, Full Re-Audit, Multi-Worker Frontend Architecture & API-Surface Reduction Report

```text
Report ID:        EDGEPAY_CF_FULL_AUDIT_REPORT_2
Series:           4th audit in the EDGEpay-CF audit series
                  (1: EDGEPAY_AUDIT_REPORT.md — baseline audit)
                  (2: EDGEPAY_CF_FULL_AUDIT_REPORT.md — first full audit, v0.3.0 pre-remediation)
                  (3: EDGEPAY_CF_FULL_AUDIT_REPORT_1.md — re-audit + remediation verification, 49+12 findings)
                  (4: THIS REPORT — verification of the claimed full remediation release)
Artifact audited: edgepay-cf-clean-new-1.zip  (870,122 bytes, extracted 225 files)
Baseline pairs:   edgepay-cf-clean.zip        (v1 — the original audited codebase)
                  edgepay-cf-clean-new.zip    (v2 — the first remediation attempt, audited by report 3)
Auditor role:     Principal Software Architect, Payments Security Engineer,
                  Distributed Systems Engineer, Database Auditor,
                  Cloudflare Workers Specialist
Method:           Line-level code verification of every remediation claim,
                  independent re-execution of the full verification battery,
                  fresh adversarial audit of the remediated code, three-way
                  version diff (v1 → v2 → v3), architecture reconstruction,
                  and a complete re-statement of the multi-worker /
                  service-binding / Worker-RPC recommendation against the
                  verified v0.3.0 state.
Date:             2026-09-01
```

---

## Table of Contents

- **Part I — Executive Summary**
  - 1. What this audit is
  - 2. Headline results
  - 3. The one claim that is false (P3-003)
  - 4. The one claim that is materially incomplete (EDGE-P0-001)
  - 5. Build & deployment claim verification (independently re-executed)
  - 6. Overall production readiness verdict
  - 7. Risk top-5 after this remediation release
- **Part II — Audit Method, Environment & Evidence Standard**
  - 8. Method and evidence rules
  - 9. Environment and artifacts
  - 10. The three-version diff (what actually changed in v3)
  - 11. Independently re-executed verification battery
- **Part III — Remediation Claim Verification (the 15 claim rows / 22 finding IDs)**
  - 12. Claim-by-claim verification with code evidence
  - 13. Claim verification matrix (summary)
- **Part IV — Regression Verification of the Money-Core P0 Fixes**
  - 14. The five previously-fixed money P0s under the new code
  - 15. Refund pipeline regression walkthrough
  - 16. Callback and corroboration regression walkthrough
- **Part V — Consolidated Finding Ledger (all 61 findings, v3 status)**
  - 17. P0 ledger (7 findings)
  - 18. P1 ledger (10 findings)
  - 19. P2 ledger (20 findings)
  - 20. P3 ledger (12 findings)
  - 21. NEW ledger (12 findings)
  - 22. Movement analysis (v2 → v3)
- **Part VI — Fresh Audit of the Remediated Code (new findings)**
  - 23. V3-001 … V3-011: defects and gaps introduced or exposed by this release
  - 24. The remediation-integrity finding (false "FIXED" claim)
- **Part VII — Current Architecture (verified, as-built)**
  - 25. Single-worker reality and complete binding inventory
  - 26. Trust boundaries as implemented
  - 27. Route inventory (52 routes across 7 controllers)
  - 28. Data-plane topology (D1, KV, R2, DO, Queues, Workflows, Ratelimit)
- **Part VIII — The Multi-Worker Frontend System (updated implementation blueprint)**
  - 29. Design goals (re-validated against v3's verified defects)
  - 30. Target topology (four workers + core)
  - 31. The RPC contract
  - 32. wrangler decomposition (all four configs, complete)
  - 33. File-level migration map (updated for v3's file set)
  - 34. Authentication design for the split
  - 35. Carrying the v3 residuals into the split (fixes that ride along)
  - 36. Phased migration plan (zero-downtime, reversible)
  - 37. Failure modes and mitigations
- **Part IX — API-Surface Reduction to a Customer-Facing REST System**
  - 38. Current surface (52 routes on one origin) — verified inventory
  - 39. The reduced customer-facing REST contract (complete specification)
  - 40. What moves to RPC, what moves to internal routes, what is deleted
  - 41. Versioning, deprecation and migration policy
- **Part X — Cloudflare Service Bindings & Worker RPC (detailed evaluation)**
  - 42. Mechanism primer (2026 state, verified against this repo's compat date)
  - 43. Six-option comparison (expanded with v3 evidence)
  - 44. Worker RPC detailed design decisions (nine decisions, updated)
  - 45. Where the split pays off against THIS release's verified residuals
  - 46. The honest counter-case
  - 47. Final recommendation
- **Part XI — Comprehensive Comparison**
  - 48. v1 → v2 → v3 remediation trajectory (everything compared)
  - 49. Monolith vs four-worker split (all dimensions)
  - 50. Integration mechanism comparison (RPC vs fetch-binding vs HTTP vs DO RPC)
  - 51. Cost & latency models
- **Part XII — Deliverables, Roadmap & Verdict**
  - 52. Required remediation sequence (what remains, in order)
  - 53. Final architecture scorecard
  - 54. The 17 executive questions, answered against v3
  - 55. Final production verdict
- **Annexes**
  - A. Full remediation-summary claim text vs code reality (side-by-side)
  - B. Verification battery raw output
  - C. Changed-file inventory with line-level deltas
  - D. Finding-card format and severity methodology
  - E. Auditor's uncertainty statement

---
---

# PART I — EXECUTIVE SUMMARY

## 1. What this audit is

This report is the verification pass for the **remediation release** of EdgePay-CF (`edgepay-cf-clean-new-1.zip`, deployed as Worker Version `92343535-3ac0-40e0-a52c-c5290ec675e3`). The developer supplied an *Audit Remediation Summary* claiming that "All perimeter, SSRF, authorization, race condition, and rate-limiting findings documented in EDGEPAY_CF_FULL_AUDIT_REPORT_1.md have been systematically resolved, verified with unit/integration tests, committed, and deployed live to Cloudflare Edge."

The commissioning questions for this pass were four:

1. **Is the remediation summary true?** For each of the 15 claim rows (covering 22 finding IDs from the 61-finding ledger of report 3), does the shipped code actually contain the described fix, and does the fix hold under adversarial reading?
2. **Did the fixes regress the money core?** The five payment-integrity P0s that were fixed in v2 must still be fixed in v3.
3. **What is still broken?** Report 3 closed with 30 findings NOT FIXED and 14 PARTIALLY FIXED; the remediation summary addresses only 22 of the 61 finding IDs. What is the true state of the other 39?
4. **Architecture**: how should the multi-worker frontend system be implemented, how should the API surface be reduced to a customer-facing REST system, is Cloudflare Service Bindings the right mechanism, and where should Worker RPC be used — all re-analyzed against the *verified* v0.3.0 codebase rather than the documented one.

The answer to (1) is: **13 of 15 claim rows are genuine and verifiable fixes, 1 is materially incomplete (EDGE-P0-001 — the secrets were never rotated and `.dev.vars` still ships the same compromised key material), and 1 is false (EDGE-P3-003 — the claimed `merchant_id` predicate on the mobile notification acknowledgement UPDATE does not exist anywhere in the shipped code).**

The answer to (2) is clean: **all five money-core P0 fixes hold; the 218-test suite, the strict typecheck, and the lint pass were independently re-executed by this auditor and all pass exactly as claimed.**

The answer to (3) is: the ledger moved from **5 FIXED / 14 PARTIAL / 30 NOT FIXED (report 3)** to **22 FIXED / 9 PARTIAL / 30 NOT FIXED** out of 61 findings — real, material progress on the security perimeter, obtained at near-zero regression cost, but with roughly half the ledger still open, one false claim, and a set of fresh defects this release introduced or exposed (Part VI).

The answer to (4) occupies Parts VII–XI and is unchanged in direction from report 3 but now *stronger in evidence*: **proceed to the four-worker split via Cloudflare Service Bindings with Worker RPC as the inter-worker contract, with the §52 hotfix list executed first — the split is now justified by verified v3 defects (the false P3-003 claim, the unvalidated `sendTest` URL persistence, the silent Analytics Engine no-op, the header-only payload cap) that are all *class* defects of a middleware-only privilege model that a network-and-capability boundary eliminates structurally.**

## 2. Headline results

### 2.1 Remediation-claim verification (the 15 rows in the supplied summary)

| Verdict on the claim | Count | Share |
|---|---|---|
| **VERIFIED — fix is real and holds** | 13 | 86.7% |
| **MATERIALLY INCOMPLETE — partially true** | 1 | 6.7% |
| **FALSE — claimed fix absent from shipped code** | 1 | 6.7% |

The one false claim is **EDGE-P3-003** (cross-tenant mobile notification acknowledgement): the summary states "Added AND merchant_id = ? predicate to UPDATE op_mobile_notifications in mobile.ts." The shipped `src/controllers/mobile.ts:259` reads:

```sql
UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (...)
```

A repository-wide search for `op_mobile_notifications` returns exactly two hits — the SELECT (line 240, which *is* tenant-scoped) and this UPDATE (which is **not**). There is no `merchant_id` predicate, no `device_id` predicate, and no other write site. Any authenticated mobile JWT from merchant A can mark merchant B's notification rows as read by enumerating integer ids. The defect is low-severity (a read-state write, not money), but the *claim* is false, and false claims in a remediation summary are themselves an audit finding (see §24 and V3-001).

The materially incomplete claim is **EDGE-P0-001** (live credentials committed). The three `verify-*.mjs` scripts are genuinely cleaned — they now read `process.env` and fail fast — and the literal live API key (`op_live_9e9b2a89…`) appears nowhere in executable code. But `.dev.vars` ships in the zip with **the same `JWT_SECRET` value (`f14d30e9a38c…`) that report 3 flagged as compromised**, alongside `APP_KEY` and `ENCRYPTION_KEY`. Nothing was rotated; the AES-256-GCM key that encrypts every stored gateway credential is the very key the repository has been leaking since v1; no secret-scanning CI exists. The claim "Stripped all fallback API keys and JWT secrets" is true of the scripts and untrue of the artifact.

### 2.2 Build and deployment claims (independently re-executed)

| Claim in the summary | Re-executed result | Verdict |
|---|---|---|
| `npm run lint` → 0 errors | `eslint src tests` → **0 errors, 42 warnings** (`no-explicit-any` 42×) | **TRUE** (warnings undisclosed) |
| `npm run typecheck` → 0 TypeScript errors | `tsc --noEmit` → **exit 0, zero diagnostics** | **TRUE** |
| `npm test` → 22/22 files, 218/218 tests | `vitest run` → **22 files passed, 218 tests passed, 6.67s** | **TRUE — exact match** |
| New SSRF suite `url-guard.test.ts` exists | Present, passing | **TRUE** |
| Git pushed to main and master (`303f156`) | Not verifiable from the zip (no `.git` directory shipped) | **UNVERIFIED** |
| Deployed live (Worker Version `92343535-…`, `edgepay-cf.bm-jonybepary.workers.dev`) | `wrangler.jsonc` targets that hostname (`APP_URL`/`APP_DOMAIN` match); deployment itself not probeable from the sandbox | **CONSISTENT, NOT INDEPENDENTLY VERIFIED** |

The verification battery is the strongest part of this release: for the first time in the series, **every measurable claim in a remediation summary reproduced exactly** in a clean environment (fresh `npm ci`, 209 packages, workerd-based vitest pool). This auditor ran the battery from scratch; the numbers are not aspirational.

### 2.3 The 61-finding ledger after this release

| Status | Report 3 (v2) | This report (v3) | Δ |
|---|---|---|---|
| **FIXED** | 5 (10.2% of 49) | **22** (36.1% of 61) | +17 |
| **PARTIALLY FIXED** | 14 | **9** | −5 |
| **NOT FIXED** | 30 | **30** | 0 |
| **FALSE "FIXED" CLAIM** | 0 | **1** (EDGE-P3-003) | +1 |
| **NEW findings (this release)** | +12 | **+11** (V3-001…V3-011) | — |

Interpretation: the release concentrated exactly where the summary said it would — perimeter, authorization, SSRF, race conditions, rate limiting — and converted 17 findings from open to fixed with zero regression in the money core. But the 30 findings that were open and *not* mentioned in the summary are **all still open**, because the v2→v3 diff touches only 13 files plus 3 new ones, none of which are the files where those 30 fixes would live. The remediation was surgical, which is both its virtue (no regressions) and its limitation (half the ledger untouched).

### 2.4 What remains broken — the headline open items

Ranked by financial/business impact, after this release:

1. **The compromised key set is still unrotated and still shipping** (EDGE-P0-001 residual). `.dev.vars` carries the same `JWT_SECRET`/`APP_KEY`/`ENCRYPTION_KEY` as v1. Anyone who ever possessed this repository can forge mobile JWTs and decrypt every gateway credential in D1. Rotation is hours of work and remains the single highest-leverage action available. Everything else in this report is secondary to this.
2. **One remediation claim is false and the process that produced it is unaudited** (V3-001/EDGE-P3-003). A false "FIXED" in a summary that otherwise checks out is more dangerous than an honest "NOT FIXED" — it corrupts the remediation-tracking signal the operator is relying on to decide production readiness.
3. **The observability layer is still a silent no-op** (EDGE-P2-006). `wrangler.jsonc` still has `analytics_engine_datasets` commented out; every `metric()` call in the codebase — including `rate_limit_degraded`, `webhook_signature_rejected`, `sms_parse_miss`, `ledger_posting_healed` — discards its data. The rate-limit *degradation* alarm that the v3 rate-limiting fix depends on to detect a misconfigured binding **cannot fire**.
4. **The payload cap is header-only** (V3-005/P1-003 residual). The 128 KB middleware checks `Content-Length` and passes chunked/absent-length requests straight through to `c.req.json()`. Cloudflare's edge normalizes most client traffic, so practical exposure is low, but the guard is not the guard it appears to be.
5. **The claim-token flow persists credentials in plaintext KV** and the `sendTest` path persists unvalidated URLs into `op_webhooks` (V3-002, V3-004) — both are within-tolerance design trade-offs *if* they are known; neither was disclosed.

### 2.5 One-paragraph summary

**This is a genuine, well-scoped, well-tested remediation release — and it is not the all-clear its summary claims.** Thirteen of fifteen claim rows check out at line level; the verification battery reproduces exactly (22/22 files, 218/218 tests, typecheck and lint clean); the money core held; the perimeter class (SSRF guard, scope enforcement, platform-admin gate, rate-limit mounts, atomic refund bound) moved from "aspirational comments" to real code in exactly the files the summary named. But the release also ships the same compromised secrets it was supposed to purge, one claim (P3-003) is verifiably false, the Analytics Engine is still commented out so the new rate-limiting's own degradation alarm is structurally mute, and 30 prior findings plus 11 fresh ones remain open. The verdict moves from **NOT PRODUCTION READY (perimeter)** to **NOT PRODUCTION READY — one rotation away from CONDITIONALLY PRODUCTION READY**: rotate and purge the key set, fix or retract the P3-003 claim, enable Analytics Engine, and close the five P1/P2 residuals in §52, and the system earns controlled production traffic *without* the split. The four-worker split via Service Bindings + Worker RPC (Parts VIII–X) remains the correct next architecture step — now with three verified class-defects (false claim, unvalidated persistence, silent telemetry) as concrete evidence for why network-and-capability boundaries beat middleware-only boundaries.

## 3. The one claim that is false (EDGE-P3-003) — detailed

The supplied remediation summary row reads:

> **P3-003** | Cross-tenant notification acknowledgements | Added AND merchant_id = ? predicate to UPDATE op_mobile_notifications in mobile.ts. | FIXED

The shipped code (`src/controllers/mobile.ts`, the only UPDATE on that table in the repository):

```ts
mobileRoutes.post('/notifications/acknowledgements', async (c) => {
  const body = await c.req.json<{ notification_ids?: number[] }>();
  if (!body.notification_ids?.length) { ... 400 ... }

  const placeholders = body.notification_ids.map(() => '?').join(',');
  await c.env.DB.prepare(
    `UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (${placeholders})`
  ).bind(new Date().toISOString(), ...body.notification_ids).run();

  return c.json({ success: true, data: { acknowledged: body.notification_ids.length } });
});
```

Three independent confirmations that the predicate is absent:

1. `rg -n "op_mobile_notifications" src/` returns exactly two lines: the SELECT at line 240 (correctly scoped `WHERE merchant_id = ? AND device_id = ?`) and the UPDATE at line 259 (unscoped).
2. The v2→v3 file diff shows `src/controllers/mobile.ts` **did not change at all** between the version report 3 audited and this one — the file is byte-identical, so the fix could not have landed.
3. The claim's own wording ("Added AND merchant_id = ?") describes a one-line change that would be visible in any diff of the file; there is no such line.

Exploit (unchanged from report 3): any paired-device JWT (merchant A) POSTs `{"notification_ids":[1,2,3,…,N]}` to `/api/mobile/v1/notifications/acknowledgements`; rows in merchant B's notification table with those integer ids get `read_at` stamped. Ids are small sequential integers, so enumeration is trivial. Impact is confined to read-state (no financial state change), which is why this is a P3 — but the **claim** is false, which is the material finding.

Root-cause note for §24: the remediation summary was evidently written against an intended change-set rather than the shipped artifact, or the change was lost in packaging. Either way, the summary's "verified with unit/integration tests" did not include a test asserting tenant scoping on this UPDATE — because no such test could have passed. **A remediation process that can emit a false FIXED without detecting it will do so again on a higher-severity finding.** The process fix (claim → diff → test → artifact hash, §52 item 2) matters more than the one-line code fix.

## 4. The one claim that is materially incomplete (EDGE-P0-001) — detailed

Claim row:

> **EDGE-P0-001** | Hardcoded credential literals in test scripts | Stripped all fallback API keys and JWT secrets from verify-adversarial.mjs, verify-all-roles.mjs, and verify-corroboration.mjs. Enforced fail-fast exit when env keys are absent. | FIXED

What is true:

- All three scripts now read `process.env.JWT_SECRET` (etc.) and hard-exit with an explicit error when absent (`scripts/verify-adversarial.mjs:19-26` pattern). Verified.
- The live API key literal `op_live_9e9b2a89…` appears in exactly one file in the artifact: `EDGEPAY_CF_FULL_AUDIT_REPORT_1.md`, where report 3 documented the leak. No executable code carries it. Verified.
- `.gitignore` lists `.dev.vars` (with a `!.dev.vars.example` carve-out).

What is not true, or not done:

- **`.dev.vars` is in the zip** with `JWT_SECRET=f14d30e9a38c97b57ac7c3845b64d8307d6233896f7b6d6571892f06c40272f5`, `APP_KEY=t8PYNmv6hdOQGcwWYwAsmckxcdosgIvV40aSm0ua8bM=`, `ENCRYPTION_KEY=nIqX5Y/JMyOxmTdKPx0H2QfBSFOWaBf7NwrlqedLGcM=`. The `JWT_SECRET` **prefix matches the exact secret report 3 flagged as compromised** (`f14d30e9…`). The zip is the delivery artifact the user deploys from; whatever git does or does not track, the artifact ships the key material.
- **No rotation occurred.** The `ENCRYPTION_KEY` is unchanged from prior versions — meaning every `op_gateway_configs.field_value` AES-256-GCM ciphertext in the production D1 is decryptable by anyone who has ever held this file. Rotating `ENCRYPTION_KEY` without a versioned re-encryption path has its own migration cost (EDGE-P2-010, still open), which makes "we didn't rotate" understandable — but the summary then claims FIXED for a finding whose mandatory remediation was rotation, without disclosing the deferral.
- **No secret-scanning CI exists.** No `.github/`, no pre-commit hook, no gitleaks/trufflehog config anywhere in the artifact.

Verdict: **PARTIALLY FIXED — the scripts were cleaned; the secret material was neither purged from the artifact nor rotated; no detection mechanism was added.** For a payment system whose JWT forging and credential decryption both hang on these three values, this remains the top production blocker (§52 item 1).

## 5. Build & deployment claim verification (independently re-executed)

This auditor reconstructed the verification environment from scratch:

```text
$ cd /home/z/my-project/audit/v3/edgepay-cf
$ npm ci --no-audit --no-fund          → 209 packages added in 8s, INSTALL_OK
$ npx tsc --noEmit                     → exit 0, no output (strict mode)
$ npx eslint src tests                 → exit 0; "42 problems (0 errors, 42 warnings)"
$ npx vitest run                       → Test Files 22 passed (22)
                                         Tests       218 passed (218)
                                         Duration    6.67s
```

Notes:

- The lint claim is *technically* true (0 **errors**) but the 42 `@typescript-eslint/no-explicit-any` warnings were not disclosed — and two of them sit on `requirePlatformAdmin(c: any, next: any)`, the very middleware this release added as the P1-005 fix (see V3-009). Warning-level `any` on a security middleware's context type is how scope-check bugs hide.
- The test claim is exactly true, including the file count (22 `.test.ts` files — this auditor counted the directory) and the test count (218). The new `tests/url-guard.test.ts` (15 tests) is present and passing.
- The git and deployment claims cannot be verified from the artifact (no `.git` shipped; no network probe of `workers.dev` from this sandbox was attempted as evidence). They are *consistent* — `wrangler.jsonc`'s `APP_URL`/`APP_DOMAIN` name the exact deployment hostname, and `package.json` version remains `0.3.0` — but they are recorded as **UNVERIFIED/CONSISTENT**, not confirmed.

## 6. Overall production readiness verdict

| Dimension | Report 3 verdict | This report verdict |
|---|---|---|
| Ledger / money correctness | DEFENSIBLE (5 P0s fixed) | **HELD — verified regression-free** |
| Security perimeter | NOT DEFENSIBLE | **MATERIALLY IMPROVED — SSRF, scopes, platform gate, throttles now real; secrets still compromised** |
| Observability | SILENT (AE commented) | **UNCHANGED — still silent** |
| Process / remediation integrity | N/A | **DEGRADED — one false FIXED claim** |
| Test evidence | 212/21 files | **218/22 files — independently reproduced** |
| Final verdict | NOT PRODUCTION READY (perimeter) | **NOT PRODUCTION READY — one rotation + five items from CONDITIONAL** |

The distance to conditional production readiness is short and fully enumerated in §52: (1) rotate/purge the key set and add scanning CI; (2) retract or implement the P3-003 fix and add the tenant-scoping test; (3) enable Analytics Engine; (4) replace the header-only payload cap with a streamed cap; (5) close the `sendTest` input-validation gap; (6) fix the two `any`-typed security middlewares. None of these is more than a day of work; items 1–3 are hours.

## 7. Risk top-5 (ranked by financial/business impact)

| # | Risk | Finding | Exposure | Effort to close |
|---|---|---|---|---|
| 1 | Compromised, unrotated key set still shipped in artifact | EDGE-P0-001 | JWT forgery (mobile API), full gateway-credential decryption (D1 ciphertexts), admin impersonation on any surface that trusts these keys | Hours (rotate) + ~1 day (ENCRYPTION_KEY re-encryption migration) |
| 2 | False FIXED claim signals unaudited remediation process | V3-001 / EDGE-P3-003 | Operator confidence in the tracking signal; future high-severity false claims | 1 line of code + 1 test + process rule (diff-verified claims) |
| 3 | Analytics Engine still disabled — all metrics, including the rate-limit degradation alarm, are no-ops | EDGE-P2-006 | Misconfigured `RATE_LIMIT_*` binding would fail open with no signal; parse-miss, signature-reject and heal events invisible | Minutes (uncomment + deploy) |
| 4 | Refund ghost-call ordering: gateway refund precedes the atomic DB bound check | V3-003 / NEW-P2-001 residual | Losing concurrent refund pays real money at the gateway with no `op_refunds` row; reconciliation sweep is the only backstop | ~1 day (reserve-then-call or gateway-side idempotency key) |
| 5 | `sendTest` persists unvalidated URLs into `op_webhooks` (bypasses registration-time SSRF guard) | V3-002 | Unvalidated data at rest; delivery-time guard currently holds, but the invariant "every stored webhook URL passed the guard" is broken | Minutes (validate `targetUrl` with `isAllowedWebhookUrl` before insert) |

---
# PART II — AUDIT METHOD, ENVIRONMENT & EVIDENCE STANDARD

## 8. Method and evidence rules

This verification pass applies a stricter evidence standard than a normal code review, because its object is *claims about code* rather than the code alone. Each claim in the supplied remediation summary was tested against five rules:

1. **Artifact truth, not intent.** The only admissible code is the code inside `edgepay-cf-clean-new-1.zip` as extracted. Commit messages, plans, prior drafts of the summary, and "it worked on my machine" carry zero evidentiary weight. Where a claim references a file, that file is opened and the claimed construct located (or located missing).
2. **Diff authorship.** Because all three zip versions were available (`v1` = the original, `v2` = the first remediation, `v3` = this release), every changed file was diffed `v2→v3` to confirm (a) the fix landed *in this release*, (b) nothing else in the file moved (regression surface), and (c) files that were *not* supposed to change did not (this is how EDGE-P3-003's absence was proven — `mobile.ts` is byte-identical across v2 and v3).
3. **Independent re-execution.** Every claim that is mechanically checkable (`tsc`, `eslint`, `vitest`, npm install) was re-executed in a clean environment rather than trusted from the summary or from prior TEST_RESULTS.md files (which, as §20 shows, are stale).
4. **Adversarial reading of the fix itself.** A fix that exists is then attacked: what encoding, ordering, environment flag, or code path gets around it? This is what produced V3-002 (sendTest), V3-005 (header-only cap), V3-006 (per-path rate-limit keys), and the SSRF-guard residuals in §12.6.
5. **Claim/text vs code naming discipline.** Where the summary names specific functions, predicates, files or tables ("AND merchant_id = ?", "requireScope('write') across all mutating HTTP verbs", "redirect: 'error' in WebhookQueueConsumer"), the *named* construct is searched for verbatim. Naming-specific claims are cheap to verify exactly and hard to fake accidentally.

Severity and verdict vocabulary are identical to report 3 so the ledgers compose: **FIXED** (the defect's primary exploit path is closed by code that exists and is mounted/reachable), **PARTIALLY FIXED** (the primary path is narrowed but a documented residual remains), **NOT FIXED** (no material change), plus this report's new verdict **FALSE CLAIM** (a summary row asserts a fix that is absent).

## 9. Environment and artifacts

```text
Sandbox:            Linux x86_64, Node via npm (vitest pool: workerd)
Extracted trees:    /home/z/my-project/audit/v1  (edgepay-cf-clean.zip, 218 files, 2.5 MB)
                    /home/z/my-project/audit/v2  (edgepay-cf-clean-new.zip, 221 files, 2.9 MB)
                    /home/z/my-project/audit/v3  (edgepay-cf-clean-new-1.zip, 225 files, 3.1 MB)
Repo root:          v3/edgepay-cf  (package.json: name=edgepay-cf, version=0.3.0)
Dependencies:       npm ci --no-audit --no-fund → 209 packages, 8s, clean install
Verification runs:  tsc --noEmit; eslint src tests; vitest run  (all in v3 tree)
Reference reports:  EDGEPAY_CF_FULL_AUDIT_REPORT_1.md (275,481 bytes — inside the v3 zip)
                    EDGEPAY_CF_FULL_AUDIT_REPORT.md  (329,644 bytes — inside v2/v3 zips)
                    EDGEPAY_AUDIT_REPORT.md          (93,889 bytes)
Commissioning text: the user's message (remediation summary, 15 rows / 22 finding IDs)
```

Notable artifact facts:

- The v3 zip **embeds its own audit history**: all three prior reports ship in the repository. This is unusual and useful — it means the operator's remediation tracking is co-versioned with the code — but it also means the live API key string persists in report 3's prose (a documentation leak of a documentation leak; harmless now that the key itself is invalid/rotated-externally, but it should be redacted to `op_live_9e9b…`).
- `node_modules/` from this auditor's verification run is excluded from all analysis (it is not part of the shipped artifact; the zip's 225-file count is pre-install).
- The `sms-phone-mockup/` sub-project and `scripts/port-gateways/` are part of the artifact and remain in scope for audit purposes (EDGE-P3-006 remains open there).

## 10. The three-version diff (what actually changed in v3)

The complete `diff -rq v2 v3` result, annotated:

```text
Only in v3: EDGEPAY_CF_FULL_AUDIT_REPORT_1.md        (report 3 added to the repo)
Only in v3: eslint.config.js                          (NEW-P3-002 fix)
Only in v3: src/lib/url-guard.ts                      (EDGE-P1-004 fix — new module)
Only in v3: tests/url-guard.test.ts                   (EDGE-P1-004 regression suite)
Changed:    package.json                              (eslint deps + lint script)
Changed:    scripts/verify-adversarial.mjs            (EDGE-P0-001 fix)
Changed:    scripts/verify-all-roles.mjs              (EDGE-P0-001 fix)
Changed:    scripts/verify-corroboration.mjs          (EDGE-P0-001 fix)
Changed:    src/controllers/admin-api.ts              (EDGE-P1-005/NEW-P2-004 + NEW-P2-005 mounts)
Changed:    src/controllers/api.ts                    (EDGE-P1-008 + registration-time SSRF guard)
Changed:    src/index.ts                              (payload cap + rate-limit mounts)
Changed:    src/lib/validation.ts                     (NEW-P3-004/P2-018 money bound)
Changed:    src/middleware/rate-limit.ts              (limit groups incl. checkout)
Changed:    src/queues/webhook-consumer.ts            (SSRF guard + redirect:'error' + 4xx no-retry)
Changed:    src/services/bootstrap.ts                 (NEW-P1-001 KV root-key removal)
Changed:    src/services/payment.ts                   (NEW-P2-002/003 cmp + mandatory amount)
Changed:    src/services/refund.ts                    (NEW-P2-001 atomic conditional INSERT)
Changed:    src/services/sms-corroboration.ts         (NEW-P3-001 + verifiedGateway param)
Unchanged:  202 other files (including mobile.ts — the P3-003 non-fix)
```

Two structural conclusions follow directly:

1. **The release is surgical.** Sixteen files touched, of which four are new artifacts (two code, two meta). No file outside the remediation's blast radius moved. That is why the money core could not have regressed by accident — the refund/ledger/callback code paths changed *only* where the summary said (refund.ts conditional INSERT, payment.ts amount checks).
2. **Everything else is v2.** The 30 NOT FIXED findings and most partials from report 3 live in files that are byte-identical to what report 3 audited. Their verdicts carry forward by diff authorship, and were spot-confirmed (§17–21) rather than re-derived from scratch. The spot-check list: `csrf.ts` (still unmounted), `webhook-dispatcher.ts` (still no outbox), `ledger-do.ts` (fault seam + no identity check), migrations (no UNIQUE on `key_prefix`), `enabled.ts` (unset ⇒ all gateways), `crypto.ts` (PBKDF2 50K default), `maintenance.ts` (unescaped `info.reason`), `sms-phone-mockup/server.js` (open proxy), `sms-parser.ts` (`new RegExp` on merchant-editable patterns), `reconciliation.ts` (heals ledger rows, not payment rows), `cloudflare-access.ts` (JWKS module cache, no fetch timeout), `jwt.ts`/`crypto.ts` (no key versioning).

## 11. Independently re-executed verification battery

Raw output (condensed; full log in Annex B):

```text
=== TYPECHECK ===          npx tsc --noEmit
TSC_EXIT=0                 (zero diagnostics)

=== LINT ===               npx eslint src tests
✖ 42 problems (0 errors, 42 warnings)
  — all 42: @typescript-eslint/no-explicit-any (severity: warn)
LINT_EXIT=0

=== TESTS ===              npx vitest run
 Test Files  22 passed (22)
      Tests  218 passed (218)
   Duration   6.67s (transform 1.05s, setup 2.09s, import 233ms, tests 2.40s)
TEST_EXIT=0
```

Test-file inventory (22 files, all passing): access-jwt, api-middleware, api-reference, bd-gateways, catalog-port, gateway-integrity, gateways-enabled, gateways, jwt, ledger-consistency, ledger-do, money, payment-edgecases, payment-integrity, port-kit, runtime-integrity, smoke, sms-corroboration-edgecases, sms-parser-adversarial, tenant-routing, url-guard (new in v3), workflow-policy.

What the battery does *not* cover — the gaps that matter for interpreting the claims:

- **No test asserts tenant scoping on the notification-ack UPDATE** (the false P3-003 claim hid exactly here).
- **No test covers `POST /api/v1/webhooks/tests` → `sendTest`** (where V3-002 lives).
- **No test asserts the payload cap under `Transfer-Encoding: chunked`** (V3-005).
- **No test asserts that `metric()` data lands anywhere** (because it cannot — EDGE-P2-006).
- **Lint warnings are excluded from the summary's "0 errors" framing** — 42 `any`s, two of them on the new platform-admin middleware.

The pattern: the battery verifies everything the summary says it verifies, and the summary says it verifies exactly the paths that were fixed. The residual risk is in the seams *between* claims. That is what Part VI is for.

---

# PART III — REMEDIATION CLAIM VERIFICATION (THE 15 CLAIM ROWS / 22 FINDING IDS)

## 12. Claim-by-claim verification with code evidence

The supplied summary contains 15 rows covering 22 finding IDs. Each row is reproduced verbatim, then verified. Line numbers refer to the v3 extraction.

### 12.1 Row 1 — EDGE-P0-001 (hardcoded credentials in test scripts)

> "Stripped all fallback API keys and JWT secrets from verify-adversarial.mjs, verify-all-roles.mjs, and verify-corroboration.mjs. Enforced fail-fast exit when env keys are absent."

**Verification:**

- `scripts/verify-adversarial.mjs:19` — `const JWT_SECRET = process.env.JWT_SECRET;` with a hard-exit at line 25–26 when absent. Same pattern in `verify-all-roles.mjs:19` and `verify-corroboration.mjs`. **Scripts are clean.**
- Repository-wide search for the v1 live-key prefix (`9e9b2a89581d`) matches exactly one file: `EDGEPAY_CF_FULL_AUDIT_REPORT_1.md` (report 3's own documentation of the leak). No executable code carries it.
- **However** — `.dev.vars` ships in the zip with the same three values as v1/v2, `JWT_SECRET` prefix matching the exact compromised secret (`f14d30e9…`). No `.github/`, no scanning config. `.gitignore` lists `.dev.vars`, but the artifact contains it regardless (either it is git-tracked from before the ignore entry, or the zip packaging includes it deliberately for deploy-button convenience — either way the delivered artifact carries the secrets).
- Rotation status: none. `ENCRYPTION_KEY` unchanged ⇒ all D1 gateway-credential ciphertexts remain decryptable by any prior holder of the repo.

**Verdict: PARTIALLY FIXED / MATERIALLY INCOMPLETE.** The literal claim (scripts stripped, fail-fast) is true; the finding's mandatory remediation (rotate, purge artifact, add scanning) is not done and is not disclosed as deferred.

### 12.2 Row 2 — NEW-P1-001 (plaintext root key in KV)

> "Deleted env.KV.put('system:root_api_key', ...) in bootstrap.ts. Root key is now only stored as a SHA-256 hash in D1 op_api_keys."

**Verification:**

- `src/services/bootstrap.ts` — the file contains **no** `KV.put('system:root_api_key')` anywhere. The key-provisioning block (lines 182–204) generates `op_live_${prefix}_${rest}`, computes `keyHash = await sha256(newApiKey)`, and inserts into `op_api_keys` with `key_hash` — exactly as claimed.
- The only KV writes in bootstrap are `system:bootstrapped` and `system:installed` flags (lines 206–207) — no secret material.
- The plaintext key is returned in `BootstrapResult.api_key` — consumed by the auto-bootstrap path in `index.ts` via `waitUntil` (result discarded, never surfaced in any response) and by the install wizard flow. No KV persistence of the plaintext anywhere.
- Claim-token flow (row 3) also stores *new-merchant* credentials in KV for 15 minutes — that is a different, disclosed-in-§V3-004 trade-off, not this finding.

**Verdict: VERIFIED — FIXED.** The exact deletion claimed is present; the hash-only storage invariant holds; no new plaintext-KV path for the root key exists.

### 12.3 Row 3 — EDGE-P1-005 & NEW-P2-004 (cross-tenant admin escalation & credential harvesting)

> "Added requirePlatformAdmin middleware on GET/POST /api/admin/v1/merchants (is_platform = 1 check). Replaced raw credential response with a 15-minute single-use claim token via POST /api/admin/v1/merchants/claim."

**Verification:**

- `src/controllers/admin-api.ts:247–259` — `requirePlatformAdmin` middleware: loads the caller's merchant row from D1, requires `is_platform === 1`, else 403 `FORBIDDEN` ("Platform administrator privileges required"). Mounted on `GET /merchants` (line 262) and `POST /merchants` (line 286), both *after* `requireScope('admin')`.
- The route group is additionally gated by `requireBearerApiAuth(['admin'])` (line 29) and the Cloudflare Access middleware at `/api/admin/*` (`index.ts:176`).
- Provisioning response (lines 421–434): returns `merchant_id`, `uuid`, `name`, `slug`, `email`, **`claim_token`**, `claim_url`, `claim_expires_in: '15 minutes'` — **no** `api_key`, `initial_password`, `pairing_otp`, or `webhook_secret` in the response. Credentials are staged in KV under `claim:{token}` with `expirationTtl: 900` (lines 406–419).
- `POST /merchants/claim` (lines 271–283): requires the group-level admin-scope bearer auth, validates the token, **deletes the KV entry before returning the payload** (single-use enforced), 404 on invalid/expired token. Claim tokens are `randomBase64Key(24)` stripped to alphanumerics ≈ 24 chars ≈ 142+ bits of entropy — brute force infeasible.
- Residuals (disclosed here, not in the summary): (a) the claim endpoint requires *any* admin-scoped key, not a platform key — a non-platform merchant admin holding a valid claim token could redeem it; acceptable because only the creating platform admin sees the token, but the tighter check costs one line; (b) credentials sit in **plaintext in KV** for up to 15 minutes (KV is not encrypted at rest in a tenant-isolated way beyond Cloudflare's platform); (c) the claim route lacks its own tight rate-limit group (it inherits only the per-API-key native limiter).

**Verdict: VERIFIED — FIXED (with three undisclosed residuals, all low).** The escalation (any admin-scoped key enumerating/provisioning tenants) and the harvesting (credentials in the provisioning response) are both closed at exactly the claimed locations.

### 12.4 Row 4 — EDGE-P1-008 (read-scoped keys executing mutations)

> "Enforced requireScope('write') across all mutating HTTP verbs (POST, PUT, PATCH, DELETE) on /api/v1/* in api.ts."

**Verification:**

- `src/controllers/api.ts:26–32`:

```ts
// Enforce write scope on all mutating HTTP methods (POST, PUT, PATCH, DELETE) — EDGE-P1-008 fix
apiRoutes.use('*', async (c, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
    return (requireScope('write') as any)(c, next);
  }
  return next();
});
```

- Mounted after `requireBearerApiAuth(['read','write','admin'])` (line 24) and before all routes — correct ordering (scope check needs `authScopes` populated).
- Route census confirms full coverage: every `POST`/`PUT`/`DELETE` under `/api/v1` (payments, refunds, api-keys, webhooks, webhooks/tests, webhooks/:id) now requires `write` in addition to route-specific scopes (`POST /api-keys` additionally requires `admin`; `POST /refunds` additionally requires idempotency + `write` explicitly).
- Scope-check semantics (`requireScope`, `auth.ts:174–182`): grants if scopes include `'*'` or the required scope — read-only keys (`['read']`) fail every mutating verb with 403. The prior exploits (`POST /payments` and webhook registration with a read-only key) are closed.
- Residual (cosmetic): the middleware casts `requireScope('write')` through `any` — the same typing laxity flagged in V3-009; behavior is correct, the type hole is a warning-level hygiene issue.

**Verdict: VERIFIED — FIXED.** The exact method-based enforcement claimed is present, mounted once at the router level, and covers every mutating route in the file.

### 12.5 Row 5 — P3-003 (cross-tenant notification acknowledgements)

> "Added AND merchant_id = ? predicate to UPDATE op_mobile_notifications in mobile.ts."

**Verification: FALSE.** See §3. `mobile.ts:259` has no `merchant_id` predicate; the file is byte-identical to v2; the predicate exists nowhere in the repository. This is the report's headline false claim (V3-001).

**Verdict: FALSE CLAIM — NOT FIXED.**

### 12.6 Row 6 — EDGE-P1-004 (webhook SSRF bypass)

> "Created url-guard.ts with comprehensive parser: blocks private IPv4 (dotted, integer 2130706433, hex 0x7f000001, octal 0177.0.0.1), IPv6 ULA (fc00::/7), IPv6 link-local (fe80::/10), IPv4-mapped IPv6 (::ffff:127.0.0.1), .local/.internal, and sets redirect: 'error' in WebhookQueueConsumer."

**Verification — the guard module (`src/lib/url-guard.ts`, 77 lines):**

- Private IPv4 ranges: `0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 224+/4` (multicast/reserved) — lines 8–21. ✅
- Integer IPv4 (`2130706433`): `/^\d+$/` → decodes via bit-shifts and runs the private check — lines 63–68. ✅
- Hex (`0x…`) and octal (`0177.0.0.1`) forms: rejected outright — lines 69–71. ✅
- IPv6: `::1`, `::`, ULA `fc/fd` prefixes (fc00::/7), link-local `fe8/fe9/fea/feb` (fe80::/10), IPv4-mapped `::ffff:` with recursive v4 check (including the hex-in-mapped form `::ffff:7f00:1`, which mis-parses as invalid → treated private → blocked) — lines 23–33, 58–60. ✅
- Hostname layer: `localhost`, `.local`, `.internal`, `.localhost` suffixes — line 53. ✅ HTTPS-only (line 47), with an explicit dev-only `http://localhost` carve-out gated on `ENVIRONMENT !== 'production'`. ✅

**Verification — the two enforcement points:**

- Delivery time: `webhook-consumer.ts:37` — `if (!isAllowedWebhookUrl(webhook.url, env.ENVIRONMENT !== 'production'))` → logs `blocked_ssrf`, acks, never fetches. Fetch options at line 51–64 include **`redirect: 'error'`** (line 62), a 15 s `AbortController` timeout (lines 48–49), and — a bonus fix — 4xx responses are acked as permanent (lines 76–79), closing EDGE-P3-009's "400/401/404 retried forever" finding as a side effect.
- Registration time: `api.ts:336–339` — `POST /api/v1/webhooks` validates `body.url` through the same guard before insert (a second enforcement point the summary did not even claim).

**Adversarial reading (residuals — all platform-mitigated, none claimed, all real):**

1. **DNS rebinding is not resolvable at this layer.** The guard is a pure string/parse check; it cannot resolve a public-looking hostname to a private IP. Mitigation stack: Cloudflare's Workers `fetch()` blocks RFC1918/loopback destinations at the platform level, `redirect: 'error'` kills redirect-based rebinding, and the 15 s timeout bounds any attack interaction. Residual risk: Low, documented.
2. **Trailing-dot hostnames**: `https://localhost./hook` — `'localhost.'` ≠ `'localhost'` and does not end with `.local`/`.internal`/`.localhost` (it ends with `.`). Passes the guard. Practical impact on Workers: platform fetch to `localhost.` fails at the edge; still, the guard's own contract is violated. One-line fix: strip trailing dots before matching.
3. **Shorthand dotted-quad**: `127.1` matches none of the three numeric patterns (`^\d+$`, `^0x`, `^\d+\.\d+\.\d+\.\d+$`) → treated as a hostname → passes. curl-style resolvers would expand `127.1` → `127.0.0.1`; Cloudflare's resolver treats it as a DNS name (fails). Residual: cosmetic-to-low.
4. **NAT64 `64:ff9b::/96`** (e.g. `64:ff9b::7f00:1` = 127.0.0.1): not matched by any IPv6 branch → passes. Platform fetch of NAT64-mapped loopback fails at the edge. Residual: low.
5. **`allowHttpLocalhost` in non-production**: `ENVIRONMENT !== 'production'` permits plain-HTTP localhost delivery — a deliberate dev affordance that becomes an SSRF *hole* if a deployment mislabels its environment. A warning-level operational foot-gun (see V3-007 family).

**Verdict: VERIFIED — FIXED (strong fix, enforcement at two points; four string-level bypasses remain, each individually platform-mitigated; rebinding handled by redirect-policy + platform, not by resolution).** The claim lists exactly what the module does, and the module does exactly what the claim lists.

### 12.7 Row 7 — P1-003 & P2-014 (unbounded payload size)

> "Mounted a global 128 KB payload ceiling middleware (Content-Length > 128KB → 413 Payload Too Large) in index.ts."

**Verification:**

- `index.ts:184–194` — the middleware exists, mounted at `'*'` **before** all route mounts, returning exactly the claimed `413` + `PAYLOAD_TOO_LARGE` envelope:

```ts
app.use('*', async (c, next) => {
  const cl = c.req.header('content-length');
  if (cl && parseInt(cl, 10) > 128 * 1024) {
    return c.json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 128 KB limit' } }, 413);
  }
  return next();
});
```

- **Adversarial reading — the cap checks the header only.** A request with `Transfer-Encoding: chunked` (no `Content-Length`) sails past the middleware into `c.req.json()` / `c.req.text()`. On the Workers runtime the edge generally buffers and normalizes client bodies (and `cf`-fronted traffic gets a Content-Length), so practical exposure is limited to non-standard clients and any future binding-fronted callers; the JSON parse itself is CPU-bounded by the runtime's limits, and D1 rejects statements over 1 MB — so the realistic worst case is wasted CPU, not a memory bomb. Still: **the guard is header-shaped, not stream-shaped.** A `stream.read(upTo(128*1024+1))`-style check (or a `Content-Length`-required policy for JSON routes) is the actual fix. This is V3-005.
- P2-014's other half (unbounded *fields* on public surfaces) is partially narrowed by the same cap + `moneySchema` bounds (row 10) + existing `z.string().max()` on validated routes; hand-rolled `c.req.json<T>()` bodies (`/install`, `sendTest`, checkout `verify`) remain length-limited only by this cap.

**Verdict: VERIFIED as claimed at the mechanical level — but the fix is weaker than its name. PARTIALLY FIXED (residual: chunked/absent-length bypass, V3-005).**

### 12.8 Row 8 — NEW-P2-001 (refund cumulative-bound race)

> "Converted refund insertion to an atomic SQLite conditional write: INSERT INTO op_refunds ... SELECT ... WHERE (SELECT SUM(amount) ...) + ? <= (SELECT amount FROM op_transactions) + 0.001 in refund.ts."

**Verification:**

- `src/services/refund.ts:129–157` — the INSERT is exactly the claimed single-statement conditional write:

```sql
INSERT INTO op_refunds (merchant_id, refund_id, transaction_id, gateway_refund_id, amount,
                         currency, reason, status, initiated_by, created_at, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?
WHERE (
  SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) FROM op_refunds
  WHERE transaction_id = ? AND merchant_id = ?
    AND status IN ('completed', 'pending', 'processing')
) + CAST(? AS NUMERIC) <= (SELECT CAST(amount AS NUMERIC) FROM op_transactions WHERE id = ?) + 0.001
```

- The rejected case is detected: `if (!inserted.meta?.changes || inserted.meta.changes === 0) throw` (lines 159–161) → surfaces as 422 `REFUND_REJECTED`.
- Concurrency semantics: D1/SQLite executes the single INSERT (with its subqueries) as one atomic statement; two racing partial refunds serialize, and the second one's SUM now *includes* the first one's committed row — the TOCTOU window between "check" and "insert" that report 3 demonstrated is closed at the storage layer. ✅
- Residuals (not claimed, real): (a) **ghost-refund ordering** — step 2 calls `adapter.refund(...)` at the *gateway* before the atomic insert at step 3, so the losing request of a race has already spent real money at the gateway before the DB rejects its row; reconciliation-sweep catches the orphan later, but money moved (V3-003). (b) The bound arithmetic uses `CAST(amount AS NUMERIC)` (SQLite REAL — float64) with a ±0.001 tolerance rather than the codebase's integer-cents `cmp()`; for ≤ 2-decimal amounts below 1e12 this is exact enough in practice, but it is the same float-discipline inconsistency NEW-P2-002 was filed against, now living in SQL.

**Verdict: VERIFIED — FIXED for the raced DB bound (the finding as filed); residual ghost-call ordering and float-tolerance noted as V3-003 and NEW-P2-002-residual.**

### 12.9 Row 9 — NEW-P2-002 & NEW-P2-003 (float comparison & optional amount in handleCallback)

> "Upgraded handleCallback() in payment.ts to use exact decimal cmp(), and enforced mandatory amount verification for all API gateway types."

**Verification:**

- `payment.ts:315–332` — both halves present:

```ts
const { cmp } = await import('../lib/money');
// 1. Mandatory amount verification for API gateways & exact decimal comparison (NEW-P2-002/003 fix)
if (verifyResult.amount == null) {
  if (intent.gateway_slug && intent.gateway_slug !== 'manual') {
    ... UPDATE op_transactions SET status = 'failed' ...
    return { success: false, status: 'amount_unverified' };
  }
} else {
  if (cmp(String(verifyResult.amount), intent.amount) !== 0) {
    ... status = 'failed' ...
    return { success: false, status: 'amount_mismatch' };
  }
}
```

- Exact decimal comparison via the codebase's own `cmp()` (integer-scaled string compare in `lib/money.ts`) — replaces the old `parseFloat` ±0.001. ✅
- Null-amount adapters: non-manual gateways now hard-fail the transaction (`amount_unverified`) instead of silently completing — the exact "amount check skipped when adapter returns no amount" bypass report 3 filed. ✅ The manual carve-out is correct: manual/MFS flows corroborate via the SMS path, which independently enforces exact-amount `cmp()` (§16).
- trx_id binding (EDGE-P0-004's fix) remains enforced at lines 335–340; the terminal-state guard (only regress to `failed` from pending/processing/created) remains at lines 344–347 — no regression of the earlier P1-006 partial.
- Residual: NEW-P2-006 (intent lookup `WHERE pi.id = ?` without a merchant predicate at the DB layer) is *still* open — `handleCallback` is only reachable via the token-resolved checkout callback and the inbound-webhook path, both of which establish the intent through a 64-hex-char random token, so the practical attack surface requires token knowledge; the DB-layer binding remains unaudited-by-SQL as filed.

**Verdict: VERIFIED — FIXED (both halves; carve-out correct; one adjacent finding unchanged).**

### 12.10 Row 10 — NEW-P3-004 & P2-018 (unbounded monetary values)

> "Added .refine(v => n > 0 && n <= 1_000_000_000) bound check to moneySchema in validation.ts."

**Verification:**

- `validation.ts:20–26` — exactly the claimed refine on `moneySchema`, which feeds both `createPaymentSchema.amount` and `createRefundSchema.amount`:

```ts
export const moneySchema = z
  .string(...)
  .regex(/^\d+(\.\d{1,2})?$/, 'amount must be a valid monetary amount (…)')
  .refine(v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1_000_000_000;
  }, 'amount must be greater than 0 and not exceed 1,000,000,000');
```

- Both money-taking public routes (`POST /api/v1/payments`, `POST /api/v1/refunds`) route through `zValidator` with these schemas; a 1e12 amount now 400s at the boundary. `POST /api/admin/v1/refunds` uses a hand-rolled body (no zod) — its `amount` is bounded downstream by the refund service's cumulative check against the captured amount, so the ceiling holds indirectly there (the captured amount itself can never exceed 1e9 because it came through `createIntent`'s schema).
- The regex also enforces 2-dp decimal strings (no exponents, no signs) — combined with the refine, the schema now rejects every magnitude and shape abuse from report 3's P2-018 card.

**Verdict: VERIFIED — FIXED.**

### 12.11 Row 11 — NEW-P1-002 & EDGE-P1-002 (credential endpoints unthrottled)

> "Mounted perIpRateLimit('password') on /install/bootstrap-key, perIpRateLimit('otp') on /api/mobile/v1/pair* and /api/mobile/v1/devices."

**Verification — all mounts present in `index.ts:196–202`, in correct order (specific before general):**

```ts
app.use('/install/bootstrap-key', perIpRateLimit('password'));   // 10/hour/IP
app.use('/install*', perIpRateLimit('install'));                 // 120/min/IP
app.use('/api/mobile/v1/pair*', perIpRateLimit('otp'));          // 10/hour/IP
app.use('/api/mobile/v1/devices', perIpRateLimit('otp'));        // 10/hour/IP
app.use('/checkout/*/verify', perIpRateLimit('checkout'));       // 30/10min/IP
app.use('/checkout/*/submit-trx', perIpRateLimit('checkout'));
```

- The `'password'` group (10 req/hour/window) on `/install/bootstrap-key` converts the old 120/min password-oracle into a 10-per-hour-per-IP oracle — a 720× tightening. ✅
- The `'otp'` group (10/hour) on `pair*` and `devices` mounts the previously dead configuration report 3 called "dead configuration describing security that does not exist" — now it exists. The 6-digit OTP space (1e6) at 10/hr/IP makes online brute force ~11 years per IP per current OTP; with the 30-day OTP validity and no per-token lockout, a patient distributed attacker with ≥ 1000 IPs gets the expected time to ~9 hours — thin but real; the deeper fix (per-token attempt counters in D1) remains open. ✅ as claimed.
- Mount-order check: `bootstrap-key`'s mount precedes the broader `/install*` mount; Hono applies both, but the specific group's 413/429 fires with the tighter limit — correct.
- Residuals: (a) the counter is KV-based read-check-write (eventual consistency) — a burst of concurrent requests from one IP can all read `count=0` and pass (EDGE-P1-010's race, unchanged; see V3-006); (b) the counter key is `prefix + IP + c.req.path` — for token-parameterized paths (`/checkout/{token}/verify`) each token gets a *separate* 30/10min budget, diluting the checkout oracle defense across token guessing (V3-006's second half); (c) `getClientIp` falls back to spoofable `X-Forwarded-For`/`X-Real-IP` if `CF-Connecting-IP` is absent — dead code on the Cloudflare edge, live code if the app is ever fronted by a non-CF proxy.

**Verdict: VERIFIED — FIXED (the mounts exist with the claimed groups; the KV race and per-path keying residuals are unchanged and undisclosed).**

### 12.12 Row 12 — NEW-P2-005 (checkout verification endpoints unthrottled)

> "Mounted perIpRateLimit('checkout') (30 req / 10 min) on /checkout/*/verify and /checkout/*/submit-trx."

**Verification:** Both mounts present (above); the `'checkout'` group is defined in `rate-limit.ts:40` as `{ windowSec: 600, maxRequests: 30 }` — exactly "30 requests / 10 minutes". The TrxID-oracle brute-force surface report 3 flagged is now throttled per-IP. The per-path keying dilution (V3-006b) and KV race (V3-006a) apply.

**Verdict: VERIFIED — FIXED (with the same two residuals as row 11).**

### 12.13 Row 13 — NEW-P3-001 (dead call in SMS corroboration)

> "Removed redundant senderToGatewaySlug(null) operand in sms-corroboration.ts."

**Verification:**

- The old dead operand (`senderToGatewaySlug(null)` evaluated unconditionally alongside a real lookup) is gone from `sms-corroboration.ts`.
- The module now takes `verifiedGatewaySlug` as an explicit **parameter** of `corroborateSmsPayment()` (line 104), and the caller computes it correctly once, with the real sender: `sms-consumer.ts:84` — `const verifiedGateway = senderToGatewaySlug(sms.sender);` then `corroborateSmsPayment(extraction, openOrders, verifiedGateway)`.
- The gate's own logic (verified sender wins over LLM guess; family conflict → manual review, lines 151–161) is unchanged and intact.

**Verdict: VERIFIED — FIXED.** Exactly the removal claimed, with the caller now wired correctly.

### 12.14 Row 14 — NEW-P3-002 (ESLint 9 flat config)

> "Configured eslint.config.js and updated npm run lint."

**Verification:**

- `eslint.config.js` exists at repo root — a flat-config array with `@typescript-eslint/parser` + plugin, `files: ['src/**/*.ts', 'tests/**/*.ts']`, and three rules (`no-explicit-any: warn`, `no-unused-vars: warn` with ignore patterns, `no-console: off`).
- `package.json` now contains `"lint": "eslint src tests"` and the eslint devDependencies for v9 flat config.
- Re-executed: `npx eslint src tests` → exit 0, `42 problems (0 errors, 42 warnings)`. The pipeline is functional for the first time in the series (v1/v2 could not lint at all — ESLint 8 config shape vs ESLint 9 runtime).

**Verdict: VERIFIED — FIXED.** (The 42 warnings — including two `any`s on the new platform-admin middleware — are disclosed in §5/V3-009 but do not contradict the claim as written.)

### 12.15 Row 15 — Verification & deployment claims

> "Linting: 0 errors. Typecheck: 0 errors. 22/22 test files (218/218). Git pushed (303f156). Deployed live (Worker Version 92343535-…)."

**Verification:** See §5. Lint/typecheck/tests all reproduced **exactly**. Git state and live deployment are **unverifiable from the artifact** (no `.git`; no live probe performed) and are recorded as consistent-but-unconfirmed. The `wrangler.jsonc` `APP_URL`/`APP_DOMAIN` (`edgepay-cf.bm-jonybepary.workers.dev`) matches the claimed deployment URL.

**Verdict: TRUE for the three mechanical claims; UNVERIFIED for git/deploy.**

## 13. Claim verification matrix (summary)

| # | Row (finding IDs) | Claimed | Verified status | Evidence anchor |
|---|---|---|---|---|
| 1 | EDGE-P0-001 | FIXED | **PARTIAL — scripts clean; secrets unrotated, `.dev.vars` shipped, no scanning CI** | §12.1 |
| 2 | NEW-P1-001 | FIXED | **FIXED** — hash-only D1 storage confirmed | §12.2 |
| 3 | EDGE-P1-005 + NEW-P2-004 | FIXED | **FIXED** — platform gate + claim token; 3 low residuals | §12.3 |
| 4 | EDGE-P1-008 | FIXED | **FIXED** — method-based write-scope middleware | §12.4 |
| 5 | EDGE-P3-003 | FIXED | **FALSE — claimed predicate absent; file unchanged from v2** | §12.5 |
| 6 | EDGE-P1-004 | FIXED | **FIXED** — guard + dual enforcement + `redirect:'error'`; 4 string-level residuals (platform-mitigated) | §12.6 |
| 7 | P1-003 + P2-014 | FIXED | **PARTIAL — cap exists but is header-only (chunked bypass)** | §12.7 |
| 8 | NEW-P2-001 | FIXED | **FIXED** — atomic conditional INSERT; ghost-call ordering residual | §12.8 |
| 9 | NEW-P2-002 + NEW-P2-003 | FIXED | **FIXED** — `cmp()` + mandatory amount, correct manual carve-out | §12.9 |
| 10 | NEW-P3-004 + P2-018 | FIXED | **FIXED** — refine bound on moneySchema | §12.10 |
| 11 | NEW-P1-002 + EDGE-P1-002 | FIXED | **FIXED** — all mounts present; KV race + per-path keys residual | §12.11 |
| 12 | NEW-P2-005 | FIXED | **FIXED** — checkout group 30/10min mounted | §12.12 |
| 13 | NEW-P3-001 | FIXED | **FIXED** — dead call removed, caller wired | §12.13 |
| 14 | NEW-P3-002 | FIXED | **FIXED** — flat config, lint runs, 0 errors | §12.14 |
| 15 | Verification & deploy claims | as stated | **TRUE (lint/tsc/tests reproduced exactly); UNVERIFIED (git/deploy)** | §12.15 |

Bottom line: **13 VERIFIED / 1 PARTIAL / 1 FALSE.** The remediation summary is 87% trustworthy at row level — and 100% trustworthy on everything mechanically re-executable. Its two failures are exactly the two things a verification battery cannot see: the contents of the artifact's secret files, and code that was *supposed* to change but didn't.

---
# PART IV — REGRESSION VERIFICATION OF THE MONEY-CORE P0 FIXES

Report 3's headline was "the money core is now defensible": five payment-integrity P0s (EDGE-P0-002, 003, 004, 006, 007) were fixed in v2. This release touched two of the files those fixes live in (`refund.ts`, `payment.ts`) — for the new race/amount fixes. The question this part answers: did the new edits disturb the old guarantees?

## 14. The five previously-fixed money P0s under the new code

| P0 | v2 fix (report 3) | v3 state | Regression evidence |
|---|---|---|---|
| **EDGE-P0-002** — refund reverses the wrong ledger row (ID-space confusion) | Refund pipeline rewritten; reversal keyed by `m{merchant}:refund:{refundPublicId}` posting ids, not payment ids | **HELD** | `refund.ts` v3: refund row insert now atomic, but the public-id keying (`rfnd_…` line 128) and the workflow trigger path (`triggerRefundReconciliation(env, refundRowId)`, line 166) are unchanged; the ledger posting still flows through the same `RefundService → refund-reconciliation workflow → postPaymentReversal` chain audited in report 3. `ledger.ts`/`ledger-do.ts` are byte-identical to v2. |
| **EDGE-P0-003** — unbounded refunds / no ledger reversal / instant "completed" | Single-path `RefundService` with cumulative bounds; status `pending` until workflow confirms | **HELD + STRENGTHENED** | v3 adds the atomic conditional INSERT on top of the same single path; refunds still insert as `'pending'` (line 134) and only the workflow flips them; the cumulative bound now holds under concurrency (§12.8). |
| **EDGE-P0-004** — callback ignores amount/intent binding | `handleCallback` enforces amount equality + `trx_id` binding | **HELD + STRENGTHENED** | amount check upgraded from float-tolerance to exact `cmp()`; null-amount now hard-fails (§12.9); trx_id binding intact (`payment.ts:335–340`). |
| **EDGE-P0-006** — checkout stored XSS + no CSP | full-context `escapeHtml`, `sanitizeBrandColor`, `data-*`/`dataset`/`innerText` rendering, CSP on checkout routes | **HELD** | `checkout.ts` is byte-identical to v2 except none — the diff shows no change to this file; CSP middleware at lines 16–22, `escapeHtml` at 772–779 (all five entities), `sanitizeBrandColor` at 781–786 (strict `#hhhhhh` regex with safe default). |
| **EDGE-P0-007** — SMS-corroborated completion skips amount on NULL / accepts no_match | mandatory exact-amount + TrxID binding in corroboration and customer-verify paths | **HELD** | `sms-corroboration.ts` v3: `!extraction.amount → manual_review` (line 106), mandatory `trx_id` (line 109), exact `cmp()` (line 118), customer-submitted TrxID match required (lines 132–147). The v3 edit (verifiedGatewaySlug parameter) is a pure refactor of the gateway-resolution input; the amount/TrxID gates are untouched. Checkout-side exact-amount check (`checkout.ts:190–200`) unchanged. |

## 15. Refund pipeline regression walkthrough (full path, v3)

The complete refund flow under v3, annotated with the invariant held at each step:

```text
POST /api/v1/refunds
  ├─ createIdempotencyMiddleware({ required: true })     [idempotency key MANDATORY]
  ├─ requireScope('write')                                [read-only keys blocked — v3]
  ├─ zValidator(createRefundSchema)                       [amount: 2dp, >0, ≤1e9 — v3]
  ├─ tx lookup: WHERE trx_id = ? AND merchant_id = ?      [tenant-bound]
  ├─ status gate: tx.status === 'completed'               [only captured money refundable]
  ├─ gateway enabled gate (ENABLED_GATEWAYS)              [422 if disabled]
  └─ RefundService.createRefund
       ├─ re-lookup tx with merchant_id                   [defense in depth]
       ├─ status gate again (completed only)
       ├─ fast-fail cumulative check (pre-read)           [latency optimization only]
       ├─ adapter.refund() at gateway (best-effort)       [ghost-call residual V3-003 lives here]
       ├─ ATOMIC conditional INSERT (bound in SQL)        [NEW-P2-001 fix — v3]
       │    changes === 0 → throw REFUND_REJECTED
       └─ triggerRefundReconciliation(refundRowId)
            └─ per-refund workflow instance `refund-{id}` [idempotent instance id]
                 ├─ polls gateway until terminal
                 ├─ posts idempotent ledger reversal      [P0-002 fix — keyed by refund id]
                 ├─ dispatches webhook
                 └─ flips refund status pending→completed/failed
```

Every invariant report 3 verified in v2 is present in v3; the two v3 additions (write-scope + schema bound at the API layer, atomic bound at the SQL layer) *narrow* the attack surface without moving any subsequent step. The refund-reconciliation workflow file is unchanged. The ledger posting protocol (`ledger.ts`, `ledger-do.ts`, `POSTING-PROTOCOL.md`) is unchanged. **No regression.**

## 16. Callback and corroboration regression walkthrough (full path, v3)

```text
GET /checkout/{token}/callback   (64-hex random token)
  └─ PaymentService.handleCallback(intentId, params)
       ├─ intent lookup: WHERE pi.id = ? (token-resolved)   [NEW-P2-006 residual: no SQL-level
       │                                                     merchant predicate — unchanged]
       ├─ adapter.verify(callbackData, credentials)
       ├─ verifyResult.success?
       │    ├─ verifyResult.amount == null?
       │    │    ├─ gateway !== 'manual' → FAIL tx, amount_unverified   [NEW-P2-003 fix — v3]
       │    │    └─ gateway === 'manual' → continue (SMS path owns amount)
       │    ├─ cmp(verifyResult.amount, intent.amount) !== 0 → FAIL    [NEW-P2-002 fix — v3]
       │    ├─ verifyResult.trx_id !== intent.trx_id → FAIL             [P0-004 — held]
       │    └─ completeTransaction
       │         ├─ postPaymentLedgerEntry AWAITED first   [posting-before-completion — held]
       │         ├─ D1 batch: tx completed + intent completed (atomic)
       │         └─ webhook dispatch (queue)
       └─ else: FAIL tx ONLY IF status IN (pending, processing, created)  [P1-006 guard — held]

POST /checkout/{token}/verify  (customer submits TrxID)     [checkout limiter 30/10min — v3]
  ├─ trx_id shape gate (≥4 chars)
  ├─ intent status completed → short-circuit success
  ├─ TrxID-reuse gate (claimed by another COMPLETED tx → 409)   [double-spend guard — held]
  ├─ SMS match query (same merchant, pending/parsed/review/no_match)
  │    └─ matched:
  │         ├─ parsed_amount NULL or cmp(parsed, intent.amount) ≠ 0 → 400 AMOUNT_MISMATCH  [P0-007 — held]
  │         └─ completeTransaction + mark SMS 'matched'
  └─ not matched: persist customer_trx_id/phone on intent metadata → 'awaiting_sms'

SMS arrives → queue → SmsQueueConsumer
  ├─ insert op_sms_data (pending)
  ├─ parse (regex → Workers AI fallback)
  ├─ corroborateSmsPayment(extraction, openOrders, senderToGatewaySlug(sender))  [NEW-P3-001 fix — v3]
  │    ├─ no amount / no trx_id / no open orders → manual_review
  │    ├─ exact cmp() amount filter
  │    ├─ currency filter (when extracted)
  │    ├─ customer_trx_id exact match; exactly-one → confirm; zero → awaiting_customer_trx
  │    ├─ sender-gateway family conflict → manual_review
  │    └─ confirm → completeTransaction (idempotent ledger posting)
  └─ match_status bookkeeping (matched / needs_manual_review)
```

The corroboration gate's decision table is unchanged from v2 in every money-relevant cell; the v3 refactor only changes *how* the verified gateway slug reaches the function (parameter instead of a dead parallel call). The checkout customer-verify path retains the TrxID-reuse gate *ahead* of the SMS match, which is what prevents one real SMS from completing two same-amount orders. **No regression.**

---

# PART V — CONSOLIDATED FINDING LEDGER (ALL 61 FINDINGS, V3 STATUS)

Verdicts for findings whose files did not change v2→v3 are carried forward from report 3 by diff authorship (§10) and spot-confirmed. New v3 statuses are marked ⟶.

## 17. P0 ledger (7 findings)

| ID | Finding (one-line) | v3 status | Notes / anchor |
|---|---|---|---|
| EDGE-P0-001 | Live credentials committed (scripts + `.dev.vars`); rotation mandatory | **PARTIALLY FIXED ⟶** | Scripts cleaned; `.dev.vars` still ships same `JWT_SECRET`/`ENCRYPTION_KEY`; no rotation; no scanning CI. §12.1, §4 |
| EDGE-P0-002 | Refund reverses wrong ledger row (ID-space confusion) | **FIXED (held)** | §14, §15 |
| EDGE-P0-003 | Merchant-API refunds unbounded / no reversal / instant completed | **FIXED (held, strengthened ⟶)** | Atomic bound added in v3. §15 |
| EDGE-P0-004 | Callback ignores amount & intent binding | **FIXED (held, strengthened ⟶)** | Exact `cmp()` + mandatory amount. §16 |
| EDGE-P0-005 | Bootstrap default-credential chain mints root key with known values | **PARTIALLY FIXED** | Prod gets CSPRNG password/OTP/key (since v2); ⟶ plaintext KV root key removed (NEW-P1-001); install lock still KV-only; auto-bootstrap still fires on first non-install request of a fresh deployment (`index.ts:83–108`); `/install` first-come race remains; bootstrap-key now 10/hr (v3). §12.1, §12.11 |
| EDGE-P0-006 | Checkout stored XSS + no CSP | **FIXED (held)** | `checkout.ts` unchanged from v2; escaping + CSP verified again. §14 |
| EDGE-P0-007 | SMS-corroborated completion skips amount on NULL / accepts no_match | **FIXED (held)** | §16 |

## 18. P1 ledger (10 findings)

| ID | Finding (one-line) | v3 status | Notes |
|---|---|---|---|
| EDGE-P1-001 | Idempotency not concurrency-safe / keys not endpoint-scoped | **PARTIALLY FIXED** | D1-backed `op_idempotency_keys` with `ON CONFLICT DO NOTHING` (since v2) is concurrency-safe; ⟶ refund path now *requires* the key; endpoint-scoping still absent (same key reusable across payments/refunds with different bodies → hash mismatch → 409; safe but crude). |
| EDGE-P1-002 | Mobile pairing OTP brute-forceable | **FIXED ⟶** | `perIpRateLimit('otp')` mounted on pair* + devices (10/hr/IP). Residuals: KV race, no per-token counter, no lockout. §12.11 |
| EDGE-P1-003 | Inbound webhook: no body cap / non-deterministic event ids / fail-open geo | **PARTIALLY FIXED ⟶** | Body cap: global 128 KB (header-only — V3-005). Event ids: `payload.id ?? payload.event_id ?? randomUUID()` — deterministic when the gateway sends an id, random (no dedup) when it doesn't. Geo: demoted to Layer-2 fallback behind data-driven IP allowlists, with signature verification ALWAYS on top — the fail-open concern is now bounded by Layer 3. |
| EDGE-P1-004 | Outbound webhook SSRF (IPv6/mapped/integer/redirect bypasses) | **FIXED ⟶** | url-guard + dual enforcement + `redirect:'error'` + 15s timeout; 4 string-level residuals, platform-mitigated. §12.6 |
| EDGE-P1-005 | Any merchant admin key enumerates/provisions tenants & harvests root keys | **FIXED ⟶** | Platform gate + claim token. §12.3 |
| EDGE-P1-006 | Unguarded status writes; completed payments can regress; reconciliation never heals payment rows | **PARTIALLY FIXED** | Regression guard in callback/fail paths held; reconciliation still heals only `op_ledger_postings`, not payment/transaction rows. Unchanged files. |
| EDGE-P1-007 | `createIntent` not atomic; auto-seeds manual gateway under race | **NOT FIXED** | `payment.ts:89–117` — the seed-then-select sequence is unchanged (no UNIQUE on `(merchant_id, slug)`; concurrent first-payments can double-seed). |
| EDGE-P1-008 | Read-scoped keys can mutate (payments, webhook config) | **FIXED ⟶** | Method-based write-scope middleware. §12.4 |
| EDGE-P1-009 | Security regression tests broken (tenant-routing suite crashes; lint cannot run) | **FIXED (held ⟶)** | 218/218 incl. tenant-routing; lint pipeline functional. §5 |
| EDGE-P1-010 | KV rate limiting racy; install misconfigured (120/min vs 3/hour docs); anonymous surfaces unthrottled | **PARTIALLY FIXED ⟶** | Anonymous surfaces now throttled (password/otp/checkout/install groups); authenticated routes use native Ratelimit bindings (now actually configured in wrangler ⟶); bootstrap-key tightened to 10/hr. Residual: KV read-modify-write race; `/install*` group still 120/min; per-path keying. |

## 19. P2 ledger (20 findings)

| ID | Finding (one-line) | v3 status | Notes |
|---|---|---|---|
| EDGE-P2-001 | CSRF middleware is dead code (never mounted) | **NOT FIXED** | `csrf.ts` unchanged, still referenced nowhere (only `csrfToken` in the AppVariables interface). |
| EDGE-P2-002 | DO fault-injection seam behind magic env combination | **NOT FIXED** | `ledger-do.ts` `this.faults` seam unchanged (test affordance; low risk). |
| EDGE-P2-003 | Platform merchant excluded from consistency verification | **NOT FIXED** | No `is_platform` handling in `ledger.ts` verify paths. |
| EDGE-P2-004 | Webhook merchant resolution on master domain binds to platform merchant | **NOT FIXED** | `webhooks.ts` fallback resolution `ORDER BY m.is_platform DESC` — platform-preferred binding unchanged (by design, but undisclosed). |
| EDGE-P2-005 | Ratelimit binding absence fails open | **PARTIALLY FIXED ⟶** | Bindings `RATE_LIMIT_READ/WRITE` now present in `wrangler.jsonc` (120/60s, 30/60s); code still fails open (with metric) if the binding is removed. |
| EDGE-P2-006 | Analytics Engine commented out — all metrics silent no-ops | **NOT FIXED** | `analytics_engine_datasets` still commented in `wrangler.jsonc`. **Blocks the rate-limit degradation alarm.** |
| EDGE-P2-007 | No outbox: crash between D1 commit and queue send loses the webhook | **NOT FIXED** | `webhook-dispatcher.ts` still DB-then-`sendBatch` with no outbox row. |
| EDGE-P2-008 | D1 mirror dedup drops legitimate identical journal lines | **NOT FIXED** | `ledger-do.ts` tx_id dedup semantics unchanged. |
| EDGE-P2-009 | Wrong/rotated ENCRYPTION_KEY degrades silently | **NOT FIXED** | `decrypt()` catch-and-skip pattern everywhere (refund credential loader, callback loader, webhook inbound loader). |
| EDGE-P2-010 | Single versionless ENCRYPTION_KEY; no rotation path | **NOT FIXED** | No key versioning anywhere; **now the direct blocker for the mandatory P0-001 rotation**. |
| EDGE-P2-011 | Break-glass comparison not timing-safe; JWKS fetch no timeout | **NOT FIXED** | `cloudflare-access.ts` unchanged (5-min JWKS module cache; no AbortController on fetch). |
| EDGE-P2-012 | LedgerDO does not verify payload.merchant_id vs its own identity | **NOT FIXED** | DOs cannot read their name; caller-side discipline is the only guard (all callers go through `getLedgerDO(env, merchantId)`). Architectural note — the four-worker split makes this a *core-internal* invariant instead. |
| EDGE-P2-013 | `op_api_keys.key_prefix` lacks UNIQUE constraint | **NOT FIXED** | Migration 0001 still has `CREATE INDEX` (not UNIQUE) on `key_prefix`; hash check after prefix lookup mitigates exploitation, collision handling is undefined (LIMIT 1). |
| EDGE-P2-014 | Unbounded/unchecked inputs on public surfaces | **PARTIALLY FIXED ⟶** | Global 128 KB cap (header-only) + money schema bounds + zod on the two money routes; hand-rolled bodies (install, sendTest, checkout verify) remain shape-unvalidated. |
| EDGE-P2-015 | SMS regex templates merchant-editable, compiled with `new RegExp` (ReDoS) | **NOT FIXED** | `sms-parser.ts:183` — `new RegExp(tpl.regex_pattern, 'i')` unchanged; admin PUT `/sms-templates` accepts arbitrary patterns. |
| EDGE-P2-016 | `ENABLED_GATEWAYS` unset ⇒ every adapter enabled (fail-open) | **NOT FIXED** | `enabled.ts` — blank/unset returns all implemented slugs, `allEnabled: true`. |
| EDGE-P2-017 | PBKDF2 default 50K vs documented 600K; env can lower to 10K | **NOT FIXED** | `crypto.ts` — `PBKDF2_ITERATIONS = 50_000`, `_MIN = 10_000`; docs still cite 600K. |
| EDGE-P2-018 | No payment-amount ceiling at API boundary | **FIXED ⟶** | `moneySchema.refine(0 < n ≤ 1_000_000_000)`. §12.10 |
| EDGE-P2-019 | Currency minor-unit exponents ignored | **NOT FIXED** | No exponent handling anywhere (all money as 2-dp strings). |
| EDGE-P2-020 | Exchange rates fetched/stored without validation; no timeout | **NOT FIXED** | `cron/handler.ts` hourly open-ER fetch → direct INSERT; unchanged. |

## 20. P3 ledger (12 findings)

| ID | Finding (one-line) | v3 status | Notes |
|---|---|---|---|
| EDGE-P3-001 | Dead schema states | **NOT FIXED** | Cosmetic; unchanged. |
| EDGE-P3-002 | Mobile `authSubject`/`device_id` identity confusion | **NOT FIXED** | `requireJwtAuth` sets `authSubject = user id` (`sub`); heartbeat/notifications use it as `device_id` (`mobile.ts:126–129`, 235–243) — cross-device misupdates persist. |
| EDGE-P3-003 | Mobile notification ack cross-tenant | **NOT FIXED — FALSE "FIXED" CLAIM ⟶** | The claimed predicate is absent; file unchanged v2→v3. §3 |
| EDGE-P3-004 | Pairing flow race + `last_insert_rowid` misuse | **NOT FIXED** | `mobile.ts:27–65` — OTP use-marking is SELECT-then-UPDATE without `AND used_at IS NULL` (two concurrent pairs both succeed); `SELECT last_insert_rowid()` as a separate statement can mis-attribute under interleaving. |
| EDGE-P3-005 | Maintenance reason interpolated unescaped into HTML | **NOT FIXED** | `maintenance.ts:79` — `<p>${info.reason}</p>` unchanged. |
| EDGE-P3-006 | sms-phone-mockup `/api/forward` unauthenticated open proxy | **NOT FIXED** | `server.js:519` — unrestricted `fetch(targetUrl, …)`; ships in the artifact. |
| EDGE-P3-007 | `secretToBytes` base64 heuristic | **NOT FIXED** | Unchanged heuristic in jwt/crypto helpers. |
| EDGE-P3-008 | `op_webhook_deliveries.payload_hash` stores literal placeholder | **NOT FIXED (variant)** | Inbound signature-rejected rows now store `''` instead of `'system'` — still no actual payload hash. Cosmetic drift persists. |
| EDGE-P3-009 | Outbound webhook retry treats 4xx as retryable | **FIXED ⟶ (side effect)** | Consumer acks 4xx permanently, retries 5xx with 60/300/1800s backoff. §12.6 |
| EDGE-P3-010 | Duplicate-instance detection by error-string matching | **NOT FIXED** | Refund routes still branch on `message.includes('not found')` (admin-api.ts:219, api.ts error mapping). |
| EDGE-P3-011 | SMS consumer writes parsed fields before parse-miss branch | **PARTIALLY FIXED** | Sequence unchanged (write-then-correct), but the miss branch now overwrites `match_status='no_match'` immediately — end state consistent; transient inconsistent write persists. |
| EDGE-P3-012 | Docs/report drift (TEST_RESULTS.md stale counts) | **NOT FIXED (worse)** | TEST_RESULTS.md still says "11 files / 104 tests / v0.2.3" vs actual 22/218/v0.3.0. |

## 21. NEW ledger (12 findings from v0.3.0, report 3)

| ID | Finding (one-line) | v3 status | Notes |
|---|---|---|---|
| NEW-P1-001 | Plaintext platform-root key in KV | **FIXED ⟶** | §12.2 |
| NEW-P1-002 | Credential endpoints shipped with dead rate-limit config | **FIXED ⟶** | §12.11 |
| NEW-P2-001 | Refund cumulative bound raceable (TOCTOU) | **FIXED ⟶** (residual V3-003) | §12.8 |
| NEW-P2-002 | Float arithmetic in money-bound checks | **FIXED ⟶ (callback path)** | `cmp()` in handleCallback; refund SQL still float-tolerant (±0.001 in CAST NUMERIC). |
| NEW-P2-003 | Amount check silently skipped when adapter returns no amount | **FIXED ⟶** | §12.9 |
| NEW-P2-004 | Root-key harvesting preserved in provisioning response | **FIXED ⟶** | §12.3 |
| NEW-P2-005 | Checkout verify endpoints unthrottled TrxID oracles | **FIXED ⟶** | §12.12 |
| NEW-P2-006 | handleCallback intent lookup not merchant-bound at DB layer | **NOT FIXED** | `WHERE pi.id = ?` unchanged; token-mediated access mitigates. |
| NEW-P3-001 | Dead call in corroboration gateway resolution | **FIXED ⟶** | §12.13 |
| NEW-P3-002 | ESLint 9 flat-config migration incomplete | **FIXED ⟶** | §12.14 |
| NEW-P3-003 | Comment/code drift in three hot spots | **NOT FIXED** | v0.2.x-era comments persist in v0.3.0 files (cosmetic). |
| NEW-P3-004 | moneySchema permits arbitrarily large magnitudes | **FIXED ⟶** | §12.10 |

## 22. Movement analysis (v2 → v3)

| Movement | Count | Findings |
|---|---|---|
| NOT/PARTIAL → **FIXED** | 17 | EDGE-P1-002, P1-004, P1-005, P1-008, P2-018, P3-009, NEW-P1-001, NEW-P1-002, NEW-P2-001, NEW-P2-002, NEW-P2-003, NEW-P2-004, NEW-P2-005, NEW-P3-001, NEW-P3-002, NEW-P3-004, + P0-005's KV-key component |
| Partial → **(still) PARTIAL, improved** | 5 | EDGE-P0-001 (scripts), P1-003 (cap), P1-010 (mounts+bindings), P2-005 (bindings), P2-014 (cap+schemas) |
| Unchanged verdicts | 38 | everything in files untouched by the diff |
| Regressed | 0 | — |
| **Totals** | 61 | **22 FIXED / 9 PARTIAL / 30 NOT FIXED** (+1 of the "FIXED" claims false ⇒ effective 21 genuinely fixed by this release) |

The remediation release moved the ledger from 10.2% fixed to 36.1% fixed in one surgical pass, with zero regressions, at the cost of 11 new findings (next part) — 4 of which are disclosure/process gaps rather than code defects.

---
# PART VI — FRESH AUDIT OF THE REMEDIATED CODE (NEW FINDINGS)

This part audits the *new* code as code — not as claims. Eleven findings; severity calibrated to the same scale as the prior reports. Four are defects of the new fixes themselves, four are undisclosed design trade-offs the new flows introduce, three are process/hygiene findings surfaced by this release's own standards.

## 23. V3-001 … V3-011

### V3-001 — False remediation claim: P3-003 "FIXED" with no code change (P2, process/integrity)

**Where:** the supplied remediation summary row 5 vs `src/controllers/mobile.ts` (unchanged).
**What:** the summary asserts an `AND merchant_id = ?` predicate was added to the notification-ack UPDATE; the shipped UPDATE is unscoped and the file is byte-identical to the version report 3 audited. No test in the 218-test suite covers tenant scoping of this statement.
**Why it matters more than the P3 itself:** a remediation ledger is the operator's control plane for production-readiness decisions. One undetected false FIXED means every other row's "FIXED" now requires independent verification (which this report performed — 13/15 held). The failure mode is systemic: claims were evidently authored from intent, not from the artifact.
**Fix:** (1) add the predicate `AND merchant_id = ? AND device_id = ?` (bind both from the JWT context) — one line; (2) add a regression test that pairs two merchants' devices and asserts cross-tenant acks affect zero rows; (3) adopt the process rule in §52 item 2: every remediation claim must cite a diff hunk and a test id in the same artifact that ships.

### V3-002 — `sendTest` persists unvalidated webhook URLs, bypassing the registration-time SSRF guard (P2)

**Where:** `api.ts:375–383` (`POST /api/v1/webhooks/tests`) → `webhook-dispatcher.ts:105–128`.
**What:** the route accepts `body.url` and passes it to `sendTest()`. When the merchant has **no** registered webhook, `sendTest` INSERTs the caller-supplied URL directly into `op_webhooks` (auto-subscribed to `['*']` events) — **without** the `isAllowedWebhookUrl` check that `POST /api/v1/webhooks` applies to the same operation.
**Current mitigation:** the v3 queue consumer re-checks every delivery URL through the guard, so the actual outbound fetch of a private target is blocked in production. The residual is the broken invariant — "every stored webhook URL passed the guard" — plus the persisted unvalidated row, plus the `ENVIRONMENT !== 'production'` localhost carve-out at delivery time.
**Fix:** validate `targetUrl` with `isAllowedWebhookUrl` (same dev carve-out) before the INSERT; or refuse `targetUrl` entirely and require pre-registration.

### V3-003 — Refund ghost-call ordering: the gateway refund fires before the atomic DB bound check (P2, financial)

**Where:** `refund.ts:103–125` (gateway call) before `refund.ts:129–161` (atomic INSERT).
**What:** under the exact race NEW-P2-001 was filed for, both requests pass the fast-fail pre-read, **both call `adapter.refund()` at the gateway**, and then only one wins the atomic INSERT. The loser throws `REFUND_REJECTED` to its caller — but real money has already moved at the gateway with no `op_refunds` row to reconcile it against. The reconciliation sweep will eventually surface a gateway-side refund with no DB counterpart, but that is hours of exposure and a manual triage path.
**Fix options (pick one):** (a) reserve-then-call — insert a `'reserving'` row first (atomic bound check), call the gateway, then flip to `'pending'`; sweep cancels stale reservations; (b) pass a client-side idempotency key (the refund's public id) to gateways that support it (Stripe et al.) so the loser's call is a no-op; (c) serialize per-transaction refunds through a DO gate. Option (a) is fully in-repo and consistent with the existing posting-protocol pattern.

### V3-004 — Claim-token flow stores full credential sets in plaintext KV for 15 minutes (P3, disclosed trade-off)

**Where:** `admin-api.ts:406–419` (KV `claim:{token}` → `{initial_password, api_key, pairing_otp, webhook_secret}`, TTL 900).
**What:** the harvesting fix moved credentials from an API *response* (visible to any admin-scoped caller) into KV (visible only to the creating platform admin + anyone with KV read). This is a strict improvement. The residual: KV is not application-encrypted; the window is 15 minutes; single-use delete happens at claim time (not at read-after-expiry, which KV TTL handles).
**Fix (optional hardening):** encrypt the claim blob with `ENCRYPTION_KEY` before `KV.put` (decrypt at claim); or move claim staging to a D1 table with a hash of the token and a `claimed_at` column.

### V3-005 — The 128 KB payload ceiling inspects only the Content-Length header (P2)

**Where:** `index.ts:184–194`.
**What:** `cl && parseInt(cl, 10) > 128*1024` — a chunked request (no Content-Length) passes to `c.req.json()`/`text()` unbounded. Workers' edge normalizes typical client traffic (adds/validates Content-Length) and D1 rejects >1 MB statements, so the practical blast radius is CPU burn, not memory exhaustion — but the guard is advertised as a ceiling and is not one for all inputs.
**Fix:** for JSON routes, read the body through a bounded reader (e.g. slice at 128 KB + 1 and reject), or require Content-Length on POST/PUT/PATCH (411 when absent) at the same middleware — the stricter variant, fully compatible with the existing clients.

### V3-006 — Anonymous rate-limit counters are per-IP **and per-path**, diluting token-parameterized limits; KV race persists (P3)

**Where:** `rate-limit.ts:111` — `key = ${prefix}${clientIp}:${c.req.path}`; read-check-write on KV (lines 113–146).
**What:** (a) each distinct checkout token gets its own 30/10min budget — an attacker cycling tokens (or just hitting many victims' checkouts) multiplies their allowance by the number of tokens they can name; (b) KV's eventual consistency means a concurrent burst from one IP all read `count=0` and pass — the exact race EDGE-P1-010 filed, now carrying the OTP/checkout limits too.
**Fix:** (a) key on `prefix + IP + route-class` (strip path parameters — Hono gives you `c.routePath`); (b) migrate the anonymous counters to the native Ratelimit binding (same primitive already used per-key) — one binding, `key: ip:class`, and the race disappears because the counter is atomic at the edge.

### V3-007 — `ENVIRONMENT !== 'production'` gates inside the SSRF guard and claim/dev carve-outs (P3, foot-gun family)

**Where:** `url-guard.ts:37` (consumer), `api.ts:337` (registration), both via `c.env.ENVIRONMENT !== 'production'`.
**What:** a deployment that mislabels its environment (a copy-pasted `wrangler.dev.jsonc` deploy with `ENVIRONMENT=development`) silently re-enables plain-HTTP localhost webhook delivery and any other dev carve-outs — on the internet.
**Fix:** derive the carve-out from an explicit opt-in var (`ALLOW_LOCAL_WEBHOOK_TARGETS=1`) instead of an environment-name inference; log a loud one-time warning when it is active.

### V3-008 — Auto-bootstrap on first request can lock a fresh deployment's operator out (P3, carried, now more visible)

**Where:** `index.ts:83–108` → `bootstrap.ts` → `KV.put('system:bootstrapped'/'installed')`.
**What:** on a fresh deployment, the first *non-install* request triggers auto-bootstrap, which provisions the platform merchant, an admin with a **random** password (production), a random root API key (never surfaced — the promise is `waitUntil`-ed and discarded), and then sets the KV installed flags — after which `POST /install` answers `ALREADY_INSTALLED`. The install wizard is thereby permanently bypassed and the operator has no path to credentials (bootstrap-key requires the password they never received).
**Fix:** make auto-bootstrap *not* set `system:installed` (only `bootstrapped`), or surface the generated credentials through a first-run claim-token flow exactly like merchant provisioning (v3 already built that machinery — reuse it), or gate auto-bootstrap behind an explicit `AUTO_BOOTSTRAP=1` var.

### V3-009 — Security-critical new middleware typed as `any` (P3, hygiene)

**Where:** `admin-api.ts:247` — `async function requirePlatformAdmin(c: any, next: any)`; `api.ts:29` — `(requireScope('write') as any)(c, next)`.
**What:** the two middlewares this release added for authorization enforcement are exactly where the 42 lint warnings concentrate. `any` on the context object means a typo'd `c.get('merchantId')` compiles silently — the class of bug that produced the original P1-005.
**Fix:** type them with the app's `Context<{ Bindings: Env; Variables: … }>` (the codebase already exports `AppVariables`); drops the warning count and the bug class.

### V3-010 — Claim endpoint is redeemable by any admin-scoped key (P3)

**Where:** `admin-api.ts:271` — `POST /merchants/claim` under the group's `requireBearerApiAuth(['admin'])` but without `requirePlatformAdmin`.
**What:** token entropy (≈142 bits) makes brute force moot; but the natural security posture is "the actor who created the claim (platform) or the new merchant's own first-party flow redeems it." As shipped, any merchant's admin key that somehow learns a token can redeem it.
**Fix:** mount `requirePlatformAdmin` on the claim route too (the creating admin hands credentials out-of-band), or implement the (better) email-delivered claim link flow.

### V3-011 — The remediation release's own documentation claim set has no machine-checkable anchor (P3, process)

**Where:** the remediation summary itself (no `REMEDIATIONS.md`, no machine-readable diff references, no test ids).
**What:** 13 of 15 rows were verifiable only because this auditor re-derived them from the code. Nothing in the artifact ties claim rows to hunks/tests — the same gap that let V3-001 happen.
**Fix:** ship `docs/REMEDIATIONS.md` in the repo with one row per finding: `{id, status, files, hunks, test ids}`; CI fails if a "FIXED" row's test is missing or skipped. This is the cheapest control in the whole report.

## 24. The remediation-integrity finding (synthesis)

Pattern across V3-001, V3-011, and the undisclosed residuals in §12: **the release's engineering is materially better than its reporting.** The code diff is honest, surgical, and test-backed; the *summary* overclaims (P3-003), under-discloses (P0-001's unrotated keys, sendTest, KV claim storage, header-only cap, per-path limiters), and carries no artifact-verifiable anchors.

For a payments platform the reporting layer is not decoration: it is what determines whether an operator ships. The single most valuable next process step is not another code fix — it is making claims checkable by construction (V3-011's `REMEDIATIONS.md` + CI gate, §52 item 2). After that, the honest fix-list is short: rotate the keys, add the predicate, enable Analytics, harden the cap, validate sendTest.

---
# PART VII — CURRENT ARCHITECTURE (VERIFIED, AS-BUILT)

## 25. Single-worker reality and complete binding inventory

The repository is still **one Worker** (`edgepay-cf`). No Service Bindings, no multi-Worker topology, no Worker RPC exists anywhere in `wrangler.jsonc`, `wrangler.dev.jsonc`, `wrangler.staging.jsonc`, or `src/`. The four-worker topology remains documentation-aspiration (README/docs), exactly as report 3 reconstructed. What changed in v3 is *within* the monolith: two new Ratelimit bindings are now actually configured.

Complete verified binding inventory (production `wrangler.jsonc`):

| Binding | Type | Name(s) | Purpose | v3 change |
|---|---|---|---|---|
| Database | D1 | `DB` | relational store: merchants, keys, intents, transactions, refunds, webhooks, deliveries, SMS data/templates, idempotency, postings-mirror, exchange rates | unchanged |
| KV namespace | KV | `KV` | domain cache, install/bootstrapped flags, maintenance flag, claim tokens, rate-limit counters (anonymous), token caches | ⟶ claim:{token} added; root-key removed |
| R2 bucket | R2 | `R2` | uploads/exports/backups | unchanged |
| Queues (producers) | Queue | `WEBHOOK_QUEUE`, `EMAIL_QUEUE`, `SMS_QUEUE` | outbound webhooks, email, SMS parse | unchanged |
| Queues (consumers) | Queue | `webhook-out` (max_retries 3, DLQ), `email-out`, `sms-parse` | delivery/parsing workers of the same Worker | unchanged |
| Durable Object | DO (SQLite) | `LEDGER_DO` → `LedgerDO` | per-tenant double-entry ledger, single-writer, posting protocol, tx_id dedup, D1 mirror | unchanged |
| Workflows | Workflow | `REFUND_WORKFLOW`, `SWEEP_WORKFLOW` | refund reconciliation (instance-per-refund), daily sweep | unchanged |
| Ratelimit (native) | Ratelimit | `RATE_LIMIT_READ` (120/60s), `RATE_LIMIT_WRITE` (30/60s) | per-API-key limits on authenticated routes | **⟶ NEW: actually configured** |
| Static assets | Assets | `ASSETS` (`run_worker_first: true`) | checkout CSS/JS | unchanged |
| Analytics Engine | AE | *(none — commented out)* | metrics | **still disabled** |
| Workers AI | AI | *(commented out)* | SMS parser fallback | still opt-in |
| Cron | Trigger | `* * * *`-family (hourly/daily) | exchange rates, domain re-verify, sweeps | unchanged |

## 26. Trust boundaries as implemented

Verified mid-stack (all within one Worker process — every "boundary" below is a middleware, not a network/capability boundary):

```text
Internet
  │  (Cloudflare edge: WAF/TLS/CDN; per-IP edge rate rules recommended in comments only)
  ▼
[requestId → logger → auto-bootstrap → domain → maintenance → prettyJSON(dev) → secureHeaders → CORS(allowlist) → payload cap(128KB, header) → per-IP limits(password/otp/checkout/install) → route mounts]
  │
  ├─ /install/*            installRoutes          (KV installed-flag gate; password-limited bootstrap-key)
  ├─ /api/v1/*             apiRoutes              (bearer auth → method write-scope → per-key native RL → zod → idempotency)
  ├─ /api/mobile/v1/*      mobileRoutes            (otp-limited pairing → JWT; authSubject = user id)
  ├─ /api/admin/v1/*       adminApiRoutes          (Access JWT gate → bearer admin scope → per-key RL → platform gate on tenants)
  ├─ /checkout|invoice|pay checkoutRoutes          (token-gated public HTML+JSON; CSP; checkout-limited verify/submit)
  ├─ /webhook/:slug        webhookRoutes           (allowlist/geo → signature → event dedup → handleCallback)
  └─ /api (reference)      apiReferenceRoutes      (OpenAPI + Scalar, own CSP)
        │
        ▼
  services (payment, refund, ledger, reconciliation, bootstrap, dispatcher, corroboration)
        │
        ▼
  bindings: D1 (SQL, incl. atomic refund INSERT) · KV · R2 · LEDGER_DO (posting protocol) · Queues · Workflows
```

The v3 hardening added exactly three enforcement layers to this stack (method write-scope, payload cap, anonymous per-IP limits) and two data-layer invariants (hash-only root key, atomic refund bound). Everything still shares one process, one set of bindings, and one deploy — the property the split in Part VIII removes.

## 27. Route inventory (52 routes across 7 controllers)

Verified by static extraction (`Routes.(get|post|put|patch|delete)`):

| Controller | Mount(s) | Routes | Auth |
|---|---|---|---|
| api.ts (14) | `/api/v1` | GET health (in index.ts); POST payments; GET payments/:id; GET transactions; GET transactions/:trx_id; POST refunds; GET customers; GET api-keys; POST api-keys; GET webhooks; POST webhooks; DELETE webhooks/:id; POST webhooks/tests; GET webhooks/deliveries; GET gateways | bearer (+write on mutations; +admin on api-keys; idempotency on payments/refunds) |
| admin-api.ts (13) | `/api/admin/v1` | POST domains/verifications; GET/PUT sms-templates; GET devices; DELETE devices/:id; GET sms-queues; POST sms-queues/:id/retries; POST refunds; POST reconcile; GET ledger/trial-balance; GET merchants; POST merchants; POST merchants/claim | Access + bearer admin (+platform gate on merchants) |
| mobile.ts (11) | `/api/mobile/v1` | POST devices; POST pair; POST devices/token-refreshes; POST refresh; POST devices/heartbeats; POST heartbeat; GET dashboard; POST sms; POST sms/batch; GET notifications; POST notifications/acknowledgements | otp-limited pairing; JWT after |
| checkout.ts (6×3 mounts) | `/checkout`, `/invoice`, `/pay` | GET :token; POST :token/initiate; POST :token/verify; POST :token/submit-trx; GET :token/callback; GET :token/status | random 64-hex token |
| install.ts (3) | `/install` | GET /; POST /; POST /bootstrap-key | KV installed-flag; password-limited |
| webhooks.ts (1) | `/webhook` | POST :slug | allowlist/geo + HMAC signature |
| api-reference.ts (2) | `/api` | GET openapi.json; GET reference | public |

## 28. Data-plane topology (verified behaviors)

- **D1**: all tenant data; `DECIMAL`/JSON as TEXT; atomic refund INSERT; idempotency via UNIQUE + `ON CONFLICT DO NOTHING`; D1 `batch()` for tx+intent completion; postings-mirror rows for recovery.
- **LedgerDO** (per `idFromName('merchant-{id}')`): write-ahead `op_ledger_postings` (pending→posted), tx_id dedup registry, balance guards, D1 mirror with heal path; fault-injection seam for tests.
- **KV**: domain resolution cache (both `domain:`/`domain-v2:` prefixes, invalidated by admin), install/bootstrapped flags, maintenance flag, ⟶ claim tokens (15-min TTL), anonymous rate counters, gateway token caches.
- **Queues**: webhook-out (consumer applies url-guard + `redirect:'error'` + 4xx-ack + 60/300/1800 backoff), email-out, sms-parse (regex→AI parse → corroboration → complete).
- **Workflows**: refund-reconciliation (instance per refund id, poll→post reversal→dispatch→flip), reconciliation-sweep (pending replay, heal, refund re-drive).
- **Ratelimit bindings**: per-key read/write ceilings, fail-open with (silent) metric.

---

# PART VIII — THE MULTI-WORKER FRONTEND SYSTEM (UPDATED IMPLEMENTATION BLUEPRINT)

This part is the direct answer to "how we should implement the multi-worker frontend system," updated against the *verified* v0.3.0 state. Report 3 §13 designed this against v2; v3's verified defects (V3-001 false claim, V3-002 unvalidated persistence, EDGE-P2-006 silent telemetry, V3-005 header-shaped guard) *strengthen* the case and are cited as evidence per decision.

## 29. Design goals (re-validated against v3's verified defects)

```text
G1  Blast-radius isolation: a compromised public frontend must not hold
    data-plane credentials.
      v3 evidence: the artifact that reaches deployers (the zip) still ships
      .dev.vars with ENCRYPTION_KEY/JWT_SECRET (EDGE-P0-001). In the split,
      the *customer* worker's artifact contains none of these — the blast
      radius of "the artifact leaked" becomes one surface, not the platform.

G2  Privilege minimization per surface: customer worker = zero merchant
    secrets; merchant worker = no platform powers.
      v3 evidence: EDGE-P1-005's fix required a bespoke requirePlatformAdmin
      middleware — and it shipped typed as `any` (V3-009), i.e. the exact
      bug-class it defends against. Positional privilege is fragile; a
      worker without the binding cannot express the power at all.

G3  Keep the proven core: LedgerDO posting protocol, refund workflow,
    reconciliation move as-is into edgepay-core.
      v3 evidence: these files are byte-identical v2→v3 (§10) — they are the
      stable, best-tested code in the repo (ledger-do, ledger-consistency,
    payment-integrity, workflow-policy suites). Do not rewrite them; move
    them.

G4  One REST contract for customers/merchants; typed RPC for everything else.
      v3 evidence: 52 routes on one origin (§27) — of which only ~11 are
      genuinely customer/merchant-facing (Part IX). The rest are internal
      or admin surfaces paying public-route risk (e.g. V3-010's claim
      endpoint reachable by any admin key).

G5  Independent deployability: checkout UI deploys without touching ledger.
      v3 evidence: this release itself demonstrates the monolith cost —
      to mount five rate-limit lines, the whole Worker (ledger included)
      redeployed.

G6  No cross-worker trust by position: every RPC method re-establishes
    identity + tenant server-side.
      v3 evidence: the P3-003 false claim (V3-001) shows tenant scoping is
      exactly the property that silently regresses. In the split, core
    re-derives merchant context from the *principal*, not from the
    caller's claims — one implementation, re-used by every method.
```

## 30. Target topology (four workers + core)

```text
                              ┌────────────────────────┐
                              │  Cloudflare Edge / WAF  │
                              │  per-hostname routes +  │
                              │  per-IP edge rate rules │
                              └───────────┬────────────┘
      pay.merchant.com                  api.edgepay.com            admin.edgepay.io
   checkout / invoice / pay          REST API (reduced,          Access-gated
   (customer HTML+JSON)              customer-facing only)        dashboard + provisioning
          │                                   │                            │
┌─────────▼──────────┐          ┌──────────────▼─────────────┐  ┌──────────▼───────────┐
│  edgepay-customer  │          │      edgepay-merchant      │  │    edgepay-admin     │
│  Bindings: NONE to │          │  Bindings: MERCHANT_RPC    │  │  Bindings: ADMIN_RPC │
│  data stores.      │          │  (service binding only)    │  │  (service binding)   │
│  CORE_RPC subset   │          │  no D1/KV/DO/queue creds   │  │  Cloudflare Access   │
└─────────┬──────────┘          └──────────────┬─────────────┘  └──────────┬───────────┘
          │                                    │                           │
          └──────────── service bindings ──────┴───────────────────────────┘
                                             ▼
              ┌──────────────────────────────────────────────────┐
              │                  edgepay-core                     │
              │  Bindings: DB (D1), KV, R2, LEDGER_DO,            │
              │  REFUND_WORKFLOW, SWEEP_WORKFLOW, WEBHOOK_QUEUE,  │
              │  EMAIL_QUEUE, SMS_QUEUE, RATE_LIMIT_*, AI, AE     │
              │  Public routes: /webhook/:slug (provider ingress),│
              │  /internal/* (binding-authed only)                │
              │  Exposes: RcpCore (Worker RPC, Part X)            │
              │  Contains: services/*, gateways/*, do/*, queues/* │
              └──────────────────────────────────────────────────┘
```

Property that matters: **only core holds data-plane bindings.** Each frontend holds exactly one service binding (its RPC surface) plus static assets. "The admin API is behind a middleware" becomes "the admin API is behind a *network* boundary, an Access policy, and a worker that has no database credentials to leak."

## 31. The RPC contract (the single inter-worker API)

One shared TypeScript package (`packages/core-rpc`) is the only inter-worker surface. Skeleton (updated from report 3 with v3-verified semantics — scopes, platform gating, claim flow):

```ts
export interface CallerContext {
  worker: 'customer' | 'merchant' | 'admin';   // asserted by core via per-worker HMAC (§44 D2)
  merchantId: number | null;                   // re-derived by core from subject — never trusted raw
  subject: number | null;                      // api_key row id / user id / (customer: null)
  scopes: string[];                            // informational only; core re-loads from D1
  requestId: string;                           // end-to-end tracing
  sig: string;                                 // HMAC-SHA256(workerSecret, canonical(ctx sans sig))
  interfaceVersion: number;
}

export interface CoreRpc {
  // ---- customer surface (token-bound; zero credentials) ----
  getCheckoutView(token: string): Promise<CheckoutView>;
  initiateGatewayPayment(token: string, gatewayId: number): Promise<InitiateResult>;
  submitTrxForVerification(token: string, trxId: string, senderPhone: string | null): Promise<VerifyStatus>;
  pollCheckoutStatus(token: string): Promise<{ status: string; trxId: string | null }>;
  handleGatewayCallback(token: string, params: Record<string, unknown>): Promise<{ ok: boolean; status: string }>;

  // ---- merchant surface (bearer-key principals) ----
  authorizeKey(apiKeyHashInput: string): Promise<{ subject: number; merchantId: number; scopes: string[] }>;
  createPayment(ctx: CallerContext, req: CreatePaymentRequest): Promise<PaymentIntentView>;   // idempotency reservation INSIDE core
  getPayment(ctx: CallerContext, intentId: string): Promise<PaymentIntentView>;
  listTransactions(ctx: CallerContext, page: PageQuery): Promise<TxPage>;
  createRefund(ctx: CallerContext, req: CreateRefundRequest): Promise<RefundView>;
  registerWebhook(ctx: CallerContext, url: string, events: string[]): Promise<WebhookView>;   // url-guard INSIDE core
  deleteWebhook(ctx: CallerContext, id: number): Promise<void>;
  sendTestWebhook(ctx: CallerContext, url?: string): Promise<void>;                            // V3-002: validated in core before persist
  listGateways(ctx: CallerContext): Promise<GatewayCatalogView>;

  // ---- admin/platform surface (Access + platform principal) ----
  listMerchants(ctx: CallerContext): Promise<MerchantPage>;                                   // is_platform enforced in core
  provisionMerchant(ctx: CallerContext, req: ProvisionRequest): Promise<{ merchantId: number; claimToken: string }>;
  redeemClaim(ctx: CallerContext, claimToken: string): Promise<ProvisionedCredentials>;       // V3-010: platform-principal only
  runReconciliation(ctx: CallerContext): Promise<ReconSummary>;
  getTrialBalance(ctx: CallerContext): Promise<TrialBalanceView>;

  // ---- health (binding-authed) ----
  ping(): Promise<{ ok: true; interfaceVersion: number; sha: string }>;
}
```

Design rule (G6): every method begins with `assertCaller(ctx)` → timing-safe HMAC verify → reload principal from D1 (`op_api_keys`/`op_merchant_users`) → scope check → `is_platform` where the method is platform-only → only then business logic. The frontends' own auth layers become *routing* concerns (which RPC subset a surface can call), not the security boundary.

## 32. wrangler decomposition (the actual configs)

```jsonc
// edgepay-core/wrangler.jsonc  (the only worker with data-plane bindings)
{
  "name": "edgepay-core",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "d1_databases":       [{ "binding": "DB", "database_name": "edgepay", "database_id": "…" }],
  "kv_namespaces":      [{ "binding": "KV", "id": "…" }],
  "r2_buckets":         [{ "binding": "R2", "bucket_name": "edgepay" }],
  "queues": { "producers": [{ "binding": "WEBHOOK_QUEUE", "queue": "webhook-out" }, /* … */],
              "consumers":  [{ "queue": "webhook-out", "max_retries": 3, "dead_letter_queue": "webhook-dlq" }] },
  "durable_objects":    { "bindings": [{ "name": "LEDGER_DO", "class_name": "LedgerDO" }] },
  "migrations":         [{ "tag": "v1", "new_sqlite_classes": ["LedgerDO"] }],
  "workflows":          [/* refund-reconciliation, reconciliation-sweep as today */],
  "ratelimits":         [/* RATE_LIMIT_READ/WRITE as today */],
  "analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "edgepay_metrics" }],  // ⟵ ENABLED (closes P2-006 at the same time)
  "routes": [ "webhook.edgepay.com/webhook/*" ]   // provider ingress only
}

// edgepay-customer/wrangler.jsonc
{
  "name": "edgepay-customer",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "services": [{ "binding": "CORE", "service": "edgepay-core", "environment": "production" }],
  "assets": { "directory": "./public/assets", "binding": "ASSETS", "run_worker_first": true },
  "routes": [ "pay.edgepay.com/checkout/*", "pay.edgepay.com/invoice/*", "pay.edgepay.com/pay/*",
              "pay.merchant-hostnames/*" ]
}

// edgepay-merchant/wrangler.jsonc
{
  "name": "edgepay-merchant",
  "services": [{ "binding": "CORE", "service": "edgepay-core" }],
  "routes": [ "api.edgepay.com/api/v*" ]
}

// edgepay-admin/wrangler.jsonc
{
  "name": "edgepay-admin",
  "services": [{ "binding": "CORE", "service": "edgepay-core" }],
  "routes": [ "admin.edgepay.com/*" ]
}
```

Note what disappears from the frontend configs: every data-plane binding. Note what `analytics_engine_datasets` being uncommented buys on day one: the P2-006 silent-metrics defect closes as a side effect of the split (Decision: enable AE in core while moving it).

## 33. File-level migration map (updated for v3's verified file set)

| Current location (v3) | Destination | Change during the move |
|---|---|---|
| `src/controllers/checkout.ts` (787 lines) | edgepay-customer | template becomes static assets + nonced inline; DB calls → `CORE` RPC; keep local escaping + CSP; strip `unsafe-inline` after nonce plumbing |
| `src/controllers/api.ts` (450) | edgepay-merchant | handlers become RPC calls; zod schemas stay client-side for fast 400s AND are re-validated in core (defense in depth); idempotency middleware deleted (core owns reservation) |
| `src/controllers/admin-api.ts` (440) | edgepay-admin | `requirePlatformAdmin` deleted (core's is_platform check); claim flow stays but `redeemClaim` RPC is platform-principal-only (V3-010) |
| `src/controllers/mobile.ts` (263) | edgepay-merchant (or its own worker later) | pairing/refresh → `CORE` RPC; **fix P3-002 while moving: carry `device_id` in the JWT and set `authSubject` correctly** |
| `src/controllers/install.ts` (288) | edgepay-admin (first-run route) | auto-bootstrap removed from customer/merchant paths; install lock moves to D1 (closes P0-005 residual + V3-008) |
| `src/controllers/webhooks.ts` | edgepay-core | unchanged location; stays provider ingress |
| `src/services/*` (payment, refund, ledger, reconciliation, bootstrap, dispatcher, corroboration) | edgepay-core | unchanged (G3) — plus: url-guard applied inside `sendTest` (V3-002), refund reserve-then-call (V3-003) |
| `src/do/ledger-do.ts`, `src/queues/*`, `src/workflows/*`, `src/gateways/*` | edgepay-core | unchanged |
| `src/lib/url-guard.ts` | core | also exported via core-rpc types for frontend pre-checks |
| `src/middleware/rate-limit.ts` | split | per-IP groups mount in each frontend's index; per-key native limits enforced in merchant worker + core backstop; **fix V3-006: key on route-class, migrate counters to the Ratelimit binding** |
| `src/middleware/{auth,csrf,idempotency,maintenance,security-headers,domain,cloudflare-access}` | split per consumer | csrf.ts: either mount it or delete it in the move (P2-001 finally decided); auth.ts's bearer verify moves to core (`authorizeKey`), frontends keep the envelope |
| `tests/*` | split | each worker keeps its unit suite; add cross-worker integration via miniflare service-binding wiring; add the tenant-scoping tests this release lacked (V3-001's lesson) |

## 34. Authentication design for the split (three options, one recommendation)

| Option | Mechanics | Verdict |
|---|---|---|
| **A. Frontends forward raw credentials; core verifies** (recommended) | merchant worker receives `Authorization: Bearer op_live_…`, calls `CORE.authorizeKey(...)` (or passes the header through the RPC ctx), core hashes + looks up + returns principal+scopes; every subsequent method re-derives tenant from the principal | No secrets persist in frontends; core remains the single verifier; per-key native limits live where the key is known (merchant worker) |
| B. Frontends verify locally (shared secret/derived read model) | merchant worker holds a read-only D1 replica or a KV key-hash cache | Violates G1/G2 (credentials in frontend), reintroduces the KV-consistency race class; rejected |
| C. mTLS-ish per-worker service tokens, user context in headers | frontends authenticate to core as *workers* (HMAC ctx), user context rides as signed claims | This is exactly A's `CallerContext.sig` — the options converge; A states it plainly |

Recommended = **A with the G6 HMAC ctx** (§44 D2): frontends never hold merchant secrets; core never trusts frontend assertions it didn't re-derive.

## 35. Carrying the v3 residuals into the split (fixes that ride along)

The migration is the cheapest moment in the project's life to close residuals whose fixes are structural:

| Residual | Closed during the split by |
|---|---|
| EDGE-P2-001 (csrf dead code) | decision forced: the merchant/customer REST surface is non-cookie (bearer/token), so csrf.ts is deleted, not mounted — documented in an ADR |
| EDGE-P2-006 (AE silent) | core enables `analytics_engine_datasets` in its wrangler (§32) |
| EDGE-P2-007 (no outbox) | core's dispatch moves to: insert outbox row in the same D1 batch as the completion update; a sweeper drains outbox → queue (reuses the posting-protocol shape the repo already proves) |
| EDGE-P2-012 (DO identity) | DO calls become core-internal; the caller-discipline invariant is now enforced by the compiler (frontends have no LEDGER_DO binding) |
| EDGE-P2-016 (ENABLED_GATEWAYS fail-open) | core's startup config asserts non-empty selection in production (fail-closed) |
| NEW-P2-006 (callback not merchant-bound at SQL) | `handleGatewayCallback(token, params)` re-resolves the intent *and* merchant inside core before completing |
| V3-002 (sendTest unvalidated persist) | `registerWebhook`/`sendTestWebhook` run url-guard inside core before any INSERT |
| V3-005 (header-only cap) | frontends mount a streamed cap (or 411-when-absent policy) as part of their new index.ts |
| V3-006 (per-path KV counters) | anonymous counters move to the Ratelimit binding keyed `ip:route-class` in each frontend |
| V3-008 (auto-bootstrap lockout) | bootstrap runs only in core's first-run path gated by a D1 lock; install wizard in admin worker |

## 36. Phased migration plan (zero-downtime, reversible at every phase)

```text
PHASE 0 — preflight (½ day)
  0.1 Execute the §52 hotfix list (rotation, P3-003 predicate + test, AE enable,
      sendTest guard, cap hardening). The split must not carry known-open P0s.
  0.2 Extract packages/core-rpc from the current interfaces (no behavior change);
      monolith temporarily implements CoreRpc and mounts it at /internal/rpc
      (binding-only route). All 218 tests stay green.

PHASE 1 — carve edgepay-customer (1–2 days)
  1.1 New worker: checkout template + assets + CSP/nonce; CORE_RPC subset.
  1.2 Route pay…/checkout|invoice|pay → edgepay-customer (Cloudflare routes).
  1.3 Monolith keeps /checkout as a shadow (rollback path) for one release.
  1.4 Verification: cross-worker integration test (miniflare service bindings),
      checkout E2E (create → render → verify → complete → ledger posted).

PHASE 2 — carve edgepay-merchant (2–3 days)
  2.1 authorizeKey + createPayment/getPayment/refunds/webhooks/gateways RPC.
  2.2 Idempotency reservation moves into core (D1 UNIQUE row = mutex, 30s lease).
  2.3 Route api.edgepay.com/api/v1* → edgepay-merchant.
  2.4 Public /api/v1 on the monolith origin 410s (route-level deprecation).
  2.5 Docs/OpenAPI regenerate against the reduced contract (Part IX).

PHASE 3 — carve edgepay-admin (1–2 days)
  3.1 Access-gated worker; merchants/claim/reconcile/trial-balance RPC.
  3.2 requirePlatformAdmin deleted (core-side is_platform). V3-010 closed.
  3.3 Install wizard relocates here with the D1 install lock.

PHASE 4 — core lockdown (½ day)
  4.1 Monolith's remaining public surface = /webhook/:slug only.
  4.2 Move routes to webhook.edgepay.com; delete the old hostname route.
  4.3 Enable AE; mount the outbox; flip anonymous limits to Ratelimit binding.
  4.4 Final: rename monolith repo → edgepay-core; archive templates.

Rollback: each phase is a route-level flip — revert the route, the monolith
still serves it (kept warm through Phase 3). No data migration at any phase
(D1/KV/DO bindings never move; only who binds them).
```

## 37. Failure modes of the split (and mitigations)

| Failure mode | Mitigation |
|---|---|
| Frontend deployed against newer/older core interface | `interfaceVersion` in every ctx; core rejects mismatch (fail-closed); dual-accept window during rollouts (§44 D7) |
| Core outage = all four surfaces down | Same blast radius as today's monolith outage (no regression); add core health ping (`/internal/health`, binding-authed) + synthetic checkout probe; the WAF serves static maintenance page (customer worker serves its assets without core for GET renders cached at edge) |
| RPC subrequest exhaustion (1,000/invocation paid tier) | One RPC per request in the common path (authorize folded into the business call's ctx); batch lists; no per-item RPC loops |
| Debugging across workers | `requestId` flows through ctx into core logs; both sides emit to the same AE dataset with worker tags |
| Cost doubling fear | RPC calls are subrequests, not billed requests; frontends' billed requests are the same requests the monolith served; only the provider-ingress stays on core |
| Do's vs worker version skew on LedgerDO | unchanged from today: DO class lives only in core; SQLite-class migrations remain core's concern |

---
# PART IX — API-SURFACE REDUCTION TO A CUSTOMER-FACING REST SYSTEM

## 38. Current surface (52 routes on one origin) — verified inventory and classification

From the verified §27 inventory, each route classified by *audience*:

| Class | Routes | Audience | Should be public REST? |
|---|---|---|---|
| Customer checkout | GET /checkout/:token · POST initiate · POST verify · POST submit-trx · GET callback · GET status (×3 mounts) | paying customers (token) | **YES — customer-facing REST/HTML** |
| Merchant REST | POST /api/v1/payments · GET payments/:id · GET transactions · GET transactions/:trx_id · POST refunds · GET customers · GET api-keys · POST api-keys · GET/POST/DELETE webhooks(+tests,deliveries) · GET gateways · GET health | merchants (bearer keys) | **YES — customer-facing REST** (customers of the platform = merchants) |
| Mobile companion | 11 routes under /api/mobile/v1 | merchant devices (JWT) | REST for the app, but **not a public contract** — version freely, it's a first-party app; keep as REST on the merchant surface or move later |
| Admin/operator | 13 routes under /api/admin/v1 | platform operators (Access) | **NO — internal; becomes admin worker + RPC** |
| Install | 3 routes under /install | first-run operator | **NO — internal (admin worker)** |
| Provider ingress | POST /webhook/:slug | payment gateways (HMAC) | **NO — stays public but on core's dedicated hostname (provider ingress, not customer REST)** |
| Reference | 2 routes (openapi.json, Scalar) | integrators | YES (public docs for the reduced contract) |

Reduction outcome: **52 routes → 17 public REST routes + 1 provider-ingress route** (plus app-docs). Everything else exits the public internet and becomes either an Access-gated admin UI over RPC or core-internal.

## 39. The reduced customer-facing REST contract (complete specification)

```text
BASE: https://api.edgepay.com/v1        (merchant REST — "customer" of the platform)
      https://pay.edgepay.com           (customer checkout — token-bound, HTML+JSON)

MERCHANT REST (bearer op_live_ keys; scopes read|write|admin):

  POST   /v1/payments            scope:write  idempotency:REQUIRED
         body: { amount: "10.50" (2dp, 0<n≤1e9), currency: "BDT",
                 description?, customer?{name,email,phone}, gateway_id?|gateway?,
                 metadata?, expires_in_seconds?(60..86400) }
         201 → { intent_id, token, checkout_url }   202-n/a
  GET    /v1/payments/{id}       scope:read   → intent view (tenant-scoped)
  GET    /v1/payments            scope:read   page: limit≤100, offset, status?
  POST   /v1/refunds             scope:write  idempotency:REQUIRED
         body: { transaction_id, amount?, reason?≤500 }
         202 → { refund_id, status:'pending', workflow_instance_id }
  GET    /v1/refunds/{id}        scope:read   (added — currently missing!)
  GET    /v1/transactions        scope:read   page
  GET    /v1/transactions/{trx}  scope:read
  GET    /v1/customers           scope:read   page
  GET    /v1/api-keys            scope:read
  POST   /v1/api-keys            scope:admin  { name, scopes }  → secret once
  GET    /v1/webhooks            scope:read
  POST   /v1/webhooks            scope:write  { url(public https), events }  → secret once
  DELETE /v1/webhooks/{id}       scope:write
  GET    /v1/webhooks/deliveries scope:read   page
  GET    /v1/gateways            scope:read   catalog for this deployment
  GET    /v1/health              public       liveness + versions

CROSS-CUTTING (all merchant REST):
  errors:  { success:false, error:{ code, message, issues? } } (unchanged envelope)
  headers: X-Request-Id, X-RateLimit-{Limit,Remaining,Reset}, Retry-After on 429
  limits:  per-key 120 read/min, 30 write/min (native binding)
  CORS:    explicit allowlist only (unchanged v0.2.2 policy)
  cap:     128 KB streamed (not header-only — V3-005 closed in the new surface)

CUSTOMER CHECKOUT (token in path; no credentials; HTML for humans, JSON for XHR):

  GET  /checkout/{token}                → HTML render (CSP, escaped)
  POST /checkout/{token}/initiate       → { redirect/params } 30/10min per IP
  POST /checkout/{token}/verify         → { status }            30/10min per IP
  POST /checkout/{token}/submit-trx     → alias of verify       30/10min per IP
  GET  /checkout/{token}/status         → JSON poll
  GET  /checkout/{token}/callback       → 302 (gateway return)

DELIBERATELY REMOVED FROM THE PUBLIC SURFACE:
  /api/admin/v1/*      → admin worker (Access) over ADMIN_RPC
  /install/*           → admin worker first-run
  /webhook/:slug       → core's provider-ingress hostname (HMAC'd, allowlisted)
  /api/mobile/v1/*     → stays REST during Phase 2 (first-party app; not a
                         public contract — document as "app API", version freely)
```

Two contract corrections this reduction makes possible: **`GET /v1/refunds/{id}` is added** (merchants currently cannot poll a refund they created — the 202 response is the last they see), and **`GET /v1/payments` list** is added for parity with transactions (both are core RPC one-liners once the split lands).

## 40. What moves to RPC, what moves to internal routes, what is deleted

| Current public route | Destination | Rationale |
|---|---|---|
| /api/admin/v1/merchants (+claim) | `ADMIN_RPC.listMerchants/provisionMerchant/redeemClaim` | platform power leaves the public internet entirely (P1-005, V3-010) |
| /api/admin/v1/refunds, /reconcile, /ledger/trial-balance | ADMIN_RPC equivalents | operator tooling |
| /api/admin/v1/sms-templates, /devices, /sms-queues, /domains/verifications | ADMIN_RPC | operator tooling |
| /install + bootstrap-key | admin worker first-run route (Access-gated) + D1 lock | kills the KV-lock + auto-bootstrap family (P0-005, V3-008) |
| /webhook/:slug | core route on `webhook.edgepay.com` | provider ingress ≠ customer surface; allowlist/geo/signature stay |
| /api/mobile/v1/* | merchant worker (same origin, /m/v1) initially | first-party app; candidate for its own worker only if the app grows |
| POST /webhooks/tests | `MERCHANT_RPC.sendTestWebhook` (core validates URL) | V3-002 |
| nothing deleted outright | — | the reduced surface is a *subset*; every route keeps serving through the transition |

## 41. Versioning, deprecation and migration policy

```text
1  The public merchant REST contract is /v1 — additive-only within v1
   (new optional fields, new endpoints). Breaking change ⇒ /v2 mounted
   beside /v1 with a 180-day overlap and a Sunset header.
2  Frontend workers are NOT versioned externally — they are deployment
   detail. Only the REST contract and the OpenAPI doc are contracts.
3  Deprecation protocol for the monolith surface during the split:
     Phase N:  new worker serves the route on the new hostname;
               monolith route answers with 200 + Deprecation + Link headers
               pointing at the new hostname (one release);
     Phase N+1: monolith route answers 410 Gone + Link (monitor 410 hits
               via AE — now that it works);
     Phase N+2: route deleted from the monolith.
4  OpenAPI doc regenerates from the reduced surface; the "EdgePay API.json"
   collector file at repo root is regenerated in the same CI step (kills
   the P3-012 drift class for the contract).
```

---

# PART X — CLOUDFLARE SERVICE BINDINGS & WORKER RPC (DETAILED EVALUATION)

## 42. Mechanism primer (2026 state, verified against this repo)

```text
Service Binding (service bindings in wrangler):
  an account-scoped, private reference from Worker A to Worker B.
  Properties verified against current docs and this repo's setup:
    - requests through the binding never traverse the public internet;
    - they are not billed as requests to B (they count as subrequests of A);
    - they cannot be reached by anyone who lacks the binding — there is no
      URL to guess; the capability IS the authorization to talk to B at all;
    - works on the free tier (this repo's deploy-button audience).

Worker RPC:
  the binding target can export a class (default export's rpc() or
  RpcTarget-extended objects) with typed methods. Callers do
  `env.CORE.someMethod(args)`:
    - arguments/results serialize via structured clone (near-native;
      no HTTP envelope, no status-code mapping);
    - thrown errors propagate as real Error objects across the boundary;
    - methods are discovered at type-check time via the shared package —
      a breaking interface change fails `tsc` in ALL FOUR repos at once,
      which is precisely the property the v3 process lacked (V3-001).
  Limits (current): 1,000 subrequests/invocation (paid; 50 free —
  irrelevant here: one-to-three RPC calls per request); args must be
  structured-cloneable; no streaming via RPC (use binding fetch()).
```

This repo's compatibility date (2026-08-28) and Hono/vitest stack need zero changes to consume Worker RPC; `@cloudflare/vitest-plugin` + miniflare already support multi-worker service-binding test wiring, so the 218-test culture extends across the boundary.

## 43. Six-option comparison (expanded with v3 evidence)

| Criterion | **A. Service Binding + Worker RPC** | B. Service Binding + fetch() | C. Inter-worker HTTP (public routes) | D. Keep monolith + tighten middleware | E. DO RPC as "the core" | F. Cloudflare API Gateway / routes layer |
|---|---|---|---|---|---|---|
| Network isolation | **Private, account-scoped; core unreachable from the internet except its two deliberate routes** | Same private path | Core must publish internet routes; trust = shared secrets/JWTs — the exact P0-001 exposure class | None — one process | Private, but wrong granularity | Public layer; complementary only |
| Latency (frontend→core) | **Sub-ms same-PoP hop; Smart Placement pins core near its D1** | +HTTP framing ≈1–3 ms | Full TLS+DNS round trip 5–50 ms | 0 (in-process) | Same as A | +1–3 ms |
| Type safety across the boundary | **Shared TS interface; tsc fails on skew in all repos** | None (hand envelopes) | None + REST design burden | Native imports (but no boundary) | Typed stubs; wrong axis | None |
| AuthZ boundary quality | **Binding = capability + per-method HMAC + principal reload (G6)** | Possible, easier to skip | Must invent request signing; replay risk | **Middleware only — the model that produced P1-005 and let V3-001's tenant-scope regression ship** | Awkward per-object authn | Coarse API-key layer |
| Cost | **RPC = subrequests, not billed requests; no egress** | Same | B's public routes are billed requests — doubles request cost | Cheapest | DO requests billed per call (ledger already pays this — correctly) | Paid product |
| Failure semantics | **Real exceptions cross the boundary; circuit breakers in-process** | Status-code mapping | Network failure classes + retry/idempotency burden | In-process throw | Input-gate serialization wrong for fan-out | Gateway-specific |
| Deploy independence | **Four deploys, interfaceVersion-guarded** | Same | Same | One deploy (v3 redeployed the ledger to mount five rate-limit lines) | DO class migrations heavier | n/a |
| Evidence from THIS audit | §45 | — | — | **The status quo's verified defect list is the evidence column** | — | — |
| Verdict | **RECOMMENDED (primary)** | Complement for payload-shaped calls | Not recommended | Not recommended (status quo) | Not applicable as core API | Complementary |

### 43.1 Why B stays as a complement

RPC cannot take a `Request`/stream. Three flows are payload-shaped and belong on `env.CORE.fetch()` to core's *internal* routes (same binding, same privacy): the gateway callback passthrough (arbitrary-size query strings), the OpenAPI JSON document, and future R2 upload/download tunnels. Design rule: **typed operations → RPC; payload-shaped operations → fetch-through-binding.**

### 43.2 Why E fails the shape test (and where DO RPC *is* right)

LedgerDO is a correct DO: single-writer, per-tenant, stateful — the posting protocol's atomicity depends on it. A "core API" is the opposite shape: multi-tenant, fan-out, stateless routing. Serving the merchant API from DOs would serialize all merchants behind per-object input gates and multiply DO billing. **DO RPC stays exactly where it is — inside core, for ledger state.** (v3's diff confirms the DO code is the most stable in the repo; it moves untouched.)

### 43.3 Why F is complementary

Edge rules / WAF / per-hostname routing sit in *front* of the three frontend workers (volumetric abuse, geo, bot management). The frontend↔core boundary is the binding's job. Use both; neither replaces the other.

## 44. Worker RPC detailed design decisions (nine decisions, updated)

```text
D1 SURFACE SHAPE — one class (RcpCore) on core's default export; methods
   grouped by audience but on ONE class: a single authorize() seam, single
   metrics point, single interfaceVersion gate.

D2 CONTEXT AUTH (G6) — every method takes CallerContext{worker, merchantId,
   subject, scopes, requestId, sig, interfaceVersion}; sig = HMAC-SHA256
   (per-worker secret, canonicalized ctx minus sig). Core: timing-safe
   verify → RELOAD principal from D1 → re-derive scopes → is_platform
   where required → proceed. Frontend assertions are routing hints only.
   [v3 evidence: P3-003 is what a caller-side-only scope model looks like
   when it regresses silently.]

D3 ERROR CONTRACT — core throws typed Rpc*Error classes; RPC propagates
   real errors; frontends map to the existing JSON envelope (lib/error.ts
   unchanged for REST clients).

D4 IDEMPOTENCY LIVES IN CORE — createPayment/createRefund first INSERT …
   ON CONFLICT into op_idempotency_keys ('in_flight', 30s lease). The
   UNIQUE row is the mutex; second caller → 409 IN_FLIGHT or replay of
   the stored response. Closes EDGE-P1-001's endpoint-scoping by keying
   the row (merchant, route-class, key).

D5 RATE LIMITING — per-IP groups: each frontend's own mount (Ratelimit
   binding, keyed ip:route-class — fixes V3-006); per-key: merchant worker
   at the router after authorizeKey; core adds a coarse per-worker ceiling
   as backstop (fail-CLOSED for anonymous RPC, fail-open+alarm for
   degraded authenticated paths — and the alarm now works because AE is
   on in core).

D6 OBSERVABILITY — requestId generated in the frontend → ctx → core logs
   + metrics; one AE dataset, worker-tagged. The v3 silent-metrics defect
   (P2-006) is closed as part of the move, not deferred.

D7 VERSIONING — interfaceVersion in every ctx; core rejects mismatched
   majors fail-closed; additive-only within a version; dual-accept window
   for one release on breaking changes.

D8 PAYLOADS — structured-cloneable DTOs only; large/streaming → binding
   fetch() to core internal routes with the same HMAC header scheme.

D9 TESTING — packages/core-rpc is mockable: frontends unit-test with an
   in-memory CoreRpc stub; core tests services directly; a cross-worker
   integration suite (miniflare service-binding wiring) runs the four
   golden paths (create→checkout→verify→ledger; refund→workflow→reversal;
   webhook ingress→dedup→complete; admin provision→claim). New mandatory
   test class: tenant-scoping assertions on every cross-tenant-capable
   RPC (the V3-001 lesson, mechanized).
```

## 45. Where the split pays off against THIS release's verified residuals

| Verified v3 defect | How the split closes or structurally shrinks it |
|---|---|
| EDGE-P0-001 artifact blast radius | the deploy-button zip for the customer surface contains **zero** data-plane secrets; core's secret set is one artifact, rotatable independently |
| V3-001 false claim / silent scope regressions | cross-worker tenant context is re-derived in ONE authorize seam covered by the D9 tenant-scoping test class; frontend code cannot even express cross-tenant SQL (no D1 binding) |
| V3-002 sendTest persistence | url-guard runs in core, where every webhook write happens — one validation point, not per-route discipline |
| EDGE-P2-006 silent telemetry | AE enabled in core's wrangler as a migration step (§32) |
| V3-005 header-only cap | each frontend's new index.ts mounts the streamed cap — writing the guard is part of writing the worker |
| V3-006 KV limiter race + per-path keys | anonymous limits move to the native Ratelimit binding keyed `ip:route-class` |
| EDGE-P1-010's "120/min install" family | install surface leaves the public internet (admin worker, Access) |
| NEW-P2-006 callback merchant-binding | `handleGatewayCallback` re-resolves intent+merchant inside core |
| V3-003 refund ghost-call | moved with core and fixed with the reserve-then-call pattern during the migration (§35) |
| Deploy risk | mounting a rate limit no longer redeploys the ledger |

## 46. The honest counter-case (unchanged, re-validated)

- **Single-tenant self-hosted deployments** (the deploy-button audience) get modest value from four workers — the isolation matters for *them* mostly as "the checkout artifact can't leak the platform key." The Phase 0/1-only variant (core + customer worker) captures ~80% of that value at half the work; ship that first if bandwidth is short.
- **The split is not a prerequisite for production readiness.** The §52 hotfix list is. Do not sequence the split before the rotation — a rotated monolith beats an unrotated constellation.
- **Team bandwidth**: Phases 0–4 total ~5–8 focused days including tests. If that window doesn't exist this quarter, execute §52 and revisit.
- **Don't confuse the axes**: the split is a *privilege* boundary; D1-tenancy + per-merchant LedgerDO remain the *tenant* boundary. Merchant-per-worker topologies (N workers) multiply operational surface for no isolation gain.

## 47. Final recommendation

**Proceed with the four-worker split via Cloudflare Service Bindings with Worker RPC as the inter-worker contract, exactly per Parts VIII–IX — after, not before, the §52 hotfix list.** Worker RPC is the appropriate mechanism for this system: private (the binding is a capability), typed (the contract package fails `tsc` on skew — the control whose absence let a false FIXED ship), cheap (subrequests, not billed requests), low-latency (same-PoP), and failure-faithful (real exceptions). Use fetch-through-binding for payload-shaped calls; keep DO RPC inside core where it already and correctly lives; keep edge rules/WAF as the outer layer. The reduced customer-facing REST surface (17 routes) becomes the only public contract; admin/install leave the internet; provider ingress gets its own hostname on core.

---
# PART XI — COMPREHENSIVE COMPARISON

## 48. v1 → v2 → v3 remediation trajectory (everything compared)

| Dimension | v1 (edgepay-cf-clean.zip) | v2 (edgepay-cf-clean-new.zip) | v3 (edgepay-cf-clean-new-1.zip) |
|---|---|---|---|
| Finding ledger | 49 findings (first full audit) | 49 carried: 5 FIXED / 14 PARTIAL / 30 NOT + 12 NEW = 61 | **22 FIXED / 9 PARTIAL / 30 NOT** (+1 false claim, +11 new) |
| Money core P0s | all 7 P0 open | 5 money P0s fixed (002/003/004/006/007) | held; 003/004 strengthened (atomic bound, exact cmp) |
| Secrets in artifact | live API key + JWT literal in scripts; `.dev.vars` | same literals as fallback; `.dev.vars` | scripts cleaned (env-only, fail-fast); `.dev.vars` **still same values, unrotated** |
| Root key storage | plaintext in KV (`system:root_api_key`) | same | **hash-only in D1**; KV plaintext removed |
| Tenant provisioning | any admin key → enumerate + harvest root keys | same | platform-gated + 15-min single-use claim token |
| Scope enforcement | read keys mutate (payments, webhooks) | partial (refunds/api-keys only) | **method-based write-scope on all /api/v1 mutations** |
| SSRF | hostname-string filter | same | **url-guard module + dual enforcement + redirect:'error' + 15s timeout** (+4 string-level residuals) |
| Rate limiting | limiter groups defined, unmounted (dead config) | same | **password/otp/checkout/install mounted; native per-key bindings configured** |
| Refund race | TOCTOU on cumulative bound | raced (NEW-P2-001 filed) | **atomic conditional INSERT** (ghost-call residual) |
| Amount checks | parseFloat ±0.001; skipped on null amount | same | **exact `cmp()`; mandatory for non-manual** |
| Money magnitude | unbounded | unbounded | **≤ 1,000,000,000, 2dp schema bound** |
| Payload size | none | none | **128 KB cap (header-only)** |
| Lint pipeline | non-functional (ESLint 9 vs v8 config) | same | **functional flat config; 0 errors / 42 warnings** |
| Tests | broken suites | 212/21 files | **218/22 files — independently reproduced** |
| Analytics Engine | commented out | commented out | **still commented out** |
| Architecture | single worker | single worker | **single worker** (+2 ratelimit bindings actually configured) |
| Remediation reporting | n/a | remediation table honest (5/14/30) | **summary overclaims: 1 false row, 1 undisclosed partial** |

Trajectory verdict: the engineering trend line is genuinely positive — each release fixed more than it broke, and the fix *quality* rose (string checks → parsers; read-then-write SQL → atomic conditional writes; dead config → mounted enforcement). The reporting trend line degraded in v3, which is the new risk to manage.

## 49. Monolith vs four-worker split (all dimensions)

| Dimension | Monolith (today) | Four-worker split (target) | Delta |
|---|---|---|---|
| Public attack surface | 52 routes, one origin, all surfaces | 17 customer REST + 1 provider ingress (dedicated host) | −66% route count; admin/install off-internet |
| Credential blast radius (artifact) | every deployer gets D1/KV/DO/queue creds + secrets | customer/merchant/admin artifacts carry one service binding each; only core's artifact is sensitive | structural |
| Privilege model | middleware layers in one process (P1-005-class bugs possible; V3-009 `any`-typed gate) | binding capability + per-method HMAC + principal reload | class change |
| Tenant-scope regression risk | per-SQL-statement discipline (V3-001 proved it regresses silently) | one authorize seam + mandatory tenant-scoping test class | mechanized |
| Deployment coupling | mounting 5 rate-limit lines redeploys the ledger | four independent deploys, version-guarded | operational |
| Latency (typical request) | 0 internal hops | 1 RPC hop (~sub-ms, same PoP) | negligible |
| Cost per request | 1 billed request + internal calls | 1 billed request (frontend) + subrequests | ≈ equal (free tier: subrequest caps fine) |
| Observability | silent (AE off) | AE on in core by migration step | defect → feature |
| Test surface | 218 unit/integration in one worker | same + cross-worker integration (miniflare bindings) | additive |
| Failure correlation | one worker = one blast radius (also one deploy to break everything) | core outage still takes all surfaces (same as today); frontend deploys can't break core | no regression; better deploy safety |
| Migration cost | — | ~5–8 focused days, zero data migration, reversible per phase | acceptable |
| Fit for deploy-button single tenant | perfect | good (Phase 0/1 variant recommended first) | nuance in §46 |

## 50. Integration mechanism comparison (the mechanism question, settled)

| Property | Worker RPC (A) | Binding fetch (B) | Public HTTP (C) | In-process monolith (D) | DO RPC (E) |
|---|---|---|---|---|---|
| Reachable from internet | **No (binding = capability)** | No | Yes | Yes (it's all public) | No |
| Transport cost | subrequest (not billed request) | subrequest | billed request + TLS setup | none | DO request (billed per 1M) |
| Added latency | ~sub-ms | 1–3 ms | 5–50 ms | 0 | sub-ms |
| Contract enforcement | **compile-time (shared package)** | runtime convention | runtime + docs | compile-time (imports) | compile-time (stubs) |
| Error fidelity | **real exceptions** | status codes | status codes | exceptions | exceptions |
| Streaming/payload ops | ✗ | **✓** | ✓ | ✓ | partial |
| AuthZ story | **HMAC ctx + principal reload, enforced in one seam** | same possible | weakest (secrets on the wire) | middleware | per-object awkward |
| Where used in the target | **all typed operations** | callbacks, OpenAPI, future R2 | **nowhere (deleted)** | today's everything | **inside core (LedgerDO) — unchanged** |

## 51. Cost & latency models

```text
ASSUME (deploy-button scale):  5,000 payments/day, 2.5 page-hops per checkout
                              (render, initiate, verify, status×2), 1.2 API
                              calls per payment (create + poll), 0.05 refunds.

TODAY (monolith):
  billed requests ≈ 12,500 checkout + 6,000 api + 250 admin + gateway ingress
                  ≈ 19k/day on one worker; internal calls free.
  Subrequests: 3–8/request (D1 statements + queue send + DO hop).

SPLIT (four workers):
  billed requests ≈ same 19k (frontends serve them) + ~250 core ingress
                  (webhook host) — the RPC hops are subrequests: ~1–3 per
                  request, far below the 1,000 (paid) / 50 (free) cap even
                  at 100× this traffic.
  Latency: +0.1–0.5 ms per RPC hop (same-PoP; Smart Placement keeps core
  near its D1). Checkout render: 1 RPC (getCheckoutView). Verify: 1 RPC.
  Against a 5–50 ms public-HTTP alternative (option C), the binding saves
  both the round trip and the billed request.
  Free-tier note: 100k req/day covers 5× this traffic on the frontends;
  core's 50-subrequest free cap is irrelevant (≤3 per request); DO stays
  inside its existing 100k/day request class.

DEPLOY: four deploys instead of one — at 5–8 minutes each via wrangler,
the operator's "mount a rate limit" change stops re-shipping the ledger.
```

---

# PART XII — DELIVERABLES, ROADMAP & VERDICT

## 52. Required remediation sequence (what remains, in order)

```text
T+0  (hours — do before anything else)
  1  ROTATE & PURGE the key set (EDGE-P0-001).
       - generate new JWT_SECRET / APP_KEY / ENCRYPTION_KEY;
       - ENCRYPTION_KEY migration: add op_gateway_configs.key_version +
         dual-key decrypt path; re-encrypt rows in a Workflow; then retire
         the old key (this is P2-010's fix arriving as the rotation's
         enabler — build it now, not later);
       - purge .dev.vars from the shipped artifact (ship .dev.vars.example);
       - add gitleaks/trufflehog to CI + pre-commit.
  2  RETRACT or IMPLEMENT the P3-003 fix (V3-001).
       - one line: AND merchant_id = ? AND device_id = ? on the ack UPDATE;
       - one test: cross-tenant ack affects zero rows;
       - process: ship docs/REMEDIATIONS.md (id, status, hunks, test ids)
         + CI gate that fails on FIXED-without-test (V3-011).
  3  ENABLE Analytics Engine (EDGE-P2-006) — uncomment, deploy, verify
       rate_limit_degraded/sms_parse_miss/ledger_posting_healed arrive.

T+1 (day)
  4  Cap hardening (V3-005): streamed 128 KB read or 411-when-no-length.
  5  sendTest validation (V3-002): isAllowedWebhookUrl before INSERT.
  6  Refund reserve-then-call (V3-003): 'reserving' row first (atomic bound
       check), gateway call, flip to 'pending'; sweep cancels stale
       reservations (>5 min). Reuses posting-protocol shapes.
  7  Type the security middlewares (V3-009); drops the warning noise to
       signal.

T+2..T+3 (days)
  8  KV limiter migration + route-class keys (V3-006) — Ratelimit binding,
       key = ip:route-class; fixes the OTP race properly.
  9  Anonymous-limiter spoofable fallbacks: drop XFF/X-Real-IP fallbacks
       (CF-Connecting-IP only).
  10 Pairing hardening (EDGE-P3-004): UPDATE … WHERE id = ? AND used_at IS
       NULL with changes-count check; last_insert_rowid → RETURNING or
       key the insert by uuid.
  11 Notification/device identity (EDGE-P3-002): carry device_id in the
       JWT; heartbeat/notifications key on it.
  12 Install lock → D1 (P0-005/V3-008): install_runs table; auto-bootstrap
       stops setting system:installed.

T+5..T+8 (the split — after, not before, 1–7)
  13 Execute Phases 0–4 (§36): core-rpc package → customer worker →
       merchant worker → admin worker → core lockdown.
  14 Carry the §35 ride-alongs during the move (outbox, AE, url-guard in
       core, ENABLED_GATEWAYS fail-closed, csrf decision ADR).

TRACKING RULE for every item above: one row in docs/REMEDIATIONS.md with
{ id, status, files, hunks, test ids } — the artifact-verifiable claim
format this release lacked.
```

## 53. Final architecture scorecard

| Criterion | v3 score | Weight | Notes |
|---|---|---|---|
| Money/ledger correctness | 8.5/10 | ×3 | posting protocol, atomic refund bound, exact cmp, idempotent completion; ghost-call residual |
| Tenant isolation | 7/10 | ×3 | platform gate, scope middleware, tenant-scoped SQL everywhere except the ack UPDATE (false-fixed) |
| Secrets management | 3/10 | ×3 | unrotated, shipped, single versionless key; scripts clean |
| Input validation | 7/10 | ×2 | zod on money routes, 128 KB cap (header), gateways gated; hand-rolled bodies remain |
| Abuse resistance | 7/10 | ×2 | real throttles everywhere claimed; KV race + per-path keys |
| Observability | 2/10 | ×2 | AE off; requestId plumbing good; alarms impossible |
| Process/integrity | 5/10 | ×2 | tests excellent; claims unaudited (1 false) |
| Architecture readiness for growth | 5/10 | ×1 | monolith with correct primitives; split blueprint ready (this report) |
| **Weighted total** | **≈ 5.9/10** | | report 3 equivalent: ≈ 4.6/10 |

## 54. The 17 executive questions, answered against v3

1. **Is the money core correct?** Yes — held and strengthened (atomic refund bound, exact cmp); one ordering residual (ghost-call, §V3-003).
2. **Can a merchant attack another merchant?** The enumerated paths are closed (provisioning, admin escalation, notification acks is NOT closed — false claim); the ack path is read-state only.
3. **Can a customer attack a merchant?** No enumerated path; checkout token entropy is 256-bit; TrxID reuse is gated; verify is throttled.
4. **Can an outsider become admin?** Only via the unrotated key set (JWT forgery) — i.e., yes until item 1 of §52 executes.
5. **Are the committed secrets still live?** **Yes — that is the single most important fact in this report.**
6. **Is SSRF closed?** Yes at both enforcement points; four string-level residuals remain, platform-mitigated.
7. **Is the refund path race-safe?** At the DB layer, yes (atomic). At the gateway layer, not yet (ghost-call).
8. **Are refunds bounded?** Yes — cumulatively, atomically, per-transaction.
9. **Can completed payments regress?** No — guarded transitions in every fail path; reconciliation healing of *payment rows* still absent (ledger rows heal).
10. **Are webhooks reliable?** Delivery: yes (queue, backoff, 4xx-ack, DLQ). Exactly-once: no outbox yet (crash window between D1 commit and enqueue).
11. **Is the API surface minimal?** No — 52 public routes; Part IX reduces to 17 + ingress.
12. **Is the system observable?** No — metrics are structurally silent (AE off).
13. **Can we deploy safely?** Tests/typecheck/lint are green and reproducible; deploy hygiene (secrets, claims) is not.
14. **Is the codebase maintainable?** Improving fast: lint functional, strict types, modular controllers; 42 `any` warnings concentrated in new security code.
15. **Is the four-worker split justified?** Yes — §45 maps eleven verified defects to structural closures; cost is 5–8 days, zero data migration.
16. **Should Worker RPC be used?** Yes — §43/§47: private, typed, cheap, failure-faithful; fetch-through-binding for payload-shaped calls; DO RPC stays in core.
17. **Can we take production traffic today?** **No.** After §52 items 1–3 (hours-to-a-day): controlled traffic, yes — bounded merchants, monitored, with the split scheduled next.

## 55. Final production verdict

```text
VERDICT:        NOT PRODUCTION READY
                (distance to CONDITIONAL: rotate the key set, retract/fix
                the false claim, enable Analytics — then controlled traffic)

WHAT GOT FIXED THIS RELEASE (verified):     17 findings, zero regressions
WHAT THE SUMMARY CLAIMED BUT ISN'T:          1 row (P3-003), 1 partial (P0-001)
WHAT'S STILL OPEN:                           30 not fixed, 9 partial, 11 new
WHAT THE TESTS SAY:                          218/218 green — reproduced
WHAT THE ARCHITECTURE SAYS:                  single worker, split blueprint
                                             ready (Parts VIII–X), Worker RPC
                                             recommended
THE ONE ACTION THAT MATTERS MOST:            rotate and purge the key set
```

EdgePay's engineering is now genuinely converging: the money core is defensible, the perimeter is real code instead of comments, and the verification culture (218 tests, crash-injection, strict types) is the strongest it has been. What stands between this and production is no longer skill — it is two honest artifacts (a rotated key set, a truthful remediation ledger) and the execution of a plan that is already written down, in this report and the one before it.

---

# ANNEXES

## Annex A — Remediation-summary claim text vs code reality (side-by-side)

| Claim (verbatim, condensed) | Code reality (file:line) | Verdict |
|---|---|---|
| "Stripped all fallback API keys and JWT secrets from verify-*.mjs. Fail-fast exit." | scripts read env, exit on missing (`verify-adversarial.mjs:19–26`) | TRUE |
| *(implied: P0-001 resolved)* | `.dev.vars` ships same secrets; no rotation; no CI scan | INCOMPLETE |
| "Deleted env.KV.put('system:root_api_key')" | no such write anywhere in bootstrap.ts | TRUE |
| "Root key only stored as SHA-256 hash in D1 op_api_keys" | `bootstrap.ts:188–203` keyHash insert | TRUE |
| "requirePlatformAdmin on GET/POST /api/admin/v1/merchants (is_platform = 1)" | `admin-api.ts:247–259, 262, 286` | TRUE |
| "15-minute single-use claim token via POST …/merchants/claim" | `admin-api.ts:271–283, 406–434` (TTL 900, delete-on-read) | TRUE |
| "requireScope('write') across all mutating HTTP verbs on /api/v1/*" | `api.ts:26–32` method-based middleware | TRUE |
| "Added AND merchant_id = ? predicate to UPDATE op_mobile_notifications" | `mobile.ts:259` — no predicate; file unchanged | **FALSE** |
| "url-guard.ts: blocks private IPv4 dotted/integer/hex/octal, IPv6 ULA, link-local, v4-mapped, .local/.internal" | `url-guard.ts:8–77` — all present | TRUE |
| "redirect: 'error' in WebhookQueueConsumer" | `webhook-consumer.ts:62` | TRUE |
| "Global 128 KB payload ceiling (Content-Length > 128KB → 413) in index.ts" | `index.ts:184–194` | TRUE (header-only) |
| "Atomic SQLite conditional write: INSERT … SELECT … WHERE SUM + ? <= amount + 0.001" | `refund.ts:129–161` | TRUE |
| "handleCallback uses exact decimal cmp()" | `payment.ts:315–331` | TRUE |
| "Mandatory amount verification for all API gateway types" | `payment.ts:318–324` (manual carve-out correct) | TRUE |
| ".refine(v => n > 0 && n <= 1_000_000_000) on moneySchema" | `validation.ts:20–26` | TRUE |
| "perIpRateLimit('password') on /install/bootstrap-key" | `index.ts:197` | TRUE |
| "perIpRateLimit('otp') on pair* and devices" | `index.ts:199–200` | TRUE |
| "perIpRateLimit('checkout') (30/10min) on verify and submit-trx" | `index.ts:201–202`; `rate-limit.ts:40` | TRUE |
| "Removed redundant senderToGatewaySlug(null) operand" | param-based refactor (`sms-corroboration.ts:104`, `sms-consumer.ts:84`) | TRUE |
| "Configured eslint.config.js and updated npm run lint" | flat config present; lint exit 0 | TRUE |
| "npm run lint → 0 errors" | 0 errors, 42 warnings | TRUE (warnings undisclosed) |
| "npm run typecheck → 0 errors" | exit 0 | TRUE |
| "22/22 test files, 218/218 tests" | reproduced exactly | TRUE |
| "Pushed to main and master (303f156)" | unverifiable from artifact | UNVERIFIED |
| "Deployed live (Worker Version 92343535-…)" | consistent with wrangler config | UNVERIFIED |

## Annex B — Verification battery raw output

```text
=== TYPECHECK ===            npx tsc --noEmit
TSC_EXIT=0

=== LINT ===                 npx eslint src tests
✖ 42 problems (0 errors, 42 warnings)
  all warnings: @typescript-eslint/no-explicit-any
LINT_EXIT=0

=== TESTS ===                npx vitest run
 Test Files  22 passed (22)
      Tests  218 passed (218)
   Duration   6.67s (transform 1.05s, setup 2.09s, import 233ms, tests 2.40s, environment 0ms)
TEST_EXIT=0

npm ci: 209 packages in 8s, zero audit findings reported by --no-audit run
```

## Annex C — Changed-file inventory (v2 → v3) with delta summary

| File | Δ | Nature of change |
|---|---|---|
| scripts/verify-adversarial.mjs | ~30 lines | env-only secrets + fail-fast |
| scripts/verify-all-roles.mjs | ~30 lines | same |
| scripts/verify-corroboration.mjs | ~20 lines | same |
| src/index.ts | +40 | payload cap; 5 rate-limit mounts; comments |
| src/controllers/api.ts | +25 | method write-scope middleware; registration-time url-guard |
| src/controllers/admin-api.ts | +150 | requirePlatformAdmin; claim endpoint; provisioning rewrite to claim-token |
| src/lib/url-guard.ts | NEW (77) | full SSRF guard module |
| src/queues/webhook-consumer.ts | +30 | guard call; redirect:'error'; 4xx-ack; timeout |
| src/services/bootstrap.ts | −15/+5 | root-key KV write removed; hash-only insert |
| src/services/payment.ts | +25 | cmp(); mandatory amount; manual carve-out |
| src/services/refund.ts | +35 | atomic conditional INSERT |
| src/services/sms-corroboration.ts | ±10 | verifiedGatewaySlug parameter; dead call removed |
| src/lib/validation.ts | +7 | moneySchema refine |
| src/middleware/rate-limit.ts | +10 | checkout group |
| eslint.config.js | NEW (24) | flat config |
| tests/url-guard.test.ts | NEW | 15 SSRF tests |
| package.json | +5 | eslint deps + lint script |
| (all other 202 files) | 0 | byte-identical to v2 |

## Annex D — Finding-card format and severity methodology

Carried unchanged from report 3: P0 = direct money loss / full compromise; P1 = privilege boundary breach or financial-integrity risk under stated conditions; P2 = defense-in-depth or reliability gap with a realistic path to impact; P3 = hygiene, drift, cosmetic. Verdicts: FIXED (primary exploit path closed by mounted, reachable code), PARTIALLY FIXED (narrowed with documented residual), NOT FIXED (no material change), FALSE CLAIM (summary asserts a fix that is absent). Confidence per finding is line-evidence-based; the only inference-based verdicts are the two UNVERIFIED deployment rows.

## Annex E — Auditor's uncertainty statement

1. Git history and the live Cloudflare deployment were not inspectable from the sandbox; their claims are marked UNVERIFIED and excluded from verdict arithmetic.
2. The Workers-platform mitigations cited for the four SSRF string-level residuals (edge blocking of RFC1918/loopback fetches, chunked-body normalization) reflect documented platform behavior; a determined attacker with a non-standard ingress path could conceivably differ. The residuals are stated as low, not zero.
3. KV rate-counter race windows were reasoned from KV's documented eventual consistency, not instrumented; the burst-bypass estimate (V3-006) is analytical.
4. The refund ghost-call scenario (V3-003) requires two concurrent refunds on one transaction with a gateway that executes both — reproducing it needs a live gateway sandbox; the code ordering is however verified directly.
5. This auditor had all three zips and both prior reports available; findings that "carried forward by diff authorship" (§10) were additionally spot-confirmed by direct search of the named constructs.
# PART VI-B — DEEP CODE REVIEW OF EVERY CHANGED FILE

This part reviews each changed file as a reviewer would in a merge request: what the diff does, what it does well, what it misses, and what a maintainer should watch. Line numbers refer to v3.

## B.1 `src/lib/url-guard.ts` (NEW, 77 lines)

**What it does.** A pure, dependency-free URL classifier deciding whether an outbound target is fetchable for webhook delivery. No I/O, no DNS — deliberately: everything resolvable at parse time is handled; everything that would need resolution (rebinding) is delegated to fetch policy (`redirect: 'error'`) and platform behavior.

**What it does well.**

1. *Pure functions, trivially testable.* `isPrivateIpv4`, `isPrivateIpv6`, `isAllowedWebhookUrl` are all referentially transparent — the paired `url-guard.test.ts` (15 tests) exercises each encoding family directly. This is the correct shape for a security primitive.
2. *Fail-closed parsing.* `new URL()` failure returns `false` (line 39–41). Non-HTTPS returns `false` unless the explicit dev carve-out (line 47). Malformed octets in `isPrivateIpv4` (NaN, >255) return **true** (treated private — blocked) — the safe default (line 10).
3. *Encoding coverage is exactly as claimed*: dotted private ranges; `0/8` and `224+/4` (frequently forgotten); integer form decoded via bit-shifts (no float precision loss below 2^32); hex `0x`-prefixed and octal `0[0-7]+\.` rejected outright; IPv6 `::1`, `::`, ULA `fc/fd`, link-local `fe8|fe9|fea|feb`, v4-mapped with recursive v4 evaluation — including the subtle `::ffff:7f00:1` hex-in-mapped form, which fails the v4 parse and is therefore treated private (blocked). Correct outcome, slightly by accident of the conservative default.
4. *The v4-mapped recursion* (line 28–31) is the right call — it inherits every future range added to `isPrivateIpv4`.

**What it misses (the four residuals of §12.6, restated with fix sketches):**

```ts
// residual 1: trailing-dot hostnames
hostname.replace(/\.+$/, '')          // before the localhost/.local checks

// residual 2: shorthand dotted-quad ("127.1", "10.1")
if (/^\d+(\.\d+){0,3}$/.test(hostname)) {
  const expanded = expandShorthandQuad(hostname);   // pad to 4 octets
  if (isPrivateIpv4(expanded)) return false;
}

// residual 3: NAT64 64:ff9b::/96 embedded v4
if (norm.startsWith('64:ff9b:')) {
  const v4 = extractNat64Tail(hostname);
  if (v4 && isPrivateIpv4(v4)) return false;
}

// residual 4 (design): the dev carve-out keyed on ENVIRONMENT name —
// see V3-007; prefer an explicit ALLOW_LOCAL_WEBHOOK_TARGETS=1 var.
```

**Maintainer watchpoints.** The octal regex `/^0[0-7]+\./` only catches octal *starting with 0 followed by digits then a dot* — `0x7f.0.0.1` is caught by the hex branch, but a mixed form like `0177.0x7f.0.1` (legal in some resolvers!) matches neither branch and falls through as a "hostname". Platform fetch fails to resolve it, so impact is nil — but the guard's contract should state "mixed-encoding dotted forms are treated as hostnames and rely on resolver failure." One more watchpoint: `isPrivateIpv4` returns `true` for any non-4-part string — it is *not* a general-purpose "is this private" predicate; do not reuse it elsewhere with non-quad inputs without the same conservatism.

## B.2 `src/queues/webhook-consumer.ts` (+30 lines)

**The diff in one sentence.** The consumer now (1) refuses to fetch URLs the guard rejects (logging `blocked_ssrf` and acking — never retrying a blocked target), (2) fetches with `redirect: 'error'` + a 15 s `AbortController`, and (3) treats 4xx as permanent (ack) and only 5xx as retryable with the 60/300/1800 s ladder.

**Why (3) matters beyond the claim.** Report 3's EDGE-P3-009 (4xx retried forever) burned queue budget on permanently misconfigured endpoints; the fix also *implicitly* fixes the DLQ-noise pattern: a 404 endpoint now produces exactly one delivery row and one ack instead of three retries + DLQ + alert. Side effect to watch: a transient 409 from an overloaded receiver is now permanent — acceptable for webhooks (the merchant can re-deliver via tests endpoint), but document it in WEBHOOKS.md.

**What the diff does well.** Blocked deliveries are *logged as deliveries* (`blocked_ssrf` with status 0) — the merchant sees why their webhook never fired in their own delivery log. This is better than a silent drop.

**What it misses.** (a) The timeout timer is cleared on success but an aborted fetch throws into the catch branch, which **retries** — a consistently-slow endpoint (15 s+) becomes retry-forever with backoff; fine, but cap total attempts at the queue's `max_retries` (it does — wrangler's 3 + DLQ; verify the DLQ binding exists in every wrangler variant). (b) `attempt` semantics: `webhook.attempt` starts at 1 and the delay ladder indexes `[attempt-1]` — a redelivered message from a *previous* deployment crash restarts at 1; acceptable. (c) No idempotency key header on delivery — `X-EdgePay-Delivery-ID` is unique **per attempt** (line 46), so receivers cannot dedup retries; the payload carries the event id (merchants dedup on that). Document it as the contract.

## B.3 `src/controllers/api.ts` (+25)

**The diff.** Two additions: the method-based write-scope middleware (lines 26–32) and the registration-time url-guard on `POST /webhooks` (lines 336–339).

**Design assessment.** The method-scope middleware is the *right* shape for this router: a single choke-point covering every current and future mutating route under `/api/v1`, eliminating the per-route discipline that produced P1-008 in the first place. It composes correctly with route-specific scopes (`POST /api-keys` still adds `requireScope('admin')` — a *stronger* check stacked on the base write check).

**Watchpoints.**

1. The `(requireScope('write') as any)(c, next)` cast (V3-009): the cast erases the generic mismatch between the middleware factory's handler type and the route's context type. Typing it properly with the app's `AppVariables` is a 5-minute change; until then, this is the one `any` in the auth path.
2. OPTIONS preflights: Hono's `cors()` short-circuits before route middleware for preflight — the method middleware doesn't see OPTIONS. Correct (no scope needed).
3. HEAD on GET routes: `GET`-scope only; `HEAD` requests to `/api/v1/*` would need... actually Hono auto-handles HEAD via GET handlers; the method middleware sees method HEAD → not in the mutating list → passes to read scope. Correct.
4. **The registration-time guard is good but one-way**: `POST /webhooks` validates; `POST /webhooks/tests` does NOT (V3-002) — the asymmetry is exactly the gap. Same file, 40 lines apart; the fix is symmetric validation in the tests route (or routing it through a shared helper `registerOrTestWebhook`).

## B.4 `src/controllers/admin-api.ts` (+150)

**The diff.** `requirePlatformAdmin` (D1 `is_platform` check), mounted on the two merchant-management routes; the provisioning handler rewritten to stage credentials in KV behind a 15-minute single-use claim token; a new `POST /merchants/claim` redemption route.

**What it does well.**

1. The platform check is **data-driven, not scope-driven**: `is_platform` lives in `op_merchants`, so a leaked/over-scoped *key* without platform tenancy still cannot pass. This is the correct authority source (the finding's exploit was precisely scope-without-tenancy).
2. Provisioning response is now credential-free: `claim_token` + `claim_url` + expiry only. The credentials (initial password, api key, pairing OTP, webhook secret) exist for ≤15 minutes in KV, single-use.
3. `KV.delete` before the response (line 281) — redemption is atomic-in-practice (a second redeem gets 404 even within the TTL).
4. Everything else in provisioning got *more* CSPRNG: `randomNumericOtp(6)` for the OTP (no more config echo), `randomBase64Key(24)` claim token, `crypto.randomUUID()` passwords.

**Watchpoints (beyond V3-004/V3-010 already filed).**

1. `requirePlatformAdmin(c: any, next: any)` — typed as `any`, the two warnings; type it.
2. The provisioning handler is 155 lines of sequential D1 writes with no transaction boundary — a crash mid-provision leaves a half-built merchant (user, no key; or ledger chart, no gateways). Idempotent re-POST would double-provision (slug collision not enforced — no UNIQUE on slug). Wrap in a Workflow or make re-POST idempotent by email (`WHERE email = ?` guard).
3. `POST /merchants/claim` rate limiting: it inherits the group-level per-key native limiter (30 writes/min/key) — brute-forcing a 142-bit token at 30/min is ~10^30 years; fine. But an *unauthenticated* pre-auth surface it is not — it sits behind bearer admin scope. Good.
4. Error path leaks `err.message` to the client on provisioning failure (line 438) — D1 constraint names could surface; map to a generic message + log the detail.

## B.5 `src/services/refund.ts` (+35)

**The diff.** The pre-read bound check is retained as a fast-fail (lines 80–101), and the INSERT became the claimed atomic conditional write (lines 129–157) with a changes-count rejection (159–161).

**Assessment.** The atomic INSERT is the textbook fix for a check-then-act race in SQLite/D1: the guard and the write are one statement, so serialization of statement execution makes the second racer's SUM *include* the first racer's row. The changes==0 → throw path converts silent no-op into a 422 the API maps cleanly. The `+ 0.001` float tolerance in SQL is deliberate (CAST REAL sums of 2-dp strings), and at ≤2-dp magnitudes ≤1e9 the float64 error is ~1e-7 — three orders below the tolerance. Acceptable, documented here.

**What it misses.** The gateway-call ordering (V3-003): `adapter.refund()` (lines 106–125) precedes the INSERT, so the loser of a race has already spent gateway money. The reserve-then-call sequence in §52 item 6 fixes it with the same atomic INSERT (insert `'reserving'` row with the bound check; call gateway; flip to `'pending'`; sweep cancels reservations older than 5 minutes). Note the workflow trigger expects `pending` — the reservation state must be excluded from `loadOpenOrders`-style queries and from the cumulative SUM (which it is, by the status IN filter, if you name the state `'reserving'` and exclude it there too — mind the status list at lines 84/137).

**Watchpoint.** `triggerRefundReconciliation(env, refundRowId)` after the throw-free insert: if the workflow create throws, the refund row exists with no workflow — the daily sweep's stuck-refund re-drive covers it (`sweepStuckRefunds`). Good layering; keep it.

## B.6 `src/services/payment.ts` (+25)

**The diff.** `handleCallback`'s amount gate: exact `cmp()` equality (line 326), mandatory amount for non-manual gateways (318–324), and the fail-path status updates are guarded by `status IN ('pending','processing','created')` (the P1-006 regression guard, retained).

**Assessment.** This closes both halves of NEW-P2-002/003 with the correct *carve-out*: manual gateways legitimately cannot echo amounts (the money arrives as an SMS the customer corroborates separately — that path has its own exact-amount gate at `checkout.ts:190–200` and `sms-corroboration.ts:118`). The comment block on `completeTransaction` (ledger-before-completion, write-ahead pending row) documents the strongest invariant in the codebase; the v3 diff didn't touch it.

**Watchpoint.** `verifyResult.amount == null` uses loose `==` — intentional (catches both null and undefined), but the linter's `eqeqeq` isn't enabled; a future strictness pass should not "fix" this to `=== undefined` and silently un-catch null. Add a comment or an explicit `== null` idiom note.

## B.7 `src/index.ts` (+40)

**The diff.** The 128 KB cap middleware (184–194) and five per-IP rate-limit mounts (196–202), all mounted *before* the route mounts and after the global middlewares.

**Assessment.** Mount placement is correct on every axis that matters: (a) the cap runs before `c.req.json()` in any handler; (b) the `bootstrap-key` mount precedes the broader `/install*` mount (tighter group wins the path it shares); (c) the OTP mounts precede the mobile route registration; (d) checkout mounts catch both `verify` and `submit-trx` (the alias pair).

**Watchpoints.** (a) The cap is header-only (V3-005 — the streamed variant is a 15-line middleware; write it once, mount it here). (b) The auto-bootstrap block (83–108) — unchanged, but its interaction with the *new* install throttling deserves a note: a fresh deployment's very first request is often a health probe from a load balancer, which triggers auto-bootstrap, which sets `system:installed` — and the operator's wizard is dead before they open it (V3-008). (c) `parseInt(cl, 10)` on a malformed header (`Content-Length: 12x3`) yields NaN → `NaN > …` is false → passes — harmless (runtime enforces the real length) but sloppy; `Number(cl)` with `Number.isFinite` reads better.

## B.8 `src/services/bootstrap.ts` (−15/+5)

**The diff.** Root-key KV write removed; hash-only D1 insert; result returns the plaintext key once to the caller (auto-bootstrap discards it; install wizard returns it to the installer).

**Assessment.** Exactly the deletion claimed; the KV namespace now contains only flags, caches, claim tokens and rate counters — no long-lived secrets. The one plaintext that exists anywhere is the `BootstrapResult.api_key` return value, which is correct by design (someone must see the key once).

**Watchpoint.** The claim-token flow in admin-api stores *new-merchant* creds in KV — different table, disclosed (V3-004). If you want uniformity, encrypt both-at-rest with `ENCRYPTION_KEY` (the helper already exists in `lib/crypto.ts`).

## B.9 `src/middleware/rate-limit.ts` (+10) and `src/lib/validation.ts` (+7)

Rate-limit: the new `checkout` group `{600s, 30}` matches the claim exactly; the module otherwise unchanged, so the KV race and per-path keys (V3-006) come along for the ride — the Ratelimit-binding migration in §52 item 8 retires both at once.

Validation: the refine is correct and composes (regex first — shape; refine second — magnitude; both messages actionable). One nit: `Number(v)` on a 2-dp string ≤ 1e9 is float-exact for the comparison; keep the string as the source of truth everywhere downstream (the services already do — they bind strings into D1 TEXT columns).

## B.10 `scripts/verify-*.mjs` (3 files)

Clean, fail-fast, env-only. One suggestion: print *which* variables are missing (the message names JWT_SECRET only) and add a `.dev.vars.example` with placeholders — the example file is already gitignore-carved-out (`!.dev.vars.example`) but doesn't exist yet; ship it.

## B.11 `eslint.config.js` (NEW) + `package.json` (+5)

The flat config is minimal but real: TS parser, the two high-signal rules, `no-console: off` (Workers logging is console-based — correct call). Suggested next rules for a payments codebase, in order of value: `eqeqeq` (the `== null` idiom above is the only sanctioned exception), `no-async-promise-executor`, `@typescript-eslint/no-floating-promises` (needs type-aware config — catches un-awaited D1 writes), `no-implicit-coercion`. Each maps to a real defect class in this codebase's history.

---

# PART VI-C — OPEN-FINDING EXPLOIT REPRODUCTION MANUAL (v3 state)

For each material open finding: preconditions, the concrete sequence, expected result, and the one-line detector an operator can run today. (This is the v3 refresh of report 3's Annex B; items closed in v3 are dropped, newly-confirmed ones added.)

## C.1 Compromised key set — full platform impersonation (EDGE-P0-001, P0)

**Preconditions.** Possession of any prior copy of the repo (v1/v2/v3 zips all contain `.dev.vars`).

**Sequence.** (1) Read `ENCRYPTION_KEY` from `.dev.vars`. (2) `SELECT field_name, field_value FROM op_gateway_configs` — requires D1 access OR the mobile/admin API; the *practical* path is JWT: sign a mobile access token with `JWT_SECRET` (sub = any user id, merchant_id = any merchant) — `requireJwtAuth` verifies against the same secret. (3) With a merchant-scoped JWT or a harvested key, read encrypted gateway credentials if exposed via any admin path; decrypt offline with the known key. (4) Separately: forge tokens at will; rotate-nothing means detection is impossible from the platform side.

**Expected result.** Full tenant impersonation; gateway credential disclosure wherever ciphertexts are reachable.

**Detector.** None currently possible — the point of rotation. Post-rotation: `jwt_verify_fail` metric spikes (AE required). **This is why §52 item 1 precedes everything.**

## C.2 Cross-tenant notification ack (EDGE-P3-003 — the false claim, P3)

**Preconditions.** Two merchants, each with a paired device (JWT A, JWT B).

**Sequence.** `curl -X POST .../api/mobile/v1/notifications/acknowledgements -H "Authorization: Bearer <JWT A>" -d '{"notification_ids":[1,2,3,4,5,6,7,8,9,10]}'` where the ids enumerate merchant B's rows (integer ids; the response reports `acknowledged: 10` regardless of tenancy).

**Expected result.** Merchant B's notifications get `read_at` stamped by merchant A's device. No financial state touched.

**Detector.** AE event on ack-count-vs-own-device-rows mismatch (needs AE); SQL audit: `SELECT COUNT(*) FROM op_mobile_notifications WHERE read_at IS NOT NULL AND device_id NOT IN (SELECT id FROM op_paired_devices)` — must always be 0; today it won't be after the above.

**Fix.** `... WHERE id IN (...) AND merchant_id = ? AND device_id = ?` binding the JWT context — plus the test that would have caught the false claim.

## C.3 sendTest unvalidated persistence (V3-002, P2-with-mitigation)

**Preconditions.** A write-scoped API key for merchant M with **no registered webhook**.

**Sequence.** `POST /api/v1/webhooks/tests` with body `{"url":"http://10.0.0.5:8080/x"}` → `sendTest` inserts the URL into `op_webhooks` (events `['*']`) and enqueues a test delivery. The queue consumer's guard blocks the actual fetch (`blocked_ssrf` row in the delivery log) — **but the row persists**, and in a mislabeled non-production environment the carve-out would fetch it.

**Expected result.** A stored webhook URL that never passed input validation; delivery blocked in production; the invariant is broken for every future consumer of that table.

**Detector.** `SELECT COUNT(*) FROM op_webhooks w WHERE NOT w.url LIKE 'https://%'` > 0 (plus guard-level check post-registration — currently impossible to express because the guard isn't persisted at insert time; run it once in a migration audit).

## C.4 Header-only cap (V3-005, P2)

**Preconditions.** Any unauthenticated route that parses JSON (checkout verify, install, webhook ingress).

**Sequence.** `curl -X POST -H 'Transfer-Encoding: chunked' --data-binary @5mb.json .../checkout/<token>/verify` — no Content-Length header reaches the middleware; the body streams into `c.req.json()`.

**Expected result.** The 413 never fires; parse of a 5 MB body proceeds (runtime CPU limits and D1 statement caps eventually stop it). On the Cloudflare edge, chunked client bodies are typically normalized — the residual matters for non-standard clients and for correctness.

**Detector.** A synthetic probe with an absent Content-Length asserting the 413.

## C.5 KV rate-counter race (V3-006, P3)

**Preconditions.** Any per-IP throttled endpoint; a concurrent HTTP client (`hey -n 200 -c 50`).

**Sequence.** Fire 50 parallel OTP pairing attempts from one IP. All 50 read the KV counter before any `KV.put` lands (writes are `waitUntil`-deferred, line 144–146); all 50 see count ≤ 10.

**Expected result.** >10 attempts reach the handler in the same window — the limiter's stated 10/hour is advisory under concurrency. The OTP check itself still gates validity; the exposure is brute-force budget, amplified across IPs.

**Detector.** Log-based: count 200-OKs to the pair endpoint per IP per window vs the group limit; divergence quantifies the race. (Post-fix: none — the Ratelimit binding counts atomically.)

## C.6 Pairing race / device double-issue (EDGE-P3-004, P3)

**Preconditions.** A valid unused OTP; two concurrent pair requests with the same OTP.

**Sequence.** Both SELECT the token row (`used_at IS NULL` passes for both), both UPDATE `used_at` (unconditional), both INSERT devices, both receive JWTs.

**Expected result.** Two paired devices from one OTP — the OTP's single-use contract is violated under concurrency.

**Detector.** `SELECT token, COUNT(*) FROM op_device_pairing_tokens t JOIN op_paired_devices d ON d.merchant_id = t.merchant_id GROUP BY token HAVING COUNT(*) > 1` (heuristic — user_id join needed for precision). Fix: conditional UPDATE with changes-count check (see §52 item 10).

## C.7 Refund ghost-call (V3-003, P2 financial — race, analytic)

**Preconditions.** A completed transaction with remaining refundable balance ≥ 2× the refund amount; two concurrent refund requests; a gateway adapter that executes refunds idempotently *per its own transaction id* only (the repo sends no client idempotency key to the gateway today).

**Sequence.** A and B both pass the pre-read; both call `adapter.refund()`; the gateway executes both; A's INSERT wins; B's INSERT gets changes=0 → 422 REFUND_REJECTED to the caller.

**Expected result.** Gateway-side double refund; one DB row; reconciliation sweep surfaces the discrepancy (gateway refund without DB counterpart) minutes-to-hours later.

**Detector.** The sweep's refund-reconciliation already compares gateway state; alert on "gateway refund with no op_refunds row" (needs AE + a per-gateway refund-status query — some adapters lack a refund-status API; those need the reserve-then-call fix regardless).

## C.8 Auto-bootstrap lockout (V3-008, operational)

**Preconditions.** Fresh deployment (empty KV/D1); any internet user.

**Sequence.** (1) Attacker (or a monitoring probe) requests `GET /api/v1/health` → auto-bootstrap runs → platform merchant + random-password admin + random root key (discarded) + KV `system:installed=true`. (2) Operator opens `/install` → `ALREADY_INSTALLED`.

**Expected result.** Operator cannot complete setup; the random credentials are unrecoverable; the deployment must be wiped (D1 + KV) to re-install.

**Detector.** Operator symptom: install wizard immediately locked on a brand-new deployment. Fix per §52 item 12 (D1 lock + bootstrap not setting `system:installed` + claim-token handoff for the first-run credentials).

---
# PART VII-B — CONCURRENCY, FAILURE & TIMELINE ANALYSIS (v3 STATE)

The prior report's interleaving timelines for *closed* findings are retired; this part re-derives the timelines for the races and failure windows that remain open or were newly introduced in v3, at the precision needed to design the fixes.

## D.1 Refund creation — all orderings that matter

```text
Actors:  R1, R2 = concurrent refund requests (same transaction T, remaining=100, each requests 60)
         DB  = D1 (statement-serializing)
         GW  = gateway adapter (remote)

T0   R1: pre-read SUM(0) + 60 <= 100 + 0.001        → pass
T1   R2: pre-read SUM(0) + 60 <= 100 + 0.001        → pass          [both pass pre-read — by design]
T2   R1: GW.refund(60)  → gateway executes          → money moves
T3   R2: GW.refund(60)  → gateway executes          → money moves   [V3-003: the ghost window]
T4   R1: INSERT…SELECT WHERE SUM(0)+60<=100         → changes=1     [atomic; R1 wins]
T5   R2: INSERT…SELECT WHERE SUM(60)+60<=100+0.001  → changes=0     [atomic; R2 rejected]
T6   R1: workflow instance refund-{rowid} created   → reconciliation tracks
T7   R2: throw REFUND_REJECTED → 422 to caller      [caller believes no refund happened]
T8   sweep: GW shows 120 refunded vs DB 60          → discrepancy surfaces hours later
```

The v3 fix moved the *DB* race from T-check/T-insert (TOCTOU) into a single statement — R2's T5 now sees R1's committed row. The *gateway* window T2–T3 is the residual. Note the ordering is not merely "the gateway call is early" — it *must* currently be early because the DB row's `gateway_refund_id` column wants the gateway's id. The reserve-then-call sequence breaks that coupling: insert first with `gateway_refund_id NULL, status 'reserving'`, call, then UPDATE with the returned id — the atomic bound check runs at insert, so R2 never reaches the gateway.

## D.2 Payment completion — the idempotent chain under duplicate callbacks

```text
A: gateway callback #1      B: gateway callback #2 (redelivery)
T0  A: verify → cmp(amount) ✓, trx_id ✓
T1  B: verify → cmp ✓, trx_id ✓                    [same payload — both pass, correctly]
T2  A: completeTransaction
      ├ postPaymentLedgerEntry  → LedgerDO: tx_id dedup → posts ONCE   [idempotent]
      ├ D1 batch: tx completed + intent completed                     [idempotent UPDATEs]
      └ webhook dispatch (queue)                                      [at-least-once; receiver dedups on event id]
T3  B: completeTransaction
      ├ postPaymentLedgerEntry → dedup hit → returns posted state     [no double-post]
      ├ D1 batch → status already completed; UPDATE no-ops            [idempotent]
      └ webhook dispatch → duplicate delivery (receiver dedups)
```

The chain is genuinely convergent under duplication — the property report 3 verified and v3 preserves (files unchanged). The remaining single-point risk in this chain is the crash window **inside** T2's steps: ledger-posted-but-batch-not-run leaves tx pending with a posted ledger row — the sweep heals (pending posting replay + heal path verified in `reconciliation.ts:126–129`). The reverse (completed-but-not-dispatched) is the P2-007 outbox window — still open, unchanged.

## D.3 Pairing under concurrency (EDGE-P3-004)

```text
T0  P1: SELECT token WHERE used_at IS NULL  → row
T1  P2: SELECT token WHERE used_at IS NULL  → row                  [both see unused]
T2  P1: UPDATE SET used_at WHERE id (unconditional)
T3  P2: UPDATE SET used_at WHERE id (unconditional)                [no-op harm]
T4  P1: INSERT device A → JWT A
T5  P2: INSERT device B → JWT B                                     [two devices, one OTP]
T6  P1/P2: SELECT last_insert_rowid()  ← session-scoped; under interleaving
           either request may read the OTHER's insert id           [device_id confusion in JWT]
```

Two defects compound: the unconditional UPDATE (single-use violation) and the separate-statement `last_insert_rowid()` (identity mis-attribution). Both have one-line fixes (§52 item 10); the JWT then carries a trustworthy `device_id`, which is also the fix vector for EDGE-P3-002 (heartbeat/notifications keying).

## D.4 Checkout verify vs SMS arrival — the bi-directional match race

```text
Path A (customer-first):  customer submits TrxID T at t0 → intent.metadata.customer_trx_id = T
                          SMS with TrxID T arrives at t1 → consumer corroborates:
                          candidates filtered by amount, currency, then customer_trx_id == T
                          → exactly one → confirm → completeTransaction (idempotent)

Path B (sms-first):       SMS with TrxID T arrives at t0 → corroboration: no candidate has
                          customer_trx_id == T yet → manual_review('awaiting_customer_trx')
                          customer submits T at t1 → checkout handler finds the SMS row
                          (op_sms_data parsed_trx_id = T, match_status in pending/parsed/
                          needs_manual_review/no_match) → exact cmp(amount) → completes

The duplicate-SMS redelivery case: consumer crashes after INSERT op_sms_data but before
ack → queue redelivers → second op_sms_data row for the same SMS → both paths key on
TrxID+amount, completion is idempotent, worst case: one extra 'matched' row + one
'needs_manual_review' row for the same physical SMS. Cosmetic.
```

The match lattice is closed under reordering — the design property P0-007's fix needed, intact in v3.

## D.5 Rate-limiter KV interleaving (V3-006)

```text
T0  C1..C50 (same IP): KV.get(counter) → all read "3"          [read window]
T1  C1..C50: count=4..53 in memory; 4..13 pass (≤10), 14+ get 429  [check in memory]
T2  C1..C13: KV.put(count) via waitUntil — LAST WRITER WINS     [write window, deferred]
T3  next request reads whatever the last put wrote (up to 13)
```

Worst-case slip ≈ concurrency of the burst (tens), not the limit (10). The Ratelimit-binding migration removes the read/write windows entirely (atomic edge counter). Interim hardening without the migration: make the `KV.put` synchronous (before `next()`) — halves the window at the cost of latency on throttled routes only.

## D.6 Failure-state matrix (v3 deltas only — full matrix unchanged from report 3 §19)

| Failure | v2 behavior | v3 behavior |
|---|---|---|
| SSRF target at delivery time | fetched | **blocked + logged delivery row (`blocked_ssrf`) + ack** |
| Oversized JSON body (with Content-Length) | parsed (CPU/D1 errors downstream) | **413 at the gate** |
| Oversized body (chunked, no length) | parsed | **parsed — V3-005 residual** |
| Read-scoped key mutating /api/v1 | executed | **403 at the router** |
| Non-platform admin listing tenants | executed (P1-005) | **403 at the platform gate** |
| Credential harvest at provisioning | in response | **claim token, 15-min single-use** |
| Bootstrap-key password guessing | 120/min | **10/hour per IP** |
| OTP pairing brute force | unlimited | **10/hour per IP (KV race caveat)** |
| Refund bound race | both rows inserted (TOCTOU) | **one row; 422 to the loser; ghost-call residual** |
| Adapter returns no amount | amount check skipped (auto-complete) | **tx failed (`amount_unverified`) unless manual** |
| Adapter amount ≠ intent (float edge) | ±0.001 tolerated | **exact cmp — reject** |
| Webhook receiver 404 | retried 3× + DLQ | **acked immediately (P3-009 closed)** |
| Webhook receiver redirect to private IP | followed | **fetch throws (redirect:'error') → retry ladder** |
| RATE_LIMIT binding missing | fail open (silent) | **fail open + silent metric (AE off — P2-006)** |

---

# PART VIII-B — ARCHITECTURE ANNEXES

## E.1 Architecture Decision Records (ADR-001 … ADR-006, updated)

```text
ADR-001 — Decompose by privilege, not by tenant.
Status: ACCEPTED (report 3; re-affirmed with v3 evidence — V3-001/V3-009 show
        middleware-only privilege is regression-prone).
Alternatives rejected: merchant-per-worker (N-workers, no isolation gain —
        D1 tenancy + per-merchant LedgerDO is the tenant boundary);
        monolith-forever (the current P0-001/P1-005/V3-002 defect classes).

ADR-002 — Worker RPC is the inter-worker contract; fetch-through-binding for
        payload-shaped calls.
Status: ACCEPTED. Evidence: Part X comparison; compile-time contract is the
        control whose absence let a false FIXED ship (V3-001/V3-011).

ADR-003 — LedgerDO stays a Durable Object inside core, accessed only by core.
Status: ACCEPTED (G3; DO code byte-stable across v2→v3; wrong-axis reuse of
        DO RPC for request serving rejected in §43.2).

ADR-004 — Idempotency reservation is core-owned (D4).
Status: ACCEPTED. The v3 refund path proves the pattern (atomic conditional
        INSERT); generalizing it to payments closes EDGE-P1-001's endpoint
        scoping by keying (merchant, route-class, key).

ADR-005 — The public REST contract is versioned /v1, additive-only; internal
        surfaces carry no public contract.
Status: ACCEPTED (Part IX). Breaking changes ⇒ /v2 + 180-day Sunset overlap.

ADR-006 — Secrets rotate via a versioned envelope (key_version column +
        dual-key decrypt workflow), not by big-bang key swap.
Status: PROPOSED — becomes mandatory the moment §52 item 1 executes, because
        ENCRYPTION_KEY rotation without it orphans every stored gateway
        credential. This is EDGE-P2-010 finally scheduled, by necessity.
```

## E.2 Complete RPC method specification (implementation-grade)

Every method below: signature, authorization rule, error set, idempotency rule, and the v3 finding it hardens. (Contexts abbreviated `ctx: CallerContext`; all methods validate `ctx` via the D2 pipeline first.)

```ts
// ===== CUSTOMER (edgepay-customer → CORE) =====

getCheckoutView(token: string): CheckoutView
  AUTHZ: token knowledge (256-bit random); no principal.
  ERRORS: NotFound, Gone (expired).
  IDEMPOTENT: read.
  HARDENS: the checkout render SQL stays in core; customer worker holds zero D1.

initiateGatewayPayment(token: string, gatewayId: number): InitiateResult
  AUTHZ: token + intent status ∈ {pending} + gateway active for the intent's merchant.
  ERRORS: Conflict(already-initiated), ValidationError, GatewayDisabled.
  IDEMPOTENT: keyed on (intent, gateway) — repeat returns the same initiation.
  HARDENS: P1-007's createIntent race (the initiation insert becomes conditional).

submitTrxForVerification(token: string, trxId: string, senderPhone: string|null):
    VerifyStatus
  AUTHZ: token; trxId shape (≥4); intent not completed (or short-circuit success).
  ERRORS: ValidationError, Conflict(TRX_ALREADY_USED).
  IDEMPOTENT: same (intent, trxId) → same response.
  HARDENS: the checkout verify SQL (incl. P0-007's exact-amount gate) in core;
           per-IP 'checkout' limiter keyed ip:route-class in the frontend.

pollCheckoutStatus(token: string): { status, trxId }
  AUTHZ: token. IDEMPOTENT: read.

handleGatewayCallback(token: string, params: Record<string, unknown>): { ok, status }
  TRANSPORT: fetch-through-binding (arbitrary query size), HMAC ctx header.
  AUTHZ: token; then the full handleCallback gate chain (cmp, trx_id binding,
         manual carve-out, terminal guard).
  HARDENS: NEW-P2-006 (core re-resolves intent AND merchant before completing).

// ===== MERCHANT (edgepay-merchant → CORE) =====

authorizeKey(apiKey: string): { subject, merchantId, scopes, expiresAt }
  AUTHZ: none (this IS authorization); timing-safe hash compare in core.
  ERRORS: Unauthorized, Forbidden(merchant suspended), Unauthorized(expired).
  RATE: called once per request; the merchant worker applies per-key native
        limits AFTER this call; core backstops per-worker.
  HARDENS: single verification point (today the same logic runs in two
           controllers with two call sites to keep in sync).

createPayment(ctx, req: CreatePaymentRequest): PaymentIntentView
  AUTHZ: scope write; merchant = ctx.merchantId (re-derived).
  ERRORS: Validation(2dp, 0<n≤1e9, currency), Conflict(IN_FLIGHT), GatewayUnknown.
  IDEMPOTENT: REQUIRED key; reservation row (merchant, 'payments', key) UNIQUE;
              30s lease; replay stored response on done.
  HARDENS: P2-018 boundary re-enforced in core; P1-001 endpoint-scoped keys.

createRefund(ctx, req): RefundView
  AUTHZ: scope write.
  ERRORS: NotFound, Validation(status≠completed), RefundRejected(bound).
  IDEMPOTENT: REQUIRED; same reservation table ('refunds').
  HARDENS: V3-003 — reserve-then-call sequence internal to core.

registerWebhook(ctx, url, events): WebhookView
  AUTHZ: scope write; url-guard runs HERE (V3-002 closed — single point).
  ERRORS: InvalidUrl, Validation.
  IDEMPOTENT: (merchant, url) dedup natural key.

sendTestWebhook(ctx, url?): void
  AUTHZ: scope write; url (when supplied) validated by the same guard BEFORE
         any persistence. V3-002.

listGateways(ctx): GatewayCatalogView
  AUTHZ: scope read. Reflects ENABLED_GATEWAYS (fail-closed in production —
         P2-016 closed in core's config assert).

// ===== ADMIN (edgepay-admin → CORE) =====

provisionMerchant(ctx, req): { merchantId, claimToken }
  AUTHZ: platform principal (is_platform=1, re-loaded in core) — the middleware
         is deleted from the frontend; V3-009's any-typing disappears with it.
  IDEMPOTENT: (platform, email) natural key — no half-built duplicates (fixes
         the B.4 watchpoint).
  ERRORS: Validation, Conflict(email exists).

redeemClaim(ctx, claimToken): ProvisionedCredentials
  AUTHZ: platform principal (V3-010 closed) OR a first-run bootstrap principal.
  IDEMPOTENT: single-use by KV/D1 delete-on-read.

runReconciliation(ctx): ReconSummary
  AUTHZ: platform principal.
  ERRORS: none (summary of partial failures in payload).

getTrialBalance(ctx): TrialBalanceView
  AUTHZ: platform principal OR own-merchant (scope admin) — enforced by
         re-derived merchantId match.

ping(): { ok, interfaceVersion, sha }
  AUTHZ: any bound caller (binding itself is the capability).
```

## E.3 Migration runbook (operator-facing, condensed)

```text
PREREQ  §52 items 1–3 done; REMEDIATIONS.md live; AE on.

PHASE 0 (½ day)
  - packages/core-rpc extracted; monolith implements RcpCore at /internal/rpc
    (binding-gated route: 403 unless the request arrived via a service
    binding — detectable via the Cf-Binding header pattern or a shared HMAC).
  - CI: tsc green in all repos (the contract package is the only shared dep).

PHASE 1 (1–2 days) — customer worker
  - wrangler: name edgepay-customer; services:[{binding:CORE, service:edgepay}];
    assets; routes pay.edgepay.com/checkout|invoice|pay.
  - src: index (requestId, security headers, per-IP checkout limiter keyed
    ip:route-class, streamed 128KB cap, CSP+nonce), controllers → RPC calls.
  - Rollout: route pay.edgepay.com first with a canary hostname
    (pay-canary.edgepay.com) → smoke (create intent on monolith API; render on
    canary; complete; verify ledger row) → flip main route → keep monolith
    /checkout for one release as rollback.

PHASE 2 (2–3 days) — merchant worker
  - authorizeKey RPC + per-key native limits at the router; zod double-
    validation; idempotency reservation deleted client-side.
  - Route api.edgepay.com/api/v1* → merchant worker; monolith answers
    Deprecation+Link (release N), 410 (N+1), deleted (N+2). 410 hits → AE.
  - Mobile /api/mobile/v1 rides this worker for now (documented as app API).

PHASE 3 (1–2 days) — admin worker
  - Access application in front; controllers → ADMIN_RPC; install wizard
    relocated (D1 install lock — V3-008 closed); requirePlatformAdmin deleted.

PHASE 4 (½ day) — core lockdown
  - Monolith public surface = /webhook/:slug only, moved to
    webhook.edgepay.com; old hostnames 410.
  - AE verified live; outbox mounted; anonymous limiters on Ratelimit binding.
  - Rename repo → edgepay-core. Archive monolith route table in REMEDIATIONS.md.

ROLLBACK at any phase: revert the Cloudflare route (one API call / dashboard
toggle); the monolith still serves the surface (kept warm through Phase 3);
no data ever moved. Cost of a bad phase: minutes, not migrations.
```

## E.4 Topology option diagrams (the six options, one screen each)

```text
OPTION A — RECOMMENDED: four workers + binding RPC core
  customer ──┐                        ┌── D1 KV R2 DO Q WF RL AE
  merchant ──┼── service bindings ──▶ core ──┘   (only public routes:
  admin ─────┘        (typed RPC)                /webhook/:slug, /internal/*)

OPTION B — binding + fetch only (no RPC): same topology, internal HTTP
  over the binding. Same privacy; loses compile-time contract + exception
  fidelity; envelope design tax on every call. Fallback only.

OPTION C — public inter-worker HTTP: core publishes api-internal routes;
  frontends call them with shared secrets. Reintroduces the secret-on-the-
  wire class (P0-001's cousin) + billed requests + TLS latency. Rejected.

OPTION D — monolith + tightened middleware: today. Zero added latency,
  zero migration, and every v3-verified class defect stays structurally
  possible (V3-001, V3-002, V3-009, P2-006). Rejected as terminal state.

OPTION E — DO-RPC as the core API: request serving serialized behind
  per-object input gates; wrong axis (state vs service). DOs stay in core.

OPTION F — API Gateway/WAF layer: front-of-house policy (per-hostname,
  volumetrics). Complements A; replaces nothing.

OPTION A-lite (recommended first step for the deploy-button audience):
  customer worker + core only (Phases 0–1). 80% of the artifact blast-radius
  value; merchant/admin stay on the monolith until bandwidth allows.
```

## E.5 Free-tier capacity re-check for the split (updated numbers)

```text
Assumptions: 5k payments/day, 12.5k checkout hops, 6k api calls, 250 admin.
Workers free tier: 100k requests/day/worker; 50 subrequests/invocation
(free) — paid: 1,000.

  customer worker: ~12.5k req/day          (12% of free tier)
  merchant worker: ~6k req + ~6k RPC        (RPC = subrequests, well under 50/req)
  admin worker:     ~250 req/day
  core worker:      provider ingress ~5k req/day + ~19k inbound RPC (subreq)
  LedgerDO:         unchanged request class (~3–5 per payment)
  Queues:           unchanged (webhook-out ~5k msgs/day vs 100k free tier... 
                    queues bill producers per operation — verify current 
                    free allocation; at 5k/day comfortably within every tier)

CPU: each frontend request is now thinner (parse + one RPC) — the 10ms
     free-tier CPU budget gets EASIER, not harder, per request.
KV writes: anonymous rate counters move OFF KV onto the Ratelimit binding —
     the free-tier 1k writes/day pressure that rate-limit.ts comments worry
     about disappears with V3-006's fix.
```

---
# PART V-B — SECURITY DEEP-DIVE UPDATES (STRIDE, OBSERVABILITY, SECRETS)

## F.1 STRIDE threat model — v3 refresh (delta only; full 13-component matrix unchanged from report 3 §28)

Components re-scored after the v3 fixes (S/T/R/I/D/E = Spoofing/Tampering/Repudiation/Info-leak/Denial/Elevation; ● open, ◐ narrowed, ○ closed):

| Component | Class | v2 | v3 | Driver of the delta |
|---|---|---|---|---|
| Public checkout (customer) | S | ● | ○ | token entropy + throttled verify/submit (30/10min) |
| Public checkout | I | ● | ○ | CSP + full-context escaping (held), 128 KB cap |
| Merchant REST | E | ● | ◐ | write-scope on mutations closed the enumerated paths; remaining: hand-rolled bodies (install-class) |
| Merchant REST | D | ● | ◐ | per-key native limits now real (bindings configured) |
| Admin API | E | ● | ○ | platform gate + claim token + Access |
| Admin API | S | ● | ◐ | bootstrap-key 10/hr — still a live oracle, just slow |
| Mobile API | S | ● | ◐ | OTP throttled 10/hr; pairing race (P3-004) still double-issues devices |
| Mobile API | T | ● | ● | notification ack unscoped (P3-003 — the false claim; read-state tamper across tenants) |
| Outbound webhooks | T/I | ● | ○ | SSRF guard + redirect policy + timeout + 4xx-ack |
| Outbound webhooks | D | ● | ● | no outbox (crash window loses events) — unchanged |
| Ledger/DO | T | ○ | ○ | held (posting protocol) |
| Refund flow | T | ● | ◐ | atomic bound; ghost-call window remains |
| Inbound webhooks | S | ● | ◐ | allowlist Layer-1 + signature always-on; event-id dedup partial (random fallback) |
| Bootstrap/install | E | ● | ◐ | CSPRNG + no KV root key; KV-only lock + auto-bootstrap lockout remain |
| Secrets at rest | I | ● | ● | **unrotated, artifact-shipped, versionless** — the top open row in the whole model |

Net: the Tampering and Elevation columns collapsed from 8 open cells to 4; the Info-leak column is now dominated by a single row (secrets) instead of five.

## F.2 Observability design (what enabling AE actually buys — the 15-minute fix, specified)

Current state (verified): `wrangler.jsonc` has the AE block commented out; `lib/observability.ts`'s `metric()` therefore writes to a binding that is undefined at runtime — every call is a silent no-op (the code guards against a missing binding). The events the codebase already emits, verbatim from source:

```text
rate_limit_degraded        (rate-limit.ts:79)      — THE alarm for a missing RATE_LIMIT binding
rate_limited               (rate-limit.ts:88)      — throttle trips per key
webhook_ip_rejected        (webhooks.ts:113)       — allowlist misses
webhook_geo_rejected       (webhooks.ts:113)       — geo fallback misses
webhook_signature_rejected (webhooks.ts:138)       — HMAC failures = probing volume
sms_parse_miss             (sms-consumer.ts:73)    — parser coverage health
sms_manual_review          (sms-consumer.ts:110)   — corroboration funnel
sms_confirmed              (sms-consumer.ts:99)    — auto-confirm rate
ledger_posting_healed      (reconciliation.ts:129) — crash-recovery events
refund workflow pages      (refund.ts:120)         — initiation failures
```

Enabling = uncomment the `analytics_engine_datasets` block, `wrangler deploy`, then `wrangler tail` / SQL API queries (`SELECT * FROM edgepay_metrics WHERE timestamp > NOW() - INTERVAL 1 DAY`). The dashboard queries this report's detectors (C.1–C.7) need are all single-filter queries over these events. **Recommended the moment §52 item 1 lands, not after the split** — the split merely formalizes where the binding lives.

## F.3 Secrets rotation runbook (ADR-006 operationalized — the P0-001 closer)

```text
STEP 1 — JWT_SECRET (minutes, zero downtime)
  1a. Deploy dual-verify: jwt.verify tries NEW secret, falls back to OLD
      (issue with NEW only). Ship.
  1b. Wait access-token TTL (3600s default) + refresh TTL window you accept
      (or force re-pair: pairing OTPs are cheap).
  1c. Remove OLD from the fallback list. Ship. Purge from .dev.vars, CI
      caches, and the artifact (ship .dev.vars.example only).

STEP 2 — APP_KEY (minutes)
  Stateless usage (session/stateless signing) — rotate on deploy; clients
  re-authenticate. Verify no long-lived APP_KEY-derived artifacts exist
  (search src for APP_KEY consumers first: jwt.ts/config only per grep).

STEP 3 — ENCRYPTION_KEY (the one that needs ADR-006; ~1 day)
  3a. Migration: ALTER op_gateway_configs ADD COLUMN key_version INTEGER
      NOT NULL DEFAULT 1; same for any other *_encrypted columns (search
      decrypt() call sites: gateway configs + claim payloads if adopted).
  3b. Deploy dual-key decrypt: try version 2 (new), fall back version 1
      (old); every WRITE encrypts under version 2. Ship.
  3c. Backfill Workflow: page through op_gateway_configs, re-encrypt each
      row (decrypt-with-old, encrypt-with-new, UPDATE ... WHERE key_version=1).
      Idempotent, resumable, rate-limited (D1 writes). Run via the existing
      Workflows machinery (reconciliation-sweep pattern).
  3d. Verify: SELECT COUNT(*) WHERE key_version=1 → 0. Remove old key from
      code/vars. Purge artifact copies.
  3e. From now on: rotation is a config change + re-run of the backfill
      workflow. P2-009 (silent degrade) and P2-010 (no rotation path) close
      together: the dual-key decrypt turns a wrong key into a loud metric
      (decryption_fallback) instead of silent skips.

STEP 4 — detection
  4a. gitleaks in CI (pre-commit + PR check); .dev.vars stays gitignored
      AND out of the zip (packaging step asserts its absence).
  4b. AE alert on jwt_verify_fail and decryption_fallback spikes.
```

## F.4 The 15-row remediation summary as a process artifact (retrospective)

What the summary did right: finding IDs matched report 3's ledger exactly (traceable); remediations named files, functions, and mechanisms (verifiable — this report verified 13/15 by direct search); the verification battery was real and reproducible.

What it did wrong, ranked by consequence: (1) one row claims code that doesn't exist (P3-003); (2) one row claims a finding closed whose mandatory step (rotation) wasn't done or disclosed as deferred (P0-001); (3) five rows carry undisclosed residuals (chunked cap, KV race, per-path keys, ghost-call, claim-KV plaintext); (4) "deployed live" and git claims carry no verifiable anchor (no commit hash in the artifact, no deployment marker file).

The fix is structural and cheap (V3-011): `docs/REMEDIATIONS.md` in-repo, one row per finding `{id, status, files, hunks, test ids, residuals}`, with CI failing on any FIXED row lacking a passing test, and the packaging step stamping the commit hash + worker version into the artifact. Then the next audit's Part III becomes a diff between two machine-readable files instead of 15 rows of prose — and false claims become build failures instead of findings.

---

# ANNEX F — TEST COVERAGE GAP MAP (v3)

The 218-test suite, mapped to the claim rows and the fresh findings — what covers what, and where the seams are:

| Claim / finding | Test coverage in v3 | Gap |
|---|---|---|
| url-guard encodings (P1-004) | `url-guard.test.ts` (15 tests, each encoding family) | trailing-dot, shorthand quad, NAT64, mixed-encoding forms untested (the four residuals) |
| Refund atomic bound (NEW-P2-001) | `payment-integrity.test.ts` (bounds, statuses) | no concurrency test of the INSERT-under-race (needs a D1 race harness or the conditional-INSERT invariant asserted via SQL EXPLAIN) |
| cmp() amount gate (NEW-P2-002/003) | `payment-edgecases.test.ts` + `money.test.ts` | null-amount-per-manual carve-out asserted? — verify; the carve-out is the subtle cell |
| Scope middleware (P1-008) | `api-middleware.test.ts` | mutation-by-method matrix (POST/PUT/PATCH/DELETE × scopes) — spot-verified via suite name; add explicit OPTIONS/HEAD row |
| Platform gate (P1-005) | `access-jwt.test.ts` + tenant-routing | **no test that a non-platform admin key gets 403 on GET/POST /merchants** — the middleware is new; this is the highest-value missing test |
| Claim-token flow (NEW-P2-004) | — | single-use (second redeem 404), TTL expiry, cross-tenant redeem (V3-010) untested |
| Notification ack (P3-003) | — | **the test whose absence let the false claim ship** — cross-tenant ack affects zero rows |
| Rate-limit mounts (P1-002/NEW-P2-005) | `runtime-integrity.test.ts` (mount assertions?) | KV race untestable in unit pool — document as known-limit; binding-based counters make it moot |
| Payload cap (P1-003) | — | absent-length (chunked) bypass untested (V3-005 probe) |
| sendTest (V3-002) | — | unvalidated-persist regression test |
| Bootstrap root key (NEW-P1-001) | `smoke.test.ts` (boot) | assert no KV write of `system:root_api_key` post-bootstrap (cheap, pins the fix) |
| Corroboration gates (P0-007 held) | `sms-corroboration-edgecases.test.ts` (strong) | — |
| Ledger posting (all held) | `ledger-do.test.ts`, `ledger-consistency.test.ts` (crash-injection) | — |

Pattern: the fixes that arrived with tests held; the two claim failures (P3-003, P0-001's rotation) and three of the four new code findings (V3-002/005/006) sit precisely where no test was written. The D9 rule (tenant-scoping test class + FIXED-requires-test CI gate) converts this pattern into a control.

---

# ANNEX G — WHAT WOULD CHANGE THE VERDICT (checklist form)

```text
CONDITIONAL PRODUCTION READY requires ALL of:
  [ ] JWT_SECRET / APP_KEY rotated; old values purged from every artifact copy
  [ ] ENCRYPTION_KEY dual-key decrypt + backfill complete (key_version=0 rows)
  [ ] .dev.vars absent from the shipped zip; .dev.vars.example present
  [ ] gitleaks (or equivalent) green in CI on the repo AND the packaged zip
  [ ] P3-003 predicate present + cross-tenant ack test green (claim retracted or fixed)
  [ ] Analytics Engine enabled; rate_limit_degraded visible in a live query
  [ ] docs/REMEDIATIONS.md live; CI FIXED-without-test gate active
  [ ] sendTest URL validation (V3-002)
  [ ] streamed or 411-enforced payload cap (V3-005)
  [ ] refund reserve-then-call (V3-003) OR documented gateway-side idempotency keys
  [ ] bounded canary: ≤3 merchants, amount caps per gateway, daily reconcile review

FULL PRODUCTION READY additionally requires:
  [ ] EDGE-P1-006's heal for payment rows (reconciliation UPDATEs intents, not just postings)
  [ ] outbox for webhook dispatch (P2-007)
  [ ] PBKDF2 default raised or docs corrected (P2-017 — pick one, stop disagreeing with yourself)
  [ ] ENABLED_GATEWAYS fail-closed in production (P2-016)
  [ ] anonymous limiter race closed (binding-based counters)
  [ ] mobile device identity fixed (P3-002/004)
  [ ] the four-worker split Phase 0–2 landed (or an explicit risk acceptance memo)

NOT REQUIRED for production (documented risk acceptances, in this auditor's view):
  [ ] the full admin-worker carve (Phase 3) — Access already fronts it
  [ ] CSRF middleware decision — surfaces are non-cookie; ship the ADR
  [ ] currency exponent handling (P2-019) — BDT/USD 2-dp contract is consistent today;
      revisit only when a 0/3-decimal currency onboards
```

---

# ANNEX H — FILE MAP OF THIS AUDIT (reproducibility)

```text
audit/                        three extracted versions (v1/v2/v3)
├─ verification battery logs  /tmp/verify-battery.log (tsc, eslint, vitest raw output)
├─ changed-file diff          diff -rq v2 v3 (16 files — §10)
├─ claim verification         Parts III–IV, evidence anchors per row (§12)
├─ fresh audit                Part VI (+B/C), V3-001…V3-011
├─ architecture               Parts VII–XI (+B), verified bindings inventory (§25)
└─ this report                download/EDGEPAY_CF_FULL_AUDIT_REPORT_2.md

To reproduce the battery:
  unzip edgepay-cf-clean-new-1.zip && cd edgepay-cf
  npm ci && npx tsc --noEmit && npx eslint src tests && npx vitest run
  expected: 0 / 0-errors-42-warnings / 22-files-218-tests
```
