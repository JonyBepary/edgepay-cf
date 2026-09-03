# Observability Alerts — EdgePay-CF

Paging and metrics run on two channels (see `src/lib/observability.ts`):

- `page(env, code, detail)` — `console.error` JSON with `level: 'page'`
  plus an Analytics Engine datapoint. **Never demote: any `level=page`
  line pages on-call.**
- `metric(env, event, dims)` — Analytics Engine datapoint only
  (dataset `edgepay_metrics`, binding `ANALYTICS`).

Free-tier note: Logpush requires Workers Paid. On the free plan, use
Workers Logs alert rules on the same `level=page` marker (200K
events/day). Analytics Engine free quota is 100K datapoints/day.

## 1. `level=page` alert (Logpush / Workers Logs)

All paging events share one shape:

```json
{ "level": "page", "code": "<CODE>", "detail": { "...": "..." }, "environment": "production", "timestamp": "<iso>" }
```

**Logpush job** (Workers Paid): filter `level = "page"`, deliver to the
on-call channel (PagerDuty/Opsgenie webhook). Alert on **any occurrence**
— `page()` is reserved for reconciliation drift, exhausted postings,
stuck refunds, rate-limiter degradation in production, and break-glass
usage.

**Workers Logs alert rule** (free plan): same filter, `level = "page"`.
Known `code` values to expect:

| code | source | meaning |
| --- | --- | --- |
| `LEDGER_RECONCILIATION_DRIFT` | sweep workflow | DO/D1 trial-balance divergence — investigate immediately |
| `REFUND_STUCK_MANUAL_REVIEW` | refund workflow | refund never reached terminal state |
| `LEDGER_POSTING_REJECTED` | payment path | posting validation refused a ledger write |
| `RATE_LIMIT_DEGRADED` | `perIpRateLimit` (production only) | KV counter unreadable — anonymous traffic fail-closed 503 |
| break-glass usage | admin auth | emergency service-token authentication — pages on every use |
| `CALLBACK_UNSIGNED_REJECTED` (log, not page) | callback handler | unsigned gateway callback kept pending — watch spikes, not singles |

## 2. Analytics Engine (`edgepay_metrics`) queries

`page()` writes `blobs = ['page', code, detail-json]`,
`indexes = [merchant_id | 'platform']`. `metric()` writes
`blobs = [event, merchant_id, gateway, extra]`, `doubles = [value]`,
`indexes = [merchant_id | 'platform']`.

```sql
-- Paging events, last 24h
SELECT blob1 AS code, count() AS n
FROM edgepay_metrics
WHERE blob1 = 'page' AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY code ORDER BY n DESC;

-- Rate-limit hits per merchant path (fail-open telemetry for the native binding)
SELECT blob1 AS event, blob4 AS path, count() AS n
FROM edgepay_metrics
WHERE blob1 IN ('rate_limited', 'rate_limit_degraded')
  AND timestamp > NOW() - INTERVAL '1' HOUR
GROUP BY event, path ORDER BY n DESC;

-- Webhook rejection spikes (>5% of inbound rate over 10m ⇒ allowlist/geo misconfig or attack)
SELECT blob1 AS event, count() AS n
FROM edgepay_metrics
WHERE blob1 IN ('webhook_ip_rejected', 'webhook_geo_rejected', 'webhook_signature_rejected')
  AND timestamp > NOW() - INTERVAL '10' MINUTE
GROUP BY event;

-- SMS parse health per merchant
SELECT blob1 AS event, index1 AS merchant_id, count() AS n
FROM edgepay_metrics
WHERE blob1 IN ('sms_parse_miss', 'sms_parse_confirmed', 'sms_manual_review')
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY event, merchant_id ORDER BY n DESC;

-- Ledger heal / reconciliation runs
SELECT blob1 AS event, count() AS n
FROM edgepay_metrics
WHERE blob1 IN ('ledger_posting_healed', 'reconciliation_run')
  AND timestamp > NOW() - INTERVAL '24' HOUR
GROUP BY event;
```

Alert: `rate_limit_degraded > 0` in any 5-minute window means the
`RATE_LIMIT_READ`/`RATE_LIMIT_WRITE` bindings are absent or failing and
per-key limits are fail-open (allowed + metric). Fix the binding, do not
tune the alert away.

## 3. D1 quota alert

Plan quotas (see `wrangler.jsonc`):

- Free: 5 GB storage, **5M rows read/day, 100K rows written/day**
- Paid: 10 GB storage, 25B rows read/day, 50M rows written/day

Wire a Cloudflare dashboard alert on D1 rows-read/written:

- Warn at **70%** of the daily quota (read or write) — investigate hot
  paths (deliveries polling, trial-balance scans, SMS backlog queries).
- Page at **90%** —Writes past quota fail the payment/refund write path;
  enable Paid cap or shed load (shorten delivery-log retention, reduce
  dashboard poll intervals) before the cap bites.

## 4. Edge rate-limit rules (dashboard)

Configure these as native edge rules **before** the Worker runs (zero CPU,
zero cost). The in-Worker layers (`src/middleware/rate-limit.ts`) stay
authoritative per-key/per-IP; the edge rules absorb volumetric abuse:

| scope | rule | action |
| --- | --- | --- |
| `/api/*` | **120 requests/min per IP** | challenge (managed) then block on repeat |
| `/install*` | **3 requests/hour per IP** | block (matches the in-Worker `install` group) |
| `/auth/*` (login, OTP, token refresh, bootstrap-key) | **5 requests/5 min per IP** | block with `Retry-After` |

Keep the in-Worker groups aligned with these ceilings:

- Authenticated API: per-key native bindings — 120/min reads
  (`RATE_LIMIT_READ`), 30/min writes (`RATE_LIMIT_WRITE`); absent
  binding degrades to allow + `rate_limit_degraded` metric, never silent.
- Anonymous: `install` 3/h, `password` 5/h (bootstrap-key),
  `otp` 10/h, `checkout` 30/10m, `mobile` 60/min — per-IP KV counters,
  fail-closed 503 `RATE_LIMIT_DEGRADED` on KV errors in production.

After any rule change: `wrangler tail` for 10 minutes and confirm
`rate_limited` metrics track the new ceiling with no `rate_limit_degraded`
companion spike.
