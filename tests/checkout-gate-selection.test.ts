/**
 * Phase 6c Test Suite: Checkout Store-and-Gate Awareness
 *
 * Verifies:
 *   1. Intent with store_id renders only that store's gates
 *   2. Intent with gate_id renders only that gate
 *   3. Intent with no store_id falls back to merchant default
 *   4. Destination number resolution prefers gate.mfs_number
 *   5. Destination number falls back to manual gateway account_number
 *   6. Destination number falls back to manual gateway payment_number when account_number is null
 *   7. All three number fields null renders "Contact merchant"
 *   8. Brand styling is applied (brand_color and logo_path)
 *   9. POST /checkout/:token/initiate accepts gate_id and resolves gateway_id
 *  10. POST /checkout/:token/initiate rejects a gate from another merchant (404 GATE_NOT_FOUND)
 *  11. POST /checkout/:token/initiate with only gateway_id still works (legacy)
 */

import { describe, it, expect } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const range = TEST_MERCHANT_RANGES.CHECKOUT_GATE_SELECTION;

async function seedMerchant(merchantId: number, name = `Merchant ${merchantId}`) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(merchantId, crypto.randomUUID(), name, `m-${merchantId}`, `m${merchantId}@test.local`, now, now).run();
}

async function seedGateway(merchantId: number, slug: string, name: string): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_gateways (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
     VALUES (?, ?, ?, 'manual', 'active', 1, '["BDT"]', ?, ?)`
  ).bind(merchantId, slug, name, now, now).run();
  return Number(res.meta?.last_row_id);
}

async function seedManualGateway(
  gatewayId: number,
  merchantId: number,
  opts: { accountNumber?: string | null; paymentNumber?: string | null; instructions?: string | null }
) {
  const now = new Date().toISOString();
  await db.prepare(
    `INSERT INTO op_manual_gateways (gateway_id, merchant_id, account_name, account_number, bank_name, payment_number, instructions, created_at)
     VALUES (?, ?, 'Manual MFS', ?, 'bKash', ?, ?, ?)`
  ).bind(gatewayId, merchantId, opts.accountNumber ?? null, opts.paymentNumber ?? null, opts.instructions ?? null, now).run();
}

async function seedBrand(
  merchantId: number,
  opts: { name?: string; slug?: string; brandColor?: string | null; logoPath?: string | null }
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_brands (merchant_id, uuid, name, slug, status, brand_color, logo_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`
  ).bind(merchantId, crypto.randomUUID(), opts.name ?? 'Brand', opts.slug ?? 'brand', opts.brandColor ?? null, opts.logoPath ?? null, now, now).run();
  return Number(res.meta?.last_row_id);
}

async function seedStore(
  brandId: number,
  merchantId: number,
  opts: { name?: string; slug?: string }
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_stores (brand_id, merchant_id, uuid, name, slug, timezone, default_currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Asia/Dhaka', 'BDT', 'active', ?, ?)`
  ).bind(brandId, merchantId, crypto.randomUUID(), opts.name ?? 'Store', opts.slug ?? 'store', now, now).run();
  return Number(res.meta?.last_row_id);
}

async function seedGate(
  storeId: number,
  merchantId: number,
  gatewayId: number,
  opts: { label: string; mfsNumber?: string | null }
): Promise<number> {
  const now = new Date().toISOString();
  const res = await db.prepare(
    `INSERT INTO op_gates (store_id, merchant_id, gateway_id, label, mfs_number, currency, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'BDT', 'active', ?, ?)`
  ).bind(storeId, merchantId, gatewayId, opts.label, opts.mfsNumber ?? null, now, now).run();
  return Number(res.meta?.last_row_id);
}

