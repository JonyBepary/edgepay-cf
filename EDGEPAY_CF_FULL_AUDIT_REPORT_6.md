# EdgePay-CF — Full Independent Audit Report 6

**Round:** 6 (verification of "Report 5 Remediations & Quality Hardening" claims + architecture deep-dive)
**Artifact under audit:** `edgepay-cf-clean-new-5.zip` (md5 `ef8dda2f1cfd63e9852285cf862b5fd5`, 1,072,491 bytes, received 2026-09-02 18:44 UTC)
**Claimed snapshot:** commit `25b2701`, pushed to `main` + `master` (unverifiable from zip — no `.git` directory ships; standing caveat)
**Auditor methodology:** independent extraction → generation diffing (new-2/3/4/5) → file-level claim verification → adversarial gate experiments (positive + negative controls) → full pipeline reproduction (`npm ci`, lint, typecheck, both verify scripts, `npm test`, `npm run package`) → architecture analysis.

---

## Part I — Round 6 Verification of V6 Remediation Claims

### 1. Executive Summary

This is the strongest remediation round of the series on test engineering and the weakest on gate honesty. The code delivery itself is real and verifiable: the packaging gate script exists and runs a genuine five-step pre-flight; the dev secrets were actually rotated (all three, byte-diff confirmed); the simulator fallback fix, ledger row count (70), test count (250/250 green), and the new security-header assertions all reproduce exactly as claimed.

However, the **headline claim of this round is half-false, and it is the same half that carried the Round-5 headline finding**. The developer states step 6 of the gate ensures "zero `*-state.json` **or `.dev.vars`** exist in the distribution archive." Direct experiment falsifies the `.dev.vars` half: the release-tree scan contains no `.dev.vars` rule at all, `npm run package` prints "✓ Release tree verified clean" and exits 0 **with `.dev.vars` sitting in the scanned tree**, and the actually-distributed artifact (`edgepay-cf-clean-new-5.zip` itself) still contains `.dev.vars` carrying the freshly-rotated secrets. Additionally, the script never creates any archive — there is no zip, no dist directory, no manifest — so the manual zip hand-off (the exact channel that produced the Round-5 twin-zip credential leak) remains entirely outside the gate it claims to guard.

A second material finding: the **production `wrangler.jsonc` Analytics Engine binding has been commented back out** — an undeclared regression of the V5-002 fix that was independently verified as active in the previous generation — while the V5-002 ledger row still claims "active." The audit gate cannot catch this because its check is a raw string-include that matches commented-out lines. This is the second occurrence of the comment-vs-active blindness failure mode.

**Score: 12 of 17 verifiable claim components fully reproduce; 2 falsified; 3 overstated. New findings V7-001 (P1) through V7-005 (P4). One carried operational item remains open: production `JWT_SECRET` rotation.**

---

### 2. Claim-by-Claim Verification Matrix

| # | Developer claim | Verdict | Evidence (this round) |
|---|---|---|---|
| 1 | `package-release.mjs` created; `npm run package` script added | ✅ VERIFIED | `scripts/package-release.mjs` (68 lines, mtime 09-02 10:59); `package.json:27` `"package": "node scripts/package-release.mjs"` |
| 2 | Gate runs lint → typecheck → verify-remediations → verify-config → npm test, fail-fast | ✅ VERIFIED | `execSync(..., {stdio:'inherit'})` steps 1–5 inside try/catch → `process.exit(1)`; full pipeline reproduced (see §5) |
| 3 | Step 6 "ensuring zero `*-state.json` or `.dev.vars` exist in the distribution archive" | ❌ **FALSIFIED (V7-001)** | Scan checks only `companion-state.json` / `*-state.json`; **no `.dev.vars` rule exists**; gate passes with `.dev.vars` present; shipped zip contains `.dev.vars` |
| 4 | Dev secrets rotated with fresh 256-bit CSPRNG | ✅ VERIFIED | All 3 secrets byte-different vs new-4 (`8f9eb3f8…` → `8f6fda1a…` etc.); format valid (hex-256 / base64-32B); old values absent repo-wide |
| 5 | `verify-config.mjs` duplicate matching of `.companion-state.json` eliminated | ✅ VERIFIED | Single `isStateFile` boolean (line 23) — one error per file, no double-count |
| 6 | `smoke.test.ts` adds explicit security-header assertions | ✅ VERIFIED | `tests/smoke.test.ts:37-44` — nosniff/DENY/CSP asserted on `/api/v1/health`; discriminative (fails if headers stripped) |
| 7 | `smoke.test.ts` "verifying that telemetry data points are recorded safely" | ⚠️ OVERSTATED (V7-003) | Assertions are `not.toThrow()` only (lines 47–55); gutting `metric()`/`page()` bodies to empty functions passes the suite; no `writeDataPoint` call is ever asserted |
| 8 | `index.html` simulator default target → `localhost:8787` (R-3) | ✅ VERIFIED | `sms-phone-mockup/public/index.html:308` (option `selected`) + `:317` (input value); old default was production `workers.dev` URL (new-4 lines 320/330) |
| 9 | Ledger: 70 non-colliding rows with verified citations | ✅ PARTIAL | 70 rows, 0 duplicate IDs reproduced (58 FIXED / 4 PARTIAL / 8 OPEN); **V6-004 row itself says "248 tests synchronized" vs actual 250** (V7-004); R-3/R-4 have **no ledger rows** |
| 10 | TEST_RESULTS.md synchronized (29 files / 250 tests / 0 skips) | ✅ VERIFIED | Matches my independent run exactly (29/250, 100% green, 7.5s) |
| 11 | 250 tests, 100% green in workerd | ✅ VERIFIED | Reproduced: `Test Files 29 passed (29) / Tests 250 passed (250)` |
| 12 | lint 0 errors 0 warnings; typecheck 0 errors | ✅ VERIFIED | Reproduced both |
| 13 | V6-006 "All citations strictly verified" | ⚠️ OVERSTATED | 7 citation-relevance WARNs remain non-fatal (down from 9); the two R5 zero-coverage cases ARE now resolved (EDGE-P2-006 → `smoke.test.ts`; NEW-P2-004 → `audit-poc-r4.test.ts` PoC-5) |
| 14 | V6-005 PoC count normalized | ✅ VERIFIED (comment-level) | `audit-poc-r4.test.ts` header relabeled "15 test cases" → "14 test cases (covering 15 PoC scenarios)"; zero logic changes; now consistent with reality |
| 15 | "All changes committed and pushed (25b2701)" | ⛔ UNVERIFIABLE | No `.git` in zip; standing caveat (never shippable from zip evidence) |
| 16 | *(undeclared)* production Analytics Engine binding state | ❌ **REGRESSION (V7-002)** | `wrangler.jsonc:239-241` commented out in new-5; was ACTIVE in new-4; dev/staging remain active; V5-002 ledger row still claims "active" |
| 17 | *(undeclared)* companion relay endpoint expansion | ⚠️ NOTE (V7-005) | `server.js:499-515`: `/api/forward` now also answers `/api/relay/send` with `target_url`/`payload` aliases |

