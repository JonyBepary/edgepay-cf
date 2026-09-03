# Runbook — Platform Secrets (P0-4)

How to generate, set, rotate, and recover the three platform secrets.
All three are **Worker secrets** — set via `wrangler secret put`, never in
`wrangler*.jsonc`, `.dev.vars` (local only), or git.

| Secret | Format | Generate |
|---|---|---|
| `JWT_SECRET` | hex, 32 bytes (`openssl rand -hex 32` → 64 hex chars; min 32 chars enforced) | `openssl rand -hex 32` |
| `APP_KEY` | base64, exactly 32 bytes | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | base64, exactly 32 bytes (AES-256-GCM) | `openssl rand -base64 32` |

Boot contract: `requireSecrets()` (`src/lib/secrets-guard.ts`) asserts all
three at boot/request entry. Any missing or malformed secret pages
`SECRETS_MISCONFIGURED` and the Worker answers **503** — fail closed, no
defaults, no fallback keys.

## 1. Initial set (per environment)

```bash
# dev (local): copy the template, fill with FRESH values, never commit
cp .dev.vars.example .dev.vars
# .dev.vars is git-ignored (.dev.vars*). Generate values:
openssl rand -hex 32        # JWT_SECRET
openssl rand -base64 32     # APP_KEY
openssl rand -base64 32     # ENCRYPTION_KEY — back this up (loss = unrecoverable credentials)

# staging / production: one command per secret, per --env
wrangler secret put JWT_SECRET --env staging
wrangler secret put APP_KEY --env staging
wrangler secret put ENCRYPTION_KEY --env staging

wrangler secret put JWT_SECRET --env production
wrangler secret put APP_KEY --env production
wrangler secret put ENCRYPTION_KEY --env production

wrangler secret list --env production   # names only — values are never readable
```

## 2. Rotation

### JWT_SECRET (mobile JWTs, HS256)

1. Generate: `openssl rand -hex 32`.
2. `wrangler secret put JWT_SECRET --env <staging|production>`.
3. Redeploy so the new secret is live: `npm run deploy -- --env <env>`.
4. **JWT invalidation:** all previously issued access/refresh tokens signed
   with the old secret fail verification immediately (HS256 has no key-id
   rollover). Every companion device must re-pair (OTP flow) and every
   session re-login. There is no grace period — schedule rotation in a
   maintenance window and announce forced re-login.
5. Confirm: issue a fresh token, verify old tokens 401, watch for
   `SECRETS_MISCONFIGURED` pages (should be none — new value is valid).

### APP_KEY (HMAC signing)

1. Generate: `openssl rand -base64 32`.
2. `wrangler secret put APP_KEY --env <env>` + redeploy.
3. Re-sign anything derived from the old key (webhook signatures recompute
   on send — no stored-state migration). Verify webhook receivers accept
   new signatures before deleting the old value from your password manager.

### ENCRYPTION_KEY (AES-256-GCM for gateway credentials + PII)

> **DANGER — plan first.** Every `op_gateway_configs.field_value` row and
> encrypted PII blob is decryptable only with the key that wrote it.
> Rotating without re-encryption **destroys access to all stored gateway
> credentials**.

1. Add a version column if not present:
   `ALTER TABLE op_gateway_configs ADD COLUMN key_version INTEGER DEFAULT 1;`
2. Deploy code that **dual-reads**: try current key, fall back to previous
   key (kept as `ENCRYPTION_KEY_PREVIOUS`), and re-encrypts on successful
   old-key read (`key_version` bump). Keep this path until `SELECT COUNT(*)`
   where `key_version < current` returns 0.
3. Backfill via Workflow: page `op_gateway_configs`, decrypt with old key,
   encrypt with new, update row + `key_version`.
4. Only then `wrangler secret put ENCRYPTION_KEY --env <env>` (new value) +
   `wrangler secret put ENCRYPTION_KEY_PREVIOUS --env <env>` (old value),
   redeploy, run backfill, verify zero old-version rows, then delete
   `ENCRYPTION_KEY_PREVIOUS`.
5. Keep an offline backup of every retired key until its rows are gone.

## 3. Leak / compromise response

1. Rotate the affected secret(s) per §2 **immediately** (JWT first — it
   forges auth; then API keys: `UPDATE op_api_keys SET status='revoked'
   WHERE key_prefix='<exposed-prefix>'`).
2. Purge the leak from git history (any `edgepay-*.zip`, `*_secrets*`
   export, or pasted value):
   ```bash
   # find it
   git log -S JWT_SECRET --oneline --all
   git log -S ENCRYPTION_KEY --oneline --all
   gitleaks detect --verbose --redact
   # rewrite history (coordinate with the team — hashes change)
   git filter-repo --path <leaked-file> --invert-paths
   # or: git filter-repo --replace-text <(echo 'JWT_SECRET==>REDACTED')
   git push --force --all && git push --force --tags
   ```
3. Delete local copies: `rm -f edgepay-*.zip *_secrets* .dev.vars.<anything>`,
   clear shell history, revoke any pasted snippet (gist, ticket, chat).
4. Confirm clean: `gitleaks detect --no-git --verbose --redact` exits 0 and
   the `.github/workflows/gitleaks.yml` CI check is green.

## 4. Zip / export hygiene

- Never `zip` a directory containing `.dev.vars*`, `*_secrets*`, or
  `.wrangler/*-secrets*` — all are git-ignored (`edgepay-*.zip` too) but
  still transmittable by hand. Before sharing any export:
  `zip -d edgepay-*.zip '.dev.vars*' '*_secrets*'`.
- `wrangler secret list` shows names only. There is no "show value" — if
  you need the value, it lives in your password manager, nowhere else.
