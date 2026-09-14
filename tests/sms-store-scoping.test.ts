/**
 * Phase 6b Test Suite: SMS Store Scoping & Isolation
 *
 * Verifies:
 *   1. Store isolation — SMS from Store A device matches Store A transaction,
 *      DOES NOT match Store B transaction with identical amount.
 *   2. Store match — SMS from Store B device matches Store B transaction.
 *   3. Legacy SMS backward compatibility — SMS without store_id matches ANY open
 *      transaction for that merchant.
 *   4. Legacy transaction backward compatibility — Transaction with store_id IS NULL
 *      matches incoming SMS from any store of that merchant.
 *   5. Metric emission — sms_store_scope_applied emitted with value=1 when store_id
 *      is present, value=0 when absent.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database, SmsMessage } from '../src/types/env';
import { SmsQueueConsumer } from '../src/queues/sms-consumer';
import { HierarchyService } from '../src/services/hierarchy';
import { LedgerService } from '../src/services/ledger';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const M = TEST_MERCHANT_RANGES.SMS_STORE_SCOPING.start; // 840001

let brandId: number;
let storeAId: number;
let storeBId: number;
let gatewayId: number;
let gateAId: number;
let gateBId: number;

async function createOpenOrder(opts: {
  amount: string;
  storeId: number | null;
  gateId?: number | null;
  brandId?: number | null;
  customerTrxId: string;
  currency?: string;
}): Promise<{ intentId: number; txId: number }> {
  const currency = opts.currency ?? 'BDT';
  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, '');
  const uuid = crypto.randomUUID();
  const meta = JSON.stringify({ customer_trx_id: opts.customerTrxId });

  const piRes = await db.prepare(
    `INSERT INTO op_payment_intents
       (merchant_id, uuid, token, amount, currency, description,
        customer_id, gateway_id, brand_id, store_id, gate_id,
        status, metadata, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'SMS test intent', NULL, ?, ?, ?, ?, 'pending', ?, datetime('now', '+1 hour'), ?, ?)`
  ).bind(
    M,
    uuid,
    token,
    opts.amount,
    currency,
    gatewayId,
    opts.brandId ?? (opts.storeId ? brandId : null),
    opts.storeId,
    opts.gateId ?? null,
    meta,
    now,
    now,
  ).run();
  const intentId = Number(piRes.meta?.last_row_id);

  const trxId = `op_${crypto.randomUUID().slice(0, 12)}`;
  const txRes = await db.prepare(
    `INSERT INTO op_transactions
       (merchant_id, trx_id, payment_intent_id, gateway_id,
        brand_id, store_id, gate_id,
        amount, currency, fee, net_amount, status, gateway_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0.00', ?, 'pending', 'pending', ?, ?)`
  ).bind(
    M,
    trxId,
    intentId,
    gatewayId,
    opts.brandId ?? (opts.storeId ? brandId : null),
    opts.storeId,
    opts.gateId ?? null,
    opts.amount,
    currency,
    opts.amount,
    now,
    now,
  ).run();
  const txId = Number(txRes.meta?.last_row_id);

  return { intentId, txId };
}

async function processSms(sms: Partial<SmsMessage>): Promise<void> {
  const consumer = new SmsQueueConsumer();
  const messageBody: SmsMessage = {
    merchant_id: M,
    device_id: 1,
    store_id: sms.store_id,
    sender: sms.sender ?? '16247',
    body: sms.body ?? '',
    received_at: sms.received_at ?? new Date().toISOString(),
    signature_verified: true,
    raw_sender: sms.raw_sender ?? sms.sender ?? '16247',
  };

  const fakeMessage: Message<SmsMessage> = {
    id: `msg-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    body: messageBody,
    attempts: 1,
    ack: () => {},
    retry: () => {},
  };

  const ctx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  await consumer.process({ messages: [fakeMessage] }, tenv, ctx);
}

describe('SMS Store Scoping & Isolation (Phase 6b)', () => {
  beforeAll(async () => {
    // 1. Seed merchant
    await db.prepare(
      `INSERT OR IGNORE INTO op_merchants (id, uuid, name, slug, email, default_currency, status, created_at, updated_at)
       VALUES (?, ?, 'SMS Scoping Merchant', 'sms-scoping', 'scoping@test.local', 'BDT', 'active', datetime('now'), datetime('now'))`
    ).bind(M, `merchant-uuid-${M}`).run();

    const ledger = new LedgerService(tenv);
    await ledger.createDefaultChartOfAccounts(M, 'BDT');

    // 2. Seed gateway
    await db.prepare(
      `INSERT OR IGNORE INTO op_gateways (id, merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
       VALUES (?, ?, 'bkash-api', 'bKash API', 'api', 'active', 1, '["BDT"]', datetime('now'), datetime('now'))`
    ).bind(840010, M).run();
    const gw = await db.prepare(
      `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = 'bkash-api' LIMIT 1`
    ).bind(M).first<{ id: number }>();
    gatewayId = gw!.id;

    // 3. Setup Hierarchy: Brand, Store A, Store B, Gate A, Gate B
    const hierarchy = new HierarchyService(db);
    const brand = await hierarchy.createBrand({
      merchant_id: M,
      name: 'Scoping Brand',
      slug: `scoping-brand-${Date.now()}`,
    });
    brandId = brand.id;

    const storeA = await hierarchy.createStore({
      merchant_id: M,
      brand_id: brandId,
      name: 'Dhaka Branch',
      slug: `store-a-${Date.now()}`,
      default_currency: 'BDT',
    });
    storeAId = storeA.id;

    const storeB = await hierarchy.createStore({
      merchant_id: M,
      brand_id: brandId,
      name: 'Chittagong Branch',
      slug: `store-b-${Date.now()}`,
      default_currency: 'BDT',
    });
    storeBId = storeB.id;

    const gateA = await hierarchy.createGate({
      merchant_id: M,
      store_id: storeAId,
      gateway_id: gatewayId,
      label: 'bKash Merchant Store A',
      currency: 'BDT',
      mfs_number: '01700000001',
    });
    gateAId = gateA.id;

    const gateB = await hierarchy.createGate({
      merchant_id: M,
      store_id: storeBId,
      gateway_id: gatewayId,
      label: 'bKash Merchant Store B',
      currency: 'BDT',
      mfs_number: '01700000002',
    });
    gateBId = gateB.id;
  });

  it('1. Store isolation — SMS from Store A matches Store A transaction, DOES NOT match Store B transaction with identical amount', async () => {
    const amount = '500.00';
    const trxId = 'BKISO001';

    // Seed two transactions with identical amount and TrxID, one in Store A, one in Store B
    const orderA = await createOpenOrder({ amount, storeId: storeAId, gateId: gateAId, customerTrxId: trxId });
    const orderB = await createOpenOrder({ amount, storeId: storeBId, gateId: gateBId, customerTrxId: trxId });

    // Incoming SMS from Store A device
    await processSms({
      store_id: storeAId,
      body: `You have received Tk ${amount} from 01711000000. TrxID ${trxId}`,
    });

    // Check transaction statuses
    const txA = await db.prepare(`SELECT status FROM op_transactions WHERE id = ?`).bind(orderA.txId).first<{ status: string }>();
    const txB = await db.prepare(`SELECT status FROM op_transactions WHERE id = ?`).bind(orderB.txId).first<{ status: string }>();

    expect(txA?.status).toBe('completed');
    expect(txB?.status).toBe('pending');
  });

  it('2. Store match — SMS from Store B device matches Store B transaction', async () => {
    const amount = '600.00';
    const trxId = 'BKISO002';

    const orderB = await createOpenOrder({ amount, storeId: storeBId, gateId: gateBId, customerTrxId: trxId });

    await processSms({
      store_id: storeBId,
      body: `You have received Tk ${amount} from 01711000000. TrxID ${trxId}`,
    });

    const txB = await db.prepare(`SELECT status FROM op_transactions WHERE id = ?`).bind(orderB.txId).first<{ status: string }>();
    expect(txB?.status).toBe('completed');
  });

  it('3. Legacy SMS backward compatibility — SMS without store_id matches ANY open transaction for that merchant', async () => {
    const amount = '750.00';
    const trxId = 'BKLEGACY01';

    // Transaction is attached to Store A
    const orderA = await createOpenOrder({ amount, storeId: storeAId, gateId: gateAId, customerTrxId: trxId });

    // SMS has store_id undefined / null (legacy queue message)
    await processSms({
      store_id: null,
      body: `You have received Tk ${amount} from 01711000000. TrxID ${trxId}`,
    });

    const txA = await db.prepare(`SELECT status FROM op_transactions WHERE id = ?`).bind(orderA.txId).first<{ status: string }>();
    expect(txA?.status).toBe('completed');
  });

  it('4. Legacy transaction backward compatibility — Transaction with store_id IS NULL matches incoming SMS from any store', async () => {
    const amount = '850.00';
    const trxId = 'BKLEGACY02';

    // Transaction was created before hierarchy migration (store_id IS NULL)
    const orderLegacy = await createOpenOrder({ amount, storeId: null, gateId: null, brandId: null, customerTrxId: trxId });

    // SMS arrives with store_id populated from a modern device (Store B)
    await processSms({
      store_id: storeBId,
      body: `You have received Tk ${amount} from 01711000000. TrxID ${trxId}`,
    });

    const tx = await db.prepare(`SELECT status FROM op_transactions WHERE id = ?`).bind(orderLegacy.txId).first<{ status: string }>();
    expect(tx?.status).toBe('completed');
  });

  it('5. Metric emission — sms_store_scope_applied emitted with value=1 when store_id present, value=0 when absent', async () => {
    const spy = vi.spyOn(
      tenv.ANALYTICS as unknown as { writeDataPoint: (...args: unknown[]) => void },
      'writeDataPoint',
    );

    try {
      const amount1 = '910.00';
      const trx1 = 'BKMETRIC01';
      await createOpenOrder({ amount: amount1, storeId: storeAId, gateId: gateAId, customerTrxId: trx1 });

      await processSms({
        store_id: storeAId,
        body: `You have received Tk ${amount1} from 01711000000. TrxID ${trx1}`,
      });

      const scopeCallWithStore = spy.mock.calls.find((call) => {
        const arg = call[0] as { blobs?: string[]; doubles?: number[] };
        return arg?.blobs?.[0] === 'sms_store_scope_applied';
      });
      expect(scopeCallWithStore).toBeDefined();
      const argWithStore = scopeCallWithStore?.[0] as { blobs?: string[]; doubles?: number[] } | undefined;
      expect(argWithStore?.doubles?.[0]).toBe(1);

      spy.mockClear();

      const amount2 = '920.00';
      const trx2 = 'BKMETRIC02';
      await createOpenOrder({ amount: amount2, storeId: storeAId, gateId: gateAId, customerTrxId: trx2 });

      await processSms({
        store_id: null,
        body: `You have received Tk ${amount2} from 01711000000. TrxID ${trx2}`,
      });

      const scopeCallWithoutStore = spy.mock.calls.find((call) => {
        const arg = call[0] as { blobs?: string[]; doubles?: number[] };
        return arg?.blobs?.[0] === 'sms_store_scope_applied';
      });
      expect(scopeCallWithoutStore).toBeDefined();
      const argWithoutStore = scopeCallWithoutStore?.[0] as { blobs?: string[]; doubles?: number[] } | undefined;
      expect(argWithoutStore?.doubles?.[0]).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
