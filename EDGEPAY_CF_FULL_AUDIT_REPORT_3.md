# EDGEpay v0.4.0 (remediation release 2) — Remediation Verification, Full Re-Audit, Ledger-Integrity Analysis & Architecture Carry-Forward Report

```text
Report ID:        EDGEPAY_CF_FULL_AUDIT_REPORT_3
Series:           5th audit in the EDGEpay-CF audit series
                  (1: EDGEPAY_AUDIT_REPORT.md — baseline audit)
                  (2: EDGEPAY_CF_FULL_AUDIT_REPORT.md — first full audit, v0.3.0 pre-remediation)
                  (3: EDGEPAY_CF_FULL_AUDIT_REPORT_1.md — re-audit + remediation verification, 49+12 findings)
                  (4: EDGEPAY_CF_FULL_AUDIT_REPORT_2.md — verification of the first remediation
                      release; 61 consolidated findings + V3-001…V3-011; one false claim (P3-003))
                  (5: THIS REPORT — verification of the second remediation release, incl. the
                      first audit of the new machine-readable remediation ledger itself)
Artifact audited: edgepay-cf-clean-new-2.zip  (953,977 bytes, 2026-09-02 07:18)
Baseline pairs:   edgepay-cf-clean.zip        (v1 — the original audited codebase)
                  edgepay-cf-clean-new.zip    (v2 — first remediation attempt)
                  edgepay-cf-clean-new-1.zip  (v3 — second remediation attempt, audited by report 4)
Auditor role:     Principal Software Architect, Payments Security Engineer,
                  Distributed Systems Engineer, Database Auditor,
                  Cloudflare Workers Specialist
Method:           Line-level code verification of every remediation claim,
                  independent re-execution of the full verification battery
                  (typecheck, lint, 23-suite test run), two live adversarial
                  probes written and executed against the artifact, four-way
                  version diff (v1 → v2 → v3 → v4), row-by-row audit of the
                  repository's own REMEDIATIONS.md ledger against both the
                  code and the test suite, and re-statement of the
                  architecture carry-forward against the verified v0.4.0 state.
Date:             2026-09-02
```

---

## Table of Contents

- **Part I — Executive Summary**
  - 1. What this audit is
  - 2. Headline results
  - 3. The code fixes are real: ten claims verified against the artifact
  - 4. The ledger is not: REMEDIATIONS.md fails its own purpose (V4-001…V4-003)
  - 5. A live production credential ships in the artifact (V4-004)
  - 6. The payload cap is still not a ceiling — live proof (V4-005)
  - 7. Build & deployment claim verification (independently re-executed)
  - 8. Overall production readiness verdict
  - 9. Risk top-5 after this remediation release
- **Part II — Audit Method, Environment & Evidence Standard**
  - 10. Method and evidence rules
  - 11. Environment and artifacts
  - 12. The v4 diff (what actually changed — complete inventory)
  - 13. Independently re-executed verification battery
- **Part III — Remediation Claim Verification (the 12 claim rows / 30 ledger rows)**
  - 14. Claim-by-claim verification with code evidence
  - 15. The REMEDIATIONS.md row-by-row audit (all 30 rows)
  - 16. Claim verification matrix (summary)
- **Part IV — Regression Verification of the Money-Core Fixes**
  - 17. The five previously-fixed money P0s under the new code
  - 18. Refund pipeline walkthrough (full path, v4 — the new ordering)
  - 19. Mobile notification and heartbeat walkthrough
  - 20. Webhook registration/test/delivery walkthrough (the new guard chain)
- **Part V — Consolidated Finding Ledger (all 72 tracked findings, v4 status)**
  - 21. P0 ledger (7 findings)
  - 22. P1 ledger (10 findings)
  - 23. P2 ledger (20 findings)
  - 24. P3 ledger (12 findings)
  - 25. NEW ledger (12 findings, report 3)
  - 26. V3 ledger (11 findings, report 4)
  - 27. V4 ledger (11 new findings, this report)
  - 28. Movement analysis (v3 → v4)
- **Part VI — Fresh Audit of the Remediated Code (new findings)**
  - 29. V4-001 … V4-011: defects and gaps introduced or exposed by this release
  - 30. The remediation-integrity synthesis (second consecutive release)
- **Part VII — Current Architecture (verified, as-built, v4 delta)**
  - 31. Single-worker reality and binding inventory (v4 delta)
  - 32. Trust boundaries and route inventory (unchanged, re-verified)
  - 33. What v4's verified fixes mean for the migration plan
- **Part VIII — Multi-Worker / Customer-Facing REST / Worker-RPC Carry-Forward**
  - 34. Status of the four-worker blueprint against v4
  - 35. Updates to the RPC contract and migration riders
  - 36. The mechanized-claims requirement (D-track) — now mandatory, not advisory
- **Part IX — Prioritized Remediation Plan & Honest Fix-List**
  - 37. The 7-day fix-list (operator actions)
  - 38. The 30/90-day roadmap
  - 39. Deployment and process recommendations
- **Part X — Comprehensive Comparison & Series Retrospective**
  - 40. The five-release evolution (v0.1 → v0.4)
  - 41. Claim-integrity evolution across three remediation rounds
  - 42. Test-suite evolution and what each round's tests actually protect
  - 43. Security-property scorecard (20 invariants × 5 releases)
  - 44. Readiness verdicts across the series
  - 45. Cost-of-delay analysis
- **Part XI — Self-Contained Architecture Blueprint (Carried Forward, Updated)**
  - 46. Target topology recap (four workers + core)
  - 47. The RPC contract (full, updated)
  - 48. Route disposition map (52 routes)
  - 49. Service Bindings vs Worker RPC — the decision matrix
  - 50. Phase plan and rollback design
  - 51. The honest counter-case (staying monolithic)
- **Part XII — Corrected Ledger Artifact & Reference Implementations**
  - 52. The corrected remediation ledger (83 rows) — the artifact to paste
  - 53. The CI gate: reference implementation
  - 54. The payload cap done right: three implementations
  - 55. Checkout and callback regression walkthroughs (v4)
- **Part XIII — Finding Deep-Dives: Impact, Detection, and the Remaining Money Paths**
  - 56. V4 findings — exploit scenarios and detection methods
  - 57. The remaining money paths: intent creation and ledger posting walkthroughs
  - 58. The claim-text deconstruction: what each section of the message asserted
- **Part XIV — Verified Route Inventory & Data-Plane Topology (v4)**
  - 59. The complete 52-route inventory (verified from source)
  - 60. Data-plane topology (verified behaviors, v4)
- **Appendices**
  - A. Verification battery — exact commands and outputs
  - B. Complete v4 diff inventory
  - C. Adversarial probe source and results
  - D. REMEDIATIONS.md — audited row-by-row table
  - E. The leaked token — decoded evidence
  - F. Glossary and finding-ID registry
  - G. The new regression test — annotated structure
  - H. Developer claims vs artifact — quote-by-quote
  - I. Operator's 7-day list — exact commands
  - J. Series statistics
  - K. REMEDIATIONS.md as shipped (verbatim, for the record)
  - L. Key v3→v4 unified diffs (evidence excerpts)
  - M. Reproducing this audit

---

# PART I — EXECUTIVE SUMMARY

## 1. What this audit is

This is the fifth report in the EDGEpay-CF audit series and the third remediation-verification round. The developer supplied `edgepay-cf-clean-new-2.zip` (referred to throughout as **v4** or **v0.4.0**) together with a remediation summary claiming: (a) fixes for the V3-001…V3-011 finding set from report 4, specifically V3-001/EDGE-P3-003 (tenant-scoped mobile acknowledgements), V3-002 (sendTest SSRF), V3-003 (refund ghost-call ordering), V3-005 (payload cap), V3-006/V3-007 (abuse hardening and SSRF opt-in), V3-009 (typed middleware), EDGE-P0-001/V3-011 (secret hygiene and a machine-readable `REMEDIATIONS.md` ledger); (b) a fix for a runtime 500 on static assets (immutable response headers); (c) resolution of "all 39" lint/type problems; and (d) an overall verdict that **"The System is 100% Healthy and Fully Fixed."**

This report independently verifies every one of those claims against the artifact itself, re-executes the entire verification battery, audits the repository's new `docs/REMEDIATIONS.md` ledger row by row against both the code and the test suite, and performs a fresh adversarial pass over the changed surface. As in every round of this series, the standard of proof is: **a claim is FIXED only if the code says so, the tests say so, and neither contradicts the other.**

The headline difference from the previous round is constructive: the one outright false claim of report 4 (V3-001/EDGE-P3-003) **is now genuinely fixed and carries a real regression test that passes**. The engineering of this release is, once again, materially better than its reporting. But the reporting layer — this time taking the form of the `REMEDIATIONS.md` ledger that report 4 explicitly demanded as the process fix — again fails an integrity check, in new and more subtle ways: five ledger rows cite verification tests that do not exist in the artifact; one row ("Analytics Engine active") is false for the production configuration; two rows claim FIXED on files that are byte-identical to the previously-audited version; and the ledger's ID column collides with the series' own finding-ID scheme in a way that can mislead an operator into believing seven different findings were fixed. And in the course of this audit, a genuinely new security defect was found that both prior reports missed: **the artifact ships a live production refresh token**.

## 2. Headline results

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ VERIFICATION BATTERY (independently re-executed, 2026-09-02)                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ npm ci                          PASS (clean install, lockfile intact)        │
│ tsc --noEmit                    0 errors            (claim: 0 — VERIFIED)    │
│ eslint src tests                0 errors, 0 warnings (claim: 0/0 — VERIFIED)│
│ vitest run                      23/23 files, 220/220 tests, 7.66s            │
│                                 (claim: 23/23, 220/220, 9.88s — VERIFIED;   │
│                                  duration variance is machine noise)        │
│ Deployment version IDs          UNVERIFIABLE from artifact (no .git shipped)│
├──────────────────────────────────────────────────────────────────────────────┤
│ CLAIM VERIFICATION (developer remediation summary, 12 substantive claims)   │
├──────────────────────────────────────────────────────────────────────────────┤
│ V3-001 / EDGE-P3-003            FIXED — verified + genuine passing test     │
│ V3-002 (sendTest SSRF)          FIXED — verified (test citation wrong)      │
│ V3-003 (refund ghost-call)      FIXED — verified (cited test does not exist)│
│ V3-005 (payload cap)            NOT FIXED in core — live PoC of bypass      │
│ V3-006 (IP/route-class limits)  FIXED as scoped (KV race persists, known)   │
│ V3-007 (SSRF opt-in flag)       FIXED — all four call sites migrated         │
│ V3-009 (typed middleware)       FIXED — zero `as any` remains in src/       │
│ EDGE-P0-001 (dev keys)          PARTIALLY — dev keys rotated, prod opaque   │
│ V3-011 (REMEDIATIONS.md)        HALF-FIXED — form yes, substance no        │
│ Static-asset 500                FIXED — verified empirically (probe)        │
│ "All 39 lint problems"          VERIFIED — 0/0 from 42 warnings in v3       │
│ "100% Healthy and Fully Fixed"  FALSE — ≥31 findings remain open            │
├──────────────────────────────────────────────────────────────────────────────┤
│ FRESH FINDINGS (this report): V4-001 … V4-011                                │
│   incl. V4-004: LIVE PRODUCTION REFRESH TOKEN SHIPPED IN THE ARTIFACT       │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3. The code fixes are real: ten claims verified against the artifact

Where the code is concerned, this release is the strongest of the three remediation rounds. Every substantive code change claimed was found in the diff, is implemented the way report 4 recommended, and holds under re-execution of the full suite:

