# Getting Started

From zero to your first payment in about 15 minutes. Two routes: click the
**Deploy to Cloudflare** button (no local tooling), or run locally with
Wrangler. Both end at the same install wizard and the same interactive API
reference.

- [Route A: one-click deploy](#route-a-one-click-deploy)
- [Route B: local development](#route-b-local-development)
- [The install wizard](#the-install-wizard)
- [Your first payment](#your-first-payment)
- [Where to go next](#where-to-go-next)

---

## Route A: one-click deploy

1. **Generate the three secrets** (you'll paste them on the setup page):

   ```bash
   openssl rand -hex 32        # JWT_SECRET
   openssl rand -base64 32     # APP_KEY
   openssl rand -base64 32     # ENCRYPTION_KEY — back this up
   ```

2. **Click the Deploy to Cloudflare button** in the README. On the setup page:
   - pick a Worker name,
   - set **ENABLED_GATEWAYS** to the gateway plugins you want
     (e.g. `stripe,bkash` — aliases welcome, see
     [GATEWAYS.md](GATEWAYS.md#two-level-enablement-model)),
   - paste the three secrets,
   - leave the optional fields empty (you can configure them later).

3. Cloudflare clones the repo into **your** GitHub, provisions D1/KV/R2/Queues/
   Workflows/Durable Objects, applies the 53-table schema, and deploys.

Full walkthrough incl. what gets provisioned and troubleshooting:
[DEPLOYMENT.md](DEPLOYMENT.md).

## Route B: local development

Prerequisites: Node.js 20+ and a free Cloudflare account.

```bash
git clone https://github.com/JonyBepary/edgepay-cf && cd edgepay-cf
npm install
npx wrangler login                       # opens the browser

# Create the resources (all free-tier):
npx wrangler d1 create edgepay-cf        # paste database_id → wrangler.toml
npx wrangler kv namespace create KV      # paste id → wrangler.toml
npx wrangler r2 bucket create edgepay-uploads
npx wrangler queues create webhook-out
npx wrangler queues create webhook-out-dlq
npx wrangler queues create email-out
npx wrangler queues create sms-parse

npm run db:migrate:local                 # applies migrations/ via the DB binding
npm run db:seed:local                    # currencies, permissions, SMS templates

cp .dev.vars.example .dev.vars           # fill in the three secrets
npm run dev                              # → http://localhost:8787
```

Run the test suite any time — 104 tests executing **inside workerd** against
real D1/Durable Objects/Workflows bindings:

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

## The install wizard

Open `http://localhost:8787/install` (or `https://<your-worker>/install`).
`GET /install` is a requirements report: binding presence, secret *posture*
(`ok`/`weak`/`missing` — length class only, the page never sees values), and
your gateway selection including `dropped_aliases` typo feedback. `POST
/install` (the wizard form) creates:

- the **platform merchant** (your brand),
- the **super-admin** user (password ≥12 chars; PBKDF2 cost follows
  `PBKDF2_ITERATIONS`),
- the **default chart of accounts** for the double-entry ledger,

then sets a KV install lock — the wizard can never run twice.

## Your first payment

1. **Mint an API key** (read+write is enough for testing):

   ```bash
   curl -s -X POST http://localhost:8787/api/v1/api-keys \
     -H "Authorization: Bearer <admin-key>" -H "Content-Type: application/json" \
     -d '{"name":"local-test","scopes":["read","write"]}'
   # → data.api_key  (op_live_… — shown ONCE)
   ```

2. **Enable a sandbox gateway** — in the admin UI, install Stripe (test mode)
   with a test secret key, or bKash sandbox credentials. Only gateways listed
   in your `ENABLED_GATEWAYS` var are selectable; confirm the active catalog:

   ```bash
   curl -s http://localhost:8787/api/v1/gateways \
     -H "Authorization: Bearer op_live_…" | jq '.data.enabled[].slug'
   ```

3. **Create a payment intent** — amounts are decimal strings:

   ```bash
   curl -s -X POST http://localhost:8787/api/v1/payments \
     -H "Authorization: Bearer op_live_…" -H "Content-Type: application/json" \
     -H "X-Idempotency-Key: demo-1" \
     -d '{"amount":"100.50","currency":"BDT","description":"first payment"}'
   # → data.checkout_url
   ```

4. **Open the checkout URL**, pay with the gateway's sandbox credentials, land
   on the callback page — the transaction completes, the double-entry ledger
   posts (one atomic per-tenant LedgerDO call), and `payment.completed` fires
   to your registered webhook endpoint (verify it first with
   `POST /api/v1/webhooks/tests`).

5. **Watch the money** — `GET /api/v1/transactions/{trx_id}`, and on the admin
   side `GET /api/admin/v1/ledger/trial-balance` for the trial balance plus
   the DO/D1 consistency verdict.

## Where to go next

- **API-REFERENCE.md** — then just keep `/api/reference` open; it is the live
  contract for your build.
- **WEBHOOKS.md** — verify HMAC signatures before going live.
- **SECURITY.md** — the admin-surface Access setup and the ops checklist.
- **DEPLOYMENT.md** — environments, free-tier budget, and the deploy-button
  internals.
- **POSTING-PROTOCOL.md** — how the ledger stays correct under failure
  (worth reading before you trust it with real money).
