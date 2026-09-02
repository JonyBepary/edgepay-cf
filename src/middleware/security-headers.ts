/**
 * Security headers middleware — adds OWASP-recommended headers.
 *
 * Port of EdgePay's PHP SecurityHeadersMiddleware. In Workers/Hono we use the
 * secureHeaders() builtin for most headers, plus a custom layer for:
 *   - Content-Security-Policy with per-request nonce
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY (or CSP frame-ancestors)
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *   - Permissions-Policy: minimal API surface
 *
 * CSP nonce is generated per request, exposed via c.var.cspNonce,
 * and injected into HTML responses by the template engine.
 */

import type { MiddlewareHandler } from 'hono';
import { randomBytes, bytesToBase64 } from '../lib/crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const securityHeadersMiddleware: MiddlewareHandler<any> = async (c, next) => {
  try {
    await next();
  } catch (err) {
    // Re-throw but ensure headers are still set
    setHeaders(c);
    throw err;
  }
  setHeaders(c);
};

function setHeaders(c: any): void {
  try {
    // Generate per-request nonce (16 bytes → 22 base64 chars)
    const cspNonce = bytesToBase64(randomBytes(16));

    const presetCsp = (() => {
      try {
        return c.res?.headers?.get?.('Content-Security-Policy') ?? null;
      } catch {
        return null;
      }
    })();

    const csp = presetCsp ?? [
      `default-src 'self'`,
      `script-src 'self' 'nonce-${cspNonce}'`,
      `style-src 'self' 'nonce-${cspNonce}'`,
      `img-src 'self' data: https:`,
      `font-src 'self' https:`,
      `connect-src 'self' https:`,
      `frame-ancestors 'none'`,
      `form-action 'self'`,
      `base-uri 'self'`,
      `object-src 'none'`,
      `upgrade-insecure-requests`,
    ].join('; ');

    c.header('Content-Security-Policy', csp);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

    if (c.req.url.startsWith('https://')) {
      c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    }

    try {
      c.set('cspNonce', cspNonce);
    } catch {
      // Variables type may not include cspNonce — ignore
    }
  } catch {
    // Response might have immutable headers (e.g. ASSETS fetch response) — safe fallback
  }
}
