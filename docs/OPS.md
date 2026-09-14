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

> [!NOTE]
> **Workers AI cost note:** The SMS parser uses Workers AI as a third-tier fallback when regex and heuristics fail. Each call to `@cf/meta/llama-3.1-8b-instruct` consumes Neurons from your Workers AI quota (10,000/day on the free tier; paid after). Typical installations: <500 Neurons/day. High-volume installations (>10,000 SMS/day with >5% parse-miss rate) may exceed the free tier. Monitor your Workers AI usage in the Cloudflare dashboard.

---

## 5. Scheduled CI Automation (Nightly & PR)

The destroy→install cycle is automated in GitHub Actions via [`.github/workflows/installer-live-check.yml`](../.github/workflows/installer-live-check.yml):
- **Nightly Schedule**: Every day at 02:00 UTC.
- **Pull Request Trigger**: On any PR changing files in `packages/init/**`.
- **Manual Trigger**: Supports `workflow_dispatch` on demand.

### Pipeline Secrets Required:
- `CLOUDFLARE_API_TOKEN`: Minimal 8-permission scoped token (see below).
- `CLOUDFLARE_ACCOUNT_ID`: `17347346d8cc54bbb820a0a0413d98c0`.
- `EDGEPAY_SCRATCH_ACCOUNTS`: `17347346d8cc54bbb820a0a0413d98c0`.
- `EDGEPAY_DESTROY_CONFIRMED`: `yes`.

### CI Token Permissions (Least Privilege):

To adhere to least-privilege security and prevent blast-radius propagation across Cloudflare resources, the `CLOUDFLARE_API_TOKEN` secret must **never** be an account-wide administrator token. It must be scoped strictly to the following 8 permission groups:

| Permission Group | Level | Purpose |
| :--- | :--- | :--- |
| **Account · Account Settings** | Read | Account validation (`wrangler whoami`) |
| **Account · Workers Scripts** | Edit | Deploy & delete worker scripts (`wrangler deploy`, `wrangler delete`) |
| **Account · Workers KV Storage** | Edit | Namespace provisioning & teardown (`wrangler kv namespace`) |
| **Account · Workers R2 Storage** | Edit | Bucket provisioning & teardown (`wrangler r2 bucket`) |
| **Account · Workers Queues** | Edit | Queue provisioning, consumer attachment & teardown (`wrangler queues`) |
| **Account · D1** | Edit | Database provisioning, schema migrations & teardown (`wrangler d1`) |
| **Account · Workers AI** | Edit | Fallback SMS parsing AI model binding (`@cf/meta/llama-3.1-8b-instruct`) |
| **User · User Details** | Read | User verification (`wrangler whoami`) |

#### Token Configuration Rules:
1. **Account Resources**: Set to `Include · <your scratch account only>` (e.g. `17347346d8cc54bbb820a0a0413d98c0`). Do **not** use wildcards (`*`) and do **not** grant any zone-level permissions.
2. **TTL & Rotation**: Maximum validity of **90 days**. When the token expires, the CI job fails loudly to enforce a regular rotation discipline.
3. **Pre-flight Local Verification**:
   ```bash
   export CLOUDFLARE_API_TOKEN="<new-token>"
   export CLOUDFLARE_ACCOUNT_ID="17347346d8cc54bbb820a0a0413d98c0"

   # Allowed operations (must succeed):
   npx wrangler whoami
   npx wrangler d1 list
   npx wrangler kv namespace list
   npx wrangler r2 bucket list
   npx wrangler queues list

   # Denied operations (must fail with permission denied):
   npx wrangler pages project list 2>&1 || echo "correctly denied"
   npx wrangler r2 bucket list --jurisdiction eu 2>&1 || echo "correctly denied"
   ```

### Success Gates:
- Total wall-clock time under 300 seconds (measured fresh install is ~2m 29s).
- HTTP 200 with `status: ok` and all 3 subsystems (`durable_objects`, `workflows`, `workers_ai`) true.
- Zero untracked or unscoped resources remaining on the account.

---

## 6. Checkout Operations & Phase Verification Invariants

### A. Phase Verification Standing Item: Browser Testing for State-Changing Pages
> [!IMPORTANT]
> **Standing Invariant**: Every user-facing page that POSTs (e.g. `/checkout/:token`, payment verification, merchant/admin forms) must be opened and exercised in a real browser at least once per phase.
> Unit and integration tests that mock HTTP requests or inject headers manually cannot detect discrepancies between server-side CSRF validation middleware and client-side HTML/JS token emission (such as missing CSRF `<meta>` tags or unsent `X-CSRF-Token` headers).

### B. Checkout Operations: "Payment Unavailable" / "Contact Merchant"
> [!NOTE]
> If a customer reports "Payment Unavailable" or "Contact merchant," the merchant has no active gates configured.
> Check:
> ```sql
> SELECT * FROM op_gates WHERE merchant_id = ? AND status = 'active';
> ```
> If empty, either the merchant's onboarding didn't create a gate, or all gates were archived. The `checkout_no_gates` metric fires on every occurrence — alerting on it in Cloudflare Analytics Engine catches this misconfiguration before the merchant does.

### C. Gate Destination Number Administration

Backfilled gates created by migration `0014` have `mfs_number = NULL` because `op_gateways` has no phone number column. Checkout resolves the destination number by fallback:

    gate.mfs_number
      ?? manualGateway.account_number
      ?? manualGateway.payment_number
      ?? "Contact merchant"

To set the primary number for a gate, use:

    PATCH /api/admin/v1/gates/:id
    { "mfs_number": "01712345678" }

This is the canonical fix when a merchant reports "Contact merchant" in checkout and they don't have an `op_manual_gateways` row configured.



