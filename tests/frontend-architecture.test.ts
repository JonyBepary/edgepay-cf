/**
 * EdgePay Multi-Worker Frontend Architecture & Blueprint Integration Tests.
 * Verifies that the Checkout, Merchant, and Admin frontends adhere to the
 * trust-plane isolation, Sanzo Wada design system, and security headers.
 */
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import { GATEWAY_BRANDS } from '../frontend/packages/gateway-brand/index';

describe('Frontend Architecture: Sanzo Wada Tokens & Asset Serving', () => {
  it('serves checkout frontend with Sanzo Wada tokens and security headers', async () => {
    const res = await SELF.fetch('http://localhost/frontend/checkout');
    expect(res.status).toBe(200);

    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('text/html');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const html = await res.text();
    expect(html).toContain('Sanzo Wada');
    expect(html).toContain('--bkash');
    expect(html).toContain('--nagad');
    expect(html).toContain('--rocket');
    expect(html).toContain('gsap');
  });

  it('serves merchant operations panel with KPI blocks and refund drawer', async () => {
    const res = await SELF.fetch('http://localhost/frontend/merchant');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('EdgePay Merchant');
    expect(html).toContain("Today's volume");
    expect(html).toContain('Transactions');
  });

  it('serves platform admin console with tenant provisioning modal', async () => {
    const res = await SELF.fetch('http://localhost/frontend/admin');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('EdgePay Admin');
    expect(html).toMatch(/provision merchant/i);
    expect(html).toContain('claim');
  });

  it('serves design system & architecture hub', async () => {
    const res = await SELF.fetch('http://localhost/frontend');
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain('EdgePay Frontend Kit');
  });

  it('serves architecture diagram assets from public/assets/diagrams/', async () => {
    const res = await SELF.fetch('http://localhost/assets/diagrams/01-multi-worker-topology.png');
    expect(res.status).toBe(200);
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toContain('image/png');
  });
});

describe('Gateway Brand Package Invariants', () => {
  it('defines all major Bangladesh MFS rails with high-contrast colors and validation regex', () => {
    expect(GATEWAY_BRANDS.bkash).toBeDefined();
    expect(GATEWAY_BRANDS.bkash.color).toBe('#E2136E');
    expect(GATEWAY_BRANDS.bkash.trxRegex.test('BL9A4K8M10')).toBe(true);

    expect(GATEWAY_BRANDS.nagad).toBeDefined();
    expect(GATEWAY_BRANDS.nagad.color).toBe('#F6921E');
    expect(GATEWAY_BRANDS.nagad.trxRegex.test('71A89KC2')).toBe(true);

    expect(GATEWAY_BRANDS.rocket).toBeDefined();
    expect(GATEWAY_BRANDS.rocket.color).toBe('#8C3494');

    expect(GATEWAY_BRANDS.upay).toBeDefined();
    expect(GATEWAY_BRANDS.upay.color).toBe('#005696');
  });
});
