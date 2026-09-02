# EDGEpay v0.4.0 (remediation release 3) — Remediation Verification, Full Re-Audit, Gate-Integrity Analysis & Credential-Exposure Follow-Through Report

**Series:** EDGEpay-CF independent audit — Report 4 (Round 4)
**Subject:** `edgepay-cf-clean-new-3.zip` — the developer's "Audit Report 3 Remediations Implemented" release
**Artifact MD5:** `7203316c47561ab8de2775c72a827a80` (1,026,380 bytes)
**Prior reports in series:** Report 1 (14 finding groups, `edgepay-cf-clean.zip`), Report 2 (`edgepay-cf-clean-new-1.zip`, MD5 `abb54408...` lineage), Report 3 (`edgepay-cf-clean-new-2.zip`, delivered at `http://sendit.sh/ZEKDn/FxDyv.md`, MD5 `0dd145e936500138f4a2767c36f2f17b` — the v5 artifact embeds this report byte-identically, confirming chain of custody).
**Audit dates:** 2026-09-02, 03:29–05:00 UTC
**Auditor posture:** adversarial verification — every developer "FIXED" claim is re-derived from the artifact, re-executed, and where possible live-proven. Nothing in the developer's verification summary is accepted on faith.

---

## Executive summary in one paragraph

The developer's third remediation release is **the strongest code drop of the series and the weakest credential-hygiene drop of the series, simultaneously**. Four code fixes claimed this round are genuine and independently live-proven: the payload cap is now the outermost middleware and closes the Report-3 chunked-body bypass with a correct 411/413 contract (PoC: a 300 KB streamed POST with no Content-Length is rejected 411 *before* authentication); the `/assets/*` prefix rewrite actually serves `/assets/css/checkout.css` with a 200 and full security headers (their own test hedged this — mine does not); the mobile heartbeat is now device- and tenant-scoped with real auth-context plumbing (my discriminating PoC proves the UPDATE lands and that a cross-tenant token cannot move the row); and the merchant-claim route now carries a genuine platform-admin gate (a non-platform admin key gets 403 and does not consume the one-time token). The full battery reproduces exactly: ESLint 0/0, `tsc --noEmit` 0 errors, 28 test files / 233 tests / 100% green in workerd — the numeric claims in the developer's message are accurate. **But two of the loudest claims are false:** the "purged" `.companion-state.json` is still in the zip — now carrying an access token *minted after Report 3 was delivered* alongside the same, never-rotated refresh token valid until 2026-10-01 (V5-001, the single worst finding of this round); and the ledger's "V4-002 Telemetry & Observability Fallback — FIXED" row is fabricated against byte-identical, still-commented-out production telemetry config. The new verification infrastructure (CI workflow, two gate scripts, 47-row ledger) is real, mostly well-formed, and a genuine process step forward — but its two scripts check *file existence* and *git-tracked status*, which is precisely why they pass while a live credential sits two directories away from them inside the same archive. The release is pilot-eligible **only after** the production `JWT_SECRET` is rotated (killing the shipped refresh token), and remains **not production-ready**.

---

## Table of Contents

- **PART I — EXECUTIVE SUMMARY**
  - §1. What this audit is
  - §2. Headline results (the scorecard)
  - §3. The four code fixes are real — live-proven
  - §4. The two false claims: V4-004 (credential purge) and V4-002 (telemetry)
  - §5. A live production credential ships in the artifact — again, fresher (V5-001)
  - §6. The new gates are real but toothless at the artifact layer (V5-003/V5-004)
  - §7. Build & verification claim reproduction (independently re-executed)
  - §8. An auditor retraction, recorded for honesty (the `audit-gate.yml` non-finding)
  - §9. Overall production-readiness verdict
- **PART II — AUDIT METHOD, ENVIRONMENT & EVIDENCE**
  - §10. Method and evidence rules
  - §11. Environment and artifacts
  - §12. The v5 delta — complete change inventory (what actually changed)
  - §13. Independently re-executed verification battery
- **PART III — REMEDIATION CLAIM VERIFICATION (CLAIM BY CLAIM)**
  - §14. Claim 1: Payload cap at the outermost layer + 411/413 (V4-005, V4-010, V3-005)
  - §15. Claim 2: Static-assets path rewriting (V4-007)
  - §16. Claim 3: Mobile heartbeat tenant & device scoping (EDGE-P3-002)
  - §17. Claim 4: Admin merchant-claim platform gate (V3-010)
  - §18. Claim 5: Credential hygiene & state-file purge (V4-004) — **FALSE**
  - §19. Claim 6: New automated test suites & benchmarks (V4-001)
  - §20. Claim 7: Automated CI & audit gate (V4-011, V4-003, V4-008)
  - §21. Claim 8: The verification summary's numbers (lint / tsc / ledger / tests)
- **PART IV — INDEPENDENT LIVE PoCs & FORENSICS**
  - §22. PoC battery design and why it exists
  - §23. PoC results: payload cap (the Report-3 bypass replay)
  - §24. PoC results: assets serving
  - §25. PoC results: heartbeat scoping (discriminating test)
  - §26. PoC results: claim gate (negative + positive + one-time)
  - §27. PoC results: refund ordering (correct-instrumentation replay)
  - §28. JWT forensics on the shipped state file (decode + HMAC negative)
- **PART V — CONSOLIDATED FINDING LEDGER**
  - §29. Carried-forward findings (unchanged files, diff-proven)
  - §30. V5 finding registry (eleven new findings, this round)
  - §31. Ledger completeness audit — what REMEDIATIONS.md still omits
  - §32. Movement analysis (v4 → v5)
- **PART VI — TEST-SUITE QUALITY REVIEW**
  - §33. The five new test files: real, green, and three of five flawed
  - §34. The two gate scripts: what they verify and what they cannot
  - §35. The vacuous-assertion taxonomy (with fixes)
- **PART VII — VERDICT & OPERATOR ACTIONS**
  - §36. Verdict
  - §37. Operator action list (ranked, with effort estimates)
  - §38. What would make Report 5 short
- **APPENDICES**
  - A. Auditor PoC suite source (15 tests)
  - B. PoC run transcript
  - C. JWT forensic detail (v4 vs v5 state files)
  - D. Claim verification matrix (developer message → verdict)
  - E. The retraction record (`audit-gate.yml` display artifact)
  - F. Reproduction commands
  - G. Series finding registry (cumulative status)

---

# PART I — EXECUTIVE SUMMARY

## 1. What this audit is

This is the fourth independent audit of the EDGEpay-CF payment platform and the third verification pass over the developer's remediation claims. The cycle is now familiar: an audit report lands, the developer publishes a remediation summary asserting that every finding is fixed, a new zip arrives, and this auditor's job is to determine — from the artifact alone — which claims are true, which are partially true, and which are false. Report 3 (delivered 2026-09-02, ~04:40 UTC, embedded byte-identically in the new zip) closed the previous round with eleven new findings (V4-001…V4-011), the worst of which were: fabricated test citations in the remediation ledger, a live production refresh token shipped inside `sms-phone-mockup/.companion-state.json`, and a payload cap that still admitted unlimited chunked bodies.

The developer's response — pasted verbatim as this round's commission — claims all Report-3 findings are "addressed and verified with unit, white-box, black-box, and API test suites," enumerating six remediation areas (payload cap hardening, assets path rewriting, heartbeat scoping, claim-route gating, credential purge, new tests + CI gate) and a verification summary of `0 lint errors / 0 tsc errors / 46 ledger rows verified / 28 test files / 233 tests / ~13.8s`. This report verifies each of those claims against the artifact, re-executes every verification command, and adds fifteen auditor-authored PoCs designed to be *discriminating* — tests that can fail, unlike several of the shipped ones.

## 2. Headline results (the scorecard)

| # | Developer claim (this round) | Verdict | Evidence |
|---|---|---|---|
| 1 | Payload cap moved to outermost layer; 411 on missing CL for POST/PUT/PATCH/DELETE; 413 on invalid/oversized | **TRUE** | Code at `src/index.ts:81-100` (before domain/maintenance/CORS/auth); PoC-1/2 (§23) |
| 2 | `/assets` prefix stripped before ASSETS fetch | **TRUE** | Code at `src/index.ts:253-259`; PoC-3 (§24): 200 + `text/css` + `nosniff`/`DENY` |
| 3 | Heartbeat scoped to authenticated device + tenant | **TRUE (code)** — shipped test is vacuous | Code at `src/controllers/mobile.ts:126-130` + `src/middleware/auth.ts:160,167`; PoC-4 (§25) |
| 4 | `/merchants/claim` gated to platform admin | **TRUE (code)** — cited test has no coverage | Code at `src/controllers/admin-api.ts:271` + `requirePlatformAdmin` at `:247-259`; PoC-5 (§26) |
| 5 | `.companion-state.json` purged & untracked; `.gitignore` hardened; `verify-config.mjs` prevents commits | **FALSE** — file ships with a *fresher* live token | §18, §28: file present (1,119 B), access token `iat 2026-09-02T03:47:45Z`, refresh token unchanged (exp 2026-10-01) |
| 6 | Five new test suites (payload-cap, refund-ordering, ssrf-webhook, assets-serving, mobile-heartbeat) | **TRUE, with quality defects** | §19, §33: 5 files / 13 tests, all green; 3 of 5 have defective assertions |
| 7 | `verify-remediations.mjs`, `verify-config.mjs`, `audit-gate.yml`, updated REMEDIATIONS.md + TEST_RESULTS.md | **PARTIAL** | §20: workflow valid (hexdump-verified); scripts run green but are materially blind (§34) |
| 8 | ESLint 0/0, tsc 0 errors, 46 rows verified, 28 files / 233 tests, 100% green | **TRUE** (numbers match; docs inflate) | §13, §21: reproduced 0/0, 0 errors, 46 rows, 28/233 in 7.07s; TEST_RESULTS.md claims "240+" |
| 9 | Ledger: "complete non-colliding finding registry" | **PARTIAL** | §31: 47 unique IDs ✓, but ≥9 known findings still absent (incl. V3-004, V3-008, V4-006) |
| 10 | (Ledger row) V4-002 Telemetry & Observability Fallback — FIXED, cited `tests/smoke.test.ts` | **FABRICATED** | §4: `wrangler.jsonc` + `observability.ts` byte-identical to v4; `analytics_engine_datasets` still commented; zero observability assertions in smoke.test.ts |

**Series-defining asymmetry, quantified:** of the 47 rows in the shipped ledger, 4 of this round's claims are code-true and live-proven, 1 is outright false (V4-004), 1 is fabricated (V4-002), and the carried backlog — every finding whose files did not change this round — remains open. The diff is surgical: exactly **three source files changed** (`src/index.ts` +28/−19, `src/controllers/mobile.ts` +4/−3, `src/controllers/admin-api.ts` +2/−2). Everything else in `src/` is byte-identical to v4, which is simultaneously good news (no regressions possible outside those three files) and the proof that every other carried finding is untouched.

## 3. The four code fixes are real — live-proven

This deserves emphasis because it is the round's genuine progress, and it is *real* engineering, not paperwork:

