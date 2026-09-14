import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { sha256 } from '../src/lib/crypto';
import { TEST_MERCHANT_RANGES } from './test-ids';
import { HierarchyService } from '../src/services/hierarchy';
import m14 from '../migrations/0014_hierarchy_backfill.sql?raw';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.HIERARCHY;

function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map(s => s.replace(/^\s*--[^\n]*$/gm, '').trim())
    .filter(s => s.length > 0);
}

async function applyMigration14(database: D1Database) {
  const stmts = splitStatements(m14);
  for (const s of stmts) {
    await database.prepare(s).run();
  }
}

describe('Domain Hierarchy (Phase 6a)', () => {
  const merchantA = range.start + 100;
  const merchantB = range.start + 101;
  const now = new Date().toISOString();

  // API key for Merchant A
  const keyPrefixA = `ha${String(merchantA).padStart(10, '0')}`.slice(0, 12);
  const keyRestA = `ka${String(merchantA).padStart(30, '0')}`.slice(0, 32);
  const apiKeyA = `op_live_${keyPrefixA}_${keyRestA}`;

  // API key for Merchant B
  const keyPrefixB = `hb${String(merchantB).padStart(10, '0')}`.slice(0, 12);
  const keyRestB = `kb${String(merchantB).padStart(30, '0')}`.slice(0, 32);
  const apiKeyB = `op_live_${keyPrefixB}_${keyRestB}`;

  beforeAll(async () => {
    // Seed Merchant A
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'Hierarchy Merchant A', 'hierarchy-a', 'ha@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantA, crypto.randomUUID(), now, now).run();

    // Seed Merchant B
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'Hierarchy Merchant B', 'hierarchy-b', 'hb@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantB, crypto.randomUUID(), now, now).run();

    // Seed API key A (scopes: read, write, admin)
    const keyHashA = await sha256(apiKeyA);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(keyPrefixA).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'key-a', ?, ?, ?, 'active', 0, ?)`
    ).bind(merchantA, keyPrefixA, keyHashA, JSON.stringify(['read', 'write', 'admin']), now).run();

    // Seed API key B (scopes: read, write, admin)
    const keyHashB = await sha256(apiKeyB);
    await db.prepare(`DELETE FROM op_api_keys WHERE key_prefix = ?`).bind(keyPrefixB).run();
    await db.prepare(
      `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_by, created_at)
       VALUES (?, 'key-b', ?, ?, ?, 'active', 0, ?)`
    ).bind(merchantB, keyPrefixB, keyHashB, JSON.stringify(['read', 'write', 'admin']), now).run();
  });

  // 1. Backfill created Main brand for a merchant without one
  it('1. Backfill created Main brand for a merchant without one', async () => {
    const testM = range.start + 110;
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, status)
       VALUES (?, ?, 'Merchant 110', 'm-110', 'm110@test.local', 'Asia/Dhaka', 'BDT', 'active')
       ON CONFLICT(id) DO NOTHING`
    ).bind(testM, crypto.randomUUID()).run();

    await applyMigration14(db);

    const brands = await db.prepare(
      `SELECT * FROM op_brands WHERE merchant_id = ? AND slug = 'main'`
    ).bind(testM).all<{ id: number; name: string; slug: string; status: string }>();

    expect(brands.results).toHaveLength(1);
    expect(brands.results[0].name).toBe('Main');
    expect(brands.results[0].status).toBe('active');
  });

  // 2. Backfill created Main store for the brand
  it('2. Backfill created Main store for the brand', async () => {
    const testM = range.start + 110;
    const stores = await db.prepare(
      `SELECT s.* FROM op_stores s
       JOIN op_brands b ON b.id = s.brand_id
       WHERE b.merchant_id = ? AND s.slug = 'main'`
    ).bind(testM).all<{ id: number; name: string; slug: string; default_currency: string; status: string }>();

    expect(stores.results).toHaveLength(1);
    expect(stores.results[0].name).toBe('Main');
    expect(stores.results[0].default_currency).toBe('BDT');
    expect(stores.results[0].status).toBe('active');
  });

  // 3. Backfill created one gate per existing gateway
  it('3. Backfill created one gate per existing gateway', async () => {
    const testM = range.start + 111;
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, status)
       VALUES (?, ?, 'Merchant 111', 'm-111', 'm111@test.local', 'Asia/Dhaka', 'BDT', 'active')
       ON CONFLICT(id) DO NOTHING`
    ).bind(testM, crypto.randomUUID()).run();

    const gw1 = await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, 'bkash-p-111', 'bKash Personal', 'manual', 'active')
       RETURNING id`
    ).bind(testM).first<{ id: number }>();

    const gw2 = await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, 'nagad-p-111', 'Nagad Personal', 'manual', 'active')
       RETURNING id`
    ).bind(testM).first<{ id: number }>();

    await applyMigration14(db);

    const gates = await db.prepare(
      `SELECT * FROM op_gates WHERE merchant_id = ? ORDER BY id ASC`
    ).bind(testM).all<{ id: number; gateway_id: number; status: string }>();

    expect(gates.results).toHaveLength(2);
    const gwIds = gates.results.map(g => g.gateway_id);
    expect(gwIds).toContain(gw1!.id);
    expect(gwIds).toContain(gw2!.id);
  });

  // 4. Backfill is idempotent
  it('4. Backfill is idempotent', async () => {
    const testM = range.start + 111;

    const brandCountBefore = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    const storeCountBefore = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    const gateCountBefore = await db.prepare(`SELECT count(*) as count FROM op_gates WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();

    // Run backfill again
    await applyMigration14(db);

    const brandCountAfter = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    const storeCountAfter = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    const gateCountAfter = await db.prepare(`SELECT count(*) as count FROM op_gates WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();

    expect(brandCountAfter?.count).toBe(brandCountBefore?.count);
    expect(storeCountAfter?.count).toBe(storeCountBefore?.count);
    expect(gateCountAfter?.count).toBe(gateCountBefore?.count);
  });

  // 5. Backfill populated FK columns
  it('5. Backfill populated FK columns', async () => {
    const testM = range.start + 112;
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, status)
       VALUES (?, ?, 'Merchant 112', 'm-112', 'm112@test.local', 'Asia/Dhaka', 'BDT', 'active')
       ON CONFLICT(id) DO NOTHING`
    ).bind(testM, crypto.randomUUID()).run();

    const gw = await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, 'bkash-p-112', 'bKash Personal', 'manual', 'active')
       RETURNING id`
    ).bind(testM).first<{ id: number }>();

    const intentUuid = crypto.randomUUID();
    const intentToken = `tok-112-${Date.now()}`;
    await db.prepare(
      `INSERT INTO op_payment_intents (merchant_id, uuid, token, amount, currency, gateway_id, status, expires_at)
       VALUES (?, ?, ?, 500, 'BDT', ?, 'pending', datetime('now', '+1 hour'))`
    ).bind(testM, intentUuid, intentToken, gw!.id).run();

    const trxId = `trx-112-${Date.now()}`;
    await db.prepare(
      `INSERT INTO op_transactions (merchant_id, trx_id, gateway_id, amount, net_amount, currency, status)
       VALUES (?, ?, ?, 500, 500, 'BDT', 'pending')`
    ).bind(testM, trxId, gw!.id).run();

    const user = await db.prepare(
      `INSERT INTO op_merchant_users (merchant_id, uuid, name, email, email_hash, password_hash, status)
       VALUES (?, ?, 'User 112', 'u112@test.local', 'hash112', 'pwdhash', 'active')
       RETURNING id`
    ).bind(testM, crypto.randomUUID()).first<{ id: number }>();

    const deviceUuid = crypto.randomUUID();
    await db.prepare(
      `INSERT INTO op_paired_devices (merchant_id, user_id, uuid, device_name, fingerprint, status)
       VALUES (?, ?, ?, 'Backfill Device', 'fp-112', 'active')`
    ).bind(testM, user!.id, deviceUuid).run();

    const domainName = `test-112-${Date.now()}.local`;
    await db.prepare(
      `INSERT INTO op_domains (merchant_id, domain, status, verification_token)
       VALUES (?, ?, 'pending', 'vt-112')`
    ).bind(testM, domainName).run();

    // Run backfill
    await applyMigration14(db);

    const intent = await db.prepare(
      `SELECT brand_id, store_id, gate_id FROM op_payment_intents WHERE token = ?`
    ).bind(intentToken).first<{ brand_id: number | null; store_id: number | null; gate_id: number | null }>();
    expect(intent?.brand_id).not.toBeNull();
    expect(intent?.store_id).not.toBeNull();
    expect(intent?.gate_id).not.toBeNull();

    const tx = await db.prepare(
      `SELECT brand_id, store_id, gate_id FROM op_transactions WHERE trx_id = ?`
    ).bind(trxId).first<{ brand_id: number | null; store_id: number | null; gate_id: number | null }>();
    expect(tx?.brand_id).not.toBeNull();
    expect(tx?.store_id).not.toBeNull();
    expect(tx?.gate_id).not.toBeNull();

    const device = await db.prepare(
      `SELECT store_id FROM op_paired_devices WHERE uuid = ?`
    ).bind(deviceUuid).first<{ store_id: number | null }>();
    expect(device?.store_id).not.toBeNull();

    const domain = await db.prepare(
      `SELECT brand_id FROM op_domains WHERE domain = ?`
    ).bind(domainName).first<{ brand_id: number | null }>();
    expect(domain?.brand_id).not.toBeNull();
  });

  // 6. Service: createBrand returns the created row
  it('6. Service: createBrand returns the created row', async () => {
    const svc = new HierarchyService(db);
    const row = await svc.createBrand({
      merchant_id: merchantA,
      name: 'Test Brand',
      slug: 'test-brand-6',
      brand_color: '#0055ff',
      support_email: 'support@testbrand.com',
    });

    expect(row.id).toBeGreaterThan(0);
    expect(typeof row.uuid).toBe('string');
    expect(row.uuid.length).toBeGreaterThan(0);
    expect(row.slug).toBe('test-brand-6');
    expect(row.brand_color).toBe('#0055ff');
    expect(row.support_email).toBe('support@testbrand.com');
  });

  // 7. Service: listBrands filters by merchant
  it('7. Service: listBrands filters by merchant', async () => {
    const svc = new HierarchyService(db);
    await svc.createBrand({
      merchant_id: merchantA,
      name: 'Alpha Only',
      slug: 'alpha-only-7',
    });
    await svc.createBrand({
      merchant_id: merchantB,
      name: 'Beta Only',
      slug: 'beta-only-7',
    });

    const listA = await svc.listBrands(merchantA);
    const listB = await svc.listBrands(merchantB);

    expect(listA.every(b => b.merchant_id === merchantA)).toBe(true);
    expect(listA.some(b => b.slug === 'alpha-only-7')).toBe(true);
    expect(listA.some(b => b.slug === 'beta-only-7')).toBe(false);

    expect(listB.every(b => b.merchant_id === merchantB)).toBe(true);
    expect(listB.some(b => b.slug === 'beta-only-7')).toBe(true);
    expect(listB.some(b => b.slug === 'alpha-only-7')).toBe(false);
  });

  // 8. Service: createStore scopes to brand
  it('8. Service: createStore scopes to brand', async () => {
    const svc = new HierarchyService(db);
    const brand = await svc.createBrand({
      merchant_id: merchantA,
      name: 'Store Parent Brand',
      slug: 'store-parent-8',
    });

    const store = await svc.createStore({
      merchant_id: merchantA,
      brand_id: brand.id,
      name: 'Gulshan Branch',
      slug: 'gulshan-branch-8',
      default_currency: 'BDT',
    });

    expect(store.id).toBeGreaterThan(0);
    expect(store.brand_id).toBe(brand.id);
    expect(store.merchant_id).toBe(merchantA);
    expect(store.slug).toBe('gulshan-branch-8');
    expect(store.default_currency).toBe('BDT');
  });

  // 9. Service: createGate with mfs_number
  it('9. Service: createGate with mfs_number', async () => {
    const svc = new HierarchyService(db);
    const brand = await svc.createBrand({
      merchant_id: merchantA,
      name: 'Gate Brand',
      slug: 'gate-brand-9',
    });

    const store = await svc.createStore({
      merchant_id: merchantA,
      brand_id: brand.id,
      name: 'Banani Branch',
      slug: 'banani-branch-9',
      default_currency: 'BDT',
    });

    const gw = await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, 'gw-gate-9', 'bKash Gate 9', 'manual', 'active')
       RETURNING id`
    ).bind(merchantA).first<{ id: number }>();

    const gate = await svc.createGate({
      store_id: store.id,
      merchant_id: merchantA,
      gateway_id: gw!.id,
      label: 'bKash Counter 1',
      currency: 'BDT',
      mfs_number: '01712345678',
    });

    expect(gate.id).toBeGreaterThan(0);
    expect(gate.mfs_number).toBe('01712345678');
    expect(gate.store_id).toBe(store.id);
    expect(gate.label).toBe('bKash Counter 1');
  });

  // 10. Service: resolveDefaultGate returns Main gate
  it('10. Service: resolveDefaultGate returns Main gate', async () => {
    const testM = range.start + 115;
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, status)
       VALUES (?, ?, 'Merchant 115', 'm-115', 'm115@test.local', 'Asia/Dhaka', 'BDT', 'active')
       ON CONFLICT(id) DO NOTHING`
    ).bind(testM, crypto.randomUUID()).run();

    const gw = await db.prepare(
      `INSERT INTO op_gateways (merchant_id, slug, name, type, status)
       VALUES (?, 'gw-115', 'Default Gate Test', 'manual', 'active')
       RETURNING id`
    ).bind(testM).first<{ id: number }>();

    await applyMigration14(db);

    const svc = new HierarchyService(db);
    const defaultGate = await svc.resolveDefaultGate(testM, gw!.id);

    expect(defaultGate).not.toBeNull();
    expect(defaultGate!.gateway_id).toBe(gw!.id);
    expect(defaultGate!.merchant_id).toBe(testM);
    expect(defaultGate!.status).toBe('active');
  });

  // 11. API: POST /api/v1/brands requires auth
  it('11. API: POST /api/v1/brands requires auth', async () => {
    const res = await SELF.fetch('https://test.local/api/v1/brands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.201',
      },
      body: JSON.stringify({ name: 'No Auth Brand', slug: 'no-auth' }),
    });

    expect(res.status).toBe(401);
  });

  // 12. API: POST /api/v1/brands creates brand
  it('12. API: POST /api/v1/brands creates brand', async () => {
    const res = await SELF.fetch('https://test.local/api/v1/brands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKeyA}`,
        'CF-Connecting-IP': '198.51.100.202',
      },
      body: JSON.stringify({
        name: 'API Brand A',
        slug: 'api-brand-a',
        brand_color: '#123456',
        support_email: 'api@brand-a.local',
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { id: number; uuid: string; slug: string } };
    expect(json.success).toBe(true);
    expect(json.data.slug).toBe('api-brand-a');

    const inDb = await db.prepare(`SELECT * FROM op_brands WHERE uuid = ?`).bind(json.data.uuid).first<{ id: number }>();
    expect(inDb).not.toBeNull();
    expect(inDb!.id).toBe(json.data.id);
  });

  // 13. API: GET /api/v1/brands/:id/stores cross-tenant isolation
  it('13. API: GET /api/v1/brands/:id/stores cross-tenant isolation', async () => {
    const svc = new HierarchyService(db);
    const brandA = await svc.createBrand({
      merchant_id: merchantA,
      name: 'Isolation Brand A',
      slug: 'iso-brand-a-13',
    });

    await svc.createStore({
      merchant_id: merchantA,
      brand_id: brandA.id,
      name: 'Store Under Brand A',
      slug: 'store-a-13',
      default_currency: 'BDT',
    });

    // Merchant B attempts to access Merchant A's brand stores
    const resB = await SELF.fetch(`https://test.local/api/v1/brands/${brandA.id}/stores`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKeyB}`,
        'CF-Connecting-IP': '198.51.100.203',
      },
    });

    expect(resB.status).toBe(404);

    // Merchant A can access their own brand stores
    const resA = await SELF.fetch(`https://test.local/api/v1/brands/${brandA.id}/stores`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKeyA}`,
        'CF-Connecting-IP': '198.51.100.204',
      },
    });

    expect(resA.status).toBe(200);
    const jsonA = (await resA.json()) as { success: boolean; data: Array<{ slug: string }> };
    expect(jsonA.success).toBe(true);
    expect(jsonA.data.some(s => s.slug === 'store-a-13')).toBe(true);
  });

  // 14. HierarchyService.provisionDefaultHierarchy is idempotent across repeated and parallel calls
  // Note: While workerd serializes D1/SQLite queries within an isolate, this verifies that multiple
  // simultaneous invocations produce exactly one brand and store without constraint violation throws.
  it('14. HierarchyService.provisionDefaultHierarchy is idempotent across repeated calls', async () => {
    const testM = range.start + 115;
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, status)
       VALUES (?, ?, 'Merchant 115', 'm-115', 'm115@test.local', 'Asia/Dhaka', 'BDT', 'active')
       ON CONFLICT(id) DO NOTHING`
    ).bind(testM, crypto.randomUUID()).run();

    const svc = new HierarchyService(db);
    // Simulate concurrent cold-start race: 5 parallel calls to provisionDefaultHierarchy
    const results = await Promise.all([
      svc.provisionDefaultHierarchy(testM, 'BDT'),
      svc.provisionDefaultHierarchy(testM, 'BDT'),
      svc.provisionDefaultHierarchy(testM, 'BDT'),
      svc.provisionDefaultHierarchy(testM, 'BDT'),
      svc.provisionDefaultHierarchy(testM, 'BDT'),
    ]);

    // All return identical brandId and storeId
    const first = results[0];
    expect(first.brandId).toBeGreaterThan(0);
    expect(first.storeId).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.brandId).toBe(first.brandId);
      expect(r.storeId).toBe(first.storeId);
    }

    // Only one brand and store exist
    const brands = await db.prepare(`SELECT count(*) as count FROM op_brands WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    const stores = await db.prepare(`SELECT count(*) as count FROM op_stores WHERE merchant_id = ?`).bind(testM).first<{ count: number }>();
    expect(brands?.count).toBe(1);
    expect(stores?.count).toBe(1);
  });
});