async function seedPaymentIntent(merchantId: number, opts: {
  storeId?: number | null;
  gateId?: number | null;
  brandId?: number | null;
  gatewayId?: number | null;
  token?: string;
  createTransaction?: boolean;
  txGatewayId?: number;
}): Promise<{ intentId: number; token: string }> {
  const token = opts.token ?? crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const piRes = await db.prepare(
    `INSERT INTO op_payment_intents (merchant_id, uuid, token, amount, currency, description, status, gateway_id, brand_id, store_id, gate_id, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, '1500.00', 'BDT', 'Order #1', 'pending', ?, ?, ?, ?, datetime('now', '+1 hour'), ?, ?)`
  ).bind(merchantId, crypto.randomUUID(), token, opts.gatewayId ?? null, opts.brandId ?? null, opts.storeId ?? null, opts.gateId ?? null, now, now).run();
  const intentId = Number(piRes.meta?.last_row_id);

  if (opts.createTransaction) {
    const trxId = `op_${crypto.randomUUID().slice(0, 12)}`;
    const txGw = opts.txGatewayId ?? opts.gatewayId ?? 1;
    await db.prepare(
      `INSERT INTO op_transactions (merchant_id, trx_id, payment_intent_id, gateway_id, brand_id, store_id, gate_id, amount, currency, fee, net_amount, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '1500.00', 'BDT', '0.00', '1500.00', 'pending', ?, ?)`
    ).bind(merchantId, trxId, intentId, txGw, opts.brandId ?? null, opts.storeId ?? null, opts.gateId ?? null, now, now).run();
  }

  return { intentId, token };
}