1. **The payload cap is finally a ceiling.** The middleware now runs at the outermost layer (after request-id/logging, before bootstrap, domain, maintenance, CORS, security headers, and all authentication), covers POST/PUT/PATCH/**DELETE**, returns **411 Length Required** when Content-Length is absent (the chunked-stream case that Report 3 live-proved as a bypass), and 413 on non-numeric or >128 KiB values. My replay of the exact Report-3 PoC — a 300 KB streamed body with no Content-Length against a protected route with no credentials — now returns **411 before authentication** (v4 returned 401, having skipped the cap entirely). The bypass class is closed at the Worker layer. Residuals are minor and documented (§23.3): `parseInt` leniency on malformed-but-leading-numeric values, and the RFC-correct-but-behavior-changing 411 contract for bodyless DELETEs.

2. **The asset path rewrite is correct.** `/assets/css/checkout.css` now strips the prefix, forwards `/css/checkout.css` to the ASSETS binding (mapped to `./public/assets`), and returns through the mutable `new Response(res.body, res)` wrapper that fixed the v3-era 500s. My PoC gets **200, `text/css`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`**, and missing assets return a clean 404. Notably, the shipped test *hedged* this (`expect([200, 404]).toContain(...)`) — the auditor PoC removes the hedge and the fix still stands.

3. **The heartbeat is scoped.** The handler now reads `deviceId` from the JWT-derived auth context (set by `requireJwtAuth` at `auth.ts:160`) and `merchantId` (set at `auth.ts:167`), and the UPDATE carries `WHERE id = ? AND merchant_id = ?`. My discriminating PoC — which seeds `last_heartbeat_at = 2000-01-01` and asserts the value *changes* — passes for the same-tenant token and proves a cross-tenant token (merchant B, foreign device id) leaves the row untouched. The shipped test could not detect the difference between fixed and unfixed code (§33); the code is nonetheless correct.

4. **The claim route is gated.** `POST /api/admin/v1/merchants/claim` now chains `requireScope('admin')` and a real `requirePlatformAdmin` middleware that looks up `is_platform = 1` for the authenticated merchant. My PoC shows a non-platform admin key receives **403 FORBIDDEN** ("Platform administrator privileges required"), the one-time KV token is *not consumed* by the rejected attempt, and a platform key redeems exactly once (second attempt 404). This closes V3-010's tenant-key redemption path.

## 4. The two false claims: V4-004 (credential purge) and V4-002 (telemetry)

**V4-004 — "Purged sms-phone-mockup/.companion-state.json and untracked it from the Git index."** The file is in the zip. Same path, same 1,119 bytes as v4, still first in the zip listing of its directory. What changed is *worse than nothing*: the embedded access token was **re-minted after Report 3 was delivered** (v4's token: `iat 1788317259` = 02:47:39 UTC; v5's: `iat 1788320865` = 03:47:45 UTC — one hour later, roughly when this release was being packaged), and the **refresh token is byte-identical** to the one Report 3 flagged — still valid until **2026-10-01T00:43:51Z**, still un-rotated, still signed by the production secret (verified: it does *not* verify against the shipped `.dev.vars` secret, so the zip is a credential-theft vector, not a forgery kit — §28). The remediation's actual mechanism — adding `**/.companion-state.json` to `.gitignore` — cannot remove a file from a *zip*, and the new `verify-config.mjs` gate is structurally incapable of noticing (§6). This is the third consecutive release shipping this file, and the first to ship it *after* claiming to have purged it.

**V4-002 — ledger row "Telemetry & Observability Fallback — FIXED — `wrangler.jsonc`, `src/lib/observability.ts` — `tests/smoke.test.ts`."** Neither file changed this round (both absent from the v4→v5 diff), the production `analytics_engine_datasets` binding is **still commented out** in `wrangler.jsonc` (lines 239–240, exactly as Report 3 quoted), `observability.ts` still guards every `writeDataPoint` behind `env.ANALYTICS?.` (a no-op without the binding), and `tests/smoke.test.ts` contains **zero** matches for "analytics", "observability", or "fallback". This is the same fabrication class Report 3 filed as V4-001 (five rows citing tests that don't exist): this time the cited test *exists* but says nothing about the claim — which the new `verify-remediations.mjs` cannot catch, because it verifies file *existence*, not content (§34).

## 5. A live production credential ships in the artifact — again, fresher (V5-001)

The forensic detail matters for risk triage, so it is worth stating precisely:

| Field | v4 (Report 3) | v5 (this round) |
|---|---|---|
| Access token `iat` | 2026-09-02 02:47:39 UTC | **2026-09-02 03:47:45 UTC** (minted post-Report-3) |
| Access token `exp` | 03:47:39 UTC | 04:47:45 UTC |
| Access token `jti` | `5c251724-395d…` | `218ed1d9-fe6b…` (new) |
| Refresh token | `iat 2026-09-01`, `exp 2026-10-01` | **byte-identical, exp 2026-10-01** |
| Subject / tenant / device | sub 6, merchant 8, device 4 | same |
| Signed with shipped `.dev.vars` secret? | no | no (HMAC-verified negative, §28) |
| File size | 1,119 B | 1,119 B |

Interpretation: the developer's pairing workflow ran against the live deployment **after** reading Report 3 (which flagged exactly this file at exactly this path), refreshed its access token using the still-valid refresh token, and re-packaged the resulting state file into the remediation release whose summary says the file was purged. The production `JWT_SECRET` has not been rotated — if it had been, the old refresh token could not have minted a fresh access token at 03:47:45. The refresh token remains redeemable for **29 more days**. Everything else in this report is secondary to the operator action this mandates: **rotate the production `JWT_SECRET` now**, and treat merchant-8/device-4 credentials as compromised.

## 6. The new gates are real but toothless at the artifact layer (V5-003/V5-004)

The release ships a genuine CI workflow (`.github/workflows/audit-gate.yml` — valid YAML, triggers `[main, master]` verified at byte level, correct step chain: `npm ci` → `verify-config` → `verify-remediations` → `typecheck` → zero-`as any` grep → `lint` → `test`) and two gate scripts. Both scripts print their green checkmarks in this environment. Both are also blind to every finding that actually matters this round:

- `verify-config.mjs` runs `git ls-files` and inspects the **git-tracked** file list. In the distributed artifact there is no `.git`, so the command either errors (caught, warned, skipped) or — as empirically observed in this audit environment — **walks up the directory tree to an unrelated repository** and silently validates *that* repo's file list. Either way: the script prints `✓ Configuration and repository hygiene verified.` while `.companion-state.json` and `.dev.vars` (with three live-format secrets) sit in the same archive, two directories away. The `sk_live_`/`whsec_` string scan is a good idea pointed at the wrong two file names.
- `verify-remediations.mjs` parses the ledger and verifies that every FIXED row's citation names a test **file that exists**. It cannot verify that the cited file contains a relevant test — which is exactly the gap V3-010's citation walks through (cites `tests/tenant-routing.test.ts`, which has 12 tests, none touching the claim route). It also has a parser bug with poetic timing: the row `V4-003` ("Finding ID Collision Resolution") is **skipped by its own verifier** because the row's category text contains the substring `Finding ID`, which the script treats as the header row. The one row that claims collision resolution is the one row the checker never sees. Total effect: `✓ 46 rows checked, 0 errors` against a ledger with 47 data rows.

## 7. Build & verification claim reproduction (independently re-executed)

Every command in the developer's verification summary was re-run from a clean `npm ci`:

| Developer claim | Auditor reproduction |
|---|---|
| `npm run lint` → ESLint 9: 0 errors, 0 warnings | ✅ 0/0 (clean output, exit 0) |
| `npm run typecheck` → tsc 0 errors | ✅ exit 0, no output |
| `node scripts/verify-remediations.mjs` → 46 rows, 0 errors | ✅ identical output — with the 47-row and V4-003-skip caveats (§34) |
| `node scripts/verify-config.mjs` → verified | ✅ prints the checkmark — vacuously (§6) |
| `npm test` → 28 files, 233 tests, ~13.8s, 100% green in workerd | ✅ **28 files / 233 tests / 100% green / 7.07s** (twice: 7.20s with PoC file present, 7.07s pristine) — machine variance on duration only |

The numeric claims are honest — a first for the series' verification summaries, and worth saying plainly. The surrounding *documentation* still inflates (TEST_RESULTS.md says "240+ tests"; the REMEDIATIONS.md preamble says "27+ test suites, 230+ tests"; the actual artifact says 28/233), which is a P4 documentation defect, not deception of the V4-002 class.

## 8. An auditor retraction, recorded for honesty (the `audit-gate.yml` non-finding)

Mid-audit, this report initially recorded a finding that the CI workflow's trigger was corrupted — `branches: ain, master]`, never matching `main`. A byte-level re-examination (`od -c`) proved the file actually contains `branches: [main, master]` — **valid YAML, correct triggers** — and that the corruption was a display artifact of the auditor's own toolchain, which swallowed the two bytes `[m` when rendering the file through a terminal pipeline. The finding is **retracted in full** and the retraction is preserved here (and in Appendix E) because the standard being applied to the developer's claims — verify at the byte level before asserting — must apply symmetrically to the auditor. The workflow is well-formed; its limitations are scope-based, not syntax-based (§20).

## 9. Overall production-readiness verdict

**Pilot-eligible, not production-ready — and this round, the blocking items are operational, not architectural.**

- **Blocks production:** (a) the live, un-rotated refresh token shipped in the artifact (V5-001) — rotate `JWT_SECRET` and the problem dies in one step; (b) production telemetry still dark (V4-002 falsely marked fixed) — the rate-limit fail-open alarm remains a no-op; (c) the ledger still carries false FIXED rows and omits the carried backlog, so the operator's control plane still cannot be trusted as a snapshot of reality; (d) the carried P1/P2 backlog (P1-007 createIntent race, P2-001 dead CSRF middleware, V3-004 claim-token KV staging, V3-008 bootstrap lockout, P2-015/016/017, P1-010) — unchanged, unclaimed, itemized in §29.
- **Genuinely improved this round:** four real code fixes, five real test files, a real CI workflow, a de-collided ledger with honest OPEN rows (P1-007, P2-001), and numeric claims that reproduce exactly.
- **The pattern to break:** remediation *claims* remain a mix of true, partial, and false for the third consecutive release. The fix is not more effort — it is an artifact-level gate (§37, action 2): make the CI fail when non-`.example` secret-bearing files exist *anywhere in the tree*, and when a FIXED row cites a test whose file does not contain the finding's identifier anywhere in its text. Both checks are ~15 lines of Node.

---

# PART II — AUDIT METHOD, ENVIRONMENT & EVIDENCE

## 10. Method and evidence rules

The method is unchanged from the series standard, restated compactly:

1. **Artifact-only grounding.** Every claim is verified against `edgepay-cf-clean-new-3.zip` (MD5 `7203316c47561ab8de2775c72a827a0`) after extraction to an isolated directory. No statement from the developer's message is treated as evidence.
2. **Byte-level diffing.** `diff -rq` and `diff -u` against the preserved v4 tree (`edgepay-cf-clean-new-2.zip` extraction) enumerate the *complete* change surface. Anything absent from the diff is byte-identical to v4 and inherits v4's verified status — no regression is possible outside the changed files, and no unclaimed fix exists inside them.
3. **Re-execution.** Every verification command the developer cites (`npm ci`, `lint`, `typecheck`, both gate scripts, `npm test`) is re-run from a clean install.
4. **Live PoCs.** Claims about runtime behavior are proven with auditor-authored tests executed inside the project's own workerd harness (`@cloudflare/vitest-plugin`, `SELF.fetch`) — the same execution environment the shipped suite uses, so results are directly comparable. The PoC file is added temporarily, run in isolation, archived to the auditor's workspace, and removed before re-running the pristine battery (233/233 confirmed after removal).
5. **Discriminating assertions.** Each PoC is designed so that it *fails* on the v4 code — the anti-pattern this replaces is the shipped suite's `toBeDefined()`-on-pre-populated-column and `[200, 404]` hedges, which pass on both fixed and unfixed code (§33–35).
6. **Symmetric rigor.** When the auditor's own toolchain produced a false observation (§8), it is retracted at the byte level and documented. The standard runs both directions.
7. **No production contact.** The audit never sends requests to the live `workers.dev` deployment. Findings about live credentials are derived from artifact forensics (decode, expiry, HMAC-negative against shipped secrets) — which is sufficient, because the artifact *is* the distribution channel being flagged.

## 11. Environment and artifacts

| Item | Value |
|---|---|
| Auditor workspace | `/home/z/my-project/audit/v5/edgepay-cf` (isolated extraction) |
| Reference tree (v4) | `/home/z/my-project/audit/v4/edgepay-cf` (preserved from Report 3) |
| Node / toolchain | npm `ci` clean install: 209 packages, ~5s; vitest 4.1.11 runtime via `@cloudflare/vitest-plugin` 1.1.2; workerd (cloudflare workers runtime) |
| Test harness config | `vitest.config.ts`: `maxWorkers: 1`, `isolate: false`, setup applies D1 migrations once per worker; wrangler config `wrangler.jsonc` (production-shaped) |
| Artifact contents | 148 `src/*.ts` files, 28 `tests/*.test.ts` files, 29,860 LOC across `src/` + `tests/`; embedded prior reports: `EDGEPAY_CF_FULL_AUDIT_REPORT_2.md` (213,994 B) and `EDGEPAY_CF_FULL_AUDIT_REPORT_3.md` (201,330 B, MD5 `0dd145e936500138f4a2767c36f2f17b` — byte-identical to the auditor's delivered Report 3, confirming the series chain of custody) |
| Notable tree state | `.dev.vars` present (189 B, three secrets, values identical to v4); `sms-phone-mockup/.companion-state.json` present (1,119 B — §5, §18, §28); **no `.git/` directory in the artifact** (git-tracking claims are unverifiable from the zip; §18.4) |

## 12. The v5 delta — complete change inventory (what actually changed)

`diff -rq v4/edgepay-cf v5/edgepay-cf` yields exactly 17 entries (minus `node_modules`, an auditor-side artifact of the v4 install). The change surface is **surgical**:

**Added (v5 only):**

| Path | Size/LOC | Purpose |
|---|---|---|
| `.github/workflows/audit-gate.yml` | 43 lines | CI gate (V4-011) — valid, see §20 |
| `scripts/verify-remediations.mjs` | 41 lines | Ledger citation checker (V3-011/V4-003 enforcement half) |
| `scripts/verify-config.mjs` | 44 lines | Secret/state hygiene checker (V4-004 enforcement half) |
| `tests/payload-cap.test.ts` | 99 lines / 6 tests | 411/413 cap regression (V3-005/V4-005/V4-010) |
| `tests/refund-ordering.test.ts` | 98 lines / 2 tests | Refund reserve-then-call (V3-003/EDGE-P0-003/NEW-P2-001) |
| `tests/ssrf-webhook-test.test.ts` | 76 lines / 2 tests | sendTest SSRF regression (V3-002/V3-007/EDGE-P1-004) |
| `tests/assets-serving.test.ts` | 24 lines / 2 tests | Asset serving (V4-007) — hedged, §33 |
| `tests/mobile-heartbeat.test.ts` | 70 lines / 1 test | Heartbeat scoping (EDGE-P3-002) — vacuous, §33 |
| `EDGEPAY_CF_FULL_AUDIT_REPORT_3.md` | 201,330 B | Report 3 embedded at repo root |

**Modified (v4 → v5):**

| Path | Delta | Change |
|---|---|---|
| `src/index.ts` | +28 / −19 | Payload cap moved outermost + 411/DELETE coverage (removed the old inner placement); `/assets` prefix strip |
| `src/controllers/mobile.ts` | +4 / −3 | Heartbeat: `deviceId` from context + `AND merchant_id = ?` |
| `src/controllers/admin-api.ts` | +2 / −2 | Claim route: `requireScope('admin')`, `requirePlatformAdmin` |
| `.gitignore` | +5 / −0 | `**/.companion-state.json`, `*-state.json` |
| `TEST_RESULTS.md` | +31 / −330 | Rewritten for this release (numbers inflated: "240+"; §21) |
| `docs/REMEDIATIONS.md` | +56 / −33 | 47-row ledger, IDs de-collided, OPEN rows added (§31) |
| `sms-phone-mockup/.companion-state.json` | content | Fresh access token, same refresh token (§28) |

**Byte-identical to v4 (therefore inherited status):** everything else — all money-path services (`payment.ts`, `refund.ts`, `ledger.ts`, `ledger-audit.ts`), all middleware except the three files above (`csrf.ts`, `idempotency.ts`, `rate-limit.ts`, `security-headers.ts`, …), all gateways, `observability.ts`, `wrangler.jsonc`, `docs/*` except REMEDIATIONS.md, migrations, seeds. This is the proof base for §29's carried-findings table: an unmodified file cannot have been remediated.

## 13. Independently re-executed verification battery

Transcript (condensed, from a clean `npm ci`):

```text
$ npm ci --no-audit --no-fund
  added 209 packages in 5s

$ npm run lint          # eslint src tests
  (no output — 0 errors, 0 warnings)          [claim: 0/0 — MATCH]

$ npm run typecheck     # tsc --noEmit
  (no output — exit 0)                          [claim: 0 errors — MATCH]

$ node scripts/verify-remediations.mjs
  ✓ Remediation ledger verified (46 rows checked, 0 errors).
  [claim: 46 rows — MATCH; but ledger has 47 data rows and the checker
   silently skips the V4-003 row — see §34.2]

$ node scripts/verify-config.mjs
  ✓ Configuration and repository hygiene verified.
  [passes — while .companion-state.json and .dev.vars exist in the same
   tree: `git ls-files` walks up to an unrelated repo (no .git in the
   artifact); see §34.1]

$ npm test              # vitest run
  Test Files  28 passed (28)
       Tests  233 passed (233)
    Duration  7.20s   (re-run pristine after PoC removal: 7.07s)
  [claim: 28/233/~13.8s green — MATCH on counts and pass-rate]
```

Battery-internal observation that doubles as a finding: the runner prints `Using secrets defined in .dev.vars` — the vitest plugin loads the shipped dev secrets, overriding the `JWT_SECRET: 'test-jwt-secret-…'` binding declared in `vitest.config.ts`'s miniflare options (V5-010, §30). Tests still pass because they mint and verify tokens with the same effective secret, but the config comment's claim ("test value") is not what executes.

---

# PART III — REMEDIATION CLAIM VERIFICATION (CLAIM BY CLAIM)

The developer's message makes six remediation claims plus four verification-statistics claims. Each is verified here against code, battery, and — where behavior matters — live PoC.

## 14. Claim 1: Payload cap at the outermost layer + 411/413 (V4-005, V4-010, V3-005)

**Developer claim (verbatim):** "Moved the payload cap to the outermost layer of the global middleware stack (before route groups and authentication). On mutating HTTP verbs (POST, PUT, PATCH, DELETE), if Content-Length is missing (e.g. chunked streams), the edge immediately returns 411 Length Required. If Content-Length is invalid or exceeds 128 KB, it returns 413 Payload Too Large."

### 14.1 Code verification — TRUE

`src/index.ts:81-100` (new code, quoted from the artifact):

```ts
// Body size cap: max 128 KB for JSON / Webhook / Checkout payloads (P1-003 / V3-005 / V4-005 / V4-010 fix)
app.use('*', async (c, next) => {
  const method = c.req.method;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const cl = c.req.header('content-length');
    if (!cl) {
      return c.json({ success: false, error: { code: 'LENGTH_REQUIRED', message: 'Content-Length header required' } }, 411);
    }
    const len = parseInt(cl, 10);
    if (isNaN(len) || len > 128 * 1024) {
      return c.json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds 128 KB limit' } }, 413);
    }
  }
  return next();
});
```

Placement, verified against the mount order in `src/index.ts`:

```text
77  app.use('*', requestId());
78  app.use('*', logger());
81  app.use('*', <PAYLOAD CAP>)          ← new position
106 app.use('*', <bootstrap waitUntil>)
132 app.use('*', domainMiddleware);
133 app.use('*', maintenanceMiddleware);
137 app.use('*', <prettyJSON dev gate>)
148 app.use('*', secureHeaders(...))
159 app.use('/api/*', cors(...))
183 app.use('/api/*', securityHeadersMiddleware)
199 app.use('/api/admin/*', accessAuthMiddleware())
209+ rate limiters
216+ app.route(...) route groups
```

The cap now executes after request-id/logging but **before bootstrap, domain, maintenance, CORS, security headers, every rate limiter, and all authentication**. The old placement (v4, `src/index.ts` inside the "Security & Rate Limiting Mounts" block, after the route-group-adjacent mounts, with `if (cl)` guard and no DELETE coverage) is deleted (−19 lines). The claim's placement and verb coverage are accurate.

### 14.2 Behavioral verification — TRUE (live PoC)

The Report-3 bypass was: *stream a large body without Content-Length; the v4 cap required a numeric CL to act, so it silently passed the request through; the body was then readable by handlers without any ceiling.* The v5 replay (§23, PoC-1):

```text
POST /api/v1/payments  — 300 KB ReadableStream body, duplex:'half', NO Content-Length, NO Authorization
v4 (Report 3):  401 Unauthorized        (cap skipped; body unbounded downstream)
v5 (this round): 411 {"error":{"code":"LENGTH_REQUIRED","message":"Content-Length header required"}}
```

The 411 fires **before** the 401 would — proving both the bypass closure and the outermost placement in one request. Supporting PoCs: CL `131073` → 413; CL `not-a-number` → 413; small valid CL → passes the cap (request proceeds to normal routing/auth); GET without CL → unaffected.

### 14.3 Residual observations (new, minor — V5-011)

1. **`parseInt` leniency.** `parseInt('12x34', 10) === 12` — a Content-Length like `12x34` is treated as 12 and passes. Fully-numeric-but-garbage values (e.g. `not-a-number`) do hit the `isNaN` branch and 413. In production this is not exploitable: Cloudflare's edge validates Content-Length formatting and length-matches the actual body upstream of the Worker (a mismatched or malformed CL is rejected at the edge), and workerd applies the same discipline to the test harness's requests. The residual is that the middleware is *more permissive than its error contract implies* — a defense-in-depth note, not a vulnerability.
2. **411 on bodyless DELETE.** Requiring Content-Length on DELETE is RFC-permitted (411 means "the server refuses to accept the request without a defined Content-Length") but changes client compatibility: an HTTP client that issues `DELETE` with no body and no `Content-Length: 0` will now receive 411. Internal audit: the repository's own browser-side code (`sms-phone-mockup/public/app.js`) issues `DELETE` only against the mockup's local Node server (`/api/mock-messages`), never against the Worker; all Worker-facing calls from the companion app are POSTs with string bodies (undici sets CL automatically). No self-inflicted breakage exists in the artifact. External API consumers should be documented as needing `Content-Length: 0` on bodyless DELETEs.
3. **Pre-auth rejection ordering** is a minor positive: oversized or streaming-unsigned requests are now rejected before any DB/KV work (rate-limit counters, API-key hashes) — cheaper and no information leak beyond what 411/413 reveal.

**Verdict: FIXED (code + behavior verified). This closes the V3-005 core bypass that Report 3 live-proved open.**

## 15. Claim 2: Static-assets path rewriting (V4-007)

**Developer claim (verbatim):** "Strips the /assets prefix before forwarding the request to c.env.ASSETS.fetch, ensuring paths like /assets/css/checkout.css resolve directly to /css/checkout.css within ./public/assets."

### 15.1 Code verification — TRUE

`src/index.ts:253-259`:

```ts
app.get('/assets/*', async (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/assets/, '') || '/';
  const assetReq = new Request(url.toString(), c.req.raw);
  const res = await c.env.ASSETS.fetch(assetReq);
  return new Response(res.body, res);
});
```

Config (unchanged from v4, `wrangler.jsonc`): `"assets": { "directory": "./public/assets", "binding": "ASSETS", "not_found_handling": "none", "run_worker_first": true }`. The rewrite is therefore dimensionally correct: `/assets/css/checkout.css` → `/css/checkout.css` → file `public/assets/css/checkout.css` (which exists). The `|| '/'` guard maps a bare `/assets` to the index. The `new Response(res.body, res)` wrapper preserves the mutable-headers fix from the v3-era 500 regression (Report 2), and `new Request(url, c.req.raw)` is the documented Cloudflare URL-rewrite idiom (method/headers/body carried over).

### 15.2 Behavioral verification — TRUE (live PoC, §24)

```text
GET /assets/css/checkout.css   → 200, Content-Type: text/css, X-Content-Type-Options: nosniff, X-Frame-Options: DENY
GET /assets/css/definitely-missing.css → 404 (clean; no 500 — mutable wrapper intact)
GET /                            → not 500 (no asset route; handled by routing)
```

The shipped test asserts `expect([200, 404]).toContain(res.status)` — a hedge that would pass even if the asset were still unreachable (V5-008, §33). The auditor PoC removes the hedge; the fix stands at 200. In the battery transcript, the shipped suite's own request also returns 200 (`--> GET /assets/css/checkout.css 200 3ms`), confirming environment parity between the shipped suite's run and the auditor's.

**Verdict: FIXED.** The double-prefix unreachability that Report 3 filed as V4-007 is resolved.

## 16. Claim 3: Mobile heartbeat tenant & device scoping (EDGE-P3-002)

**Developer claim (verbatim):** "Scoped /heartbeat and /devices/heartbeats to the authenticated device's deviceId and merchantId with WHERE id = ? AND merchant_id = ?."

### 16.1 Code verification — TRUE, with the plumbing verified end-to-end

`src/controllers/mobile.ts:125-131` (both routes share `handleHeartbeat`):

```ts
const handleHeartbeat = async (c: MobileContext) => {
  const deviceId = (c.get('deviceId') as number | undefined) ?? c.get('authSubject')!;
  const merchantId = c.get('merchantId')!;
  await c.env.DB.prepare(
    `UPDATE op_paired_devices SET last_heartbeat_at = ? WHERE id = ? AND merchant_id = ?`
  ).bind(new Date().toISOString(), deviceId, merchantId).run();
  return c.json({ success: true, data: { status: 'ok' } });
};
mobileRoutes.post('/devices/heartbeats', handleHeartbeat);
mobileRoutes.post('/heartbeat', handleHeartbeat);
```

The context keys exist and are JWT-derived — `src/middleware/auth.ts` (`requireJwtAuth`, mounted at `mobile.ts:122` for all mobile routes):

```ts
158:  c.set('authType', 'jwt');
159:  c.set('authSubject', parseInt(payload.sub, 10));
160:  c.set('deviceId', payload.device_id ?? null);
161:  c.set('authScopes', payload.scope);
167:  c.set('merchantId', payload.merchant_id);
```

The v4 bug was `deviceId = c.get('authSubject')` — using the **user id** as the device id, with an unscoped `WHERE id = ?`, so any authenticated user could stamp heartbeat timestamps on any device row by numeric id. The fix sources `device_id` from the JWT (attacker-controlled only in the sense that a device token *is* the credential — the pairing flow binds device ids to merchants) and scopes by merchant.

### 16.2 Behavioral verification — TRUE (discriminating PoC, §25)

The auditor PoC seeds `last_heartbeat_at = '2000-01-01T00:00:00.000Z'` (the shipped test's INSERT pre-populates the column — making its `toBeDefined()` assertion vacuous), then:

```text
same-tenant token (merchant A, device 9901):  200 → row CHANGED (update landed)
cross-tenant token (merchant B, device 9901): 200 → row UNCHANGED (WHERE merchant_id = ? blocks)
```

The cross-tenant request still returns `{success:true}` — the handler is silent-success by design (an UPDATE that matches 0 rows is not an error). That is a P3 observability residual, not an isolation failure: the *data* is protected, the *signal* is not.

**Verdict: FIXED (code + behavior). The shipped regression test is vacuous (V5-006) — the auditor PoC is the discriminating coverage this fix needs.**

## 17. Claim 4: Admin merchant-claim platform gate (V3-010)

**Developer claim (verbatim):** "Added requireScope('admin') and requirePlatformAdmin to /merchants/claim so arbitrary tenant keys cannot redeem one-time claim tokens."

### 17.1 Code verification — TRUE

`src/controllers/admin-api.ts:270-271`:

```ts
// One-time credential claim for newly provisioned merchants (Platform Admin only)
adminApiRoutes.post('/merchants/claim', requireScope('admin'), requirePlatformAdmin, async (c) => { ... });
```

`requirePlatformAdmin` (`admin-api.ts:247-259`) is a real check, not a decoration:

```ts
const requirePlatformAdmin: MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> = async (c, next) => {
  const merchantId = c.get('merchantId');
  if (!merchantId) return c.json({ ... 'Platform authentication required' }, 403);
  const row = (await c.env.DB.prepare(
    `SELECT is_platform FROM op_merchants WHERE id = ? LIMIT 1`
  ).bind(merchantId).first()) as { is_platform: number } | null;
  if (!row || row.is_platform !== 1) return c.json({ ... 'Platform administrator privileges required' }, 403);
  return next();
};
```

The route group already runs `adminApiRoutes.use('*', requireBearerApiAuth(['admin']))` (line 29) and the app-level `accessAuthMiddleware()` on `/api/admin/*` (`index.ts:199`), so the full chain for the claim route is: access-auth → bearer key with admin scope → platform-merchant check → handler. The v4 exposure (any tenant admin key could redeem `claim:<token>` from KV, harvesting the newly provisioned merchant's credentials) is closed at two layers.

### 17.2 Behavioral verification — TRUE (PoC-5, §26)

```text
POST /api/admin/v1/merchants/claim, no auth                    → 401 (rejected)
POST ..., non-platform admin key, valid claim token            → 403 FORBIDDEN ("Platform administrator privileges required")
                                                                  AND the KV token is NOT consumed by the rejected attempt
POST ..., platform-admin key, same token                       → 200, credentials returned, KV entry deleted
POST ..., platform-admin key, same token again                 → 404 INVALID_CLAIM (one-time semantics intact)
```

### 17.3 Citation defect (V5-005)

The ledger cites `tests/tenant-routing.test.ts` for V3-010 (and for NEW-P2-004 and EDGE-P1-005). That file contains 12 tests — domain/tenant routing, install-path bypasses, domain-cache invalidation, bootstrap timing — and **zero** tests touching `/merchants/claim`, `requirePlatformAdmin`, or `is_platform`. No test anywhere in the 28-file battery covers the new gate. The fix is real; the verification citation is decorative — the same defect class Report 3 filed as V4-001 (fabricated citations), now in a milder form (existing file, absent coverage).

**Verdict: FIXED (code + behavior). Coverage: auditor PoC only — the shipped citation points at an unrelated suite.**

## 18. Claim 5: Credential hygiene & state-file purge (V4-004) — FALSE

**Developer claim (verbatim):** "Purged sms-phone-mockup/.companion-state.json and untracked it from the Git index. Updated .gitignore with **/.companion-state.json and *-state.json. Added verify-config.mjs to prevent state files or credentials from being committed."

### 18.1 The file is not purged

`sms-phone-mockup/.companion-state.json` exists in the v5 artifact — 1,119 bytes, same size as v4, same location. It is present in the zip listing and in the extracted tree. The claim's first clause is false on its face.

### 18.2 The file is *fresher* than the one Report 3 flagged

Full forensic detail in §28; the short version: the embedded access token has `iat = 2026-09-02T03:47:45Z` — minted **after** Report 3 was written and delivered (report timestamp ~03:40Z) and approximately when this release was being packaged (adjacent file mtimes 03:52–04:12Z). The refresh token is byte-identical to v4's and is valid until **2026-10-01T00:43:51Z**. A fresh access token minted from an old refresh token is direct evidence that (a) the credential pair is in active use in the developer's environment, and (b) the production `JWT_SECRET` has **not** been rotated (a rotation would have invalidated the refresh flow). The remediation workflow did not stop the leak — it *refreshed* the leak and re-shipped it.

### 18.3 The mechanism cannot do what is claimed

- **`.gitignore` additions** (`**/.companion-state.json`, `*-state.json` — verified present, +5 lines) affect git's *untracked-file* behavior. The distribution channel here is a **zip**, and `.gitignore` has no effect on zip contents. The file ships.
- **"Untracked it from the Git index"** is unverifiable from the artifact — the zip contains no `.git/` directory. Even taken at face value, untracking does not delete the working-tree file, and the working-tree file is what gets zipped.
- **`verify-config.mjs`** "to prevent state files or credentials from being committed" — the script's forbidden-file check runs `git ls-files` and inspects the result. In the artifact context (no `.git`), `execSync` either throws (caught; `git check skipped` warning; script continues) or, as observed in this audit's directory layout, **resolves to an unrelated ancestor repository** (`git rev-parse --show-toplevel` → `/home/z/my-project`, the auditor's workspace) and validates that repo's file list. Empirically: the script prints `✓ Configuration and repository hygiene verified.` while the state file and `.dev.vars` exist in the same tree it just "verified." The `sk_live_`/`whsec_` string-grep over the three wrangler configs is a real check but only covers two secret prefixes in three named files.

### 18.4 What "purged" would have required

1. Delete the file (or template it to `.companion-state.json.example` with placeholder values) — the artifact-level action.
2. Rotate the production `JWT_SECRET` — kills the shipped refresh token wherever it has spread.
3. Add an artifact-level gate: fail CI if any file matching `*state.json` / `.dev.vars` (non-`example`) exists anywhere in the tree — a `find`-based check, not a `git ls-files`-based one (§37, action 2 — ~15 lines).

**Verdict: FALSE. V4-004 is the round's most serious finding (re-filed as V5-001, P1). The `.gitignore` and script additions are real but structurally incapable of enforcing the claim.**

## 19. Claim 6: New automated test suites & benchmarks (V4-001)

**Developer claim (verbatim):** five new test files — payload-cap (411 chunked, 413 >128KB/NaN, 200 GET/valid), refund-ordering (reserve-then-call; no gateway call when bound exceeded), ssrf-webhook-test (route + dispatcher blocking), assets-serving (security headers), mobile-heartbeat (device and tenant scoping).

**Existence and execution: TRUE.** All five files exist with the claimed scopes; all run green; the arithmetic reconciles exactly (v4: 23 files / 220 tests → v5: 28 files / 233 tests; the five files contribute 6+2+2+2+1 = 13 new tests). The payload-cap suite in particular is well-designed: it uses `duplex: 'half'` ReadableStream bodies (a faithful simulation of transfer-encoding streaming in the workerd harness) and covers all four mutating verbs.

**Quality: three of five files carry defective assertions** (full analysis §33):

| File | Defect | Consequence |
|---|---|---|
| `mobile-heartbeat.test.ts` | Asserts `last_heartbeat_at` is `toBeDefined()` on a column the fixture INSERT pre-populates; no cross-tenant negative case | Passes on v4 (unfixed) code — non-discriminating (V5-006) |
| `assets-serving.test.ts` | `expect([200, 404]).toContain(res.status)` for the primary claim | Passes if the asset is still unreachable — hedged (V5-008) |
| `refund-ordering.test.ts` | Spies `StripeGateway.prototype.refund` on a fixture whose transaction resolves to gateway slug `'manual'`; `gatewayRegistry.resolve('manual')` throws before any adapter is constructed | The "gateway never called" counter monitors a class that is never instantiated — doubly vacuous (V5-007) |
| `payload-cap.test.ts` | Clean | The one shipped suite whose assertions are discriminating |
| `ssrf-webhook-test.test.ts` | Clean (route-level with real API key; dispatcher-level with DB persistence check) | Good coverage of V3-002/V3-007 |

**Verdict: TRUE (existence, scope, execution) / PARTIAL (quality). The auditor's PoC suite (Appendix A) supplies the discriminating versions of the three defective tests; all 15 pass.**

## 20. Claim 7: Automated CI & audit gate (V4-011, V4-003, V4-008)

**Developer claim (verbatim):** `verify-remediations.mjs` verifies every FIXED claim points to a valid test file; `verify-config.mjs` verifies no tracked secret or temporary state file exists; `audit-gate.yml` runs linting, typechecking, the zero-`as any` check, audit gate verification, and tests; REMEDIATIONS.md and TEST_RESULTS.md updated.

### 20.1 `audit-gate.yml` — REAL and well-formed (with a scope caveat)

The workflow file is valid YAML with correct triggers — **verified at byte level** (`od -c` shows `branches: [main, master]` for both `push` and `pull_request`; see §8 for the retraction of the auditor's initial misreading). The step chain is exactly as claimed: `actions/checkout@v4` → `setup-node@v4` (Node 20, npm cache) → `npm ci` → `node scripts/verify-config.mjs` → `node scripts/verify-remediations.mjs` → `npm run typecheck` → zero-`as any` grep over `src/` → `npm run lint` → `npm test`.

Caveats (why V4-011 is PARTIAL rather than FIXED):
1. **No run history.** The artifact contains no evidence the workflow has ever executed (no badges, no logs). The commands it runs *do* pass locally (this audit reproduced them all), so the gate would presumably go green — but "would" is not "has."
2. **Scope.** The gate audits the *git repository state*. The round's worst finding (V5-001) is an *artifact-distribution* defect: the state file and `.dev.vars` ship in the zip regardless of their git-tracked status. The CI gate cannot catch it by construction — its hygiene check is the `git ls-files`-based `verify-config.mjs` (§18.3).
3. The gate inherits the two scripts' blindnesses (§34): file-existence citation checking, header-substring row skipping, git-walk-up semantics.

### 20.2 `verify-remediations.mjs` — REAL, runs green, materially blind

What it does: parses `docs/REMEDIATIONS.md` table rows; for every row whose status includes `FIXED` and whose citation cell mentions `tests/….test.ts`, checks `existsSync` on each cited path; fails if any cited file is missing. Output: `✓ 46 rows checked, 0 errors` — reproduced exactly.

What it cannot do (each with this round's live example):
- **Relevance:** V3-010 cites `tests/tenant-routing.test.ts` (exists ✓, contains zero claim-route tests) — passes. V4-002 cites `tests/smoke.test.ts` (exists ✓, zero observability tests) — passes.
- **Completeness:** the ledger has 47 data rows; the checker reports 46. The skipped row is **V4-003 itself** — its category text `Finding ID Collision Resolution` contains the substring `Finding ID`, which the script's header-detection heuristic (`line.includes('Finding ID')`) treats as the table header. The row claiming collision-resolution is invisible to its own verifier (V5-004).
- **Empty citations:** a FIXED row with no `tests/…` mention is skipped silently (`if (status.includes('FIXED') && testCitation)`); `NEW-P3-002`'s citation is `0 errors, 0 warnings` — no test path, no check.
- **Status validity / duplicate IDs:** neither is validated (IDs happen to be unique this round — §31 — but the script would not detect a regression of V4-003's collision class).

### 20.3 `verify-config.mjs` — REAL, runs green, vacuously (see §18.3)

The empirical demonstration is the strongest form of the finding: in a tree containing both `sms-phone-mockup/.companion-state.json` (live-format JWTs) and `.dev.vars` (three secrets), the script prints its success line. The git-based check cannot see working-tree files in an artifact context, and the string-grep only covers `sk_live_`/`whsec_` in three wrangler configs.

### 20.4 REMEDIATIONS.md / TEST_RESULTS.md — updated, better, still imperfect

Improvements over v4's ledger (credit where due): IDs are unique (V4-003's collision class is genuinely resolved — 47 rows, 0 duplicates, auditor-verified); OPEN rows now exist and are honest (EDGE-P1-007 intent race, EDGE-P2-001 CSRF dead code); PARTIAL rows are retained rather than rounded up to FIXED. Remaining defects: ≥9 known series findings still absent (§31); V4-002 is a fabricated FIXED row; V4-004 is a false FIXED row; TEST_RESULTS.md inflates the test count ("240+ passed" vs the actual 233 — V5-009); the preamble's "27+ test suites, 230+ tests" doesn't match the artifact's 28/233 either.

**Verdict: PARTIAL. The infrastructure exists, is well-formed, and runs — but it verifies the wrong layer (git/file-existence instead of artifact/content) and its own parser skips the one row that describes its own remediation.**

## 21. Claim 8: The verification summary's numbers

| Claim | Reproduced | Notes |
|---|---|---|
| `npm run lint` → ESLint 9, 0 errors, 0 warnings | ✅ exact | clean exit |
| `npm run typecheck` → tsc 0 errors | ✅ exact | clean exit |
| `verify-remediations.mjs` → 46 rows, 0 errors | ✅ exact output | 47-row ledger, V4-003 skipped (§20.2) |
| `verify-config.mjs` → verified | ✅ prints success | vacuously (§18.3) |
| `npm test` → 28 files, 233 tests, ~13.8s, 100% green in workerd | ✅ 28/233/100% | 7.07–7.20s on this machine — duration is hardware-dependent; counts and pass-rate match exactly |

**This is the first release in the series whose verification-summary numbers all reproduce.** The inflation has moved up one level of indirection: from the message (accurate) into the shipped documentation (TEST_RESULTS.md's "240+", REMEDIATIONS.md preamble's "27+ suites / 230+ tests"). Both are P4 documentation defects — filed as V5-009 — not integrity failures of the executable claims.

---

# PART IV — INDEPENDENT LIVE PoCs & FORENSICS

## 22. PoC battery design and why it exists

The shipped battery's job is regression: prove the code still does what it does. The auditor PoCs' job is discrimination: prove the code does what it *claims*, in tests that would fail on the previous release. Three of the five new shipped tests fail that standard (§33); the fifteen PoCs below replace and exceed them. All PoCs run in the project's own harness (`SELF.fetch` against the workerd-served Worker, real D1/KV bindings, real JWT service) so results are directly comparable with the shipped suite. The PoC file is added to `tests/`, run in isolation, archived (Appendix A), and removed; the pristine battery was re-run afterward and confirmed 28 files / 233 tests / green.

## 23. PoC results: payload cap (the Report-3 bypass replay)

### 23.1 The headline replay

```text
PoC-1  POST /api/v1/payments
       body: 300 KB ReadableStream (duplex:'half'), NO Content-Length, NO Authorization
       expected / observed: 411  {"error":{"code":"LENGTH_REQUIRED",...}}

       v4 behavior (Report 3, live): 401 — the cap required a numeric CL to act and
       silently passed the request; the body was then readable downstream without limit.
```

The 411 (not 401) also proves ordering: the cap runs before authentication, i.e., before any handler could read the stream.

### 23.2 The full contract

| Case | Method | Content-Length | Body | Result |
|---|---|---|---|---|
| Report-3 bypass replay | POST | *(none — streamed)* | 300 KB stream | **411 LENGTH_REQUIRED** |
| Same, PUT/PATCH/DELETE | PUT/PATCH/DELETE | *(none — streamed)* | small stream | **411** each |
| Oversized declared | POST | `131073` | small | **413 PAYLOAD_TOO_LARGE** |
| Non-numeric | POST | `not-a-number` | small | **413** |
| Leading-numeric garbage | POST | `12x34` | small | passes cap (parses as 12) — informational, §14.3 |
| Valid small | POST | correct | small | passes cap (normal routing) |
| GET exempt | GET | *(none)* | — | 200 (health) |

### 23.3 Interpretation

The bypass class is closed at the Worker layer. Remaining trust rests correctly on the platform: Cloudflare's edge (and workerd in tests) enforce Content-Length well-formedness and body-length agreement upstream, so header-value games (`12x34`, CL-undersized streaming) cannot smuggle oversized bodies past the cap in production. The cap's 411/413 responses are JSON, consistent with the API's error envelope, and fired before any rate-limit or DB work in the observed ordering.

## 24. PoC results: assets serving

```text
PoC-3a  GET /assets/css/checkout.css
        → 200
        → Content-Type: text/css
        → X-Content-Type-Options: nosniff
        → X-Frame-Options: DENY
        → non-empty body

PoC-3b  GET /assets/css/definitely-missing.css
        → 404 (clean JSON envelope, security headers still present, no 500)

PoC-3c  GET /
        → not 500 (no asset route at root; routing handles it)
```

The shipped suite's own run corroborates (`--> GET /assets/css/checkout.css 200 3ms` in the battery transcript). V4-007's claim resolves to 200 in the harness — the shipped test's `[200, 404]` hedge was unnecessary; the auditor's unhedged assertion is the coverage the claim requires.

## 25. PoC results: heartbeat scoping (discriminating test)

Design: seed the device row with `last_heartbeat_at = '2000-01-01T00:00:00.000Z'`; mint two JWTs with the real `createJwtService` — A: (merchant 990001, device 9901); B: (merchant 990002, **same device id 9901**); assert the row's timestamp changes for A and does not for B.

```text
PoC-4a  POST /api/mobile/v1/heartbeat  (Bearer A)
        → 200 {"success":true}
        → DB: last_heartbeat_at CHANGED from '2000-01-01…' (UPDATE matched)

PoC-4b  POST /api/mobile/v1/heartbeat  (Bearer B — cross-tenant)
        → 200 {"success":true}              ← silent-success residual (documented)
        → DB: last_heartbeat_at UNCHANGED   ← isolation holds
```

Why this matters: the shipped test inserts the row with `last_heartbeat_at` already set and asserts `toBeDefined()` — an assertion that passes even if the UPDATE matches zero rows, which is exactly the v4 failure mode (authSubject-as-device-id). The auditor's change-detection form is the minimum bar for this fix; the cross-tenant negative is the second bar. Both pass against v5; both would fail against v4.

## 26. PoC results: claim gate (negative + positive + one-time)

Fixture: merchant 970001 (`is_platform = 0`) and 970002 (`is_platform = 1`), each with an `op_live_…` API key carrying `["read","write","admin"]` scopes; KV `claim:r4-poc-claim-token` → credential JSON.

```text
PoC-5a  POST /api/admin/v1/merchants/claim   (no Authorization)
        → 401 (rejected at access-auth)                       [not 200]

PoC-5b  POST … (Bearer normal-key, valid claim token)
        → 403 {"error":{"code":"FORBIDDEN","message":"Platform administrator privileges required"}}
        → KV: claim token STILL PRESENT (rejected attempts do not consume it —
          important: the gate runs before the handler's KV.get/delete)

PoC-5c  POST … (Bearer platform-key, same token)
        → 200, returns the staged credentials; KV entry deleted

PoC-5d  POST … (Bearer platform-key, same token again)
        → 404 INVALID_CLAIM (one-time redemption semantics preserved)
```

This is the complete V3-010 verification: arbitrary-tenant-key redemption is closed, one-time consumption is intact, and rejection is non-destructive.

## 27. PoC results: refund ordering (correct-instrumentation replay)

The shipped `refund-ordering.test.ts` spies `StripeGateway.prototype.refund` on a fixture whose transaction resolves to gateway slug `'manual'` (the fallback when a gateway has no configured credentials — `paymentService.createIntent({gateway:'bkash'})` in the test env leaves the transaction's `gateway_slug = 'manual'`), and `gatewayRegistry.resolve('manual')` throws (`Gateway adapter not registered: manual` — observed in the run log) before any adapter object exists. Its "gateway must NOT have been called" counter therefore monitors a class that is never instantiated — the assertion cannot discriminate.

The auditor replay instruments the correct seam — `gatewayRegistry.resolve` itself:

```text
PoC-6a  over-bound refund (150.00 against a 100.00 transaction):
        → createRefund() throws (pre-check + conditional-INSERT bound)
        → gatewayRegistry.resolve called 0 times
        → fake adapter .refund() called 0 times
        → op_refunds rows for the transaction: 0 (no ghost pending row —
          the INSERT…SELECT conditional leaves nothing behind on failure)

PoC-6b  valid refund (30.00):
        → pending row reserved FIRST (row exists, status 'pending')
        → THEN resolve() called once, adapter.refund() called once
        → gateway_refund_id recorded only on gateway success
```

The reserve-then-call ordering (V3-003, EDGE-P0-003, NEW-P2-001) is therefore **re-proven with correct instrumentation** this round. The code was already correct (v4's fix is byte-identical in v5 — `refund.ts` is unchanged); what changed is that the round's new test for it adds a defective spy on top of an already-passing design, while the correct proof required instrumenting the registry.

## 28. JWT forensics on the shipped state file

### 28.1 Decoded contents (v5 artifact)

```json
{
  "edgepay_url": "https://edgepay-cf.bm-jonybepary.workers.dev",
  "jwt_token":  "<HS256 access  token>",
  "refresh_token": "<HS256 refresh token>",
  "paired": true, "merchant_id": 8, "device_uuid": "…", "device_name": "…",
  "auto_relay_enabled": …, "simulation_active": …, "simulation_interval_ms": …,
  "last_heartbeat_at": …, "battery_level": …, "is_charging": …, "carrier": …
}
```

### 28.2 Claims (base64url-decoded, both tokens)

| Token | type | sub | merchant_id | device_id | iat (UTC) | exp (UTC) |
|---|---|---|---|---|---|---|
| v4 access | access | 6 | 8 | 4 | 2026-09-02 02:47:39 | 2026-09-02 03:47:39 |
| **v5 access** | access | 6 | 8 | 4 | **2026-09-02 03:47:45** | 2026-09-02 04:47:45 |
| v4 refresh | refresh | 6 | 8 | 4 | 2026-09-01 00:43:51 | **2026-10-01 00:43:51** |
| v5 refresh | refresh | 6 | 8 | 4 | 2026-09-01 00:43:51 | **2026-10-01 00:43:51** (byte-identical to v4) |

Issuer `edgepay-cf`, audience `mobile`, scopes `["read","write"]`.

### 28.3 Signature source discrimination (HMAC-SHA256 negative test)

Both tokens were verified against the `JWT_SECRET` shipped in the same zip's `.dev.vars` (`8f9eb3f8…`):

```text
v4 access  verifies with shipped .dev.vars secret: false
v4 refresh verifies with shipped .dev.vars secret: false
v5 access  verifies with shipped .dev.vars secret: false
v5 refresh verifies with shipped .dev.vars secret: false
```

**Interpretation.** The tokens are signed with a *different* (production) secret. That is the better of the two possible worlds: the zip is not a token-forgery kit (an attacker cannot mint arbitrary merchant tokens from the shipped secret). It remains a **credential-theft kit**: the refresh token is a bearer credential redeemable at the production URL for fresh access tokens until 2026-10-01, scoped to merchant 8 / device 4 with read+write on the mobile API.

### 28.4 Timeline reconstruction

```text
2026-09-01 00:43:51Z   refresh token issued (pairing flow; still valid)
2026-09-02 02:47:39Z   v4 access token minted (inside the v4 zip)
~03:40Z                 Report 3 delivered (flags this exact file & token)
2026-09-02 03:47:45Z   v5 access token minted — AFTER the report, from the same refresh token
03:52–04:12Z            v5 file mtimes (packaging window)
```

The only consistent reading: the pairing/simulation workflow ran again during packaging, using the compromised-and-flagged refresh token, and the resulting state file was zipped into the release that claims to have purged it. The production `JWT_SECRET` cannot have been rotated in this window (rotation would have killed the refresh flow).

---

# PART V — CONSOLIDATED FINDING LEDGER

## 29. Carried-forward findings (unchanged files, diff-proven)

The v4→v5 diff touches exactly three `src/` files (§12). Every other finding from the series whose remediation would live in an untouched file is **provably unchanged**. Status below reflects v5; "ledger" column = the shipped REMEDIATIONS.md's current treatment.

| Finding | Severity | Carried status in v5 | Ledger treatment | Notes |
|---|---|---|---|---|
| P1-007 (EDGE-P1-007) createIntent race | P1 | OPEN (unchanged) | **OPEN** ✓ honest | "30-day roadmap: UNIQUE constraint" — first time this appears honestly in the ledger |
| P2-001 (EDGE-P2-001) csrf.ts dead middleware | P2 | OPEN (unchanged) | **OPEN** ✓ honest | State-changing web routes still rely on a middleware that is never mounted |
| P2-006 / V4-002 prod telemetry dark | P2 | OPEN (unchanged) | **FIXED** ✗ fabricated | `analytics_engine_datasets` still commented; cited test has no coverage (§4) |
| V3-004 claim-token KV plaintext staging (15 min) | P2 | OPEN (unchanged) | **absent** | Mitigated in *impact* by the new platform gate (V3-010) — only platform admins can redeem now — but the staging mechanism (plaintext creds in KV) is unchanged |
| V3-008 fresh-deploy bootstrap lockout | P2 | OPEN (unchanged) | **absent** | Dropped from the ledger rather than tracked |
| P2-007 no webhook outbox | P2 | OPEN (unchanged) | absent | Crash between D1 commit and queue send still loses the message |
| P2-015 merchant-editable ReDoS regexes | P2 | OPEN (unchanged) | absent | |
| P2-016 fail-open gateway enablement | P2 | OPEN (unchanged) | absent | |
| P2-017 PBKDF2 50K iterations | P2 | OPEN (unchanged) | absent | |
| P1-010 KV rate-limiter grouping race | P1 | OPEN (unchanged) | **PARTIAL** | Honest-ish; the fix class is unchanged |
| EDGE-P0-005 install/bootstrap chain | P0 | PARTIAL (unchanged) | PARTIAL ✓ | |
| EDGE-P1-006 state machine regression | P1 | PARTIAL (unchanged) | PARTIAL ✓ | |
| EDGE-P0-001 secret hygiene (prod half) | P0 | PARTIAL | PARTIAL — "production JWT_SECRET rotation documented" | **The rotation has not happened** — proven by §28.4's timeline (refresh flow still works) |

The money-core P0s fixed in earlier rounds (ledger reversal, bounded refunds, callback amount binding, XSS/CSP, SMS null-amount) remain fixed — their files are unchanged, and the battery's money suites (ledger-consistency, payment-integrity, gateways, catalog-port) all pass in the 233/233 run.

## 30. V5 finding registry (eleven new findings, this round)

| ID | Severity | Title | One-line statement |
|---|---|---|---|
| **V5-001** | **P1** | Live production credential re-shipped, fresher than the flag | `.companion-state.json` ships in the v5 artifact with an access token minted *after* Report 3 and the same un-rotated refresh token (exp 2026-10-01); V4-004's "purged" claim is false; artifact channel ungated by CI (§5, §18, §28) |
| V5-002 | P2 | Fabricated FIXED row (third consecutive release) | Ledger row V4-002 "Telemetry & Observability Fallback — FIXED" against byte-identical files, still-commented config, and a citation with zero related assertions (§4) |
| V5-003 | P2 | Hygiene gate is structurally vacuous | `verify-config.mjs` checks `git ls-files` (walks up / errors in artifact context) — prints success while the state file and `.dev.vars` ship in the same tree (§18.3, §34.1) |
| V5-004 | P3 | Ledger verifier skips the row it exists to check | `verify-remediations.mjs`'s header heuristic (`includes('Finding ID')`) false-positives on the V4-003 row's category text; 47 data rows, 46 checked (§20.2, §34.2) |
| V5-005 | P3 | Citation relevance still unchecked | V3-010 / NEW-P2-004 / EDGE-P1-005 cite `tenant-routing.test.ts` (zero claim coverage); V4-002 cites `smoke.test.ts` (zero observability coverage); verifier checks existence only (§17.3, §34.3) |
| V5-006 | P3 | Vacuous regression test | `mobile-heartbeat.test.ts` asserts `toBeDefined()` on a pre-populated column; passes on v4 code; no cross-tenant negative (§33) |
| V5-007 | P3 | Miswired gateway spy | `refund-ordering.test.ts` spies `StripeGateway` on a `'manual'`-slug fixture; `resolve('manual')` throws pre-adapter; assertion non-discriminating (§27, §33) |
| V5-008 | P4 | Hedged asset assertion | `assets-serving.test.ts` accepts `[200, 404]` for the primary V4-007 claim (actual behavior: 200) (§33) |
| V5-009 | P4 | Documentation inflation | TEST_RESULTS.md "240+ tests" (actual 233); REMEDIATIONS.md preamble "27+ suites / 230+ tests" (actual 28/233); verifier "46 rows" (47 exist) (§21) |
| V5-010 | P4 | Test-env secret substitution | vitest plugin loads `.dev.vars` ("Using secrets defined in .dev.vars"), overriding the declared test `JWT_SECRET` binding; shipped dev secrets silently active in the harness (§13) |
| V5-011 | P4 | Cap parsing leniency + DELETE contract note | `parseInt` accepts leading-numeric garbage CL (`12x34` → 12); bodyless DELETEs without `Content-Length: 0` now 411 (no internal breakage found; external clients need documenting) (§14.3) |

## 31. Ledger completeness audit — what REMEDIATIONS.md still omits

The claim was "complete non-colliding finding registry." The collision half is true (47 unique IDs, auditor-verified). The completeness half is not — cross-referencing the series registry (Appendix G) against the 47 shipped rows, at least these known findings are absent:

- **V3-004** (claim-token KV plaintext staging) — was in Report 3's registry; dropped.
- **V3-008** (bootstrap lockout) — dropped.
- **V4-006** ("100% Healthy" verdict overclaim, Report 3) — dropped.
- **V4-009** (stale TEST_RESULTS.md, Report 3) — arguably resolved this round (file rewritten), but untracked rather than closed.
- **P2-007** (webhook outbox), **P2-015** (ReDoS), **P2-016** (fail-open gateway enablement), **P2-017** (PBKDF2) — the four P2s Report 3 explicitly named as money-blocking; all dropped.
- The P1-003-family webhook determinism/geo residuals — dropped.

The honest formulation remains what Report 3 asked for: either add the missing rows or retitle the document ("claims tracked for the current round" rather than "all findings across the audit series"). The current state — 47 rows, 2 of them false, ~9 known findings absent, the verifier skipping 1 row — is better than v4's 30-row all-fixed view, but it is not yet a control plane.

## 32. Movement analysis (v4 → v5)

| Axis | v4 (Report 3) | v5 (this report) |
|---|---|---|
| Code fixes claimed | 10 | 6 areas / 8 ledger rows |
| Code fixes verified true | 7 (V3-001/002/003/007/009 + static-500 + lint) | 4 (cap+411, assets, heartbeat, claim gate) — all live-proven |
| False "FIXED" rows | 2 (V3-005 core, EDGE-P2-006) + 5 fabricated citations | 2 (V4-004, V4-002) — citation fabrication reduced from 5 rows to ~4 rows of irrelevant citations |
| Live credential in artifact | yes (refresh token, exp 2026-10-01) | **yes — token refreshed post-report, same refresh token** |
| Test files / tests | 23 / 220 | 28 / 233 (5 new files; 3 with defective assertions) |
| CI gate | none | real, valid, well-formed (scope caveat) |
| Ledger rows / ID collisions | 30 / 7 collisions | 47 / 0 collisions; OPEN rows honest; ≥9 findings absent |
| Verification-summary numbers | did not reproduce (23/23 files vs claims; durations mismatched) | **reproduce exactly** (28/233) |
| P1/P2 carried backlog | ~10 items | same ~10 items (unchanged files) |

Net: engineering integrity improved materially; process integrity improved partially; the single worst finding (live credential) got *worse* (fresher) while being claimed fixed.

---

# PART VI — TEST-SUITE QUALITY REVIEW

## 33. The five new test files: real, green, and three of five flawed

### 33.1 `tests/payload-cap.test.ts` (6 tests) — CLEAN

Uses `duplex: 'half'` ReadableStream bodies to simulate chunked transfer (the correct technique in the workerd harness — the Worker sees no Content-Length, exactly as with real transfer-encoding), covers all four mutating verbs, asserts specific error codes (`LENGTH_REQUIRED`, `PAYLOAD_TOO_LARGE`), and includes the pass-through cases (GET without CL; small valid POST). This is the model for what the other four files should have been. One nit: the oversized-CL test declares `Content-Length: 133120` while sending a ~130-byte body — legal in the harness (the middleware keys on the header) and unreachable in production (edge enforces CL⇔body agreement), but a purist would stream 130 KB for real.

### 33.2 `tests/mobile-heartbeat.test.ts` (1 test) — VACUOUS (V5-006)

The fixture INSERTs the device row with `last_heartbeat_at` **already populated** (bound to `now`). The post-request assertion is:

```ts
expect(deviceRow?.last_heartbeat_at).toBeDefined();
```

`toBeDefined()` on a column the fixture itself set can never fail — regardless of whether the UPDATE matched 1 row or 0. The test therefore passes on **v4 code** (where `deviceId = authSubject` = user id 991 matches no device row, the UPDATE is a silent no-op, and the endpoint still returns `{success:true}`). It is a smoke test wearing a regression test's name. The fix it purports to verify is real (§16) — but nothing in the shipped suite would notice a regression of it. Discriminating form (auditor PoC-4): seed a sentinel value; assert it changed; add the cross-tenant negative.

### 33.3 `tests/assets-serving.test.ts` (2 tests) — HEDGED (V5-008)

```ts
// Either 200 (if file found by miniflare) or 404 from ASSETS binding, but NEVER 500
expect([200, 404]).toContain(res.status);
```

The comment concedes the test was written without knowing whether the fix works. A test that accepts the failure mode (404 = asset unreachable = V4-007 *not* fixed) cannot verify the fix. The second test (missing asset → 404) is fine. Reality, established by the auditor PoC and by the shipped suite's own transcript: **200** — the hedge was unnecessary. The fix: assert 200 and the content-type.

### 33.4 `tests/refund-ordering.test.ts` (2 tests) — MISWIRED SPY (V5-007)

The fixture creates the transaction via `PaymentService.createIntent({gateway: 'bkash'})`. In the test environment (no gateway credentials configured), the transaction's resolved `gateway_slug` is `'manual'` — observed directly in the run log: `REFUND_INITIATION_FAILED … "Gateway adapter not registered: manual"`. `RefundService.createRefund` calls `gatewayRegistry.resolve(tx.gateway_slug)` (refund.ts:144), which **throws before constructing any adapter**. The test's spy:

```ts
vi.spyOn(StripeGateway.prototype, 'refund').mockImplementation(...)
```

instruments a class that is never instantiated, on a gateway that is neither the fixture's (`bkash`) nor the resolved one (`manual`). The first test's meaningful assertion is `rejects.toThrow()` (the DB bound check) — which does pass and does prove the pre-check fires; the "gateway must NOT have been called" counter adds nothing. The second test's `row.status === 'pending'` assertion is valid. Correct instrumentation (auditor PoC-6): spy `gatewayRegistry.resolve` and count resolutions/adapter calls — that is the seam where reserve-then-call ordering is observable.

### 33.5 `tests/ssrf-webhook-test.test.ts` (2 tests) — CLEAN

Route-level: real API key in the DB, five internal/localhost/metadata URLs against `POST /api/v1/webhooks/tests`, asserts 400 INVALID_URL each. Dispatcher-level: `sendTest` rejects blocked URLs and asserts **no row persisted** — the persistence check is the good part (it discriminates against a guard that validates but still inserts). Both are correctly built; this is the second-cleanest file of the five.

## 34. The two gate scripts: what they verify and what they cannot

### 34.1 `verify-config.mjs` — the vacuity proof

```js
const trackedFiles = execSync('git ls-files', { encoding: 'utf8' })...
if (trackedFiles.includes('.dev.vars')) { /* FAIL */ }
if (trackedFiles.some(f => f.includes('companion-state.json'))) { /* FAIL */ }
```

Three failure modes, all demonstrated this round:
1. **No `.git` in the artifact** → `execSync` throws → caught → `console.warn('git check skipped')` → script continues → prints `✓`.
2. **Ancestor repo** (observed in this audit's layout) → `git ls-files` lists the *auditor's workspace* files → neither forbidden name is tracked *there* → prints `✓`.
3. **A real repo where the files were untracked but not deleted** → `git ls-files` omits them → prints `✓` — while the working-tree files (the ones that get zipped) still exist.

In every case the success line prints while the leak ships. The `sk_live_`/`whsec_` grep over `wrangler*.jsonc` is sound but covers only two prefixes in three files. The artifact-correct form is a tree scan (§37, action 2): fail if any path matching `.dev.vars` (non-`example`) or `**/*state.json` exists in the checkout — `git ls-files` answers "is it tracked," which is the wrong question for a distribution channel that zips the working tree.

### 34.2 `verify-remediations.mjs` — the parser blind spots

```js
if (!line.startsWith('|') || line.includes('Finding ID') || line.includes('---')) continue;
```

- `line.includes('Finding ID')` is a *substring* header test. The V4-003 row's category is literally "Finding ID Collision Resolution" → the row is skipped. The verifier therefore never inspects the one row describing its own remediation. Total: 47 data rows, 46 checked — matching the script's own output (`✓ 46 rows checked`), which is how the discrepancy was found.
- `line.includes('---')` would likewise skip any future row containing an em-dash run in prose (e.g. "30-day roadmap — see…"), a latent trap.
- Citation checking is `existsSync` on `tests/….test.ts` paths extracted by regex — existence, not content, not test names, not finding-ID mentions.

### 34.3 What a gate that would have caught this round's failures looks like

Two additions, ~15 lines total:
1. **Relevance check:** for each FIXED row, require the finding ID (or its cited test file) to appear in the cited file's *text*: `readFileSync(tf).includes(id)` — V3-010's citation of tenant-routing.test.ts fails instantly (no "V3-010", no "claim" coverage), V4-002's citation of smoke.test.ts fails instantly.
2. **Artifact scan:** fail if `find . -name '.dev.vars' ! -name '*.example' -o -name '*-state.json'` returns anything, and fail if any fixed-length JWT-shaped string (`eyJ…`) appears in any non-test file outside `docs/`.

Either check, shipped this round, would have blocked the release. That is the standard the gate should aim for: not "the ledger's citations point at files that exist" but "the release cannot contain what the ledger says was removed."

## 35. The vacuous-assertion taxonomy (with fixes)

| Pattern | Shipped instance | Why it passes anything | Discriminating form |
|---|---|---|---|
| Assert on fixture-prepopulated state | heartbeat `toBeDefined()` | INSERT set the value; the UPDATE is unobserved | Seed sentinel; assert change; negative case |
| Status-set hedging | assets `[200, 404]` | Both fix and no-fix are accepted | Assert the claimed status (200) |
| Wrong-seam spy | refund `StripeGateway` spy | Instrumented object never constructed | Spy the registry/factory seam; count resolutions |
| Existence-only citation | verify-remediations | File exists ≠ file covers | Content/ID-relevance check |
| Track-status hygiene | verify-config | Git says nothing about zips | Tree scan + secret-shape grep |

The pattern behind all five: each check was written against the *happy path the developer could observe*, not against the *failure mode the finding describes*. The series' recurring integrity failures (fabricated citations, false FIXED rows) are all downstream of this: a gate that cannot fail cannot refute a claim, and claims that are never refuted drift toward optimism.

---

# PART VII — VERDICT & OPERATOR ACTIONS

## 36. Verdict

**The four code fixes this round are genuine, live-proven, and well-targeted. The verification infrastructure is real and, for the first time in the series, the executable claims (lint/typecheck/test counts) reproduce exactly. The release is nonetheless not what its summary says it is:** the state-file purge did not happen (the file ships, with a fresher token than the one Report 3 flagged), the telemetry FIXED row is fabricated against unchanged files, the two new gates cannot see either failure, and the ledger still omits the carried backlog while claiming completeness.

**Production-readiness: NOT READY.** Blocking, in order:
1. **V5-001** — live refresh token (exp 2026-10-01) in the distributed artifact; production `JWT_SECRET` demonstrably un-rotated.
2. **V4-002/V5-002** — production telemetry dark (rate-limit fail-open alarm is a no-op) *and* the control plane says it is fixed.
3. **Ledger integrity (V5-002/004/005)** — false FIXED rows and absent rows mean release decisions made on this ledger are made on fiction, for the third consecutive release.
4. **Carried P1/P2 backlog** (~10 items, §29) — unchanged, several money-path relevant.

**Pilot-eligibility: YES, conditional** on action 1 (rotation) and a written acknowledgment of items 3–4. The platform's money-core remains sound (P0 ledger/refund/callback fixes intact and green), the new edge hardening is real, and the tenant-isolation gaps that mattered (heartbeat, claim redemption) are closed.

## 37. Operator action list (ranked, with effort estimates)

| # | Action | Closes | Effort | Why it is first |
|---|---|---|---|---|
| 1 | **Rotate the production `JWT_SECRET`** (and treat merchant-8/device-4 credentials as compromised; review mobile-API writes since 2026-09-01) | V5-001, EDGE-P0-001 (prod half) | minutes | The shipped refresh token is redeemable for 29 more days; rotation is the only unilateral kill-switch |
| 2 | **Fix the artifact pipeline + gate scope:** exclude `*state.json`/`.dev.vars` from zips; convert `verify-config.mjs` to a tree scan (+ JWT-shape grep); add the relevance check to `verify-remediations.mjs` (§34.3) | V5-003, V5-004, V5-005, V5-001 (recurrence) | ~half a day | Prevents the *class* — a gate that can fail is what makes the next "FIXED" mean something |
| 3 | **Correct the ledger:** V4-004 → OPEN; V4-002 → OPEN (or actually enable `analytics_engine_datasets` and deploy — minutes); add the ~9 missing rows; fix the 4 irrelevant citations (or add real tests — the auditor PoCs in Appendix A are ready-made for 3 of them) | V5-002, §31 | ~1 hour | The ledger is the operator's map; it currently shows two roads that do not exist |
| 4 | **Harden the three defective tests** to their discriminating forms (§35) | V5-006/007/008 | ~2 hours | Regression coverage that can fail is the only kind that protects the fixes |
| 5 | **Document the DELETE/411 contract** for external API consumers (bodyless DELETE requires `Content-Length: 0`) | V5-011 (compat half) | minutes | Prevents a support incident class before it happens |
| 6 | **Execute the carried backlog plan:** P1-007 UNIQUE constraint on createIntent, csrf.ts mount-or-delete, outbox, V3-004 claim-token encryption-at-rest, V3-008 bootstrap lockout, P2-015/016/017 | §29 | the existing 30-day roadmap | Itemized in Reports 3–4; none blocks pilot, all block real money |

## 38. What would make Report 5 short

The series' reports are long because every round mixes three jobs: verifying real fixes, refuting false claims, and re-listing carried findings. Any release that arrives with (a) no credential-shaped strings outside docs/, (b) a ledger whose every FIXED row cites a test that names the finding, and (c) the carried backlog either fixed or honestly OPEN, collapses this report's Parts III–VI into a one-page table. That is the challenge for remediation release 4 — the infrastructure shipped this round is, for the first time, good enough to build it from.

---

# APPENDICES

## Appendix A — Auditor PoC suite source (15 tests)

Archived at the auditor's workspace as `scripts/audit-poc-r4.test.ts`; run inside the project harness via `npx vitest run tests/audit-poc-r4.test.ts` (file temporarily placed in `tests/`, removed after the run; pristine battery re-verified 28/233 afterward). The full source is reproduced on the next page.

```typescript
/**
 * ROUND-4 INDEPENDENT PoCs — auditor-authored, NOT part of the shipped battery.
 * Discriminating tests for claims the shipped suite asserts weakly or not at all.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { createJwtService } from '../src/lib/jwt';
import { sha256 } from '../src/lib/crypto';
import { PaymentService } from '../src/services/payment';
import { LedgerService } from '../src/services/ledger';
import { RefundService } from '../src/services/refund';
import { gatewayRegistry } from '../src/gateways/base';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

interface StreamRequestInit extends RequestInit {
  duplex?: 'half';
}

function streamOf(data: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    },
  });
}

const withCL = (body: string, extra: Record<string, string> = {}) => ({
  headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), ...extra },
  body,
});

// ---------------------------------------------------------------------------
describe('PoC-1/2: payload cap — Report-3 bypass replay (300 KB chunked, no CL)', () => {
  it('411 BEFORE auth on a protected route with a 300 KB streamed body and no Content-Length', async () => {
    const big = 'x'.repeat(300 * 1024);
    const res = await SELF.fetch('http://localhost/api/v1/payments', {
      method: 'POST',
      body: streamOf(big),
      duplex: 'half',
      // no Authorization, no Content-Length
    } as StreamRequestInit);
    expect(res.status).toBe(411); // v4 returned 401 (cap skipped, body unread-bounded)
    const json = await res.json<{ error: { code: string } }>();
    expect(json.error.code).toBe('LENGTH_REQUIRED');
  });

  it('413 when Content-Length = 131073 (> 128 KB)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: { 'Content-Length': '131073' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('413 when Content-Length is non-numeric (NaN)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 'not-a-number' },
      body: '{}',
    });
    expect(res.status).toBe(413);
  });

  it('NOTE (informational): parseInt leniency — CL "12x34" parses as 12 and passes the cap', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '12x34' },
      body: '{}',
    });
    expect(res.status).not.toBe(413); // parseInt('12x34')=12 — malformed-but-leading-numeric CL is accepted (runtime/CF edge rejects malformed CL upstream)
    expect(res.status).not.toBe(411);
  });

  it('small valid CL passes the cap (health route: POST falls through to routing, not 411/413)', async () => {
    const res = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'POST',
      ...withCL('{}'),
    });
    expect([411, 413]).not.toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-3: static assets prefix rewrite (V4-007)', () => {
  it('/assets/css/checkout.css resolves to 200 with css content-type', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/checkout.css');
    expect(res.status).toBe(200); // their own test hedged [200,404]; we assert the actual claim
    expect((res.headers.get('content-type') || '')).toContain('text/css');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('missing asset under /assets/ is a clean 404 (mutable wrapper retained, no 500)', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/definitely-missing.css');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('root path / is not an asset route (documents behavior)', async () => {
    const res = await SELF.fetch('http://localhost/');
    expect(res.status).not.toBe(500);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-4: heartbeat tenant/device scoping — DISCRIMINATING test', () => {
  const merchantA = 990001;
  const merchantB = 990002;
  const deviceId = 9901;
  let jwtA: string, jwtB: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    for (const [mid, slug, mail] of [[merchantA, 'poc-a', 'poca@example.com'], [merchantB, 'poc-b', 'pocb@example.com']] as const) {
      await db.prepare(
        `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
         VALUES (?, ?, 'PocMerchant', ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind(mid, crypto.randomUUID(), slug, mail, now, now).run();
    }
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (991, ?, ?, 'Poc User', 'pocu@example.com', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantA, crypto.randomUUID(), await sha256('pocu@example.com'), now, now).run();
    await db.prepare(
      `INSERT INTO op_paired_devices (id, merchant_id, user_id, uuid, device_name, fingerprint, status, last_heartbeat_at, created_at)
       VALUES (?, ?, 991, ?, 'PocPhone', 'fp-9901', 'active', '2000-01-01T00:00:00.000Z', ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(deviceId, merchantA, crypto.randomUUID(), now).run();

    const jwt = createJwtService(tenv);
    jwtA = await jwt.issueAccessToken({ sub: '991', merchant_id: merchantA, device_id: deviceId, scope: ['read', 'write'] });
    jwtB = await jwt.issueAccessToken({ sub: '992', merchant_id: merchantB, device_id: deviceId, scope: ['read', 'write'] });
  });

  it('same-tenant heartbeat CHANGES last_heartbeat_at (their test asserted only toBeDefined — vacuous)', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      ...withCL('{}', { Authorization: `Bearer ${jwtA}` }),
    });
    expect(res.status).toBe(200);
    const row = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    expect(row?.last_heartbeat_at).not.toBe('2000-01-01T00:00:00.000Z'); // UPDATE actually matched
  });

  it('cross-tenant token (merchant B, foreign device id) returns 200 but does NOT touch the row', async () => {
    const before = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    const res = await SELF.fetch('http://localhost/api/mobile/v1/heartbeat', {
      method: 'POST',
      ...withCL('{}', { Authorization: `Bearer ${jwtB}` }),
    });
    expect(res.status).toBe(200); // handler is silent-success by design (documented residual)
    const after = await db.prepare(`SELECT last_heartbeat_at FROM op_paired_devices WHERE id = ?`).bind(deviceId).first<{ last_heartbeat_at: string }>();
    expect(after?.last_heartbeat_at).toBe(before?.last_heartbeat_at); // row untouched
  });
});

// ---------------------------------------------------------------------------
describe('PoC-5: /api/admin/v1/merchants/claim platform gate (V3-010)', () => {
  const normalMerchant = 970001;
  const platformMerchant = 970002;
  const CLAIM_TOKEN = 'r4-poc-claim-token';
  let normalKey: string, platformKey: string;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'NormalMerchant', 'poc-normal', 'n@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(normalMerchant, crypto.randomUUID(), now, now).run();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'PlatformMerchant', 'poc-platform', 'p@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 1, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(platformMerchant, crypto.randomUUID(), now, now).run();

    const mk = async () => {
      const prefix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const rest = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      return `op_live_${prefix}_${rest}`;
    };
    normalKey = await mk();
    platformKey = await mk();
    for (const [k, mid] of [[normalKey, normalMerchant], [platformKey, platformMerchant]] as const) {
      const prefix = k.split('_')[2];
      await db.prepare(
        `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
         VALUES (?, 'poc-key', ?, ?, '["read","write","admin"]', 'active', ?)`
      ).bind(mid, prefix, await sha256(k), now).run();
    }
    await tenv.KV.put(`claim:${CLAIM_TOKEN}`, JSON.stringify({ api_key: 'poc-claimed-secret', merchant: 'newly-provisioned' }));
  });

  it('unauthenticated request is rejected (not 200)', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN })),
    });
    expect(res.status).not.toBe(200);
    expect([401, 403, 503]).toContain(res.status);
  });

  it('NON-platform admin key gets 403 FORBIDDEN (the V3-010 fix)', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${normalKey}` }),
    });
    expect(res.status).toBe(403);
    const json = await res.json<{ error: { code: string; message: string } }>();
    expect(json.error.code).toBe('FORBIDDEN');
    expect(json.error.message).toContain('Platform administrator');
    // token must NOT be consumed by the rejected attempt
    expect(await tenv.KV.get(`claim:${CLAIM_TOKEN}`)).not.toBeNull();
  });

  it('platform admin key redeems exactly once', async () => {
    const res = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ success: boolean; data: { api_key: string } }>();
    expect(json.data.api_key).toBe('poc-claimed-secret');
    // one-time: second redemption fails
    const res2 = await SELF.fetch('http://localhost/api/admin/v1/merchants/claim', {
      method: 'POST',
      ...withCL(JSON.stringify({ claim_token: CLAIM_TOKEN }), { Authorization: `Bearer ${platformKey}` }),
    });
    expect(res2.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('PoC-6: refund reserve-then-call with the CORRECT gateway spy (bkash fixture)', () => {
  const merchantId = 980001;
  let trxId: number;

  beforeAll(async () => {
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'RefundPocMerchant', 'poc-refund', 'r@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();
    const ledger = new LedgerService(tenv);
    await ledger.createDefaultChartOfAccounts(merchantId, 'BDT');
    const paymentService = new PaymentService(tenv);
    const intent = await paymentService.createIntent({
      merchant_id: merchantId, amount: '100.00', currency: 'BDT', gateway: 'bkash',
    });
    const txRow = await db.prepare(`SELECT id FROM op_transactions WHERE payment_intent_id = ?`).bind(intent.intent_id).first<{ id: number }>();
    trxId = txRow!.id;
    await paymentService.completeTransaction(trxId, intent.intent_id, 'gw-poc-6');
  });

  it('over-bound refund: throws, gateway NEVER resolved/called, NO ghost pending row', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => { refundCalls++; return { success: false, error: 'poc' }; },
    };
    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);
    const refundService = new RefundService(tenv);
    await expect(
      refundService.createRefund({ merchant_id: merchantId, transaction_id: trxId, amount: '150.00', reason: 'poc-over-bound', initiated_by: null })
    ).rejects.toThrow();
    expect(resolveCalls).toBe(0); // bound check throws BEFORE the registry is even touched
    expect(refundCalls).toBe(0);  // ...and no adapter method runs (their test spied StripeGateway on a 'manual'-slug fixture)
    const ghost = await db.prepare(
      `SELECT COUNT(*) AS n FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?`
    ).bind(trxId, merchantId).first<{ n: number }>();
    expect(ghost?.n).toBe(0); // conditional INSERT...SELECT leaves no ghost row
    registrySpy.mockRestore();
  });

  it('valid refund: pending reservation exists, THEN gateway resolve+refund run (ordering proof)', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => { refundCalls++; return { success: false, error: 'poc-env-no-credentials' }; },
    };
    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);
    const refundService = new RefundService(tenv);
    const res = await refundService.createRefund({
      merchant_id: merchantId, transaction_id: trxId, amount: '30.00', reason: 'poc-valid', initiated_by: null,
    });
    expect(resolveCalls).toBe(1); // gateway resolution happens only AFTER the reservation INSERT succeeded
    expect(refundCalls).toBe(1);
    expect(res.refund_row_id).toBeGreaterThan(0);
    const row = await db.prepare(`SELECT status, gateway_refund_id FROM op_refunds WHERE id = ?`).bind(res.refund_row_id).first<{ status: string; gateway_refund_id: string | null }>();
    expect(row?.status).toBe('pending'); // reserved before the call — the V3-003 invariant
    expect(row?.gateway_refund_id).toBeNull(); // gateway refused -> no id recorded
    registrySpy.mockRestore();
  });
});
```

## Appendix B — PoC run transcript (condensed)

```text
$ npx vitest run tests/audit-poc-r4.test.ts
 RUN  v4.1.11 /home/z/my-project/audit/v5/edgepay-cf
 Using secrets defined in .dev.vars            ← see V5-010 (§13)

 ✓ 411 BEFORE auth on a protected route with a 300 KB streamed body and no Content-Length  10ms
 ✓ 413 when Content-Length = 131073 (> 128 KB)                                              4ms
 ✓ 413 when Content-Length is non-numeric (NaN)                                             3ms
 ✓ NOTE (informational): parseInt leniency — CL "12x34" parses as 12 and passes the cap     9ms
 ✓ small valid CL passes the cap (health route: POST falls through to routing)             44ms
 ✓ /assets/css/checkout.css resolves to 200 with css content-type                           8ms
 ✓ missing asset under /assets/ is a clean 404 (mutable wrapper retained, no 500)           4ms
 ✓ root path / is not an asset route (documents behavior)                                    3ms
 ✓ same-tenant heartbeat CHANGES last_heartbeat_at (their test asserted only toBeDefined)   —
 ✓ cross-tenant token (merchant B, foreign device id) returns 200 but does NOT touch the row—
 ✓ unauthenticated request is rejected (not 200)                                             4ms
 ✓ NON-platform admin key gets 403 FORBIDDEN (the V3-010 fix)                               11ms
 ✓ platform admin key redeems exactly once                                                  20ms
 ✓ over-bound refund: throws, gateway NEVER resolved/called, NO ghost pending row            5ms
 ✓ valid refund: pending reservation exists, THEN gateway resolve+refund run (ordering)     —

 Test Files  1 passed (1)
      Tests  15 passed (15)
   Duration  4.16s
