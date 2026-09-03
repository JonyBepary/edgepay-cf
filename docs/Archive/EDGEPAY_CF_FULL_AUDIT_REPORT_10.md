# EDGEPAY_CF_FULL_AUDIT_REPORT_10.md

**Round 11 of the independent audit series — verification of "Report 9 Remediations & Multi-Worker Frontend Architecture" (v0.4.5)**

- **Date:** 2026-09-03
- **Auditor:** Independent verifier (unchanged methodology since Report 1)
- **Evidence primary:** `upload/edgepay-cf-clean-new-9.zip` — 25,540,292 bytes, md5 `c0ce083c7c83e7cee39118e9ba543a24`, 695 entries, tree state dated 2026-09-03 00:39 UTC
- **Comparison generation:** new-8 (Report 9 evidence base)
- **Live control:** `https://edgepay-cf.bm-jonybepary.workers.dev/api/openapi.json` (re-fetched this round)
- **Verification environment:** fresh extraction to `audit-r10/new9-raw` (read-only evidence) + `audit-r10/run-tree` (pipeline reproduction); `npm ci` from lockfile; Node 20; workerd via `@cloudflare/vitest-plugin`

---

## 1. Executive Summary

This round carries the largest change surface of the series — the Report 9 remediations (V10-001…V10-005) **plus** an entirely new multi-Worker frontend layer — and the remediation quality is high: all five V10 fixes are implemented in code, four of the five are empirically effective in my reproduction (the fifth — the hand-off channel — is real as tooling but was not used for the artifact I received), and the release archive reaches **content-level full equality** with a clean-tree rebuild for the first time since the equality metric regressed in Report 9 (325/325 files byte-identical; only the manifest build timestamp differs). The binary allowlist inversion (V10-003) survives a five-file pollution experiment with zero leaks. The claim-encryption fail-closure (V10-005) and the PBKDF2 pin/wiring (V10-004) are genuine, tested, and match the Report 9 prescriptions almost line-for-line.

The frontend layer is architecturally faithful to the Round-10 (F1) blueprint — four Hono workers on separate names (`edgepay-checkout`, `edgepay-merchant`, `edgepay-admin`, `edgepay-hub`), shared `@edgepay/ui` / `@edgepay/gateway-brand` packages, a merchant BFF with KV sessions, an admin proxy that injects Access service tokens exactly as the blueprint requires — and the shipped static panels are near-verbatim embeds of the auditor's own F1 samples (merchant panel byte-identical; checkout 1 byte; design-system hub identical). But the layer ships as **scaffolding**: the "Astro" half of "Astro + Hono" has no toolchain behind it (no astro dependency, no config, the `.astro` pages are non-building skeletons), the merchant BFF authenticates against a **fail-open** fallback with a demo identity and stores API keys in **plaintext KV sessions**, and the entire `frontend/` tree sits **outside every quality gate** (no lint, no typecheck, no CI coverage, not counted in the "31 test files" battery).

Seven new findings. The most material: **(V11-001, P3)** the distribution hand-off still ships `.dev.vars` — the sixth consecutive round — even though `scripts/package-handoff.mjs` now exists, works, and produces a verified-clean archive; the tooling was built and then not used for the actual hand-off; **(V11-002, P3)** ~1,500 lines of new trust-plane code (BFF auth, session handling, API proxies) have zero static-analysis or CI coverage; **(V11-003, P3)** the merchant BFF's login fails open on fetch errors and stages merchant API keys in KV unencrypted — the exact genre (V3-004/V10-005) the core just spent two rounds closing, reintroduced in new code; **(V11-004, P4)** the round that claims to fix documentation count-sync itself desynced the ledger (263/30 vs the tree's 269/31 — the count-drift genre's fourth recurrence); **(V11-005, P4)** an undeclared backward `compatibility_date` regression across all three configs; **(V11-006, P4)** the new public `/frontend/*` HTML routes ship without CSP while admin/merchant panels are publicly enumerable on the main worker; **(V11-007, P4)** the "100% green / deterministic" test battery is flaky — my first post-install run failed `ledger-consistency` on a D1 UNIQUE constraint (4/5 subsequent runs green).

Claim score: **12/14 verified, 1 verified-with-caveat, 1 not adopted** (hand-off channel). Production JWT_SECRET rotation remains the highest OPEN operational item, now overdue across multiple rounds.