---

### 3. Detailed Findings (V7 series)

#### V7-001 (P1) — Release gate: `.dev.vars` blind spot, and the "package" never packages

**Claim under test:** "Strict release filesystem tree scan ensuring zero `*-state.json` or `.dev.vars` exist in the distribution archive."

**Evidence A — the scan has no `.dev.vars` rule.** `scripts/package-release.mjs:47-54` (and the mirrored logic in `verify-config.mjs:23`) flags exactly two patterns: `entry.includes('companion-state.json')` and `entry.endsWith('-state.json')`, both with an `.example` exemption. `.dev.vars` appears nowhere in the release-tree logic. The only `.dev.vars` check in the codebase is the *git-tracking* check (`verify-config.mjs:55`), which is inert in zip context — there is no `.git` in a distributed tree, and the catch block's own comment ("filesystem scan covers it") is factually wrong: the filesystem scan does not cover `.dev.vars`.

**Evidence B — direct experiment.** In a working tree containing `.dev.vars` (three live-format secrets):

```
$ npm run package
...
6. Checking Release Filesystem Hygiene...
✓ Release tree verified clean.
=== All Packaging Gates Passed Successfully ===
$ echo $?
0
```

**Evidence C — the shipped artifact still carries the file.** `edgepay-cf-clean-new-5.zip` contains `edgepay-cf/.dev.vars` (189 bytes, 3 secrets). The distribution channel itself therefore violates the developer's own stated invariant. Severity is materially reduced versus Round 5 because the secrets are freshly rotated (dev-only, never production signers — HMAC verification from the R5 forensics still holds for the new values: they cannot sign the previously leaked refresh token), but the *claim* is false, and the gate's stated coverage is narrower than advertised.

**Evidence D — negative control (gate is functional for the state-file class).** Planting `sms-phone-mockup/.companion-state.json` and `test-state.json` into the tree causes both verify-config (step 4) and the release scan to fail and abort the pipeline with `[FATAL]`. The gate works; it is simply not specified to cover `.dev.vars`. The twin-zip leak vector from R5 (V6-001) is closed for `*-state.json` and open for `.dev.vars`.

**Evidence E — no archive is ever created.** The script is named `package-release.mjs`, is invoked as `npm run package`, and its success message is "All Packaging Gates Passed" — but it produces **no zip, no `dist/` directory, no tarball, no manifest, and no checksums**. The unused imports `writeFileSync` and `createHash` (lines 6–7) are vestiges of an archive/manifest step that was never implemented. Consequently, whatever process actually produces the hand-off zips (`edgepay-cf-clean-new-*.zip`) is a **manual step outside the gate** — which is precisely the root cause identified in R5 V6-001. Until the gate creates (or at least verifies) the artifact it certifies, "release packaging gate" certifies a tree, not a release.

**Required remediation:**
1. Add `.dev.vars` (and `.dev.vars.*` variants) to both scan patterns; treat the comment at `verify-config.mjs:64` as a bug (it asserts coverage that does not exist).
2. Make the script actually produce the distribution artifact: build the archive from an explicit allowlist (or via `git archive`), run the scan **against the unpacked archive contents**, and emit a manifest with SHA-256 of the artifact. Then the audit can verify the artifact, not the promise.
3. Decide and document the policy: if `.dev.vars` is intentionally shipped for dev convenience, the claim language must change (say "working tree, not release archive"). The current claim text and the artifact contradict each other.

#### V7-002 (P2) — Undeclared regression: production Analytics Engine binding commented out again

`wrangler.jsonc:239-241` in new-5:

```jsonc
// "analytics_engine_datasets": [
//   { "binding": "ANALYTICS", "dataset": "edgepay_metrics" }
// ],
```

