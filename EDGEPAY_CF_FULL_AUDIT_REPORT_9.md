# EDGEPAY_CF_FULL_AUDIT_REPORT_9.md

**Round 10 of the independent audit series — verification of "Report 8 Remediations & Crypto Hardening" (commit `14c6690` claimed, main + master)**

- **Date:** 2026-09-03
- **Auditor:** Independent verifier (unchanged methodology since Report 1)
- **Evidence primary:** `upload/edgepay-cf-clean-new-8.zip` — 2,379,816 bytes, md5 `89e2df3fb47aa2f85eaaa2b310bae917`, 561 entries, tree state dated 2026-09-02 21:37 UTC
- **Comparison generation:** new-7 (Report 8 evidence base)
- **Live control:** `https://edgepay-cf.bm-jonybepary.workers.dev/api/openapi.json` (re-fetched this round)
- **Verification environment:** fresh extraction to `audit-r9/new8-raw` (read-only evidence) + `audit-r9/run-tree` (pipeline reproduction); `npm ci` from lockfile; Node 20; workerd via `@cloudflare/vitest-plugin`

---

## 1. Executive Summary

This is the strongest remediation round of the series on **declaration accuracy and numeric fidelity**: the change surface between new-7 and new-8 is exactly the seven declared files plus the new `tests/crypto-security.test.ts`, my prior Report 8 copy (expected pattern), and the regenerated `dist/` — **zero undeclared source or test mutations, a series first at this tree size**. Every quantitative claim reproduces exactly: archive size 628,880 B, SHA-256 `f7ae7a56…`, 233 staged files / 234 file entries, 30 test files / 260 tests / 0 skips on workerd (7.40 s, clean exit), ESLint 0/0, `tsc` 0 errors, ledger 86 rows / 0 duplicates. The V9-002/003/004 packaging exclusions are real and empirically effective against every leak class from Report 8; EDGE-P2-017's 600,000-iteration default is real and backward-compatible; V3-004's claim-credential AES-256-GCM envelope is implemented.

