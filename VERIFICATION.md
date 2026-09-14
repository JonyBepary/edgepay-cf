# EdgePay-CF v0.5.0 Verification & Evidence Record

This document records the empirical verification and raw evidence gathered to validate the installer, error handling, safety gates, and CI automation.

---

## 1. GitHub Actions CI Verification

The Gitleaks Action workflow ([`.github/workflows/gitleaks.yml`](.github/workflows/gitleaks.yml)) was corrected to remove the invalid `args` input that caused GitHub Actions runner errors. Additionally, `remoteBindings: false` was set in [`vitest.config.ts`](vitest.config.ts) so Vitest runs workerd tests locally without attempting to initiate a remote proxy session for Workers AI in unauthenticated CI environments.

### Live Runs Observed on GitHub Actions:
- **Installer Live Verification (Timed Destroy→Install Regression Loop)**:
  - **Run ID**: `34819181558`
  - **Status**: `completed`, **Conclusion**: `success` (Green checkmark)
  - **Duration**: 2m 40s (under 300s budget)
  - **Pre-run Teardown**: Cleaned any lingering state.
  - **Fresh Installation**: Provisioned isolated scoped deployment `edgepay-fresh` with D1, KV, R2, and Queues using the minimal 8-permission scoped token.
  - **Health Probes**:
    - Primary (`/api/v1/health`): `{"status":"ok","durable_objects":true,"workflows":true,"workers_ai":true}`
    - Alias (`/health`): `{"status":"ok","durable_objects":true,"workflows":true,"workers_ai":true}`
    - Dashboard (`/merchant`): HTTP 200 OK
  - **Post-run Teardown**: Detached queue consumers, deleted worker, deleted scoped queues, deleted D1 database, deleted KV namespace, deleted R2 bucket. Zero remote resources remaining.
- **Gitleaks Secret Scan**:
  - **Run ID**: `34819179929` (and prior `34815584710`, `34813042052`)
  - **Status**: `completed`, **Conclusion**: `success` (Green checkmark)
  - **Step 1 (`Run gitleaks secret detection`)**: Executed cleanly, logged `✅ No leaks detected`.
  - **Step 2 (`Block known secret variable names with live values`)**: Evaluated repository with zero matches, logged `No live secret assignments found`.
- **Audit Gate & Verification CI**:
  - **Run ID**: `34819179923` (and prior `34815584753`, `34813041941`)
  - **Status**: `completed`, **Conclusion**: `success` (Green checkmark)
  - **Test Suite**: 40 files, 404 tests passed, 0 failures, lint and typecheck 100% clean.

---

## 2. Live-Captured Cloudflare Error Codes & Messages

Raw evidence file: [`evidence/cf_notfound_codes.txt`](evidence/cf_notfound_codes.txt)

Captured directly against Cloudflare account `17347346d8cc54bbb820a0a0413d98c0` using Wrangler v4.127.1:

| Resource | Command Executed | Captured Output / Error Code |
| :--- | :--- | :--- |
| **D1** | `wrangler d1 delete 00000000-0000-0000-0000-000000000000 --skip-confirmation` | `Couldn't find a D1 DB with name or binding '...' in your config or the API.` |
| **KV** | `wrangler kv namespace delete --namespace-id 0123456789abcdef0123456789abcdef` | `namespace not found [code: 10013]` (Invalid format returns `[code: 10011]`) |
| **R2** | `wrangler r2 bucket delete nonexistent-bucket-12345` | `The specified bucket does not exist. [code: 10006]` |
| **Queue** | `wrangler queues delete nonexistent-queue-12345` | `Queue "nonexistent-queue-12345" does not exist. To create it, run: wrangler queues create ...` |
| **Worker** | `wrangler delete nonexistent-worker-12345 --force` | `This Worker does not exist on this account. [code: 10090]` |

The error classification function [`isNotFound`](packages/init/src/wrangler.ts) in `@edgepay/init` strictly matches these empirically captured CLI strings and codes (and intentionally omits uncaptured theoretical codes like `7000` or `11001`), while explicitly rejecting non-404 errors (auth `10000`, permission `10007`, user `10008`, account `10002`).

---

## 3. Queue List Format & JSON Verification

Running `npx wrangler queues list --json` on Wrangler v4.127.1 returns:
```text
✘ [ERROR] Unknown argument: json
```
Wrangler CLI does not support `--json` on `wrangler queues list`. Consequently, `parseQueueList` in [`packages/init/src/wrangler.ts`](packages/init/src/wrangler.ts) implements exact column parsing on the ASCII table:
- It splits rows by `│` delimiters.
- `parts[2]` corresponds strictly to the `name` column.
- Lookup uses exact equality: `queues.find((q) => q.name === name)`.
- Verified in [`packages/init/tests/installer.test.ts`](packages/init/tests/installer.test.ts): a table containing only `webhook-out-dlq` does NOT match `ensureQueue('webhook-out')`, completely eliminating the substring matching false-positive failure mode.

---

## 4. Test Determinism Battery (10 Consecutive Runs)

Raw evidence file: [`evidence/test_runs.txt`](evidence/test_runs.txt)

Command executed:
```bash
for i in $(seq 1 10); do echo "=== Run $i $(date -Iseconds) ===" && npx vitest run 2>&1 | grep -E "Tests|Files|Duration"; done > evidence/test_runs.txt
```