describe('Checkout Gate Selection (Phase 6c)', () => {
  it('Test 1 — Intent with store_id renders only that store gates', async () => {
    const m = range.start + 1;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 1', slug: 'brand-1' });
    const storeAId = await seedStore(brandId, m, { name: 'Store A', slug: 'store-a' });
    const storeBId = await seedStore(brandId, m, { name: 'Store B', slug: 'store-b' });

    const gwA = await seedGateway(m, `bkash-a-${m}`, 'bKash Store A');
    await seedManualGateway(gwA, m, { accountNumber: '01710000001' });
    await seedGate(storeAId, m, gwA, { label: 'Store A Counter' });

    const gwB = await seedGateway(m, `bkash-b-${m}`, 'bKash Store B');
    await seedManualGateway(gwB, m, { accountNumber: '01710000002' });
    await seedGate(storeBId, m, gwB, { label: 'Store B Counter' });

    const { token } = await seedPaymentIntent(m, { storeId: storeAId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 1 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('Store A Counter');
    expect(html).not.toContain('Store B Counter');
    expect(gateMatches).toBe(1);
  });

  it('Test 2 — Intent with gate_id renders only that gate', async () => {
    const m = range.start + 2;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 2', slug: 'brand-2' });
    const storeId = await seedStore(brandId, m, { name: 'Store 2', slug: 'store-2' });

    const gw1 = await seedGateway(m, `bkash-1-${m}`, 'bKash Gate One');
    await seedManualGateway(gw1, m, { accountNumber: '01720000001' });
    await seedGate(storeId, m, gw1, { label: 'Gate One' });

    const gw2 = await seedGateway(m, `bkash-2-${m}`, 'bKash Gate Two');
    await seedManualGateway(gw2, m, { accountNumber: '01720000002' });
    const gate2 = await seedGate(storeId, m, gw2, { label: 'Gate Two' });

    const { token } = await seedPaymentIntent(m, { storeId, brandId, gateId: gate2 });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 2 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('Gate Two');
    expect(html).not.toContain('Gate One');
    expect(gateMatches).toBe(1);
  });

  it('Test 3 — Intent with no store_id falls back to merchant default', async () => {
    const m = range.start + 3;
    await seedMerchant(m);
    // Merchant default requires slug = 'main' for both brand and store
    const brandId = await seedBrand(m, { name: 'Main Brand', slug: 'main' });
    const storeId = await seedStore(brandId, m, { name: 'Main Store', slug: 'main' });

    const gw = await seedGateway(m, `bkash-main-${m}`, 'bKash Main');
    await seedManualGateway(gw, m, { accountNumber: '01730000001' });
    await seedGate(storeId, m, gw, { label: 'Main Store Gate' });

    // Legacy intent: no store_id, no gate_id
    const { token } = await seedPaymentIntent(m, { storeId: null, gateId: null });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 3 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('Main Store Gate');
    expect(gateMatches).toBe(1);
  });

  it('Test 4 — Destination number resolution prefers gate.mfs_number', async () => {
    const m = range.start + 4;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 4', slug: 'brand-4' });
    const storeId = await seedStore(brandId, m, { name: 'Store 4', slug: 'store-4' });

    const gw = await seedGateway(m, `bkash-4-${m}`, 'bKash 4');
    await seedManualGateway(gw, m, { accountNumber: '01799999999' });
    await seedGate(storeId, m, gw, { label: 'Gate With MFS Number', mfsNumber: '01711111111' });

    const { token } = await seedPaymentIntent(m, { storeId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 4 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('01711111111');
    expect(html).not.toContain('01799999999');
  });

  it('Test 5 — Destination number falls back to manual gateway account_number', async () => {
    const m = range.start + 5;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 5', slug: 'brand-5' });
    const storeId = await seedStore(brandId, m, { name: 'Store 5', slug: 'store-5' });

    const gw = await seedGateway(m, `bkash-5-${m}`, 'bKash 5');
    await seedManualGateway(gw, m, { accountNumber: '01799999999' });
    await seedGate(storeId, m, gw, { label: 'Gate Fallback Account', mfsNumber: null });

    const { token } = await seedPaymentIntent(m, { storeId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 5 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('01799999999');
  });

  it('Test 6 — Destination number falls back to manual gateway payment_number when account_number is null', async () => {
    const m = range.start + 6;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 6', slug: 'brand-6' });
    const storeId = await seedStore(brandId, m, { name: 'Store 6', slug: 'store-6' });

    const gw = await seedGateway(m, `bkash-6-${m}`, 'bKash 6');
    await seedManualGateway(gw, m, { accountNumber: null, paymentNumber: '01788888888' });
    await seedGate(storeId, m, gw, { label: 'Gate Fallback Payment Number', mfsNumber: null });

    const { token } = await seedPaymentIntent(m, { storeId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 6 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('01788888888');
  });

  it('Test 7 — All three number fields null renders "Contact merchant"', async () => {
    const m = range.start + 7;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 7', slug: 'brand-7' });
    const storeId = await seedStore(brandId, m, { name: 'Store 7', slug: 'store-7' });

    const gw = await seedGateway(m, `bkash-7-${m}`, 'bKash 7');
    await seedManualGateway(gw, m, { accountNumber: null, paymentNumber: null });
    await seedGate(storeId, m, gw, { label: 'Gate With No Numbers', mfsNumber: null });

    const { token } = await seedPaymentIntent(m, { storeId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 7 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('Contact merchant');
  });

  it('Test 8 — Brand styling is applied', async () => {
    const m = range.start + 8;
    await seedMerchant(m);
    const brandId = await seedBrand(m, {
      name: 'Styled Brand',
      slug: 'styled-brand',
      brandColor: '#ff00aa',
      logoPath: '/assets/logo-test.png',
    });
    const storeId = await seedStore(brandId, m, { name: 'Styled Store', slug: 'styled-store' });

    const gw = await seedGateway(m, `bkash-8-${m}`, 'bKash 8');
    await seedManualGateway(gw, m, { accountNumber: '01780000001' });
    await seedGate(storeId, m, gw, { label: 'Styled Gate' });

    const { token } = await seedPaymentIntent(m, { storeId, brandId });

    const res = await SELF.fetch(`http://localhost/checkout/${token}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const gateMatches = (html.match(/class="gateway-option/g) || []).length;
    console.log(`Test 8 rendered ${gateMatches} gate(s)`);

    expect(html).toContain('#ff00aa');
    expect(html).toContain('/assets/logo-test.png');
  });

  it('Test 9 — POST /:token/initiate accepts gate_id', async () => {
    const m = range.start + 9;
    await seedMerchant(m);
    const brandId = await seedBrand(m, { name: 'Brand 9', slug: 'brand-9' });
    const storeId = await seedStore(brandId, m, { name: 'Store 9', slug: 'store-9' });

    const gw = await seedGateway(m, `bkash-9-${m}`, 'bKash 9');
    await seedManualGateway(gw, m, { accountNumber: '01790000001' });
    const gateId = await seedGate(storeId, m, gw, { label: 'Initiate Gate' });

    const { intentId, token } = await seedPaymentIntent(m, {
      storeId,
      brandId,
      txGatewayId: gw,
      createTransaction: true,
    });

    const csrfToken = 'test_csrf_token_checkout_gate_sel';
    const res = await SELF.fetch(`http://localhost/checkout/${token}/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Cookie': `edgepay_csrf=${csrfToken}`,
      },
      body: JSON.stringify({ gate_id: gateId }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const updated = await db.prepare(
      `SELECT gateway_id, status FROM op_payment_intents WHERE id = ? LIMIT 1`
    ).bind(intentId).first<{ gateway_id: number; status: string }>();

    expect(updated?.gateway_id).toBe(gw);
    expect(updated?.status).toBe('processing');
    console.log('Test 9 initiate successfully bound gateway_id:', gw);
  });

  it('Test 10 — POST /:token/initiate rejects a gate from another merchant', async () => {
    const mA = range.start + 10;
    const mB = range.start + 11;
    await seedMerchant(mA, 'Merchant A');
    await seedMerchant(mB, 'Merchant B');

    // Merchant A store & gate
    const brandA = await seedBrand(mA, { name: 'Brand A', slug: 'brand-a' });
    const storeA = await seedStore(brandA, mA, { name: 'Store A', slug: 'store-a' });
    const gwA = await seedGateway(mA, `gw-a-${mA}`, 'Gateway A');
    await seedManualGateway(gwA, mA, { accountNumber: '01710000010' });
    await seedGate(storeA, mA, gwA, { label: 'Gate A' });

    // Merchant B store & gate
    const brandB = await seedBrand(mB, { name: 'Brand B', slug: 'brand-b' });
    const storeB = await seedStore(brandB, mB, { name: 'Store B', slug: 'store-b' });
    const gwB = await seedGateway(mB, `gw-b-${mB}`, 'Gateway B');
    await seedManualGateway(gwB, mB, { accountNumber: '01710000011' });
    const gateB = await seedGate(storeB, mB, gwB, { label: 'Gate B' });

    // Intent for Merchant A
    const { token } = await seedPaymentIntent(mA, {
      storeId: storeA,
      brandId: brandA,
      txGatewayId: gwA,
      createTransaction: true,
    });

    // POST with gate_id from Merchant B
    const csrfToken = 'test_csrf_token_checkout_gate_sel';
    const res = await SELF.fetch(`http://localhost/checkout/${token}/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Cookie': `edgepay_csrf=${csrfToken}`,
      },
      body: JSON.stringify({ gate_id: gateB }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error?: { code: string } };
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('GATE_NOT_FOUND');
    console.log('Test 10 correctly rejected foreign gate with 404 GATE_NOT_FOUND');
  });

  it('Test 11 — POST /:token/initiate with only gateway_id still works (legacy)', async () => {
    const m = range.start + 12;
    await seedMerchant(m);
    const gw = await seedGateway(m, `legacy-gw-${m}`, 'Legacy Gateway');
    await seedManualGateway(gw, m, { accountNumber: '01712000001' });

    const { token, intentId } = await seedPaymentIntent(m, {
      txGatewayId: gw,
      createTransaction: true,
    });

    const csrfToken = 'test_csrf_token_checkout_gate_sel';
    const res = await SELF.fetch(`http://localhost/checkout/${token}/initiate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Cookie': `edgepay_csrf=${csrfToken}`,
      },
      body: JSON.stringify({ gateway_id: gw }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);

    const updated = await db.prepare(
      `SELECT gateway_id, status FROM op_payment_intents WHERE id = ? LIMIT 1`
    ).bind(intentId).first<{ gateway_id: number; status: string }>();

    expect(updated?.gateway_id).toBe(gw);
    expect(updated?.status).toBe('processing');
    console.log('Test 11 legacy initiate succeeded with gateway_id:', gw);
  });
});
