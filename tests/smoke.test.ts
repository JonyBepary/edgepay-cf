/**
 * Smoke & Observability tests — verify Worker boot, security headers, and analytics telemetry.
 * (EDGE-P0-006, EDGE-P2-006, V7-003)
 */

import { describe, it, expect, vi } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { Env } from '../src/types/env';
import { metric, page } from '../src/lib/observability';

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

describe('Observability & Analytics Engine Telemetry (EDGE-P2-006 / V7-003)', () => {
  it('metric() writes a datapoint with indexes, doubles, and blobs when ANALYTICS is bound', () => {
    const writeDataPoint = vi.fn();
    const mockEnv = { ANALYTICS: { writeDataPoint }, ENVIRONMENT: 'production' } as unknown as Env;
    
    metric(mockEnv, 'payment_success', {
      merchant_id: 1,
      gateway: 'bkash',
      value: 42,
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const callArg = writeDataPoint.mock.calls[0][0];
    expect(callArg.indexes).toContain('1');
    expect(callArg.doubles).toContain(42);
    expect(callArg.blobs).toContain('payment_success');
    expect(callArg.blobs).toContain('bkash');
  });

  it('page() writes a datapoint when ANALYTICS is bound', () => {
    const writeDataPoint = vi.fn();
    const mockEnv = { ANALYTICS: { writeDataPoint }, ENVIRONMENT: 'production' } as unknown as Env;

    page(mockEnv, 'PAGE_CRITICAL_EVENT', {
      merchant_id: 1,
      error: 'TestError',
    });

    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const callArg = writeDataPoint.mock.calls[0][0];
    expect(callArg.blobs).toContain('PAGE_CRITICAL_EVENT');
  });

  it('metric() and page() gracefully no-op when ANALYTICS is unbound', () => {
    const emptyEnv = { ENVIRONMENT: 'production' } as unknown as Env;
    expect(() => {
      metric(emptyEnv, 'test_unbound', { merchant_id: 1 });
      page(emptyEnv, 'PAGE_UNBOUND', { merchant_id: 1 });
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
