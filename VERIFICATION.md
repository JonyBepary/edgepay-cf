# EdgePay-CF v0.5.0 Verification & Evidence Record

This document records the empirical verification and raw evidence gathered to validate the installer, error handling, safety gates, and CI automation.

---

## 1. Gitleaks CI Workflow Configuration

The Gitleaks Action workflow ([`.github/workflows/gitleaks.yml`](.github/workflows/gitleaks.yml)) was corrected to remove the invalid `args` input:

```yaml
      - name: Run gitleaks secret detection
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

The step now runs with official action defaults, while the secondary `Block known secret variable names with live values` step enforces the tightened Perl regex (`["']?[A-Za-z0-9+/=]{40,}["']?[;,]?\s*$`) with strict path exclusions.

---

## 2. Live-Captured Cloudflare Error Codes & Messages

Raw evidence file: [`evidence/cf_notfound_codes.txt`](evidence/cf_notfound_codes.txt)

Captured directly against Cloudflare account `17347346d8cc54bbb820a0a0413d98c0` using Wrangler v4.127.1:

| Resource | Command Executed | Captured Output / Error Code |
| :--- | :--- | :--- |
| **D1** | `wrangler d1 delete 00000000-0000-0000-0000-000000000000 --skip-confirmation` | `Couldn't find a D1 DB with name or binding '...' in your config or the API.` (Cloudflare REST code `7000`) |
| **KV** | `wrangler kv namespace delete --namespace-id 0123456789abcdef0123456789abcdef` | `namespace not found [code: 10013]` (Invalid format returns `[code: 10011]`) |
| **R2** | `wrangler r2 bucket delete nonexistent-bucket-12345` | `The specified bucket does not exist. [code: 10006]` |
| **Queue** | `wrangler queues delete nonexistent-queue-12345` | `Queue "nonexistent-queue-12345" does not exist. To create it, run: wrangler queues create ...` |
| **Worker** | `wrangler delete nonexistent-worker-12345 --force` | `This Worker does not exist on this account. [code: 10090]` |

The error classification function [`isNotFound`](packages/init/src/wrangler.ts) in `@edgepay/init` is directly calibrated against these captured strings and error codes, while explicitly rejecting non-404 errors (auth `10000`, permission `10007`, user `10008`, account `10002`).

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

## 5. Live Scoped Queues Confirmation

Raw evidence file: [`evidence/live_queues.txt`](evidence/live_queues.txt)

Executing `npx wrangler queues list` against account `17347346d8cc54bbb820a0a0413d98c0` reports:
- `edgepay-fresh-email-out`
- `edgepay-fresh-email-out-dlq`
- `edgepay-fresh-sms-parse`
- `edgepay-fresh-sms-parse-dlq`
- `edgepay-fresh-webhook-out`
- `edgepay-fresh-webhook-out-dlq`

Zero unscoped production queues (`webhook-out`, `email-out`, `sms-parse`) exist on the account.

---

## 6. Adoption Protection Test Matrix

Confirmed in [`packages/init/tests/installer.test.ts`](packages/init/tests/installer.test.ts#L410-L541):
1. **D1**: Mismatched UUID throws `Refusing to adopt` (line 410); matched UUID returns ID (line 418); unadopted existing throws with flag guidance (line 508); `adoptExisting: true` passes (line 520).
2. **KV**: Mismatched ID throws (line 425); matched ID returns ID (line 433); `adoptExisting: true` passes (line 524).
3. **R2**: Mismatched bucket name throws (line 440); matched name returns name (line 448); `adoptExisting: true` passes (line 528).
4. **Queue**: Mismatched queue name throws (line 455); matched name returns name (line 470); `adoptExisting: true` passes (line 539).

---

## 7. Provisioning Queue Helper Usage

`grep -n "getDeploymentQueueNames\|'webhook-out'\|\"webhook-out\"" packages/init/src/provision.ts` confirms:
- Line 50: Used only in `detectLegacyQueueBindings` for backward compatibility detection.
- Line 58: Definition of `getDeploymentQueueNames`.
- Line 170: `provisionAll` binds `queuePlan = getDeploymentQueueNames(config.deployment_name, ...)`.
- Line 209: `destroyAll` binds `queuePlan = getDeploymentQueueNames(config.deployment_name)`.

There are zero hardcoded raw queue names in the provisioning or deletion pipelines.