In new-4 (R5 round) this block was **active** — I verified it as the fix for V5-002/V4-002 and the ledger row `V5-002 | FIXED | analytics_engine_datasets active` still asserts that. Dev (`wrangler.dev.jsonc:116-118`) and staging (`wrangler.staging.jsonc:113-115`) remain active. This was **not declared** in the remediation message; the change surface between new-4 and new-5 shows no other wrangler change.

Operational impact: in production, `env.ANALYTICS` is undefined, so every `metric()`/`page()` call silently no-ops (fail-open by design in `src/lib/observability.ts`). The rate-limit fail-open telemetry, parse-miss metrics, and page-level events wired in earlier rounds are **dark in production right now**. If the dataset required dashboard enablement before deploy (the new comment suggests a deploy-time constraint), that is an operational fact to document — silently reverting a verified fix is not an acceptable channel for it.

Systemic aggravator: `verify-config.mjs:72` checks `raw.includes('analytics_engine_datasets')` — a raw string match that passes on **commented-out** lines. This is the same blindness that originally hid V4-002, and it has now allowed a verified fix to regress through the CI gate. The gate must parse the JSONC (strip comments) and assert the binding key exists in the parsed object.

Ledger impact: the V5-002 row's verification cell ("active") is now false against the shipped artifact — the second time a ledger row has been falsified by direct inspection (first: EDGE-P0-001 "Dev keys rotated" in R5).

#### V7-003 (P3) — Telemetry test does not verify recording, only non-throwing

`tests/smoke.test.ts:46-55` wraps `metric(...)`/`page(...)` calls in `expect(() => {...}).not.toThrow()`. This proves importability and callability, nothing more. The claim — "verifying that telemetry data points are **recorded** safely with graceful fallback" — requires asserting the write itself. Discriminative-power test: replace the body of `metric()` with `function metric() {}` — the suite still passes 250/250. Recommended fix (one test, ~10 lines):

```ts
it('metric() writes a datapoint when ANALYTICS is bound', () => {
  const writeDataPoint = vi.fn();
  const mockEnv = { ANALYTICS: { writeDataPoint }, ENVIRONMENT: 'test' } as unknown as Env;
  metric(mockEnv, 'test_event', { merchant_id: 1, duration_ms: 42 });
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  expect(writeDataPoint.mock.calls[0][0].indexes).toEqual(['1']);
});
```

Given that the production binding is currently dark (V7-002), the only layer that could detect the telemetry regression is exactly the layer this test does not cover.

#### V7-004 (P3) — Ledger self-inconsistency: the metrics-sync row carries a stale metric

The V6-004 row ("Documentation Metrics Sync") says "248 tests synchronized" — the count from the *previous* round. The actual and documented count is 250 (TEST_RESULTS.md is correct; my reproduction agrees). The row that exists to guarantee metric accuracy is itself inaccurate. Related provenance gaps: **R-3 and R-4 are remediated (per the message) but have no ledger rows** — the R-series IDs appear nowhere in `docs/REMEDIATIONS.md`. This repeats the V5-010 pattern (claims citing IDs the ledger does not track). Every remediation the developer announces should have a ledger row with an ID that exists in the audit's numbering; otherwise the verify-remediations gate's "70 rows" is a partial truth about the total claim surface.

#### V7-005 (P4) — Undeclared companion relay expansion

`sms-phone-mockup/server.js:499-515` (diff vs new-4): the forwarding relay now also answers `/api/relay/send` and accepts `target_url`/`payload` field aliases. Dev-tool only (not part of the Worker), but undeclared changes to an SSRF-relevant proxy surface belong in the remediation message. Recommend the relay validate target schemes/hosts rather than proxying arbitrary URLs, or clearly scope the companion as a trusted-network tool.

#### Carried / standing items (unchanged from R5, for the record)

- **JWT_SECRET production rotation — still OPEN (operational).** The artifact contains no evidence the production secret was rotated. The previously leaked mobile refresh token (exp 2026-10-01) must be presumed valid until rotation + token revocation is attested out-of-band. This remains the single highest-impact open action in the series.
- Honest-backlog OPEN rows remain open and truthful: csrf middleware still unmounted on HTML routes, claim tokens still plaintext in KV, `createIntent` uniqueness still unconstrained at the D1 level.
- workerd `Worker's code had hung` uncaught-exception noise still appears around `REFUND_GATEWAY_FAILED` page events during the refund-failure tests; all 250 tests remain green; classified (R5) as teardown artifacts. Non-blocking; keep watching.

---

### 4. What Genuinely Improved This Round

Credit where due, because this round's engineering delta is real: the pre-flight pipeline is now a single auditable command with correct fail-fast semantics; the secrets are truly rotated with correct entropy and format; the twin-zip vector for `*-state.json` is closed (verified by negative control); the simulator no longer points its default at production (an R-series ask finally landed); the two specific zero-coverage citations from R5 were resolved with real, discriminative tests in the header case; and the PoC count language now matches reality. The 248→250 test delta is exactly accounted for by the two new smoke tests. Nothing in the change surface touched `src/` money-path code — appropriate for an infra-hardening round.

### 5. Independent Pipeline Reproduction Log