---

## 2. Claim Verification Matrix

| # | Developer claim (TEST_RESULTS.md v0.4.5) | Verdict | Evidence |
|---|---|---|---|
| C1 | 31 test files / 269 tests / 100% green | **Reproduced (with flake)** | 269/269 green in 4 of 5 runs; first post-`npm ci` run failed `ledger-consistency.test.ts` (UNIQUE constraint, §4) → V11-007 |
| C2 | Typecheck 0 errors, ESLint 0/0 | **Reproduced — scope caveat** | Both clean; but gates cover only `src`/`tests` — `frontend/` is ungated → V11-002 |
| C3 | Audit gate: 91 ledger rows, non-colliding IDs | **Reproduced** | `verify-remediations.mjs`: 91 rows, 0 errors, 0 duplicates; 7 benign relevance WARNs |
| C4 | Release gate `npm run package` PASS with SHA-256 manifest | **Reproduced** | Full pre-flight battery re-runs inside; archive 3,982,923 B; 258 staged + manifest = 259 file entries, +67 dir entries = 326 — arithmetic exact |
| C5 | Hand-off gate `npm run package:handoff` PASS | **Reproduced** | Script chains release packager, re-zips staging tree, per-entry forbidden-pattern battery, emits SHA-256; output verified clean |
| C6 | 3+1 decoupled Workers (checkout/merchant/admin/hub) with isolated trust planes | **Structure verified** | 4 deployable Hono apps (`frontend/apps/*`, own `wrangler.jsonc`, `public/index.html` = served panels); hub carries design system |
| C7 | Shared `@edgepay/ui` (Sanzo Wada tokens, haptics, motion) + `@edgepay/gateway-brand` | **Verified** | `tokens.css` (100 lines, WCAG-calibrated palette), `haptics.ts` (4 patterns, reduced-motion gate), `motion.ts` (GSAP budgets + reduced-motion gates), `gateway-brand` (4 MFS rails, TrxID regexes) |
| C8 | "Astro + Hono" frontend | **Half-true** | Hono workers real (deployable via wrangler); Astro nominal — no astro dep/config/build; `.astro` pages are skeletons; panels served are static HTML embeds of the auditor's F1 samples |
| C9 | V10-004: 600K pinned + universal `getPbkdf2Iterations` wiring | **Verified** | `crypto-security.test.ts` pins 600,000 / bounds / override fallback; helper wired at `install.ts:138`, `bootstrap.ts:73`, `admin-api.ts:353`; `verifyPassword` now bounds-checks stored cost |
| C10 | V10-005: fail-closed AES-256-GCM claim tokens + integration test | **Verified** | Write: missing key → 500 SECURITY_ERROR, encrypt throw → 500; read: missing key → 500, decrypt throw → 400 + log; new PoC test asserts KV value is not `{`-prefixed, round-trip, one-time deletion |
| C11 | V10-003: strict allowlist denies non-code/non-text binaries | **Verified empirically** | 5/5 planted files (`invoice.pdf`, `backup.zip`, `video.mp4`, `mystery.bin`, `payload.xyz`) excluded; post-build check now per-entry (fixes the dead `\.log\n` regex) |
| C12 | V10-002: reconciled version 0.4.5 and 263 tests | **Mostly** | 0.4.5 consistent across `package.json`, `frontend/package.json`, manifest, TEST_RESULTS; archive↔tree equality restored; but ledger says 263/30 vs actual 269/31 → V11-004 |
| C13 | V10-001: automated clean hand-off pipeline | **Tooling verified — not adopted** | `package-handoff.mjs` real and clean; but the received hand-off is still an ad-hoc full-tree zip carrying `.dev.vars` (6th round) → V11-001 |
| C14 | Strict security headers & nonce CSP on all JSON/HTML surfaces (incl. frontend) | **Overstated** | JSON surfaces retain the nonce-CSP middleware; the new `/frontend/*` HTML routes ship nosniff+DENY only, no CSP → V11-006 |

---

## 3. Change Surface (new-9 vs new-8)

