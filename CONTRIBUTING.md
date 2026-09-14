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
