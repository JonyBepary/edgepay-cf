# Contributing to EdgePay-CF

Thank you for contributing to EdgePay-CF.

## Development Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```
2. **Build Packages**:
   ```bash
   npm run build:init
   ```
3. **Run Test Suites**:
   ```bash
   npm test               # Core test suite (404 tests)
   npm run test:init      # Installer test suite
   npm run typecheck      # Type validation
   npm run lint           # ESLint verification
   ```

---

## Safety Protocol: Cloudflare Teardown & Resource Isolation

EdgePay-CF manages stateful Cloudflare resources (D1 databases, KV namespaces, R2 buckets, and Queues). To eliminate the risk of accidental data loss on shared or production Cloudflare accounts, contributors and CI pipelines **must** adhere to the following safety protocol:

### 1. Dedicated Scratch Cloudflare Accounts
- Automated tests or manual teardown experiments (`--destroy`) must **never** run against a production or shared development Cloudflare account.
- Always use a dedicated, isolated scratch Cloudflare account for testing infrastructure provisioning and teardown.

### 2. Dual-Signal Protection for Non-Interactive Destroy
To prevent automated scripts or accidental CLI invocations from nuking account resources:
- Interactive teardown prompts the user to type the deployment name explicitly.
- Non-interactive teardown (`--yes`, `-y`, or non-TTY CI environments) strictly requires **both**:
  1. The CLI flag: `--i-know-what-im-doing`
  2. The environment variable: `EDGEPAY_DESTROY_CONFIRMED=yes`
  If either signal is missing, the installer immediately halts with exit code 1.

### 3. Account Allowlisting (`EDGEPAY_SCRATCH_ACCOUNTS`)
- CI pipelines and automation environments can enforce an account allowlist by defining `EDGEPAY_SCRATCH_ACCOUNTS`:
  ```bash
  export EDGEPAY_SCRATCH_ACCOUNTS="scratch-account-id-1,scratch-account-id-2"
  ```
- If set, `--destroy` will verify that the target account ID is present in the allowlist and will abort immediately if a non-matching account is detected.

### 4. Synthetic Resource Naming
- Any test provisioning live Cloudflare resources must use dynamically generated, synthetic, prefixed names (e.g. `scratch-${Date.now()}-${uuid}-*`) and must never use default production names like `edgepay-cf`, `webhook-out`, `email-out`, or `sms-parse`.

### 5. Reserved Fresh-Install Deployment
- The `edgepay-fresh` deployment on the test account (`17347346d8cc54bbb820a0a0413d98c0`) is reserved for fresh-install testing. Do not manually modify its resources.
- For authorized teardown testing on this account, set:
  ```bash
  export EDGEPAY_SCRATCH_ACCOUNTS=17347346d8cc54bbb820a0a0413d98c0
  ```

### 6. Live-Resource Mutation Policy (Agent & Automation Protocol)
**Live-resource mutations require explicit user authorization per operation.** An automated agent (Claude, Copilot, Cursor, Antigravity, or any other) must not run `wrangler * create|delete|put` against a live account without an explicit user instruction in the same turn. Read-only operations (`list`, `info`, `tail`) are always allowed. When in doubt, propose the command and wait for confirmation.

### 7. Cloudflare Account Separation
Maintain strict physical separation between Cloudflare environments:
- **Account A (Disposable Reference / CI)**: Hosts disposable deployments (`edgepay-fresh` or prefixed with `ci-`). Automated CI runs destroy and recreate this environment. Contains zero merchant data and zero production traffic.
- **Account B (Pilot / Production)**: Reserved strictly for merchant deployments. No automated CI pipelines hold credentials with destructive permissions against this account.

---

## Secret Scanning & Test Fixtures

This repository enforces automated secret detection via Gitleaks in CI.
- Test fixtures with realistic-looking secrets use inline `// gitleaks:allow` comments on the fixture definition.
- Path-based allowlists for test suites are maintained in [`.gitleaks.toml`](.gitleaks.toml).
- Never commit live credentials or API tokens under any circumstances. Use `wrangler secret put <NAME>` for production deployment secrets.
