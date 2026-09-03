# Crypto Norms

How EdgePay handles secrets and money-moving safety, in plain language. Short sentences. Copy what you need.

See also: [README](../README.md) · [SECURITY](SECURITY.md) · [API-REFERENCE](API-REFERENCE.md) · [DASHBOARD-PITFALLS](DASHBOARD-PITFALLS.md)

## 1. Secrets: set with `secret put`, never in code

Secrets (`JWT_SECRET`, `APP_KEY`, `ENCRYPTION_KEY`) are typed values, not code. Set them with `npx wrangler secret put NAME` or paste them on the Deploy-to-Cloudflare setup page. Never put real values in `wrangler.jsonc`, `.dev.vars`, or git. Local dev uses `cp .dev.vars.example .dev.vars` with throwaway values only. The setup page never prefills secrets. Project refs: `src/middleware/secrets-guard.ts` (blocks boot on weak/missing secrets), `RUNBOOK-SECRETS.md`, `SECURITY.md`.

## 2. JWT + OTP: short-lived, hashed, locked

JWTs sign mobile-companion and pairing sessions (`JWT_SECRET`, min 32 chars). 6-digit pairing OTPs are stored as hashes — never plaintext — expire after 300 seconds, and lock out after a few wrong guesses. If you mistype repeatedly, wait out the lockout instead of retrying fast. Project refs: `src/routes/mobile.ts`, `src/utils/jwt.ts`, `SECURITY.md`.

## 3. Webhooks: HMAC signature + 300s replay window

Every outbound webhook carries an HMAC signature made with `APP_KEY`. Your endpoint must recompute it and reject mismatches. Each payload has a timestamp: older than 300 seconds is rejected, and already-seen IDs are rejected — so a captured webhook cannot be replayed to fake a payment. Verify first with a `webhook.test` event. Project refs: `src/utils/webhook.ts`, `WEBHOOKS.md`, `API-REFERENCE.md`.

## 4. Refunds: always send `Idempotency-Key`

Money moves twice if you retry without a key. Every refund `POST` must include an `X-Idempotency-Key` (or `Idempotency-Key`) header with a unique value per intent (e.g. `refund-order-123`). Retrying with the same key returns the original result — no double refund. Generate a new key for each new refund. Project refs: `src/routes/refunds.ts`, `POSTING-PROTOCOL.md`, `API-REFERENCE.md`.

## 5. API keys: narrow scopes, rotate fast

Keys look like `op_live_…` and carry scopes (`read`, `write`, `admin`). Mint the smallest scope that works; use `admin` only for setup. The full key is shown once — store it in a password manager. Rotate by minting a new key then deleting the old one; if a key leaks, delete it immediately and check `GET /api/v1/transactions` for misuse. Never use test keys in production. Project refs: `src/routes/api-keys.ts`, `SECURITY.md`.

## 6. PII: encrypted at rest, redacted in logs

Names, phones, and gateway credentials are encrypted with `ENCRYPTION_KEY` (AES-256-GCM) before hitting D1. Logs never carry full secrets, card data, or raw tokens — values are redacted or hash-prefixed. Losing `ENCRYPTION_KEY` makes stored credentials unrecoverable, so back it up offline. If PII ever appears in a log, rotate the exposed credential and scrub the log. Project refs: `src/utils/crypto.ts`, `src/middleware/secrets-guard.ts`, `SECURITY.md`.
