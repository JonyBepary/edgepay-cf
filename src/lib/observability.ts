/**
 * Observability primitives (review: "page on reconciliation drift rather
 * than logging" + Analytics Engine for per-merchant/per-gateway metrics
 * without touching D1).
 *
 * Two channels:
 *
 *   page()  — structured console.error with level='page'. Wire Logpush
 *             (or Workers Logs alerts) to route level=page straight to
 *             your on-call channel. Reconciliation drift, exhausted
 *             postings, stuck refunds, and break-glass usage all page.
 *             FREE-TIER NOTE: Logpush requires Workers Paid; on the free
 *             plan use Workers Logs (200K events/day) alert rules on the
 *             same level=page marker.
 *
 *   metric() — Analytics Engine datapoints (100K/day free) keyed by
 *             merchant for parse-miss rate, webhook lag, posting heal
 *             counts, rate-limit hits. Queryable per merchant/gateway
 *             in SQL without a single D1 read.
 */

import type { Env } from '../types/env';

type MetricValue = string | number | boolean | null | undefined;

/** Emit a PAGE-severity event. This is the paging contract — never demote. */
export function page(env: Env, code: string, detail: Record<string, unknown>): void {
  // Two independent sinks: Workers Logs (always) + Analytics Engine (if bound)
  console.error(JSON.stringify({
    level: 'page',
    code,
    detail,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
  }));
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: ['page', code, JSON.stringify(detail).slice(0, 4500)],
      indexes: [String(detail.merchant_id ?? 'platform')],
    });
  } catch {
    // Analytics must never break the code path that is paging
  }
}

/** Emit a structured info/error log line (Logpush/Workers Logs queryable). */
export function logEvent(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, MetricValue> = {},
): void {
  console.log(JSON.stringify({ level, event, ...fields, timestamp: new Date().toISOString() }));
}

/**
 * Emit an Analytics Engine datapoint. dims.merchant_id (when present)
 * becomes the AE index so metrics are per-merchant queryable.
 */
export function metric(env: Env, event: string, dims: Record<string, MetricValue> = {}): void {
  try {
    env.ANALYTICS?.writeDataPoint({
      blobs: [
        event,
        String(dims.merchant_id ?? ''),
        String(dims.gateway ?? ''),
        String(dims.extra ?? ''),
      ],
      doubles: [typeof dims.value === 'number' ? dims.value : 0],
      indexes: [String(dims.merchant_id ?? 'platform')],
    });
  } catch {
    // Never let telemetry break the request path
  }
}
