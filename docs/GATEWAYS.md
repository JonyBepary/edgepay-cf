# Gateway Plugins

EdgePay-CF treats every payment provider as a **plugin adapter** implementing
`BaseGatewayAdapter` (`src/gateways/base.ts`): `initiate()`, `verify()`,
`verifyWebhook()`, `refund()`, `queryRefundStatus()`, plus metadata and the
credential field definitions the admin UI renders.

**v0.3.0 ships the full 123-provider catalog** — the complete port of the
[OwnPay-Gateway-Plugin](https://github.com/own-pay/OwnPay-Gateway-Plugin)
suite (AGPLv3): 86 adapters with working payment flows plus 37 catalog-listed
`planned` providers whose ports land next.

- [Two-level enablement model](#two-level-enablement-model)
- [The 123-provider catalog (v0.3.0 port)](#the-123-provider-catalog-v030-port)
- [Port policies — security fixes over upstream](#port-policies--security-fixes-over-upstream)
- [The Bangladesh reference set](#the-bangladesh-reference-set)
- [Configuring credentials per merchant](#configuring-credentials-per-merchant)
- [Adding a gateway to the platform](#adding-a-gateway-to-the-platform)
- [The port pipeline (regenerating adapters)](#the-port-pipeline-regenerating-adapters)

---

## Two-level enablement model

A gateway being usable on a deployment requires **both** levels:

```
Level 1 — PLATFORM gate (ENABLED_GATEWAYS var)
  Which adapters this deployment may use at all. Set on the Deploy to
  Cloudflare setup page (the ENABLED_GATEWAYS field) or via
  `wrangler secret put ENABLED_GATEWAYS`; parsed by src/gateways/enabled.ts.
  Fail-closed: unknown-only lists enable nothing; in-flight payments/refunds
  are never stranded by a later disable.

Level 2 — MERCHANT install (op_gateways + op_gateway_configs in D1)
  Which gateways an individual merchant has configured, with
  AES-256-GCM-encrypted credentials. Unrelated to Level 1: a merchant cannot
  use a gateway the platform disabled, and installing one does not force
  other merchants to see it.
```

### The ENABLED_GATEWAYS selector

```ini
# .dev.vars.example — the deploy-button setup page field
ENABLED_GATEWAYS=bkash,nagad,rocket,sslcommerz   # Bangladesh MFS set
ENABLED_GATEWAYS=stripe,paypal,razorpay          # global cards
ENABLED_GATEWAYS=all                             # everything (default)
```

Semantics (v0.3.0, catalog-aware):

| Value | Meaning |
|---|---|
| unset / empty / `all` / `*` | every catalog gateway enabled (v0.2.2 back-compat default) |
| comma/semicolon/space-separated slugs | only those gateways enabled |
| unknown tokens | dropped, reported as `dropped_aliases` by `GET /api/v1/gateways` (typo feedback, never a crash) |
| only-unknown tokens | **zero gateways enabled** (fail closed — a typo'd list never silently enables everything) |

Short aliases work everywhere: `bkash` → `bkash-api`, `nagad` →
`nagad-merchant-api`, `paypal-checkout` → `paypal`, `ssl` → `sslcommerz`.

Effect of the gate:

- `POST /api/v1/payments` against a disabled gateway → `422 GATEWAY_DISABLED`
- `POST /api/v1/refunds` against a disabled gateway → `422 GATEWAY_DISABLED`
- `POST /webhook/{gateway}` for a disabled gateway → `404 UNKNOWN_GATEWAY`
  (indistinguishable from an unregistered slug — no inventory leak)
- In-flight operations are exempt: existing transactions and refunds keep
  reconciling even after that gateway is disabled (stranding a completed
  payment mid-flight would lose money).

---

## The 123-provider catalog (v0.3.0 port)

`GET /api/v1/gateways` (bearer auth) returns the deployment's catalog: every
gateway with its status, capabilities, currencies, and credential field
**definitions** (names/labels only — values live AES-256-GCM-encrypted in D1
and are never returned by any API).

| Status | Count | Meaning |
|---|---:|---|
| `implemented` | 5 | core adapters (stripe, paypal, bkash-api, razorpay, nagad-merchant-api) — hand-written, battle-tested |
| `ported` | 81 | full TS ports with working payment flows |
| `planned` | 37 | catalog-listed; selectable and credential-configurable, but `initiate()` throws a clear `GatewayNotPortedError` until the port lands |

Coverage highlights (all `ported`):

- **Bangladesh MFS**: bKash API, Nagad Merchant API, Rocket, SSLCommerz,
  Aamarpay, ShurjoPay, PortWallet, CellFin, NexusPay, OK Wallet, Upay
- **South Asia**: Paytm (planned), PhonePe, Cashfree, CCAvenue (planned),
  PayU, Mobikwik, Instamojo, JazzCash (planned), Easypaisa
- **Global**: Adyen, Amazon Pay, Checkout.com, dLocal, EBANX, Fawry,
  Flutterwave, Google Pay (planned), Klarna (planned), Mercado Pago,
  MercadoLibre Wallet, Mollie, Paystack, PayTabs, Square (planned), Wise,
  Worldline, 2Checkout, Bitpay, BTCPay, Coinbase Commerce …
- **Africa MFS**: M-Pesa, MTN MoMo (planned), Airtel Money (planned),
  Orange Money (planned)
- **SE Asia**: GrabPay, GCash, Maya, Midtrans, MOMO, OVO, ShopeePay,
  TrueMoney, Touch 'n Go, Xendit

The full list with statuses and credential fields is the machine-readable
source of truth: `GET /api/v1/gateways` after deploy, or
`src/gateways/catalog.data.ts` in the repo.

---

## Port policies — security fixes over upstream

The port is faithful to upstream flows but deliberately fixes three classes
of upstream defects. Each is marked `PORT-NOTE`/`PORT-SECURITY` in the
adapter source.

1. **Fake refunds removed.** 33 of upstream's 42 "refund implementations"
   were simulations (`success: true` + an invented refund ID, no API call —
   upstream comments literally say *"Dynamic refund simulation"*). Ported
   adapters return `refund_not_supported` instead: a fake refund ID fed into
   the double-entry ledger would record money that never moved. Only the
   real refund APIs (stripe, braintree, paddle) kept their implementations.

2. **Sandbox simulators stripped.** Several upstream adapters returned a
   `SIM_xxx` "PAID" redirect when the provider API failed in sandbox mode
   (*"Emulate fallback visual window for simulated checkout"*). The ports
   throw on API failure instead — no code path fakes a completed payment.

3. **Webhooks fail closed.** 31 upstream `verifyWebhook()` stubs returned
   `true` unconditionally and 27 more only checked that a header *exists*
   (*"timing-safe validation check simulation"*). All ported stubs return
   `false`: unsigned webhook events are rejected. Payment completion is
   unaffected — it flows through the checkout callback token +
   server-side `verify()`.

Also carried through: callback-payload amounts are never trusted when a
server-side verification API exists (upstream's Stripe comment — now applied
everywhere a verify API exists), and adapters guard their callback input
before spending subrequests (no token grants, logins, or lookups for
callbacks that cannot verify anyway).

---

## The Bangladesh reference set

Five adapters are hand-ported with full behavioral test coverage
(`tests/bd-gateways.test.ts`) and serve as the reference implementations for
each archetype:

| Adapter | Archetype | Flow |
|---|---|---|
| `rocket` | auto-submit form + legacy hash | MD5 concat signature (provider-mandated), response hash verified server-side |
| `sslcommerz` | hosted checkout (form-encoded) | session POST → GatewayPageURL; callback verified via the validator API |
| `aamarpay` | hosted checkout (JSON) | session POST → payment_url; trxcheck requires pay_status AND status_code |
| `shurjopay` | tokenized checkout | /api/get_token → secret-pay → checkout_url; verification list API, KV token cache |
| `portwallet` | bearer invoice + IPN | base64(appKey:md5(secret+ts)) invoice; IPN endpoint verification |

All five: `verify()` ALWAYS re-checks server-side — callback payloads alone
never complete a payment.

---

## Configuring credentials per merchant

Per-gateway credentials (the `fields()` definitions) are entered per
merchant and stored AES-256-GCM-encrypted in `op_gateway_configs`; the
platform decrypts them only in-process when calling the adapter. The catalog
API and the admin UI expose field **definitions** only.

To install a gateway for a merchant:

```sql
-- op_gateways: one row per merchant-gateway
INSERT INTO op_gateways (merchant_id, gateway_slug, is_active, created_at)
VALUES (1, 'rocket', 1, datetime('now'));
-- op_gateway_configs: one row per credential field (encrypted via the app)
```

In practice use the admin API surface (`/api/admin/*`), which handles
encryption, or the merchant onboarding flow. `GET /install` reports the
platform-level readiness including the gateway selection.

---

## Adding a gateway to the platform

Three routes, in order of effort:

1. **Already in the catalog?** Just set credentials — Level 2 install. If the
   status is `planned`, the adapter exists but throws until ported.
2. **Bundled adapter PR** (small): create `src/gateways/{slug}/{slug}.gateway.ts`
   extending `BaseGatewayAdapter` (~100-200 lines using the kit:
   `gwJson`, `buildAutoSubmitForm`, `md5Hex`/`hmacHex`, `TokenCache`),
   register it in `src/gateways/index.ts`, add the catalog entry to the
   generator's source data, and port the tests
   (`tests/bd-gateways.test.ts` is the template).
3. **Regenerate from upstream** (bulk): see the port pipeline below — the
   generator, fixers, and catalog builder are all checked in.

## The port pipeline (regenerating adapters)

The whole port is reproducible from the upstream repo:

```bash
git clone https://github.com/own-pay/OwnPay-Gateway-Plugin /tmp/plugins
bash scripts/port-gateways/build-all.sh /tmp/plugins
```

Pipeline stages (`scripts/port-gateways/`):

| Stage | Script | What it does |
|---|---|---|
| 1. analyze | `analyze.py` | extracts every PHP adapter's manifest, fields, curl calls, response reads, success conditions, hash usage, token flows → `analysis.json` |
| 2. catalog | `build-catalog.py` | emits `src/gateways/catalog.data.ts` (123 entries; status derived from actual adapter presence) |
| 3. generate | `generate.py` | primitive-based PHP→TS compiler emitting one adapter per gateway (curl→gwJson, form_html→buildAutoSubmitForm, bcmath→Number math, hash functions→lib/hash, token grants→KV-cached getToken) |
| 4. cleanup/fix/repair/finalize | `cleanup.py`, `fix-ts.py`, `repair.py`, `finalize.py` | tsc-error-driven convergence: unused declarations, declaration ordering, missing imports, callback guards, optional-chained response reads |

The generator bakes in the port policies above (fake refunds → not
supported, SIM fallbacks stripped, webhook stubs fail-closed) so
regeneration cannot reintroduce them. `analysis-report.txt` records the
upstream census (30 structure signatures, crypto usage, token flows).

Licensing: the upstream suite is AGPLv3; the port carries per-file
attribution in every generated adapter header.
