/**
 * Refund Reserve-Then-Call Ordering & Atomicity Tests (V3-003, EDGE-P0-003, NEW-P2-001, V5-007).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { RefundService } from '../src/services/refund';
import { PaymentService } from '../src/services/payment';
import { LedgerService } from '../src/services/ledger';
import { gatewayRegistry } from '../src/gateways/base';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;

describe('Refund Reserve-Then-Call Ordering (V3-003 / V5-007)', () => {
  const merchantId = 940001;
  let trxId: number;

  beforeAll(async () => {
    // 1. Create merchant
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'RefundOrderTest', 'refund-order', 'refund@example.com', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    // 2. Initialize chart of accounts for ledger
    const ledger = new LedgerService(tenv);
    await ledger.createDefaultChartOfAccounts(merchantId, 'BDT');

    // 3. Create gateway & transaction of 100.00
    const paymentService = new PaymentService(tenv);
    const intent = await paymentService.createIntent({
      merchant_id: merchantId,
      amount: '100.00',
      currency: 'BDT',
      gateway: 'bkash',
    });

    const txRow = await db.prepare(
      `SELECT id FROM op_transactions WHERE payment_intent_id = ?`
    ).bind(intent.intent_id).first<{ id: number }>();
    trxId = txRow!.id;

    await paymentService.completeTransaction(trxId, intent.intent_id, 'gw-orig-12345');
  });

  it('over-bound refund: fails at DB layer, gateway NEVER resolved/called, NO ghost pending row', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => {
        refundCalls++;
        return { success: false, error: 'overbound-test' };
      },
    };

    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);

    const refundService = new RefundService(tenv);

    // Try to refund 150.00 on a 100.00 transaction
    await expect(
      refundService.createRefund({
        merchant_id: merchantId,
        transaction_id: trxId,
        amount: '150.00',
        reason: 'exceeds-bound',
        initiated_by: null,
      })
    ).rejects.toThrow();

    // Bound check must throw BEFORE registry resolution
    expect(resolveCalls).toBe(0);
    expect(refundCalls).toBe(0);

    // Confirm no ghost pending row exists
    const ghost = await db.prepare(
      `SELECT COUNT(*) AS n FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?`
    ).bind(trxId, merchantId).first<{ n: number }>();
    expect(ghost?.n).toBe(0);

    registrySpy.mockRestore();
  });

  it('valid refund: reserves pending row in DB first, THEN calls gateway resolve & refund', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => {
        refundCalls++;
        return { success: false, error: 'valid-test-adapter' };
      },
    };

    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalls++;
      return fakeAdapter as never;
    }) as never);

    const refundService = new RefundService(tenv);

    const res = await refundService.createRefund({
      merchant_id: merchantId,
      transaction_id: trxId,
      amount: '30.00',
      reason: 'valid-partial-refund',
      initiated_by: null,
    });

    expect(resolveCalls).toBe(1);
    expect(refundCalls).toBe(1);
    expect(res.refund_row_id).toBeDefined();
    expect(res.refund_id).toBeDefined();

    // Verify row was reserved with pending status
    const row = await db.prepare(
      `SELECT amount, status FROM op_refunds WHERE id = ?`
    ).bind(res.refund_row_id).first<{ amount: string; status: string }>();

    expect(row).toBeDefined();
    expect(row?.status).toBe('pending');

    registrySpy.mockRestore();
  });
});
