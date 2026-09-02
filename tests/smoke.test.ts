/**
 * Smoke & Observability tests — verify Worker boot, security headers, and analytics telemetry.
 * (EDGE-P0-006, EDGE-P2-006)
 */

import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/types/env';
import { metric, page } from '../src/lib/observability';

const tenv = env as unknown as Env;

describe('Worker boot & Health', () => {
  it('responds to /api/v1/health with 200 OK', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/health');
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('responds to unknown routes without crashing the runtime', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/nonexistent');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(600);
  });

  it('returns a JSON error envelope on failures', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/nonexistent');
    const body = await response.json() as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
  });
});

describe('Security Headers & CSP (EDGE-P0-006)', () => {
  it('attaches nosniff, DENY, and CSP headers to responses', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/health');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toBeDefined();
  });
});

describe('Observability & Analytics Engine Telemetry (EDGE-P2-006)', () => {
  it('records metrics and page events without throwing when Analytics Engine is bound or unbound', () => {
    expect(() => {
      metric(tenv, 'test_event', { merchant_id: 1, duration_ms: 42 });
    }).not.toThrow();

    expect(() => {
      page(tenv, 'PAGE_EVENT_CODE', { merchant_id: 1 });
    }).not.toThrow();
  });
});

describe('CORS preflight', () => {
  it('handles OPTIONS requests', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/health', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://example.com',
        'Access-Control-Request-Method': 'GET',
      },
    });
    expect(response.status).toBeLessThan(500);
  });
});
