/**
 * Rate limiting — v0.2.1 (review fix #5).
 *
 * v0.2.0 used per-IP KV counters only. Native edge rules (and KV
 * counters) cannot express PER-API-KEY quotas — one abusive integration
 * sharing a NAT/office IP with good clients gets everyone throttled,
 * and a single key hammered from a botnet never trips a per-IP rule.
 *
 * v0.2.1 uses the Workers Ratelimit BINDING as the primary primitive:
 *   - Authenticated routes: per-API-KEY counters (key = api key row id)
 *     across ALL IPs — 120/min reads, 30/min writes per key.
 *   - Anonymous routes (install, login, otp): per-IP KV counters as a
 *     fallback layer, since no authenticated subject exists yet.
 *   - A free edge rule (dashboard) still covers volumetric per-IP abuse
 *     BEFORE the Worker runs — zero CPU, zero cost.
 *
 * Degradation policy: if the binding is absent (misconfig / test env),
 * requests are ALLOWED and a metric is emitted — the API key check is
 * the authorization gate; rate limiting is abuse protection and must
 * not take payments down. Alert on rate_limit_degraded.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { metric } from '../lib/observability';

interface RateLimitConfig {
  windowSec: number;
  maxRequests: number;
  keyPrefix: string;
}

const ANON_ROUTE_LIMITS: Record<string, RateLimitConfig> = {
  'api-read':    { windowSec: 60, maxRequests: 120, keyPrefix: 'rl:api:r:' },
  'api-write':   { windowSec: 60, maxRequests: 30,  keyPrefix: 'rl:api:w:' },
  'mobile':      { windowSec: 60, maxRequests: 60,  keyPrefix: 'rl:mobile:' },
  'install':     { windowSec: 60, maxRequests: 120, keyPrefix: 'rl:install:' },
  'otp':         { windowSec: 3600, maxRequests: 10, keyPrefix: 'rl:otp:' },
  'password':    { windowSec: 3600, maxRequests: 10, keyPrefix: 'rl:pwd:' },
};

function rateLimitHeaders(c: { header: (k: string, v: string) => void }, limit: number, resetAt: number, remaining: number): void {
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, remaining)));
  c.header('X-RateLimit-Reset', String(Math.floor(resetAt / 1000)));
}

function getClientIp(headers: Headers): string {
  // CF-Connecting-IP is set by Cloudflare's edge — always trust it
  return headers.get('CF-Connecting-IP') ??
         headers.get('X-Real-IP') ??
         headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
         '0.0.0.0';
}

/**
 * Authenticated-route rate limiter — per API KEY (native Ratelimit
 * binding). Mount AFTER requireBearerApiAuth: it keys on the resolved
 * api key id (c.get('authSubject')).
 */
export const rateLimitMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Record<string, unknown> }> = async (c, next) => {
  const apiKeyId = c.get('authSubject') as number | null | undefined;

  if (apiKeyId == null) {
    // No authenticated subject on this route — fall through to per-IP
    // handling (anonymous variant below should be used instead).
    return next();
  }

  const binding = c.req.method === 'GET' || c.req.method === 'HEAD'
    ? c.env.RATE_LIMIT_READ
    : c.env.RATE_LIMIT_WRITE;
  const limit = c.req.method === 'GET' || c.req.method === 'HEAD' ? 120 : 30;

  if (!binding) {
    // Degraded mode — authz still enforced by the bearer middleware;
    // emit a metric so ops sees the missing binding.
    metric(c.env, 'rate_limit_degraded', { extra: c.req.path });
    return next();
  }

  const result = await binding.limit({ key: `key:${apiKeyId}` });

  if (!result.success) {
    rateLimitHeaders(c, limit, Date.now() + 60_000, 0);
    c.header('Retry-After', '60');
    metric(c.env, 'rate_limited', { merchant_id: c.get('merchantId') as number | undefined, extra: c.req.path });
    return c.json({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'API key rate limit exceeded. Please slow down.',
        retry_after_seconds: 60,
      },
    }, 429);
  }

  return next();
};

/**
 * Anonymous-route rate limiter — per IP via KV (login attempts, OTP
 * pairing, install). Keep volumes low: KV free tier allows only 1K
 * writes/day, so only mount this on genuinely anonymous, low-QPS paths.
 */
export function perIpRateLimit(group: keyof typeof ANON_ROUTE_LIMITS): MiddlewareHandler<{ Bindings: Env }> {
  const config = ANON_ROUTE_LIMITS[group];
  return async (c, next) => {
    const clientIp = getClientIp(c.req.raw.headers);
    const key = `${config.keyPrefix}${clientIp}:${c.req.path}`;

    const counterRaw = await c.env.KV.get(key);
    let count = 0;
    let resetAt = Date.now() + config.windowSec * 1000;

    if (counterRaw) {
      const parts = counterRaw.split('|');
      count = parseInt(parts[0], 10) || 0;
      resetAt = parseInt(parts[1], 10) || resetAt;
    }

    if (Date.now() > resetAt) {
      count = 0;
      resetAt = Date.now() + config.windowSec * 1000;
    }

    count++;

    if (count > config.maxRequests) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      rateLimitHeaders(c, config.maxRequests, resetAt, 0);
      c.header('Retry-After', String(retryAfter));
      return c.json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please slow down.',
          retry_after_seconds: retryAfter,
        },
      }, 429);
    }

    c.executionCtx.waitUntil(
      c.env.KV.put(key, `${count}|${resetAt}`, { expirationTtl: config.windowSec }),
    );

    rateLimitHeaders(c, config.maxRequests, resetAt, config.maxRequests - count);
    return next();
  };
}
