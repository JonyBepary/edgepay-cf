/**
 * Phase 6d Test Suite: Gate Administration (PATCH /api/admin/v1/gates/:id)
 *
 * Verifies:
 *   Test 6 — PATCH updates mfs_number and writes audit log.
 *   Test 7 — PATCH updates multiple fields atomically.
 *   Test 8 — PATCH rejects with no fields (400 NO_FIELDS).
 *   Test 9 — PATCH validates mfs_number format (+, length, null).
 *   Test 10 — PATCH rejects invalid status (400 INVALID_STATUS).
 *   Test 11 — PATCH on a gate from a different merchant is 404 (GATE_NOT_FOUND).
 *   Test 12 — PATCH requires admin scope (403 Forbidden).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { TEST_MERCHANT_RANGES } from './test-ids';
import { sha256 } from '../src/lib/crypto';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.GATE_ADMIN;

async function seedMerchant(merchantId: number, name = `Merchant ${merchantId}`) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(merchantId, crypto.randomUUID(), name, `m-${merchantId}`, `m${merchantId}@test.local`, now, now).run();
}

async function seedApiKey(merchantId: number, name: string, scopes: string[]): Promise<string> {
  const now = new Date().toISOString();
  const cleanName = name.replace(/[^a-zA-Z0-9]/g, '');
  const prefix = `a${String(merchantId).slice(-6)}${cleanName}`.slice(0, 12).padEnd(12, '0');
  const rest = crypto.randomUUID().replace(/[^a-zA-Z0-9]/g, '');
  const apiKey = `op_live_${prefix}_${rest}`;
  const keyHash = await sha256(apiKey);

  await db.prepare(
    `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  ).bind(merchantId, name, prefix, keyHash, JSON.stringify(scopes), now).run();

  return apiKey;
}

async function seedBrand(merchantId: number, name: string, slug: string): Promise<number> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(merchantId, crypto.randomUUID(), name, slug, now, now).run();
  const row = await db.prepare(
    `SELECT id FROM op_brands WHERE merchant_id = ? AND slug = ? LIMIT 1`
  ).bind(merchantId, slug).first<{ id: number }>();
  return row!.id;
}

async function seedStore(brandId: number, merchantId: number, name: string, slug: string): Promise<number> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, timezone, default_currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'active', ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(brandId, merchantId, crypto.randomUUID(), name, slug, now, now).run();
  const row = await db.prepare(
    `SELECT id FROM op_stores WHERE merchant_id = ? AND slug = ? LIMIT 1`
  ).bind(merchantId, slug).first<{ id: number }>();
  return row!.id;
}

async function seedGateway(merchantId: number, slug: string, name: string): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_gateways (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'active', 1, '["BDT"]', ?, ?)`
  ).bind(merchantId, slug, name, now, now).run();
  return Number(res.meta?.last_row_id);
}

async function seedGate(storeId: number, merchantId: number, gatewayId: number, label: string, mfsNumber: string | null = null): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_gates (store_id, merchant_id, gateway_id, label, mfs_number, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'BDT', 'active', ?, ?)`
  ).bind(storeId, merchantId, gatewayId, label, mfsNumber, now, now).run();
  return Number(res.meta?.last_row_id);
}

describe('Gate Administration (Phase 6d)', () => {
  const m1 = range.start + 1;
  let adminApiKey1: string;
  let readOnlyApiKey1: string;
  let gateId1: number;

  beforeAll(async () => {
    await seedMerchant(m1, 'Primary Gate Merchant');
    adminApiKey1 = await seedApiKey(m1, 'admin', ['admin', 'read', 'write']);
    readOnlyApiKey1 = await seedApiKey(m1, 'readonly', ['read']);

    const brandId = await seedBrand(m1, 'Brand 1', 'main');
    const storeId = await seedStore(brandId, m1, 'Store 1', 'main');
    const gatewayId = await seedGateway(m1, `bkash-${m1}`, 'bKash Counter');
    gateId1 = await seedGate(storeId, m1, gatewayId, 'Original Counter Gate', null);
  });

  it('Test 6 — PATCH updates mfs_number', async () => {
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminApiKey1}`,
      },
      body: JSON.stringify({ mfs_number: '01711111111' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { id: number; mfs_number: string } };
    expect(json.success).toBe(true);
    expect(json.data.mfs_number).toBe('01711111111');

    // Assert D1 state
    const d1Row = await db.prepare(
      `SELECT mfs_number, label, status FROM op_gates WHERE id = ? LIMIT 1`
    ).bind(gateId1).first<{ mfs_number: string; label: string; status: string }>();
    expect(d1Row?.mfs_number).toBe('01711111111');

    // Assert audit log row exists
    const auditRow = await db.prepare(
      `SELECT action, entity_type, entity_id, new_values FROM op_audit_logs WHERE entity_type = 'gate' AND entity_id = ? ORDER BY id DESC LIMIT 1`
    ).bind(String(gateId1)).first<{ action: string; entity_type: string; entity_id: string; new_values: string }>();

    expect(auditRow?.action).toBe('gate.updated');
    expect(auditRow?.new_values).toContain('01711111111');
  });

  it('Test 7 — PATCH updates multiple fields atomically', async () => {
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminApiKey1}`,
      },
      body: JSON.stringify({ label: 'New Label', status: 'paused' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { label: string; status: string } };
    expect(json.success).toBe(true);
    expect(json.data.label).toBe('New Label');
    expect(json.data.status).toBe('paused');

    const d1Row = await db.prepare(
      `SELECT label, status FROM op_gates WHERE id = ? LIMIT 1`
    ).bind(gateId1).first<{ label: string; status: string }>();
    expect(d1Row?.label).toBe('New Label');
    expect(d1Row?.status).toBe('paused');
  });

  it('Test 8 — PATCH rejects with no fields', async () => {
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminApiKey1}`,
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('NO_FIELDS');
  });

  it('Test 9 — PATCH validates mfs_number format', async () => {
    // Invalid: letters
    let res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminApiKey1}` },
      body: JSON.stringify({ mfs_number: 'not-a-phone' }),
    });
    expect(res.status).toBe(400);
    let json = (await res.json()) as { success: boolean; error?: { code: string }; data?: { mfs_number: string | null } };
    expect(json.error?.code).toBe('INVALID_MFS_NUMBER');

    // Invalid: too short (< 6 digits)
    res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminApiKey1}` },
      body: JSON.stringify({ mfs_number: '123' }),
    });
    expect(res.status).toBe(400);
    json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('INVALID_MFS_NUMBER');

    // Valid: international format with +
    res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminApiKey1}` },
      body: JSON.stringify({ mfs_number: '+8801712345678' }),
    });
    expect(res.status).toBe(200);
    json = (await res.json()) as { success: boolean; data?: { mfs_number: string } };
    expect(json.data?.mfs_number).toBe('+8801712345678');

    // Valid: null clears field
    res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminApiKey1}` },
      body: JSON.stringify({ mfs_number: null }),
    });
    expect(res.status).toBe(200);
    json = (await res.json()) as { success: boolean; data?: { mfs_number: string | null } };
    expect(json.data?.mfs_number).toBeNull();
  });

  it('Test 10 — PATCH rejects invalid status', async () => {
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminApiKey1}`,
      },
      body: JSON.stringify({ status: 'unknown' }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('INVALID_STATUS');
  });

  it('Test 11 — PATCH on a gate from a different merchant is 404', async () => {
    const m2 = range.start + 2;
    await seedMerchant(m2, 'Merchant 2');
    const brand2 = await seedBrand(m2, 'Brand 2', 'main');
    const store2 = await seedStore(brand2, m2, 'Store 2', 'main');
    const gw2 = await seedGateway(m2, `bkash-${m2}`, 'bKash M2');
    const foreignGateId = await seedGate(store2, m2, gw2, 'Merchant 2 Gate', '01722222222');

    // Merchant 1 admin key trying to update Merchant 2 gate
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${foreignGateId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminApiKey1}`,
      },
      body: JSON.stringify({ label: 'Attempted Hijack' }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('GATE_NOT_FOUND');

    // Verify Merchant 2 gate unchanged
    const d1Row = await db.prepare(
      `SELECT label FROM op_gates WHERE id = ? LIMIT 1`
    ).bind(foreignGateId).first<{ label: string }>();
    expect(d1Row?.label).toBe('Merchant 2 Gate');
  });

  it('Test 12 — PATCH requires admin scope', async () => {
    const res = await SELF.fetch(`http://localhost/api/admin/v1/gates/${gateId1}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${readOnlyApiKey1}`, // Scope is only ['read']
      },
      body: JSON.stringify({ label: 'Readonly Key Attempt' }),
    });

    // When a Bearer API key lacks 'admin' scope, it fails the Cloudflare Access
    // perimeter bypass in accessAuthMiddleware() and is rejected with 401 ACCESS_DENIED
    // before the route-level requireScope('admin') handler is reached.
    expect(res.status).toBe(401);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('ACCESS_DENIED');
  });
});
