# Deployment Guide

How EdgePay-CF gets from this repository to a running payment platform on your
Cloudflare account — via the **Deploy to Cloudflare button** (one click) or the
Wrangler CLI (full control). Both paths end at the same place: an install wizard
at `/install`, an admin surface behind Cloudflare Access, and an interactive API
reference at `/api/reference`.

> Start with the [README](../README.md) 1-click guide (button snippet, prerequisites, checklist). Gotchas live in [DASHBOARD-PITFALLS](DASHBOARD-PITFALLS.md); crypto rules in [CRYPTO-NORMS](CRYPTO-NORMS.md).

- [Deploy to Cloudflare button](#deploy-to-cloudflare-button)
- [Choosing your gateway plugins](#choosing-your-gateway-plugins)
- [Secrets you need before deploying](#secrets-you-need-before-deploying)
- [What the button provisions](#what-the-button-provisions)
- [After deployment: first-run checklist](#after-deployment-first-run-checklist)
- [Manual deployment (Wrangler CLI)](#manual-deployment-wrangler-cli)
- [Environments: dev / staging / prod](#environments-dev--staging--prod)
- [Free-tier budget](#free-tier-budget)
- [Troubleshooting](#troubleshooting)

---

## Deploy to Cloudflare button

The badge at the top of the README is a one-click deployment path built on
Cloudflare's [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/):

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/JonyBepary/edgepay-cf)
```

The button only supports public github.com / gitlab.com repositories. If you
fork or rename, update the badge URL (README) and
`package.json → cloudflare.docs_url` to point at **your** repo.

What happens when someone (including you) clicks it:

1. **Clone** — Cloudflare clones the repo into the clicker's GitHub account, so
   they own the code from minute one and can keep developing after deploying.
2. **Configure** — a single setup page collects the Worker name, resource names,
   and every environment variable/secret that has a description in
   `package.json → cloudflare.bindings` (that includes the gateway-plugin
   selector and the three required secrets — see below).
3. **Build & deploy** — [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds)
   installs dependencies, runs the `deploy` script (`npm run db:migrations:apply
   && wrangler deploy`), provisions every binding the wrangler config declares,
   and rewrites the config in the cloned repo with the new resource IDs.

Total time is typically 3–5 minutes, and no local tooling is required — the flow
runs entirely in the browser and on Cloudflare's build infrastructure.

## Choosing your gateway plugins

The setup page's **`ENABLED_GATEWAYS`** field is the gateway-plugin selector.
It takes a comma-separated list of slugs (friendly aliases accepted) — **any of
the 123 catalog gateways**. The BD set:
`bkash`/`bkash-api`, `nagad`/`nagad-merchant-api`, `rocket`, `sslcommerz`,
`aamarpay`, `shurjopay`, `portwallet`, `cellfin`, `nexuspay`, `ok-wallet`,
`upay`; global cards: `stripe`, `paypal`, `razorpay`, `adyen`, `2checkout`,
`checkout-com`…; Africa MFS: `mpesa`, `mtn-momo`… — the complete list is at
`GET /api/v1/gateways` after deploy and in
[docs/GATEWAYS.md](GATEWAYS.md).

Examples: `stripe,bkash` (cards + bKash), `bkash,nagad,rocket,sslcommerz`
(pure BD MFS), or leave the default to enable the entire catalog.
Gateways whose port is still pending are marked `planned` in the catalog —
selectable and credential-configurable, but payments return a clear error
until their adapter lands.

Semantics (implemented in `src/gateways/enabled.ts`, pinned by
`tests/gateways-enabled.test.ts`):

- **Unset / empty / `all`** — every implemented adapter is enabled (the v0.2.2
  default; deployments that never touch the field keep working).
- **Unknown tokens are dropped, not fatal** — `stripe,stripe-checkout` enables
  Stripe and reports `stripe-checkout` in `dropped_aliases` via
  `GET /api/v1/gateways` and `GET /install`, so typos surface immediately
  instead of crashing the platform.
- **Fail closed** — a value consisting *only* of unknown tokens (e.g. a
  misspelled list) enables **zero** gateways. New payments against any gateway
  then fail with `422 GATEWAY_DISABLED`. The platform never silently enables
  everything because of a bad config value.
- **In-flight flows are exempt** — disabling a gateway does not strand money
  that is already moving: existing transactions still complete via callback, and
  in-flight refund workflows keep polling their adapter. Only *new* payments,
  *new* refunds, and *new* inbound webhooks for that gateway are refused.

This is the **platform-level** gate. Merchants still install gateways and store
credentials per-tenant (AES-256-GCM in D1) — see [GATEWAYS.md](GATEWAYS.md) for
the full two-level model.

**Changing the selection later**: edit `ENABLED_GATEWAYS` in `wrangler.jsonc`
inside the repo the button created for you and push — Workers Builds redeploys
automatically. Confirm the active set any time with:

```bash
curl -H "Authorization: Bearer op_live_…" https://<your-worker>/api/v1/gateways
```

## Secrets you need before deploying

See the [README](../README.md) (Prerequisites + what 1-click does NOT do) for the 3-secret setup. Quick version:

```bash
openssl rand -hex 32        # JWT_SECRET
openssl rand -base64 32     # APP_KEY
openssl rand -base64 32     # ENCRYPTION_KEY — back this up
```

Paste them on the setup page (values are never prefilled). Rules for handling them: [CRYPTO-NORMS](CRYPTO-NORMS.md). Optional fields (`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD_TAG`, break-glass token, `PBKDF2_ITERATIONS=100000` for strictly-free) can be left empty and set later — see [SECURITY.md](SECURITY.md) and [free-tier budget](#free-tier-budget).

## What the button provisions

Cloudflare reads `wrangler.jsonc` and provisions every declared resource, then
rewrites the config in the cloned repo with the concrete IDs:

| Resource | Binding(s) | Free-tier allowance |
|----------|-----------|---------------------|
| D1 database | `DB` | 5 GB total, 5M rows read + 100K rows written/day |
| KV namespace | `KV` | 100K reads + 1K writes/day |
| R2 bucket | `R2` | 10 GB, 1M Class A + 10M Class B ops/mo |
| Queues (4: webhook-out, its DLQ, email-out, sms-parse) | `WEBHOOK_QUEUE`, `EMAIL_QUEUE`, `SMS_QUEUE` | 10K ops/day (the binding constraint) |
| Durable Objects (one LedgerDO per merchant) | `LEDGER_DO` | 100K DO requests/day, SQLite-backed |
| Workflows (refund reconciliation, daily sweep) | `REFUND_WORKFLOW`, `SWEEP_WORKFLOW` | 100K executions/day (shared request bucket) |
| Ratelimit namespaces | `RATE_LIMIT_READ`, `RATE_LIMIT_WRITE` | included |
| Analytics Engine dataset | `ANALYTICS` | 100K datapoints/day |
| Static assets (checkout CSS) | `ASSETS` | included |

D1 migrations (the 53-table schema in `migrations/`) are applied by the deploy
script **before** the Worker upload, referencing the database by **binding name**
(`wrangler d1 migrations apply DB --remote`) so it targets whatever database the
button provisioned regardless of its name.

## After deployment: first-run checklist

1. **Install wizard** — open `https://<your-worker>.workers.dev/install`. It
   verifies bindings, secret posture (length-class only — the page never sees
   secret contents), and your gateway selection, then creates the platform
   merchant, the super-admin, and the default chart of accounts. The wizard is
   anonymous but rate-limited to 3 requests/hour per IP, and it locks itself
   (KV flag) after completion.
2. **Cloudflare Access** — create a free Zero Trust team at
   <https://one.dash.cloudflare.com>, add an Access application covering
   `https://<your-worker>/api/admin/*`, then set `CF_ACCESS_TEAM_DOMAIN` and
   `CF_ACCESS_AUD_TAG`. Until then the admin API returns 503 by design — it
   fails closed, there is no flag to open it.
3. **Gateway credentials** — in the admin UI, install the gateway(s) you enabled
   and paste their API credentials (stored AES-256-GCM-encrypted). The
   `GET /api/v1/gateways` catalog tells you exactly which fields each adapter
   needs.
4. **API keys** — mint your first API key (`POST /api/v1/api-keys`, admin
   scope) and make a test payment intent.
5. **Webhook endpoint** — register your merchant endpoint and send a
   `webhook.test` event to verify your HMAC validation.
6. **Explore the API** — open `https://<your-worker>/api/reference` (Scalar
   UI over the OpenAPI 3.1 document) — see [API-REFERENCE.md](API-REFERENCE.md).

## Manual deployment (Wrangler CLI)

The button is a convenience, not a requirement. The CLI path:

```bash
npm install
npx wrangler login

# Create named resources and paste the returned IDs into wrangler.jsonc
npx wrangler d1 create edgepay-cf
npx wrangler kv namespace create KV
npx wrangler r2 bucket create edgepay-uploads
npx wrangler queues create webhook-out
npx wrangler queues create webhook-out-dlq
npx wrangler queues create email-out
npx wrangler queues create sms-parse

# Secrets
npx wrangler secret put JWT_SECRET
npx wrangler secret put APP_KEY
npx wrangler secret put ENCRYPTION_KEY

# Migrations + deploy (same command the button's build runs)
npm run deploy
```

`npm run deploy` = `npm run db:migrations:apply && wrangler deploy`, where the
migration step targets the `DB` **binding** (`wrangler d1 migrations apply DB
--remote`) — this works no matter what you named your D1 database.

## Environments: dev / staging / prod

Production is the top level of `wrangler.jsonc` (the only file the Deploy
to Cloudflare button reads). Dev and staging are **self-contained separate
configs** — because bindings and vars are never inherited across Wrangler
environments, each file declares its own complete set
([Wrangler environments docs](https://developers.cloudflare.com/workers/wrangler/environments/)):

```bash
npm run deploy:dev       # wrangler deploy --config wrangler.dev.jsonc     -> edgepay-cf-dev
npm run deploy:staging   # wrangler deploy --config wrangler.staging.jsonc -> edgepay-cf-staging
```

Dev/staging use suffixed resource names (`edgepay-cf-dev`, `edgepay-uploads-dev`,
…) and their own placeholder IDs in their config files — fill those in before
deploying those environments, and create their queues
(`wrangler queues create webhook-out …` per environment prefix) since queue
names are account-global. Secrets are per-Worker too: set them once per
environment with `wrangler secret put NAME --config wrangler.dev.jsonc`.

## Free-tier budget

Everything EdgePay-CF uses is available on the Cloudflare **free tier** (Queues,
the last paid-only primitive in the stack, went free in February 2026). The
practical ceiling for a strictly-free deployment is **~3.3K payments/day** — the
binding constraint is Queues' 10K ops/day (each payment fans out to webhook +
email deliveries). The full analysis lives in the architecture addendum PDF;
the operational summary:

| Constraint | Free allowance | EdgePay-CF usage at 1K payments/day |
|------------|----------------|--------------------------------------|
| Queue ops/day | 10,000 | ~3,000 (webhook + email fan-out) |
| D1 rows written/day | 100,000 | ~15,000 (intent, transaction, ledger, events) |
| Workers requests/day (shared with cron/queue/workflow) | 100,000 | ~20,000 |
| DO requests/day | 100,000 | ~5,000 (1 posting + reads) |
| Workers AI neurons/day | 10,000 | SMS long-tail parsing only |
| Cron triggers | 5 **per account** | 3 (leave 2 for other Workers) |

Two free-tier settings to change deliberately:

- **`PBKDF2_ITERATIONS=100000`** — the 600K OWASP default cannot complete inside
  the free plan's 10ms CPU budget. Stored password hashes embed their own
  iteration count, so lowering this only affects *new* hashes; existing ones
  keep verifying at their original cost.
- **Workers AI binding** — `"ai"` is commented out in `wrangler.jsonc` because
  the test runner does not emulate it. After your first deploy, uncomment the
  binding and redeploy to enable AI fallback SMS parsing (regex templates remain
  the primary path and work without it).

On the $5/mo Workers Paid plan the ceilings lift by 1–2 orders of magnitude and
the 30s CPU budget removes the PBKDF2 caveat — but free tier is a fully
supported posture, not a demo mode.

## Troubleshooting

Full 8-row gotcha table: [DASHBOARD-PITFALLS](DASHBOARD-PITFALLS.md). Quick index:

| Symptom | Cause | Fix |
|---------|-------|-----|
| Deploy fails at the migrations step | `database_id` still a placeholder in the repo the button created (provisioning normally rewrites it) | `npx wrangler d1 list`, paste the id into `wrangler.jsonc`, push |
| `/api/admin/*` returns 503 | Cloudflare Access vars empty (fail closed) | Set `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD_TAG`, see [SECURITY.md](SECURITY.md) |
| `422 GATEWAY_DISABLED` on payments | Gateway slug not in `ENABLED_GATEWAYS` | Add it to the var (or check spelling via `GET /api/v1/gateways` → `dropped_aliases`) |
| Inbound webhook 404 `UNKNOWN_GATEWAY` | Slug not registered **or** disabled — intentionally indistinguishable | Same as above; only enabled gateways accept webhooks |
| Install wizard says secrets `weak`/`missing` | Placeholder-length secrets | `openssl rand` values from the table above; re-put via `wrangler secret put` |
| Dev/staging Worker 500s on first call | Env resource IDs still placeholders | Fill the placeholder IDs in that environment's `wrangler.*.jsonc` |
| Queues consumer errors after first deploy | Queues not yet created for that environment | `wrangler queues create` each queue (names in the wrangler config) |