Log summary:
- **Run 1** (11:48:52): 40 files, 404 tests passed, duration 16.56s
- **Run 2** (11:49:10): 40 files, 404 tests passed, duration 15.55s
- **Run 3** (11:49:27): 40 files, 404 tests passed, duration 15.39s
- **Run 4** (11:49:44): 40 files, 404 tests passed, duration 15.58s
- **Run 5** (11:50:01): 40 files, 404 tests passed, duration 15.98s
- **Run 6** (11:50:18): 40 files, 404 tests passed, duration 15.37s
- **Run 7** (11:50:35): 40 files, 404 tests passed, duration 16.94s
- **Run 8** (11:50:53): 40 files, 404 tests passed, duration 15.62s
- **Run 9** (11:51:11): 40 files, 404 tests passed, duration 16.40s
- **Run 10** (11:51:29): 40 files, 404 tests passed, duration 15.83s

**Result**: 10/10 runs green (404/404 tests each run, 0 failures, 0 flakes).

---

## 5. Live Scoped Queues Confirmation & Reconstruction Timeline

Raw evidence files:
- Current queues listing: [`evidence/live_queues.txt`](evidence/live_queues.txt)
- Complete chronological queue audit: [`evidence/queue_timeline.txt`](evidence/queue_timeline.txt) (197 events across 397 logs)

Executing `npx wrangler queues list` against account `17347346d8cc54bbb820a0a0413d98c0` reports strictly scoped queues:
- `edgepay-fresh-email-out`
- `edgepay-fresh-email-out-dlq`
- `edgepay-fresh-sms-parse`
- `edgepay-fresh-sms-parse-dlq`
- `edgepay-fresh-webhook-out`
- `edgepay-fresh-webhook-out-dlq`

### Chronological Decommission & Teardown Reconstruction:
The legacy unscoped queues (`webhook-out`, `email-out`, `sms-parse` and their `-dlq` siblings) were removed in two distinct passes:
1. **Initial Decommission (03:33 - 03:35 UTC)**: In response to audit findings and the planned transition to scoped naming, the agent executed a cleanup sweep to detach consumers and delete the pre-existing unscoped queues created on 2026-09-03 (logs `wrangler-2026-09-14_03-35-04_298.log` through `_03-35-46_709.log`).
2. **Recreation During Installer Test (03:56 - 03:57 UTC)**: A subsequent fresh clone installation test in `/home/jony/edgepay-fresh-test` inadvertently recreated the unscoped queues because the installer's provisioning logic at that commit had not yet enforced deployment queue scoping, falling back to default unscoped values from `wrangler.jsonc` (e.g. `webhook-out` created at `03:56:29Z` in `wrangler-2026-09-14_03-56-33_984.log`).
3. **Automated Teardown Delete (04:26 - 04:27 UTC)**: When `edgepay-init --destroy` was subsequently tested against `edgepay-fresh-test`, it recovered configuration from `wrangler.jsonc` and executed `destroyAll`, detaching consumers and deleting the recreated unscoped queues (logs `wrangler-2026-09-14_04-26-55_785.log` through `_04-27-41_104.log`).
4. **Scoped Architecture Established (04:32 - 05:10 UTC)**: Deployment-scoped queue naming (`getDeploymentQueueNames`) was implemented and verified. All fresh installs provision strictly isolated queues (`edgepay-fresh-*`).

Zero unscoped queues remain. The complete chronological sequence of all 197 queue actions on this account is substantiated in [`evidence/queue_timeline.txt`](evidence/queue_timeline.txt).

---

## 6. Adoption Protection Test Matrix

Confirmed in [`packages/init/tests/installer.test.ts`](packages/init/tests/installer.test.ts#L410-L541):
1. **D1**: Mismatched UUID throws `Refusing to adopt` (line 410); matched UUID returns ID (line 418); unadopted existing throws with flag guidance (line 542); `adoptExisting: true` passes (line 554).
2. **KV**: Mismatched ID throws (line 425); matched ID returns ID (line 433); `adoptExisting: true` passes (line 558).
3. **R2**: Mismatched bucket name throws (line 440); matched name returns name (line 448); `adoptExisting: true` passes (line 562).
4. **Queue**: Mismatched queue name throws (line 455); matched name returns name (line 470); `adoptExisting: true` passes (line 573).

---

## 7. Provisioning Queue Helper Usage

`grep -n "getDeploymentQueueNames\|'webhook-out'\|\"webhook-out\"" packages/init/src/provision.ts` confirms:
- Line 50: Used only in `detectLegacyQueueBindings` for backward compatibility detection.
- Line 58: Definition of `getDeploymentQueueNames`.
- Line 170: `provisionAll` binds `queuePlan = getDeploymentQueueNames(config.deployment_name, ...)`.
- Line 209: `destroyAll` binds `queuePlan = getDeploymentQueueNames(config.deployment_name)`.

There are zero hardcoded raw queue names in the provisioning or deletion pipelines.

---

## 8. Verification of Preview & Legacy Credential Adoption

Confirmed in [`packages/init/tests/installer.test.ts`](packages/init/tests/installer.test.ts):
- **Preview Skips Network Auth**: A test spies on `ensureAuth` via `vi.spyOn(authModule, 'ensureAuth')` and asserts `expect(ensureAuthSpy).not.toHaveBeenCalled()`, verifying that when `.edgepay-init.json` exists with `auth_done: true`, `--preview` executes strictly against memory/disk state without calling Cloudflare APIs.
- **Legacy `.dev.vars` Preservation**: A test calls `readDevVars` on an unmanaged `.dev.vars` with `adoptLegacyDevVars: true` and verifies that existing credentials (`JWT_SECRET`, `APP_KEY`, `ENCRYPTION_KEY`) are parsed and preserved intact without secret regeneration or rotation.
