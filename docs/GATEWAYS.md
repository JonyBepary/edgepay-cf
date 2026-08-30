# Gateway Plugins

EdgePay-CF treats every payment provider as a **plugin adapter** implementing
`BaseGatewayAdapter` (`src/gateways/base.ts`): `initiate()`, `verify()`,
`verifyWebhook()`, `refund()`, `queryRefundStatus()`, plus metadata and the
credential field definitions the admin UI renders. This document explains the
two-level enablement model, the five implemented plugins, and the roadmap for
the remaining catalog.

- [Two-level enablement model](#two-level-enablement-model)
- [The five implemented plugins](#the-five-implemented-plugins)
- [Configuring credentials per merchant](#configuring-credentials-per-merchant)
- [Adding a gateway to the platform](#adding-a-gateway-to-the-platform)
- [The 123-gateway catalog and the v0.3.0 plan](#the-123-gateway-catalog-and-the-v030-plan)

---

## Two-level enablement model

A gateway being usable on a deployment requires **both** levels:

```
Level 1 — PLATFORM gate (ENABLED_GATEWAYS var)
  Which adapters this deployment may use at all. Set on the Deploy to
  Cloudflare setup page or in wrangler.toml [vars]; parsed by
  src/gateways/enabled.ts. Fail-closed: unknown-only lists enable nothing;
  in-flight payments/refunds are never stranded by a later disable.

Level 2 — MERCHANT install (op_gateways + op_gateway_configs in D1)
  Which gateways an individual merchant has configured, with
  AES-256-GCM-encrypted credentials. Managed in the admin UI per merchant.
```

Enforcement points for level 1 (all pinned by tests):

| Operation | Behavior when gateway disabled |
|-----------|-------------------------------|
| `POST /api/v1/payments` → execute (`PaymentService.executePayment`) | throws `422 GATEWAY_DISABLED` |
| `POST /api/v1/refunds` (merchant API) | `422 GATEWAY_DISABLED` |
| `POST /webhook/{gateway}` (inbound) | `404 UNKNOWN_GATEWAY` — same as unregistered, so probes learn nothing about the adapter inventory |
| In-flight: checkout callback, refund-reconciliation workflow | **Allowed** — the customer already paid; refusing to complete would strand funds |

Inspect the active selection at any time — `GET /api/v1/gateways` (bearer key)
returns the enabled adapters with their metadata and credential-field
definitions, the `dropped_aliases` typo feedback, and the pending-catalog count.
The anonymous `GET /install` requirements check surfaces the same selection
before the platform is installed.

## The five implemented plugins

| Slug | Alias | Currencies | Refunds | Webhooks | Notes |
|------|-------|-----------|---------|----------|-------|
| `stripe` | `stripe` | multi | yes | yes (HMAC over raw body) | `metadata.edgepay_trx_id` correlation; legacy payments still reconcile via the fallback dual-read |
| `paypal` | `paypal` | multi | yes | yes | correlation via `resource.custom` |
| `bkash-api` | `bkash` | BDT | yes | yes | bKash Merchant API (tokenized grant + payment create/execute) |
| `razorpay` | `razorpay` | INR + multi | yes | yes (Razorpay signature header) | inline auto-submitting form; `notes.trx_id` correlation |
| `nagad-merchant-api` | `nagad` | BDT | yes | yes | Nagad Merchant API |

The exact credential fields each adapter requires are exposed programmatically —
this is the same list the admin UI renders:

```bash
curl -H "Authorization: Bearer op_live_…" \
  https://<your-worker>/api/v1/gateways | jq '.data.enabled[] | {slug, config_fields}'
```

## Configuring credentials per merchant

Credentials never live in environment variables. Each merchant installs a
gateway in the admin UI (or via SQL/admin tooling), and the field values are
encrypted with the deployment's `ENCRYPTION_KEY` (AES-256-GCM) before landing in
`op_gateway_configs`. Consequences worth internalizing:

- **Rotating a gateway API key** is a per-merchant admin action — no redeploy.
- **Losing `ENCRYPTION_KEY`** makes all stored credentials unrecoverable; back it
  up when you generate it (see [DEPLOYMENT.md](DEPLOYMENT.md#secrets-you-need-before-deploying)).
- Adapters receive only the decrypted field map at call time; nothing is cached
  in module state.

## Adding a gateway to the platform

Bundled adapters follow the existing pattern — there is no runtime plugin
loading (Workers forbids dynamic code execution by design, and Workers for
Platforms is a $25/mo product, incompatible with the strictly-free posture):

1. Create `src/gateways/{slug}/{slug}.gateway.ts` extending
   `BaseGatewayAdapter`; implement `metadata()`, `fields()`, `initiate()`,
   `verify()`, and `verifyWebhook()`/`refund()`/`queryRefundStatus()` where
   supported.
2. Register it in `src/gateways/index.ts`:
   `gatewayRegistry.register('{slug}', () => new MyGateway());`
3. Add the slug to `IMPLEMENTED_GATEWAY_SLUGS` (and an alias if useful) in
   `src/gateways/enabled.ts` so `ENABLED_GATEWAYS` can select it.
4. Add tests alongside `tests/gateways.test.ts` (the existing 13 tests cover the
   registry contract; mirror them for the new adapter).

Each adapter is ~2–5 KB minified+gzipped — the Workers 10 MB compressed-script
budget accommodates hundreds before code-splitting becomes worth its complexity.

## The 123-gateway catalog and the v0.3.0 plan

The original PHP platform shipped 123 gateways; 5 are ported. `PENDING_GATEWAYS`
in `src/gateways/index.ts` lists the other 118 (global cards, wallets, MFS per
region, BNPL, crypto…). Porting them mechanically as bundled adapters would
bloat the bundle and review surface long before the script-size limit, so the
v0.3.0 plugin design (documented in the architecture addendum) takes a
three-tier route that reuses existing infrastructure:

- **Tier 1 — manifest gateways**: JSON adapter manifests (endpoints, auth
  scheme, response mapping) stored in D1 and executed by a built-in
  `ManifestGateway`. Covers the long tail with zero new code per gateway.
- **Tier 2 — HTTP hook plugins**: external services called synchronously
  (guards, pre-post, fail-open/closed per install) or notified asynchronously
  (observers, via the existing webhook-out queue and HMAC signing).
- **Tier 3 — Worker plugins**: plugin authors deploy their own Worker on their
  own account; the platform calls it with a signed JWT. No platform quota used.

Until then, `pending_count` in the `GET /api/v1/gateways` response reports the
size of the backlog, and PRs porting popular gateways as bundled adapters (step
list above) are the supported extension path.
