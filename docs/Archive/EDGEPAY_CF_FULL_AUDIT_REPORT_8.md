# EdgePay-CF — Full Independent Audit Report 8

**Round:** 8 (verification of "Report 7 Audit Remediations & Quality Hardening Summary" claims)
**Artifact under audit:** `edgepay-cf-clean-new-7.zip` (md5 `ff68583aff63c007884bdb6bb0750fb9`, 2,707,731 bytes, received 2026-09-02 ~20:49 UTC)
**Claimed snapshot:** commit `dd7412d`, pushed to `main` + `master` (unverifiable from zip — no `.git`; standing caveat)
**Auditor methodology:** independent extraction → generation diff (new-6 → new-7) → claim-by-claim code verification → **clean-tree re-packaging with per-file hash comparison against the shipped manifest** → planted-file pollution experiments (incl. an unknown hidden directory and the root-image class) → JSONC production-binding negative control → full pipeline reproduction.

---

## Part I — Round 8 Verification of V8 Remediation Claims

### 1. Executive Summary

This is the strongest gate-engineering round of the series, and the first in which **every claimed number reconciles exactly**. The shipped release archive is byte-identical to the claim (sha256 `f74026d4…`, 798,202 bytes); my independent clean-tree rebuild is **content-identical** — 235 staged files, all 235 per-file SHA-256 hashes equal, zero files only on either side. The V8-002 fix is genuine and complete: the production `analytics_engine_datasets` binding is active in `wrangler.jsonc` for the first time since the V7-002 regression, the `file !== 'wrangler.jsonc'` exemption is deleted, and the exact negative control that **passed** in Round 7 (commented production binding) now **fails** the gate with exit 1. The hidden-directory class rule works — an *unknown* dot-directory (`.vscode/`) planted by the auditor was excluded without anyone having to enumerate it, which is the structural fix V8-001 asked for. The post-build regex screen is real, correctly anchored (`(?!\.example)` lookaheads; `/\.git\//` does not false-positive on `.github/`), and state files are now blocked *even earlier*, at the pre-flight tree scan. The developer's "13 items filtered" reconstructs to the item on their build machine. The ledger is at 82 honest rows, and the V5-002 restore to FIXED is **justified** this time — the condition it asserts (active binding in all 3 configs) is now verifiably true.

Three material qualifications offset that progress:

**V9-001 (P3): V8-003 is declared FIXED but is not fixed.** The finding was that the *hand-off channel* re-ships the top-level `.dev.vars` the gate exists to exclude. The hand-off zip of this round still contains `.dev.vars` (189 B, byte-identical to the new-6 values) — the **fourth consecutive round**. The remediation redefined scope: the ledger row now says "Release artifact packaged as self-contained verified archive," which is true of the *inner* `dist/` artifact and silent about the *outer* zip that actually reaches recipients. The outer zip did improve (it now `-x`-excludes `.wrangler/.opencode/.slim`), but the specific file class the finding named persists.

**V9-002 (P3): the audit-correspondence exclusion misses the two largest audit documents.** The filter pattern `^EDGEPAY_CF_FULL_AUDIT_REPORT_\d+\.md$` requires a numeric suffix. The release archive still ships `docs/Archive/EDGEPAY_CF_FULL_AUDIT_REPORT.md` (**329,644 B — the single largest file in the release**) and `docs/Archive/EDGEPAY_AUDIT_REPORT.md` (93,889 B), plus `EdgePay API.json` (117,511 B). That is 541,044 B ≈ **22.7% of the release's uncompressed content** being audit correspondence and internal API spec — the exact release-content class Round 7 flagged, now partially excluded.

**V9-003 (P3): "Allowlist" is the label, not the design.** Gate header, ledger row, and remediation message all say "Allowlist"; the implementation remains a denylist (a strong one — hidden dirs as a class, plus explicit file-class rules). Planting a root-level `screenshot.png` and re-running `npm run package` lands it in the "clean" **signed** archive — experimentally demonstrated this round. The R7 required remediation #1 (stage from `git archive` / explicit inventory, fail on any non-enumerated file) was not implemented; #2 was, minus the `*.png`-at-root clause.

**Score: 10 of 12 verifiable claim components fully reproduce; 1 falsified (V8-003 FIXED status); 1 overstated (correspondence-exclusion class + allowlist label). New findings V9-001…V9-004. Carried: production `JWT_SECRET` rotation (operational, highest open risk).**

