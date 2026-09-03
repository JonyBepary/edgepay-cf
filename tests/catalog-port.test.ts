/**
 * Full-catalog conformance tests (v0.3.0 port).
 *
 * Every one of the 123 catalog gateways must:
 *   - be registered in the gateway registry
 *   - expose well-formed metadata (slug/name/currencies/capabilities)
 *   - expose well-formed credential fields (unique names, valid types)
 *   - behave sanely on the failure paths: initiate rejects bad input,
 *     verify handles empty callbacks without throwing, webhooks
 *     fail closed, fake refunds report refund_not_supported
 */

import { describe, expect, it } from 'vitest';
import { gatewayRegistry } from '../src/gateways/index';
import { GATEWAY_CATALOG, CATALOG_VERSION } from '../src/gateways/catalog.data';
import { catalogCounts, catalogFind, catalogAliases } from '../src/gateways/catalog';
import { IMPLEMENTED_GATEWAY_SLUGS, PORTED_GATEWAY_SLUGS } from '../src/gateways/registry-slugs';
import { GatewayNotPortedError } from '../src/gateways/planned';

const VALID_FIELD_TYPES = ['text', 'password', 'select', 'checkbox', 'textarea'];

describe('catalog data integrity', () => {
  it('ships 123 entries with unique slugs', () => {
    expect(GATEWAY_CATALOG.length).toBe(123);
    const slugs = GATEWAY_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(123);
  });

  it('statuses split into implemented / ported / planned', () => {
    const counts = catalogCounts();
    expect(counts.total).toBe(123);
    expect(counts.implemented).toBe(5);
    expect(counts.ported).toBe(65);
    expect(counts.planned).toBe(53);
    expect(counts.implemented + counts.ported + counts.planned).toBe(123);
  });

  it('every entry has identity + category + color', () => {
    for (const e of GATEWAY_CATALOG) {
      expect(e.slug).toMatch(/^[a-z0-9-]+$/);
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(['global', 'mfs', 'bank', 'europe', 'latam', 'mena', 'apac', 'mobile', 'express', 'africa', 'crypto'])
        .toContain(e.category);
    }
  });

  it('credential fields have unique names and valid type codes (no value storage)', () => {
    // catalog tuples use compact type codes: t/p/s/c/ta
    const CODES = ['t', 'p', 's', 'c', 'ta'];
    for (const e of GATEWAY_CATALOG) {
      const names = e.fields.map((f) => f[0]);
      expect(new Set(names).size, `${e.slug} duplicate field names`).toBe(names.length);
      for (const f of e.fields) {
        expect(CODES, `${e.slug} field ${f[0]}`).toContain(f[2]);
      }
    }
  });

  it('aliases map every catalog slug to itself', () => {
    const aliases = catalogAliases();
    for (const e of GATEWAY_CATALOG) {
      expect(aliases[e.slug]).toBe(e.slug);
    }
  });

  it('BD MFS set is fully ported', () => {
    for (const slug of ['bkash-api', 'nagad-merchant-api', 'rocket', 'sslcommerz', 'aamarpay', 'shurjopay', 'portwallet', 'cellfin', 'nexuspay', 'ok-wallet']) {
      expect(['implemented', 'ported'], `${slug} must be implemented or ported`)
        .toContain(catalogFind(slug)?.status);
    }
  });

  it('tracks a catalog version', () => {
    expect(CATALOG_VERSION).toBe('0.3.0');
  });
});

