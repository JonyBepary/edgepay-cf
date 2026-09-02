/**
 * Static Assets Serving & Prefix Rewriting Discriminating Tests (V4-007, V5-008).
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';

describe('Static Assets Serving (V4-007 / V5-008)', () => {
  it('serves checkout.css with 200, text/css, and security headers', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/checkout.css');
    // Must return 200 (not hedged with 404)
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/css');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');

    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it('handles non-existent asset with clean 404 without throwing 500', async () => {
    const res = await SELF.fetch('http://localhost/assets/css/definitely-missing.css');
    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
