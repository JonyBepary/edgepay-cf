# Changelog

All notable changes to EdgePay-CF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-14

### Security & Safety Incident Report: Pre-Release Queue Collision Near-Miss (Mitigated by External Validation, Root Cause Fixed)
- **Incident Summary**: During automated verification of pre-release installer teardown routines, scratch testing passed un-scoped production queue names (`webhook-out`, `webhook-out-dlq`, `email-out`, `sms-parse`). `destroyAll` attempted to delete these queues on the active Cloudflare account.
- **Mitigating Factor**: Cloudflare API error `11005` (`Cannot delete queue that serves as dead letter queue for consumers`) prevented the destructive deletion of production queues because teardown attempted to delete DLQs before primary consumers were unbound.
- **Root Causes**:
  1. Queues lacked mandatory deployment-name scoping and were not isolated per deployment.
  2. `ensureQueue` and `provisionAll` silently adopted foreign pre-existing account resources when names matched.
  3. Scratch tests did not enforce random synthetic isolation prefixes.
- **Permanent Remediation**:
  1. **Deployment Scoping**: All queues are strictly scoped via `getDeploymentQueueNames(deploymentName)` (e.g. `my-shop-webhook-out`).
  2. **Fail-Closed Resource Adoption Protection**: `ensureD1`, `ensureKv`, `ensureR2`, and `ensureQueue` throw explicit fatal errors refusing to adopt existing account resources unless the resource ID matches the active installer session (`expectedExistingId`).
  3. **Exact Column Parsing (`parseQueueList`)**: Replaced substring checks (`l.includes(name)`) with strict table column parsing to eliminate false positive collisions between primary queues and `-dlq` suffixes.
  4. **Strict Teardown Ordering**: Primary consumer/producer queues are always deleted before dead-letter queues.
  5. **Automated CI Regression Guards**: Unit and isolation tests verify synthetic non-default deployment queues never collide with default production queue names.
- **Operational Recurrence Prevention**: Destroy is now gated on an account allowlist (`EDGEPAY_SCRATCH_ACCOUNTS`) and independent environment confirmation (`EDGEPAY_DESTROY_CONFIRMED=yes`); CI runs against a dedicated scratch account.

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
