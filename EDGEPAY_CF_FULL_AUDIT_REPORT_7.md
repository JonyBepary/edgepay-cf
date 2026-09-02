# EdgePay-CF — Full Independent Audit Report 7

**Round:** 7 (verification of "Report 6 Remediations & Engineering Upgrades" claims)
**Artifact under audit:** `edgepay-cf-clean-new-6.zip` (md5 `e704119586595c50d2f8a275eaf54e71`, 3,385,405 bytes, received 2026-09-02 20:15 UTC)
**Claimed snapshot:** commit `1382718`, pushed to `main` + `master` (unverifiable from zip — no `.git`; standing caveat)
**Auditor methodology:** independent extraction → generation diff (new-5 → new-6) → claim-by-claim code verification → **live re-packaging of the release archive in a clean tree** → planted-file pollution experiments → JSONC parser negative controls (dev config AND production config) → forensic inspection of staged dev-state artifacts (SQLite dump, VLM screenshot analysis) → full pipeline reproduction.

---

## Part I — Round 7 Verification of V7 Remediation Claims

### 1. Executive Summary

This round closes the letter of V7-001 and leaves its spirit half-open. The core engineering is now genuinely good: the packaging gate **really builds an archive** (SHA-256 manifest, per-file hashes, `zip -r`, `unzip -l` verification), the **`.dev.vars` exclusion is real** (my independent clean re-packaging excluded it — direct experimental confirmation of the fix the previous round falsified), the **shipped release archive is byte-identical to the claimed SHA-256** (`38e4b241…`, 1,141,250 bytes), the telemetry tests are now **properly discriminating** (`vi.fn()` spies with exact argument-shape assertions — exactly the remediation Report 6 specified), the relay protocol validation is real, and the ledger grew honestly (77 rows, R-3/R-4/V7 rows added, and — notably — the V5-002 row was **voluntarily downgraded FIXED → PARTIAL**, an act of ledger honesty this series has not seen before).

However, two new material findings offset that progress:

