# Security Model

EdgePay-CF moves money, so its security posture is **fail-closed by default**:
a missing configuration never widens access, and every trust boundary is
verified rather than assumed. This document maps the controls so operators can
audit them; the code comments in each cited file carry the full rationale.

- [Identity and access](#identity-and-access)
- [Transport and browser hardening](#transport-and-browser-hardening)
- [Data protection at rest](#data-protection-at-rest)
- [Webhook trust boundaries](#webhook-trust-boundaries)
- [Abuse controls](#abuse-controls)
- [Audit and alerting](#audit-and-alerting)
- [Operational security checklist](#operational-security-checklist)

---

## Identity and access

**Merchant API** (`/api/v1/*`) authenticates with Bearer API keys
(`op_live_<prefix>_<secret>`). Only a SHA-256 hash is stored — the full key is
returned exactly once, at creation. Keys carry scopes (`read`, `write`,
`admin`); route handlers enforce them (`requireScope`), so a leaked read key
cannot mint refunds.

**Admin API** (`/api/admin/v1/*`) sits behind *two* doors, deliberately:

1. **Cloudflare Access** at the edge. The Worker does not trust the proxy — it
   verifies the `Cf-Access-Jwt-Assertion` against the team's JWKS
   (`src/middleware/cloudflare-access.ts`, pinned by 10 tests incl. ES256/RS256
   and tamper vectors). Unconfigured team domain or AUD tag ⇒ **503**, an
   unreachable JWKS ⇒ **503**. There is no `CF_ACCESS_ENABLED=false` escape
   hatch — v0.2.0's header-trusting design was removed precisely because a
   standing backdoor is worse than an outage.
2. **An admin-scope API key** at the application — the same bearer layer as the
   merchant API.

**Break-glass access**: a service token (`BREAK_GLASS_CLIENT_ID`/`_SECRET`) can
reach the admin API when Access itself is down. Every use emits a **page-level
audit alarm** — the trade is explicit: availability in extremis, at the cost of
a guaranteed notification.

**Mobile companion**: devices pair via a single-use, expiring 6-digit OTP (the
dashboard prints it); subsequent calls present HS256 JWTs with audience
`mobile` (audience and algorithm pinned — `algorithms: ['HS256']`, secret ≥32
chars enforced at service construction). Refresh tokens rotate access tokens
without re-pairing; admins can revoke devices outright.

## Transport and browser hardening

- **TLS everywhere**; HSTS (2 years, includeSubDomains, preload) on HTTPS
  responses.
- **Nonce CSP** on all JSON surfaces (`/api/*`, `/webhook/*`):
  `script-src 'self' 'nonce-…'` — a reflected payload cannot execute. The
  browser-facing checkout templates are exempt *for now* because Razorpay's
  flow requires external/inline scripts; threading nonces through those
  templates is tracked follow-up work (documented in `src/index.ts`).
- **The Scalar reference page** (`/api/reference`) ships its own tailored CSP —
  pinned CDN script origin + per-request nonce, still no `unsafe-inline`
  scripts; `style-src 'unsafe-inline'` only, which Scalar's runtime requires.
  All other `/api/*` responses keep the strict default
  (`src/middleware/security-headers.ts` preserves any route-set CSP instead of
  clobbering it).
- **CORS fails closed**: cross-origin browser access requires the origin to be
  listed in `ALLOWED_ORIGINS`; everything else gets no CORS grant at all.
  Credentials are never combined with wildcard grants.
- `X-Frame-Options: DENY` + `frame-ancestors 'none'` (nothing may frame a
  payment page), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, and a minimal
  `Permissions-Policy` (no geolocation/mic/camera/payment).
- **CSRF** tokens on the browser forms (checkout, install).

## Data protection at rest

- **AES-256-GCM** (Web Crypto, envelope `iv || ciphertext || tag`) encrypts
  gateway credentials and PII in D1; the key (`ENCRYPTION_KEY`) exists only as
  a Worker secret. Losing it makes ciphertext unrecoverable — back it up.
- **PBKDF2** password hashing with a self-describing cost: every stored hash
  embeds its iteration count, so verification uses the cost the hash was
  created with. Free-tier deployments lower `PBKDF2_ITERATIONS` for *new*
  hashes without invalidating old ones.
- **Email/phone lookups** use SHA-256 hash columns, keeping raw identifiers out
  of indexable positions.
- Money is never a float: the API boundary regex-rejects malformed amounts,
  and internal math runs on integer minor units / an isolated `Decimal`
  clone (`src/lib/money.ts`).

## Webhook trust boundaries

Both webhook directions are verified, never trusted:

- **Outbound** (EdgePay → merchant endpoints): HMAC-SHA256 over the raw body
  with per-merchant secrets (`X-EdgePay-Signature` + `X-EdgePay-Timestamp`),
  so recipients can prove origin. See [WEBHOOKS.md](WEBHOOKS.md#verifying-signatures).
- **Inbound** (gateways → EdgePay): three ordered layers — data-driven per-
  gateway IP allowlists (checked before any signature work), a coarse geo
  fallback (only when no allowlist exists), and **always** adapter-specific
  signature verification over the raw body. Events dedup on
  `(merchant, gateway, event_id)`, so replays complete no second posting.

## Anti-Double-Spending & Two-Way Corroboration Controls

- **Elimination of Heuristic Auto-Confirmation**: Heuristic amount-only matching on personal MFS accounts is strictly prohibited. An order is NEVER marked completed without an exact, cryptographically verified `TrxID` match.
- **Two-Way Cryptographic Matching**:
  - If a customer submits their `TrxID` first, the intent records the expected `customer_trx_id` and waits in `awaiting_sms`.
  - Inbound carrier SMS from the companion phone is parsed into `op_sms_data`. The queue consumer verifies `trx_id`, `amount`, and `merchant_id`.
  - When verified, the transaction completes and the carrier SMS receipt is atomically flagged `matched`.
- **Anti-Replay Attack Protection**: If a customer attempts to claim a `TrxID` that was already matched to another completed order, the request is immediately rejected with `409 TRX_ALREADY_USED`.
- **Global Concurrency & Linearizability (`LedgerDO`)**:
  - Double-entry postings route to a per-merchant Cloudflare Durable Object (`LedgerDO`).
  - Single-threaded execution inside `blockConcurrencyWhile` and SQLite-backed `posted_transactions` registry prevents concurrent edge races from double-posting to ledger accounts.
  - D1 SQLite atomic Compare-And-Swap (`UPDATE ... WHERE status IN ('pending', 'processing')`) ensures only one edge request can execute payment settlement.

## Abuse controls

- **Per-API-key rate limits** via native Ratelimit bindings (120 reads/min, 30
  writes/min) — the primitive per-IP edge rules cannot express. Degrades to
  allow+metric if the binding is missing: authorization is the auth layer's
  job, and an outage must not take payments down.
- **Per-IP KV limits** on anonymous surfaces: install wizard 3/hour, OTP and
  password flows similarly tight.
- **Idempotency keys** on payment creation make client retries safe (return the
  original result, no double charge).
- A free-tier-compatible **edge rate rule** (one rule on the free zone plan)
  can sit in front of the dashboard for volumetric per-IP abuse — it runs
  before the Worker, costing zero CPU.

## Audit and alerting

- `op_webhook_deliveries` records every delivery in both directions (status
  code, latency, attempt count) — one query answers "did you call me?".
- `op_webhook_events` stores raw inbound gateway events for replay/forensics.
- Workers Logs (100% request sampling) + Workers Traces (1%) ship with the
  default config; structured JSON logs carry request ids end-to-end.
- Analytics Engine datapoints (`webhook_lag`, `parse_miss`, `webhook_dlq`,
  `rate_limit_degraded`, `page_*`) are the ops dashboard's substrate.
- Ledger integrity is continuously self-checked: the daily sweep (and the
  manual `POST /api/admin/v1/reconcile`) replays pending postings and verifies
  Durable-Object/D1 consistency; `GET /api/admin/v1/ledger/trial-balance`
  exposes both the trial balance and the consistency verdict.

## Operational security checklist

1. Generate the three secrets with `openssl rand` (never reuse values across
   environments) and back up `ENCRYPTION_KEY` offline.
2. Configure Cloudflare Access over `/api/admin/*` and set the two `CF_ACCESS_*`
   vars — until then the admin API intentionally returns 503.
3. Set `ALLOWED_ORIGINS` to exactly the browser origins that need API access.
4. On the free tier, set `PBKDF2_ITERATIONS=100000`.
5. Restrict each API key to the narrowest scope the integration needs.
6. Register gateway webhook URLs with the providers, and configure per-gateway
   IP allowlists for the gateways that publish ranges.
7. Watch the DLQ alert and `rate_limit_degraded` metric; drain the DLQ within
   24h (free-tier queue retention).
8. Rotate `JWT_SECRET`/`APP_KEY` on a schedule you can afford (sessions
   invalidate); rotate merchant webhook secrets via the admin UI.
