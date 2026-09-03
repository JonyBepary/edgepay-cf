# Planned / quarantined gateways (P0-7)

Default `GET /api/v1/gateways` serves the **7-gateway ceiling**:

```
bkash-api, nagad-merchant-api, sslcommerz, aamarpay, shurjopay, portwallet, stripe
```

Everything below is **planned-future**: catalog-listed, credential-configurable
in the admin UI, but hidden from the default list. `initiate()` on any of them
throws a loud, fail-closed `GatewayNotPortedError` (surfaces as 502
`GATEWAY_ERROR`) until its port lands. Opt in explicitly via `ENABLED_GATEWAYS`
or `?include=planned` (P1 lane owns the `?include=planned` filter in
`src/controllers/api.ts` — not this file).

Counts: `total 123 = implemented 5 + ported 65 + planned 53`,
where `planned 53 = 37 scaffolds + 16 quarantined broken ports`.

Source of truth for statuses: `src/gateways/catalog.data.ts`
(`PLANNED_GATEWAY_SLUGS` / `PLANNED_GATEWAY_COUNT`); stub behaviour:
`src/gateways/planned/index.ts`.

## A. Scaffold stubs (37) — reason: `stub`

Catalog entries with no TS adapter port yet. The upstream PHP provider module
exists but its flow (payment-token decryption, XML payloads, AES-CBC form
crypto, …) is not carried in this build. Adapter files are NOT on disk; the
planned stub serves metadata/fields only.

| slug | reason |
| ---- | ------ |
| airtel-money | stub — port not started |
| alipay | stub — port not started |
| apple-pay | stub — port not started (express checkout via Stripe, unported) |
| billplz | stub — port not started |
| binance-merchant-api | stub — port not started |
| binance-personal | stub — port not started |
| blik | stub — port not started |
| braintree | stub — port not started |
| cashfree | stub — port not started |
| cashmaal | stub — port not started |
| ccavenue | stub — port not started |
| checkout-com | stub — port not started |
| eps | stub — port not started |
| fawry | stub — port not started |
| giropay | stub — port not started |
| google-pay | stub — port not started (express checkout via Stripe, unported) |
| instamojo | stub — port not started |
| jazzcash | stub — port not started |
| klarna | stub — port not started |
| kushki | stub — port not started |
| mtn-momo | stub — port not started |
| myfatoorah | stub — port not started |
| now-payments | stub — port not started |
| orange-money | stub — port not started |
| oxapay | stub — port not started |
| paddle | stub — port not started |
| pagseguro | stub — port not started |
| payfast | stub — port not started |
| paystation | stub — port not started |
| paytabs | stub — port not started |
| paytm | stub — port not started |
| pix | stub — port not started |
| przelewy24 | stub — port not started |
| sofort | stub — port not started |
| tap-payments | stub — port not started |
| toss | stub — port not started |
| trustly | stub — port not started |

## B. Quarantined broken ports (16) — files kept, hidden from default list

Generated adapters exist on disk (`src/gateways/generated/*.gateway.ts`) but
the port is verifiably broken. Catalog status is `planned` so the default list
hides them; re-port (do not hand-patch generated files — regenerate via
`scripts/port-gateways/generate.py`) to graduate back to `ported`.

| slug | reason |
| ---- | ------ |
| easypaisa | PHP leftover — `initiate()` passes the literal string `" . htmlspecialchars($url) . "` as the form action URL (`src/gateways/generated/easypaisa.gateway.ts`) |
| payu | PHP leftover — `initiate()` passes the literal string `" . htmlspecialchars($checkoutUrl) . "` as the form action URL (`src/gateways/generated/payu.gateway.ts`) |
| amazon-pay | empty redirect — `initiate()` hard-codes `redirectUrl = ""` / `sessionId = ""` and never parses the checkout-session response, so it returns `redirect_url: undefined` |
| grabpay | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| kakaopay | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| maya | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| mercadolibre-wallet | empty redirect — `initiate()` hard-codes `initPoint = ""` / `sessionId = ""` and never parses the preference response, so it returns `redirect_url: undefined` |
| mercadopago | empty redirect — `initiate()` hard-codes `initPoint = ""` / `sessionId = ""` and never parses the preference response, so it returns `redirect_url: undefined` |
| opennode | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| payme | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| square | empty redirect — `initiate()` hard-codes `sessionId = ""` and never parses the API response, so it returns `redirect_url: undefined` |
| affirm | stub — upstream webhook check was stub/presence-only; ported fail-closed with no server-side verification path |
| afterpay | stub — upstream webhook check was stub/presence-only; ported fail-closed with no server-side verification path |
| bancontact | stub — upstream webhook check was stub/presence-only; ported fail-closed with no server-side verification path |
| bitpay | stub — upstream webhook check was stub/presence-only; ported fail-closed with no server-side verification path |
| dana | stub — upstream webhook check was stub/presence-only; ported fail-closed with no server-side verification path |

## Graduation checklist (per gateway)

1. Re-port via `scripts/port-gateways/generate.py` (never hand-edit generated files).
2. Flip catalog `status` back to `'ported'` in `src/gateways/catalog.data.ts`.
3. Prove: real redirect/session on `initiate()`, server-side `verify()`, signed
   `verifyWebhook()` (fail-closed on unsigned), no PHP syntax remnants.
4. Remove the row from section B above.