```
npm ci                          → 142 top-level packages, clean
npm run lint                    → ESLint: 0 errors, 0 warnings
npm run typecheck               → tsc --noEmit: 0 errors
node scripts/verify-remediations.mjs
                                → 70 rows checked, 0 errors, 0 duplicate IDs
                                  (7 citation-relevance WARNs, non-fatal)
node scripts/verify-config.mjs  → PASS (while .dev.vars present in tree — see V7-001)
npm test                        → Test Files 29 passed (29)
                                  Tests      250 passed (250) — 7.5s, workerd
npm run package                 → all 6 steps green, exit 0
                                   (with .dev.vars present; no artifact created)
Negative control (planted state files) → [FAIL] both files, [FATAL] abort ✓
```

---

## Part II — Deep Analysis: What Should Be an HTTP API, What Should Be a Service Binding, What Should Be Workers RPC

> Scope request (developer): "Deep analysis on what service should be API and what service binding or worker RPC."
> Method: inventory every EdgePay call path in the shipped code, classify each against the communication primitives Cloudflare Workers actually offers, and produce a target topology with a migration path that the existing test suite can survive.

### 6. Primer — The Communication Planes Available on Cloudflare Workers

EdgePay today runs as **one Worker** (`edgepay-cf`) plus an off-platform Node dev tool (`sms-phone-mockup`). Before deciding what should move where, it pays to be precise about the four planes on which two pieces of code can talk on this platform:

**Plane 1 — Public HTTP API (the `fetch` handler).** The only plane reachable from the open internet. Every caller EdgePay cannot vouch for — merchant backends, PSP callback servers, mobile companion devices, checkout browsers, the install wizard, infra health probes — must enter here. Properties: full HTTP semantics (auth headers, CORS, CSP, rate limiting, request/response streaming), 128 KB middleware enforcement, OWASP header stack, per-route middleware. Costs: every public route is attack surface; requires authn/authz at the edge of the system.

**Plane 2 — Service Bindings (`env.SERVICE.fetch(...)`).** A private, addressable reference from one Worker to another Worker *as if it were HTTP*. Properties: calls traverse Cloudflare's internal network — typically same-POP, no public-internet round trip, no DNS/TLS handshake; the callee sees no public hostname, so a service-bound worker is invisible to the internet unless it also exposes routes; caller authenticates by possession of the binding (no API keys needed). Costs: each call is a subrequest against the caller's budget; you inherit HTTP-shaped ergonomics (build a `Request`, parse a `Response`) even for what is conceptually a function call.

**Plane 3 — Workers RPC (`env.SERVICE.someMethod(args)`).** JS-native method calls *over a service binding*. The callee exports a default object (and/or named entries); the caller invokes typed methods directly. Properties: structured-clone arguments and return values (objects, arrays, numbers — no manual `JSON.stringify`); thrown errors propagate as rejections; same private routing and subrequest accounting as Plane 2; TypeScript contracts are generatable from the deployed worker (remote-bindings typegen), so the boundary can be as type-safe as an in-process import. Limits: ~1 MiB per serialized argument/return value (verified against CF docs; larger payloads should travel via R2/Streams, not RPC args); still counts against the subrequest budget; no HTTP middleware semantics (auth/observability must be done in the method or via wrappers).

**Plane 4 — the primitives EdgePay already uses correctly, which are *not* service bindings:**
- **Durable Objects RPC** (`env.LEDGER_DO.idFromName(...).postTransaction(...)`) — chosen for *consistency*, not communication: one DO per merchant serializes the entire chart-of-accounts posting. A DO is a consistency boundary; wrapping it in a service binding would add a hop without adding a boundary.
- **Queues** (`SMS_QUEUE`, `WEBHOOK_QUEUE`, `EMAIL_QUEUE` producers + consumers + DLQs) — chosen for *decoupled async*: at-least-once delivery, retry with backoff, batch amortization. An RPC is synchronous; anything that must survive a crash mid-flight belongs on a queue, not on a binding.
- **Workflows** (`REFUND_WORKFLOW.create({id, params})`, `SWEEP_WORKFLOW`) — chosen for *multi-step sagas with durable state*: refund reconciliation's bounded poll loop and the daily sweep are exactly the "retry for up to 24h, then halt in a visible terminal state" shape Workflows exist for.
- **Cron** (`*/5`, hourly, daily) — time-triggered entry points.
- *(Completeness: Dispatch Namespaces / Workers for Platforms — running customer-*supplied* code at scale — is the fourth binding flavor. EdgePay is self-hosted single-tenant; not applicable today.)*

The three decision-relevant planes for this analysis are therefore: **public HTTP for untrusted callers, Workers RPC for trusted internal cross-worker calls, and service-binding `fetch` only when HTTP semantics are themselves the contract.** A useful shorthand: *RPC for functions, service-binding fetch for HTTP contracts, public API for the world.*

### 7. Decision Framework — Nine Axes

For each EdgePay component, score the boundary along these axes; boundaries earn their cost only where at least two axes genuinely diverge from the core:

