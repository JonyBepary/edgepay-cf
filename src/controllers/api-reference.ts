/**
 * API reference routes — /api/reference (Scalar UI) + /api/openapi.json
 *
 * v0.2.3. The OpenAPI 3.1 document lives in src/openapi.ts; this controller
 * serves it and renders the interactive Scalar reference from it.
 *
 * Why Scalar's Hono middleware: it only emits an HTML shell that loads the
 * Scalar bundle from a PINNED jsDelivr URL — no Node APIs, workerd-safe
 * (verified by tests/api-reference.test.ts running inside workerd).
 *
 * CSP strategy: the global security-headers middleware enforces the strict
 * nonce policy (script-src 'self' 'nonce-…') on all JSON surfaces. The
 * reference page needs two relaxations — the pinned CDN script and
 * 'unsafe-inline' styles (Scalar injects runtime styles; a nonce can never
 * authorize inline style ATTRIBUTES, per Scalar's CSP guidance). This route
 * therefore ships its own tailored policy:
 *
 *   script-src 'self' 'nonce-<per-request>' https://cdn.jsdelivr.net   (no unsafe-inline scripts)
 *   style-src  'self' 'unsafe-inline'
 *
 * The nonce is generated per request here (NOT by the global middleware,
 * which runs after the handler and could not inject it into the HTML), passed
 * to Scalar's config so both script tags carry it, and mirrored into the CSP
 * header. security-headers.ts deliberately does not clobber a preset CSP —
 * all other /api/* responses keep the strict default.
 */

import { Hono } from 'hono';
import type { Env } from '../types/env';
import { Scalar } from '@scalar/hono-api-reference';
import { buildOpenApiDocument } from '../openapi';
import { randomBytes, bytesToBase64 } from '../lib/crypto';

/**
 * Pinned Scalar bundle. Bump deliberately (check
 * https://www.jsdelivr.com/package/npm/@scalar/api-reference?tab=files) and
 * keep the CSP host below in sync — the pin exists so a CDN-side compromise
 * or breaking release cannot silently change what this payment platform
 * serves on its docs page.
 */
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0';

type ReferenceEnv = { Bindings: Env; Variables: { scalarNonce: string } };

export const apiReferenceRoutes = new Hono<ReferenceEnv>();

/** The machine-readable contract — also consumable by codegen tooling. */
apiReferenceRoutes.get('/openapi.json', (c) => {
  return c.json(buildOpenApiDocument(c.env));
});

/**
 * The interactive reference. Two handlers:
 *   1. wrapper — generates the nonce (pre-next), applies the tailored CSP
 *      (post-next, once Scalar's HTML response exists);
 *   2. Scalar's terminal handler — renders the HTML shell, embedding the
 *      nonce on both script tags + the csp-nonce meta tag.
 */
apiReferenceRoutes.get(
  '/reference',
  async (c, next) => {
    c.set('scalarNonce', bytesToBase64(randomBytes(16)));
    await next();
    const nonce = c.get('scalarNonce');
    c.header(
      'Content-Security-Policy',
      [
        `default-src 'self'`,
        `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: https:`,
        `font-src 'self' https:`,
        `connect-src 'self'`,
        `frame-ancestors 'none'`,
        `form-action 'self'`,
        `base-uri 'self'`,
        `object-src 'none'`,
        `upgrade-insecure-requests`,
      ].join('; '),
    );
  },
  Scalar<ReferenceEnv>((c) => ({
    url: '/api/openapi.json',
    pageTitle: 'EdgePay API Reference & Documentation',
    cdn: SCALAR_CDN,
    nonce: c.get('scalarNonce'),
    theme: 'purple',
    layout: 'modern',
    showSidebar: true,
    hideDownloadButton: false,
    darkMode: true,
    searchHotKey: 'k',
    metaData: {
      title: 'EdgePay API Reference',
      description: 'Interactive API Reference for EdgePay Cloudflare-Native Payment Platform',
      ogDescription: 'Edge-native payment gateway and GAAP double-entry ledger for mobile financial services (bKash, Nagad, Rocket) and cards on Cloudflare Workers.',
      ogTitle: 'EdgePay API Reference',
    },
    customCss: `
      :root {
        --scalar-font: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --scalar-radius: 8px;
      }
      .scalar-card {
        border-radius: 8px;
        transition: all 0.2s ease-in-out;
      }
      .sidebar {
        font-size: 0.92rem;
      }
    `,
  })),
);
