/**
 * Smoke tests — verify the Worker boots and responds to requests.
 *
 * These tests validate that:
 *   - The Worker module loads without errors
 *   - The Hono app can dispatch requests
 *   - The health endpoint returns 200 OK
 *   - Unknown routes are handled gracefully (not crashed)
 *
 * Detailed behavior tests (auth, rate limiting, idempotency) require
 * D1 schema setup and are covered in tests/integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Worker boot', () => {
  it('responds to /api/v1/health with 200 OK', async () => {
    const response = await SELF.fetch('http://localhost/api/v1/health');
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { status: string } };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('responds to unknown routes without crashing the runtime', async () => {
    // The Worker must always return a Response — never throw unhandled
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