```
Modified (15):
  scripts/package-release.mjs           (V10-003 allowlist inversion, version stamp)
  src/controllers/admin-api.ts           (V10-005 fail-closed claim encryption, V10-004 wiring)
  src/controllers/install.ts             (V10-004 wiring via shared helper)
  src/lib/crypto.ts                      (getPbkdf2Iterations export, verify bounds, AES key derivation fallback)
  src/services/bootstrap.ts              (V10-004 wiring)
  src/index.ts                           (NEW: /frontend + /frontend/:app asset routes)
  wrangler.jsonc / wrangler.dev.jsonc / wrangler.staging.jsonc   (compatibility_date 2026-08-28 → 2026-07-21, undeclared)
  package.json / TEST_RESULTS.md / docs/REMEDIATIONS.md           (v0.4.5, +5 V10 ledger rows)
  tests/crypto-security.test.ts          (+2 cases: 600K pin, out-of-range hash rejection)
  tests/audit-poc-r4.test.ts             (+1 case: encrypted claim round-trip)

New:
  scripts/package-handoff.mjs            (V10-001 hand-off gate)
  tests/frontend-architecture.test.ts    (7 cases — main-worker static serving + gateway-brand invariants)
  frontend/                              (4 Hono workers + 2 shared packages, ~1,500 lines)
  public/assets/{admin,checkout,merchant,design-system,diagrams}/   (built panels + diagrams)
  frontend_reference/                    (auditor's F1 deliverables copied into the repo)
  EDGEPAY_CF_FULL_AUDIT_REPORT_9.md     (auditor's prior report — expected)
  dist/                                  (regenerated: staging tree + release.zip + clean-handoff.zip)
```

