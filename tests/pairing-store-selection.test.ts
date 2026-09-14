/**
 * Phase 6d Test Suite: Pairing Store Selection
 *
 * Verifies:
 *   1. Pair without store_id defaults to Main store.
 *   2. Pair with explicit store_id uses that store.
 *   3. Pair with a store_id belonging to a different merchant is rejected (404 STORE_NOT_FOUND).
 *   4. Pair with invalid store_id shape is rejected (400 INVALID_STORE_ID).
 *   5. Missing Main store produces clear error (400 NO_DEFAULT_STORE).
 */

import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { TEST_MERCHANT_RANGES } from './test-ids';
import { sha256 } from '../src/lib/crypto';
import { HierarchyService } from '../src/services/hierarchy';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.PAIRING_STORE_SELECTION;

async function seedMerchant(merchantId: number, name = `Merchant ${merchantId}`) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(merchantId, crypto.randomUUID(), name, `m-${merchantId}`, `m${merchantId}@test.local`, now, now).run();
}

async function seedUser(merchantId: number, userId: number): Promise<number> {
  const now = new Date().toISOString();
  const emailHash = await sha256(`user-${userId}@test.local`);
  await db.prepare(
    `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Test User', ?, ?, 'hash', 'active', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(userId, merchantId, crypto.randomUUID(), `user-${userId}@test.local`, emailHash, now, now).run();
  return userId;
}

async function seedBrand(merchantId: number, opts: { name: string; slug: string }): Promise<number> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(merchantId, crypto.randomUUID(), opts.name, opts.slug, now, now).run();
  const row = await db.prepare(
    `SELECT id FROM op_brands WHERE merchant_id = ? AND slug = ? LIMIT 1`
  ).bind(merchantId, opts.slug).first<{ id: number }>();
  return row!.id;
}

async function seedStore(brandId: number, merchantId: number, opts: { name: string; slug: string }): Promise<number> {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, timezone, default_currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'active', ?, ?)
     ON CONFLICT DO NOTHING`
  ).bind(brandId, merchantId, crypto.randomUUID(), opts.name, opts.slug, now, now).run();
  const row = await db.prepare(
    `SELECT id FROM op_stores WHERE merchant_id = ? AND slug = ? LIMIT 1`
  ).bind(merchantId, opts.slug).first<{ id: number }>();
  return row!.id;
}

