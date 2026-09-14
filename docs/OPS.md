# EdgePay Operations & Live Verification Guide

This guide documents operations, safety invariants, and the automated destroy→install verification loop for EdgePay self-hosted Cloudflare deployments.

---

## 1. Reserved Test Deployment

To ensure end-to-end installer reliability against real Cloudflare infrastructure without risk to production merchants, a designated test deployment and account are reserved:

| Property | Value |
| :--- | :--- |
| **Reserved Account ID** | `17347346d8cc54bbb820a0a0413d98c0` |
| **Account Owner** | `bm.jonybepary@gmail.com` |
| **Worker Script Name** | `edgepay-fresh` |
| **Production URL** | `https://edgepay-fresh.bm-jonybepary.workers.dev` |
| **D1 Database** | `edgepay-fresh-db` |
| **KV Namespace** | `edgepay-fresh-kv` |
| **R2 Bucket** | `edgepay-fresh-assets` |
| **Scoped Queues** | `edgepay-fresh-webhook-out`, `edgepay-fresh-webhook-out-dlq`<br>`edgepay-fresh-email-out`, `edgepay-fresh-email-out-dlq`<br>`edgepay-fresh-sms-parse`, `edgepay-fresh-sms-parse-dlq` |

> [!CAUTION]
> Never deploy real merchant credentials or production payment volume to the `edgepay-fresh` deployment. It is continuously recycled during automated and manual regression testing.

---

## 2. Teardown Safety Gates & Isolation

EdgePay enforces multi-layered safety gates before executing destructive resource deletion:

### A. Scratch Account Allowlist (`EDGEPAY_SCRATCH_ACCOUNTS`)
The installer strictly refuses to run `--destroy` unless the target Cloudflare account is explicitly listed in `EDGEPAY_SCRATCH_ACCOUNTS`:
```bash
export EDGEPAY_SCRATCH_ACCOUNTS=17347346d8cc54bbb820a0a0413d98c0
```
If an account is not in this allowlist, teardown aborts immediately without modifying any remote resources.

### B. Dual-Confirmation Gate for CI & Non-Interactive Invocations
In non-interactive environments (CI, `--yes`, `-y`), teardown requires **both**:
1. The CLI flag `--i-know-what-im-doing` (or `--force`)
2. The environment variable `EDGEPAY_DESTROY_CONFIRMED=yes`

In interactive TTY mode, the user must explicitly type the exact deployment name (`edgepay-fresh`) to confirm.

---

## 3. Teardown Dependency Ordering

Cloudflare APIs impose strict invariants on resource deletion. `destroyAll` in `@edgepay/init` executes teardown in the exact dependency order:

1. **Detach Queue Consumers**:
   ```bash
   wrangler queues consumer remove <queue> <worker-name>
   ```
   *Cloudflare error 10064 forbids deleting any Worker while it is bound as a consumer to an active queue.* Consumers are removed from primary queues first.
2. **Delete Worker**:
   ```bash
   wrangler delete <worker-name> --force
   ```
3. **Delete Queues (Primary before DLQ)**:
   ```bash
   wrangler queues delete <queue>
   ```
   *Primary queues must be deleted before dead-letter queues (DLQs); Cloudflare error 11005 rejects deleting a DLQ while a primary queue references it.*
4. **Delete D1 Database by UUID**:
   ```bash
   wrangler d1 delete <uuid> --skip-confirmation
   ```
   *Deleting by name resolves against local bindings and fails with error 7404 if local config is out of sync. Teardown always deletes using the database UUID.*
5. **Delete KV Namespace**:
   ```bash
   wrangler kv namespace delete --namespace-id <id>
   ```
6. **Delete R2 Bucket**:
   ```bash
   wrangler r2 bucket delete <bucket-name>
   ```
7. **Clean Workflows (Best-Effort)**:
   ```bash
   wrangler workflows delete <workflow-name>
   ```

---

## 4. Manual Destroy & Install Cycle

To execute a clean teardown and fresh reinstall cycle manually:

### Step 1: Execute Teardown
```bash
EDGEPAY_SCRATCH_ACCOUNTS=17347346d8cc54bbb820a0a0413d98c0 \
EDGEPAY_DESTROY_CONFIRMED=yes \
npx @edgepay/init --destroy --i-know-what-im-doing --yes
```

### Step 2: Confirm Clean Account State
```bash
npx wrangler queues list
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler r2 bucket list
```
All four commands should report zero resources remaining.

### Step 3: Execute Fresh Installation
```bash
npx @edgepay/init --yes \
  --name=edgepay-fresh \
  --currency=BDT \
  --merchant="Fresh Test Merchant"
```

### Step 4: Verify Live System Health
```bash
# Health check (primary API route)
curl -sS https://edgepay-fresh.bm-jonybepary.workers.dev/api/v1/health

# Health check (alias route)
curl -sS https://edgepay-fresh.bm-jonybepary.workers.dev/health

# Merchant Dashboard
curl -sSi https://edgepay-fresh.bm-jonybepary.workers.dev/merchant
```

Expected Health Response:
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "version": "0.5.0",
    "environment": "production",
    "served_by": "cloudflare-workers",
    "durable_objects": true,
    "workflows": true,
    "workers_ai": true
  }
}
```

---

## 5. Scheduled CI Automation (Nightly & PR)

The destroy→install cycle will be automated in GitHub Actions to run:
- **Nightly Schedule**: Every day at 02:00 UTC.
- **Pull Request Trigger**: On any PR changing files in `packages/init/**`.

### Pipeline Secrets Required:
- `CLOUDFLARE_API_TOKEN`: Token with Workers, D1, KV, R2, and Queues permissions.
- `CLOUDFLARE_ACCOUNT_ID`: `17347346d8cc54bbb820a0a0413d98c0`.
- `EDGEPAY_SCRATCH_ACCOUNTS`: `17347346d8cc54bbb820a0a0413d98c0`.
- `EDGEPAY_DESTROY_CONFIRMED`: `yes`.

### Success Gates:
- Total wall-clock time under 4 minutes.
- HTTP 200 with `status: ok` and all 3 subsystems (`durable_objects`, `workflows`, `workers_ai`) true.
- Zero untracked or unscoped resources remaining on the account.