- **V3-001 / EDGE-P3-003 — the false claim of the last round is now a true one.** `mobile.ts` now carries `AND merchant_id = ? AND device_id = ?` on the acknowledgement UPDATE, with both values bound from the verified JWT context; `auth.ts` populates `deviceId` from `payload.device_id`; the response now reports the true affected-row count (`res.meta.changes`) instead of echoing the request; and a new suite, `tests/mobile-notifications.test.ts`, builds two merchants with paired devices and proves — through the real HTTP route, with real JWTs — that merchant B's token acknowledges zero of merchant A's notifications and leaves `read_at` NULL in the database. This is precisely the test report 4 §23 asked for. The one-line predicate, the honest row count, and the regression test are all present and passing.
- **V3-002 — the sendTest hole is closed at both layers.** The route (`api.ts` `POST /api/v1/webhooks/tests`) validates a caller-supplied `body.url` through `isAllowedWebhookUrl` before invoking the dispatcher, and the dispatcher itself (`webhook-dispatcher.ts` `sendTest`) re-checks `urlToUse` before the auto-registration INSERT into `op_webhooks`. The invariant "every stored webhook URL passed the guard" is restored.
- **V3-003 — reserve-then-call, exactly as recommended.** The atomic conditional INSERT into `op_refunds` (with the cumulative-bound check) now executes **before** the gateway refund call; `gateway_refund_id` is inserted as NULL and backfilled after a successful gateway response via an id-keyed UPDATE; the `REFUND_INITIATION_FAILED` page now includes the refund's public id so an operator can triage. The losing request of a concurrent pair now fails at the database, before any money moves at the gateway. This is option (a) of report 4's fix menu, implemented cleanly.
- **V3-007 — the environment-name inference is gone.** All four guard call sites (registration, sendTest route, dispatcher, queue consumer) now key the local-delivery carve-out on an explicit `ALLOW_LOCAL_WEBHOOK_TARGETS === '1'` variable, typed in `env.ts`. A deployment that mislabels its environment no longer silently re-enables localhost webhook delivery.
- **V3-009 — the security-critical middleware is typed.** `requirePlatformAdmin` is a `MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }>`; both route groups use `ApiVariables`; `requireScope('write')` lost its `as any`; and a repository-wide grep confirms **zero** `as any` casts remain under `src/`.
- **The static-asset 500 is fixed** — and verified live (probe in appendix C): `/assets/css/checkout.css` now returns the ASSETS 404 (no route crash) with `X-Content-Type-Options` and `X-Frame-Options` applied, where the pre-fix code path threw `TypeError: Can't modify immutable headers` and 500'd. The fix uses the canonical Cloudflare pattern (`new Response(res.body, res)` to create a mutable copy) plus a guard in `setHeaders`.
- **The lint debt is gone**: 42 warnings in v3 → 0 errors, 0 warnings in v4, with the enumeration in the developer's summary (nagad typing, security-headers typing, gateway-integrity/payment-integrity/tenant-routing test typing, timeout increase) matching the actual diffs.
- **V3-006 as scoped**: `getClientIp` trusts only `CF-Connecting-IP` (the spoofable `X-Forwarded-For`/`X-Real-IP` fallbacks are deleted), and anonymous counters are keyed `ip:group` rather than `ip:path`, ending the token-parameterized dilution. The KV read-modify-write race remains, as it was always going to without a binding migration — it was not claimed fixed.
- **EDGE-P0-001 dev half**: all three local dev secrets in `.dev.vars` were regenerated (fresh values, verified distinct from v3's), the file is gitignored, the example is placeholder-only, and no literal secret exists anywhere else in the artifact (repository-wide grep for all three values).

## 4. The ledger is not: REMEDIATIONS.md fails its own purpose (V4-001…V4-003)

Report 4's V3-011 demanded a machine-readable remediation ledger so that claims become "checkable by construction." The developer shipped `docs/REMEDIATIONS.md` — a well-structured table with 30 rows, each carrying a finding ID, severity, category, status, files, and a "Verification Test ID" column. The form is exactly right. **The substance fails an audit in five distinct ways** (full row-by-row table in appendix D):

1. **Five rows cite verification tests that do not exist.** The V3-002, V3-003, V3-005, V3-006 and V3-007 rows cite `tests/url-guard.test.ts` and `tests/api-middleware.test.ts` and `tests/payment-integrity.test.ts` as covering the new behaviors — but those files are **byte-identical to v3** (MD5-verified), and the one changed test file that V3-003 cites (`payment-integrity.test.ts`) contains typing and timeout changes only, with **zero new test cases** (diff shows no new `describe`/`it` blocks). The V3-003 row's citation — "Reserve-then-call: atomic DB reservation BEFORE gateway call" — describes a test that was never written. The code fix is real; the cited evidence is fabricated.
2. **EDGE-P2-006 is claimed FIXED and is false for production.** The row says "Verified `analytics_engine_datasets` active and bound to `ANALYTICS`." In fact the **production `wrangler.jsonc` still has the binding commented out** — only the comment text changed. It was uncommented in `wrangler.dev.jsonc` and `wrangler.staging.jsonc` only. This was report 4's risk #3, explicitly priced at "minutes (uncomment + deploy)" — and the production config remains dark, while the ledger claims it active. Metrics, including the rate-limit degradation alarm, remain silent no-ops in production.
3. **The ID column collides with the series' own scheme.** Seven rows reuse report 1's `NEW-P2-00x`/`NEW-P3-00x` finding numbers as `EDGE-P2-00x`/`EDGE-P3-00x` — IDs that in report 4's consolidated ledger denote *completely different, still-open findings*. The most dangerous instance: the ledger's "EDGE-P2-001 | FIXED | atomic refund INSERT" reads, against the series' ledger, as "the CSRF middleware dead-code finding is fixed." It is not — `csrf.ts` is still never mounted. An operator tracking remediation by ID would be actively misled on seven rows.
4. **Two rows claim FIXED on byte-identical files.** `EDGE-P0-005` (install/bootstrap family) and `EDGE-P1-006` (reconciliation heals only ledger rows, not payment rows) are claimed FIXED with test citations, while `install.ts`, `bootstrap.ts`, `payment.ts` and `reconciliation.ts` are all byte-identical to v3 (MD5-verified). The cited tests are the pre-existing ones from earlier rounds — they verify the parts that were already fixed, not the residuals report 4 filed.
5. **Coverage is selective while the title is comprehensive.** The ledger's own preamble says it provides "a record of all findings and remediations across the audit series." It lists 30 rows. The series ledger at the end of report 4 tracked **72 distinct findings** (61 consolidated + 11 V3). The 42 omitted rows are precisely the NOT FIXED ones — P1-007 (createIntent race), P2-001 (CSRF dead code), P2-007 (no webhook outbox), P2-015 (ReDoS), P2-016 (fail-open gateway enablement), P2-017 (PBKDF2 50K), V3-004, V3-008, V3-010, among others. There is no CI gate (the enforcement half of the V3-011 recommendation) — the repo ships no `.github/` at all — so nothing fails a build when a "FIXED" row's test is missing. Which is exactly what happened.

This is the second consecutive release in which the remediation-tracking layer contains claims that do not survive contact with the artifact. The pattern has shifted — last round it was one code claim with no code change; this round the code claims (with one exception) hold and it is the **evidence layer** that was authored from intent rather than from the artifact. For an operator, the practical consequence is identical: **every row of this ledger now requires independent verification before it can be trusted** — which is what §15 of this report does, row by row.

## 5. A live production credential ships in the artifact (V4-004)

During the fresh-audit pass this round discovered what both prior reports missed: `sms-phone-mockup/.companion-state.json` — a runtime state file for the SMS companion mockup, **committed to the repository and shipped in both `edgepay-cf-clean-new-1.zip` and `edgepay-cf-clean-new-2.zip`** — contains a live JWT **refresh token** for the production deployment `https://edgepay-cf.bm-jonybepary.workers.dev`:

- decoded payload: `merchant_id: 8`, `sub (user): 6`, `device_id: 4`, `scope: ['read','write']`, `type: refresh`
- issued 2026-09-01, **expires 2026-10-01** — i.e. valid for another month at audit time
- the mobile refresh endpoints (`POST /api/mobile/v1/refresh`, `/api/mobile/v1/devices/token-refreshes`) exchange it for fresh access tokens with **no additional authentication** (verified in `mobile.ts:102–119`; these routes are mounted before the JWT middleware and carry no anonymous rate-limit group)

Anyone holding the distributed zip can mint valid read/write mobile-API credentials for merchant 8 on the production worker. The access token in the same file has already expired; the refresh token has not. The file is not gitignored (`.gitignore` covers `.dev.vars`, `.env`, logs — not this), and the mockup's `edgepay_url` proves the developer's local tooling talks to **production**, so this is a production-signed credential, not a dev one. Severity is assessed P2 rather than P0 because the blast radius is one non-platform merchant's mobile surface (notifications, heartbeats, device pairing state) rather than admin or money movement — but it is a *production credential in a distributed artifact*, and it converts EDGE-P0-001's "rotate production secrets" recommendation from prudence into **immediate necessity**: rotating the production `JWT_SECRET` is the one action that kills this token (and every other mobile token signed by the old secret) at once.

The adjacent finding from report 4, EDGE-P3-006 (the mockup's `/api/forward` open proxy), remains open and unclaimed.

## 6. The payload cap is still not a ceiling — live proof (V4-005)

The developer's V3-005 row claims the 128 KB payload middleware was "enhanced … to guard mutating HTTP methods (POST, PUT, PATCH)." Two changes were actually made in `index.ts`: the check is now scoped to POST/PUT/PATCH, and a malformed `Content-Length` (NaN) is rejected. Both are small improvements. **Neither addresses the defect report 4 filed**, which was never about which methods were guarded — it was that the guard inspects only the `Content-Length` header, so a request without one (chunked transfer encoding) passes to `c.req.json()` unbounded.

This round the bypass was **proven live** rather than reasoned statically. A probe test (source and output in appendix C) streamed a ~300 KB JSON body with no `Content-Length` through `SELF.fetch`:

```text
AUDIT chunked status: 401        ← passed the cap middleware entirely, failed later at auth
control (Content-Length 300KB): 413   ← the cap works when the header is present
```

The request sailed through the payload middleware and was rejected only by authentication — demonstrating the ceiling does not exist for chunked bodies, exactly as report 4 §V3-005 predicted. Meanwhile the REMEDIATIONS.md row for V3-005 says FIXED, citing an unchanged test file. This is the round's most consequential overclaim after the production analytics one: the guard is advertised as a DoS ceiling, the ledger says it is fixed, and the artifact demonstrates it is not.

Report 4's fix menu remains the correct one and is still a 15-line middleware: read the body through a bounded reader (slice at 128 KB + 1 and reject), or require `Content-Length` on POST/PUT/PATCH (411 when absent). Neither variant is present in v4. (A third, smaller regression also rides along: by scoping the check to POST/PUT/PATCH, a DELETE with an oversized declared body is no longer capped at all — theoretical, noted as V4-010.)

## 7. Build & deployment claim verification (independently re-executed)

Every reproducible claim in the developer's summary was re-executed from a clean checkout of the artifact:

| Claim | Re-executed result | Verdict |
|---|---|---|
| ESLint 9: 0 errors | `npx eslint src tests` → clean exit, no output | **VERIFIED** |
| 0 errors, 0 warnings ("all 39 problems fixed") | 0 problems reported (v3 baseline: 42 warnings) | **VERIFIED** (the 39-vs-42 count in the summary is enumeration drift, not a defect) |
| TypeScript: 0 errors | `npx tsc --noEmit` → exit 0, no diagnostics | **VERIFIED** |
| Test suites: 23/23 (100%) | 23 files, 23 passed | **VERIFIED** (up from 22 — the new `mobile-notifications.test.ts`) |
| Total tests: 220/220 (100%) | 220 passed, 0 failed, 0 skipped | **VERIFIED** (up from 218 — the two new cross-tenant tests) |
| Duration ~9.88s, "no hung requests, zero 500 errors" | 7.66s wall clock on this auditor's machine; no hangs; no 500s in logs | **VERIFIED** (duration is machine-dependent) |
| "The 400/401/403/409 errors in logs are the security tests working" | Confirmed — every non-2xx in the run traces to a test deliberately sending hostile or unauthenticated input (tenant-routing, api-middleware, smoke suites) | **VERIFIED** — this is a correct and welcome piece of developer framing |
| Git branches synchronized; Worker Version IDs `f40de600-…` / `23da8a0a-…` | **NOT VERIFIABLE from the artifact** — the zip ships no `.git` directory and no CI provenance. Two different version IDs appear in the summary (two deployments); neither can be confirmed or refuted from the zip. Carried as unverifiable, consistent with this series' evidence rules. | **UNVERIFIABLE** |

The battery itself is honest: the counts, the pass state, the clean typecheck and lint all reproduce exactly. What does not survive verification is everything the battery *cannot* see: the chunked-body bypass (no test sends a headerless body), the production analytics config (tests run against `wrangler.jsonc`'s bindings — which for metrics is a no-op either way), and the shipped credential (a state file outside the test surface). This is why the series' method treats the suite as necessary but not sufficient.

## 8. Overall production readiness verdict

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  VERDICT: CONDITIONAL HOLD — pilot-eligible after 3 operator actions;      │
│  NOT production-ready for real money movement                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

The trajectory across the series is genuine and should be stated fairly: three remediation rounds have taken the codebase from 49 open findings with five money-path P0s to a state where **every known money-path P0 and every race window on the refund/callback paths is closed and regression-tested**, the type and lint surface is clean, the suite is real (220 tests, no skips, adversarial cases included), and the one historical false claim has been converted into a true, tested fix. The engineering discipline visible in the v4 diff is high: changes are surgical, scoped, and consistent with the recommendations they cite.

What keeps the release out of production is (a) **process integrity**: the operator's control plane — the remediation ledger and the "100% fully fixed" verdict — again contains claims that fail artifact verification (5 fabricated test citations, 1 false production-config claim, 2 FIXED-on-unchanged-files rows, 7 ID collisions, and an overall verdict contradicted by ≥31 open findings); (b) **one live production credential in the distributed artifact** (V4-004); (c) **the payload ceiling still does not exist for chunked bodies** (V4-005); and (d) the carried backlog of 30+ open series findings, of which at least seven are P1/P2 items that a payments platform cannot carry into real money (P1-007 createIntent race, P2-001 dead CSRF middleware, P2-015 ReDoS, P2-016 fail-open gateway enablement, P2-006 production telemetry, P1-010 KV limiter race, V3-008 auto-bootstrap lockout).

The three operator actions that gate pilot eligibility (all are hours, not days): **rotate the production `JWT_SECRET`** (kills V4-004's leaked token and closes EDGE-P0-001's production half), **uncomment `analytics_engine_datasets` in the production `wrangler.jsonc` and deploy** (closes V4-002 and lights up the rate-limit degradation alarm), and **correct REMEDIATIONS.md** (fix the five citations, the seven IDs, the two status rows; add the 42 missing rows or retitle the file; wire the CI gate — the template is appendix D of this report).

## 9. Risk top-5 (ranked by financial/business impact)

| # | Risk | Finding | Exposure | Effort to close |
|---|---|---|---|---|
| 1 | Live production refresh token distributed in the artifact | V4-004 (new) | Read/write mobile API for merchant 8 on production until 2026-10-01 for anyone holding the zip; proof that production credentials can leak through dev tooling state | Rotate prod `JWT_SECRET` (minutes) + gitignore/exclude mockup state + rotate on schedule |
| 2 | Remediation ledger is untrustworthy — second consecutive release | V4-001, V4-002, V4-003, V4-006 | The operator's production-readiness control plane carries false "FIXED" signals; decisions made on it are decisions made on fiction | Correct 10 rows (an hour) + add the CI gate that fails on FIXED-without-test (half a day) |
| 3 | Production telemetry still dark — the rate-limit fail-open alarm remains a no-op | EDGE-P2-006 / V4-002 | A misconfigured or removed `RATE_LIMIT_*` binding fails open with **no signal**; parse-miss, signature-reject and heal events invisible in production | Minutes: uncomment in `wrangler.jsonc`, deploy |
| 4 | The 128 KB payload "ceiling" does not exist for headerless (chunked) bodies — claimed fixed, live-bypassed | V3-005 / V4-005 | CPU-burn DoS surface on every public JSON route; the guard's advertisement is false | 15-line streamed/411 middleware (report 4's fix menu, unchanged) |
| 5 | Carried P1/P2 residuals on tenancy and abuse paths | P1-007, P1-010, P2-001, P2-015, P2-016, V3-008, V3-010 (all unchanged files) | Concurrent first-payment double-seed; KV limiter race; dead CSRF middleware (state-changing web routes rely on it existing); merchant-editable ReDoS regexes; fail-open gateway enablement; fresh-deploy lockout; claim token redeemable by any admin key | Each is small and itemized in §37–38; none blocks pilot, all block real money |

---

# PART II — AUDIT METHOD, ENVIRONMENT & EVIDENCE STANDARD

## 10. Method and evidence rules

The method is unchanged from the prior reports in this series and is applied with the same rigor:

1. **Claims are verified against the artifact, not the summary.** Every sentence in the developer's remediation message and every row of `docs/REMEDIATIONS.md` is treated as a hypothesis. The artifact (`edgepay-cf-clean-new-2.zip`) is the only source of truth for what the code does.
2. **Fixes are verified by diff authorship.** A finding is "FIXED" only when the file that hosts the defect changed in the direction the fix requires. Files that are byte-identical to the previously-audited version inherit their verdicts (spot-confirmed by checksum, §12). This rule is what exposes claims of the "FIXED on an unchanged file" class (EDGE-P0-005, EDGE-P1-006 in the ledger).
3. **Tests are verified by existence and content.** A cited "Verification Test ID" is real only if the named file contains a test that exercises the claimed behavior. File-identity checksums plus targeted diff inspection (new `describe`/`it` blocks) are used; this rule is what exposes the five fabricated citations (V4-001).
4. **The battery is re-executed from clean state.** `npm ci`, `tsc --noEmit`, `eslint src tests`, `vitest run` — every count in the developer's summary is reproduced independently before it is believed.
5. **Adversarial probes go beyond the shipped suite.** Where a claimed fix is testable but untested (the payload cap; the asset-header fix), this auditor writes and executes probe tests inside the artifact's own harness, then removes them. Probe sources and outputs are in appendix C. The probes are not part of the delivered repo.
6. **Runtime/deployment claims that cannot be derived from the artifact are marked UNVERIFIABLE, not true.** The two Worker Version IDs and the git branch state are examples this round (no `.git` ships).
7. **Severity is about exposure, not elegance.** A P2 process defect that corrupts the operator's decision signal ranks alongside a P2 code defect, because in a payments platform the reporting layer *is* a control surface (see §30).

## 11. Environment and artifacts

```text
Auditor environment
  node v24.19.0 / npm 11.17.0 (clean virtual workspace)
  vitest 4.x via @cloudflare/vitest-plugin (workerd) — same harness as the repo
  eslint 9 flat config as shipped in the artifact
  no network access assumed beyond the artifact and its lockfile registry

Artifacts
  edgepay-cf-clean-new-2.zip   953,977 bytes   extracted → v4/edgepay-cf (audit target)
  edgepay-cf-clean-new-1.zip   extracted → v3ref/edgepay-cf (report 4's target; diff baseline)
  EDGEPAY_CF_FULL_AUDIT_REPORT_2.md — recovered from inside the v4 zip itself
      (MD5 abb544088b3df7d93c7194eed9706875, 213,994 bytes — byte-identical to the
       report this auditor delivered at the end of the previous round; the developer
       archived it into the repo, which is how the baseline survived the workspace
       reset between sessions; prior reports 1–3 were moved to docs/Archive/)

Extracted tree size: 225 files + node_modules excluded from counts
Test harness: cloudflareTest() over wrangler.jsonc (real D1/DO/Queues/KV bindings),
  maxWorkers 1, isolate false — same as prior rounds
```

One environmental note for reproducibility: the vitest plugin loads bindings from `wrangler.jsonc` — the **production** config. That is why the test battery cannot detect the production Analytics Engine gap (V4-002): metrics writes are fire-and-forget no-ops with or without the binding, in tests as in a misconfigured production. Config-level defects are invisible to the suite by construction; they are exactly the class that requires the row-by-row ledger audit of §15.

## 12. The v4 diff (what actually changed — complete inventory)

The four-way diff (v1 → v2 → v3 → v4) shows this release touches **21 tracked paths** (plus `node_modules`, excluded — installed by this audit). Full raw inventory in appendix B; the semantically grouped view:

```text
Source (11 files)
  src/controllers/mobile.ts          V3-001 predicate + deviceId + honest row count
  src/middleware/auth.ts             ApiVariables exported; deviceId from JWT payload
  src/services/webhook-dispatcher.ts V3-002 guard before INSERT (sendTest path)
  src/controllers/api.ts             V3-002 route-level validation; V3-007 flag; V3-009 typing
  src/services/refund.ts             V3-003 reserve-then-call reordering
  src/index.ts                       V3-005 method-scoped cap + NaN guard; asset wrapper fix
  src/middleware/rate-limit.ts       V3-006 CF-IP-only + group keying
  src/middleware/security-headers.ts static-500 guard + V3-009 typing
  src/queues/webhook-consumer.ts     V3-007 ALLOW_LOCAL_WEBHOOK_TARGETS
  src/controllers/admin-api.ts       V3-009 typed requirePlatformAdmin + ApiVariables
  src/gateways/nagad/nagad.gateway.ts lint fix: RSA-OAEP params typed (hash pinned at import)
  src/types/env.ts                   ALLOW_LOCAL_WEBHOOK_TARGETS?: string

Tests (4 files)
  tests/mobile-notifications.test.ts NEW — cross-tenant/device ack regression (2 tests)
  tests/payment-integrity.test.ts    typing generics + timeouts only (no new cases)
  tests/tenant-routing.test.ts       typing only (no new cases)
  tests/gateway-integrity.test.ts    typing only (no new cases)

Config / secrets / docs (6 paths)
  .dev.vars                          all three dev secrets regenerated (rotation)
  .dev.vars.example                  rewritten to placeholder form
  wrangler.dev.jsonc                 analytics_engine_datasets UNCOMMENTED (dev)
  wrangler.staging.jsonc             analytics_engine_datasets UNCOMMENTED (staging)
  wrangler.jsonc                     comment text only — analytics STILL COMMENTED (prod)
  docs/REMEDIATIONS.md               NEW — the machine-readable ledger (30 rows)
  docs/Archive/                      NEW — reports 1–3 moved here from repo root
  EDGEPAY_CF_FULL_AUDIT_REPORT_2.md  NEW at root — report 4 archived by the developer

Runtime state (1 file — SHOULD NOT SHIP)
  sms-phone-mockup/.companion-state.json  regenerated live session state incl.
      a production refresh token (V4-004) and updated heartbeat timestamps
      proving active use against production minutes before the zip was cut
```

**What did not change** is as important as what did. Byte-identical to v3 (checksum-verified spot list): `payment.ts`, `reconciliation.ts`, `install.ts`, `bootstrap.ts`, `csrf.ts`, `enabled.ts`, `sms-parser.ts`, `crypto.ts`, `ledger-do.ts`, `jwt.ts`, `cloudflare-access.ts`, `maintenance.ts`, `url-guard.ts` (the guard function itself — V3-007 was fixed entirely at call sites, §14.6), `observability.ts` (despite the ledger citing it as a modified file for EDGE-P2-006), and all of `tests/url-guard.test.ts` / `tests/api-middleware.test.ts` (despite the ledger citing both as verification for four rows).

## 13. Independently re-executed verification battery

Executed 2026-09-02 from a clean extraction, before any auditor modification of the tree:

```text
$ npm ci                       → exit 0 (lockfile intact, no drift)
$ npx tsc --noEmit             → exit 0, zero diagnostics
$ npx eslint src tests         → exit 0, zero errors, zero warnings
$ npx vitest run               →

  ✓ tests/access-jwt.test.ts
  ✓ tests/api-middleware.test.ts
  ✓ tests/api-reference.test.ts
  ✓ tests/bd-gateways.test.ts
  ✓ tests/catalog-port.test.ts
  ✓ tests/gateway-integrity.test.ts
  ✓ tests/gateways-enabled.test.ts
  ✓ tests/gateways.test.ts
  ✓ tests/ledger-consistency.test.ts
  ✓ tests/ledger-do.test.ts
  ✓ tests/mobile-notifications.test.ts        ← NEW this release
  ✓ tests/money.test.ts
  ✓ tests/payment-edgecases.test.ts
  ✓ tests/payment-integrity.test.ts
  ✓ tests/port-kit.test.ts
  ✓ tests/runtime-integrity.test.ts
  ✓ tests/sms-corroboration-edgecases.test.ts
  ✓ tests/sms-parser-adversarial.test.ts
  ✓ tests/smoke.test.ts
  ✓ tests/tenant-routing.test.ts
  ✓ tests/url-guard.test.ts
  ✓ tests/workflow-policy.test.ts
  ✓ tests/jwt.test.ts

  Test Files  23 passed (23)
       Tests  220 passed (220)
    Duration  7.66s (transform 1.15s, setup 2.26s, tests 3.04s)
```

The counts match the developer's claims exactly (23/23, 220/220; the 9.88s vs 7.66s duration difference is machine noise). The log noise the developer's summary describes — 400/401/403/409 lines during the run — is confirmed to originate from tests deliberately exercising validation failures, tenant mismatches, unauthorized calls and replay conflicts; this is correct behavior and the developer's framing of it ("expected behavior verifying that the API rejected unauthorized or bad inputs") is accurate. No 500s appear anywhere in the run — consistent with the static-asset fix (probe-verified separately, appendix C).

**What the battery cannot see**, and therefore what the summary's "100% healthy" inference cannot rest on: the payload cap's headerless-body bypass (no test sends a body without Content-Length), the production Analytics binding state (config-level, invisible to tests), the shipped refresh token (outside the test surface), and the ledger's evidence integrity (outside the code entirely). The suite verifies that what is tested works; it is silent on what is not tested — which is the gap the fabricated citations exploit.

---

# PART III — REMEDIATION CLAIM VERIFICATION (THE 12 CLAIM ROWS / 30 LEDGER ROWS)

## 14. Claim-by-claim verification with code evidence

This section verifies the developer's remediation summary claim by claim. Each entry states the claim, shows the code evidence found in v4, and renders a verdict under the evidence rules of §10. The REMEDIATIONS.md ledger itself is audited separately, row by row, in §15.

### 14.1 V3-001 / EDGE-P3-003 — tenant- and device-scoped mobile acknowledgements

**Claim:** predicate added (`AND merchant_id = ? AND device_id = ?`); `deviceId` populated from verified JWT payloads in `auth.ts`; new test suite `mobile-notifications.test.ts` verifying cross-tenant/cross-device acknowledgements affect 0 rows.

**Code evidence (all verified):**

`src/controllers/mobile.ts` — the acknowledgement UPDATE, v4:

```sql
UPDATE op_mobile_notifications SET read_at = ?
WHERE id IN (…) AND merchant_id = ? AND device_id = ?
```

bound with `(now, …notification_ids, merchantId, deviceId)` where `merchantId` comes from the authenticated context and `deviceId` from `(c.get('deviceId') as number | undefined) ?? c.get('authSubject')`. The response changed from echoing the request (`acknowledged: body.notification_ids.length` — a lie under scoping) to the true count: `acknowledged: res.meta?.changes ?? …`. That last detail matters more than it looks: an honest affected-row count is what makes the new test's zero-row assertion meaningful.

`src/middleware/auth.ts` — `ApiVariables` is exported with `deviceId?: number | null`, and `requireJwtAuth` now sets `c.set('deviceId', payload.device_id ?? null)` after verifying the token. The JWT payload type (`jwt.ts`) already carried `device_id?: number`, so the plumbing is end-to-end typed.

`tests/mobile-notifications.test.ts` — read in full (appendix C reproduces its skeleton). It provisions two merchants, each with an admin user and a paired device; inserts a notification for merchant A's device; issues real JWTs for both merchants via the real `createJwtService` with `device_id` in the payload; then, through the real HTTP route:

- merchant B's token attempts to acknowledge merchant A's notification → asserts `acknowledged === 0` **and** asserts in the database that `read_at` is still NULL;
- merchant A's token acknowledges it → asserts `acknowledged === 1` and `read_at` set.

This is a genuine black-box regression test through the full middleware stack, not a unit-level mock. It is precisely the test report 4 §23/V3-001 specified ("pairs two merchants' devices and asserts cross-tenant acks affect zero rows").

**Residuals (minor, non-blocking):** (a) the test covers cross-tenant **and** cross-device simultaneously (B's device ≠ A's device) but contains no *same-merchant, different-device* case, which is the narrowest form of the device-scoping guarantee; (b) the `?? authSubject` fallback means a user-session JWT without `device_id` (password login rather than device pairing) still keys the device predicate by user id — harmless here (device-keyed notification rows simply won't match a user id, so 0 rows) but it keeps the EDGE-P3-002 identity-confusion family alive on adjacent routes (see §19); (c) the GET `/notifications` list route uses the same fallback by design and remains merchant-scoped.

**Verdict: FIXED — verified in code, in plumbing, and by a genuine passing regression test.** The false claim of report 4 is now a true one. This is the single most important credibility repair of the release.

### 14.2 V3-002 — sendTest no longer persists unvalidated URLs

**Claim:** `isAllowedWebhookUrl()` enforced in `webhook-dispatcher.ts` and `api.ts` before creating test webhook endpoints.

**Code evidence (verified at both layers):**

`src/controllers/api.ts` — `POST /api/v1/webhooks/tests` now validates before dispatch:

```ts
if (body?.url) {
  const { isAllowedWebhookUrl } = await import('../lib/url-guard');
  if (!isAllowedWebhookUrl(body.url, c.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
    return c.json({ … code: 'INVALID_URL' … }, 400);
  }
}
```

`src/services/webhook-dispatcher.ts` — `sendTest()` re-checks at the persistence boundary, before the auto-registration INSERT:

```ts
const urlToUse = targetUrl || this.env.DEFAULT_WEBHOOK_URL;
if (!urlToUse) return { success: false, error: 'No webhook endpoint registered for merchant' };

const { isAllowedWebhookUrl } = await import('../lib/url-guard');
if (!isAllowedWebhookUrl(urlToUse, this.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
  return { success: false, error: 'Target webhook URL is blocked by SSRF protection' };
}
// only then: INSERT INTO op_webhooks (merchant_id, url, secret, events…
```

The invariant report 4 demanded — *every URL persisted into `op_webhooks` passed the SSRF guard* — is restored: the registration route (unchanged, already guarded), the test route, and the dispatcher's auto-subscribe path (including the `DEFAULT_WEBHOOK_URL` env fallback case) all pass through the same check. The delivery-time re-check in the queue consumer remains as defense-in-depth, so the guard is now enforced three times along the URL's lifecycle.

**Residuals:** none material. The auto-created row still subscribes to `['*']` events (as before, disclosed); the route's error envelope for a blocked URL is honest.

**Verdict: FIXED — verified.** Note on the claim's citation: the ledger row cites `tests/url-guard.test.ts` as covering "sendTest and POST /webhooks/tests validate URL before INSERT" — that file is byte-identical to v3 and contains no such route-level tests; the fix is real, the cited evidence is not (V4-001).

### 14.3 V3-003 — refund reserve-then-call ordering

**Claim:** reordered `refund.ts` so the atomic conditional INSERT executes before the external gateway API call, eliminating ghost refunds.

**Code evidence (verified — this is the recommended option (a) of report 4 §23):**

v4 execution order in `RefundService.processRefund`:

1. pre-reads and validations (unchanged: transaction exists, belongs to merchant, status, amount ≤ …);
2. **atomic reservation** — the conditional INSERT with the cumulative-bound check, now with `gateway_refund_id` explicitly NULL:
   `INSERT INTO op_refunds (…, gateway_refund_id, …, status, …) SELECT ?, ?, ?, NULL, ?, …, 'pending', … WHERE (SELECT COALESCE(SUM(CAST(amount AS NUMERIC)),0) FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?) + ? <= (SELECT amount FROM op_transactions …) + 0.001`;
   on zero rows inserted → `REFUND_REJECTED` (the loser of a concurrent pair dies HERE, before any money moves);
3. **gateway call** — `adapter.refund(...)` executed only after the row exists; on success the row is updated `SET gateway_refund_id = ? WHERE id = ?` (row-own id from `last_row_id`, no scope ambiguity);
4. on gateway failure, `REFUND_INITIATION_FAILED` pages now include `refund_id` — the missing-money triage path is directly actionable;
5. the per-refund reconciliation workflow trigger (unchanged, idempotent by instance id).

**Why this is correct:** the race window report 4 filed (NEW-P2-001's residual) was "both requests pass the pre-read, both call the gateway, only one wins the INSERT — the loser has moved real money with no DB row." In v4 the INSERT *is* the gate: the losing request throws before `adapter.refund()` is ever invoked. A crash between INSERT and gateway call leaves a `pending` row with NULL `gateway_refund_id` — visible to the workflow and the sweep, which is exactly the state machine the reconciliation machinery already handles. A crash between gateway success and the backfill UPDATE leaves a `pending` row without its gateway id — the sweep's amount/transaction matching still sees it; this is a bounded, observable residual (seconds of exposure vs. the previous unbounded ghost).

**Idempotency interplay:** the route-level idempotency middleware (required for refunds since v3) still catches same-key replays before this code runs; the conditional INSERT catches different-key concurrency. The two mechanisms compose correctly.

**Verdict: FIXED — verified, and the strongest fix of the release** (financial race window closed at the only place it could be: the database).

**Citation note:** the ledger cites `tests/payment-integrity.test.ts` "(Reserve-then-call: atomic DB reservation BEFORE gateway call)". The file's v3→v4 diff contains typing generics and two timeout bumps **only** — no new test cases exist for the ordering (V4-001). The fix is real; the claimed test does not exist. Report 4's §12 pattern — code honest, evidence layer overclaimed — repeats here in miniature.

### 14.4 V3-005 — payload cap

**Claim:** "Enhanced the 128 KB payload middleware in index.ts to guard mutating HTTP methods (POST, PUT, PATCH)."

**Code evidence (v4 `index.ts`):**

```ts
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    const cl = c.req.header('content-length');
    if (cl) {
      const len = parseInt(cl, 10);
      if (isNaN(len) || len > 128 * 1024) {
        return c.json({ … code: 'PAYLOAD_TOO_LARGE' … }, 413);
      }
    }
  }
  return next();
});
```

What actually changed relative to v3: (a) the check is scoped to POST/PUT/PATCH (v3 checked any method *when a Content-Length was present*); (b) NaN from a malformed header is now rejected (v3's `parseInt` sloppiness — report 4's watchpoint — is fixed); (c) the guard remains **entirely header-conditioned**: `if (cl)` — a request with no `Content-Length` (chunked transfer encoding) passes to `c.req.json()` unbounded, exactly as report 4 §V3-005 described.

**Live proof (appendix C):** a streamed ~300 KB JSON body without Content-Length traversed the middleware and was rejected only at authentication (401), while the header-present control was correctly 413'd. **The finding's core defect is not fixed.** The two small hardenings are real but orthogonal to it; and the method-scoping is a *narrowing* (a DELETE with an oversized declared body is no longer capped — theoretical, filed as V4-010).

The fix menu from report 4 is unchanged and still small: a bounded reader (slice at 128 KB + 1, reject) or 411-when-absent on POST/PUT/PATCH. Neither variant appears.

**Verdict: NOT FIXED in its core defect; two small hardenings added. The claim's framing ("Hardened Request Payload Cap") and the ledger's status (FIXED, citing an unchanged test file) materially overstate the state of the guard.**

### 14.5 V3-006 — IP extraction and route-class keying

**Claim:** switched IP extraction to CF-Connecting-IP directly; keyed anonymous throttles on route classes.

**Code evidence (verified):** `getClientIp` is now `headers.get('CF-Connecting-IP') ?? '0.0.0.0'` — the spoofable `X-Real-IP`/`X-Forwarded-For` chain is deleted. On Workers, `CF-Connecting-IP` is edge-set and trustworthy; the previous fallbacks were dead code in production but live spoof vectors in any non-CF ingress scenario, so their removal is genuine defense-in-depth. The anonymous counter key changed from `${prefix}${ip}:${c.req.path}` to `${prefix}${ip}:${group}` — every distinct checkout token no longer mints its own 30-per-10-minutes budget; the dilution attack (token cycling) is dead.

**Residuals (known, unclaimed):** the KV read-check-write race (concurrent burst all read 0 and pass) persists — REPORT 2's recommendation to migrate anonymous counters onto the native Ratelimit binding (keyed `ip:class`) was not taken, and was not claimed. Local `wrangler dev` without the edge header collapses all clients into the `0.0.0.0` bucket — a dev-only annoyance.

**Verdict: FIXED as scoped and claimed.** Ledger citation to unchanged `api-middleware.test.ts` is again inaccurate (V4-001), but the two claimed behaviors are real in code.

### 14.6 V3-007 — SSRF guard opt-in

**Claim:** SSRF guard in `url-guard.ts` and `webhook-consumer.ts` requires explicit `ALLOW_LOCAL_WEBHOOK_TARGETS` configuration.

**Code evidence (verified at all four call sites):** `src/types/env.ts` adds `ALLOW_LOCAL_WEBHOOK_TARGETS?: string`; and the environment-name inference `ENVIRONMENT !== 'production'` was replaced with `ALLOW_LOCAL_WEBHOOK_TARGETS === '1'` in:

1. `api.ts` webhook registration (`POST /api/v1/webhooks`);
2. `api.ts` test-webhook route (new, §14.2);
3. `webhook-dispatcher.ts` `sendTest` (new, §14.2);
4. `webhook-consumer.ts` queue delivery (the delivery-time re-check).

A mislabeled environment (copy-pasted dev config in a production deploy) can no longer silently re-enable localhost webhook delivery — the failure mode report 4 flagged. The carve-out now fails closed: unset variable → strict guard.

**Precision note:** `url-guard.ts` itself is byte-identical to v3 — `isAllowedWebhookUrl(url, allowHttpLocalhost = false)` already took an explicit boolean; what changed is that every *caller* now derives that boolean from the opt-in variable instead of the environment name. The claim's wording ("Updated SSRF guard in url-guard.ts") is technically inaccurate about which file changed, but the security property is delivered. The remaining `ENVIRONMENT === 'development'` checks in the tree (`error.ts` stack exposure, `index.ts` pretty-JSON gate) are verbosity conveniences, not security carve-outs — correctly out of scope.

**Verdict: FIXED — verified (claim's file attribution slightly off; cited test coverage again nonexistent — V4-001).**

### 14.7 V3-009 — typed middleware

**Claim:** replaced all `any` casts in `admin-api.ts` and `api.ts` with strict `ApiVariables`.

**Code evidence (verified):** `ApiVariables` is exported from `auth.ts` with `merchantId`, `authSubject`, `deviceId`, `authScopes`, `authType`; both controllers instantiate their route groups as `Hono<{ Bindings: Env; Variables: ApiVariables }>`; `requirePlatformAdmin` is now `const requirePlatformAdmin: MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> = async (c, next) => …` with `c.get('merchantId')` fully typed; the `(requireScope('write') as any)(c, next)` call became `requireScope('write')(c, next)`; `security-headers.ts`'s middleware and `setHeaders(c: Context)` lost their `any`s (with the try/catch restructure of §14.9). A repository-wide grep for `as any` under `src/` returns **zero** hits; `tsc --noEmit` is clean. The bug class report 4 described (a typo'd `c.get('merchantId')` compiling silently on an `any` context) is closed.

**Verdict: FIXED — verified.**

### 14.8 EDGE-P0-001 & V3-011 — secret hygiene and the remediation ledger

**Claim (P0-001 half):** fresh local dev keys generated; `.dev.vars.example` created.

**Evidence:** `.dev.vars` in v4 carries three fresh values, all distinct from v3's (JWT_SECRET hex rotated, APP_KEY/ENCRYPTION_KEY base64 rotated); a repository-wide search for all three literals finds them nowhere else in the artifact; `.gitignore` excludes `.dev.vars` (with `!.dev.vars.example` negation); the example file is placeholder-only with generation commands. The verify-scripts remain fail-fast (exit 1 on missing env, no literal fallbacks — spot-verified in `verify-adversarial.mjs`). The `.dev.vars` file's *presence in the zip* remains a distribution artifact of zipping the working tree rather than a repository leak (it is gitignored), and its values are dev-only.

**Claim precision note:** `.dev.vars.example` was not *created* this round — v3 already shipped one (with empty values and rich instructions); v4 rewrote it into placeholder form. "Created" overstates; the substance (placeholder template) holds.

**The production half of P0-001 remains unverifiable and now intersects V4-004:** production secrets live in `wrangler secret` and cannot be inspected from the artifact — but the leaked production refresh token (§5, V4-004) is signed by the production secret and still validates (as far as the artifact can show), which is *prima facie* evidence that **the production `JWT_SECRET` has not been rotated** since at least 2026-09-01. Rotation therefore graduates from "recommended" to "required immediately."

**Claim (V3-011):** "Created the machine-readable tracking ledger REMEDIATIONS.md."

**Evidence:** `docs/REMEDIATIONS.md` exists — 30 rows, columns `{Finding ID, Severity, Category, Status, File(s) Modified, Verification Test ID}`. The form implements report 4's recommendation. **The substance fails audit** in the five ways detailed in §4 and §15: five fabricated test citations, one false production-config claim (EDGE-P2-006), two FIXED-on-unchanged-files rows (EDGE-P0-005, EDGE-P1-006), seven ID-scheme collisions, 42 of 72 tracked findings omitted under a "comprehensive" title, and no CI gate to enforce any of it (the repo ships no `.github/`).

**Verdict: EDGE-P0-001 — PARTIALLY FIXED (dev half done and clean; production half now REQUIRED, see V4-004). V3-011 — HALF-FIXED: the artifact exists, the integrity does not.** The ledger, as shipped, would not have passed the very gate report 4 proposed ("CI fails if a FIXED row's test is missing or skipped") — five rows fail it on arrival.

### 14.9 Static-asset 500 fix

**Claim:** outer middleware injecting OWASP headers into immutable ASSETS responses threw `TypeError: Can't modify immutable headers` → 500; fixed in `index.ts:244–250` via a mutable `new Response(res.body, res)` wrapper; `security-headers.ts` safely guards header mutation.

**Code evidence (verified, with one attribution correction):**

```ts
app.get('/assets/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);   // mutable copy — canonical CF pattern
});
```

`security-headers.ts`'s `setHeaders` now wraps its whole body in try/catch with the comment "Response might have immutable headers (e.g. ASSETS fetch response) — safe fallback," and the CSP-nonce `c.set` is guarded separately.

**Empirical verification (appendix C):** `GET /assets/css/checkout.css` in the artifact's harness returns **404 (the ASSETS binding's own not-found), not 500**, with `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY` present. Pre-fix, this path threw and 500'd (the `tenant-routing.test.ts` asset-bypass case exercised it; the test tolerated any status, which is why the suite never failed on it — the error only surfaced in logs, exactly as the developer's narrative describes).

**Attribution correction (does not change the verdict):** the middleware that threw on asset responses was Hono's built-in `secureHeaders()` mounted at `app.use('*', …)` (index.ts line 125) — which also sets XCTO/XFO on every path — not the custom `securityHeadersMiddleware` (mounted only on `/api/*` and `/webhook/*`). The wrapper in the asset route is what actually fixes the crash (the response is mutable before *any* post-handler middleware touches it); the `setHeaders` guard protects the custom middleware's own surfaces. The developer's narrative names the wrong middleware, but the fix is correct and complete for the crash. The empirical probe also shows the custom CSP layer does not apply to asset paths (it never did — only hono `secureHeaders` does) — a pre-existing layering fact, not a regression.

**New residual (V4-007, cosmetic):** the asset route still cannot serve a real file: `ASSETS.fetch(c.req.raw)` forwards the full `/assets/css/checkout.css` path, which the binding resolves against its `./public/assets` root as `public/assets/assets/css/checkout.css` → always 404. The only shipped asset (`checkout.css`, 727 bytes) is unreachable at every URL — nothing in the app references it, so no user-facing behavior depends on it, but "static asset serving" as a subsystem remains decorative. Correct fix: strip the `/assets` prefix before the binding call, or set the directory to `./public` and pass through.

**Verdict: FIXED as claimed (crash eliminated, probe-verified); one pre-adjacent discovery filed (V4-007); attribution narrative slightly off.**

### 14.10 "All 39 problems" (lint/type/test hygiene)

**Claim:** ESLint 0/0, tsc 0, 23/23 suites, 220/220 tests, no hung requests, zero 500s.

**Evidence:** all reproduced (§13). The specific fixes enumerated in the claim match the diffs one-for-one: `nagad.gateway.ts` dropped the `as any` on RSA-OAEP encrypt params (safe: WebCrypto's `RsaOaepParams` has no `hash` member — the hash is bound to the key at import, and `importPublicKey` still pins `{ name: 'RSA-OAEP', hash: 'SHA-256' }`, so OAEP-SHA256 behavior is preserved — verified §15 row 25); `security-headers.ts` typed; `gateway-integrity.test.ts`/`payment-integrity.test.ts`/`tenant-routing.test.ts` typing and timeouts, with the diffs containing **no new test cases** (which is why the counts rose only 22→23 files and 218→220 tests — exactly the new mobile suite's two tests, and nothing else).

**Verdict: VERIFIED in full.** (The "39" in the claim vs the 42 warnings report 4 counted is enumeration drift — the breakdown lists five files' worth of fixes; the current state is 0/0 either way.)

### 14.11 "The 400/401/403/409 errors are normal" — and the overall verdict claim

The developer's framing that non-2xx lines during `npm test` are the security suite doing its job is **correct** (verified in the run log: every 4xx traces to a deliberately hostile input case). This is a good-faith and accurate piece of documentation — noted because it is the kind of operator-facing explanation this series has asked for.

The overall verdict — "The System is 100% Healthy and Fully Fixed" and "Fixed: All 39 Problems" — is **false as stated**: V3-005's core bypass persists (live-proven), V3-004/V3-008/V3-010 are untouched and unclaimed, 30 series findings remain NOT FIXED (including seven P1/P2 items), the production analytics claim in the ledger is false, and a live production credential ships in the artifact. The honest formulation would have been: "all claimed code fixes for this round are implemented and the full suite is green; N findings from the series remain open." Filed as V4-006.

## 15. The REMEDIATIONS.md row-by-row audit (all 30 rows)

The ledger is the round's designated process fix, so it receives a full audit rather than spot checks. Verdicts use the same vocabulary as the series. "Citation ✗" means the Verification Test ID column names coverage that does not exist in the artifact (either the file is unchanged and never contained the case, or the described case was never added).

| Row (as written) | Files claim | Status claim | Audit verdict | Notes |
|---|---|---|---|---|
| EDGE-P0-001 Secrets | scripts + example | FIXED | **PARTIAL** | Scripts clean (held from v3); dev keys rotated ✅; production rotation not evidenced — and V4-004 shows the prod JWT secret is still the one signing the leaked token. No scanning CI. |
| EDGE-P0-002 refund wrong ledger row | ledger.ts, refund.ts | FIXED | **FIXED (held)** | Byte-identical files; fix dates to v2/v3 and holds (re-verified in walkthrough §18). |
| EDGE-P0-003 unbounded refunds | refund.ts | FIXED | **FIXED (held, strengthened)** | Atomic bound (v3) + new reserve-then-call ordering (v4) — cumulative fix verified. |
| EDGE-P0-004 callback amount binding | payment.ts | FIXED | **FIXED (held)** | payment.ts unchanged; fix holds (suite re-run green). |
| EDGE-P0-005 install/bootstrap | install.ts, bootstrap.ts | FIXED | **OVERCLAIM** | Both files **byte-identical to v3**. The claimed test ("Post-install secret posture") is a pre-existing v2-era test. Residuals report 4 filed (auto-bootstrap on first non-install request sets `system:installed`; KV-only install lock; `/install` first-come race) are all still live. |
| EDGE-P0-006 checkout XSS | checkout.ts | FIXED | **FIXED (held)** | Unchanged; escaping + CSP hold (suite re-run). |
| EDGE-P0-007 SMS amount NULL | checkout.ts, sms-corroboration.ts | FIXED | **FIXED (held)** | Unchanged; exact-decimal strictness holds. |
| EDGE-P1-001 idempotency | idempotency.ts | FIXED | **FIXED (held)** | D1-backed, concurrency-safe since v2; endpoint scoping still absent (disclosed residual, unchanged). |
| EDGE-P1-002 OTP brute force | index.ts, rate-limit.ts | FIXED | **FIXED (held)** | Group mounts persist; now improved by v4's CF-IP + group keying. |
| EDGE-P1-003 body cap | index.ts | FIXED | **FIXED (held) — but see V3-005 row** | The original cap (v2) holds for headered requests; the v4 "hardening" row below overclaims. |
| EDGE-P1-004 outbound SSRF | url-guard.ts, webhook-consumer.ts | FIXED | **FIXED (held, strengthened)** | Dual enforcement + v4 opt-in flag; string-level residuals unchanged (platform-mitigated). |
| EDGE-P1-005 tenant enumeration | admin-api.ts | FIXED | **FIXED (held)** | Platform gate + claim token (v3); typing improved (v4). |
| EDGE-P1-006 state machine | payment.ts | FIXED | **OVERCLAIM** | payment.ts **byte-identical**. Regression guards in callback/fail paths hold (v2-era), but the residual report 4 filed — reconciliation heals `op_ledger_postings` only, never payment/transaction rows — is untouched. Cited test is pre-existing. |
| EDGE-P1-008 write scope | api.ts | FIXED | **FIXED (held, improved)** | Method-based write-scope middleware; typing cleaned (v4). |
| EDGE-P2-001 "atomic refund INSERT" | refund.ts | FIXED | **FIXED — but ID COLLISION** | The substance (NEW-P2-001 in the series) is fixed and now strengthened by reserve-then-call. The row's ID, however, collides with the series' EDGE-P2-001 (CSRF dead code — still NOT FIXED). An operator reading "EDGE-P2-001 FIXED" against the series ledger is misinformed. |
| EDGE-P2-002 "decimal cmp" | payment.ts, money.ts | FIXED | **FIXED — ID COLLISION** | Substance = series NEW-P2-002 (fixed since v3, holds). Series EDGE-P2-002 (DO fault seam) remains open. |
| EDGE-P2-003 "amount verification" | payment.ts | FIXED | **FIXED — ID COLLISION** | Substance = NEW-P2-003 (held). Series P2-003 (platform merchant excluded from verification) remains open. |
| EDGE-P2-004 "claim token" | admin-api.ts | FIXED | **FIXED — ID COLLISION** | Substance = the v3 claim-token flow (held). Series P2-004 (webhook master-domain platform binding) remains open. |
| EDGE-P2-005 "checkout rate limit" | index.ts, rate-limit.ts | FIXED | **FIXED — ID COLLISION** | Substance = NEW-P2-005 (held; improved by group keying). Series P2-005 (ratelimit binding fail-open) remains partially open. |
| EDGE-P2-006 analytics | wrangler.jsonc, observability.ts | FIXED | **FALSE (production)** | Production `wrangler.jsonc` binding **still commented out**; only dev/staging configs were enabled. `observability.ts` is byte-identical (listed as modified — inaccurate). The "verified active" statement is true only of dev/staging. This was report 4's risk #3. |
| EDGE-P3-001 "dead operand" | sms-corroboration.ts | FIXED | **FIXED — ID COLLISION** | Substance = series NEW-P3-001 (held from v3). Series P3-001 (dead schema states) remains open. |
| EDGE-P3-002 "ESLint 9" | eslint.config.js | FIXED | **FIXED — ID COLLISION** | Substance = NEW-P3-002 (held). Series P3-002 (authSubject/device_id confusion on heartbeat etc.) remains open — partially mitigated for notifications only. |
| EDGE-P3-003 / V3-001 mobile ack | mobile.ts | FIXED | **FIXED (verified + tested)** | The round's genuine repair: predicate + JWT deviceId + real regression test. ✅ |
| V3-002 sendTest | dispatcher + api.ts | FIXED | **FIXED (verified) — Citation ✗** | Code fix real at both layers; cited url-guard.test.ts coverage does not exist (file unchanged). |
| V3-003 reserve-then-call | refund.ts | FIXED | **FIXED (verified) — Citation ✗** | Code fix real; cited payment-integrity.test.ts case was never written (diff = typing only). |
| V3-005 payload cap | index.ts | FIXED | **NOT FIXED (core) — Citation ✗** | Live bypass proof (§6, appendix C). Chunked/headerless bodies pass unbounded. NaN + method-scoping added; core defect remains. |
| V3-006 CF-IP + route class | rate-limit.ts | FIXED | **FIXED (as scoped) — Citation ✗** | Both behaviors real; KV race persists (unclaimed, known); cited coverage doesn't exist. |
| V3-007 opt-in flag | url-guard.ts, webhook-consumer.ts | FIXED | **FIXED (verified) — Citation ✗ + file ✗** | All four call sites migrated; url-guard.ts itself unchanged (claim names it as modified); cited coverage doesn't exist. |
| V3-009 typed middleware | admin-api.ts, api.ts | FIXED | **FIXED (verified)** | Verified by tsc/lint/grep — the one row whose cited "verification" (typecheck/lint) is real and reproduces. |

**Ledger audit totals:** 30 rows audited → 17 clean verdicts (including 6 held-fixes re-confirmed), 2 OVERCLAIM (P0-005, P1-006 — FIXED claimed on byte-identical files), 1 FALSE for production (P2-006), 1 NOT FIXED (V3-005), 5 Citation ✗ rows in addition to their code verdicts, 7 ID collisions, and 42 series findings absent from a document whose preamble claims comprehensive coverage.

## 16. Claim verification matrix (summary)

| # | Claim (developer summary) | Code | Test | Ledger row honest? | Final verdict |
|---|---|---|---|---|---|
| 1 | V3-001 predicate + deviceId + suite | ✅ | ✅ real, passing | ✅ | **FIXED** |
| 2 | V3-002 sendTest validation | ✅ both layers | — none added | ✗ citation | **FIXED** |
| 3 | V3-003 reserve-then-call | ✅ | — none added | ✗ citation | **FIXED** |
| 4 | V3-005 hardened cap | partial | — | ✗ status+citation | **NOT FIXED (core)** |
| 5 | V3-006 CF-IP + route-class | ✅ | — | ✗ citation | **FIXED (scoped)** |
| 6 | V3-007 explicit opt-in | ✅ (4 call sites) | — | ✗ citation+file | **FIXED** |
| 7 | V3-009 typed middleware | ✅ | ✅ (tsc/lint) | ✅ | **FIXED** |
| 8 | P0-001 fresh dev keys + example | ✅ | — | partial | **PARTIAL** |
| 9 | V3-011 REMEDIATIONS.md | ✅ exists | — | **✗ (5 rows fail audit)** | **HALF-FIXED** |
| 10 | Static-asset 500 fixed | ✅ | ✅ probe-verified | n/a (not a ledger row) | **FIXED** |
| 11 | 39 lint problems / battery green | ✅ | ✅ 23/23, 220/220 | n/a | **VERIFIED** |
| 12 | "100% healthy, fully fixed" | ✗ (≥31 open) | ✗ | ✗ | **FALSE** |

The pattern in one sentence: **eleven of twelve claims are engineering-true; four of them carry evidence-layer falsehoods; and the twelfth claim (the verdict) is false.** The engineering has earned the benefit of the doubt; the reporting has not — which is the exact inverse of the situation report 3 faced, and the exact same place report 4 ended up.

---

# PART IV — REGRESSION VERIFICATION OF THE MONEY-CORE FIXES

## 17. The five previously-fixed money P0s under the new code

Report 4 verified the five money-path P0s (EDGE-P0-002 … EDGE-P0-006 + EDGE-P0-007's corroboration path) as fixed and held under v3. This round re-verified them under v4. None of the hosting files changed except `refund.ts` (the V3-003 reordering), so the verdicts are diff-authoritative plus suite-confirmed, with the refund path additionally re-walked line by line (§18).

| Finding | Status under v4 | Evidence |
|---|---|---|
| EDGE-P0-002 (refund reverses wrong ledger row) | **FIXED (held)** | `ledger.ts`/`refund.ts` posting by public refund id; suite: `ledger-consistency.test.ts` (idempotent refund posting) green in the 220-test run |
| EDGE-P0-003 (unbounded refunds / instant completed) | **FIXED (held, strengthened by v4)** | Atomic cumulative-bound INSERT (v3) now *precedes* the gateway call (v4) — the bound is enforced before money moves; `payment-integrity.test.ts` cumulative-limit cases green |
| EDGE-P0-004 (callback ignores amount & intent binding) | **FIXED (held)** | `payment.ts` byte-identical; exact `cmp()` + mandatory amount verification; callback suite green |
| EDGE-P0-005 (bootstrap credential chain) | **PARTIAL (unchanged residuals)** | See §14.8/§21 — the money-adjacent install/bootstrap family's residuals (auto-bootstrap lockout, KV lock) persist; not claimed this round, correctly so in the summary (incorrectly as FIXED in the ledger) |
| EDGE-P0-006 (checkout stored XSS / CSP) | **FIXED (held)** | `checkout.ts` byte-identical; smoke suite's CSP + escaping cases green |
| EDGE-P0-007 (SMS corroboration skips amount on NULL) | **FIXED (held)** | Corroboration path byte-identical; edge-case suite green |

**Money-path conclusion:** every finding in the series that could move money incorrectly is closed and regression-covered under v4, and the v4 change to `refund.ts` strictly strengthened the strongest of them. No regression introduced by the reordering (full walkthrough next).

## 18. Refund pipeline walkthrough (full path, v4 — the new ordering)

The complete path of `POST /api/v1/payments/refund` under v4, as executed in code order, with the verification performed at each gate:

```text
1. Route group gates (api.ts)
   requireBearerApiAuth(['read','write','admin'])
   → requireScope('write') for POST (method-based, EDGE-P1-008)
   → route-local zod: amount moneySchema (0 < n ≤ 1e9, 2-dp string, EDGE-P2-018)
   → idempotency middleware REQUIRED on this route (EDGE-P1-001):
     same key + same body-hash → replay; same key + different body → 409

2. RefundService.processRefund (refund.ts, v4 order)
   a. SELECT transaction by public trx_id, merchant-scoped
      → 404 if absent; status must be a refundable state (regression guard, P1-006 held)
   b. fast-fail pre-read: existing refunds sum + requested ≤ transaction amount
      (advisory only — the authoritative check is the INSERT below)
   c. ATOMIC RESERVATION (the V3-003 fix, now step 1 of persistence):
      INSERT INTO op_refunds (…, gateway_refund_id, …, status, …)
      SELECT ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?
      WHERE (SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)
             FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?) + ?
            <= (SELECT amount FROM op_transactions WHERE …) + 0.001
      → zero rows ⇒ REFUND_REJECTED (loser of a concurrent pair exits HERE,
        before any gateway call — ghost-refund window closed)
   d. GATEWAY CALL (only now):
      adapter = registry.resolve(tx.gateway_slug)
      credentials = loadCredentials(payment_intent_id)   (AES-GCM decrypt, skip-on-fail
      residual EDGE-P2-009 unchanged)
      result = adapter.refund(tx.gateway_trx_id, amount, credentials, {kv})
      → on success: UPDATE op_refunds SET gateway_refund_id = ?, updated_at = ?
                    WHERE id = <own last_row_id>          (row-scoped, no ambiguity)
      → on failure/throw: page REFUND_INITIATION_FAILED {…, refund_id}     (v4:
                    now includes the public refund id — triage is direct)
      → manual gateways: unsupported → row stays 'pending', workflow + sweep own it
   e. WORKFLOW TRIGGER: refund-reconciliation instance per refund row id
      (idempotent by instance id; polls settlement; pages on timeout — unchanged,
      and now sees the row from the moment it exists)
```

**Race matrix under v4** (the scenarios the series has tracked since report 1):

| Scenario | v3 behavior | v4 behavior |
|---|---|---|
| Two concurrent refunds, combined ≤ bound | both pass pre-read → both call gateway → one wins INSERT, loser throws with money already moved at gateway (ghost) | **both attempt INSERT; both may win if within bound (correct — bounded); if either exceeds, that request is rejected at the DB before its gateway call** |
| Two concurrent refunds, combined > bound | both call gateway (money moves twice!) then one INSERT fails | **at most one gateway call; the second is rejected at the INSERT** |
| Same idempotency key, same body (double-click) | replay served from `op_idempotency_keys` | unchanged (correct) |
| Same key, different body | 409 body-hash mismatch | unchanged (correct) |
| Crash between reservation and gateway call | n/a (call came first) | row exists as `pending`/NULL gateway id → workflow polls, sweep reconciles (observable, bounded) |
| Crash between gateway success and backfill UPDATE | row existed with gateway id already (single INSERT) | row exists `pending` with NULL gateway id; sweep matches by transaction/amount — seconds-scale residual vs. hours-scale ghost |
| Gateway-side refund succeeds but returns error | row `pending` with NULL id (v3 also recorded row on catch) | same — reconciliation sweep is the backstop (unchanged, and now includes refund_id in the page) |

**Ledger-affecting behavior (P0-002 family):** posting still keyed by the refund's *public* id with idempotent journal entries (`ledger-consistency` suite green) — unaffected by the reordering.

**Verdict: the refund path is now correct under every scenario the series has filed, with one knowingly-bounded residual (crash between gateway success and id backfill) that the existing sweep already observes.** This closes the last money-path race window in the series.

## 19. Mobile notification and heartbeat walkthrough

The V3-001 fix changed the identity plumbing; this walkthrough re-verifies the mobile surface end-to-end under the new code:

- **JWT issuance** (`jwt.ts`, unchanged): access tokens carry `sub` (user id), `merchant_id`, optional `device_id`, `scope`. Pairing flow issues device-bound tokens; password login issues user-bound tokens without `device_id`.
- **`requireJwtAuth`** (`auth.ts`, v4): verifies signature/type/exp, sets `authSubject = parseInt(payload.sub)`, **`deviceId = payload.device_id ?? null`** (new), `authScopes`, and enforces the domain-vs-JWT merchant consistency check (tenant isolation at the middleware layer, held from v2).
- **`GET /api/mobile/v1/notifications`** (v4): merchant-scoped SELECT; `deviceId = c.get('deviceId') ?? authSubject` — a user-token without device id lists rows keyed by user id (will match nothing if notifications are device-keyed; harmless) while remaining strictly merchant-scoped.
- **`POST /notifications/acknowledgements`** (v4): the scoped UPDATE (§14.1); honest `res.meta.changes` reporting; the new regression suite proves cross-tenant/cross-device zero-row behavior through the real route.
- **`POST /devices/heartbeats`** (unchanged): **still uses `c.get('authSubject')` as the device id** — `UPDATE op_paired_devices SET last_heartbeat_at = ? WHERE id = <authSubject>`. For a device-paired JWT, `sub` is the *user* id, not the device id (the pairing flow issues tokens whose `sub` is the user and whose `device_id` is the device) — so heartbeat updates the row `WHERE id = user_id`, which is the wrong row whenever user id ≠ device id (EDGE-P3-002, carried). The notification routes got the identity repair; heartbeat did not. It remains a P3 data-hygiene defect (mis-keyed heartbeat timestamps), now adjacent to code that demonstrates the correct pattern — the fix is a one-line `c.get('deviceId') ?? c.get('authSubject')` in the handler, exactly as the notification routes do.
- **Refresh endpoints** (unchanged, mounted pre-auth): `/refresh` and `/devices/token-refreshes` exchange a refresh token for an access token with no additional binding — the surface that makes V4-004's shipped token directly usable (§29.4).

## 20. Webhook registration/test/delivery walkthrough (the new guard chain)

The full URL lifecycle under v4, showing the now-triple enforcement:

```text
[registration] POST /api/v1/webhooks
  zod url schema → isAllowedWebhookUrl(body.url, ALLOW_LOCAL_WEBHOOK_TARGETS === '1')
  → INSERT into op_webhooks                                  (v2-era guard, now opt-in flag)

[test route]    POST /api/v1/webhooks/tests
  optional body.url → route-level isAllowedWebhookUrl(…) → 400 INVALID_URL if blocked
  → WebhookDispatcher.sendTest(merchant, body.url)

[dispatcher]    sendTest
  no registered webhook? urlToUse = targetUrl || DEFAULT_WEBHOOK_URL
  → isAllowedWebhookUrl(urlToUse, flag) → refuse before INSERT      (V3-002 fix)
  → INSERT op_webhooks (…, events '["*"]', active)
  → enqueue webhook.test message (signed, queued)

[delivery]      queue consumer
  → isAllowedWebhookUrl(webhook.url, flag) → blocked_ssrf log + ack   (v3-era guard)
  → fetch with redirect: 'error', 15s timeout, signature header      (EDGE-P1-004 held)
```

The invariant "every persisted URL passed the guard" is restored at every write site; delivery-time enforcement remains as defense-in-depth. The `DEFAULT_WEBHOOK_URL` env-fallback case — the one path where a *non-caller-controlled* URL could previously enter storage unvalidated — is covered by the dispatcher-side check.

**Carried residuals on this path (unchanged, unclaimed):** no outbox — a crash between the D1 commit and `sendBatch` still loses the message (P2-007); the claim-token flow still stages new-merchant credentials in plaintext KV for 15 minutes (V3-004); inbound webhook geo-fallback and event-id determinism residuals (P1-003 family) are byte-identical to v3.

---

# PART V — CONSOLIDATED FINDING LEDGER (ALL 72 TRACKED FINDINGS, V4 STATUS)

The series ledger, updated for v4. Verdict legend: **FIXED** (verified this round or held by diff+suite), **PARTIAL**, **NOT FIXED**, **UNVERIFIABLE** (runtime claims), and ⟶ for movement since report 4. Findings are condensed to their operative content; full histories live in reports 2–4.

## 21. P0 ledger (7 findings)

| ID | Finding (condensed) | v4 status | Notes |
|---|---|---|---|
| EDGE-P0-001 | Live credentials in artifact; rotation mandatory | **PARTIAL ⟶** | Scripts clean (held); dev keys rotated ⟶; **production rotation now REQUIRED** — the shipped refresh token (V4-004) is signed by the still-live prod secret; no scanning CI. |
| EDGE-P0-002 | Refund reverses wrong ledger row | **FIXED (held)** | Suite-confirmed. |
| EDGE-P0-003 | Refunds unbounded / instant completed | **FIXED (held, strengthened ⟶)** | Atomic bound + reserve-then-call (§18). |
| EDGE-P0-004 | Callback ignores amount & intent binding | **FIXED (held)** | payment.ts unchanged. |
| EDGE-P0-005 | Bootstrap default-credential chain / install lockout family | **PARTIAL (unchanged residuals)** | install.ts/bootstrap.ts byte-identical; auto-bootstrap on first request, KV-only lock, first-come `/install` race all persist. Ledger's FIXED row is an overclaim (V4-003 family). |
| EDGE-P0-006 | Checkout stored XSS + CSP | **FIXED (held)** | Suite-confirmed. |
| EDGE-P0-007 | SMS corroboration amount bypass | **FIXED (held)** | Suite-confirmed. |

## 22. P1 ledger (10 findings)

| ID | Finding (condensed) | v4 status | Notes |
|---|---|---|---|
| EDGE-P1-001 | Idempotency concurrency/keys | **FIXED (held)** | Endpoint-scoping residual persists (disclosed). |
| EDGE-P1-002 | Mobile OTP brute force | **FIXED (held, improved ⟶)** | Group mounts + CF-IP-only extraction + group keying (v4). |
| EDGE-P1-003 | Webhook body cap / event ids / geo | **PARTIAL (unchanged)** | Cap: see V3-005; event-id and geo residuals byte-identical. |
| EDGE-P1-004 | Outbound SSRF bypass vectors | **FIXED (held, strengthened ⟶)** | Opt-in flag at all four call sites. |
| EDGE-P1-005 | Merchant-admin tenant enumeration | **FIXED (held)** | Platform gate + claim token; typing improved. |
| EDGE-P1-006 | Status regression / reconciliation never heals payment rows | **PARTIAL (unchanged)** | Callback guards hold; reconciliation still heals ledger rows only. |
| EDGE-P1-007 | createIntent not atomic; auto-seed race | **NOT FIXED (unchanged)** | payment.ts byte-identical. Absent from the ledger. |
| EDGE-P1-008 | Read-scope keys can mutate | **FIXED (held)** | Method-based write-scope; typing cleaned. |
| EDGE-P1-009 | Security regression tests broken | **FIXED (held)** | 23/23 suites. |
| EDGE-P1-010 | KV rate-limit race; install group config; anonymous throttle | **PARTIAL ⟶** | Anonymous throttle improved (group keying ⟶); KV read-modify-write race persists; `/install*` group 120/min persists. |

## 23. P2 ledger (20 findings)

| ID | Finding (condensed) | v4 status | Notes |
|---|---|---|---|
| EDGE-P2-001 | CSRF middleware dead code | **NOT FIXED (unchanged)** | `csrf.ts` never mounted; state-changing web routes rely on it existing. The ledger's "EDGE-P2-001 FIXED" row collides with this ID and does not refer to it (V4-003). |
| EDGE-P2-002 | DO fault-injection seam | **NOT FIXED (unchanged)** | Test affordance; low risk. |
| EDGE-P2-003 | Platform merchant excluded from verification | **NOT FIXED (unchanged)** | |
| EDGE-P2-004 | Webhook master-domain platform binding | **NOT FIXED (unchanged)** | By design, undisclosed. |
| EDGE-P2-005 | Ratelimit binding absence fails open | **PARTIAL (unchanged code)** | Bindings present; fail-open-with-metric code path persists — and the alarm that would surface it is still dark in prod (V4-002). |
| EDGE-P2-006 | Analytics Engine disabled — metrics no-ops | **PARTIAL ⟶ (dev/staging only)** | Prod `wrangler.jsonc` still commented. **Ledger's FIXED row is false for production.** |
| EDGE-P2-007 | No webhook outbox | **NOT FIXED (unchanged)** | |
| EDGE-P2-008 | Mirror dedup drops identical journal lines | **NOT FIXED (unchanged)** | |
| EDGE-P2-009 | Wrong ENCRYPTION_KEY degrades silently | **NOT FIXED (unchanged)** | |
| EDGE-P2-010 | Single versionless ENCRYPTION_KEY | **NOT FIXED (unchanged)** | Blocks the P0-001 prod rotation story (re-encrypt migration). |
| EDGE-P2-011 | Break-glass not timing-safe; JWKS no timeout | **NOT FIXED (unchanged)** | |
| EDGE-P2-012 | LedgerDO doesn't verify caller identity | **NOT FIXED (architectural, unchanged)** | |
| EDGE-P2-013 | `key_prefix` lacks UNIQUE | **NOT FIXED (unchanged)** | |
| EDGE-P2-014 | Unbounded/unchecked inputs | **PARTIAL (unchanged this round)** | Hand-rolled bodies (install, checkout verify) remain shape-unvalidated. |
| EDGE-P2-015 | Merchant-editable regex → ReDoS | **NOT FIXED (unchanged)** | |
| EDGE-P2-016 | ENABLED_GATEWAYS unset ⇒ all gateways | **NOT FIXED (unchanged)** | |
| EDGE-P2-017 | PBKDF2 50K default; env floor 10K | **NOT FIXED (unchanged)** | |
| EDGE-P2-018 | No amount ceiling at boundary | **FIXED (held)** | moneySchema refine. |
| EDGE-P2-019 | Currency minor-unit exponents | **NOT FIXED (unchanged)** | |
| EDGE-P2-020 | Exchange rates unvalidated, no timeout | **NOT FIXED (unchanged)** | |

## 24. P3 ledger (12 findings)

| ID | Finding (condensed) | v4 status | Notes |
|---|---|---|---|
| EDGE-P3-001 | Dead schema states | **NOT FIXED (unchanged)** | Cosmetic. |
| EDGE-P3-002 | authSubject/device_id identity confusion | **PARTIAL ⟶** | Notification routes repaired (deviceId plumbing ⟶); heartbeat route still mis-keys (§19). |
| EDGE-P3-003 | Mobile ack cross-tenant | **FIXED ⟶ (verified + tested)** | The round's headline repair. |
| EDGE-P3-004 … 012 | (dead operand — see NEW ledger; static-asset / docs / mockup family: open proxy P3-006, etc.) | **NOT FIXED (unchanged)** | Spot-checks: mockup `/api/forward` open proxy ships in the artifact; `maintenance.ts` unescaped `info.reason`; static asset unreachable (now V4-007). |

## 25. NEW ledger (12 findings from report 3, the v0.3.0 release)

| ID | Finding (condensed) | v4 status |
|---|---|---|
| NEW-P1-001 | Root API key in plaintext KV at bootstrap | **FIXED (held)** — hash-only in D1 since v3 |
| NEW-P1-002 | Install/bootstrap-key unthrottled | **FIXED (held)** — password-group limits; improved keying ⟶ |
| NEW-P2-001 | Refund bound race | **FIXED (held, strengthened ⟶)** — reserve-then-call |
| NEW-P2-002/003 | Float compare / mandatory amount | **FIXED (held)** |
| NEW-P2-004 | Credential harvesting via admin API | **FIXED (held)** — claim token (V3-004 residual open) |
| NEW-P2-005 | Checkout abuse unthrottled | **FIXED (held, improved ⟶)** |
| NEW-P3-001 | sms-corroboration dead operand | **FIXED (held)** |
| NEW-P3-002 | ESLint pipeline broken | **FIXED (held)** — 0/0 now |
| NEW-P3-003/004 | misc hygiene | **FIXED (held) / open as V3-004** |
| NEW-P3-005… | (see report 3 for enumeration) | unchanged |

## 26. V3 ledger (11 findings from report 4, the first remediation release)

| ID | Finding (condensed) | v4 status | Notes |
|---|---|---|---|
| V3-001 | False FIXED claim (P3-003) | **FIXED ⟶ (verified + tested)** | The claim became true this round. |
| V3-002 | sendTest persists unvalidated URLs | **FIXED ⟶** | §14.2. |
| V3-003 | Refund ghost-call ordering | **FIXED ⟶** | §14.3/§18. |
| V3-004 | Claim creds in plaintext KV 15 min | **NOT FIXED (unclaimed)** | Disclosed trade-off; optional encrypt-with-ENCRYPTION_KEY hardening stands. |
| V3-005 | Header-only payload cap | **NOT FIXED in core ⟶ (live PoC)** | §14.4/§6. |
| V3-006 | Per-path anon limits; KV race | **FIXED-as-scoped ⟶ / race open** | §14.5. |
| V3-007 | ENVIRONMENT-inferred SSRF carve-out | **FIXED ⟶** | §14.6. |
| V3-008 | Auto-bootstrap first-request lockout | **NOT FIXED (unclaimed)** | Byte-identical block; health-probe scenario stands. |
| V3-009 | `any`-typed security middleware | **FIXED ⟶** | §14.7. |
| V3-010 | Claim route redeemable by any admin key | **NOT FIXED (unclaimed)** | No `requirePlatformAdmin` on `/merchants/claim` (verified §14 audits). |
| V3-011 | Claims not checkable by construction | **HALF-FIXED ⟶** | Ledger exists; integrity fails (V4-001/002/003). |

## 27. V4 ledger (11 new findings, this report)

Detailed in §29. Summary:

| ID | Severity | Finding |
|---|---|---|
| V4-001 | P2 (process) | REMEDIATIONS.md cites verification tests that do not exist (5 rows) |
| V4-002 | P2 | "Analytics active" claimed; production config still commented out |
| V4-003 | P2 (process) | Ledger ID-scheme collisions (7 rows) vs. series finding IDs |
| V4-004 | **P2→P1 urgency** | Live production refresh token shipped in the artifact |
| V4-005 | P2 | Payload cap still bypassable for headerless bodies — claimed FIXED, live-proven open |
| V4-006 | P3 (process) | "100% Healthy / Fully Fixed" verdict contradicted by ≥31 open findings |
| V4-007 | P4 | Asset route unreachable (path double-prefix); 500-crash fixed, serving still decorative |
| V4-008 | P3 (process) | Ledger omits 42 of 72 tracked findings under a comprehensive title |
| V4-009 | P4 | TEST_RESULTS.md stale (documents v0.2.3, 11 files / 104 tests) |
| V4-010 | P4 | Payload cap method-scoping dropped DELETE-with-body from coverage |
| V4-011 | P3 (process) | No CI gate — the enforcement half of the V3-011 fix was not built |

## 28. Movement analysis (v3 → v4)

```text
Series totals (72 tracked):                 v3 status → v4 status
  FIXED / FIXED-held          31   →   38   (+7: V3-001, V3-002, V3-003, V3-006*,
                                               V3-007, V3-009, static-500; P2-006
                                               dev-half does not count)
  PARTIAL                     12   →   12   (P0-001 improved; P1-010 improved;
                                               P3-002 improved; P0-005/P1-006/P1-003/
                                               P2-005/P2-006/P2-014 unchanged)
  NOT FIXED                   26   →   24   (V3-005 core remains open but its row moved
                                               to "claimed-fixed-but-open"; V3-008/V3-010
                                               unchanged; +11 new V4 findings net of
                                               fixed V3 rows)
  False/integrity findings    1    →   5    (V3-001 resolved; V4-001, V4-002, V4-003,
                                               V4-005-claim, V4-006 added)
  Test suite                   22 files / 218 tests  →  23 files / 220 tests
  Lint                         42 warnings          → 0 warnings
  Type surface                 clean                → clean
  Money-path P0s               all closed           → all closed + strengthened
```

The shape of the movement is the story: **code quality monotonically improved; process integrity did not.** The single false claim of v3 was replaced by five evidence-layer defects in v4. The code fixes earned trust; the ledger spent it.

---

# PART VI — FRESH AUDIT OF THE REMEDIATED CODE (NEW FINDINGS)

## 29. V4-001 … V4-011

### 29.1 V4-001 — The remediation ledger cites verification tests that do not exist (P2, process/integrity)

**Where:** `docs/REMEDIATIONS.md`, Verification Test ID column — rows V3-002, V3-003, V3-005, V3-006, V3-007.
**What:** each row names a test file (and, for V3-003, a described test case: "Reserve-then-call: atomic DB reservation BEFORE gateway call") as the verification for its fix. File-identity checks prove `url-guard.test.ts` and `api-middleware.test.ts` are byte-identical to v3, and the v3→v4 diff of `payment-integrity.test.ts` contains typing generics and two timeout bumps with **no new `describe`/`it` blocks**. The cited coverage does not exist anywhere in the artifact.
**Why it matters:** the ledger was created specifically to make remediation claims checkable by construction (V3-011). Citing nonexistent tests is strictly worse than citing nothing: a reader who trusts the column stops looking; a CI gate built on this column would green-light rows with zero coverage. It also means the round's most important fixes (the refund reordering, the SSRF opt-in) shipped **without regression tests** — verified by this auditor by code reading and probe, but unprotected against future regressions.
**Fix:** write the five tests (each is small: a sendTest-with-bad-URL 400 case; a refund-ordering assertion via a gateway double; a headerless-body 413-or-411 case; a rate-limit key-shape assertion; a flag-default strict case), then wire the CI gate of V4-011 to the column so a missing test fails the build.

### 29.2 V4-002 — "Analytics Engine active" is false for production (P2)

**Where:** `docs/REMEDIATIONS.md` row EDGE-P2-006 vs `wrangler.jsonc` (production), `wrangler.dev.jsonc`, `wrangler.staging.jsonc`.
**What:** the row states "Verified `analytics_engine_datasets` active and bound to `ANALYTICS`." The dev and staging configs had the binding uncommented; the production config — the one `wrangler deploy` uses — still has it commented out (only the comment prose changed, plus a dashboard URL). `src/lib/observability.ts`, listed as a modified file, is byte-identical to v3.
**Why it matters:** this was report 4's risk #3, priced at minutes to fix, because every metrics write (including the **rate-limit binding degradation alarm** that P2-005's fail-open path emits) is a silent no-op without the binding. The operator believes telemetry is live; it is dark in the environment that matters.
**Fix:** uncomment the block in `wrangler.jsonc`, deploy, verify the dataset is receiving rows (`wrangler tail` + dashboard). Then make the ledger row true.

### 29.3 V4-003 — Ledger ID-scheme collisions manufacture phantom fixes (P2, process)

**Where:** `docs/REMEDIATIONS.md` rows EDGE-P2-001…EDGE-P2-005, EDGE-P3-001, EDGE-P3-002.
**What:** these seven rows describe (accurately, as fixes) the findings that report 1 filed as **NEW-P2-001…NEW-P2-005 and NEW-P3-001/002** — but they relabel them with the `EDGE-` prefix, which in the series' consolidated ledger (report 4 §17–21) denotes seven **different, mostly still-open findings**. Worked example: ledger "EDGE-P2-001 | FIXED | refund.ts | atomic conditional INSERT" vs series EDGE-P2-001 "CSRF middleware is dead code — NOT FIXED." An operator reconciling the ledger against the audit series concludes the CSRF finding was fixed. It was not; `csrf.ts` is still referenced nowhere.
**Why it matters:** the ledger is meant to be the join key between audits and code. Broken keys don't just lose information — they fabricate it.
**Fix:** renumber the seven rows to the series' actual IDs (NEW-P2-001…005, NEW-P3-001, NEW-P3-002 — or a disambiguating suffix), and add a finding-ID registry (appendix F of this report is a starting template) mapping every ID to its first-appearance report.

### 29.4 V4-004 — A live production refresh token ships in the artifact (P2, treated as P1-urgent)

**Where:** `sms-phone-mockup/.companion-state.json` — in both `edgepay-cf-clean-new-1.zip` (missed by report 4) and `edgepay-cf-clean-new-2.zip`.
**What:** the mockup's runtime state file contains, among session fields, `jwt_token` (already expired) and `refresh_token` — a **production-signed** refresh JWT decoded as:

```text
iss edgepay-cf | aud mobile | type refresh
merchant_id 8 | sub 6 | device_id 4 | scope [read, write]
iat 2026-09-01T00:43:51Z | exp 2026-10-01T00:43:51Z   ← 29 days of life at audit time
target https://edgepay-cf.bm-jonybepary.workers.dev    (edgepay_url field — production)
```

The refresh endpoints (`POST /api/mobile/v1/refresh`, `/api/mobile/v1/devices/token-refreshes`, `mobile.ts:102–119`) verify the token and mint access tokens with **no additional authentication** (they sit before the JWT middleware and carry no anonymous rate-limit group). The file is not gitignored; the heartbeat timestamp in the v4 copy (2026-09-02T03:12:15Z) shows active use against production minutes before the zip was cut.
**Impact:** anyone holding either distributed zip can maintain read/write mobile-API access to merchant 8 on the production worker through October 1. Bounded to one non-platform merchant's mobile surface — not admin, not money — hence P2; but it is a *live credential in a distributed artifact*, and it is dispositive evidence that the production `JWT_SECRET` predates 2026-09-01 and has not been rotated.
**Fix (immediate):** rotate the production `JWT_SECRET` (`wrangler secret put JWT_SECRET`) — this single action invalidates the leaked token, every other outstanding mobile token, and closes the production half of EDGE-P0-001 in one step. Then: gitignore `sms-phone-mockup/.companion-state.json` (and any `*-state.json`), purge it from the distribution, and re-issue the developer's own pairing after rotation.

### 29.5 V4-005 — The payload cap is claimed fixed and live-bypassed (P2)

Covered in §6 with the live proof. The ledger row says FIXED (citing an unchanged test); the artifact demonstrates the bypass; the developer's own claim language ("guard mutating HTTP methods") describes a different (and smaller) change than the finding required. The 15-line streamed-reader or 411-when-absent middleware from report 4's fix menu remains the correct fix and remains unwritten.

### 29.6 V4-006 — The "100% Healthy and Fully Fixed" verdict (P3, process)

The summary's overall verdict is contradicted by the artifact on four axes: ≥31 open findings (30 series NOT/PARTIAL + V3-004/008/010), one open finding claimed fixed (V3-005 core), one false production-config claim (V4-002), and one shipped credential (V4-004). The verdict language converts a good release into a false one. The honest sentence was available: "all ten claimed code fixes implemented, suite green, N findings open." Nothing about V4-006 is a code defect; everything about it is an operator-safety defect.

### 29.7 V4-007 — Static asset serving remains decorative (P4)

The 500-crash on `/assets/*` is fixed (probe-verified), but the route still cannot serve any file: the handler forwards the full path (`/assets/css/checkout.css`) to an ASSETS binding rooted at `./public/assets`, which resolves to `public/assets/assets/css/checkout.css` → 404 for every possible asset. Nothing in the application references the shipped `checkout.css`, so there is no user-facing breakage — but the subsystem that was just debugged is still a no-op. Fix: rewrite the path (strip the `/assets` prefix) before `ASSETS.fetch`, or point `directory` at `./public` and pass through. (This also explains why the crash was only ever seen on not-found asset requests — the only requests the route can generate.)

### 29.8 V4-008 — Selective coverage under a comprehensive title (P3, process)

The ledger's preamble claims a record of "all findings and remediations across the audit series"; it lists 30 of 72 tracked findings. The omitted 42 are precisely the NOT FIXED set. A ledger that lists only what was fixed is a changelog, not a control plane — the operator loses the ability to see the open risk from inside the repository. Fix: either include all 72 rows with honest statuses, or retitle the file "Remediated findings ledger" and link the audit reports for the open set.

### 29.9 V4-009 — Stale TEST_RESULTS.md (P4)

The repo-root `TEST_RESULTS.md` still documents v0.2.3 with "11 passed (11) / 104 passed (104) / ~5s" — three releases and 116 tests ago. Doc drift of this kind is how "100% healthy" narratives accrete. Update or delete it (the REMEDIATIONS.md ledger and CI output should be the single source of truth).

### 29.10 V4-010 — Payload cap method-scoping dropped DELETE-with-body (P4)

Scoping the check to POST/PUT/PATCH means a DELETE carrying a declared >128 KB body is no longer 413'd at the edge (v3 checked any method when a Content-Length was present). No current route parses DELETE bodies, so the exposure is theoretical; note it for the V3-005 rewrite, which should either cover all body-bearing methods or pair the scope with an explicit allowlist.

### 29.11 V4-011 — No CI gate behind the ledger (P3, process)

The V3-011 recommendation was two-part: the ledger artifact **and** enforcement ("CI fails if a FIXED row's test is missing or skipped"). The repo ships no CI at all (no `.github/`). The five fabricated citations of V4-001 are exactly the failure the gate exists to catch — and would have caught on this release's first commit. A minimal gate is ~60 lines: parse REMEDIATIONS.md, for each FIXED row resolve the cited test ids in the vitest manifest, fail if unresolved or skipped, and fail on any `as any` regression in src/ while it's at it.

## 30. The remediation-integrity synthesis (second consecutive release)

Report 4's synthesis said: "the release's engineering is materially better than its reporting." The v4 data sharpen that sentence rather than change it:

```text
                     report 4 (v3)                    this report (v4)
Engineering        14 claimed fixes, 13 real,        10 claimed code fixes, 9 real,
                   1 fabricated (no code change)     1 materially incomplete
Evidence layer     no ledger; claims re-derived      ledger exists; 5 fabricated
                   by the auditor                    citations; 1 false config claim;
                                                     7 broken ID keys; 42 omitted rows
Suite              22 files / 218 tests              23 files / 220 tests (new tests
                                                     cover the formerly-false claim)
Overall verdict    "all FIXED" (false)               "100% Healthy and Fully Fixed"
                                                     (false; more qualified in body)
```

The v3 failure was a claim with no code. The v4 failures are code with no evidence, an evidence column with no referents, and a verdict with no relationship to the ledger either file describes. From the operator's chair these are the same event: **the tracking signal cannot be trusted without an independent audit**, which is why this series exists and why the CI gate (V4-011) is the single highest-leverage process fix available: it converts claim-checking from a per-release forensic exercise into a mechanical invariant.

The constructive reading deserves the last word: this release *did the hard things* — the refund race is closed at the database, the SSRF invariant is restored end-to-end, the false claim of the last round was converted into a passing regression test, the type surface is clean, and 220 tests run green with zero skips. A team that does this work is a team that can do the ledger work. The gap is not competence; it is that nobody is currently paid (in failed builds) to keep the story straight.

---

# PART VII — CURRENT ARCHITECTURE (VERIFIED, AS-BUILT, V4 DELTA)

## 31. Single-worker reality and binding inventory (v4 delta)

v4 remains a **single Worker** (one `src/index.ts`, one wrangler deployment unit, `run_worker_first: true`) serving all 52 routes across 7 controllers, with the binding inventory unchanged except where noted. Verified against the shipped configs:

| Binding | Prod (`wrangler.jsonc`) | Dev | Notes |
|---|---|---|---|
| D1 `DB` | ✅ | ✅ | migrations 0001–0004; `key_prefix` still non-UNIQUE (P2-013) |
| KV `KV` | ✅ | ✅ | still hosts rate-limit counters (P1-010 race), claim tokens (V3-004), bootstrap locks (P0-005) |
| DO `LEDGER` | ✅ | ✅ | per-merchant ledger authority; identity-check gap unchanged (P2-012) |
| Queues (webhook/email/sms) | ✅ | ✅ | no outbox (P2-007) |
| Ratelimit READ/WRITE | ✅ 120/60, 30/60 | ✅ | fail-open code path unchanged (P2-005) |
| **ANALYTICS** | ❌ **still commented** | ✅ enabled ⟶ | staging enabled ⟶ — V4-002 |
| ASSETS | ✅ | ✅ | route unreachable (V4-007) |
| AI (sms parser) | opt-in | opt-in | unchanged |
| Workflows (refund-recon, recon-sweep) | ✅ | ✅ | unchanged |

`ALLOW_LOCAL_WEBHOOK_TARGETS` is now a recognized (optional) var in `env.ts`, defaulting unset ⇒ strict SSRF guard.

## 32. Trust boundaries and route inventory (unchanged, re-verified)

The 52-route inventory and trust-boundary map of report 4 §25–27 were re-verified by checksum: no route was added, removed, or re-scoped this round. The v4 changes tighten *inside* the existing boundaries (notification scoping, guard call sites, middleware typing) without moving any boundary. The customer-facing surface remains: `/api/v1/*` (bearer API), `/api/mobile/v1/*` (mobile JWT), `/api/admin/v1/*` (bearer + platform gates), `/checkout/*` (public token-gated), `/install*` (first-run), `/webhook/*` (inbound gateway callbacks), `/api/reference` (docs).

## 33. What v4's verified fixes mean for the migration plan

The four-worker blueprint of report 4 (Parts VIII–X there) stands unchanged; v4's diffs interact with it in five specific ways:

1. **The reserve-then-call refund pattern is now the reference implementation for the core worker's money methods** (§35 of that report called for exactly this during migration; it is now in-repo and merely needs to be kept). The migration rider "fix V3-003 while moving" is satisfied — one less rider.
2. **The SSRF opt-in flag is the correct shape for the split**: `ALLOW_LOCAL_WEBHOOK_TARGETS` as an explicit, default-off var on the *delivery* worker (the only worker that should ever hold it) is precisely how report 4's blueprint wanted environment inference replaced. The migration plan should note the flag belongs on the webhook-delivery worker alone, never on the frontends.
3. **The notification-scoping fix demonstrates the authorize-seam discipline the split demands**: `deviceId` derived once from the verified token, bound into every scoped write. The heartbeat route (§19) is the counter-example that proves the rule: per-handler identity choices regress silently; a single `authorize(principal)` seam does not. This is D-track test class D9's justification, now with in-repo evidence on both sides.
4. **V4-004 (the leaked refresh token) strengthens the secret-boundary argument**: a frontend worker holding no signing secret cannot mint or validate mobile JWTs; the refresh flow belongs in the auth surface of the worker that owns the secret. The leak also adds a concrete migration step: rotate, then split.
5. **V4-001/V4-011 (ledger integrity + no gate) convert the D-track's "mechanized claims" from advisory to mandatory**: the split's migration report should itself be generated from the same ledger format, and the CI gate should run in every worker repo from day one — the failure mode this round demonstrated (claims authored from intent) is exactly what multi-repo migrations amplify.

---

# PART VIII — MULTI-WORKER / CUSTOMER-FACING REST / WORKER-RPC CARRY-FORWARD

## 34. Status of the four-worker blueprint against v4

Report 4's target topology (core + checkout/frontend + admin frontend + delivery worker, connected by Service Bindings with typed Worker RPC; public REST surface reduced to the customer contract) remains the recommended end-state. Nothing in v4 changes the topology decision; the file-level migration map needs only these deltas:

```text
carried riders resolved by v4 (remove from the migration fix-list):
  - V3-003 refund ghost-call ordering   → fixed in core (refund.ts)
  - V3-002 sendTest URL validation      → fixed in core (dispatcher)
  - V3-007 environment-inferred SSRF    → fixed (explicit flag; assign to delivery worker)
  - V3-009 middleware typing            → fixed (simplifies RPC contract typing)

riders still open (unchanged):
  - P0-005/V3-008  install lock → D1 + admin-worker first-run flow
  - V3-010         claim route platform gate
  - P1-007         createIntent atomicity
  - P2-001         CSRF middleware: mount (or delete) during the web-surface move
  - P2-006/V4-002  prod analytics enablement (precondition, not a rider)
  - P1-010/V3-006  anonymous counters → Ratelimit binding (per frontend)
  - V3-005/V4-005  streamed cap → each frontend's new index.ts (the guard is
                    written as part of writing the worker, per report 4 §1245)
```

## 35. Updates to the RPC contract and migration riders

The RPC contract of report 4 §31 needs one addition and one annotation:

- **Add `redeemClaim` to `ADMIN_RPC` with a platform-principal guard** (it was listed there as the V3-010 fix; v4 did not implement it in the monolith, so it stays a contract requirement: `redeemClaim(ctx: CallerContext, claimToken)` where `ctx.principal.platform === true` is enforced *inside* core, not by route placement).
- **Annotate `refund*` methods with the reserve-then-call invariant**: `RefundRPC.processRefund` must preserve "atomic reservation before gateway call" as a core-internal invariant covered by a test id in the ledger — the pattern is now in the code; the contract should pin it so the split cannot silently reorder it back.

The phased zero-downtime plan (report 4 §36: bind → route-by-route cutover → frontends → delete public admin routes) is unchanged; v4's green suite (220 tests) is the regression net the cutover steps lean on.

## 36. The mechanized-claims requirement (D-track) — now mandatory, not advisory

Report 4 made the ledger a recommendation. This report upgrades it to a **migration precondition**:

1. **The gate ships before the split**: `REMEDIATIONS.md` (corrected per §15) + a CI job that parses it, resolves every FIXED row's test id against the vitest manifest, and fails the build on unresolved or skipped ids; plus a repo-wide `as any` tripwire (v4 proved both fixes are achievable — 0 casts, 0 warnings).
2. **Every migration phase emits ledger rows**: `{phase, finding-id-or-task, files, hunks, test-ids, status}` — the same schema, generated by the same CI. The multi-worker migration is the highest-claim-density event in the platform's future; it must be the first fully mechanized one.
3. **The ID registry is frozen** (appendix F): no new finding IDs may collide with the series' ledger; the seven v4 collisions get aliased entries mapping ledger text → series ID.

---

# PART IX — PRIORITIZED REMEDIATION PLAN & HONEST FIX-LIST

## 37. The 7-day fix-list (operator actions, in order)

| # | Action | Closes | Effort |
|---|---|---|---|
| 1 | **Rotate the production `JWT_SECRET`** (`wrangler secret put JWT_SECRET`); re-pair the developer's mockup; verify the leaked refresh token now 401s | V4-004; EDGE-P0-001 (prod half) | minutes |
| 2 | Purge `sms-phone-mockup/.companion-state.json` from the repo; gitignore it; re-cut the distribution | V4-004 (distribution half) | minutes |
| 3 | Uncomment `analytics_engine_datasets` in **production** `wrangler.jsonc`; deploy; verify rows arriving | V4-002; EDGE-P2-006 | minutes |
| 4 | Correct REMEDIATIONS.md: fix the 7 ID collisions, the 2 FIXED-on-unchanged-file rows (P0-005, P1-006 → PARTIAL), the P2-006 row, and the 5 test citations; add the 42 missing rows (or retitle); delete or update stale TEST_RESULTS.md | V4-001, V4-003, V4-006, V4-008, V4-009 | ~1 hour |
| 5 | Write the five missing tests (sendTest 400 case; refund ordering via gateway double; headerless-body cap case; rate-limit key shape; flag-default strict) | V4-001 coverage half | ~half day |
| 6 | Replace the payload cap with a streamed reader (or 411-when-absent on POST/PUT/PATCH) | V3-005 / V4-005; V4-010 | 15 lines + test |
| 7 | Add the CI gate (ledger + `as any` tripwire + counts assertion) | V4-011 | ~half day |

## 38. The 30/90-day roadmap

**30 days (pre-pilot):** mount or delete `csrf.ts` (P2-001 — mounting it is the safe choice for the web surface); `requirePlatformAdmin` on `/merchants/claim` (V3-010); auto-bootstrap gate — `AUTO_BOOTSTRAP=1` var or stop setting `system:installed` from the auto path (P0-005/V3-008); createIntent atomicity via UNIQUE `(merchant_id, slug)` + `ON CONFLICT` (P1-007); PBKDF2 default to 600K with floor raise (P2-017); anonymous counters → Ratelimit binding (P1-010 race); encrypt claim blobs with ENCRYPTION_KEY (V3-004 optional hardening); asset route path fix or removal (V4-007); heartbeat deviceId one-liner (P3-002 remainder); merchant-regex allowlist or `safe-regex` screening (P2-015).

**90 days (pre-real-money):** ENCRYPTION_KEY versioning + re-encrypt migration path (P2-010 — also the durable P0-001 close); webhook outbox (P2-007); reconciliation heals payment/transaction rows (P1-006 remainder); event-id determinism for inbound webhooks (P1-003 remainder); D1 lock for install (P0-005 remainder); exchange-rate validation + fetch timeout (P2-020); JWKS fetch timeout (P2-011); the four-worker split per report 4 Parts VIII–X with the mechanized-claims precondition of §36.

## 39. Deployment and process recommendations

1. **Ship the corrected ledger with every release, generated not authored**: claims should be emitted by the same tooling that runs the tests, so the Verification Test ID column cannot contain intent. Until tooling exists, a human other than the author signs the ledger.
2. **Never distribute working-tree zips**: cut artifacts from a clean checkout with an explicit include-list (git archive). This single habit would have kept `.dev.vars`, `.companion-state.json`, and `node_modules` out of every zip this series has audited.
3. **Treat production telemetry as a deployment gate**: a release whose prod config leaves the metrics binding dark does not ship. (This round is the second time the alarm path's darkness has been carried.)
4. **Rotate on schedule, not on incident**: JWT_SECRET and ENCRYPTION_KEY (the latter after versioning lands) on a 90-day cadence, with the rotation event logged in the ledger.
5. **Keep the suite's adversarial posture**: the 400/401/403 noise in CI is the sound of the security tests working — the developer's framing in this round's summary was exactly right and should be preserved in team documentation.

---


---

# PART X — COMPREHENSIVE COMPARISON & SERIES RETROSPECTIVE

## 40. The five-release evolution (v0.1 → v0.4)

The series has now audited five artifacts. The table below is the consolidated history — every release's input state, its remediation claims, and what the audit actually found. It exists because the individual reports' verdicts only become decision-grade when read as a trajectory: **is the system converging?**

| Release | Artifact | Size | Claims made | Claims verified true | Claims false/overstated | New findings filed |
|---|---|---|---|---|---|---|
| v0.1 (baseline) | `edgepay-cf-clean.zip` | ~660 KB | (none — first audit) | n/a | n/a | 49 (report 1: 7 P0, 10 P1, 20 P2, 12 P3) |
| v0.3.0 (pre-remediation) | (report 2's target) | ~870 KB | n/a | n/a | n/a | 12 NEW-* (report 3) |
| v0.3.0-r1 | `edgepay-cf-clean-new.zip` | 866 KB | "all findings fixed" | ~13/15 substantive | 1 fabricated (P3-003 no code change) + material under-disclosures | 11 V3-* (report 4) |
| v0.3.0-r2 | `edgepay-cf-clean-new-1.zip` | 870 KB | 15 rows / 22 IDs "FIXED" | 13/15 held; 1 false; 1 partial | P3-003 false claim; P0-001 rotation absent | 11 V3-* (report 4, incl. the integrity finding) |
| v0.4.0 (this audit) | `edgepay-cf-clean-new-2.zip` | 954 KB | 10 code claims + "100% healthy" + 30-row ledger | 9/10 code claims real; battery exact | V3-005 "FIXED" (live-bypassed); P2-006 "FIXED" (prod dark); 5 fabricated test citations; 7 ID collisions; verdict false | 11 V4-* (this report) |

**Convergence verdict: the codebase is converging; the reporting layer is oscillating.** Every code-level metric improved monotonically — money-path P0s 7→0 open; refund/callback race windows closed and stayed closed; test suite 4→11→22→23 files; lint 42 warnings→0; type surface clean. No fix has ever regressed across releases (verified each round by re-running the accumulated suites). But the claim-integrity metrics do not improve: each round produces a new class of reporting failure (fabricated claim → fabricated citations + false config claim + broken ID keys). The engineering process learns; the reporting process does not — because nothing in the toolchain ever fails when a claim is wrong. That asymmetry is the entire argument for V4-011's CI gate.

## 41. Claim-integrity evolution across three remediation rounds

```text
Round 1 (v0.3.0-r1) — "summary authored from intent"
  Failure class:   FIXED claimed with zero code change (P3-003)
  Detection cost:  full re-derivation of all 15 rows by the auditor
  Root cause:      no artifact tie between claim and diff; no test requirement
  Auditor remedy:  report 3 demanded diff-hunk + test-id citations

Round 2 (v0.3.0-r2) — "code honest, summary overclaims"
  Failure class:   1 false claim (same finding, again zero change);
                   under-disclosed residuals (P0-001 rotation, sendTest,
                   KV claim storage, header-only cap, per-path limiters)
  Detection cost:  moderate (diff authorship exposes unchanged files quickly)
  Root cause:      claims still hand-authored; no ledger; no gate
  Auditor remedy:  report 4 demanded REMEDIATIONS.md + CI fails-on-missing-test

Round 3 (v0.4.0) — "ledger exists, evidence fabricated"  (this report)
  Failure class:   5 rows cite tests that were never written;
                   1 row false for production config;
                   2 rows FIXED on byte-identical files;
                   7 rows carry IDs that alias to different open findings;
                   42 of 72 findings omitted; no gate
  Detection cost:  LOW where the gate would be: file-hash + manifest
                   resolution catches every instance mechanically
  Root cause:      the ledger was authored (by hand) instead of generated;
                   the gate was recommended but not built
  Auditor remedy:  §36 upgrades the gate to a migration precondition;
                   appendix D is the corrected ledger as a starting artifact
```

The trajectory of failure classes is itself informative: each round's reporting failure is *one level more subtle* than the last (no code → no disclosure → no evidence). A hand-authored claims layer will keep finding new ways to be wrong; a generated one cannot mis-cite a test that doesn't resolve, cannot claim a file it didn't touch, and cannot alias an ID that the registry freezes. This is why report 4's "cheapest control in the whole report" line deserves emphasis: the ledger-plus-gate is estimated at under a day of work, and this round's five V4-001-class defects are precisely what it costs not to have it.

## 42. Test-suite evolution and what each round's tests actually protect

```text
Release    Files  Tests  New this round                          Protected property
v0.1         4      ~20   (baseline)                              boot, smoke, money basics
v0.3.0      11     104   tenant-routing, jwt, api-middleware,     tenancy, auth, idempotency,
                        gateways, money, ledger-do…               gateway config, ledger shape
v0.3.0-r1   22     218   + adversarial parsers, url-guard,        SSRF vectors, parser
                        payment-integrity, workflow-policy,       edge cases, refund bounds,
                        sms-corroboration, runtime-integrity…     workflow policies
v0.3.0-r2   22     218   (none — the false-claim round)           —
v0.4.0      23     220   + mobile-notifications (2 tests)         cross-tenant/device scoping
```

Two observations the table makes visible. First, **the suite's growth is entirely remediation-driven**: every new suite maps to a finding family, which is the correct causal direction (tests born from failures). Second, **the v4 delta is exactly two tests** — the notification scoping pair — and nothing for the round's other nine code changes. The changes most in need of regression protection (the refund ordering, the SSRF call-site migration, the cap behavior) are the ones whose ledger citations this report proved empty. The suite is strong where past failures pointed; it is silent exactly where this round's changes landed. §37 item 5 (write the five missing tests) closes that gap at an estimated half-day.

## 43. Security-property scorecard (20 invariants × 5 releases)

The series' findings reduce to twenty testable invariants. Reading them as rows rather than as 72 findings shows where the platform actually stands:

| # | Invariant | v0.1 | v0.3.0 | r1 | r2 | v0.4 |
|---|---|---|---|---|---|---|
| 1 | Refund total never exceeds captured amount (atomically) | ✗ | ✗ | ✗ | ✓ | ✓ (strengthened: pre-gateway) |
| 2 | Gateway refunds only for DB-recorded refunds | ✗ | ✗ | ✗ | ✗ | **✓ (reserve-then-call)** |
| 3 | Callback amount must match intent exactly (decimal-safe) | ✗ | ✗ | ✓ | ✓ | ✓ |
| 4 | Ledger postings idempotent by public id | ✗ | ✓ | ✓ | ✓ | ✓ |
| 5 | Terminal payment states cannot regress | ✗ | ✗ | ✓ | ✓ | ✓ (callback paths; recon heals ledger only) |
| 6 | Every mobile write is merchant- and device-scoped | ✗ | ✗ | ✗ | ✗ | **✓ (notifications; heartbeat residual)** |
| 7 | Read-scope keys cannot mutate | ✗ | ✗ | ✓ | ✓ | ✓ |
| 8 | Platform-admin surface gated by is_platform | ✗ | ✗ | ✓ | ✓ | ✓ (claim route exception open) |
| 9 | Merchant credentials never returned by API | ✗ | ✗ | ✓ | ✓ | ✓ (claim-token; KV-at-rest residual) |
| 10 | Every stored webhook URL passed the SSRF guard | ✗ | ✗ | ✗ | ✗ | **✓ (sendTest fixed)** |
| 11 | Outbound fetches cannot reach private space (all encodings) | ✗ | ✗ | ✓ | ✓ | ✓ (string-level residuals, platform-mitigated) |
| 12 | SSRF dev carve-outs require explicit opt-in | n/a | ✗ | ✗ | ✗ | **✓ (ALLOW_LOCAL_WEBHOOK_TARGETS)** |
| 13 | Request bodies bounded ≤128 KB at the edge | ✗ | ✗ | ✓* | ✓* | ✗* (*header-only — live bypass proof this round) |
| 14 | Anonymous surfaces rate-limited per real client IP | ✗ | ✗ | ✓ | ✓ | ✓ (CF-IP; group keying; KV race open) |
| 15 | Credentials never committed to the artifact | ✗ | ✗ | ✗ | ✗ | ✗ (**live prod refresh token** — new class) |
| 16 | Secrets rotatable without re-deploy pain | ✗ | ✗ | ✗ | ✗ | ✗ (versionless ENCRYPTION_KEY) |
| 17 | Security telemetry emits observable signals | ✗ | ✗ | ✗ | ✗ | ✗ in prod (dev/staging ✓; ledger says otherwise) |
| 18 | Install/bootstrap cannot lock out the operator | ✗ | ✗ | ✗ | ✗ | ✗ |
| 19 | State-changing web routes CSRF-protected | ✗ | ✗ | ✗ | ✗ | ✗ (middleware still dead code) |
| 20 | Remediation claims are artifact-checkable | n/a | ✗ | ✗ | ✗ | ✗ (ledger exists; integrity fails) |

Twelve of twenty invariants hold under v0.4; three were newly earned this round (2, 6, 12); one regressed in relative terms (13 — claimed fixed while bypassable). The eight open invariants cluster exactly where the 90-day roadmap of §38 points: credential hygiene (15, 16), telemetry (17), first-run safety (18), web-session integrity (19), and process (20). The scorecard is the single-page answer to "how far from production-ready is this platform?"

## 44. Readiness verdicts across the series

```text
report 1 (v0.1):        NOT production-ready — 7 P0s incl. five money-path
report 2 (v0.3.0):      NOT production-ready — money P0s remediation pending
report 3 (r1):          NOT production-ready — 1 false claim; residuals
report 4 (r2):          HOLD — strong code round; false claim + rotation gate
report 5 (v0.4, this):  CONDITIONAL HOLD — pilot-eligible after 3 operator
                        actions (rotate prod secret; enable prod analytics;
                        correct the ledger); real money gated on §38's 90-day list
```

The verdict language has tightened each round as the codebase earned it. The v0.4 verdict is the first in the series to offer a concrete, short, operator-executable path to pilot eligibility — because for the first time the blocking items are hours-scale operator actions rather than days-scale engineering.

## 45. Cost-of-delay analysis

Which findings got more expensive by not being fixed when first filed:

| Finding | First filed | Then | Now (v0.4) | Cost curve |
|---|---|---|---|---|
| ENCRYPTION_KEY versioning (P2-010) | report 2 | blocks clean rotation | still blocks it; now also the durable fix for V4-004's class | **compounding** — every day adds ciphertexts bound to a single unversioned key |
| Analytics enablement (P2-006) | report 2 | silent metrics | dev/staging on, prod dark; ledger false | flat but **misleading** — the operator believes it closed |
| CSRF mount (P2-001) | report 2 | dead code | dead code; ledger ID now falsely signals fixed | flat, **risk-ambiguous** — depends on whether any cookie-authed web route ever ships |
| createIntent atomicity (P1-007) | report 2 | double-seed race | unchanged | flat, low probability × moderate impact |
| Claim-route gating (V3-010) | report 4 | any admin key | unchanged | flat, bounded by token entropy |
| Ledger integrity (V3-011→V4-001/003/008/011) | report 4 | "make claims checkable" | ledger shipped uncheckable; 5 fabricated citations | **the series' purest cost-of-delay story**: the fix was half-built, and its absence this round cost five new findings, an operator-correction cycle, and this report's §15 |

The pattern: money-path and race-condition findings got fixed promptly (their cost curves are steep and visible); process and hygiene findings compound quietly. In a payments platform the quiet ones are what eventually produce the expensive incident — V4-004 (a production credential in a zip) is precisely the compound interest on "ship clean artifacts," filed as advice in report 2 and still unpriced in the repo's tooling.

---

# PART XI — SELF-CONTAINED ARCHITECTURE BLUEPRINT (CARRIED FORWARD, UPDATED)

*This part condenses report 4's Parts VIII–X so the current report stands alone for an engineer who has not read the prior volumes. Nothing here changes the prior recommendation; v4's verified deltas are annotated inline (⟵ v4).*

## 46. Target topology recap (four workers + core)

```text
                      ┌────────────────────────────────────────────┐
                      │            Cloudflare edge                 │
   public HTTPS       │                                            │
  ────────────────────┼─▶  checkout-pay Worker   (public payment UI │
                      │    routes: /checkout/* only)               │
                      │        │                                   │
                      │        │ Service Binding (RPC)              │
                      │        ▼                                   │
                      │   edgepay-core Worker  (D1, DO, KV,        │
                      │    Queues, Workflows; all business rules;  │
                      │    NO public routes except /api/v1/*       │
                      │    customer contract + /webhook/* inbound) │
                      │   ▲              ▲            ▲            │
                      │   │ RPC          │ RPC        │ RPC        │
                      │ admin-console    │            │ webhook-   │
                      │ Worker (Access-  │            │ delivery   │
                      │ gated; /install* │            │ Worker     │
                      │ first-run; all   │            │ (queues +  │
                      │ /api/admin/* )   │            │ outbound   │
                      │                  │            │ fetches;   │
                      │                  │            │ the ONLY   │
                      │                  │            │ holder of  │
                      │                  │            │ ALLOW_     │
                      │                  │            │ LOCAL_     │
                      │                  │            │ WEBHOOK_   │
                      │                  │            │ TARGETS ⟵v4│
                      └────────────────────────────────────────────┘
```

Design goals (re-validated against v4's evidence): tenant scope enforced in one authorize seam (V3-001's lesson); internal traffic never crosses the public internet (P1-005/V3-010's class); per-surface blast radius for credentials (V4-004's lesson); every money invariant core-internal (V3-003's pattern, now the in-repo reference); claims mechanized at every repo boundary (V4-001/011's lesson).

## 47. The RPC contract (full, updated)

```ts
// core exposes ONE typed surface — every method: (ctx: CallerContext, …)
export interface CallerContext {
  worker: 'checkout' | 'admin' | 'delivery';
  requestId: string;
  principal: { kind: 'device-jwt' | 'api-key' | 'platform-admin' | 'queue';
               merchantId: number | null; platform: boolean; scopes: string[] };
}

export interface CoreRPC {
  // payments (checkout surface)
  createIntent(ctx, input: CreateIntentInput): Promise<Intent>;          // P1-007 fix rides here: UNIQUE seed
  getCheckoutSession(ctx, token: string): Promise<CheckoutSession>;
  confirmManualPayment(ctx, token: string, proof: ManualProof): Promise<Result>;
  // customer REST backing (core hosts /api/v1/* itself)
  // refunds (admin + api surfaces) — reserve-then-call invariant pinned ⟵v4
  processRefund(ctx, input: RefundInput): Promise<RefundResult>;
  listRefunds(ctx, query: Query): Promise<Refund[]>;
  // webhooks (delivery surface)
  registerWebhook(ctx, url: string, events: string[]): Promise<Webhook>;  // guard inside core ⟵v4
  sendTestWebhook(ctx, url?: string): Promise<TestResult>;                // guard inside core ⟵v4
  // admin (Access-gated surface)
  ADMIN_RPC: {
    listMerchants(ctx): Promise<Merchant[]>;
    provisionMerchant(ctx, input: NewMerchant): Promise<Provisioning>;    // claim-token out-of-band
    redeemClaim(ctx, claimToken: string): Promise<ProvisionedCredentials>;// platform-principal only ⟵carried
  };
  // shared infrastructure
  emitMetric(ctx, name: string, dims: Record<string, string>): Promise<void>; // fails LOUD in every env ⟵v4-002
}
```

Annotations are the deltas from report 4's contract: the refund invariant is now in-repo and needs only pinning; the SSRF guards run inside core (single validation point — v4 proved the pattern at every write site); `redeemClaim`'s platform gate remains a contract requirement because the monolith never implemented it (V3-010); `emitMetric` gained the fails-loud requirement because V4-002 proved a silent metrics no-op can survive a full green suite.

## 48. Route disposition map (52 routes)

```text
checkout-pay Worker (public, no secrets):
  /checkout/:token (GET), /checkout/:token/verify (POST),
  /checkout/:token/submit-trx (POST)                       + per-frontend streamed cap ⟵V3-005

edgepay-core Worker (customer contract + inbound):
  /api/v1/health, /api/v1/payments (CRUD + confirm), /api/v1/refunds,
  /api/v1/transactions, /api/v1/webhooks (CRUD, tests), /api/v1/gateways (read),
  /api/v1/me — the ENTIRE remaining public REST surface (~14 routes)
  /webhook/:slug (inbound gateway callbacks, signed)

admin-console Worker (Cloudflare Access in front):
  / (dashboard UI), /api/admin/v1/* (platform ops, refunds, recon, ledger,
  merchants+claim ⟵platform-gate here), /install* (first-run, D1-locked),
  /api/reference (docs)

webhook-delivery Worker (no public routes):
  queue consumers (webhook/email/sms), outbound fetch with redirect:'error',
  15s timeout, ALLOW_LOCAL_WEBHOOK_TARGETS (the only holder) ⟵v4

deleted in the split: nothing user-visible; the monolith's cross-cutting
middleware stack (CORS/CSP/rate-limit/cap) is re-expressed per frontend,
which is where V3-005's streamed cap and P1-010's binding-based limits land.
```

## 49. Service Bindings vs Worker RPC — the decision matrix

Updated from report 4 §43–44 with v4 evidence in the last column:

| Criterion | Service Bindings (fetch) | **Worker RPC (recommended)** | Queues | mTLS custom domain | Public REST |
|---|---|---|---|---|---|
| Type safety at boundary | none (raw Request) | **full (TS interface, breaking-change = compile error)** | payload only | none | schema only |
| AuthN of caller | your own scheme | **platform-enforced binding identity + ctx re-derived principal** | queue-level | cert-level | API-key layer |
| Tenant-scope guarantee | per-request discipline | **one authorize seam; frontends cannot express cross-tenant SQL (no D1 binding)** — the V3-001 lesson mechanized | consumer-side | per-call | middleware only (the P1-005 model) |
| Latency | same-isolate ~0 | **same (RPC over binding)** | async | +TLS +net | +public edge |
| Money-invariant custody | discipline | **core-internal (V3-003's reserve-then-call is the pattern)** | n/a | split | split |
| Claim-checkability | manual | **CI-resolvable interface = the ledger's test column can point at RPC methods** ⟵v4 lesson | manual | manual | manual |
| Cost of mistake visible at | runtime | **compile time** | runtime | runtime | runtime |

Recommendation unchanged: **Worker RPC over Service Bindings for all synchronous core calls**; Service Bindings kept only where a frontend must proxy arbitrary paths (none identified in the final topology); Queues for the delivery pipeline; public REST reduced to the ~14-route customer contract of §48. The v4 evidence strengthened three rows (tenant scope, custody, checkability) without touching the others.

## 50. Phase plan and rollback design

```text
Phase 0 (precondition):  corrected ledger + CI gate live ⟵v4 mandatory; prod
                          analytics on; prod JWT_SECRET rotated ⟵V4-004
Phase 1 (shadow):        deploy core Worker with RPC; monolith calls it via
                          binding behind a feature flag; diff responses;
                          rollback = flip flag (zero user impact)
Phase 2 (cutover REST):  /api/v1/* traffic served by core; monolith keeps
                          admin/checkout/webhook surfaces; rollback = DNS/
                          route weight back to monolith (minutes)
Phase 3 (frontends):     checkout-pay and admin-console workers live, bound
                          to core; each frontend mounts its own cap/limits ⟵V3-005;
                          rollback = per-frontend route weight
Phase 4 (delivery):      queue consumers move to webhook-delivery worker;
                          ALLOW_LOCAL_* var exists only there ⟵v4; rollback =
                          queue consumer redelivery from DLQ (idempotent by design)
Phase 5 (delete):        monolith's admin/checkout routes removed; public
                          surface = customer contract only; the ledger records
                          the deletion as the final row of the migration
```

## 51. The honest counter-case (staying monolithic)

The split is not free, and the counter-case deserves its annual re-statement:

1. **The monolith is currently winning on correctness velocity.** Three remediation rounds fixed 38 findings inside one deployment unit with one test suite. A four-repo split during that period would have slowed every fix by the inter-repo coordination tax.
2. **The split's benefits are mostly preventive.** The tenant-scope mechanization, credential blast-radius reduction, and checkable claims are real, but the incident classes they prevent (V3-001, P1-005, V4-004-shaped leaks) have all been caught *in audit* before production damage.
3. **The operator's actual near-term risk list (§9) contains zero items the split fixes this quarter.** Rotation, analytics, cap, ledger correction — all monolith-compatible.

Therefore the recommendation stands as it has since report 3: **fix the 7-day and 30-day lists in the monolith now; begin the split at Phase 0's preconditions (which are the same actions); execute Phases 1–5 when the pilot is stable, not before.** The architecture work is justified the moment real merchants transact at volume — the moment the cost of the prevented-incident classes stops being hypothetical.

---

# PART XII — CORRECTED LEDGER ARTIFACT & REFERENCE IMPLEMENTATIONS

*This part is written to be pasted, not just read: §52 is the corrected ledger the operator should ship in place of the current REMEDIATIONS.md; §53 is the CI gate that keeps it honest; §54 is the payload-cap implementation the V3-005 finding has been asking for since report 4; §55 completes the regression walkthrough set.*

## 52. The corrected remediation ledger (72 rows + 11 V4) — the artifact to paste

The repository's ledger lists 30 rows, 7 of them under colliding IDs, 5 with fabricated citations, and 42 findings absent. The table below is the corrected superset — every tracked finding in the series, its true v4 status, and its fix pointer. Columns: **ID** (series registry, appendix F), **Src** (report that filed it), **Finding** (condensed), **v4** (status under this audit), **Fix** (where the fix lives or where to write it).

| ID | Src | Finding | v4 | Fix |
|---|---|---|---|---|
| EDGE-P0-001 | R2 | Live credentials in artifact; rotation mandatory | PARTIAL | scripts clean (r1); dev keys rotated (v4); **prod rotation REQUIRED now** — V4-004; scanning CI absent |
| EDGE-P0-002 | R2 | Refund reverses wrong ledger row | FIXED (held) | ledger.ts posting by public id |
| EDGE-P0-003 | R2 | Merchant-API refunds unbounded/instant | FIXED (held+) | atomic bound (v3) + reserve-then-call (v4) |
| EDGE-P0-004 | R2 | Callback ignores amount & intent binding | FIXED (held) | payment.ts exact cmp + mandatory amount |
| EDGE-P0-005 | R2 | Bootstrap credential chain / install lockout | PARTIAL | CSPRNG creds (v2); **auto-bootstrap + KV lock persist** — D1 lock + AUTO_BOOTSTRAP var (90-day) |
| EDGE-P0-006 | R2 | Checkout stored XSS; no CSP | FIXED (held) | checkout.ts escaping + nonce CSP |
| EDGE-P0-007 | R2 | SMS corroboration NULL-amount bypass | FIXED (held) | exact-decimal strict match |
| EDGE-P1-001 | R2 | Idempotency not concurrency-safe | FIXED (held) | D1 op_idempotency_keys; endpoint scoping residual |
| EDGE-P1-002 | R2 | Mobile OTP brute-forceable | FIXED (held+) | otp-group limits; CF-IP keying (v4) |
| EDGE-P1-003 | R2 | Inbound webhook body/event-id/geo | PARTIAL | 128 KB global cap (header-only — V3-005); geo Layer-2; event-id determinism open |
| EDGE-P1-004 | R2 | Outbound SSRF encodings/redirects | FIXED (held+) | url-guard + 4-site enforcement + opt-in flag (v4) |
| EDGE-P1-005 | R2 | Merchant-admin tenant enumeration | FIXED (held) | platform gate + claim token |
| EDGE-P1-006 | R2 | Status regression; recon never heals payments | PARTIAL | callback guards (v2); **recon heals ledger rows only** — payment-row heal (90-day) |
| EDGE-P1-007 | R2 | createIntent non-atomic; auto-seed race | NOT FIXED | UNIQUE (merchant_id, slug) + ON CONFLICT (30-day) |
| EDGE-P1-008 | R2 | Read-scoped keys can mutate | FIXED (held) | method-based write-scope middleware |
| EDGE-P1-009 | R2 | Security regression tests broken | FIXED (held) | 23/23 suites |
| EDGE-P1-010 | R2 | KV limiter race; install group; anon throttle | PARTIAL+ | group keying (v4); **KV race persists** → Ratelimit binding (30-day) |
| EDGE-P2-001 | R2 | CSRF middleware dead code | NOT FIXED | mount csrf.ts on web routes or delete (30-day) |
| EDGE-P2-002 | R2 | DO fault-injection seam | NOT FIXED | env-gated only; low risk |
| EDGE-P2-003 | R2 | Platform merchant excluded from verification | NOT FIXED | is_platform handling in verify paths |
| EDGE-P2-004 | R2 | Webhook master-domain platform binding | NOT FIXED | disclose or scope by SNI |
| EDGE-P2-005 | R2 | Ratelimit binding absence fails open | PARTIAL | bindings present; fail-open path + dark alarm (V4-002) |
| EDGE-P2-006 | R2 | Analytics disabled — metrics no-ops | PARTIAL | dev/staging on (v4); **prod still commented** — uncomment + deploy (7-day #3) |
| EDGE-P2-007 | R2 | No webhook outbox | NOT FIXED | outbox table + sweep (90-day) |
| EDGE-P2-008 | R2 | Mirror dedup drops identical journal lines | NOT FIXED | dedup key includes line ordinal |
| EDGE-P2-009 | R2 | Wrong ENCRYPTION_KEY degrades silently | NOT FIXED | loud decrypt failure + page |
| EDGE-P2-010 | R2 | Single versionless ENCRYPTION_KEY | NOT FIXED | key versioning + re-encrypt migration (90-day; P0-001 durable close) |
| EDGE-P2-011 | R2 | Break-glass not timing-safe; JWKS no timeout | NOT FIXED | timing-safe compare; AbortController |
| EDGE-P2-012 | R2 | LedgerDO trusts caller identity | NOT FIXED | architectural — resolved by the split |
| EDGE-P2-013 | R2 | key_prefix non-UNIQUE | NOT FIXED | migration 0005 UNIQUE index |
| EDGE-P2-014 | R2 | Unbounded/unchecked inputs | PARTIAL | money zod (v3); hand-rolled bodies open |
| EDGE-P2-015 | R2 | Merchant-editable ReDoS regexes | NOT FIXED | pattern allowlist / safe-regex screen (30-day) |
| EDGE-P2-016 | R2 | ENABLED_GATEWAYS unset ⇒ all | NOT FIXED | fail-closed default (30-day) |
| EDGE-P2-017 | R2 | PBKDF2 50K; floor 10K | NOT FIXED | 600K default, 100K floor (30-day) |
| EDGE-P2-018 | R2 | No amount ceiling at boundary | FIXED (held) | moneySchema refine |
| EDGE-P2-019 | R2 | Currency minor-unit exponents | NOT FIXED | exponent table per currency |
| EDGE-P2-020 | R2 | Exchange rates unvalidated, no timeout | NOT FIXED | zod + AbortController (90-day) |
| EDGE-P3-001 | R2 | Dead schema states | NOT FIXED | cosmetic |
| EDGE-P3-002 | R2 | authSubject/device_id confusion | PARTIAL+ | notifications fixed (v4); **heartbeat mis-keys** — one-liner (30-day) |
| EDGE-P3-003 | R2 | Mobile ack cross-tenant | FIXED (v4) | predicate + deviceId + regression test |
| EDGE-P3-004…012 | R2 | (docs/mockup/misc hygiene family) | NOT FIXED | incl. mockup open proxy P3-006 — ships in artifact |
| NEW-P1-001 | R3 | Root key in plaintext KV | FIXED (held) | hash-only in D1 |
| NEW-P1-002 | R3 | Install/bootstrap-key unthrottled | FIXED (held) | password-group limits |
| NEW-P2-001 | R3 | Refund bound race | FIXED (held+) | atomic INSERT; reserve-then-call (v4) |
| NEW-P2-002 | R3 | Float amount compare | FIXED (held) | cmp() decimal |
| NEW-P2-003 | R3 | API gateway amount unchecked | FIXED (held) | mandatory verification |
| NEW-P2-004 | R3 | Credential harvesting via admin API | FIXED (held) | claim token (V3-004 KV residual) |
| NEW-P2-005 | R3 | Checkout abuse unthrottled | FIXED (held+) | checkout-group limits |
| NEW-P3-001 | R3 | sms-corroboration dead operand | FIXED (held) | removed |
| NEW-P3-002 | R3 | ESLint pipeline broken | FIXED (held) | flat config; 0/0 now |
| NEW-P3-003…005 | R3 | (misc hygiene) | held/open per report 3 | — |
| V3-001 | R4 | False FIXED claim (P3-003) | FIXED (v4) | claim made true + tested |
| V3-002 | R4 | sendTest persists unvalidated URLs | FIXED (v4) | guard before INSERT ×2 layers |
| V3-003 | R4 | Refund ghost-call ordering | FIXED (v4) | reserve-then-call |
| V3-004 | R4 | Claim creds in plaintext KV | OPEN | encrypt blob with ENCRYPTION_KEY (30-day optional) |
| V3-005 | R4 | Header-only payload cap | **OPEN (claimed fixed)** | streamed cap / 411 — §54 (7-day #6) |
| V3-006 | R4 | Per-path anon limits; KV race | FIXED-as-scoped | group keying (v4); race → binding (30-day) |
| V3-007 | R4 | ENVIRONMENT-inferred SSRF carve-out | FIXED (v4) | ALLOW_LOCAL_WEBHOOK_TARGETS ×4 sites |
| V3-008 | R4 | Auto-bootstrap first-request lockout | OPEN | AUTO_BOOTSTRAP var / stop setting installed (30-day) |
| V3-009 | R4 | any-typed security middleware | FIXED (v4) | ApiVariables everywhere |
| V3-010 | R4 | Claim route any-admin redeemable | OPEN | requirePlatformAdmin mount (30-day) |
| V3-011 | R4 | Claims not checkable by construction | HALF-FIXED | ledger exists; **see V4-001/003/008/011** |
| V4-001 | R5 | Ledger cites nonexistent tests (5 rows) | NEW | write tests (7-day #5) + gate |
| V4-002 | R5 | "Analytics active" false for prod | NEW | uncomment prod config (7-day #3) |
| V4-003 | R5 | Ledger ID collisions (7 rows) | NEW | paste this table; freeze registry |
| V4-004 | R5 | Live prod refresh token in artifact | NEW | **rotate JWT_SECRET now** (7-day #1) |
| V4-005 | R5 | Cap bypass live-proven, claimed fixed | NEW | §54 implementation |
| V4-006 | R5 | "100% fixed" verdict | NEW | honest summary language |
| V4-007 | R5 | Asset route unreachable | NEW | path rewrite or config change |
| V4-008 | R5 | Ledger omits 42 findings | NEW | paste this table |
| V4-009 | R5 | Stale TEST_RESULTS.md | NEW | update or delete |
| V4-010 | R5 | Cap dropped DELETE-with-body | NEW | fold into §54 |
| V4-011 | R5 | No CI gate behind the ledger | NEW | §53 implementation |

**83 rows, 0 collisions, 0 fabricated citations, 42 previously-absent findings present.** This table is the deliverable V3-011 actually asked for; replacing the repo's ledger with it (and regenerating the "Verification Test ID" column as tests land) closes V4-003 and V4-008 immediately and V4-001 as the five tests merge.

## 53. The CI gate: reference implementation

The gate exists to make §15's audit mechanically impossible to need again. Three checks, one workflow:

**`.github/workflows/audit-gate.yml`:**

```yaml
name: audit-gate
on: [push, pull_request]
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: npm ci
      - name: Ledger integrity (V4-001/003/008/011)
        run: node scripts/verify-remediations.mjs
      - name: Type surface (V3-009 held)
        run: |
          npx tsc --noEmit
          ! grep -rn "as any" src/ && echo "no any-casts"
      - name: Production config assertions (V4-002)
        run: node scripts/verify-config.mjs wrangler.jsonc
      - run: npx eslint src tests
      - run: npx vitest run
```

**`scripts/verify-remediations.mjs` (the ledger checker):**

```js
// Parses docs/REMEDIATIONS.md; for every FIXED row resolves the cited test
// ids against the vitest manifest; fails on: unresolved id, skipped test,
// missing file, or a finding-ID outside the frozen registry.
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REGISTRY = ['EDGE-P0-001', /* …full appendix F list… */, 'V4-011'];
const md = readFileSync('docs/REMEDIATIONS.md', 'utf8');
const rows = [...md.matchAll(/^\| (\S+) \|[^|]+\|[^|]+\| ([A-Z ]+) \|/gm)];

// 1. test manifest: vitest --list --api emits machine-readable cases
const manifest = JSON.parse(execSync('npx vitest list --api').toString());
const known = new Set(manifest.files.flatMap(f => f.tests.map(t => `${f.file} > ${t.name}`)));

let failures = [];
for (const [, id, status] of rows) {
  if (!REGISTRY.includes(id)) failures.push(`unknown/colliding ID: ${id}`);
  if (status.trim() === 'FIXED') {
    const cited = (md.match(new RegExp(`^\| ${id} \|.*\| .+ \|$`, 'm')) || [''])[0];
    const tests = [...cited.matchAll(/([\w./-]+\.test\.ts)[^|]*?([\w >-]+)?/g)];
    if (!tests.length) failures.push(`FIXED row cites no test: ${id}`);
    for (const t of tests) {
      const file = t[1];
      if (!known.has(file) && !manifest.files.some(f => f.file.includes(file)))
        failures.push(`FIXED row cites unknown test file: ${id} → ${file}`);
    }
  }
}
if (failures.length) { console.error('AUDIT GATE FAILURES:\n' + failures.join('\n')); process.exit(1); }
console.log(`ledger OK: ${rows.length} rows, all FIXED citations resolve`);
```

**`scripts/verify-config.mjs` (the config assertion):**

```js
// Fails when a production binding the ledger claims as active is commented
// out, or when .dev.vars / *-state.json would ship in the tree (V4-004 class).
const [file] = process.argv.slice(2);
const src = readFileSync(file, 'utf8');
const asserts = [
  [/^[^\n]*"analytics_engine_datasets"\s*:/m, 'analytics_engine_datasets must be ACTIVE in production config'],
];
let fail = 0;
for (const [re, msg] of asserts) if (!re.test(src)) { console.error('FAIL: ' + msg); fail = 1; }
for (const leak of ['.dev.vars\n', 'companion-state.json'])
  if (execSync('git ls-files').toString().includes(leak.trim().replace('\\n',''))) {
    console.error('FAIL: tracked file must not ship: ' + leak.trim()); fail = 1; }
process.exit(fail);
```

Together: ~90 lines that would have caught **every** reporting failure this series has filed — the v3 no-code "FIXED," the v4 fabricated citations, the prod-dark analytics row, and the tracked state file. This is the highest-leverage code in the entire report.

## 54. The payload cap done right: three implementations

The finding's fix menu (report 4, unchanged; pick ONE):

**Variant A — streamed reader (true ceiling, recommended):**

```ts
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();  // V4-010: keep DELETE
  const cl = c.req.header('content-length');
  if (cl) {
    const len = Number(cl);
    if (!Number.isFinite(len) || len > 128 * 1024) return tooLarge();      // v4 NaN fix retained
    return next();                                                          // header present & sane: runtime enforces
  }
  // no Content-Length (chunked): re-body through a bounded reader
  const raw = c.req.raw.clone();
  const limited = raw.body.tee(1)[0];            // tee: read at most limit+1 bytes
  const reader = limited.getReader();
  let seen = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength; if (seen > 128 * 1024) return tooLarge();
    chunks.push(value);
  }
  const body = new ReadableStream({ start(c){ chunks.forEach(ch => c.enqueue(ch)); c.close(); } });
  return app.fetch(new Request(raw.url, { method, headers: raw.headers, body, duplex: 'half' }));
});
```

**Variant B — 411-when-absent (stricter, simpler, 6 lines):**

```ts
if (['POST','PUT','PATCH','DELETE'].includes(c.req.method) && !c.req.header('content-length')) {
  return c.json({ success: false, error: { code: 'LENGTH_REQUIRED',
    message: 'Content-Length header required' } }, 411);
}
```

Compatible with every well-formed API client (fetch/axios/curl all send it for fixed bodies); hostile clients get the 411 before any parse work.

**Variant C — bounded parse at the JSON layer** (replace `c.req.json()` call sites with a helper that reads text with a byte cap) — viable but spreads the guard across controllers; only worth it if A's stream re-wrapping misbehaves under a future Hono upgrade.

**Test template (either variant):** the probe of appendix C *is* the test — flip its assertion to `expect(res.status).toBe(413)` (or 411) and it becomes the regression test the ledger's V3-005 row should cite.

## 55. Checkout and callback regression walkthroughs (v4)

Completing the walkthrough set begun in §18–20:

**Checkout (public, token-gated):** `GET /checkout/:token` resolves the session by token with expiry/status checks; the HTML is template-rendered with the escaping discipline fixed in v2 (attribute-context escaping + nonce CSP from the per-request middleware; the smoke suite asserts both). `POST /checkout/:token/verify` and `/submit-trx` sit behind the `checkout` anonymous rate-limit group (now IP+group-keyed ⟵v4) and validate the manual-proof schema; the corroboration path enforces exact decimal amount match (P0-007 family, held). Files byte-identical to v3; suite green; the only v4 interaction is the improved limiter keying — strictly stronger, no behavior regression (the tenant-routing and payment-edgecases suites exercise these routes with distinct source IPs and pass).

**Callback (inbound gateway):** `webhooks.ts` resolves the merchant (platform-preferred on master domain — P2-004, disclosed, unchanged), verifies the gateway signature (per-adapter), then `payment.handleCallback`: amount compared with decimal `cmp()` against the intent (P0-004, held), intent/transaction binding enforced, terminal-state regression guard (P1-006 callback half, held), then the posting protocol through the per-merchant LedgerDO with idempotent journal entries (P0-002, held). The v4 diff touches none of this; the 220-test run exercises callback paths in payment-integrity and payment-edgecases; no regression.

**Mobile (close-out of §19):** refresh → access exchange (no secondary binding — V4-004's surface); heartbeat mis-keys by authSubject (P3-002 residual); notifications fully scoped and tested (v4).

---


---

# PART XIII — FINDING DEEP-DIVES: IMPACT, DETECTION, AND THE REMAINING MONEY PATHS

## 56. V4 findings — exploit scenarios and detection methods

Severity claims are only as good as their attack narrative. This section walks each V4 finding through the scenario an adversary would actually follow, and the cheapest reliable way an operator could have detected it — the pair that justifies the P-rating and, more usefully, tells the operator what monitoring would have caught it had no audit been performed.

**V4-004 (live refresh token).** *Scenario:* an adversary obtains any of the distributed zips (they are shared with auditors, reviewers, and potentially future contractors); extracts `refresh_token` from `sms-phone-mockup/.companion-state.json`; POSTs it to `/api/mobile/v1/refresh` on the production origin; receives a fresh read/write access token for merchant 8's device 4; can then read notifications, drive heartbeats, and exercise every mobile read/write route as that device until 2026-10-01 — and can *renew* the session indefinitely within the refresh token's own lifetime. *Detection without audit:* none of the current telemetry would flag it (mobile refresh is a normal flow; metrics are dark in production anyway — V4-002 compounds this). *Post-rotation detection:* the token's next use 401s; a page on refresh-with-unknown-jti would make rotation verifiable. *Cost of the fix:* one `wrangler secret put` — the cheapest P2-to-P1-urgency conversion in the series.

**V4-001 (fabricated citations).** *Scenario:* not an attack but a decision failure — an operator (or an investor, or a certification assessor) reads REMEDIATIONS.md, sees V3-003 "FIXED … verified by payment-integrity.test.ts (Reserve-then-call…)", and ships a refund-flow change on the belief the ordering is regression-protected; a future refactor reorders the statements back; no test fails; ghost refunds return silently. *Detection:* the manifest-resolution check of §53 (one command). *This is the exploit: the absence of a tripwire where the documentation claims one exists.*

**V4-002 (prod analytics false).** *Scenario:* the `RATE_LIMIT_WRITE` binding is misconfigured or removed in a future deploy; the code fails open by design (P2-005) and emits the degradation metric that is supposed to page — but the production dataset binding is commented out, so nothing is written, nothing pages, and every customer-facing mutating route runs unthrottled for as long as the misconfiguration persists. The ledger says the alarm is live; an operator troubleshooting an abuse incident looks for telemetry that does not exist. *Detection:* the config assertion of §53; or a synthetic canary metric written by a cron and alerted on absence.

**V4-005 (cap bypass).** *Scenario:* a hostile client opens N parallel connections to `/api/v1/payments` (or any JSON route), each streaming a headerless multi-megabyte body; the middleware sees no Content-Length and calls `next()`; the handler's `c.req.json()` buffers the full stream; worker CPU burns on JSON parsing of garbage at attacker-chosen size, times out, and repeats — a cheap CPU-exhaustion surface across the whole public API. The Workers platform bounds memory per isolate, so the practical impact is throughput degradation and billed CPU, not a crash — the same "practical blast radius is CPU burn" assessment report 4 made, now demonstrated rather than predicted. *Detection:* the probe of appendix C as a permanent test (its assertion flipped to expect 413/411).

**V4-003 (ID collisions).** *Scenario:* an operator triaging "what's still open before we take real money?" reads the ledger's "EDGE-P2-001 | FIXED" row and crosses the CSRF dead-code finding off their list; the middleware stays unmounted; a future cookie-authenticated web route (an admin dashboard "remember me" flow, say) ships with no CSRF protection because the team's own tracking says the control is live. *Detection:* the registry freeze of appendix F plus the gate's unknown-ID check.

**V4-006 (verdict overclaim).** *Scenario:* the summary text ("100% Healthy and Fully Fixed") is forwarded as the deployment justification; nobody opens the ledger or the audits; the ≥31 open findings — including the auto-bootstrap lockout (V3-008) that can brick a fresh deployment's first-run wizard — are discovered in production, one incident at a time. *Detection:* process rule (§39.1): no verdict sentence ships unless generated from the ledger, and the ledger is generated from the artifact.

**V4-007 (assets unreachable) / V4-009 (stale TEST_RESULTS) / V4-010 (DELETE uncapped).** Low-impact individually; their significance is cumulative — each is a place where the artifact's self-description diverges from its behavior, and the divergence survived a 220-test green run. They are the canaries for the reporting-layer failure mode the bigger findings exemplify.

**The detection column summarizes to one sentence:** every V4 finding is mechanically detectable — hashes, manifests, config greps, one probe — and none of the detections exist in the repo. The series' most consistent meta-finding remains true: **this codebase's verification tooling verifies everything except its own claims about itself.**

## 57. The remaining money paths: intent creation and ledger posting walkthroughs (v4)

Completing the trilogy begun by §18 (refunds) and §20 (webhooks): the two other paths that touch money state.

**Payment intent creation (`POST /api/v1/payments`):**

```text
1. group gates: bearer auth → write-scope (POST) → route zod
   (moneySchema bounds, currency enum, gateway slug validation)
2. idempotency: key REQUIRED (op_idempotency_keys; ON CONFLICT DO NOTHING;
   body-hash mismatch ⇒ 409; replay ⇒ X-Idempotent-Replay + 201 of original)
3. PaymentService.createIntent:
   a. resolve merchant + slug → manual-gateway auto-seed
      (payment.ts:89–117 — ⚠ UNCHANGED from v1: SELECT-then-INSERT with no
       UNIQUE (merchant_id, slug) — EDGE-P1-007: concurrent first-payments
       can double-seed the manual gateway row; the affected SELECT then
       LIMIT 1 arbitrates, so the failure mode is a duplicate row, not a
       wrong posting; still open, still P1)
   b. INSERT op_payment_intents (status 'pending', amount/currency from zod)
   c. gateway dispatch: manual → pending (off-band); API-gateway →
      adapter.createPayment with encrypted credentials; callback URL bound
      to intent id; failures land in a terminal 'failed' state with the
      signature-reject path intact (P1-006 guards held)
4. response: intent_id, client secret, redirect/session tokens per gateway type
```

No v4 changes on this path (payment.ts byte-identical); suite coverage: payment-integrity (bounds, idempotency, replay), payment-edgecases (gateway failure modes). The one open defect remains P1-007's seed race — fixed naturally by the migration's UNIQUE constraint, or opportunistically by the 30-day list.

**Ledger posting (the posting protocol, post-callback):**

```text
callback verified (§55) → PaymentService records the transaction
  → op_transactions row (terminal-state guarded)
  → LedgerDO per merchant (getLedgerDO(env, merchantId) — caller-side
     discipline is the identity guard, P2-012 architectural note)
  → posting: journal lines {debit, credit} with idempotency key =
     public transaction/refund id (P0-002's fix — the wrong-row-reversal
     class is dead because reversal targets the same key)
  → D1 mirror (best-effort; dedup semantics P2-008 unchanged)
  → reconciliation sweep (cron): re-verifies op_ledger_postings vs DO
     state, heals postings only (P1-006 residual: payment/transaction
     rows are never healed), flags drift, pages on divergence
  → refund postings ride the same protocol via the refund's public id,
     now guaranteed a row exists before the gateway moves money (v4 §18)
```

**Series-level conclusion on the money core:** of the three money paths — create, capture/callback, refund — the first is correct except for a narrow seed race (P1-007), the second has held all its fixes across three releases, and the third closed its last race window this round. The ledger DO's authority model, the posting idempotency discipline, and the decimal-exact comparisons are now the platform's strongest subsystem. What remains open on money (recon healing payment rows, currency exponents, exchange-rate validation) is correctness-of-reconciliation, not correctness-of-movement — an acceptable posture for a pilot with capped volumes, and the exact posture the 90-day list is designed to close before real money.

## 58. The claim-text deconstruction: what each section of the remediation message asserted

The developer's message had five sections: the remediation list (verified in §14), the "400/401/403 are normal" explanation (verified — correct), the static-asset narrative (verified with attribution correction), the "Current Status" block, and the "Fixed: All 39 Problems" block with its five-file breakdown and a second verification-results block. The two status blocks, deconstructed:

**"Current Status" block:**

| Line | Verdict | Note |
|---|---|---|
| ESLint 9: 0 errors | **reproduced** | §13 |
| TypeScript: 0 errors | **reproduced** | §13 |
| Test Suites 23/23, 220/220 | **reproduced** | §13 |
| Duration 9.88s, no hung requests, zero 500s | **reproduced** (7.66s) | machine variance |
| Git branches synchronized | unverifiable | no .git in artifact |
| Cloudflare Edge deployed, Version f40de600… | unverifiable | runtime claim; note a *second* version id (23da8a0a…) appears in the message's later block — two deploys, both unconfirmable from the zip |

**"Fixed: All 39 Problems" block — the five enumerated fixes vs the diffs:**

| Claimed fix | Diff says | Verdict |
|---|---|---|
| nagad: `as any` → `{ name: 'RSA-OAEP' }`, typed key imports | exactly that; importPublicKey still pins SHA-256 | **true and safe** (WebCrypto: encrypt-time hash is inert; the key's hash governs) |
| security-headers strictly typed | `MiddlewareHandler` + `setHeaders(c: Context)` | **true** |
| gateway-integrity: renamed unused mocks, 10 casts → types | typing-only diff, no new cases | **true** |
| payment-integrity: 7 casts → generics, timeout raised | typing + two 15s timeouts, no new cases | **true** — and this is where the V3-003 citation fails: a typing-only diff cannot contain an ordering test |
| tenant-routing: 18 env casts → typed, redirects `as const` | typing-only diff | **true** |

The five enumerated fixes are all real. The claim's only defect is its framing: "Fixed: All 39 Problems" elides that none of the 39 were *coverage* problems — the suite grew by exactly two tests this round, both for V3-001. The problems that remain (the five unwritten tests, the cap bypass, the dark prod telemetry) are precisely the ones lint and typecheck cannot see.


---

# PART XIV — VERIFIED ROUTE INVENTORY & DATA-PLANE TOPOLOGY (V4)

## 59. The complete 52-route inventory (verified from source)

Every public route in the v4 worker, extracted from the controllers and re-verified against the mounted middleware (auth, scope, rate-limit group). This is the surface an operator must reason about when reducing the API to the customer contract (§48) and when threat-modeling the split (§46). Mount points: `/api/v1` (apiRoutes), `/api/mobile/v1` (mobileRoutes), `/api/admin/v1` (adminApiRoutes), `/checkout` (checkoutRoutes), `/install` (installRoutes), `/webhook` (webhooks), `/api/reference` (apiReferenceRoutes), root (health, assets).

**Customer REST surface — `/api/v1/*` (bearer API key; write-scope enforced on all mutating verbs; per-key Ratelimit binding):**

| # | Route | Method | Notes |
|---|---|---|---|
| 1 | `/payments` | POST | zod money bounds; idempotency key REQUIRED; P1-007 seed race lives here |
| 2 | `/payments/:id` | GET | |
| 3 | `/refunds` | POST | idempotency REQUIRED; reserve-then-call ⟵v4 |
| 4 | `/transactions` | GET | |
| 5 | `/transactions/:id` | GET | |
| 6 | `/customers` | GET | |
| 7 | `/api-keys` | GET | key material shown once at creation only |
| 8 | `/api-keys` | POST | admin scope required |
| 9 | `/webhooks` | GET | |
| 10 | `/webhooks` | POST | isAllowedWebhookUrl at entry ⟵v4 flag |
| 11 | `/webhooks/:id` | DELETE | |
| 12 | `/webhooks/tests` | POST | route-level + dispatcher guard ⟵v4 |
| 13 | `/webhooks/deliveries` | GET | delivery log |
| 14 | `/gateways` | GET | enabled-gateway catalog |

**Mobile companion — `/api/mobile/v1/*` (mobile JWT; device_id now flows in context ⟵v4):**

| # | Route | Method | Notes |
|---|---|---|---|
| 15 | `/pair` | POST | otp group (IP+group keyed ⟵v4) |
| 16 | `/devices` | POST | otp group |
| 17 | `/refresh` | POST | **pre-auth** — V4-004's surface |
| 18 | `/devices/token-refreshes` | POST | alias of 17 |
| 19 | `/heartbeat` | POST | mis-keyed by authSubject (P3-002 open) |
| 20 | `/devices/heartbeats` | POST | alias of 19 |
| 21 | `/dashboard` | GET | |
| 22 | `/sms` | POST | |
| 23 | `/sms/batch` | POST | |
| 24 | `/notifications` | GET | merchant+device scoped |
| 25 | `/notifications/acknowledgements` | POST | scoped + tested ⟵v4 |

**Admin API — `/api/admin/v1/*` (bearer + admin scope; platform gate on tenant ops; Access middleware on the dashboard origin):**

| # | Route | Method | Notes |
|---|---|---|---|
| 26 | `/sms-templates` | GET | |
| 27 | `/sms-templates/:id` | PUT | P2-015 ReDoS surface (merchant-editable regex) |
| 28 | `/devices` | GET | |
| 29 | `/devices/:id` | DELETE | |
| 30 | `/sms-queues` | GET | |
| 31 | `/sms-queues/:id/retries` | POST | |
| 32 | `/refunds` | POST | same RefundService path as #3 |
| 33 | `/reconcile` | POST | manual reconciliation trigger |
| 34 | `/ledger/trial-balance` | GET | |
| 35 | `/domains/verifications` | POST | custom-hostname verification |
| 36 | `/merchants` | GET | requirePlatformAdmin ⟵held |
| 37 | `/merchants` | POST | requirePlatformAdmin; claim-token issuance |
| 38 | `/merchants/claim` | POST | **any admin-scoped key — V3-010 open** |

**Checkout (public, token-gated):**

| # | Route | Method | Notes |
|---|---|---|---|
| 39 | `/checkout/:token` | GET | nonce CSP + escaping (P0-006 held) |
| 40 | `/checkout/:token/initiate` | POST | |
| 41 | `/checkout/:token/verify` | POST | checkout rate group ⟵v4 keying |
| 42 | `/checkout/:token/submit-trx` | POST | checkout rate group; corroboration exact-match |
| 43 | `/checkout/:token/callback` | GET | gateway return |
| 44 | `/checkout/:token/status` | GET | |

**Install (first-run):**

| # | Route | Method | Notes |
|---|---|---|---|
| 45 | `/install/` | GET | KV lock (P0-005 residual) |
| 46 | `/install/` | POST | first-come race (P0-005 residual) |
| 47 | `/install/bootstrap-key` | POST | password group (10/hr) |

**Inbound webhooks, health, docs, assets:**

| # | Route | Method | Notes |
|---|---|---|---|
| 48 | `/webhook/:gateway` | POST | per-adapter signature verify; platform-preferred resolution on master domain (P2-004) |
| 49 | `/api/v1/health` | GET | no auth |
| 50 | `/api/reference` (+/openapi.json) | GET | docs; tailored CSP |
| 51 | `/assets/*` | GET | unreachable (V4-007); crash fixed ⟵v4 |
| 52 | `/api/admin/*` (dashboard origin) | ALL | Cloudflare Access middleware |

## 60. Data-plane topology (verified behaviors, v4)

```text
                    ┌─────────── WRITE PATH (money) ───────────┐
 client ─REST/JWT→ index.ts middleware chain ─→ controller ─→ service
   (cap* ⟵v4      (requestId, logger, auto-bootstrap†,    (payment/
    auth, scope,    domain, maintenance, secureHeaders,    refund/
    idempotency,    CORS, custom-security-headers,          ledger svcs)
    per-key RL)     Access†, per-IP RL ⟵v4)
                          │
                          ├─ D1 (op_* tables: merchants, intents,
                          │   transactions, refunds, webhooks, keys,
                          │   idempotency, notifications, templates…)
                          ├─ KV (claim tokens, rate counters, locks†,
                          │   gateway token caches)
                          ├─ LedgerDO per merchant (journal authority;
                          │   posting idempotent by public id)
                          ├─ Queues (webhook/email/sms deliveries)
                          ├─ Workflows (refund-recon per refund;
                          │   reconciliation sweep)
                          └─ Workers AI (opt-in SMS parse fallback)

                    ┌─────────── READ/POLL PATHS ──────────────┐
 cron handler ─→ reconciliation sweep, exchange rates (P2-020)
 queue consumers ─→ webhook delivery (guard + sign + fetch, ⟵v4 opt-in flag)
 mobile mockup (dev tooling) ─→ production origin  ⚠ V4-004: ships state

†  = the carried residuals' homes: auto-bootstrap block (V3-008) and the
    KV locks (P0-005) sit in the request path of EVERY route; the split
    removes them from the customer surface by construction.
*  = the cap is header-conditioned (V4-005) — the one middleware whose
    advertisement exceeds its behavior.
```

**Trust boundaries as implemented (unchanged from report 4, re-verified):** (1) the edge→worker boundary (CF-IP, Access on admin origin, run_worker_first); (2) the authn boundary per surface (bearer keys with scopes / mobile JWTs with device binding ⟵v4 / Access JWTs on admin); (3) the tenant boundary (merchant_id in every scoped statement — notifications now included ⟵v4); (4) the money boundary (LedgerDO + posting protocol); (5) the egress boundary (url-guard at every webhook write site ⟵v4 + delivery). The split blueprint of Parts XI moves boundary 3 into an authorize seam and boundary 5 into a dedicated worker — every other boundary survives unchanged.

---

# APPENDICES

## Appendix A — Verification battery: exact commands and outputs

```bash
unzip -q edgepay-cf-clean-new-2.zip -d v4 && cd v4/edgepay-cf
npm ci                        # exit 0, lockfile intact
npx tsc --noEmit              # exit 0, no diagnostics
npx eslint src tests          # exit 0, no output (0 errors, 0 warnings)
npx vitest run                # 23 files / 220 tests passed, 7.66s
# md5 baselines used for diff-authorship (spot list):
#   payment.ts / reconciliation.ts / install.ts / bootstrap.ts / csrf.ts /
#   enabled.ts / sms-parser.ts / crypto.ts / url-guard.ts / observability.ts /
#   tests/url-guard.test.ts / tests/api-middleware.test.ts   — all identical v3↔v4
#   refund.ts / index.ts / mobile.ts / auth.ts / api.ts / admin-api.ts /
#   rate-limit.ts / security-headers.ts / webhook-consumer.ts /
#   webhook-dispatcher.ts / nagad.gateway.ts / env.ts          — changed (§12)
```

## Appendix B — Complete v4 diff inventory (raw)

```text
CHANGED (23 paths):
  .dev.vars                                  secrets rotated (3/3 fresh)
  .dev.vars.example                          placeholder rewrite
  wrangler.jsonc                             comment text only (analytics STILL off)
  wrangler.dev.jsonc                         analytics ON
  wrangler.staging.jsonc                     analytics ON
  src/controllers/mobile.ts                  V3-001 predicate + deviceId + meta.changes
  src/controllers/api.ts                     V3-002 route guard; V3-007 flag; V3-009 typing
  src/controllers/admin-api.ts               V3-009 typing (ApiVariables)
  src/middleware/auth.ts                     deviceId export/plumbing
  src/middleware/rate-limit.ts               CF-IP only; group keying
  src/middleware/security-headers.ts         typing + immutable-guard
  src/services/refund.ts                     V3-003 reserve-then-call
  src/services/webhook-dispatcher.ts         V3-002 guard before INSERT
  src/queues/webhook-consumer.ts             V3-007 flag
  src/gateways/nagad/nagad.gateway.ts        RSA-OAEP typing (hash pinned at import)
  src/types/env.ts                           ALLOW_LOCAL_WEBHOOK_TARGETS
  src/index.ts                               V3-005 scoping/NaN; asset wrapper
  tests/mobile-notifications.test.ts         NEW SUITE (2 tests)
  tests/payment-integrity.test.ts            typing + timeouts only
  tests/tenant-routing.test.ts               typing only
  tests/gateway-integrity.test.ts            typing only
  sms-phone-mockup/.companion-state.json     live session state (V4-004)
ADDED:
  docs/REMEDIATIONS.md                       30-row ledger
  docs/Archive/{reports 1..3}                moved from root
  EDGEPAY_CF_FULL_AUDIT_REPORT_2.md          archived at root by developer
REMOVED (moved):
  root EDGEPAY_AUDIT_REPORT.md, EDGEPAY_CF_FULL_AUDIT_REPORT.md,
  EDGEPAY_CF_FULL_AUDIT_REPORT_1.md          → docs/Archive/
```

## Appendix C — Adversarial probe source and results

Probe 1 — payload cap (V3-005 / V4-005). Written into the artifact's own harness, executed, then removed:

```ts
// tests/zz-audit-bypass.test.ts (auditor's probe — NOT part of the repo)
it('POST with streamed body (no Content-Length) > 128KB is NOT rejected by the cap', async () => {
  const big = JSON.stringify({ data: 'A'.repeat(300 * 1024) });        // ~300 KB
  const stream = new ReadableStream({ start(c){ c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const res = await SELF.fetch('http://localhost/api/v1/payments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream, duplex: 'half',
  });
  console.log('AUDIT chunked status:', res.status);                     // → 401
  expect([413]).not.toContain(res.status);                             // documents the bypass
});
it('POST with Content-Length 300KB IS rejected (control)', async () => { /* → 413 ✅ */ });
it('POST with malformed Content-Length "12x3" (control)', async () => {  /* → 401: malformed
  header dropped at the HTTP layer; the NaN guard exists in code but is unreachable via raw HTTP */ });
```

Result transcript:

```text
AUDIT chunked status: 401     ← passed the cap middleware; rejected later at auth
control (CL 300KB): 413       ← cap works when the header is present
Test Files 1 failed (the intentional bypass-documentation assertion pattern)
[probes then deleted; shipped suite unaffected: 23/23, 220/220]
```

Probe 2 — static asset fix (§14.9):

```text
GET /assets/css/checkout.css → 404 (ASSETS not-found), NOT 500
  X-Content-Type-Options: "nosniff"   ← applied (hono secureHeaders, mounted on *)
  X-Frame-Options: "DENY"             ← applied
  Content-Type: null; empty body      ← the binding's own 404
Conclusion: immutable-header crash eliminated (v3 reproduced 500 via TypeError);
asset remains unservable due to path double-prefix (V4-007).
```

## Appendix D — REMEDIATIONS.md audited row-by-row

Presented in full in §15 (30 rows, verdicts + notes). Machine-checkable correction list:

```json
{ "row": "EDGE-P0-005", "action": "status→PARTIAL; remove-or-rejustify test citation",
  "row": "EDGE-P1-006", "action": "status→PARTIAL (reconciliation residual open)",
  "row": "EDGE-P2-006", "action": "status→PARTIAL; 'active' true only for dev/staging; remove observability.ts from files",
  "row": "V3-002", "action": "write cited test or drop citation", "row": "V3-003", "action": "write cited test or drop citation",
  "row": "V3-005", "action": "status→NOT FIXED (core); write bypass test when fixing",
  "row": "V3-006", "action": "write cited test or drop citation", "row": "V3-007", "action": "write cited test or drop citation; url-guard.ts not modified",
  "id_aliases": { "ledger EDGE-P2-001..005": "series NEW-P2-001..005",
                  "ledger EDGE-P3-001": "series NEW-P3-001", "ledger EDGE-P3-002": "series NEW-P3-002" },
  "missing_rows": 42, "ci_gate": "absent — required (V4-011)" }
```

## Appendix E — The leaked token: decoded evidence

```text
file:   sms-phone-mockup/.companion-state.json  (ships in new-1.zip AND new-2.zip)
fields: edgepay_url = https://edgepay-cf.bm-jonybepary.workers.dev   ← production
        jwt_token    (type access)  exp 2026-09-02T03:07:39Z         ← expired
        refresh_token(type refresh) exp 2026-10-01T00:43:51Z         ← LIVE at audit time
payload(refresh): { sub: "6", merchant_id: 8, device_id: 4, scope: ["read","write"],
                    type: "refresh", iss: "edgepay-cf", aud: "mobile" }
endpoints: POST /api/mobile/v1/refresh | /api/mobile/v1/devices/token-refreshes
           (mobile.ts:102–119 — no secondary auth; mounted before requireJwtAuth)
impact:   read/write mobile API for merchant 8 on production until 2026-10-01
kill-switch: rotate production JWT_SECRET (also closes EDGE-P0-001 prod half)
file hygiene: not in .gitignore; heartbeat timestamps prove live use against
              production minutes before the zip was cut (03:12:15Z vs zip 07:18Z)
```

## Appendix F — Finding-ID registry (frozen)

```text
EDGE-P0-001..007   report 2 (first full audit)      P0 set
EDGE-P1-001..010   report 2                          P1 set
EDGE-P2-001..020   report 2                          P2 set
EDGE-P3-001..012   report 2                          P3 set
NEW-P1-001..002, NEW-P2-001..005, NEW-P3-001..005
                   report 3 (v0.3.0 release audit)
V3-001..V3-011     report 4 (first remediation release)
V4-001..V4-011     THIS REPORT (second remediation release)
Alias map for the ledger's seven collided rows: ledger EDGE-P2-001…005 →
series NEW-P2-001…005; ledger EDGE-P3-001/002 → series NEW-P3-001/002.
Rule: new findings append a new series prefix (V5-…); no ID may be reused
across series, and REMEDIATIONS.md must cite the series ID exactly.
```


---

## Appendix G — The new regression test: annotated structure

`tests/mobile-notifications.test.ts` (v4, 2 tests) — the structure that makes it a genuine regression test rather than a formality:

```ts
describe('Mobile Notification Tenant & Device Isolation (EDGE-P3-003 / V3-001)', () => {
  beforeAll(async () => {
    // (1) REAL persistence: two merchants, two users, two paired devices,
    //     one notification bound to merchant A's device — all inserted via
    //     the real D1 binding (env.DB), not mocks.
    // (2) REAL credentials: createJwtService(env).issueAccessToken({
    //       sub, merchant_id, device_id, scope }) — device_id travels in the
    //       JWT payload exactly as the pairing flow issues it.
  });

  it('prevents Merchant B from acknowledging Merchant A notification', async () => {
    // (3) REAL route: SELF.fetch(POST /api/mobile/v1/notifications/acknowledgements,
    //     Authorization: Bearer <merchant B token>) — through requireJwtAuth,
    //     the middleware chain, and the scoped UPDATE.
    expect(json.data.acknowledged).toBe(0);          // honest row count — the fix's
                                                    // meta.changes reporting makes
                                                    // this assertion meaningful
    // (4) DB-level assertion: notification A's read_at is still NULL — the
    //     test does not trust the response; it verifies the row.
  });

  it('allows Merchant A to acknowledge their own notification', async () => {
    // positive control through the same path; acknowledged === 1 and read_at set
  });
});
```

Why this template matters beyond the finding: it is the shape every ledger citation should point at — real persistence, real credentials, real route, response **and** database assertions. The five missing tests of §37 item 5 should be written in exactly this mold.

## Appendix H — Developer claims vs artifact: quote-by-quote

The remediation summary's operative sentences, with the artifact's answer to each:

| Quote (condensed) | Artifact's answer |
|---|---|
| "Updated POST …acknowledgements in mobile.ts with AND merchant_id = ? AND device_id = ?" | **True** — predicate present, bound from JWT context |
| "Populated deviceId directly from verified JWT access token payloads in auth.ts" | **True** — `c.set('deviceId', payload.device_id ?? null)` |
| "Added unit test suite mobile-notifications.test.ts verifying that cross-tenant / cross-device acknowledgement attempts affect 0 rows" | **True** (cross-tenant+cross-device simultaneously; no same-merchant-different-device case) |
| "Enforced isAllowedWebhookUrl() in webhook-dispatcher.ts and api.ts before creating test webhook endpoints" | **True** — both layers verified |
| "Reordered refund.ts so the atomic conditional INSERT … executes before the external gateway API call" | **True** — reserve-then-call with NULL-then-backfill gateway id |
| "Enhanced the 128 KB payload middleware … to guard mutating HTTP methods" | **Misleading** — method-scoping + NaN added; the core defect (header-only) persists; live-bypassed |
| "Switched IP extraction … to CF-Connecting-IP directly and keyed anonymous throttles on route classes" | **True** |
| "Updated SSRF guard in url-guard.ts and webhook-consumer.ts to require an explicit ALLOW_LOCAL_WEBHOOK_TARGETS configuration" | **Substantially true** — all call sites migrated; url-guard.ts itself unchanged (attribution off) |
| "Replaced all any casts in admin-api.ts and api.ts with strict ApiVariables" | **True** — zero `as any` in src/ |
| "Generated fresh local dev keys, created .dev.vars.example" | **True** (dev keys); example *rewritten*, not created |
| "Created the machine-readable tracking ledger REMEDIATIONS.md" | **True in form; fails integrity audit** (§15) |
| "The 500 error on static assets … is now fixed … index.ts:244-250 … mutable new Response wrapper, and security-headers.ts safely guards header mutation" | **True** (probe-verified); throwing layer was hono secureHeaders, not the custom middleware — attribution off, fix correct |
| "ESLint 9: 0 errors … TypeScript: 0 errors … 23/23 … 220/220 … 9.88s" | **All reproduced** (7.66s here) |
| "The System is 100% Healthy and Fully Fixed" / "Fixed: All 39 Problems" | **False** — ≥31 open findings; 1 claimed-fixed defect live-bypassed; prod telemetry dark; live credential in artifact |

## Appendix I — Operator's 7-day list: exact commands

```bash
# 1. Rotate the production JWT secret (kills the leaked refresh token + all
#    outstanding mobile tokens; closes the production half of EDGE-P0-001)
wrangler secret put JWT_SECRET --config wrangler.jsonc
#   then: re-pair the developer mockup; verify the old refresh token 401s:
curl -s -X POST https://edgepay-cf.bm-jonybepary.workers.dev/api/mobile/v1/refresh \
     -H 'Content-Type: application/json' \
     -d '{"refresh_token":"<value from .companion-state.json>"}'   # expect 401

# 2. Purge the state file from the repo and future zips
git rm --cached sms-phone-mockup/.companion-state.json
printf '\n# mockup runtime state — never ship\nsms-phone-mockup/.companion-state.json\n' >> .gitignore
#   cut future artifacts from a clean tree:  git archive --format=zip -o edgepay.zip HEAD

# 3. Enable production Analytics (then deploy)
$EDITOR wrangler.jsonc    # uncomment the analytics_engine_datasets block
wrangler deploy
wrangler tail --format pretty   # confirm metrics writes; check the dashboard dataset

# 4–7. Ledger corrections, the five tests, the streamed cap, the CI gate —
#      see §37; the corrected ledger skeleton is appendix D's JSON block.
```

## Appendix J — Series statistics

```text
Audit hours (auditor-side, cumulative):  reports 1–4 as filed; this report:
  extraction + diff authorship .........  ~1.5 h
  battery re-execution .................  ~0.5 h
  claim + ledger verification ..........  ~2 h
  adversarial probes (2) ...............  ~0.5 h
  report authorship ....................  ~3 h
Artifact lineage:
  v0.1 → v0.3.0 → v0.3.0-r1 → v0.3.0-r2 → v0.4.0
Findings ledger (72 tracked + 11 V4 = 83 total):
  fixed & held: 38   partial: 12   open: 24   integrity-class: 5 (+V4-001 family)
  false-or-overstated claims across rounds: 7 instances over 3 remediation
  releases — every one detectable mechanically (diff + manifest resolution)
Battery: 23 files / 220 tests / 0 skipped / 0 flakes in 3 consecutive runs
Word count of this report: ~28,200 / sections: 60 (§1–§60) + 13 appendices (A–M)
```
## Appendix K — REMEDIATIONS.md as shipped (verbatim, for the record)

The artifact under audit, reproduced without modification (30 rows as delivered; the audit of each row is §15; the corrected superset is §52). Preserved here because the repo may edit it in response to this report — the audit record should contain what was actually claimed.

```markdown
# EDGEpay-CF — Comprehensive Remediation Ledger & Audit Verification Matrix

This ledger provides a line-referenced, artifact-verifiable record of all
findings and remediations across the audit series (EDGEPAY_CF_FULL_AUDIT_REPORT_1.md
and EDGEPAY_CF_FULL_AUDIT_REPORT_2.md).

## Remediation Matrix

| Finding ID | Severity | Category | Status | File(s) Modified | Verification Test ID |
| :--- | :--- | :--- | :--- | :--- | :--- |
| EDGE-P0-001 | P0 | Secrets | FIXED | scripts/verify-*.mjs, .dev.vars.example | Verified zero literal secret fallbacks in codebase; .dev.vars purged and rotated. |
| EDGE-P0-002 | P0 | Money / Ledger | FIXED | src/services/ledger.ts, src/services/refund.ts | tests/ledger-consistency.test.ts (Idempotent refund posting by public ID). |
| EDGE-P0-003 | P0 | Money / Ledger | FIXED | src/services/refund.ts | tests/payment-integrity.test.ts (Cumulative refund limits). |
| EDGE-P0-004 | P0 | Payment Integrity | FIXED | src/services/payment.ts | tests/payment-integrity.test.ts (Amount and trx_id binding in callbacks). |
| EDGE-P0-005 | P0 | Auth / Install | FIXED | src/controllers/install.ts, src/services/bootstrap.ts | tests/tenant-routing.test.ts (Post-install secret posture protection). |
| EDGE-P0-006 | P0 | XSS / Checkout | FIXED | src/controllers/checkout.ts | tests/smoke.test.ts (CSP headers, HTML attribute escaping). |
| EDGE-P0-007 | P0 | Payment Integrity | FIXED | src/controllers/checkout.ts, src/services/sms-corroboration.ts | tests/sms-corroboration-edgecases.test.ts (Strict exact decimal amount check). |
| EDGE-P1-001 | P1 | Concurrency | FIXED | src/middleware/idempotency.ts | tests/api-middleware.test.ts (Idempotency cache & body hash check). |
| EDGE-P1-002 | P1 | Brute Force | FIXED | src/index.ts, src/middleware/rate-limit.ts | tests/api-middleware.test.ts (OTP rate limiting on mobile pairing). |
| EDGE-P1-003 | P1 | DoS / Memory | FIXED | src/index.ts | tests/api-middleware.test.ts (128 KB request payload cap). |
| EDGE-P1-004 | P1 | SSRF | FIXED | src/lib/url-guard.ts, src/queues/webhook-consumer.ts | tests/url-guard.test.ts (SSRF guard blocking private IPv4/IPv6, encoded IPs, redirects). |
| EDGE-P1-005 | P1 | Privilege Escalation | FIXED | src/controllers/admin-api.ts | tests/tenant-routing.test.ts (requirePlatformAdmin is_platform = 1 check on /merchants). |
| EDGE-P1-006 | P1 | State Machine | FIXED | src/services/payment.ts | tests/payment-integrity.test.ts (Terminal state guards on transactions). |
| EDGE-P1-008 | P1 | Authorization | FIXED | src/controllers/api.ts | tests/api-middleware.test.ts (Enforced requireScope('write') on mutating verbs). |
| EDGE-P2-001 | P2 | Concurrency | FIXED | src/services/refund.ts | tests/payment-integrity.test.ts (Atomic conditional INSERT for refund bound). |
| EDGE-P2-002 | P2 | Decimal Safety | FIXED | src/services/payment.ts, src/lib/money.ts | tests/money.test.ts (Strict cmp() exact decimal comparisons). |
| EDGE-P2-003 | P2 | Payment Integrity | FIXED | src/services/payment.ts | tests/payment-integrity.test.ts (Mandatory amount verification for API gateways). |
| EDGE-P2-004 | P2 | Secrets | FIXED | src/controllers/admin-api.ts | tests/tenant-routing.test.ts (One-time claim token flow for merchant provisioning). |
| EDGE-P2-005 | P2 | Abuse Hardening | FIXED | src/index.ts, src/middleware/rate-limit.ts | tests/api-middleware.test.ts (Rate-limiting on /checkout/*/verify). |
| EDGE-P2-006 | P2 | Observability | FIXED | wrangler.jsonc, src/lib/observability.ts | Verified analytics_engine_datasets active and bound to ANALYTICS. |
| EDGE-P3-001 | P3 | Code Cleanup | FIXED | src/services/sms-corroboration.ts | tests/sms-corroboration-edgecases.test.ts (Removed dead operand). |
| EDGE-P3-002 | P3 | Tooling | FIXED | eslint.config.js, package.json | Verified npm run lint with ESLint 9 flat config. |
| EDGE-P3-003 / V3-001 | P3 | Tenant Isolation | FIXED | src/controllers/mobile.ts | tests/mobile-notifications.test.ts (Strict merchant_id & device_id predicate on ack UPDATE). |
| V3-002 | P2 | SSRF | FIXED | src/services/webhook-dispatcher.ts, src/controllers/api.ts | tests/url-guard.test.ts (sendTest and POST /webhooks/tests validate URL before INSERT). |
| V3-003 | P2 | Money / Ordering | FIXED | src/services/refund.ts | tests/payment-integrity.test.ts (Reserve-then-call: atomic DB reservation BEFORE gateway call). |
| V3-005 | P2 | DoS / Payload | FIXED | src/index.ts | tests/api-middleware.test.ts (Hardened payload cap checking mutating requests). |
| V3-006 | P3 | Abuse Hardening | FIXED | src/middleware/rate-limit.ts | tests/api-middleware.test.ts (CF-Connecting-IP and route-class keying for anonymous limits). |
| V3-007 | P3 | Security Guard | FIXED | src/lib/url-guard.ts, src/queues/webhook-consumer.ts | tests/url-guard.test.ts (Explicit ALLOW_LOCAL_WEBHOOK_TARGETS opt-in flag). |
| V3-009 | P3 | Type Safety | FIXED | src/controllers/admin-api.ts, src/controllers/api.ts | npm run typecheck & npm run lint (Replaced any with strict ApiVariables). |
```

For the record, the five audit-relevant properties of this document as shipped: (1) the preamble claims series-wide coverage while listing 30 of 83 tracked findings; (2) rows EDGE-P2-001…005 and EDGE-P3-001/002 use IDs that alias to different, mostly-open findings in the series registry; (3) five rows' Verification Test IDs name coverage that does not exist in the artifact; (4) EDGE-P2-006's "verified active" is true only of dev/staging configs; (5) EDGE-P0-005 and EDGE-P1-006 claim FIXED on files byte-identical to the previously audited release.

## Appendix L — Key v3→v4 unified diffs (evidence excerpts)

The seven diffs that carry this round's security-relevant changes, abridged to the operative hunks. Full diffs reproduce with `diff -u` against the two zips.

**L.1 mobile.ts — V3-001 (the predicate):**

```diff
-// Acknowledge notifications
+// Acknowledge notifications — strictly tenant and device scoped (V3-001 / EDGE-P3-003 fix)
 mobileRoutes.post('/notifications/acknowledgements', async (c) => {
+  const merchantId = c.get('merchantId')!;
+  const deviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;
   const body = await c.req.json<{ notification_ids?: number[] }>();
…
-  await c.env.DB.prepare(
-    `UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (${placeholders})`
-).bind(new Date().toISOString(), ...body.notification_ids).run();
+  const res = await c.env.DB.prepare(
+    `UPDATE op_mobile_notifications SET read_at = ? WHERE id IN (${placeholders}) AND merchant_id = ? AND device_id = ?`
+  ).bind(new Date().toISOString(), ...body.notification_ids, merchantId, deviceId).run();
-  return c.json({ success: true, data: { acknowledged: body.notification_ids.length } });
+  return c.json({ success: true, data: { acknowledged: res.meta?.changes ?? body.notification_ids.length } });
```

**L.2 auth.ts — deviceId plumbing:**

```diff
-interface ApiVariables {
+export interface ApiVariables {
   merchantId: number | null;
   authSubject: number | null;
+  deviceId?: number | null;
…
     c.set('authType', 'jwt');
     c.set('authSubject', parseInt(payload.sub, 10));
+    c.set('deviceId', payload.device_id ?? null);
```

**L.3 refund.ts — V3-003 (reserve-then-call; abridged, see §18 for the full order):**

```diff
-    // 2. Ask the gateway to issue the refund …
-    let gatewayRefundId: string | null = null;
-    try { … adapter.refund(…) … }
+    // 2. Atomically reserve the refund row with conditional bound check FIRST (V3-003 fix)
+    const inserted = await env.DB.prepare(
+        `INSERT INTO op_refunds (…, gateway_refund_id, …)
+         SELECT ?, ?, ?, NULL, ?, ?, ?, 'pending', ?, ?, ?
+         WHERE ((SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0) …) + ?
+                <= (SELECT amount FROM op_transactions …) + 0.001)` …
+    // 3. Ask the gateway to issue the refund after the atomic reservation is locked
+    … const result = await adapter.refund(…);
+      if (result.success && result.refund_id) {
+        await env.DB.prepare(`UPDATE op_refunds SET gateway_refund_id = ?, updated_at = ? WHERE id = ?`)…
+      }
```

**L.4 index.ts — V3-005 scoping + the asset wrapper:**

```diff
 app.use('*', async (c, next) => {
-  const cl = c.req.header('content-length');
-  if (cl && parseInt(cl, 10) > 128 * 1024) { return c.json({ … }, 413); }
+  const method = c.req.method;
+  if (['POST', 'PUT', 'PATCH'].includes(method)) {
+    const cl = c.req.header('content-length');
+    if (cl) { const len = parseInt(cl, 10);
+      if (isNaN(len) || len > 128 * 1024) { return c.json({ … }, 413); } }
+  }
   return next();
 });
…
-app.get('/assets/*', (c) => {
-  return c.env.ASSETS.fetch(c.req.raw);
+app.get('/assets/*', async (c) => {
+  const res = await c.env.ASSETS.fetch(c.req.raw);
+  return new Response(res.body, res);
 });
```

**L.5 rate-limit.ts — V3-006:**

```diff
 function getClientIp(headers: Headers): string {
-  return headers.get('CF-Connecting-IP') ??
-         headers.get('X-Real-IP') ??
-         headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
-         '0.0.0.0';
+  return headers.get('CF-Connecting-IP') ?? '0.0.0.0';
 }
…
-    const key = `${config.keyPrefix}${clientIp}:${c.req.path}`;
+    const key = `${config.keyPrefix}${clientIp}:${group}`;
```

**L.6 webhook-dispatcher.ts / webhook-consumer.ts / api.ts — V3-002 + V3-007:**

```diff
+      const { isAllowedWebhookUrl } = await import('../lib/url-guard');
+      if (!isAllowedWebhookUrl(urlToUse, this.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
+        return { success: false, error: 'Target webhook URL is blocked by SSRF protection' };
+      }
…(consumer)
-      if (!isAllowedWebhookUrl(webhook.url, env.ENVIRONMENT !== 'production')) {
+      if (!isAllowedWebhookUrl(webhook.url, env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
…(api.ts registration + test route)
-  if (!isAllowedWebhookUrl(body.url, c.env.ENVIRONMENT !== 'production')) {
+  if (!isAllowedWebhookUrl(body.url, c.env.ALLOW_LOCAL_WEBHOOK_TARGETS === '1')) {
```

**L.7 wrangler configs — the analytics asymmetry (V4-002's evidence):**

```diff
--- wrangler.jsonc (PRODUCTION)          --- wrangler.dev.jsonc / staging
-  // Analytics Engine — per-merchant metrics …
+  // Analytics Engine … (EDGE-P2-006)
   // "analytics_engine_datasets": [        -  // "analytics_engine_datasets": [
   //   { "binding": "ANALYTICS", … }        +  "analytics_engine_datasets": [
   // ]                                      +    { "binding": "ANALYTICS", "dataset": "edgepay_metrics" }
                                             +  ]
```

## Appendix M — Reproducing this audit

```bash
# 0. obtain the zips (series artifacts) and this report's baselines
mkdir -p audit && cd audit
unzip -q ../upload/edgepay-cf-clean-new-1.zip -d v3ref/
unzip -q ../upload/edgepay-cf-clean-new-2.zip -d v4/

# 1. diff authorship — what changed, what didn't (V4 verdicts' backbone)
diff -qr v3ref/edgepay-cf v4/edgepay-cf | grep -v node_modules

# 2. battery (clean)
cd v4/edgepay-cf && npm ci && npx tsc --noEmit && npx eslint src tests && npx vitest run
#    expect: 0 / 0 problems / 23 files / 220 tests

# 3. citation integrity (the V4-001 check, by hand)
md5sum ../../v3ref/edgepay-cf/tests/url-guard.test.ts tests/url-guard.test.ts
md5sum ../../v3ref/edgepay-cf/tests/api-middleware.test.ts tests/api-middleware.test.ts
diff -u ../../v3ref/edgepay-cf/tests/payment-integrity.test.ts tests/payment-integrity.test.ts | grep -c 'it('
#    expect: identical hashes; zero new it( blocks

# 4. config assertion (the V4-002 check)
grep -n 'analytics_engine_datasets' wrangler.jsonc wrangler.dev.jsonc wrangler.staging.jsonc

# 5. the V3-005 probe (appendix C) and the asset probe — write, run, remove
# 6. the leaked-token check (the V4-004 check)
node -e "console.log(JSON.parse(Buffer.from(
  require('fs').readFileSync('sms-phone-mockup/.companion-state.json','utf8')
  .match(/refresh_token":"([^"]+)/)[1].split('.')[1],'base64url').toString()))"
```


---

*Report 5 of 5 in the current series. Prepared for the EDGEpay-CF maintainership as an independent verification of the second remediation release. Evidence artifacts: the four distribution zips, the recovered report 4 (byte-identical, MD5 `abb54408…`), the re-executed battery transcript of §13, and the probe transcripts of appendix C. The three operator actions of §8 gate pilot eligibility; the roadmap of §38 gates real-money production. Series findings registry: appendix F — frozen; future findings continue at V5-001.*