---

### 2. Claim-by-Claim Verification Matrix

| # | Developer claim | Verdict | Evidence (this round) |
|---|---|---|---|
| 1 | Hidden-directory filter: all `.*` dirs excluded except `.github` | ✅ VERIFIED | `package-release.mjs:60-62`; pollution control: planted **unknown** `.vscode/` → excluded; `.github/workflows/audit-gate.yml` staged (md5 unchanged from new-6) |
| 2 | Explicit exclusions `.wrangler/.opencode/.slim/.system_generated/.git/node_modules/dist/coverage/*.sqlite*/*.log/.DS_Store` + audit correspondence | ✅ VERIFIED (with V9-002 asterisk) | `isForbiddenInRelease()` lines 63–83; planted `.wrangler` (sqlite+wal), `.opencode` (png), `.slim`, `devrun.log`, `stray.sqlite`, `.dev.vars.local`, numbered report → **all excluded**; but non-numbered Archive audit docs still ship |
| 3 | Release reduced 1.14 MB → ~798 KB, 235 staged files | ✅ VERIFIED | Shipped `dist/edgepay-cf-release.zip`: 798,202 B, sha256 `f74026d49b27939a4171ddb7509c31a1ca60952d246cd8b495b7aac2d6cdf681` — **byte-identical to claim**; manifest 235 files; my rebuild: 235/235 hashes equal |
| 4 | Production `analytics_engine_datasets` activated | ✅ VERIFIED | `wrangler.jsonc:239-241` active (was commented in new-6); dev:116 / staging:113 active — all 3 environments |
| 5 | `verify-config.mjs` exemption removed; strict validation across all 3 environments | ✅ VERIFIED | Line 81: `!parsed.analytics_engine_datasets \|\| !Array.isArray(...)` for **all** config files; negative control: commented prod binding → `[FAIL] Active analytics_engine_datasets must be declared in wrangler.jsonc`, exit 1 — **the exact control that passed in R7** |
| 6 | Post-build comprehensive regex screening on `unzip -l` | ✅ VERIFIED | `FORBIDDEN_ZIP_PATTERNS` lines 179–190: 10 patterns with `(?!\.example)` lookaheads and `/`-anchored dir patterns; gate self-consistent with `.github` inclusion; state file additionally blocked at pre-flight (verify-config tree scan — observed live) |
| 7 | Manifest accounting documented (235 staged vs 236 entries) | ✅ VERIFIED | `manifest_note: 'total archive entries equals staged_file_count + 1…'`; printed both counts; archive verified: 236 file entries (+41 dir entries — labeling nit, V9-004) |
| 8 | Ledger 82 verified rows incl. V8-001…005; V5-002 restored FIXED | ✅ VERIFIED | 82 rows, 0 duplicate IDs, 70 FIXED / 4 PARTIAL / 8 OPEN (arithmetic exact vs R7: +5 V8 rows, V5-002 PARTIAL→FIXED); restore **justified** — the asserted condition is now code-verifiable |
| 9 | 29 test files, 252 tests, 0 skips, 100% green | ✅ VERIFIED | Reproduced: 29 files / 252 tests / 7.55 s, workerd runtime, 0 skips |
| 10 | Pipeline: "13 items filtered (0 .dev.vars, 0 state files, 0 dev state)" | ✅ VERIFIED (arithmetically exact) | Their machine's 13 = node_modules, dist, .git, .wrangler, .opencode, .slim (dirs) + `.dev.vars` + reports 2/3/4/6/7 + Archive report 1 — reconstructed to the item; resulting archive scanned: 0 `.dev.vars` / 0 state files / 0 dev-state |
| 11 | All findings from Report 7 resolved | ❌ **PARTIALLY FALSE** | V8-003 not resolved — hand-off zip ships `.dev.vars` (4th round, V9-001); V8-001's allowlist recommendation unimplemented (V9-003) |
| 12 | Committed & pushed (`dd7412d`) | ⛔ UNVERIFIABLE | No `.git` in artifact; standing caveat |

---

### 3. Detailed Findings (V9 series)

#### V9-001 (P3) — V8-003 marked FIXED by scope redefinition; the hand-off channel still ships `.dev.vars` (4th consecutive round)