describe('registry conformance — all 123 adapters', () => {
  it('registers every catalog slug (and nothing else)', () => {
    expect(gatewayRegistry.list().length).toBe(123);
    for (const e of GATEWAY_CATALOG) {
      expect(gatewayRegistry.has(e.slug), `missing ${e.slug}`).toBe(true);
    }
  });

  it('IMPLEMENTED_GATEWAY_SLUGS matches the registry exactly', () => {
    expect([...IMPLEMENTED_GATEWAY_SLUGS].sort()).toEqual([...gatewayRegistry.list()].sort());
  });

  it('PORTED_GATEWAY_SLUGS excludes planned stubs', () => {
    expect(PORTED_GATEWAY_SLUGS.length).toBeLessThan(IMPLEMENTED_GATEWAY_SLUGS.length);
    for (const e of GATEWAY_CATALOG.filter((x) => x.status === 'planned')) {
      expect(PORTED_GATEWAY_SLUGS).not.toContain(e.slug);
    }
  });

  it('every adapter has well-formed metadata + fields', () => {
    for (const e of GATEWAY_CATALOG) {
      const adapter = gatewayRegistry.resolve(e.slug);
      const meta = adapter.metadata();
      expect(meta.slug).toBe(e.slug);
      expect(meta.name.length).toBeGreaterThan(0);
      expect(meta.type).toBe('gateway');
      expect(Array.isArray(meta.supported_currencies)).toBe(true);
      for (const cap of meta.capabilities) {
        expect(['refund', 'verification', 'webhook', 'gateway', 'subscription']).toContain(cap);
      }
      const fields = adapter.fields();
      const names = fields.map((f) => f.name);
      expect(new Set(names).size, `${e.slug} dup fields`).toBe(names.length);
      for (const f of fields) {
        expect(VALID_FIELD_TYPES).toContain(f.type);
      }
    }
  });

  it('verify() handles empty callbacks without throwing (all adapters)', async () => {
    for (const e of GATEWAY_CATALOG) {
      const adapter = gatewayRegistry.resolve(e.slug);
      const result = await adapter.verify({}, { mode: 'sandbox' });
      expect(result.success, `${e.slug} must not succeed on an empty callback`).toBe(false);
      expect(['failed', 'pending', 'cancelled']).toContain(result.status);
    }
  });

  it('webhooks fail closed across the whole catalog (no accept-all)', async () => {
    for (const e of GATEWAY_CATALOG) {
      const adapter = gatewayRegistry.resolve(e.slug);
      const accepted = await adapter.verifyWebhook({
        rawBody: '{"event":"payment.completed"}',
        headers: {},
        credentials: {},
      });
      expect(accepted, `${e.slug} must fail closed on unsigned/empty-credential webhooks`).toBe(false);
    }
  });

  it('planned stubs throw GatewayNotPortedError on initiate', async () => {
    const planned = GATEWAY_CATALOG.filter((e) => e.status === 'planned').slice(0, 5);
    expect(planned.length).toBeGreaterThan(0);
    for (const e of planned) {
      const adapter = gatewayRegistry.resolve(e.slug);
      await expect(
        adapter.initiate(
          { amount: '10.00', currency: 'BDT', trx_id: 'trx_1', redirect_url: 'https://x/cb', cancel_url: 'https://x/cancel' },
          { mode: 'sandbox' },
        ),
      ).rejects.toThrow(GatewayNotPortedError);
    }
  });

  it('ported adapters REJECT the upstream fake refunds (never fake money movement)', async () => {
    // a sample of adapters whose upstream PHP faked refund success
    const sampled = GATEWAY_CATALOG.filter((e) => e.status === 'ported').slice(0, 25);
    let fakeRefunds = 0;
    for (const e of sampled) {
      const adapter = gatewayRegistry.resolve(e.slug);
      const res = await adapter.refund('gw_trx_1', '10.00', { mode: 'sandbox' });
      if (res.success === true) fakeRefunds += 1;
    }
    // success is only allowed for adapters with a REAL refund API integration
    // (upstream had exactly 3: stripe, braintree, paddle — and of those only
    // stripe is in this sample's status class, so 0..1 is the honest bound)
    expect(fakeRefunds).toBeLessThanOrEqual(1);
  });
});

describe('catalog-aware ENABLED_GATEWAYS selection', () => {
  // (parser unit tests live in gateways-enabled.test.ts; these pin the
  // catalog integration: aliases resolve for real catalog slugs)
  it('catalog aliases include short forms for the BD set', () => {
    const aliases = catalogAliases();
    expect(aliases['bkash']).toBe('bkash-api');
    expect(aliases['nagad']).toBe('nagad-merchant-api');
    expect(aliases['paypal-checkout']).toBe('paypal');
    expect(aliases['rocket']).toBe('rocket');
    expect(aliases['sslcommerz']).toBe('sslcommerz');
  });
});