```

Supporting runtime log lines observed during the runs (verbatim, JSON envelope trimmed):

```json
{"level":"page","code":"REFUND_INITIATION_FAILED","detail":{"transaction_id":1,
 "merchant_id":980001,"refund_id":"rfnd_…","error":"Gateway adapter not registered: manual"},
 "environment":"production"}                       ← the 'manual'-slug evidence for §33.4
{"level":"page","code":"REFUND_GATEWAY_FAILED","detail":{"refund_id":"rfnd_…",
 "merchant_id":980001}}                             ← reconciliation workflow healing the
                                                      failed refund (outbox-less but observable)
```

## Appendix C — JWT forensic detail (v4 vs v5 state files)

```text
--- v4/edgepay-cf/sms-phone-mockup/.companion-state.json ---
  jwt_token:     type=access  sub=6 merchant=8 device=4  iat=1788317259 exp=1788320859
  refresh_token: type=refresh sub=6 merchant=8 device=4  iat=1788223431 exp=1790815431
    jwt_token     exp: 2026-09-02 03:47:39 UTC   iat: 2026-09-02 02:47:39 UTC
    refresh_token exp: 2026-10-01 00:43:51 UTC   iat: 2026-09-01 00:43:51 UTC
  keys: edgepay_url, jwt_token, refresh_token, paired, merchant_id, device_uuid,
        device_name, auto_relay_enabled, simulation_active, simulation_interval_ms,
        last_heartbeat_at, battery_level, is_charging, carrier

