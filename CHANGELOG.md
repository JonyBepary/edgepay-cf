# Changelog

All notable changes to EdgePay-CF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-14

### Security & Safety Incident Report: Pre-Release Queue Deletion and Cross-Deployment Teardown Collision (Resolved & Architecturally Hardened)
- **Incident Summary**: During automated verification and decommissioning of pre-release installer routines on Cloudflare account `17347346d8cc54bbb820a0a0413d98c0`, cross-deployment naming collisions occurred across two distinct deletion events:
  1. **Pass 1 (03:33 - 03:35 UTC)**: In transitioning the account to scoped naming, an agent cleanup sweep detached consumers and deleted the pre-existing unscoped queues (`webhook-out`, `email-out`, `sms-parse`, and their `-dlq` siblings).
  2. **Recreation & Pass 2 (03:56 - 04:27 UTC)**: A subsequent fresh clone installation test in `edgepay-fresh-test` inadvertently recreated the unscoped queues because provisioning had not yet enforced deployment scoping. When `edgepay-init --destroy` was subsequently tested at 04:26 UTC, it recovered configuration from `wrangler.jsonc` and executed `destroyAll`, deleting the recreated unscoped queues. Complete forensic reconstruction is recorded in `evidence/queue_timeline.txt`.
- **Blast Radius**: Unscoped queues on the test account were deleted. While early runs at 02:36 UTC were partially halted by Cloudflare API code `11005` on DLQs, subsequent scripted sweeps explicitly detached consumers and executed the deletions.
- **Root Causes**:
  1. Queues lacked mandatory deployment-name scoping and were not isolated per deployment.
  2. `ensureQueue` and `provisionAll` silently adopted foreign pre-existing account resources when names matched.
  3. Scratch tests did not enforce random synthetic isolation prefixes.
  4. Destroy routines lacked fail-closed account allowlists and explicit dual-confirmation flags.
- **Permanent Architectural Remediation**:
  1. **Mandatory Deployment Scoping**: All queues are strictly scoped via `getDeploymentQueueNames(deploymentName)` (e.g. `edgepay-fresh-webhook-out`).
  2. **Fail-Closed Resource Adoption Protection**: `ensureD1`, `ensureKv`, `ensureR2`, and `ensureQueue` throw explicit fatal errors refusing to adopt existing account resources unless the resource ID matches the active installer session (`expectedExistingId`) or `--adopt-existing-resources` is explicitly passed.
  3. **Exact Column Parsing (`parseQueueList`)**: Replaced substring checks with strict ASCII table column parsing, completely eliminating substring collisions between primary queues and `-dlq` suffixes.
  4. **Strict Teardown Ordering**: Consumer workers are detached from primary queues before worker deletion, and primary queues are always deleted before dead-letter queues.
  5. **Safety Gates & Account Allowlist**: Non-interactive destroy strictly requires `--i-know-what-im-doing` AND `EDGEPAY_DESTROY_CONFIRMED=yes`, and refuses execution unless the account is explicitly listed in `EDGEPAY_SCRATCH_ACCOUNTS`.

### Breaking Changes
- **Installer `--destroy` Safety Gate & Dual Signal**:
  - In interactive mode, users must explicitly type the deployment name (e.g. `edgepay-prod`) to confirm permanent deletion of D1, KV, R2, and Queue resources.
  - In non-interactive mode (`--yes` or non-TTY), `--destroy` strictly requires **both** `--i-know-what-im-doing` AND the environment variable `EDGEPAY_DESTROY_CONFIRMED=yes`.
  - If `EDGEPAY_SCRATCH_ACCOUNTS` is set, `--destroy` halts unless the target account ID is present in the allowlist.
- **Explicit Resource Adoption (`--adopt-existing-resources`)**:
  - Pre-existing D1, KV, R2, and Queue resources in a Cloudflare account will not be adopted without either an active session match (`expectedExistingId`) or the explicit CLI flag `--adopt-existing-resources`. Fails closed with descriptive guidance.
- **Legacy `.dev.vars` Protection (`--adopt-legacy-dev-vars`)**:
  - The installer refuses to silently overwrite or rotate unmanaged `.dev.vars` files containing existing credentials. If an unmanaged file is detected, the installer halts to prevent accidental rotation and invalidation of active merchant JWTs/sessions. Users must pass `--adopt-legacy-dev-vars` to adopt and preserve existing secrets.
- **Installer `--preview` vs `--dry-run` Separation**:
  - `--preview`: Pure read-only verification mode. Inspects configuration, authenticates with Cloudflare, and runs purely in-memory with zero disk state writes, zero file mutations, and zero Cloudflare changes.
  - `--dry-run`: Provisions infrastructure on Cloudflare (D1, KV, R2, Queues), generates `wrangler.jsonc`, runs database migrations, sets secrets, but stops before deploying Worker code.
- **`pushAllSecrets` Signature**:
  - Returns `Promise<InitSecrets>` instead of `Promise<void>` to return active credentials for local variable syncing.

### Added
- **Legacy Queue Compatibility**:
  - Existing installations with `wrangler.jsonc` containing unscoped queue bindings (`"queue": "webhook-out"`) automatically retain unscoped names to preserve compatibility, while fresh installs use scoped queue naming (`${deployment_name}-webhook-out`).

### Added
- **Private `.dev.vars` Storage**:
  - Installer writes local secrets with strict `0o600` (user-read/write only) file permissions.
  - Scoped by `# managed by @edgepay/init` marker header to prevent reading unmanaged foreign environment files.
- **Queue Teardown Ordering**:
  - Teardown deletes primary producer/consumer queues before dead-letter queues (`DLQ`) to comply with Cloudflare API code `11005`.
  - Deployment-scoped queue naming (`${deployment_name}-*`) prevents cross-deployment queue collisions on shared Cloudflare accounts.
- **Installer Resilience & Provisional Error Classification**:
  - Added exponential backoff retry for transient network failures and HTTP 429 rate limits.
  - Resource deletion error classification is provisional and calibrated against live-captured Cloudflare v4 responses (D1 `Couldn't find a D1 DB` / code `7000`, KV code `10013`, R2 code `10006`, Queues `Queue "..." does not exist`), explicitly rejecting authentication, permission, user, and account errors.
  - Destructive teardown sets `process.exitCode = 1` if any resource encounters errors during deletion.
- **Canonical Bootstrapper Script**:
  - Canonical 1-line installer served via `scripts/install.sh`.
