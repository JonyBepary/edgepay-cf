# EdgePay-CF — Self-hosted payment gateway on Cloudflare Workers

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_GITHUB_USERNAME/edgepay-cf)

A HonoJS + Cloudflare Workers port —
the open-source, self-hosted payment gateway automation platform for BD/AF mobile-payment
merchants (bKash, Nagad, Rocket, Razorpay, Stripe, PayPal…). EdgePay-CF runs entirely on
Cloudflare's edge network (Workers + D1 + Durable Objects + KV + R2 + Queues + Workflows),
and runs **fully on the free tier** (~3.3K payments/day practical ceiling — see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#free-tier-budget)).

> **One-click deploy**: click the button above, pick your **gateway plugins**
> (`ENABLED_GATEWAYS`), paste three generated secrets, and Cloudflare provisions
> D1, KV, R2, Queues, Workflows and Durable Objects, applies migrations and deploys —
> no local tooling needed. Full walkthrough: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## What's included

- **5 fully implemented gateway adapters**: Stripe, PayPal, bKash, Razorpay, Nagad —
  selectable per deployment via the `ENABLED_GATEWAYS` plugin gate
  ([docs/GATEWAYS.md](docs/GATEWAYS.md))
- **Interactive API reference** — OpenAPI 3.1 served at `/api/openapi.json`,
  rendered by [Scalar](https://scalar.com) at `/api/reference` on your own deployment
- **Multi-brand domain routing** — per-brand custom domain isolation (KV cache +
  Cloudflare for SaaS custom hostnames)
- **Double-entry ledger** (GAAP-compliant) — one per-tenant LedgerDO per merchant,
  6-step posting protocol with dedup + heal convergence
  ([docs/POSTING-PROTOCOL.md](docs/POSTING-PROTOCOL.md))
- **Webhooks, both directions** — HMAC-SHA256-signed outbound events (queued, retried,
  DLQ) and verified inbound gateway webhooks (IP allowlist → geo fallback → signature)
  ([docs/WEBHOOKS.md](docs/WEBHOOKS.md))
- **JWT auth** (mobile companion, OTP device pairing, SMS forwarding + AI fallback parsing)
  + **Bearer API keys** with read/write/admin scopes (merchant + admin APIs)
- **Security** — Cloudflare Access fail-closed on the admin surface, AES-256-GCM PII +
  credential encryption, CSRF, nonce-CSP/HSTS on JSON surfaces
  ([docs/SECURITY.md](docs/SECURITY.md))
- **3 Cron Triggers, 3 Queue consumers, 2 Workflows** — refund reconciliation
  (instance-per-refund), daily reconciliation sweep, intent expiry
- **D1 schema** — 53 tables ([migrations/](migrations/))
- **zod request validation** on money-critical routes, idempotency keys,
  native Ratelimit bindings per API key

## Documentation

| Doc | What's inside |
|-----|---------------|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Local dev → first payment in 15 minutes |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | **Deploy to Cloudflare button** (incl. gateway-plugin selection), environments, free-tier budget |
| [docs/GATEWAYS.md](docs/GATEWAYS.md) | Gateway plugins: selection, credentials, capabilities, the 123-gateway catalog |
| [docs/API-REFERENCE.md](docs/API-REFERENCE.md) | Auth schemes, conventions, and the Scalar-rendered reference |
| [docs/WEBHOOKS.md](docs/WEBHOOKS.md) | Outbound HMAC webhooks + inbound verification layers |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every var, secret and binding |
| [docs/SECURITY.md](docs/SECURITY.md) | Access, encryption, scopes, break-glass, CSP |
| [docs/POSTING-PROTOCOL.md](docs/POSTING-PROTOCOL.md) | Normative ledger posting protocol |

Interactive API reference on any deployment: **`/api/reference`** · machine-readable contract: **`/api/openapi.json`**

## Project structure

```
edgepay-cf/
├── src/
│   ├── index.ts                    # Worker entry — fetch + scheduled + queue
│   ├── openapi.ts                  # OpenAPI 3.1 document (single source of truth)
│   ├── types/                      # env.ts (bindings), db.ts, ledger.ts
│   ├── lib/                        # crypto, jwt, money, error, logger, validation…
│   ├── middleware/                 # auth, csrf, rate-limit, security-headers,
│   │                               # cloudflare-access, domain, idempotency…
│   ├── controllers/
│   │   ├── api.ts                  # /api/v1/* merchant API
│   │   ├── mobile.ts               # /api/mobile/v1/* companion app
│   │   ├── admin-api.ts            # /api/admin/v1/* admin (behind Access)
│   │   ├── api-reference.ts        # /api/reference (Scalar) + /api/openapi.json
│   │   ├── checkout.ts             # /checkout/* customer flow (HTML)
│   │   ├── webhooks.ts             # /webhook/{gateway} inbound
│   │   └── install.ts              # /install wizard
│   ├── services/                   # payment, ledger, refund, reconciliation,
│   │                               # webhook-dispatcher, custom-hostnames, sms…
│   ├── gateways/                   # base.ts + 5 adapters + enabled.ts (selection)
│   ├── do/ledger-do.ts             # Per-tenant LedgerDO (posting protocol)
│   ├── workflows/                  # refund-reconciliation, reconciliation-sweep
│   ├── cron/handler.ts             # 3 cron schedules
│   └── queues/                     # webhook / email / sms consumers
├── migrations/                     # 0001–0003 (53 D1 tables)
├── db/seeds.sql
├── tests/                          # 11 suites, 104 tests (vitest in workerd)
├── docs/                           # the documentation set above
├── wrangler.toml                   # prod + dev + staging environments
├── .dev.vars.example               # secrets template (deploy-button fields)
└── package.json                    # incl. cloudflare.bindings descriptions
```

## Quick start

### Option A — Deploy to Cloudflare button (recommended)

1. Push this repo to **your public GitHub** (the button needs a public repo) and
   replace `YOUR_GITHUB_USERNAME` in the badge URL above and in
   `package.json → cloudflare.docs_url`.
2. Generate the three required secrets locally:
   ```bash
   openssl rand -hex 32        # JWT_SECRET
   openssl rand -base64 32     # APP_KEY
   openssl rand -base64 32     # ENCRYPTION_KEY  (back this up!)
   ```
3. Click **Deploy to Cloudflare**. On the setup page: pick a Worker name, set
   **ENABLED_GATEWAYS** to the plugins you want (e.g. `stripe,bkash`), paste the
   secrets, deploy. D1/KV/R2/Queues/Workflows/DO are provisioned automatically and
   migrations run as part of the deploy script.
4. Open `https://<your-worker>.workers.dev/install` → create the super-admin →
   configure gateway credentials in the admin UI.

Details and troubleshooting: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

### Option B — Local development

```bash
npm install
npx wrangler login

# Create resources (all free): D1, KV, R2, Queues
npx wrangler d1 create edgepay-cf            # paste database_id into wrangler.toml
npx wrangler kv namespace create KV           # paste id into wrangler.toml
npx wrangler r2 bucket create edgepay-uploads
npx wrangler queues create webhook-out && npx wrangler queues create webhook-out-dlq
npx wrangler queues create email-out && npx wrangler queues create sms-parse

npm run db:migrate:local      # applies migrations/ via the DB binding
npm run db:seed:local

cp .dev.vars.example .dev.vars   # fill in the three generated secrets
npm run dev                      # http://localhost:8787/install

npm test                         # 104 tests, run inside workerd
```

### Deploy manually (no button)

```bash
npx wrangler secret put JWT_SECRET      # >= 32 chars
npx wrangler secret put APP_KEY
npx wrangler secret put ENCRYPTION_KEY

npm run deploy    # = d1 migrations apply DB --remote  +  wrangler deploy
```

## API surface (summary)

Full, always-current contract at **`/api/reference`** on any deployment.

| Group | Auth | Highlights |
|-------|------|-----------|
| `/api/v1/*` | Bearer API key (read/write/admin) | payments, refunds, transactions, api-keys, gateways catalog, webhook deliveries |
| `/api/mobile/v1/*` | JWT (aud `mobile`) | OTP device pairing, dashboard, SMS forwarding, notifications |
| `/api/admin/v1/*` | Cloudflare Access + admin key | refunds (workflow-driven), reconcile, trial-balance, devices, SMS templates |
| `/webhook/{gateway}` | per-gateway signature | inbound gateway events (IP allowlist → geo → signature) |
| `/checkout/{token}` | public (CSRF-protected) | hosted checkout + callback + status polling |
| `/install` | anonymous (rate-limited, pre-install only) | requirements check + wizard |
| `/api/reference`, `/api/openapi.json` | public | this documentation |

## Cloudflare free tier

Everything in this stack is available on the **free tier** (Queues went free in
Feb 2026 — the last paid-only primitive). Practical ceiling ≈ **3.3K payments/day**,
bound first by the 10K queue-ops/day allowance. Two free-tier notes:

- **PBKDF2**: the 600K-iteration default exceeds the free plan's 10ms CPU budget —
  strictly-free deployments set `PBKDF2_ITERATIONS=100000` (stored hashes
  self-describe their cost, so nothing breaks).
- **Crons**: 3 of the 5 free per-account cron slots are used.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#free-tier-budget) for the budget table
and the $5/mo paid-tier alternative.

## License

AGPL-3.0-or-later — same as the original EdgePay.

## Acknowledgments

- Original EdgePay project: https://github.com/edgepay/EdgePay
- Built with: [HonoJS](https://hono.dev), [Cloudflare Workers](https://workers.cloudflare.com),
  [D1](https://developers.cloudflare.com/d1), [Durable Objects](https://developers.cloudflare.com/durable-objects),
  [jose](https://github.com/panva/jose), [decimal.js](https://github.com/MikeMcl/decimal.js),
  [Scalar API Reference](https://github.com/scalar/scalar)