--- v5/edgepay-cf/sms-phone-mockup/.companion-state.json ---
  jwt_token:     type=access  sub=6 merchant=8 device=4  iat=1788320865 exp=1788324465
  refresh_token: type=refresh sub=6 merchant=8 device=4  iat=1788223431 exp=1790815431
    jwt_token     exp: 2026-09-02 04:47:45 UTC   iat: 2026-09-02 03:47:45 UTC  ← post-Report-3
    refresh_token exp: 2026-10-01 00:43:51 UTC   iat: 2026-09-01 00:43:51 UTC  ← identical
  keys: (same fourteen keys)

HMAC-SHA256 verification against the shipped .dev.vars JWT_SECRET (8f9eb3f8…):
  v4 access  → false      v4 refresh → false
  v5 access  → false      v5 refresh → false
  ⇒ tokens are signed with the production secret; the zip is a credential-theft
    vector, not a forgery kit.

File sizes: v4 1,119 B  |  v5 1,119 B  (identical shape, refreshed token payload)
```

## Appendix D — Claim verification matrix (developer message → verdict)

| Developer message section | Ledger rows | Auditor verdict | Primary evidence |
|---|---|---|---|
| "Payload Cap & 411 Length Required Enforced (index.ts:79-101)" | V4-005, V4-010, V3-005 | **TRUE** | §14 code quote; PoC-1/2 (411 pre-auth on 300 KB stream; 413 ×2) |
| "Static Assets Path Rewriting (index.ts:245-253)" | V4-007 | **TRUE** | §15 code quote; PoC-3 (200 / text/css / nosniff / DENY) |
| "Mobile Heartbeat Tenant & Device Scoping (mobile.ts:125-133)" | EDGE-P3-002 | **TRUE** (test vacuous) | §16 code+plumbing; PoC-4 (change + cross-tenant negative) |
| "Admin Merchant Claim Platform Gate (admin-api.ts:270-283)" | V3-010 | **TRUE** (citation irrelevant) | §17 code; PoC-5 (403 / unconsumed / one-time) |
| "Credential Hygiene & State File Purge (V4-004)" | V4-004 | **FALSE** | §18 + §28: file present, fresher token, un-rotated refresh, gates vacuous |
| "New Automated Test Suites & Benchmarks (V4-001)" | V4-001 | **TRUE / quality partial** | §19, §33: 5 files, 13 tests, green; 3 defective |
| "Automated CI & Audit Gate (V4-011, V4-003, V4-008)" | V4-003, V4-008, V4-011 | **PARTIAL** | §20: workflow valid (hexdump); scripts blind (§34) |
| "npm run lint — 0/0" | — | **TRUE** | §13 reproduction |
| "npm run typecheck — 0 errors" | — | **TRUE** | §13 reproduction |
| "verify-remediations — 46 rows, 0 errors" | — | **TRUE (output)** / parser caveats | §20.2 (47 rows; V4-003 skipped) |
| "verify-config — verified" | — | **TRUE (output)** / vacuous | §18.3 (walk-up demo) |
| "npm test — 28 files, 233 tests, ~13.8s, 100% green" | — | **TRUE** (counts) | §13: 28/233, 7.07–7.20s, green |
| Ledger: "complete non-colliding finding registry" | V4-003 | **PARTIAL** | §31: unique IDs ✓; ≥9 findings absent |
| Ledger row V4-002 "Telemetry… FIXED… smoke.test.ts" | V4-002 | **FABRICATED** | §4: files unchanged, config commented, zero related assertions |

## Appendix E — The retraction record (`audit-gate.yml` display artifact)

During initial review, the auditor's terminal pipeline rendered the workflow's trigger as:

```text
on:
  push:
    branches: ain, master]
