# Webhooks

Webhooks flow in **both directions**: gateways call EdgePay (inbound), and
EdgePay calls your platform (outbound). Both directions are signature-verified,
idempotent, and observable — this document is the contract for integrators and
operators.

- [Outbound: EdgePay → your endpoint](#outbound-edgepay--your-endpoint)
- [Verifying signatures](#verifying-signatures)
- [Inbound: gateway → EdgePay](#inbound-gateway--edgepay)
- [Delivery guarantees and the DLQ](#delivery-guarantees-and-the-dlq)
- [Operations](#operations)

---

## Outbound: EdgePay → your endpoint

Events are produced by payment completion (`PaymentService`), the refund
reconciliation workflow, and the webhook test endpoint, then delivered through
the `webhook-out` queue (never inline with the request — a slow merchant
endpoint must never slow a checkout).

| Event | Fired when | Key `data` fields |
|-------|-----------|-------------------|
| `payment.completed` | A transaction reaches terminal `completed` (webhook or verified callback) | `trx_id`, `amount`, `currency`, `gateway_trx_id`, `customer`, `metadata` |
| `refund.completed` | The per-refund workflow observes the refund terminal and posts the ledger reversal | `refund_id`, `transaction_id`, `amount`, `currency`, `status` |
| `webhook.test` | You call `POST /api/v1/webhooks/tests` | arbitrary test payload |

Envelope shape:

```jsonc
{
  "event": "payment.completed",
  "timestamp": "2026-08-30T06:20:00.000Z",
  "data": { /* event-specific, see /api/reference → webhooks */ }
}
```

## Verifying signatures

Every delivery is signed with the merchant's webhook secret (generated at
merchant creation; rotate via the admin UI):

```
X-EdgePay-Signature: <hex HMAC-SHA256 of the EXACT raw body bytes>
X-EdgePay-Timestamp: <unix milliseconds>
```

Verify like this (Node example; the principle is identical everywhere):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

const raw = await req.text(); // IMPORTANT: verify the raw bytes, not re-serialized JSON
const expected = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
const got = req.headers.get('x-edgepay-signature') ?? '';
const ok = expected.length === got.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(got));
```

Two rules that bite people: hash the **raw request body** (re-parsing and
re-serializing JSON changes key order/whitespace and breaks the HMAC), and
compare in **constant time**. Optionally reject stale `X-EdgePay-Timestamp`
values (a 5-minute window is reasonable) to blunt replay.

## Inbound: gateway → EdgePay

Gateways POST asynchronous events to `/webhook/{gateway}` (the URL you
register at the gateway). Three defense layers run in order:

1. **IP allowlist** (primary) — `op_gateway_ips` is data-driven per gateway
   (update via admin tooling/SQL without redeploying) because gateway IP ranges
   change without notice. When an allowlist exists, requests outside the CIDRs
   are rejected *before* any signature work.
2. **Geo fallback** — only when no allowlist is configured: the request country
   must be BD/AF/SG/US (the MFS providers' operating regions plus common relay
   locations). Coarse by design; the allowlist is the precise tool.
3. **Signature verification** (always) — the adapter's `verifyWebhook()` checks
   the gateway-specific HMAC/RSA signature over the raw body + headers. There
   is no configuration that skips this layer.

Then the event is recorded with `(merchant, gateway, event_id)` dedup — a
gateway retrying the same event returns `duplicate` and completes no second
posting. Payment-completion events locate their transaction via the
correlation key the adapter embedded at initiate time (e.g. Stripe
`metadata.edgepay_trx_id`, PayPal `resource.custom`, Razorpay
`notes.trx_id`) and drive it through the idempotent completion path: ledger
posting + outbound webhook.

Response codes you may see as a gateway (and what they mean):
`200 processed|duplicate`, `400 NO_MERCHANT_CONTEXT`, `401 SIGNATURE_INVALID`,
`403 IP_NOT_ALLOWED|GEO_BLOCKED`, `404 UNKNOWN_GATEWAY` (slug not registered
**or** disabled via `ENABLED_GATEWAYS` — deliberately indistinguishable).

## Delivery guarantees and the DLQ

- **3 attempts** per delivery with exponential backoff, executed by the
  `webhook-out` queue consumer (batch size 10, 5s batch timeout).
- Any **2xx** acknowledges. Anything else (including network failure) retries.
- After the final attempt the message moves to the `webhook-out-dlq` dead-letter
  queue, where it alerts (page-level event + `webhook_dlq` metric) rather than
  silently disappearing. Queue retention on the free tier is 24h — drain the
  DLQ promptly; every delivery (attempts included) is also recorded in
  `op_webhook_deliveries` with status codes and latency, queryable via
  `GET /api/v1/webhooks/deliveries`.
- Replaying: deliveries are idempotent on your side if you verify signatures
  and dedup on `trx_id` — the same event may legitimately arrive twice across
  retry boundaries.

## Operations

- **Watch lag**: the consumer records a `webhook_lag` metric when the gateway
  provides an event timestamp; sustained lag means the queue is backing up
  (check the free-tier 10K ops/day ceiling first).
- **Test loop**: `POST /api/v1/webhooks/tests` sends a `webhook.test` event —
  use it to validate your signature code before the first real payment.
- **Audit trail**: `GET /api/v1/webhooks/deliveries` returns the last 200
  deliveries with direction (`inbound`/`outbound`), attempt counts and status
  codes — one endpoint answers "did you call me?" and "did they call us?".