The shipped `edgepay-cf-clean-new-7.zip` contains a top-level `.dev.vars` (189 B, md5 `a2b02d29…`, byte-identical to the new-6 generation — the dev-secret values rotated in the V6 round). The V8-003 finding was never about the inner archive; it was that "the distribution channel that actually reaches recipients re-introduces the exact file the gate exists to exclude." That remains true. The developer's zip command now excludes `.wrangler/.opencode/.slim/.git/node_modules` — a real channel improvement — but not `.dev.vars`. The ledger's V8-003 row reads FIXED with verification text "Release artifact packaged as self-contained verified archive," which describes the inner artifact (true) and not the finding (unresolved). Severity stays P3: the values are dev-only, previously rotated, and never production signers. But four consecutive rounds of a FIXED-marked row that does not describe the observed channel is a ledger-accuracy issue, which this series weighs heavily because the ledger is the trust anchor of the whole remediation program.

**Required remediation:** distribute `dist/edgepay-cf-release.zip` itself (self-verifying: manifest + SHA-256), or add `.dev.vars*` (and the state-file classes) to the hand-off zip's `-x` list, and reword the V8-003 row to describe the channel, not the artifact.

#### V9-002 (P3) — Audit-correspondence exclusion is pattern-incomplete; the original 329 KB audit report is the largest file in the "clean" release

The stated exclusion class is "internal `EDGEPAY_CF_FULL_AUDIT_REPORT_*.md` correspondence." The implemented regex — `^EDGEPAY_CF_FULL_AUDIT_REPORT_\d+\.md$` — requires a numeric suffix and therefore matches reports 1–7 at root/Archive, but not:
- `docs/Archive/EDGEPAY_CF_FULL_AUDIT_REPORT.md` — **329,644 B**, the original full audit report, the single largest file in the release archive;
- `docs/Archive/EDGEPAY_AUDIT_REPORT.md` — 93,889 B (different name stem, same correspondence class);
- `EdgePay API.json` — 117,511 B, an internal API spec (flagged as a release-content question in R7, unaddressed).

Combined: 541,044 B of the release's 2,383,434 B uncompressed content (≈22.7%) is audit correspondence and internal spec. No secrets were found in these documents in earlier rounds (they are this audit series' own public deliverables), so this is content policy, not leakage — but a payment gateway's signed, customer-facing release carrying its own full vulnerability audit history is categorically wrong, and the remediation message's "internal … correspondence excluded" claim is true for 5 of 7 documents in the class it names. Cheap fix: `/^EDGEPAY_(CF_FULL_)?AUDIT_REPORT(_\d+)?\.md$/i` plus a decision on `EdgePay API.json`.

#### V9-003 (P3) — "Allowlist" label vs denylist reality; root-level image class leaks into the signed archive (experimentally demonstrated)