```

which was (correctly, by the series' own standards) about to be filed as a P2 finding — "the CI gate can never trigger." Byte-level re-examination before publication:

```text
$ sed -n '1,8p' .github/workflows/audit-gate.yml | od -c
0000060   b   r   a   n   c   h   e   s   :       [   m
0000100   a   i   n   ,       m   a   s   t   e   r   ]  \n
```

The file contains `branches: [main, master]` — valid YAML, correct triggers for both `push` and `pull_request`. The apparent corruption was an artifact of the auditor's own output rendering (the two bytes `[m` were consumed by the display pipeline), and a YAML parse plus the `Read`-tool view of the file independently confirmed the correct content. **The finding is retracted in full.** It is recorded here because the discipline that caught it — never file a claim without byte-level evidence — is the same discipline this report applies to the developer, and it must visibly run in both directions. The workflow's genuine limitations are scope-based and stand in §20.1.

## Appendix F — Reproduction commands

```text
# 0. Extract and inventory
unzip edgepay-cf-clean-new-3.zip -d v5
md5sum edgepay-cf-clean-new-3.zip          # 7203316c47561ab8de2775c72a827a80
diff -rq v4/edgepay-cf v5/edgepay-cf       # the 17-entry change inventory (§12)

# 1. Verification battery (clean)
cd v5/edgepay-cf && npm ci --no-audit --no-fund
npm run lint                               # 0/0
npm run typecheck                          # exit 0
node scripts/verify-remediations.mjs       # "✓ 46 rows checked, 0 errors"
node scripts/verify-config.mjs             # "✓ … verified" (see §18.3 for vacuity)
npm test                                   # 28 files / 233 tests / green

# 2. Gate-scope demonstration
git -C v5/edgepay-cf rev-parse --show-toplevel   # → walks up (no .git in artifact)
ls v5/edgepay-cf/sms-phone-mockup/.companion-state.json  # → present (1,119 B)
ls v5/edgepay-cf/.dev.vars                       # → present (189 B)

# 3. Ledger parser check
node -e "…count rows vs script-checked rows…"   # 47 data rows, 46 checked, V4-003 skipped

# 4. Forensics on the state file
python3 - <<'EOF'   # decode JWT claims (iat/exp/sub/merchant/device) — §28 table
node - <<'EOF'      # HMAC-SHA256 verify both tokens against .dev.vars secret → all false

# 5. Auditor PoCs
cp scripts/audit-poc-r4.test.ts v5/edgepay-cf/tests/
cd v5/edgepay-cf && npx vitest run tests/audit-poc-r4.test.ts   # 15/15 pass
rm tests/audit-poc-r4.test.ts && npx vitest run                 # pristine: 28/233
```

## Appendix G — Series finding registry (cumulative status after Round 4)

P0s (money-path, original Report 1 groups): EDGE-P0-002 reversal, P0-003 unbounded refunds, P0-004 callback binding, P0-006 XSS/CSP, P0-007 SMS null-amount — **FIXED (files unchanged since their fixing rounds; money suites green)**. EDGE-P0-005 install/bootstrap — PARTIAL (carried). EDGE-P0-001 secret hygiene — PARTIAL (dev keys rotated earlier; **production JWT_SECRET still un-rotated — proven this round, V5-001**).

P1s: P1-001 idempotency, P1-002 OTP rate limits, P1-003 payload cap (**core bypass closed this round — V3-005/V4-005/010 verified**), P1-004 SSRF, P1-005 tenant enumeration, P1-008 write scopes — FIXED. P1-006 state machine — PARTIAL. **P1-007 createIntent race — OPEN (ledger-honest). P1-010 KV limiter race — PARTIAL (carried).**

P2s: P2-005, P2-018, NEW-P2-001…005, V3-002/005/006/007, V3-010 (**fixed this round**) — FIXED. **P2-001 CSRF dead code — OPEN (ledger-honest). P2-006 prod telemetry — OPEN (ledger falsely FIXED — V5-002). P2-007 outbox, P2-015 ReDoS, P2-016 fail-open enablement, P2-017 PBKDF2 — OPEN (absent from ledger). V3-004 claim-token staging — OPEN, impact-reduced by the new gate. V3-008 bootstrap lockout — OPEN (absent from ledger).**

P3/P4: EDGE-P3-002 heartbeat (**fixed this round**), P3-003 notifications, V3-001/003/009/011, NEW-P3-001/002, V4-007 (**fixed this round**) — FIXED or verified. V4-001 (citations) — PARTIAL. V4-003 (collisions) — resolved for IDs, incomplete for coverage. **V4-004 → re-opened as V5-001. V4-005/010 — fixed. V4-008/009 — improved (docs still inflated). V4-011 — infrastructure real, scope-limited.**

V5 (this report): V5-001 (P1, credential re-ship), V5-002 (P2, fabricated FIXED row), V5-003 (P2, vacuous hygiene gate), V5-004 (P3, verifier blind spot), V5-005 (P3, citation relevance), V5-006/007/008 (test-quality), V5-009 (P4, doc inflation), V5-010 (P4, test-env secret substitution), V5-011 (P4, parsing leniency + DELETE contract note).

**Cumulative open count after Round 4: 1 P0-half (prod secret rotation), 2 P1 (P1-007, P1-010), 8 P2, plus the V5 process findings.** The money-core is stable; the perimeter and the process are what still stand between this platform and real money.

---

*Report 4 of the EDGEpay-CF audit series. Independent verification only — no production systems were contacted during this audit. Auditor PoCs, transcripts, and forensic scripts are preserved in the auditor workspace for any third-party re-run.*
