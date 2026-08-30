/**
 * API reference tests (v0.2.3 — OpenAPI 3.1 document + Scalar rendering).
 *
 * Covers:
 *   1. GET /api/openapi.json — valid document: 3.1.0, deployment-derived
 *      version/servers, security schemes, every major path group, and the
 *      outbound webhook declarations.
 *   2. GET /api/reference — Scalar HTML shell with the PINNED CDN script and
 *      a per-request nonce that is CONSISTENT between the script tags and the
 *      Content-Security-Policy header.
 *   3. CSP isolation — the tailored docs-page policy does NOT leak onto other
 *      /api/* responses, which keep the strict nonce policy
 *      (script-src 'self' 'nonce-…', no external script origins).
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

const PINNED_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.67.0';

describe('GET /api/openapi.json', () => {
  it('serves a valid OpenAPI 3.1 document for this deployment', async () => {
    const res = await SELF.fetch('http://localhost/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string; version: string };
      servers: Array<{ url: string }>;
      paths: Record<string, unknown>;
      webhooks: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown>; schemas: Record<string, unknown> };
    };

    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toContain('EdgePay');
    expect(doc.info.version).toBe('0.3.0');
    expect(doc.servers[0].url).toBeTruthy();
  });

  it('documents every major surface', async () => {
    const res = await SELF.fetch('http://localhost/api/openapi.json');
    const doc = (await res.json()) as { paths: Record<string, unknown>; webhooks: Record<string, unknown> };

    const expectedPaths = [
      '/api/v1/health',
      '/api/v1/gateways',
      '/api/v1/payments',
      '/api/v1/refunds',
      '/api/v1/api-keys',
      '/api/v1/webhooks/deliveries',
      '/api/mobile/v1/devices',
      '/api/mobile/v1/sms',
      '/api/admin/v1/refunds',
      '/api/admin/v1/reconcile',
      '/api/admin/v1/ledger/trial-balance',
      '/webhook/{gateway}',
      '/checkout/{token}',
      '/install',
      '/api/reference',
      '/api/openapi.json',
    ];
    for (const p of expectedPaths) {
      expect(doc.paths[p], `missing path ${p}`).toBeDefined();
    }
    expect(Object.keys(doc.paths).length).toBeGreaterThanOrEqual(25);

    for (const w of ['payment.completed', 'refund.completed', 'webhook.test']) {
      expect(doc.webhooks[w], `missing webhook ${w}`).toBeDefined();
    }
  });

  it('declares the three auth schemes', async () => {
    const res = await SELF.fetch('http://localhost/api/openapi.json');
    const doc = (await res.json()) as { components: { securitySchemes: Record<string, { type: string }> } };
    expect(doc.components.securitySchemes.ApiKeyAuth.type).toBe('http');
    expect(doc.components.securitySchemes.MobileJwt.type).toBe('http');
    expect(doc.components.securitySchemes.AccessJwt.type).toBe('apiKey');
  });

  it('keeps the strict nonce CSP on the JSON document (not just HTML routes)', async () => {
    const res = await SELF.fetch('http://localhost/api/openapi.json');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).not.toContain('cdn.jsdelivr.net');
  });
});

describe('GET /api/reference — Scalar rendering', () => {
  it('serves the HTML shell with the PINNED CDN bundle', async () => {
    const res = await SELF.fetch('http://localhost/api/reference');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain(`src="${PINNED_CDN}"`);
    expect(html).toContain('/api/openapi.json');
  });

  it('uses a nonce on BOTH script tags and keeps scripts strict (no unsafe-inline)', async () => {
    const res = await SELF.fetch('http://localhost/api/reference');
    const html = await res.text();

    // Extract the nonce from the CDN script tag
    const m = html.match(/<script[^>]*nonce="([^"]+)"/);
    expect(m, 'script tag must carry a nonce').not.toBeNull();
    const htmlNonce = m![1];

    // BOTH script tags carry the same nonce (split-based count: the nonce is
    // random base64 and may contain regex metacharacters like + or /, which
    // would break a naive `new RegExp(nonce)` — this was a flaky assertion)
    expect(html.split(`nonce="${htmlNonce}"`).length - 1).toBeGreaterThanOrEqual(2);

    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain(`script-src 'self' 'nonce-${htmlNonce}' https://cdn.jsdelivr.net`);
    expect(csp).toContain("style-src 'self' 'unsafe-inline'"); // Scalar runtime styles
    expect(csp).toContain("frame-ancestors 'none'");

    // script-src must NOT contain unsafe-inline — extract just that directive
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it('generates a FRESH nonce per request', async () => {
    const extract = async () => {
      const res = await SELF.fetch('http://localhost/api/reference');
      const html = await res.text();
      return html.match(/<script[^>]*nonce="([^"]+)"/)![1];
    };
    const n1 = await extract();
    const n2 = await extract();
    expect(n1).not.toBe(n2);
  });

  it('other OWASP headers still apply on the docs page', async () => {
    const res = await SELF.fetch('http://localhost/api/reference');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});