Five new findings temper the verdict, the most material being: **(V10-001, P3)** the ledger marks V9-001 FIXED ("comprehensive exclusion of .dev.vars across all archive packaging") while the hand-off zip — the artifact actually distributed to third parties — still ships `edgepay-cf/.dev.vars` for the **fifth consecutive round**, repeating the scope-redefinition pattern Report 8 flagged on V8-003; **(V10-002, P4)** the shipped release archive embeds stale self-description documents claiming **259 tests** while the delivered tree and the independently reproduced battery say **260** (archive built 6–10 s before the final doc edit, never rebuilt — breaking Report 8's first-ever archive↔tree content equality); **(V10-003, P4)** the binary filter is image-types-only, so `.pdf`/`.zip`/`.mp4` planted at root enter the signed "clean" archive while the packager prints "verified successfully"; **(V10-004, P4)** no test pins the 600K default despite a test block titled "OWASP 600K Compliance"; **(V10-005, P3)** the V3-004 encryption is best-effort fail-open (missing/failed key → plaintext credential bundle in KV, silently) and has zero integration coverage — the existing claim tests hand-seed plaintext KV fixtures and therefore exercise only the compatibility shim.

Claim score: **13/14 verified, 1 unverifiable** (commit hash — no `.git` in hand-off, recurring). Production JWT_SECRET rotation remains the highest OPEN operational item.

---

## 2. Claim Verification Matrix

| # | Developer claim | Verdict | Evidence |
|---|---|---|---|
| C1 | Release archive 628,880 bytes (was 798,202) | **EXACT** | `stat` on shipped `dist/edgepay-cf-release.zip` |
| C2 | SHA-256 `f7ae7a56f5a96a4caab37bc834bce594e12dd84275ed3334631ead855467de1e` | **EXACT** | Byte-identical hash on shipped artifact |
| C3 | 233 staged files, 234 total entries incl. manifest | **EXACT** | Manifest `staged_file_count: 233`; zip non-dir entries = 234 (274 incl. directory entries, now documented in `manifest_note`) |
| C4 | 15 exclusion items | **Consistent** | 11 reproducible on delivered tree; +4 are machine-local dirs absent from hand-off (`.git`, `.opencode`, `.slim`, `.wrangler`) — arithmetic 11+4=15 holds |
| C5 | Audit correspondence excluded (V9-002): reports incl. unnumbered, `docs/Archive/`, `EdgePay API.json`, collections | **Verified** | `package-release.mjs:81-86`; negative experiment §5.3 |
| C6 | Images restricted to asset directories (V9-003) | **Verified for images** | `package-release.mjs:89-92`; root `screenshot.png` excluded. Non-image binaries leak — V10-003 |
| C7 | Itemized exclusion logging + manifest self-count (V9-004) | **Verified** | `excludedLog` printed per item; `manifest_note` added; log caps at 15 items |
| C8 | `wrangler.jsonc` stale comment cleanup | **Verified** | Diff shows only comment lines changed; ANALYTICS binding **still active** — no V7-002-style regression |
| C9 | V3-004: claim credentials AES-256-GCM in KV, decrypted at redemption | **Implemented** | `admin-api.ts:417-442` (write), `:283-291` (read); fail-open caveats → V10-005 |
| C10 | EDGE-P2-017: default PBKDF2 600,000 iterations | **Verified** | `crypto.ts:28` (`50_000 → 600_000`); PHC format embeds cost → old hashes still verify |
| C11 | `crypto-security.test.ts` — 8 cases, real assertions | **Verified** | 8 `it()` blocks, all import production code (V7-003 lesson institutionalized); gap → V10-004 |
| C12 | 30 files / 260 tests / 0 skips / workerd green | **Reproduced** | Independent run: 30/30 files, 260/260 tests, 7.40 s, clean exit (teardown-hang noise gone) |
| C13 | ESLint 0/0, `tsc --noEmit` 0, ledger 86 rows / 0 duplicates | **Reproduced** | §4; ledger status split 77 FIXED / 4 PARTIAL / 5 OPEN |
| C14 | Commit `14c6690` pushed to main + master | **Unverifiable** | No `.git` in hand-off (recurring since Report 6); CI workflow correctly targets `[main, master]` but runs only in the remote repo |

---

## 3. Change Surface (new-8 vs new-7)

```
scripts/package-release.mjs          modified   (V9-002/003/004)
src/controllers/admin-api.ts          modified   (V3-004)
src/lib/crypto.ts                     modified   (EDGE-P2-017)
wrangler.jsonc                        modified   (comment only)
docs/REMEDIATIONS.md                  modified   (ledger update)
TEST_RESULTS.md                       modified   (count sync)
tests/crypto-security.test.ts         NEW        (8 cases)
EDGEPAY_CF_FULL_AUDIT_REPORT_8.md     NEW        (auditor's prior report — expected)
dist/                                 regenerated
```

No other source, test, config, or documentation file differs. This is the cleanest declaration-to-reality mapping of the series — prior rounds routinely carried undeclared edits (e.g., R7's `server.js` relay alias, R6's simulator default change).

---

## 4. Pipeline Reproduction (independent, clean tree)

| Stage | Result |
|---|---|
| `npm ci` | exit 0 (209 packages, lockfile) |
| `npm run lint` | 0 errors, 0 warnings |
| `npm run typecheck` | 0 errors (strict) |
| `node scripts/verify-remediations.mjs` | **86 rows, 0 errors, 0 duplicate IDs**; 7 citation-relevance WARNs (carried, benign) |
| `node scripts/verify-config.mjs` | PASS (tree scan + git check + JSONC parser) |
| `npm test` | **30 files / 260 tests / 100% / 7.40 s** on workerd; no skipped tests; no teardown hang (first fully clean exit since R5) |
| `npm run package` | exit 0; pre-flight battery re-run inside; archive built and post-checked |

Ledger distribution after this round: **77 FIXED / 4 PARTIAL / 5 OPEN** (86 total). The four PARTIAL and five OPEN rows are carried items (incl. CSRF mount, `createIntent` uniqueness, production JWT rotation) — no status regressions introduced.

---

## 5. Archive & Packaging Verification

### 5.1 Shipped artifact

- Size **628,880 B** and SHA-256 **`f7ae7a56…`** match the declaration byte-for-byte (798,202 → 628,880 B, −21%).
- 234 file entries = 233 staged + `release-manifest.json`; 274 zip entries including directory paths — the counting semantics are now self-documented in `manifest_note` (closes the R8 V9-004 sub-item).
- 6/6 randomly-sampled manifest SHA-256 hashes match archived content.
- Leak sweep of the shipped archive: no audit-report `.md` (numbered or unnumbered), no `docs/Archive/`, no `EdgePay API.json`, no `.png`, no `.sqlite`/`.log`, no real `.dev.vars` (only `.dev.vars.example`), no `companion-state.json` (only `.example`). Matches labeled "audit" hits are legitimate runtime files (`ledger-audit.ts`, `audit-gate.yml`, `audit-poc-r4.test.ts`).

### 5.2 Clean-tree repack vs shipped

Entry sets are **identical (234 = 234)**; 231/233 files are byte-identical. Two files differ:

| File | Shipped archive says | Delivered tree / my battery says |
|---|---|---|
| `TEST_RESULTS.md` | "Tests **259** passed (259)" | "**260** passed (260)" |
| `docs/REMEDIATIONS.md` | "30 test suites, **259** tests" | "30 test suites, **260** tests" |

Timeline forensics: manifest timestamp `21:37:02.512Z`; `docs/REMEDIATIONS.md` mtime `21:37:08`; `TEST_RESULTS.md` mtime `21:37:12`. The archive was built **6–10 seconds before** both documents received their final edit and was never rebuilt. Report 8's milestone (clean repack = content-level full equality, 235/235) therefore regresses to 231/233 — see V10-002.

### 5.3 Pollution experiments (V9-002/003 regression probes)

Planted into a clean tree, then `npm run package`:

| Planted file | Outcome |
|---|---|
| `docs/Archive/EDGEPAY_CF_FULL_AUDIT_REPORT.md` (unnumbered, R8 leaker) | **Excluded** ✓ |
| root `EDGEPAY_AUDIT_REPORT.md` (unnumbered, R8 leaker) | **Excluded** ✓ |
| root `EdgePay API.json` (R8 leaker, 117 KB class) | **Excluded** ✓ |
| root `screenshot.png` (V9-003 original PoC) | **Excluded** ✓ |
| root `invoice.pdf` | **LEAKED into signed "clean" archive** ✗ |
| root `backup.zip` | **LEAKED** ✗ |
| root `video.mp4` | **LEAKED** ✗ |

Exclusion arithmetic under pollution: 11 → 13 items (audit `.md` + `EdgePay API.json` overwrite) with staged count 236 = 233 + 3 leaked plants; the packager still printed "Clean release archive generated and verified successfully" and the post-build pattern battery raised no alarm (its rules cover images/state/audit classes only). The R8 critique stands in widened form: the filter remains a **type blacklist, not an allowlist** — see V10-003.

---

## 6. Code-Level Verification Details

### 6.1 V9-002/003/004 — `scripts/package-release.mjs`

- Audit-document rule now `/EDGEPAY.*AUDIT.*\.md$/i` on filename **or** `relPath.includes('docs/Archive/')` — covers both unnumbered R8 leakers and the numbered series; `EdgePay API.json` exact-name plus `*.postman_collection.json`; image rule is path-scoped (`public/`, `sms-phone-mockup/public/` allowlist). All empirically effective (§5.3).
- Post-build zip-listing battery gained the audit regex and retains `.dev.vars(?!\.example)`, state-file, hidden-dir, and dev-tool patterns. Fail behavior is fail-closed (`exit 1`).
- Observability: per-item `excludedLog` with `[DIR]`/`[FILE]` prefixes (capped at 15 printed items — sufficient today, truncating tomorrow), manifest self-count note, `Total File Entries: N+1` console line.

### 6.2 EDGE-P2-017 — `src/lib/crypto.ts`

- `PBKDF2_ITERATIONS: 50_000 → 600_000` (OWASP 2023 for PBKDF2-HMAC-SHA256) — the declared change, nothing else in the file moved.
- Hash format `pbkdf2-sha256$iterations$salt$hash` embeds the cost; `verifyPassword` derives at the stored cost, so pre-fix 50K hashes remain verifiable — **no credential lockout regression**.
- Bounds `[10_000, 2_000_000]` fail-hard on out-of-range cost.
- Free-tier honesty: the module documents that 600K cannot finish in the Workers free 10 ms CPU budget and that `PBKDF2_ITERATIONS` env override exists. Wiring audit: the override is honored **only** in `install.ts:138`; `admin-api.ts:344` (merchant provisioning) and `bootstrap.ts:73` (initial admin) always hash at the 600K default. Operational note folded into V10-004.
- Minor: `verifyPassword` applies no lower bound to iterations parsed from a stored hash (accepts ≥ 1); harmless under the current writer (writer floor 10K) but worth a guard.

### 6.3 V3-004 — claim credential envelope, `admin-api.ts`

- Payload now bundles `initial_password`, `api_key`, `pairing_otp`, `webhook_secret` — encryption at rest is materially load-bearing.
- Write (provisioning): AES-256-GCM via `ENCRYPTION_KEY`, KV TTL 900 s, one-time token from CSPRNG. Read (redemption): platform-admin double gate retained (`requireScope('admin')` + `requirePlatformAdmin`), **KV delete executes before decrypt** — a claim token is consumed exactly once even when decryption subsequently fails (replay-safe).
- Both directions degrade silently: see V10-005.

### 6.4 `crypto-security.test.ts` quality review

All 8 `it()` blocks import production modules (`../src/lib/crypto`, `../src/gateways/enabled`) and assert real outcomes (PHC format regex, verify true/false round-trip, `rejects.toThrow` for sub-threshold cost, AES envelope round-trip, timing-safe equal/unequal/length-mismatch, OTP digit format, SHA-256 hex format, fail-closed gateway selector with typo→0-enabled + `dropped` containment). No `not.toThrow` vacuity, no reimplementation-of-subject. The V7-003 standard is now institutionalized. Gap: the 600K **default** is asserted nowhere (see V10-004).

### 6.5 CI control (`.github/workflows/audit-gate.yml`)

Byte-level verification (an initial shell-rendering artifact suggested a malformed branch filter — disproven by `Read`/grep/PyYAML, all confirming `branches: [main, master]`): the workflow triggers correctly on push/PR to main+master and runs `npm ci` → `verify-config` → `verify-remediations` → `typecheck` → zero-`as any` guard → `lint` → `npm test`. It does not run `npm run package`; packaging enforcement remains local-only.

---

## 7. New Findings

### V10-001 (P3) — Distribution channel still ships `.dev.vars`; V9-001 marked FIXED via scope redefinition — 5th consecutive round

**Evidence.** `upload/edgepay-cf-clean-new-8.zip` contains `edgepay-cf/.dev.vars` (189 B, mtime 2026-09-02 06:36, byte-identical to new-7's copy, md5 `a2b02d291da90772e8ca2bbb61e5960f`; dev-only values, rotated in R6 — not production secrets). The remediation ledger row states: `V9-001 | FIXED | scripts/package-release.mjs | "Comprehensive exclusion of .dev.vars across all archive packaging."`

**Analysis.** "All archive packaging" covers only the inner release archive produced by `package-release.mjs`. The outer hand-off zip — the artifact actually distributed — is created ad hoc outside every gate, and has now carried `.dev.vars` in new-3/4, new-5, new-6, new-7, and new-8. This is the second consecutive round in which this finding class is marked FIXED by narrowing the verified surface to the artifact the gate controls (R8 flagged the identical pattern on V8-003). Confidentiality impact is bounded (values are dev-only), but the ledger's "all archive packaging" wording is factually inaccurate for the distribution channel, and the fix is one `zip -x` or one wrapper script away.

**Fix.** Script the hand-off packaging (`make handoff` / `scripts/package-handoff.mjs`) with the same exclusion battery, or make the signed release archive the sole distribution artifact. Amend the V9-001 row to describe the actual verified surface.

### V10-002 (P4) — Shipped archive embeds stale count documents (259 vs 260); archive↔tree content equality regressed to 231/233

**Evidence.** §5.2. The shipped `dist/edgepay-cf-release.zip` internally declares 259 tests in both `TEST_RESULTS.md` and `docs/REMEDIATIONS.md`; the delivered tree and two independent battery runs produce 260. Archive mtime `21:37:02`, docs' final mtimes `21:37:08/12`.

**Analysis.** The release artifact was built from a tree state that predates the final documentation edit by seconds and was not rebuilt afterward. A downstream verifier who trusts the archive's self-description will conclude 259; one who rebuilds will conclude 260 — the exact count-drift genre this series has chased since V6-004/V7-004. Corollary drift: version self-labels disagree across artifacts (`package.json` 0.3.0, `TEST_RESULTS.md` "v0.4.3", manifest 0.4.4).

**Fix.** Re-run `npm run package` after any documentation edit that the archive embeds (or make the packager stamp counts/versions itself from a single source), and reconcile the three version labels.

### V10-003 (P4) — Binary exclusion remains a type blacklist; non-image binaries enter the signed "clean" archive

**Evidence.** §5.3 — planted root `invoice.pdf`, `backup.zip`, `video.mp4` all appear in `dist/edgepay-cf-release.zip` (staged 236 = 233 + 3) while the packager reports "verified successfully"; the post-build pattern battery has no rule for non-image binary extensions.

**Analysis.** V9-003's fix generalized the root-PNG leak to all *image* types but retained the blacklist design. The failure mode is unchanged in kind: any new binary class (`.pdf`, `.zip`, `.mp4`, `.docx`, `.exe`, dumps…) placed anywhere outside the two asset directories ships inside a gate-blessed, manifest-hashed artifact. The shipped new-8 archive itself contains no such files — this is a latent control gap, not an active leak.

**Fix.** Invert the design: allowlist known-safe text/code extensions plus explicit asset directories, deny everything else (the R7/R8 recommendation); minimally, extend both the tree filter and the post-build battery with a binary-extension set and treat unknown extensions at root as fatal.

### V10-004 (P4) — 600K default unpinned by any test; "OWASP 600K Compliance" block overstates coverage; free-tier knob only half-wired

**Evidence.** `crypto-security.test.ts`'s first describe block is titled "PBKDF2 Password Hashing & OWASP 600K Compliance (EDGE-P2-017)" but both cases run at explicit 10,000/5,000 costs. No test in the suite references 600,000 or asserts the no-arg default of `hashPassword()`. `PBKDF2_ITERATIONS` env override is read only in `install.ts:138`.

**Analysis.** A regression of `PBKDF2_ITERATIONS` to the pre-fix 50,000 (or lower) keeps the entire suite green, including the block whose title claims 600K compliance. Separately, on a strictly-free-tier deployment, provisioning (`admin-api.ts:344`) and bootstrap (`bootstrap.ts:73`) would exceed the 10 ms CPU budget at 600K since neither site honors the documented env escape hatch — the module comment promises a capability the wiring only half-delivers.

**Fix.** One assertion closes the gap: `expect((await hashPassword('x')).split('$')[1]).toBe('600000')` (or export the constant). Route the env override through a single helper used by all three hash sites.

### V10-005 (P3) — V3-004 encryption is best-effort fail-open and has zero integration coverage

**Evidence.** Write path (`admin-api.ts:428-436`): `if (ENCRYPTION_KEY) { try { encrypt } catch { store plaintext } }` — missing key or encrypt failure (e.g. malformed key material) stores the full credential bundle (`initial_password`, `api_key`, `pairing_otp`, `webhook_secret`) in KV as plaintext JSON, silently — no log, no metric, no failure. Read path (`:283-291`): decrypt failure falls back to treating ciphertext as payload; `JSON.parse` then throws → unhandled 500, after the token was already deleted. Test coverage: the only tests touching `/merchants/claim` (PoC-5, `audit-poc-r4.test.ts`) seed KV with hand-written **plaintext** fixtures (line 197) and assert gating/one-time semantics — the compatibility shim is what's tested; the encryption behavior (and both fallback paths) is untested. `install.ts`'s `secretPosture` reports key posture as a diagnostic but enforces nothing at runtime.

**Analysis.** The codebase's runtime decrypt sites (`payment.ts:212`, `refund.ts:189`, `webhooks.ts:126`) share a skip-on-fail philosophy, so the pattern is stylistically consistent — but those sites guard rows written by other tooling, whereas the claim KV bundle is born inside this code path, where fail-closed is cheap and the EDGE-P2-016 fail-closed precedent already exists in the same release. The threat model is real: KV snapshots, misconfigured deployments, or a future KV export would expose live merchant credentials in plaintext with no signal to operators.

**Fix.** Fail the provisioning request (500) when `ENCRYPTION_KEY` is absent or `encrypt()` throws — a merchant that cannot be provisioned safely should not be provisioned. Emit a metric/log line on decrypt failure at redemption. Add an integration test: provision → assert KV value is not `{`-prefixed and not parseable as the plaintext payload → claim → assert round-trip and one-time deletion.

---

## 8. Carried / Open Items (status unchanged unless noted)

1. **Production JWT_SECRET rotation** — highest OPEN operational item; refresh-token validity window continues to run; not verifiable from hand-off artifacts.
2. **Live OpenAPI staleness** — re-fetched this round: still `v0.3.0`, 38 paths; `/api/admin/v1/merchants` (GET/POST), `/merchants/claim`, and merchant webhook registration (POST/GET/DELETE `/api/v1/webhooks`) remain implemented-but-unspecced. Contract drift between the deployed spec and code persists (carried from the architecture round).
3. **CSRF middleware mount, `createIntent` unique constraint** — remain the standing PARTIAL/OPEN ledger rows; untouched this round, honestly carried.
4. **Citation-relevance WARNs** — 7 notices persist (benign).
5. **workerd teardown hang** — not observed this round; first fully clean exit since R5 (improvement, noted).

---

## 9. Conclusion

Report 8's remediation declarations are **the most faithful of the series**: every number is exact, every declared edit is real, the change surface contains nothing undeclared, and the new test suite meets the discriminating-power bar set after V7-003. The packaging exclusions close every leak class Report 8 demonstrated, and the crypto hardening is genuine and backward-compatible.

The residual risk concentrates exactly where it has for five rounds: **the boundary between the gated artifact and the actually-distributed artifact**. The release archive is now clean, self-describing, and reproducible — but the hand-off zip still carries `.dev.vars` under a ledger row that says the problem is comprehensively solved (V10-001), and the archive's embedded self-description has already drifted from the tree it was cut from (V10-002). V10-003/004/005 are all the same species in miniature: controls that verify the happy path and stay silent at the edges — binary types the blacklist never learned, a cost constant no test pins, an encryption envelope that quietly stops encrypting. Each is a one-line-to-one-day fix; none requires architectural change.

**Priority order for the next round:** (1) gate the hand-off channel and correct the V9-001 ledger row; (2) fail-closed on claim encryption + its first integration test; (3) pin the 600K default in the suite; (4) allowlist-based binary filter; (5) rebuild-on-doc-edit discipline. Production JWT_SECRET rotation remains overdue regardless of code state.

---

*Verification artifacts retained at `/home/z/my-project/audit-r9/{new8-raw, run-tree}`; pollution-experiment archive and repack logs under `audit-r9/run-tree/dist/`. Report 10 will verify this round's findings (V10-001..V10-005) against the next hand-off.*