The gate prints "Allowlist & Strict Hygiene"; the ledger row is titled "Release Packaging Allowlist"; the remediation message headline says "Strict Allowlist." The implementation is a **denylist** — substantially hardened by the hidden-directory class rule, but still "working tree minus enumerated names." Pollution experiment: planting a root-level `screenshot.png` (an arbitrary non-enumerated binary) and running `npm run package` produces a "✓ Clean release archive generated successfully" whose manifest and zip **contain the planted image** (verified by manifest diff: exactly `["screenshot.png"]` leaked; all 9 planted dev-state items excluded; 17 total exclusions, matching the gate's own count to the item). This is the same failure family as V8-001's clipboard screenshot — a stray image at root ships into a hashed, "verified" release — now proven at root level, not just inside dot-dirs. The structural fix remains what R7 specified: stage from `git archive` (the commit is the release definition) or an explicit inventory, failing on any file not enumerated. At minimum add `*.png/*.jpg/*.gif` outside `public/assets`.

#### V9-004 (P4) — Precision nits (claim text, entry-count labeling, stale config comment)

1. **Regex claim vs code.** The message lists unanchored patterns (`/\.dev\.vars/`, `/\.git/`). The actual code uses `(?!\.example)` negative lookaheads and trailing-slash anchors — the code is *better* than claimed (the literal claimed patterns would false-fail on `.dev.vars.example`, `.gitignore`, and `.github/`). The claim describes the mechanism imprecisely; the implementation is correct.
2. **"Total Zip Entries: 236."** Counts file entries only. `unzip -l` reports 277 "files" (236 files + 41 directory entries). The manifest_note is internally consistent, but a verifier diffing the gate's number against `unzip -l`'s summary line gets a 41-entry discrepancy with no explanation. One sentence in the note would close it.
3. **Stale comment above the now-active binding.** `wrangler.jsonc:236-238` still instructs "(Enable at …dash.cloudflare.com… then uncomment the binding below to activate live dataset streams)" — directly above a binding that is now uncommented. This exact ambiguity fueled the V7-002 comment/regression cycle; delete or rewrite the comment to reflect the active state.
4. **Exclusion log prints the count, not the list.** R7 asked for observability into what the gate removed; the gate prints "17 items filtered" with the item list computed but discarded. Logging the `excludedLog` lines would cost nothing and would have let the developer see — this round — that their own machine still stages `.dev.vars` and five audit reports into the exclusion path.

#### Carried / standing items (unchanged)

- **Production `JWT_SECRET` rotation — still OPEN (operational, highest impact).** The ledger's EDGE-P0-001 row attests production rotation "via wrangler" — unverifiable from any zip artifact. The previously leaked mobile refresh token remains presumptively valid until rotation + revocation is attested out-of-band (dashboard evidence, revocation event, or rotated-token failure replay).
- Honest-backlog OPEN/PARTIAL rows remain open and truthful (csrf middleware unmounted on HTML routes, `createIntent` D1 uniqueness, plaintext claim tokens in KV, EDGE-P0-005/P1-006 partial states) — `src/` is byte-identical to new-6, so the backlog assessment carries over without re-testing.
- workerd `Worker's code had hung` noise persists around refund-failure tests; 252/252 green; classified as teardown artifacts (R5 determination, re-observed this round).
- Commit `dd7412d` — no `.git` in artifact; unverifiable (standing caveat since R4).

---

### 4. What Genuinely Improved This Round

The V8-002 closure is the round's real achievement and deserves precision: the production analytics binding — commented out since the V7-002 regression, exempted from the gate that was supposed to catch it in Round 7 — is now (a) active in `wrangler.jsonc`, (b) enforced identically across all three environments by a check with no carve-outs, and (c) proven enforced by the exact negative control that exposed the exemption last round. Production `metric()`/`page()` telemetry is live for the first time in the series, which also unblocks the observability precondition for the connectors-extraction roadmap. The V8-001 class fix is structurally sound: excluding *all* hidden directories except `.github` means the next tool that leaves a dot-directory behind is excluded without anyone remembering to enumerate it — my unknown-`.vscode` control confirms the design intent. The archive itself is now the most verifiable artifact the series has produced: byte-identical to the claimed SHA-256, and my independent rebuild matches it file-for-file and hash-for-hash, which means the gate is deterministic and the certified content is the shipped content. Finally, the numbers all reconcile — 13 exclusions, 82 rows, 235 files, 236 entries, 29/252 — with zero accounting drift for the first time in eight rounds.

### 5. Independent Reproduction Log

```
npm ci                            → clean install
npm run lint                      → 0 errors, 0 warnings
npm run typecheck                 → 0 errors
node scripts/verify-remediations  → 82 rows, 0 errors, 0 duplicate IDs
node scripts/verify-config.mjs    → PASS (tree scan + git check + JSONC parser)
npm test                          → 29 files / 252 tests / 100% green / 7.55 s
npm run package (clean tree)      → dist/edgepay-cf-release.zip
                                    798,202 B (size-identical to shipped);
                                    235 staged files; 235/235 per-file SHA-256
                                    equal to shipped manifest; 0 .dev.vars,
                                    0 state files, 0 dev-state
Prod-binding negative control     → commented binding in wrangler.jsonc:
                                    [FAIL] + exit 1 ✓ (exemption genuinely gone)
Pollution control (11 items)      → 9 dev-state items excluded (incl. unknown
                                    .vscode/); test-state.json blocked earlier
                                    at pre-flight tree scan; root screenshot.png
                                    LEAKS into clean archive (V9-003);
                                    17 exclusions = gate's own count, to the item
Shipped archive forensics         → sha256 f74026d4… == claim, byte-identical;
                                    236 file entries (+41 dirs); still contains
                                    EDGEPAY_CF_FULL_AUDIT_REPORT.md (329,644 B),
                                    EDGEPAY_AUDIT_REPORT.md (93,889 B),
                                    EdgePay API.json (117,511 B) — V9-002
Hand-off zip                      → top-level .dev.vars present, 4th round (V9-001);
                                    .wrangler/.opencode/.slim/.git now -x-excluded
```

---

## Part II — Architecture Recommendation Status (advisory tracking)

No service-binding, Workers RPC, or connectors-extraction work appears in this round's change surface — consistent with the remediation scope (nothing was claimed, nothing regressed). The one architecture-relevant delta is positive: **production telemetry is now live** (V8-002 closure), which was the observability precondition Report 6 identified for the `edgepay-connectors` extraction (per-adapter `metric()` calls across the RPC boundary). The `gatewayRegistry` seam remains unchanged and the extraction path stays open.

| Report 6/7 advisory | Status this round | Note |
|---|---|---|
| `edgepay-connectors` RPC extraction | NOT STARTED (advisory) | No `"services"` bindings in any config; seam intact |
| Parser / dispatch workers | NOT STARTED (deferred by design) | Triggers not yet met |
| Gate must parse (not string-match) configs | **DONE — all 3 environments** | Exemption removed; negative control fails correctly |
| Gate must build/verify the artifact | DONE (since R7; re-proven) | Content-identical rebuild this round |
| Allowlist-based staging | NOT DONE — denylist persists under an "Allowlist" label | V9-003; root-image class leaks |
| Production observability precondition | **DONE** | Binding active; `metric()`/`page()` live in production |

---

## Appendix — Round 8 Evidence Register

| Evidence | Value |
|---|---|
| Artifact md5 | `ff68583aff63c007884bdb6bb0750fb9` (2,707,731 B) |
| new-6 → new-7 changed files | `scripts/package-release.mjs`, `scripts/verify-config.mjs`, `wrangler.jsonc`, `docs/REMEDIATIONS.md`, `dist/` (staging + archive + manifest), + delivered `EDGEPAY_CF_FULL_AUDIT_REPORT_7.md` — **no `src/`, `tests/`, `sms-phone-mockup/`, or `package.json` changes** |
| Shipped release archive | sha256 `f74026d49b27939a4171ddb7509c31a1ca60952d246cd8b495b7aac2d6cdf681` (matches claim, byte-identical), 798,202 B, 235 manifest files + itself = 236 file entries |
| Auditor rebuild | 798,202 B; 235/235 files hash-equal to shipped manifest; 0 differences |
| Production binding | `wrangler.jsonc:239-241` ACTIVE (new-6: commented); dev:116, staging:113 active |
| Negative control (prod) | commented binding → `[FAIL]` + exit 1 — R7's passing control now fails ✓ |
| Pollution control | 9 dev-state items excluded (incl. unknown `.vscode/`); `test-state.json` blocked at pre-flight; **root `screenshot.png` leaked** — V9-003 |
| Release-content residue | `docs/Archive/EDGEPAY_CF_FULL_AUDIT_REPORT.md` (329,644 B), `docs/Archive/EDGEPAY_AUDIT_REPORT.md` (93,889 B), `EdgePay API.json` (117,511 B) — V9-002 |
| Hand-off zip `.dev.vars` | present (189 B, md5 `a2b02d29…`, identical to new-6) — **4th consecutive round** — V9-001 |
| Ledger | 82 rows / 0 dupes / 70 FIXED / 4 PARTIAL / 8 OPEN; V8-001…005 present (all FIXED); V5-002 PARTIAL→FIXED restore justified |
| Tests | 29 files / 252 tests / 0 skips / 100% green / 7.55 s (reproduced) |
| Pipeline | lint 0/0, tsc 0, both verify scripts PASS, `npm run package` exit 0 |
| New findings | V9-001 (P3), V9-002 (P3), V9-003 (P3), V9-004 (P4) |
| Carried open | Production `JWT_SECRET` rotation; checkout nonce-CSP; plaintext claim tokens in KV; `createIntent` uniqueness; csrf unmounted on HTML routes |

*Independent audit, Round 8. All experiments reproducible from the artifact md5 above; reproduction trees at `/home/z/my-project/audit-r8/{new7-raw,run-tree}`; exclusion-walk forensic script at `/home/z/my-project/scripts/r8-exclusion-walk.mjs`.*