async function seedPairingOtp(merchantId: number, userId: number, otp: string) {
  const now = new Date().toISOString();
  const otpHash = await sha256(otp);
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  await db.prepare(
    `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(merchantId, userId, `tok_${otp}`, otpHash, expiresAt, now).run();
}

describe('Pairing Store Selection (Phase 6d)', () => {
  it('Test 1 — Pair without store_id defaults to Main store', async () => {
    const m = range.start + 1;
    const userId = m * 10 + 1;
    await seedMerchant(m);
    await seedUser(m, userId);
    const brandId = await seedBrand(m, { name: 'Main Brand', slug: 'main' });
    const mainStoreId = await seedStore(brandId, m, { name: 'Main Store', slug: 'main' });

    const otp = '821001';
    await seedPairingOtp(m, userId, otp);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.81' },
      body: JSON.stringify({
        otp,
        device_name: 'Counter Phone 1',
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { device_id: string } };
    expect(json.success).toBe(true);

    const device = await db.prepare(
      `SELECT store_id, merchant_id FROM op_paired_devices WHERE uuid = ? LIMIT 1`
    ).bind(json.data.device_id).first<{ store_id: number; merchant_id: number }>();

    expect(device?.merchant_id).toBe(m);
    expect(device?.store_id).toBe(mainStoreId);
  });

  it('Test 2 — Pair with explicit store_id uses that store', async () => {
    const m = range.start + 2;
    const userId = m * 10 + 1;
    await seedMerchant(m);
    await seedUser(m, userId);
    const brandId = await seedBrand(m, { name: 'Main Brand', slug: 'main' });
    await seedStore(brandId, m, { name: 'Main Store', slug: 'main' });
    const storeBId = await seedStore(brandId, m, { name: 'Branch Store B', slug: 'branch-b' });

    const otp = '821002';
    await seedPairingOtp(m, userId, otp);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.82' },
      body: JSON.stringify({
        otp,
        device_name: 'Branch Phone B',
        store_id: storeBId,
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { device_id: string } };
    expect(json.success).toBe(true);

    const device = await db.prepare(
      `SELECT store_id, merchant_id FROM op_paired_devices WHERE uuid = ? LIMIT 1`
    ).bind(json.data.device_id).first<{ store_id: number; merchant_id: number }>();

    expect(device?.merchant_id).toBe(m);
    expect(device?.store_id).toBe(storeBId);
  });

  it('Test 3 — Pair with a store_id belonging to a different merchant is rejected', async () => {
    const mA = range.start + 3;
    const mB = range.start + 4;
    const userA = mA * 10 + 1;
    const userB = mB * 10 + 1;

    await seedMerchant(mA, 'Merchant A');
    await seedUser(mA, userA);
    const brandA = await seedBrand(mA, { name: 'Brand A', slug: 'main' });
    await seedStore(brandA, mA, { name: 'Store A', slug: 'main' });

    await seedMerchant(mB, 'Merchant B');
    await seedUser(mB, userB);
    const brandB = await seedBrand(mB, { name: 'Brand B', slug: 'main' });
    const storeB = await seedStore(brandB, mB, { name: 'Store B', slug: 'main' });

    const otp = '821003';
    await seedPairingOtp(mA, userA, otp);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.83' },
      body: JSON.stringify({
        otp,
        device_name: 'Attempt Rogue Store Pair',
        store_id: storeB, // Belongs to Merchant B!
      }),
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('STORE_NOT_FOUND');

    const devices = await db.prepare(
      `SELECT COUNT(*) as cnt FROM op_paired_devices WHERE device_name = 'Attempt Rogue Store Pair'`
    ).first<{ cnt: number }>();
    expect(devices?.cnt).toBe(0);
  });

  it('Test 4 — Pair with invalid store_id shape is rejected', async () => {
    const m = range.start + 5;
    const userId = m * 10 + 1;
    await seedMerchant(m);
    await seedUser(m, userId);
    const brandId = await seedBrand(m, { name: 'Brand', slug: 'main' });
    await seedStore(brandId, m, { name: 'Store', slug: 'main' });

    // Negative store_id
    let otp = '821041';
    await seedPairingOtp(m, userId, otp);
    let res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.84' },
      body: JSON.stringify({ otp, store_id: -1 }),
    });
    expect(res.status).toBe(400);
    let json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('INVALID_STORE_ID');

    // Float store_id
    otp = '821042';
    await seedPairingOtp(m, userId, otp);
    res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.85' },
      body: JSON.stringify({ otp, store_id: 1.5 }),
    });
    expect(res.status).toBe(400);
    json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('INVALID_STORE_ID');

    // String store_id
    otp = '821043';
    await seedPairingOtp(m, userId, otp);
    res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.86' },
      body: JSON.stringify({ otp, store_id: 'abc' }),
    });
    expect(res.status).toBe(400);
    json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.error?.code).toBe('INVALID_STORE_ID');
  });

  it('Test 5 — Missing Main store produces clear error', async () => {
    const m = range.start + 6;
    const userId = m * 10 + 1;
    // Insert merchant directly and explicitly purge any brand or store (simulating interrupted onboarding)
    await seedMerchant(m);
    await seedUser(m, userId);
    await db.prepare(`DELETE FROM op_stores WHERE merchant_id = ?`).bind(m).run();
    await db.prepare(`DELETE FROM op_brands WHERE merchant_id = ?`).bind(m).run();

    const otp = '821005';
    await seedPairingOtp(m, userId, otp);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.87' },
      body: JSON.stringify({
        otp,
        device_name: 'No Default Store Device',
      }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(json.success).toBe(false);
    expect(json.error?.code).toBe('NO_DEFAULT_STORE');
  });

  it('Test 6 — Merchant with provisionDefaultHierarchy automatically pairs without store_id', async () => {
    const m = range.start + 7;
    const userId = m * 10 + 1;
    await seedMerchant(m);
    await seedUser(m, userId);

    // Call provisionDefaultHierarchy to simulate Core onboarding invariant
    const hierarchy = new HierarchyService(db);
    const { brandId, storeId } = await hierarchy.provisionDefaultHierarchy(m, 'BDT');
    expect(brandId).toBeGreaterThan(0);
    expect(storeId).toBeGreaterThan(0);

    const otp = '821006';
    await seedPairingOtp(m, userId, otp);

    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.88' },
      body: JSON.stringify({
        otp,
        device_name: 'Auto-Provisioned Device',
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { success: boolean; data: { device_id: string } };
    expect(json.success).toBe(true);

    const device = await db.prepare(
      `SELECT store_id FROM op_paired_devices WHERE uuid = ? LIMIT 1`
    ).bind(json.data.device_id).first<{ store_id: number }>();
    expect(device?.store_id).toBe(storeId);
  });
});