| Axis | Favors public HTTP | Favors binding/RPC extraction | Favors staying in-process |
|---|---|---|---|
| **Trust** | Caller is off-platform / untrusted | Both sides internal & trusted | Same trust domain already |
| **Churn cadence** | Stable surface, versioned externally | High-frequency deploys (adapter fixes) isolated from stable money core | Shared cadence with core |
| **Blast radius** | — | Bug class isolated (parse crash can't cycle the payment worker) | Small, well-tested code |
| **Secret custody** | — | Secrets compartmentalized per worker (fewer people/code paths see them) | Single key holder acceptable |
| **Latency budget** | Network anyway | Same-POP hop (~ms) affordable; no chains | Money path wants zero extra hops |
| **Resource budgets** | — | Separate subrequest/CPU pools (e.g. outbound fan-out) | Shared pool sufficient |
| **Contract evolution** | Public versioning pain | Typed RPC surface, versioned entrypoints | Compile-time types already |
| **Observability** | Needs per-route middleware | Per-worker logs/traces/metrics | Already instrumented in-core |
| **Testability** | Black-box via SELF | Mock the binding in vitest, or self-bind | In-process is cheapest (current suite) |

**Anti-principle (the one that matters most for EdgePay): do not draw boundaries along service seams; draw them where churn, trust, or failure behavior diverge.** A payment gateway's `payment → refund → ledger` spine is one cohesive money path; splitting it into microservices would purchase deployment ceremony at the price of distributed-transaction reasoning the LedgerDO was specifically designed to avoid.

### 8. Current-State Inventory — Every Call Path in Shipped Code

```
merchant backend ──HTTP──▶ /api/v1/* (Hono)                    [Plane 1]
PSP servers     ──HTTP──▶ /webhook/*  (Hono)                    [Plane 1]
companion app   ──HTTP──▶ /api/mobile/v1/sms ──▶ SMS_QUEUE      [Plane 1 → Queue]
admin (CF Access) ─HTTP──▶ /api/admin/v1/*                      [Plane 1]
browsers        ──HTTP──▶ /checkout /pay /invoice, /assets/*    [Plane 1 + Assets]

in-process (same isolate):
  controllers ──imports──▶ services (payment, refund, …)
  payment/refund ──▶ gatewayRegistry.resolve(slug) ──▶ adapter ──fetch──▶ PSP   [outbound HTTP]
  mobile.ts ──▶ SMS_QUEUE.send (producer)
  cron/handler ──▶ reconciliation, expiry, currency jobs

async/background:
  sms-parse consumer   ──▶ sms-corroboration ──▶ LedgerDO ──▶ complete tx
  webhook-out consumer ──fetch──▶ merchant endpoints (SSRF-guarded, signed)
  email-out consumer   ──▶ outbound mail
  REFUND_WORKFLOW / SWEEP_WORKFLOW ──▶ polling, replay, re-drive

consistency:
  services ──DO RPC──▶ LedgerDO (postTransaction / trialBalance / …)
```

Notably: **zero service bindings exist today** (`"services"` key absent from all three wrangler configs). Every internal boundary is either an import, a queue, a workflow, or the DO. That is a legitimate v1 architecture — and it is worth stating plainly that at the current scale (~5K tx/day, DO free tier 100K requests/day per the config's own math) nothing here *needs* to split. The question is where the first boundary will pay for itself when it does.

### 9. The Verdict Table — Component by Component

| # | Component | Today | Verdict | Rationale (axes that fire) |
|---|---|---|---|---|
| 1 | `/api/v1/*` merchant REST | HTTP | **KEEP public HTTP API** | Untrusted external callers; auth, CORS, rate limits, 128 KB cap, OWASP headers are the product surface. Cannot be a binding — merchants are off-platform |
| 2 | `/api/mobile/v1/*` (pair, SMS ingest, heartbeat, dashboard) | HTTP + JWT | **KEEP public HTTP API** | Companion devices are off-platform; OTP pairing rate-limits; ingest is deliberately `202 queued` decoupled already |
| 3 | `/api/admin/v1/*` | HTTP + CF Access | **KEEP public HTTP API** | SSO humans; JWKS verification; page on break-glass use |
| 4 | `/webhook/*` PSP callbacks | HTTP | **KEEP public HTTP API** | PSPs call you; per-gateway signature verification; amount binding |
| 5 | `/checkout /pay /invoice` + assets | HTTP + Assets binding | **KEEP public HTTP** | Browsers; zero-subrequest static serving already correct |
| 6 | `/install`, `/api/v1/health`, api-reference | HTTP | **KEEP public HTTP** | Bootstrap + probes + docs |
| 7 | **Gateway adapters (15+ PSPs, `src/gateways/*`, catalog `generated/`, `planned/`)** | in-process modules behind `gatewayRegistry` | **EXTRACT → dedicated `edgepay-connectors` Worker, reached via Service Binding + Workers RPC** (the flagship recommendation — §10) | Churn (highest-deploy-frequency code in the repo), blast radius (adapter bug cannot cycle money-path worker), secret custody option (PSP credentials decrypt only in connectors), canary per gateway slug via the existing registry seam |
| 8 | **SMS parse + corroboration + Workers AI fallback** | queue consumer in-process | **PHASE 2 → `edgepay-parser` Worker reached via RPC from the consumer** (conditional) | CPU axis (AI-bound long-tail parsing), failure isolation (untrusted text parsing), keeps AI binding + its timeouts out of the core worker; below ~1 msg/s keep in-process |
| 9 | Webhook outbound delivery | queue consumer (SSRF-guarded fetch) | **KEEP for now; extract `edgepay-dispatch` Worker only at volume** | Queue already isolates retries/DLQ; extraction pays when per-tenant fan-out needs its own subrequest pool or delivery-domain reputation |
| 10 | LedgerDO posting engine | DO RPC | **KEEP exactly as is — never a service binding** | It is the atomicity boundary (single serialized writer per merchant). Any interposed worker between payment service and DO adds a hop and buys nothing |
| 11 | Refund/recon orchestration | Workflows | **KEEP Workflows** | Durable sagas; a binding would downgrade this to request-scoped RPC |
| 12 | Cron jobs (expiry, currency, sweep) | `scheduled` in core | **KEEP in core** (ownership follows the data; sweep already delegates to a Workflow) | No isolation need; cron triggers are per-account limited (3 used of 5 free) |
| 13 | Money-path services (payment, refund, validation, auth, domain routing) | in-process | **KEEP in-process — do not split** | Zero-latency spine; LedgerDO already provides the consistency boundary; splitting = distributed-transaction risk |
| 14 | `sms-phone-mockup` companion | external Node app | **Always public HTTP client, never a binding** | Runs off-platform by definition; that's why R-3's localhost default matters |
| 15 | Telemetry (`metric()`/`page()`) | AE binding (prod currently dark — V7-002) | **Binding, not worker** | Data-plane only; requires the prod binding re-enabled, which the audit gate must then assert as *parsed-active*, not string-present |
| 16 | Email sending | queue consumer | **KEEP queue** | Async, retry-shaped |
| 17 | Static assets / OpenAPI reference | Assets binding / HTTP | **KEEP** | Zero-subrequest path already optimal |

### 10. Deep Dive — The Connectors Worker (Recommendation #7, in full)

This is the one extraction that clears the framework on multiple axes simultaneously, and EdgePay's existing code is unusually well prepared for it — the `gatewayRegistry` factory seam that the R5 refund-ordering tests proved real (`spy` on `resolve`) is *exactly* the seam an RPC client needs.

**10.1 Target topology**

```
                    ┌────────────────────────────────────────────┐
 merchants / PSPs   │  edgepay-cf  (core Worker — money path)    │
 ──public HTTP──▶   │  Hono routes · auth · 128KB cap · ledger   │
                    │  DO RPC ──▶ LedgerDO · Queues · Workflows  │
                    └──────────────┬─────────────────────────────┘
                                   │ Service Binding "GATEWAYS"
                                   │ Workers RPC (same-POP, private)
                                   ▼
                    ┌────────────────────────────────────────────┐
                    │  edgepay-connectors  (adapter Worker)      │
                    │  initiatePayment / verifyPayment /         │
                    │  issueRefund / parseWebhook / health       │
                    │  15+ adapters · catalog · generated/planned│
                    │  outbound fetch ──▶ PSP APIs               │
                    └────────────────────────────────────────────┘
```

**10.2 The RPC facade (named entrypoints, versioned)**

```ts
// edgepay-connectors/src/index.ts
export default {
  async health(): Promise<{ ok: true; adapters: string[] }> { … },

  async initiatePayment(req: InitiateRequest): Promise<InitiateResult> { … },
  // req: { slug, amount_minor, currency, credentials, order_ref, callback_url, return_url }
  // InitiateResult is the EXISTING src/gateways/base.ts InitiateResult shape —
  // the facade deliberately re-uses the current adapter contract so the
  // core-side adapter is a pure transport swap.

  async verifyPayment(req: VerifyRequest): Promise<VerifyResult> { … },
  async issueRefund(req: RefundRequest): Promise<RefundResult> { … },
  async parseWebhook(req: { slug, headers, raw_body_b64 }): Promise<ParsedWebhook> { … },
};

export const v2 = {  // parallel entrypoint during migration — both live at once
  async initiatePayment(req: InitiateRequestV2): Promise<InitiateResult> { … },
};
```

Core side — the migration is a registry-level swap, invisible to the payment service:

```ts
// edgepay-cf: RpcGatewayAdapter implements the SAME GatewayAdapter interface
export class RpcGatewayAdapter implements GatewayAdapter {
  constructor(private slug: string, private rpc: ConnectorsRpc) {}
  async initiate(params: InitiateParams, cred: Credentials, ctx?: GatewayContext) {
    return this.rpc.initiatePayment({ slug: this.slug, credentials: cred, … });
  }
  // verify / refund / parseWebhook likewise
}

// registration: canary per slug — migrate 'rocket' first, watch a week, proceed
for (const slug of env.RPC_GATEWAY_SLUGS?.split(',') ?? []) {
  gatewayRegistry.register(slug, () => new RpcGatewayAdapter(slug, env.GATEWAYS));
}
```

Because every adapter already implements one tiny interface with no optional methods (base.ts), and `ENABLED_GATEWAYS` already gates adapter availability platform-side, the canary surface is already plumbed. The two wrangler configs:

```jsonc
// edgepay-cf/wrangler.jsonc
"services": [
  { "binding": "GATEWAYS", "service": "edgepay-connectors", "remote": true }
]
// edgepay-connectors/wrangler.jsonc — NO smart placement (backends are
// external PSP APIs; placement optimization targets CF-internal backends
// like D1 — default placement keeps it near the calling core worker).
```

**10.3 Credential custody — the one real design decision**

Today: PSP credentials are AES-256-GCM encrypted in D1 (`ENCRYPTION_KEY`); the core payment service decrypts and passes plaintext to the adapter. Two options at the boundary:

- **Option A (phase 1): pass decrypted credentials in the RPC args.** Simplest; binding traffic never leaves Cloudflare's internal network (same POP, no public hop), so exposure is the connectors worker's memory/logs. Document the trust assumption: the RPC surface is private-by-default — do NOT later add a public route to connectors.
- **Option B (target): credential-by-reference.** Core passes `{ credential_id }`; connectors holds `ENCRYPTION_KEY` + D1 read access and decrypts at the last hop. Core loses plaintext custody entirely (least privilege — the money-path worker can no longer exfiltrate PSP secrets even if compromised). Cost: key custody splits across two workers (rotation procedure must cover both), and D1 is queried from two workers (row-billing is per query regardless of which worker issues it).

Recommendation: A to start, B before any third party gets code into either worker. Both are auditable; what is *not* acceptable is passing credentials as query strings on a service-binding **fetch** — if you use HTTP semantics, they land in logs.

**10.4 Why RPC and not service-binding `fetch` here**

The adapter contract is a function call (`initiate(params) → result`), not an HTTP resource. Using Plane 2 would mean: minting internal URLs, hand-serializing bodies, mapping typed `PostingResult`-style unions through status codes, and re-implementing error taxonomy on both sides of the line. Plane 3 gives structured-clone of the existing result objects, exceptions as rejections, and — via remote-bindings typegen — a generated `ConnectorsRpc` type so a facade contract change fails the core worker's `typecheck` at build time. Reserve Plane 2 for the case where connectors must also serve HTTP-shaped consumers (e.g. a debug dashboard), which can coexist: one worker, both entry styles.

**10.5 Budget check (per payment lifecycle, paid plan: 1000 subrequests; free: 50)**

- initiate: 1 RPC hop + 1 PSP fetch = 2 subrequests (+0 for D1/DO — bound resources, not subrequests)
- webhook verify+capture: ~1 + ledger DO post (DO request, separately metered) + queue send
- refund: reserve (D1) + 1 RPC + 1 PSP fetch = ~3
- Worst realistic path (payment + webhook + refund + sweep re-drive): well under 20. The +1-per-hop cost of the binding is noise here — which is exactly why the rule is *no chains of bindings* (a→b→c doubles latency and burns budget linearly) rather than *no bindings*.

**10.6 Keeping the 250-test suite green through the migration**

`@cloudflare/vitest-plugin` runs the suite inside workerd against real bindings. Two options, both already compatible with the current config:
1. **Self-binding in tests:** map `GATEWAYS` to the same test worker (miniflare `serviceBindings` supports this) and export a test-only connectors entry; integration tests then exercise the real RPC path end-to-end.
2. **Spy at the facade seam:** unit tests spy `env.GATEWAYS.initiatePayment` exactly the way `refund-ordering.test.ts` spies `gatewayRegistry.resolve` — the R5 round already proved this test pattern works at a factory seam.
Either way the migration lands with the gate green, per-slug canary order, and rollback = one registry line.

### 11. Deep Dive — Parser Worker (Phase 2) and Dispatch Worker (Conditional)

**Parser (`edgepay-parser`).** Trigger: SMS volume where AI-fallback latency or CPU share starts affecting the `sms-parse` consumer's batch window (currently 50 msgs / 10s), or the desire to bind Workers AI only in a worker that never touches money state. Shape: the consumer (or directly the ingest route for sync low-latency parsing) calls `env.PARSER.parse({ sender, body, received_at })` via RPC; parser returns the existing `SmsExtraction` union. Keep the corroboration *matching* logic in the consumer — it needs D1 order context — only the text→structure extraction moves. This also quarantines the single most adversarial input class in the system (attacker-crafted SMS bodies).

**Dispatch (`edgepay-dispatch`).** Trigger: per-tenant webhook fan-out where a single payment's delivery burst consumes a disproportionate share of the consumer's subrequest pool, or the need for delivery-domain reputation management (dedicated egress identity, per-tenant signing key rotation cadence). Shape: consumer stays the retry/DLQ brain; the actual `fetch` moves into the dispatch worker via RPC (`env.DISPATCH.deliver(signed_payload)`) purely to borrow its subrequest budget. Until either trigger fires, the current queue-consumer design is correct — extraction now would be ceremony.

### 12. What Must Never Move (and why — this is half the answer)

1. **The LedgerDO stays the only writer, called by RPC, from the core.** Its per-merchant serialization is the system's atomicity guarantee. A service binding between payment service and DO adds latency and a failure mode while weakening nothing an attacker cares about and strengthening nothing the ledger needs.
2. **The money path (`payment`, `refund`, `ledger` services + validation + auth middleware) stays in-process in the core worker.** Reserve-then-call, idempotency-key scoping, double-entry posting — these are one transactional spine; the codebase's own DO design notes ("per-account DOs solve a contention problem this system does not have") apply equally to per-service workers.
3. **External-facing surfaces stay public HTTP** — for the boring reason that off-platform callers cannot hold bindings. This includes the companion mockup, which is *also* the reason its default target must remain localhost (R-3, verified this round).
4. **Queues stay queues; Workflows stay Workflows.** An RPC is synchronous and request-scoped; "retry for 24h across instance restarts" is not a function call.

### 13. Risks, Limits, and Anti-Patterns

- **RPC argument cap:** ~1 MiB serialized per argument/return. Payment payloads are KB-scale (the 128 KB request cap upstream guarantees it) — but if a future reconciliation payload wants to ship a full day's journal, hand it via R2 key, not RPC args.
- **Subrequest accounting:** every binding fetch/RPC call counts against the caller's budget (50 free / 1000 paid). Budget above shows comfortable headroom; re-check if a single request ever needs >10 adapter calls.
- **Binding chains:** core→connectors→sub-connector designs double latency and halve debuggability. One hop, one worker, typed facade. If connectors needs shared logic, ship it as a package, not a third worker.
- **Contract drift:** the moment connectors' facade types and core's expectations diverge, deploys fail at runtime, not compile time — *unless* typegen is wired. Make `wrangler types` (remote bindings) part of the core's CI typecheck, exactly like `tsc --noEmit` is today.
- **Two-repo/two-config operational cost:** two wrangler configs, two CI jobs, two deploy targets, one shared audit gate — and note the audit lesson of this round (V7-002): the packaging/verify gates must then parse and assert bindings across **all workers' configs**, not string-match one file. A comment-blinded gate is how a verified fix silently regresses.
- **Premature decomposition:** every extraction before its trigger fires is pure cost. At ~5K tx/day the correct number of workers is one; the connectors split is justified by churn/isolation (it can be done first and incrementally), the parser and dispatch splits are explicitly deferred to their triggers.
- **Testing discipline:** after extraction, self-bindings or facade spies are mandatory in CI — an untested boundary is worse than no boundary, because it fails only in production where the subrequest budget and the real RPC serialization actually live.

### 14. Roadmap (ranked, with acceptance criteria)

| Phase | Action | Acceptance criteria |
|---|---|---|
| 0 | Fix V7-001/V7-002 gate gaps (`.dev.vars` rule; JSONC-parsed binding assertions; gate builds & scans the actual artifact) | Negative controls fail closed for `.dev.vars` and commented-out bindings; shipped zip provably gate-produced |
| 1 | Extract `edgepay-connectors` behind `GATEWAYS` RPC; canary `rocket` → all 10 hand-ported, then generated adapters | Core `typecheck` fails on facade drift (typegen wired); 250-test suite green via self-binding; per-slug rollback demonstrated; PSP creds flow per Option A documented |
| 2 | Credential-by-reference (Option B); `edgepay-parser` when AI/CPU trigger fires | Core no longer holds `ENCRYPTION_KEY`-decrypted PSP plaintext; parser RPC latency p99 < in-process baseline + 5ms |
| 3 | `edgepay-dispatch` at webhook volume trigger | Consumer subrequest pool headroom restored to >80% at peak |

### 15. One-Paragraph Answer (TL;DR)

Everything with an off-platform caller — merchant REST, mobile companion, admin, PSP webhooks, checkout, install, health, docs — **stays a public HTTP API, full stop; bindings are invisible to the internet by design.** The LedgerDO stays a Durable Object called by RPC because it is the atomicity boundary, queues and workflows stay queues and workflows because retry-sagas are not function calls. The one boundary worth building today is **`edgepay-connectors`, reached by Service Binding + Workers RPC (not fetch)**, because the 15+ gateway adapters are the repo's highest-churn, secret-touching, blast-radius-prone code and the existing `gatewayRegistry` factory seam already provides the canary hook; extract the SMS parser (phase 2) and webhook dispatcher (phase 3) only when their triggers fire. Use service-binding `fetch` instead of RPC only where HTTP semantics are the actual contract; never chain bindings; wire remote-binding typegen into CI so the typed facade cannot drift silently; and let the packaging gate parse — not string-match — every worker's config, so the V7-002 class of regression can never ship quietly again.

---

## Appendix — Round 6 Evidence Register

| Evidence | Value |
|---|---|
| Artifact md5 | `ef8dda2f1cfd63e9852285cf862b5fd5` |
| new-4 → new-5 changed files | 12 (`.dev.vars`, `TEST_RESULTS.md`, `docs/REMEDIATIONS.md`, `package.json`, `scripts/package-release.mjs` (new), `scripts/verify-config.mjs`, mockup `app.js`/`index.html`/`style.css`/`server.js`, `tests/audit-poc-r4.test.ts`, `tests/smoke.test.ts`, `wrangler.jsonc`) — no `src/` changes |
| `.dev.vars` in shipped zip | present (189 B) — V7-001 |
| `.companion-state.json` in shipped zip | absent (only `.example`) — twin-zip vector closed |
| Secrets rotated | 3/3 (byte-diff verified vs new-4) |
| Prod analytics binding | commented out (new-4: active) — V7-002 |
| Ledger | 70 rows, 0 dup IDs, 58 FIXED / 4 PARTIAL / 8 OPEN; V6-004 row says "248" (actual 250) — V7-004; R-3/R-4 rows absent |
| Tests reproduced | 29 files / 250 tests / 100% green / 7.5s |
| `npm run package` with `.dev.vars` present | exit 0, "Release tree verified clean" — V7-001 |
| Negative control (planted `*-state.json`) | FAIL ×2, pipeline aborts — gate functional for state class |
| New findings | V7-001 (P1), V7-002 (P2), V7-003 (P3), V7-004 (P3), V7-005 (P4) |
| Carried open | Production `JWT_SECRET` rotation (operational); checkout nonce-CSP; plaintext claim tokens in KV; `createIntent` uniqueness |

*Independent audit, Round 6. All experiments reproducible from the artifact md5 above; scripts retained at `/home/z/my-project/scripts/r6-ledger-count.mjs` and pipeline logs in the work log.*
