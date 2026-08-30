# API Reference Guide

EdgePay-CF ships its API contract as an **OpenAPI 3.1 document** with an
**interactive [Scalar](https://scalar.com) reference** — served by your own
Worker, versioned with your deployment:

| URL | What it is |
|-----|------------|
| `/api/reference` | Interactive Scalar UI — browse, try requests, read auth/scope requirements per endpoint |
| `/api/openapi.json` | The raw OpenAPI 3.1 document (codegen-ready; import into Postman/Insomnia/Scalar elsewhere) |

Because the document is built per request from the deployment's
`APP_URL`/`APP_NAME`/`APP_VERSION` vars, the reference is always current for the
build you are actually running — including the gateway catalog route, which
reflects that deployment's `ENABLED_GATEWAYS` selection.

- [Authentication](#authentication)
- [Response envelope and error contract](#response-envelope-and-error-contract)
- [Money, IDs and idempotency](#money-ids-and-idempotency)
- [Rate limits](#rate-limits)
- [Endpoint groups](#endpoint-groups)
- [A complete first payment](#a-complete-first-payment)
- [Self-hosting notes (CSP, pinning)](#self-hosting-notes-csp-pinning)

---

## Authentication

Three schemes protect three surfaces (all declared as OpenAPI
`securitySchemes`):

| Scheme | Where | How |
|--------|-------|-----|
| `ApiKeyAuth` — Bearer API key | `/api/v1/*` (merchant) and `/api/admin/v1/*` | `Authorization: Bearer op_live_<prefix>_<secret>`. Keys are created via `POST /api/v1/api-keys` (admin scope) and carry scopes: `read`, `write`, `admin`. Only a SHA-256 hash is stored; the full key is shown once at creation. |
| `MobileJwt` — Bearer JWT | `/api/mobile/v1/*` | HS256 JWT, issuer `edgepay-cf`, audience `mobile`, issued after 6-digit-OTP device pairing. Refresh via `/api/mobile/v1/devices/token-refreshes`. |
| `AccessJwt` — Cloudflare Access | in front of `/api/admin/v1/*` | The edge proxy authenticates the operator; the Worker **verifies** `Cf-Access-Jwt-Assertion` against the team's JWKS and fails closed (unconfigured ⇒ 503, never open). The admin API *also* requires an admin-scope API key — Access is the outer door, the key is the inner one. A break-glass service token exists for Access outages and pages on every use (see [SECURITY.md](SECURITY.md)). |

## Response envelope and error contract

Every JSON response uses the same envelope, whichever surface you call:

```jsonc
// success
{ "success": true, "data": { … } }

// failure
{ "success": false, "error": { "code": "GATEWAY_DISABLED", "message": "…" } }
```

`code` is stable and machine-readable — the ones you should handle explicitly:
`VALIDATION_ERROR` (400, with zod issue details), `UNAUTHORIZED` (401),
`FORBIDDEN` (403), `NOT_FOUND` / `UNKNOWN_GATEWAY` (404), `CONFLICT` (409),
`OTP_EXPIRED` (410), `GATEWAY_DISABLED` / `REFUND_REJECTED` (422),
`RATE_LIMIT_EXCEEDED` (429, with `X-RateLimit-*` headers),
`GATEWAY_ERROR` (502), `SERVICE_UNAVAILABLE` (503).

Validation errors on the money-critical routes (`POST /payments`, `POST
/refunds`) return the zod issue list in `error.details` — field-level messages,
not a generic 400. Request validation is declared by the same zod schemas that
typed the route handler (`src/lib/validation.ts`), so the OpenAPI document, the
runtime check, and the handler types cannot drift apart.

## Money, IDs and idempotency

- **Money is always a decimal string** (`"100.50"`), never a JSON float. The API
  regex-rejects >2 fraction digits at the boundary; internally everything is
  integer minor units / `Decimal` — see `src/lib/money.ts`.
- **Currency** is ISO 4217, case-insensitive on input, upper-cased by the API.
- **Public references** (`trx_id`, refund ids, checkout `token`) are strings you
  can safely show customers; numeric ids are internal.
- **Idempotency**: send `X-Idempotency-Key` on `POST /api/v1/payments`; replays
  with the same key return the original result instead of creating a second
  intent. Inbound gateway events are deduplicated per
  `(merchant, gateway, event_id)`.

## Rate limits

Authenticated routes are limited **per API key** via native Ratelimit bindings:
120 reads/min and 30 writes/min. Anonymous surfaces (install wizard, OTP
pairing) use per-IP KV counters (install: 3/hour). Responses carry
`X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`. If a
Ratelimit binding is missing (misconfiguration), the request is allowed and a
`rate_limit_degraded` metric is emitted — authorization is never outsourced to
a rate limiter.

## Endpoint groups

The Scalar UI is the always-current source; the groups at a glance:

- **Health** — `GET /api/v1/health` (unauthenticated liveness).
- **Merchant API** (`/api/v1/*`) — payment intents, refunds, transactions,
  customers, API keys, the gateway catalog, webhook tests/deliveries.
- **Mobile Companion** (`/api/mobile/v1/*`) — OTP device pairing, token
  refresh, heartbeat, dashboard, SMS forwarding, notifications.
- **Admin API** (`/api/admin/v1/*`, behind Access + admin key) —
  workflow-driven refunds, manual reconciliation, trial balance + consistency,
  devices, SMS templates, domain verification.
- **Inbound Webhooks** (`/webhook/{gateway}`) — gateway → platform events,
  protected by IP allowlist → geo fallback → signature verification.
- **Checkout** (`/checkout/{token}`) — hosted browser flow (HTML; also mounted
  at `/invoice/{token}` and `/pay/{slug}`).
- **Setup** (`/install`) — pre-install requirements check + wizard.
- **Documentation** — `/api/reference`, `/api/openapi.json`.

Outbound webhook *events* (`payment.completed`, `refund.completed`,
`webhook.test`) are documented in the OpenAPI document's top-level `webhooks`
section — see [WEBHOOKS.md](WEBHOOKS.md) for signing and retry semantics.

## A complete first payment

```bash
BASE=https://<your-worker>.workers.dev

# 1. Create a payment intent (amount = decimal string!)
curl -s -X POST "$BASE/api/v1/payments" \
  -H "Authorization: Bearer op_live_…" -H "Content-Type: application/json" \
  -d '{"amount":"100.50","currency":"BDT","description":"Test payment"}'
# → { "success": true, "data": { "intent_id":1, "token":"…", "checkout_url":"$BASE/checkout/…" } }

# 2. Open checkout_url in a browser (or drive /checkout/{token} yourself)

# 3. Poll status
curl -s "$BASE/api/v1/payments/1" -H "Authorization: Bearer op_live_…"

# 4. (Later) refund it
curl -s -X POST "$BASE/api/v1/refunds" \
  -H "Authorization: Bearer op_live_…" -H "Content-Type: application/json" \
  -d '{"transaction_id":"edgepay_trx_…"}'
```

## Self-hosting notes (CSP, pinning)

The reference page is served by your Worker with a **tailored CSP**: the Scalar
bundle is loaded from a *pinned* jsDelivr URL
(`@scalar/api-reference@1.67.0`, see `src/controllers/api-reference.ts`), and
both script tags carry a per-request nonce mirrored into the CSP header —
`script-src` stays strict (no `unsafe-inline`); only `style-src` permits inline
styles, which Scalar's runtime requires. All other `/api/*` responses keep the
stricter default policy (self + nonce only). Bump the pinned version
deliberately — the pin exists so a CDN-side change cannot silently alter what
your payment platform serves on its docs page.