**V8-001 (P2): the "clean" release archive ships dev-machine state.** The staging denylist contains six entries (`node_modules`, `.git`, `.dist`, `coverage`, `.system_generated`, `.DS_Store`) but omits the dev-state directories that actually exist on the build machine: `.wrangler/` (9 miniflare test-run SQLite files), `.opencode/` (4 files, including a 25.5 KB gnome-screenshot clipboard PNG from the developer's AI-session), and `.slim/`. Arithmetic proof: the shipped archive's 253 manifest files = my clean re-packaging's 240 files + exactly those 13 dev-state files. Experimental proof: planting a fake `.wrangler/state/test.sqlite` and `.opencode/images/clipboard-fake.png` in my tree and re-running `npm run package` lands both in the "clean" archive. The SQLite was an empty stub and the screenshot (VLM-analyzed) contains no secrets — this is hygiene pollution, not a credential leak — but a payment gateway's signed release artifact carrying the developer's clipboard and test databases is categorically wrong, and the denylist design guarantees recurrence for the next tool that leaves a dot-directory behind.

**V8-002 (P2): the production config is explicitly exempted from the new binding check.** The V7-002 regression — production `analytics_engine_datasets` commented out — is **not fixed**: production `wrangler.jsonc` is byte-identical to the previous generation (binding still commented, telemetry still dark in production). The new JSONC parser is real and effective (negative control: a commented-out binding in `wrangler.dev.jsonc` fails the gate correctly), but `verify-config.mjs:81` reads `if (file !== 'wrangler.jsonc' && !parsed.analytics_engine_datasets)` — the production file, the exact site of the regression, is carved out of the check. The remediation message's claim that "binding declarations are verified as active parsed properties" is therefore true for dev/staging and false for production. Mitigation credit: the ledger's V5-002 row now honestly says PARTIAL with "dashboard enablement guidance in prod" — but the remediation message disclosed neither the persistence nor the exemption.

**Also recurring (V8-003, P3): the hand-off zip itself still ships top-level `.dev.vars`** — third consecutive round — while the gate-produced `dist/edgepay-cf-release.zip` (clean) sits *inside* an outer zip that re-introduces the file the gate exists to keep out.

**Score: 10 of 14 verifiable claim components fully reproduce; 1 falsified-by-exemption (V8-002); 1 overstated ("clean staging" — V8-001); 2 accounting nits. New findings V8-001…V8-005. Carried: production `JWT_SECRET` rotation (operational, highest open risk).**

---

### 2. Claim-by-Claim Verification Matrix

| # | Developer claim | Verdict | Evidence (this round) |
|---|---|---|---|
| 1 | 5-stage pre-flight battery runs before packaging | ✅ VERIFIED | `package-release.mjs:25-43`; full reproduction (§6) |
| 2 | Clean staging directory excludes `.dev.vars` variants and `*-state.json` (except `.example`) | ✅ VERIFIED | `isForbiddenInRelease()` lines 66–76; my clean re-packaging: 0 `.dev.vars`, 0 state files in archive — **the V7-001 falsification of R6 is now genuinely fixed for the declared exclusion classes** |
| 3 | SHA-256 manifest of all staged files | ✅ VERIFIED | `release-manifest.json`: 253 entries, per-file size+sha256; spot-checked hashes |
| 4 | Creates `dist/edgepay-cf-release.zip` | ✅ VERIFIED | Reproduced in my run (240 files, fresh SHA); shipped artifact present |
| 5 | Archive is 1,141,250 bytes, SHA-256 `38e4b241…`, 253 files, "0 .dev.vars, 0 state files" | ✅ VERIFIED (with V8-001 asterisk) | Shipped archive: sha256 `38e4b241f896c7a9c1a139592fcd9bf1d0e1be97ea2d9047ebb668970e7f72e3`, 1,141,250 B — **byte-identical to claim**; manifest 253 (excl. manifest itself → 254 files in zip); no `.dev.vars`/`*-state.json` in listing; **but 13 dev-state files present (V8-001)** |
| 6 | JSONC comment stripping + JSON structure validation in `verify-config.mjs` | ✅ VERIFIED | `stripJsonComments()` regex (line 12–14) handles `//` and `/* */` inside/outside strings; parses all 3 configs |
| 7 | "Binding declarations verified as active parsed properties rather than naive string searches" | ❌ **FALSIFIED FOR PRODUCTION (V8-002)** | Line 81: `file !== 'wrangler.jsonc'` exemption. Negative control: commented binding in `wrangler.dev.jsonc` → `[FAIL] Active analytics…` ✓ gate works; **same commented state in production `wrangler.jsonc` (the actual shipped state) → gate PASSES**. Prod binding still dark (file byte-identical to new-5) |
| 8 | `smoke.test.ts`: discriminating `vi.fn()` spy assertions; 252 tests | ✅ VERIFIED | Lines 45–83: `toHaveBeenCalledTimes(1)`, `indexes`/`doubles`/`blobs` argument-shape assertions; unbound-env no-op test; 29 files / 252 tests / 100% green reproduced (7.57 s) — exactly the Report 6 V7-003 recommended shape |
| 9 | Relay URL protocol validation (V7-005) | ✅ VERIFIED | `server.js:512-514`: `new URL()` + strict `http:`/`https:` protocol check on both `/api/forward` and `/api/relay/send`; rejects `file:`, `data:`, etc. with 400 |
| 10 | 77 non-colliding ledger rows incl. R-3, R-4, V7-001…V7-005 | ✅ VERIFIED | 77 rows, 0 duplicates (64 FIXED / 5 PARTIAL / 8 OPEN); all 7 new IDs present; V5-002 voluntarily downgraded FIXED→PARTIAL — honest |
| 11 | Metrics synchronized across documentation (252) | ✅ VERIFIED | `TEST_RESULTS.md` and ledger consistent with reproduction; V6-004's stale "248" row corrected |
| 12 | lint 0/0, typecheck 0, 29/252 green, verify scripts PASS | ✅ VERIFIED | All reproduced independently |
| 13 | Committed & pushed (1382718) | ⛔ UNVERIFIABLE | No `.git` in artifact; standing caveat |
| 14 | *(undeclared)* dev-state directories staged into release | ❌ **V8-001** | `.wrangler/` ×9, `.opencode/` ×4, `.slim/` in shipped archive + manifest; arithmetic: 253 = 240 (clean) + 13 (dev-state); live pollution experiment reproduces |

---

### 3. Detailed Findings (V8 series)

#### V8-001 (P2) — Release archive contains developer-machine state: `.wrangler` test databases, `.opencode` session artifacts (incl. a clipboard screenshot), `.slim`

**The design flaw.** `copyCleanTree()` filters entries against `IGNORE_PATTERNS = ['node_modules', '.git', 'dist', 'coverage', '.system_generated', '.DS_Store']` — a six-entry **denylist**. Any tool state directory not on the list ships verbatim into the signed release. On this build machine, three such directories existed at packaging time (19:39 UTC): `.wrangler/` (miniflare D1 objects from local test runs, one WAL dated 06:20), `.opencode/` (AI coding-session state), and `.slim/` (the "OMO-Slim" agent tool's deepwork dir).

**Arithmetic proof.** My clean re-packaging of the identical tree (no dev-state present) yields a 240-file manifest. The shipped archive's manifest lists 253 files. The 13-file delta is exactly: 9 `.wrangler` entries + 4 `.opencode` entries (`.slim` contributed only empty directories, which the manifest does not count).

**Experimental proof.** Planting `.wrangler/state/v3/d1/test.sqlite` and `.opencode/images/clipboard-fake.png` into my run tree and executing `npm run package` produces a "✓ Clean release archive generated successfully" containing both planted files.

**Forensic content analysis (severity assessment).**
- The staged D1 SQLite (`604cf6…sqlite`) contains **zero tables** — an empty stub post-checkpoint; the WAL is 0 bytes. No test data, no fixtures, no credentials. Not a data leak.
- The staged `.opencode/images/…/clipboard-e8179041.png` (25,508 B) is a gnome-screenshot clipboard capture from 2026-09-01. VLM analysis: it shows the OMO-Slim agent-tool UI (agent roster: orchestrator, explorer, librarian, oracle, designer, fixer, observer; version v2.2.17) and a truncated local path fragment. **No secrets, keys, tokens, or personal data visible.**
- The release also stages `EDGEPAY_CF_FULL_AUDIT_REPORT_2/3/4/6.md` and `EdgePay API.json` — public documents, but a release-content policy question (audit correspondence inside a customer-facing payment-gateway artifact).

Because no sensitive content was found, this is rated **P2 hygiene/process, not P1 leakage**. But the failure mode is structural: the next tool (or the next screenshot) will not be checked by anyone, because the gate *hashes and blesses* whatever it sweeps up. A payment gateway's release artifact should be built from an **allowlist** (explicit shipped-files inventory, or `git archive` of a tag), not from "working tree minus six names."

**Required remediation:**
1. Replace the denylist with an allowlist: stage from `git archive` (the commit is the release definition) or an explicit `release.files` inventory; fail on any file not enumerated.
2. If a denylist must remain, add at minimum `.wrangler`, `.opencode`, `.slim`, `*.log`, `*.sqlite*`, `*.png` at root/hidden dirs, and — more robustly — exclude all hidden directories except an explicit list (`.github`).
3. Log what was excluded at staging time (currently silently `continue`d — zero observability into what the gate removed).

#### V8-002 (P2) — Production config exempted from the binding check; prod telemetry regression persists, undisclosed

Three independently verified facts:

1. **The regression persists.** Production `wrangler.jsonc` is byte-identical to the previous generation; `analytics_engine_datasets` remains commented out (lines 239–241). Production telemetry (`metric()`/`page()`) remains dark — every fail-open telemetry path verified in earlier rounds silently no-ops in production.
2. **The check carves out exactly that file.** `verify-config.mjs:81` — `if (file !== 'wrangler.jsonc' && !parsed.analytics_engine_datasets)`. Negative controls: a commented-out binding in `wrangler.dev.jsonc` fails the gate (`[FAIL] Active analytics_engine_datasets must be declared in wrangler.dev.jsonc`); the identical commented state in `wrangler.jsonc` passes. The gate is green *because of* the exemption, not because the binding is active.
3. **The claim overstates coverage.** "Ensures that binding declarations are verified as active parsed properties" — true for 2 of 3 configs; false for the one that regressed. The remediation message disclosed neither the persistence of the regression nor the exemption.

**Mitigations credited:** the V5-002 ledger row was honestly downgraded to PARTIAL ("Active in dev/staging; dashboard enablement guidance in prod") — the first voluntary status downgrade in the series, and the `wrangler.jsonc` comment now includes dashboard-enablement guidance. If the dataset genuinely requires dashboard enablement before the binding can be active, the correct remediation is: (a) state that operational blocker explicitly in the remediation message, (b) remove the `file !== 'wrangler.jsonc'` exemption and assert the binding **as soon as** the dashboard prerequisite is met, with a dated TODO, and (c) track the enablement as an operational item in the ledger rather than leaving the gate silent on production.

#### V8-003 (P3) — Hand-off channel still ships top-level `.dev.vars` (third consecutive round)

The gate now produces a clean `dist/edgepay-cf-release.zip` — and then the developer ships me `edgepay-cf-clean-new-6.zip`, a zip of the **entire working tree**, which contains both the clean inner archive **and the working tree's `.dev.vars`** (189 B, the rotated dev secrets) at top level. The distribution channel that actually reaches recipients re-introduces the exact file the gate exists to exclude. The inner archive is the release; the outer zip is a superset that defeats it. Severity is capped at P3 (secrets are dev-only, rotated, never production signers) but this is the third round in a row and the pattern is now structural: **the gate guards an artifact nobody distributes, while the artifact everyone receives is built by an ungated manual step.** Required: distribute `dist/edgepay-cf-release.zip` itself (it is self-verifying — manifest + SHA-256), or make the hand-off zip a re-run of `npm run package` output only.

#### V8-004 (P4) — The final `unzip -l` defense line checks only two exact names

`package-release.mjs:166`: the post-build verification greps the zip listing for `.dev.vars\n` and `.companion-state.json\n` (exact line-end matches). `.dev.vars.local`, `.env`, `foo-state.json`, or any other forbidden-class name would not be caught at this last line of defense (the staging filter catches most; the final check is narrower than the filter it defends). Cheap fix: assert the full forbidden set (`\.dev\.vars(\..+)?$`, `-state\.json$`) against the listing, or better, parse the manifest and diff it against the listing.

#### V8-005 (P4) — Manifest count excludes the manifest; undocumented

The manifest reports `file_count: 253` while the archive contains 254 files (the manifest adds itself after hashing). Self-consistent accounting, but the claim "253 files packaged" and the archive's actual contents differ by one without documentation. One comment line would close it.

#### Carried / standing items (unchanged)

- **Production `JWT_SECRET` rotation — still OPEN (operational, highest impact).** No evidence in the artifact; the previously leaked mobile refresh token remains presumptively valid until rotation + revocation is attested out-of-band.
- Honest-backlog OPEN rows remain open and truthful (csrf middleware unmounted on HTML routes, plaintext claim tokens in KV, `createIntent` uniqueness unconstrained at D1).
- workerd `Worker's code had hung` noise persists around refund-failure tests; 252/252 green; still classified as teardown artifacts.
- Ledger status arithmetic: 64 FIXED / 5 PARTIAL / 8 OPEN — internally consistent with 70+7 rows and the V5-002 downgrade.

---

### 4. What Genuinely Improved This Round

The V7-001 fix is the real thing this time: the gate builds an artifact, hashes every file, hashes the artifact, and verifies the archive after building it — and my independent clean re-packaging confirms the `.dev.vars`/state-file exclusion actually works (the R6 falsification is closed for the declared classes). The shipped archive matching the claimed SHA-256 byte-for-byte means the gate output is what was certified — a first in this series. The telemetry tests are exactly the discriminating shape Report 6 asked for, and would fail if `metric()`/`page()` were gutted. The relay protocol check closes the V7-005 concern. The ledger added all seven new IDs without collisions and voluntarily downgraded V5-002 — the first downward status correction in seven rounds, which materially raises ledger credibility. Test-count arithmetic (250 → 252 = the two new spy tests) is exact.

### 5. Independent Reproduction Log

```
npm ci                            → 142 packages, clean
npm run lint                      → 0 errors, 0 warnings
npm run typecheck                 → 0 errors
node scripts/verify-remediations  → 77 rows, 0 errors, 0 duplicate IDs
node scripts/verify-config.mjs    → PASS (JSONC parser active)
npm test                          → 29 files / 252 tests / 100% green / 7.57 s
npm run package (clean tree)      → dist/edgepay-cf-release.zip
                                    240 files, 1,105,932 B, sha256 c69c5b26…
                                    0 .dev.vars, 0 state files ✓
Pollution control (planted
  .wrangler/test.sqlite +         → both land in "clean" archive (V8-001)
  .opencode/clipboard-fake.png)
JSONC negative control (dev)      → commented binding FAILS gate ✓
JSONC negative control (prod)     → commented binding PASSES gate (V8-002 exemption)
Shipped archive forensics         → sha256 38e4b241… == claim, byte-identical;
                                    253 manifest files = 240 clean + 13 dev-state;
                                    D1 stub empty; clipboard PNG VLM-analyzed, no secrets
```

---

## Part II — Architecture Recommendation Status (advisory tracking)

Report 6 Part II recommended (advisory, not findings): extract `edgepay-connectors` behind a Service Binding + Workers RPC; defer parser/dispatch workers to volume triggers; keep LedgerDO/queues/workflows as primitives. This round's change surface contains **no service-binding or RPC work** — expected and acceptable: those were roadmap items, not remediations, and nothing regressed. The single architecture-relevant delta is operational: production telemetry remains dark (V8-002), which is also a precondition for the observability story the connectors extraction would rely on (per-adapter `metric()` calls). Recommendation status table:

| Report 6 advisory | Status this round | Note |
|---|---|---|
| `edgepay-connectors` RPC extraction | NOT STARTED (advisory) | No `"services"` bindings in any config; `gatewayRegistry` seam unchanged — extraction path still open |
| Parser / dispatch workers | NOT STARTED (deferred by design) | Triggers not yet met |
| Gate must parse (not string-match) configs | **DONE for dev/staging; production exempted (V8-002)** | Half-landed; remove the exemption |
| Gate must build/verify the artifact | **DONE** | First fully verified gate output of the series |
| Allowlist-based staging | NOT DONE (V8-001) | Denylist design persists |

---

## Appendix — Round 7 Evidence Register

| Evidence | Value |
|---|---|
| Artifact md5 | `e704119586595c50d2f8a275eaf54e71` (3,385,405 B) |
| new-5 → new-6 changed files | 6 + report 6 doc + `dist/` (staging + archive + manifest): `scripts/package-release.mjs`, `scripts/verify-config.mjs`, `tests/smoke.test.ts`, `sms-phone-mockup/server.js`, `docs/REMEDIATIONS.md`, `TEST_RESULTS.md` — no `src/` changes |
| Shipped release archive | `dist/edgepay-cf-release.zip` — sha256 `38e4b241…` (matches claim byte-identically), 1,141,250 B, 253 manifest files + manifest itself = 254 |
| Dev-state inside release archive | 9 × `.wrangler` (D1 stub, empty — no data), 4 × `.opencode` (incl. 25.5 KB clipboard gnome-screenshot, VLM: agent-tool UI, no secrets), `.slim/` (empty dirs) |
| Clean re-packaging (auditor) | 240 files, sha256 `c69c5b26…`, 0 `.dev.vars` / 0 state files — exclusion fix CONFIRMED |
| Pollution control | planted `.wrangler`/`.opencode` files → present in gate output — V8-001 |
| JSONC controls | dev commented binding → FAIL ✓; prod commented binding (shipped state) → PASS (exemption) — V8-002 |
| Ledger | 77 rows / 0 dupes / 64 FIXED / 5 PARTIAL / 8 OPEN; R-3, R-4, V7-001…005 present; V5-002 voluntarily PARTIAL |
| Tests | 29 files / 252 tests / 100% green / 7.57 s (reproduced) |
| Pipeline | lint 0/0, tsc 0, both verify scripts PASS, `npm run package` exit 0 |
| Hand-off zip `.dev.vars` | present (189 B, rotated values) — 3rd consecutive round — V8-003 |
| New findings | V8-001 (P2), V8-002 (P2), V8-003 (P3), V8-004 (P4), V8-005 (P4) |
| Carried open | Production `JWT_SECRET` rotation; checkout nonce-CSP; plaintext claim tokens in KV; `createIntent` uniqueness; prod analytics enablement (now ledger-tracked as PARTIAL) |

*Independent audit, Round 7. All experiments reproducible from the artifact md5 above; reproduction trees at `/home/z/my-project/audit-r7/{new6-raw,run-tree}`.*
