# Changelog

All notable changes to EdgePay-CF will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-09-14

### Breaking Changes
- **Installer `--destroy` Safety Gate**:
  - In interactive mode, users must explicitly type the deployment name (e.g. `edgepay-prod`) to confirm permanent deletion of D1, KV, R2, and Queue resources.
  - In non-interactive mode (`--yes` or non-TTY), `--destroy` will halt with exit code 1 unless `--i-know-what-im-doing` is explicitly provided.
- **Installer `--preview` vs `--dry-run` Separation**:
  - `--preview`: Pure read-only verification mode. Inspects configuration, authenticates with Cloudflare, prints target infrastructure plan, and exits with zero Cloudflare or filesystem mutations.
  - `--dry-run`: Provisions infrastructure on Cloudflare (D1, KV, R2, Queues), generates `wrangler.jsonc`, runs database migrations, sets secrets, but stops before deploying Worker code.
- **Foreign Resource Adoption Blocked**:
  - `provisionAll` refuses to silently adopt pre-existing Cloudflare resources with matching names unless they were previously recorded in state during resumption. Fails closed with a descriptive error.
- **`pushAllSecrets` Signature**:
  - Returns `Promise<InitSecrets>` instead of `Promise<void>` to return active credentials for local variable syncing.

### Added
- **Private `.dev.vars` Storage**:
  - Installer writes local secrets with strict `0o600` (user-read/write only) file permissions.
  - Scoped by `# managed by @edgepay/init` marker header to prevent reading unmanaged foreign environment files.
- **Queue Teardown Ordering**:
  - Teardown deletes primary producer/consumer queues before dead-letter queues (`DLQ`) to comply with Cloudflare API code `11005`.
  - Deployment-scoped queue naming (`${deployment_name}-*`) prevents cross-deployment queue collisions on shared Cloudflare accounts.
- **Installer Resilience**:
  - Added exponential backoff retry for transient network failures and HTTP 429 rate limits.
  - Narrowed resource deletion error detection to prevent masking authentication and authorization failures as missing resources.
  - Destructive teardown sets `process.exitCode = 1` if any resource encounters errors during deletion.
- **Canonical Bootstrapper Script**:
  - Canonical 1-line installer served via `scripts/install.sh`.
