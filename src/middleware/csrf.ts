/**
 * CSRF middleware — port of EdgePay's CsrfMiddleware.
 *
 * In a Workers + Hono app:
 *   - CSRF token is generated per session (stored in KV under session:<id>)
 *   - Token returned to client via Set-Cookie (HttpOnly + SameSite=Strict)
 *   - All non-GET requests must include X-CSRF-Token header matching token
 *   - Token rotates every 24 hours
 *
 * Exemptions:
 *   - /api/* routes (use bearer auth, no CSRF needed)
 *   - /webhook/* routes (use HMAC signature verification instead)
 *   - /install/* routes (no session established yet)
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { randomToken } from '../lib/crypto';

interface AppVars {
  requestId: string;
  merchantId: number | null;
  authType: 'bearer' | 'jwt' | 'session' | null;
  authSubject: number | null;
  authScopes: string[];
  csrfToken: string;
  cspNonce: string;
  startTime: number;
}

const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_NAME = 'edgepay_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const CSRF_TTL_SEC = 86400; // 24h

export const csrfMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVars }> = async (c, next) => {
  const path = c.req.path;

  // Skip for non-browser routes
  if (
    path.startsWith('/api/') ||
    path.startsWith('/webhook/') ||
    path.startsWith('/install/') ||
    path.startsWith('/cron/') ||
    path === '/api/v1/health'
  ) {
    return await next();
  }

  // Only check state-changing methods
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // Issue a CSRF token via cookie if none exists
    const existingToken = getCookie(c.req.header('Cookie') ?? '', CSRF_COOKIE_NAME);
    if (!existingToken) {
      const token = randomToken(CSRF_TOKEN_LENGTH);
      setCsrfCookie(c, token);
      c.set('csrfToken', token);
    } else {
      c.set('csrfToken', existingToken);
    }
    return await next();
  }

  // State-changing request — verify token
  const headerToken = c.req.header(CSRF_HEADER);
  const cookieToken = getCookie(c.req.header('Cookie') ?? '', CSRF_COOKIE_NAME);

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return c.json({
      success: false,
      error: {
        code: 'CSRF_TOKEN_INVALID',
        message: 'CSRF token missing or invalid',
      },
    }, 403);
  }

  c.set('csrfToken', cookieToken);
  await next();
};

function getCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function setCsrfCookie(c: { header: (k: string, v: string) => void }, token: string): void {
  c.header('Set-Cookie', `${CSRF_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${CSRF_TTL_SEC}`);
}