No undeclared mutations inside `src/` beyond the declared remediation files; the `src/index.ts` route additions and the triple-config compatibility-date change are **undeclared** (the former is visible in the new tests, the latter is not — see V11-005). `frontend_reference/` (9.6 MB, including the auditor's PDF report) enters the repo but is correctly excluded from both archives.

---

## 4. Pipeline Reproduction (independent, clean tree)

| Stage | Result |
|---|---|
| `npm ci` | exit 0 (lockfile) |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run typecheck` | 0 errors (strict; covers `src`+`tests` only) |
| `node scripts/verify-remediations.mjs` | **91 rows, 0 errors, 0 duplicate IDs**; 7 relevance WARNs (carried, benign) |
| `node scripts/verify-config.mjs` | PASS (tree scan + git check + JSONC parser) |
| `npm test` (run 1, first after `npm ci`) | **1 file failed** — `ledger-consistency.test.ts` at `seedMerchant` → `createDefaultChartOfAccounts` → D1 `UNIQUE constraint failed: op_ledger_accounts.merchant_id, code, currency`; totals: 1 failed / 30 passed, 266 passed / 3 skipped (269) |
| `npm test` (runs 2–5, incl. 3 with wiped `.wrangler` state) | **31/31 files, 269/269 tests, 0 skips, 7.5 s** — green |
| `npm run package` | exit 0; pre-flight battery re-runs inside (all green); archive + hand-off built and post-checked |
| `npm run package:handoff` | exit 0; per-entry forbidden battery clean; SHA-256 emitted |

Ledger distribution after this round: **82 FIXED / 4 PARTIAL / 5 OPEN** (91 total; arithmetic 77+5 new V10 FIXED rows checks). The workerd "hung request" uncaught-exception noise, which R9 noted as absent, reappeared intermittently (non-fatal).

The first-run failure is a genuine test-isolation flake: the default chart-of-accounts seeding races a shared D1 instance across parallel test files. It did not reproduce in four subsequent runs (including three with cold state), but a suite marketed as deterministic-"100% green" should not fail on a fresh clone's first run. → V11-007.

---

## 5. Archive & Packaging Verification

### 5.1 Shipped artifacts

- `dist/edgepay-cf-release.zip`: **3,982,923 B** — a 533% size increase over new-8's 628,880 B, driven by the four architecture diagram PNGs (3.5 MB, in allowed asset directories), the three frontend panels, and the growth of the staged tree to 258 files.
- `dist/edgepay-cf-clean-handoff.zip`: **byte-identical** to the release zip (same staging tree, same zip invocation) — the two channels have been unified into one artifact, which is one of the two designs Report 9 suggested.
- Entry arithmetic is now **exact and self-documenting**: 326 zip entries = 259 files (258 staged + 1 manifest) + 67 directory entries; `manifest_note` states precisely this.
- Leak sweep of the shipped release zip: no audit-report `.md` (numbered or unnumbered), no `docs/Archive/`, no `EdgePay API.json`, no real `.dev.vars` (only `.example`), no `companion-state.json` (only `.example`), no `frontend_reference/`, no node_modules, no dev-state directories. The only "audit"-named entries are legitimate runtime files (`ledger-audit.ts`, `audit-gate.yml`, `audit-poc-r4.test.ts`, `frontend-architecture.test.ts` references).

### 5.2 Clean-tree repack vs shipped — content-level full equality restored

Entry sets identical (326 = 326). **325/325 content files byte-identical**; the sole differing file is `release-manifest.json`, whose only field difference is the build `timestamp` (`00:35:02Z` shipped vs `00:54:00Z` mine). Report 9's regression (231/233 with stale embedded documents) is closed: the archive's embedded `TEST_RESULTS.md` now says 31/269, matching both the delivered tree and my reproduced battery. (The embedded ledger still disagrees on counts — V11-004 — but as a *documentation* defect, not an archive-staleness defect.)

### 5.3 Pollution experiments (V10-003 regression probes)

Planted at repo root, then `npm run package`:

| Planted file | Outcome |
|---|---|
| `invoice.pdf` (R9 leaker) | **Excluded** ✓ |
| `backup.zip` (R9 leaker) | **Excluded** ✓ |
| `video.mp4` (R9 leaker) | **Excluded** ✓ |
| `mystery.bin` (unknown binary class) | **Excluded** ✓ |
| `payload.xyz` (unknown text-ish class) | **Excluded** ✓ |

5/5 — the R8/R9 leak class is closed, and the filter now also catches unknown extensions (the allowlist's default-deny). The post-build verification was rewritten from whole-listing regex (which contained a dead `\.log\n` pattern that could never match) to per-entry matching with an explicit forbidden-binary set — a real strengthening, not a label change.

### 5.4 Hand-off channel (V10-001)

`scripts/package-handoff.mjs` chains the release packager (inheriting every gate), zips the verified staging tree, runs a per-entry forbidden battery (`.dev.vars`, state files, hidden dirs, audit reports, binaries), and emits a SHA-256. I ran it: clean output, correct exclusions. The tooling is real.

**But the hand-off I was actually sent is not that artifact.** `edgepay-cf-clean-new-9.zip` (25.5 MB, 695 entries) is an ad-hoc full-tree zip that still contains `edgepay-cf/.dev.vars` — 189 B, md5 `a2b02d291da90772e8ca2bbb61e5960f`, byte-identical to new-7/new-8 (dev-only values, rotated in R6). Sixth consecutive round. The V9-001 ledger row was reworded this round from "across all archive packaging" to "across all **release** archive packaging" (honest narrowing), and the new V10-001 row marks the hand-off pipeline FIXED — accurate for the script, inaccurate for the practice: the channel that has leaked the file six times is still being used by hand. → V11-001.

---

## 6. Code-Level Verification Details

### 6.1 V10-004 — PBKDF2 pin & universal wiring (`crypto.ts`, three call sites)

- `PBKDF2_ITERATIONS` (600,000), MIN/MAX bounds, and `getPbkdf2Iterations(env)` are now exported and **pinned by test**: `expect(PBKDF2_ITERATIONS).toBe(600_000)` plus default/override/out-of-bounds-fallback assertions — closing R9's "no test pins the default" exactly as prescribed.
- The env override is routed through the shared helper at all three hashing sites (`install.ts:138`, `bootstrap.ts:73`, `admin-api.ts:353`) — the "half-wired knob" is closed, and the helper's [10K, 2M] bounds replace `install.ts`'s old unbounded `Number(env)` parse.
- `verifyPassword` now rejects stored hashes with out-of-range cost (was: any ≥1). Legacy 50K hashes verify (in range); hashes written via the env override in [10K, 2M] verify. **No lockout regression.**
- Side change (declared only as "wiring"): AES key derivation gained a fallback chain (base64 → raw-text → SHA-256-derived 32 bytes). Round-trips deterministically; old 32-byte-base64 keys behave identically. Net effect: malformed key material silently becomes *usable* key material rather than failing — the fail-closed checks in `admin-api.ts` gate key *presence*, not validity. Minor hardening note only.

### 6.2 V10-005 — fail-closed claim encryption (`admin-api.ts`)

Write path: `ENCRYPTION_KEY` absent → **500 SECURITY_ERROR** (no provisioning); `encrypt()` throw → **500 ENCRYPTION_FAILED** with log. Read path: key absent → **500 CONFIG_ERROR**; decrypt throw → **400 DECRYPTION_FAILED** with `console.error` (observable); corrupt JSON → **400 CORRUPT_CLAIM_PAYLOAD`. The old plaintext-fallback and silent-catch are gone. One-time semantics preserved (KV delete before decrypt). The new integration test (`audit-poc-r4.test.ts:238–270`) does exactly what Report 9 prescribed: provision → assert the raw KV value is **not** `{`-prefixed (genuinely encrypted) → redeem as platform admin → assert field round-trip → assert KV deletion. This is the strongest close of the series on a P3.

### 6.3 V10-002 — version & count reconciliation

Versions: `package.json` 0.4.5, `frontend/package.json` 0.4.5, manifest `version` 0.4.5, `TEST_RESULTS.md` v0.4.5 — reconciled. Archive embeds current documents (§5.2). Residual: `docs/REMEDIATIONS.md` (and its archive-embedded copy) still says "**30 test suites, 263 tests**" and three sync-status rows repeat "263" while the tree, the battery, and TEST_RESULTS all say **31/269**. The remediation round for count-sync shipped with a count error — the same genre as V6-004/V7-004/V10-002, now in its fourth recurrence, root cause unchanged: counts are hand-maintained in parallel documents instead of stamped from a single source.

### 6.4 Multi-Worker frontend layer (the new ~1,500 lines)

**What is real and good:**

- Four independent, deployable Workers (`frontend/apps/{checkout,merchant,admin,hub}`) with per-app `wrangler.jsonc` (own names, assets binding, SPA fallback), Hono entrypoints, and a shared workspace manifest. This is the F1 blueprint's topology, implemented.
- `@edgepay/ui`: `tokens.css` (Sanzo Wada palette, WCAG-calibrated semantic states, MFS brand colors), `haptics.ts` (tap/select/success/error patterns, `vibrate` gated on support + `prefers-reduced-motion`), `motion.ts` (entrance stagger, SVG stroke-draw checkmark, KPI count-up — all budgeted and reduced-motion-gated), `icons.ts`. `@edgepay/gateway-brand`: bkash/nagad/rocket/upay metadata + TrxID validation regexes, consumed by real tests.
- Admin proxy implements the blueprint's non-negotiable correctly: real `fetch()` through the edge to the core with **Access service-token headers + platform admin bearer** injected server-side — no Service Binding bypass of the Access trust plane.
- Checkout worker is minimal by design (status polling proxy only, no credentials) — correct for an untrusted public plane.
- The served panels (`public/assets/{checkout,merchant,admin,design-system}/index.html`) are the auditor's F1 samples: merchant byte-identical, checkout 1 byte apart, design-system identical — GSAP pinned by **SRI hash**, haptic feedback, Sanzo Wada tokens throughout.
- `tests/frontend-architecture.test.ts` (7 cases) verifies the main worker serves each plane with tokens + nosniff, diagrams resolve as PNGs, and gateway-brand invariants hold.

**What is scaffolding or overstated:**

- The "Astro" claim: `src/pages/*.astro` exist but there is no `astro` dependency, no config, no build step; the pages' bodies are placeholders ("hydrates with interactive tables…" as a comment). The deployable payload is static HTML that did not come from these sources. The claim "Astro + Hono" describes an architecture *idiom* (islands, zero-framework runtime), not a build pipeline.
- The merchant BFF (`apps/merchant/src/index.ts`) is demo-grade with three genuine security defects — see V11-003.
- None of this code is linted, typechecked, or CI-gated — see V11-002; and the frontend battery tests only the **main worker's** static serving of the panels, not any of the four workers' own Hono behavior (no self-fetch tests for `/session/login`, `/api/proxy/*`, or the admin proxy).

### 6.5 Main-worker integration (`src/index.ts`)

New routes `/frontend` and `/frontend/:app` serve the panels from the ASSETS binding with 307/308 redirect following, `nosniff`, and `X-Frame-Options: DENY` — but **no CSP**, in a repo whose OpenAPI reference route already demonstrates the tailored-CSP pattern, and whose own frontend workers do ship CSP headers. All three planes' panels are therefore publicly enumerable on the main API worker's hostname. See V11-006.

### 6.6 Config regression (undeclared)

All three environment configs moved `compatibility_date` **backward**: `2026-08-28 → 2026-07-21`, matching the four frontend workers' date. No ledger row, no TEST_RESULTS mention, no commit note (the change is visible only in the tree diff). Backward compatibility-date moves change runtime semantics and are the config-level cousin of the undeclared-regression class this series has flagged twice before (V7-002, V8-002). If the motive was alignment with the new workers, say so in the ledger; if not, restore it. See V11-005.

---

## 7. New Findings

### V11-001 (P3) — Hand-off tooling built and verified, then not used; `.dev.vars` ships for the 6th consecutive round

**Evidence.** `edgepay-cf-clean-new-9.zip` contains `edgepay-cf/.dev.vars` (189 B, md5 `a2b02d29…`, byte-identical to new-7/new-8). `scripts/package-handoff.mjs` exists, runs clean, and its output (`dist/edgepay-cf-clean-handoff.zip`, verified per-entry) contains no `.dev.vars`. The V10-001 ledger row: `FIXED | scripts/package-handoff.mjs | "Automated script creates untainted external distribution archive."`

**Analysis.** The fix is real as tooling and fictional as practice. The channel that has now leaked the file six times (new-3/4/5/6/7/8/9) is the ad-hoc outer zip, and this round it was still made by hand — while the scripted, verified alternative sat unused in `dist/`. Confidentiality impact remains bounded (dev-only values rotated in R6), but the pattern is the series' most persistent honesty defect: a control is marked FIXED on the strength of its existence, not its adoption. The V9-001 row's rewording ("release archive packaging") is an honest narrowing — the first time — and is noted as an improvement.

**Fix.** Distribute the hand-off zip that `npm run package:handoff` produces. If the auditor needs dev-tree context (frontend sources, scripts, dist evidence), add a second scripted target (`package:audit`) that includes the tree minus secrets — one `zip -x` line. The outer zip should never again be typed by hand.

### V11-002 (P3) — The entire `frontend/` trust-plane layer is outside every quality gate

**Evidence.** `tsconfig.json` `include: ["src/**/*.ts", "tests/**/*.ts"]`; `lint` = `eslint src tests`; `audit-gate.yml` runs typecheck+lint+tests; `frontend/` (~1,500 lines across 4 workers + 2 packages) matches none of these. The frontend workspace's own `test` script (`npm run test --workspaces`) has no test targets — no app or package defines a `test` script. `verify-config.mjs` parses only the three root wrangler configs, not the four app configs.

**Analysis.** The code that now implements session issuance, credential staging, and API proxying — the highest-blast-radius surface introduced since the payment core — has no static analysis, no type checking, and no CI. `src/` earned 0/0 lint and strict tsc over ten rounds; `frontend/` ships unmeasured. `admin-api.ts`'s Bearer-injection and the BFF's session logic contain exactly the class of mistakes (fail-open catches, unbounded forwarding) that lint/type discipline surfaces.

**Fix.** Extend `tsconfig` include (or add `frontend/tsconfig.json` with the same strict flags), add `frontend` to the ESLint flat-config globs, add the four app wrangler configs to `verify-config.mjs`, and add at least one self-fetch test per worker (login fail-open, proxy auth, health).

### V11-003 (P3) — Merchant BFF: fail-open login, plaintext API-key sessions, demo-key proxy fallback

**Evidence.** `frontend/apps/merchant/src/index.ts`:
- Login (`:48-57`): the core validation `fetch` is wrapped in `try { if (!check.ok) return 401 } catch {}` — a network error (outage, DNS misconfig, wrong `API_ORIGIN`) **skips validation and issues a session** for any `op_live_*`-prefixed string, with no `ENVIRONMENT` guard on the fallback. Data exposure requires a valid key at proxy time, so impact is bounded to session issuance + KV staging of attacker-chosen strings, but the pattern is fail-open authentication in the round that closed fail-open encryption.
- Sessions (`:59-72`): the merchant API key is stored in KV as **plaintext JSON** (`sess:{uuid}` → `{"apiKey": …}`), TTL 7 days, cookie `Max-Age` 604800 — the V3-004/V10-005 genre (credentials at rest in KV) reintroduced in new code, one round after the core closed it.
- Proxy (`:91-97`): requests without a session are forwarded with `Authorization: Bearer op_live_demo_key` — an undocumented demo credential flowing to the production core; unauthenticated proxying also makes the worker an open relay for the core's GET surface.
- Identity is hardcoded (`merchantId: 1`, `merchantName: 'Metro Mart'`); no `__Host-` cookie prefix; no login rate limiting; CSP allows `unsafe-inline` scripts and unpinned `cdnjs` (the static panels themselves pin GSAP with SRI — the header policy does not require it).

**Analysis.** As shipped, this is a demo-quality BFF presented in TEST_RESULTS as the tenant-plane session pattern. None of it is exploited today (the apps are not deployed; the panels are static), but this repository's entire audit history is about not shipping the *next* incident's preconditions.

**Fix.** Fail the login on fetch error (401/502, no session); validate the key's merchant identity from the core response and store `{merchantId, merchantName}` (not the key) in the session, re-authenticating per request or storing the key AES-256-GCM-sealed; require a session for `/api/proxy/*` (drop the demo key); add `__Host-edgepay_sess`, login rate limit, and a CSP without `unsafe-inline`.

### V11-004 (P4) — Count-sync remediation desynced its own ledger (263/30 vs 269/31)

**Evidence.** `docs/REMEDIATIONS.md` (and its archive-embedded copy): "Test Automation Battery: 30 test suites, 263 tests"; rows EDGE-P1-009 / V5-009 / V6-004 / V7-004 all state "263" (one: "counts exact across artifacts (263 tests)"). Ground truth this round: **31 files / 269 tests** (TEST_RESULTS.md, my five runs, per-file grep). The V10-002 row claims "Reconciled version 0.4.5 and 263 tests" — the version reconciled; the count did not.

**Analysis.** Fourth recurrence of the count-drift genre. The pattern is stable: the ledger is edited by hand at a different moment than TEST_RESULTS, and no gate compares them. Every prior recurrence was rated P4 for the same reason as this one: zero production impact, direct hit on declaration credibility.

**Fix.** Make the packager stamp test counts (parse the vitest JSON reporter output, or count `it(`/`test(` occurrences) into the manifest, and have `verify-remediations.mjs` assert ledger == stamped count. One assertion ends this genre permanently.

### V11-005 (P4) — Undeclared backward `compatibility_date` regression in all three environment configs

**Evidence.** `wrangler.jsonc`, `wrangler.dev.jsonc`, `wrangler.staging.jsonc`: `2026-08-28 → 2026-07-21` (diff vs new-8; identical value in the four frontend app configs). No ledger row, no TEST_RESULTS mention.

**Analysis.** A backward compat-date move opts the Worker out of five weeks of runtime fixes and flag flips; it is also the config-level instance of the undeclared-change class (V7-002 telemetry comment, V8-002 binding regression) that this series keeps finding precisely because nothing declares it. The likely motive — aligning all seven configs at one date — is benign and fixable by declaration.

**Fix.** Restore `2026-08-28` for the three core configs (or add a ledger row stating the alignment rationale and the accepted runtime-delta). Add a `verify-config.mjs` assertion: `compatibility_date` ≥ the value declared in the ledger, so future silent moves fail the gate.

### V11-006 (P4) — New public `/frontend/*` HTML routes ship without CSP; admin/merchant panels enumerable on the main worker

**Evidence.** `src/index.ts:261-285` (`serveAssetDirect`): responses carry `nosniff` + `X-Frame-Options: DENY` only — no `Content-Security-Policy`. The repo's own precedents: JSON surfaces mount the nonce-CSP middleware; the OpenAPI reference route ships a tailored CSP. `/frontend`, `/frontend/checkout`, `/frontend/merchant`, `/frontend/admin` are all publicly reachable on the API worker's hostname.

**Analysis.** The panels are static, SRI-pinned, and carry no secrets — the immediate risk is low. But the main worker is the **checkout trust boundary**, and hanging the admin and merchant planes' UIs off it publicly trades the blueprint's core property (hostname-level plane isolation) for preview convenience. The blueprint's Phase-3 was Access-gated admin on its own hostname; this route family is a v0 preview surface that should either carry the tailored-CSP pattern or not expose the admin/merchant planes at all.

**Fix.** Apply the tailored-CSP pattern (self + SRI-required cdnjs) to `/frontend/*`; restrict `/frontend/{admin,merchant}` to authenticated origins or serve only checkout + design-system publicly; consider `Cache-Control` and `Referrer-Policy` on the route family for parity with the JSON surfaces.

### V11-007 (P4) — Test battery is not deterministic: first-run `ledger-consistency` failure (D1 UNIQUE constraint)

**Evidence.** Run 1 (immediately after `npm ci`, cold state): `tests/ledger-consistency.test.ts` failed at `seedMerchant → LedgerService.createDefaultChartOfAccounts` with `UNIQUE constraint failed: op_ledger_accounts.merchant_id, code, currency`; suite total 1 failed / 30 passed (266 passed / 3 skipped). Runs 2–5 (including three with wiped `.wrangler` state): 31/31, 269/269, 0 skips. The workerd "hung request" uncaught-exception noise, absent in R9's runs, reappeared intermittently.

**Analysis.** A ~20% observed flake rate on the exact suite whose greenness is the release gate's final step means the gate's verdict is partially load-bearing on ordering luck. The failure mode — default chart-of-accounts seeding racing parallel D1 access — is a classic isolation bug, cheap to fix and expensive to ignore (a flaky gate trains people to re-run instead of investigate).

**Fix.** Make `createDefaultChartOfAccounts` idempotent (`INSERT OR IGNORE` / exists-check), or ensure the per-test D1 fixture is unique per file; add a repeat-run smoke (e.g., `npm test` twice in CI) to surface flakes.

---

## 8. Carried / Open Items (status unchanged unless noted)

1. **Production JWT_SECRET rotation** — highest OPEN operational item; overdue across multiple rounds; not verifiable from hand-off artifacts.
2. **Live OpenAPI staleness** — re-fetched this round: still `v0.3.0`, 38 paths; `/api/admin/v1/merchants` (GET/POST), `/merchants/claim`, and merchant webhook registration (POST/GET/DELETE `/api/v1/webhooks`) remain implemented-but-unspecced. Now compounded: the new frontend consumes these exact undocumented routes via its proxies.
3. **CSRF middleware mount, `createIntent` unique constraint** — standing PARTIAL/OPEN ledger rows; untouched this round, honestly carried.
4. **Citation-relevance WARNs** — 7 notices persist (benign).
5. **V9-001 ledger row** — reworded honestly this round (scope now says "release archive packaging"); the underlying distribution behavior is V11-001.

---

## 9. Conclusion

Report 9's remediation round is **the best executed of the series on the code itself**: all five V10 findings were fixed at or above the prescribed strength — the allowlist inversion survives a widened pollution experiment, the claim envelope fails closed in both directions with its first real integration test, the PBKDF2 default is pinned and universally wired, versions reconciled, and the release archive returned to content-level full equality with a clean rebuild. The new frontend layer is a faithful materialization of the auditor's own blueprint at the topology level — four isolated workers, shared design system, Access-token-injecting admin proxy — and the served panels are the auditor's SRI-pinned, haptic, Sanzo-Wada samples.

The residual risk has moved, and moved tellingly: **from the money path to the edges** — to the hand-off channel that still carries `.dev.vars` past a brand-new gate built to stop exactly that (V11-001); to a new trust-plane layer that ships ungated, unlinted, with fail-open auth and plaintext sessions (V11-002/003); to the documentation count that desynced in the very round that claimed to reconcile it (V11-004); to an undeclared config regression and a CSP-less public route family (V11-005/006); and to a gate battery that is green only most of the time (V11-007). Each is small; none touches the payment core; together they describe a system whose center is now genuinely hardened and whose frontier is being built faster than it is being disciplined.

**Priority order for the next round:** (1) use the hand-off script for the hand-off — or script an audit-target variant; (2) bring `frontend/` under lint/typecheck/CI and fix the BFF's fail-open login, plaintext sessions, and demo key; (3) stamp test counts from a single source and assert them in the ledger gate; (4) make the ledger battery deterministic (idempotent chart-of-accounts seeding); (5) restore or declare the compatibility date; (6) CSP + plane-restriction on `/frontend/*`. Production JWT_SECRET rotation remains overdue regardless of code state.

---

*Verification artifacts retained at `/home/z/my-project/audit-r10/{new9-raw, run-tree}`; pollution-experiment archive and repack comparison under `audit-r10/run-tree/dist/` and `/tmp/r10-{ship,mine}`. Report 11 will verify this round's findings (V11-001…V11-007) against the next hand-off.*
