/**
 * Refund Reserve-Then-Call Ordering & Atomicity Tests (V3-003, EDGE-P0-003, NEW-P2-001, V5-007).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import { RefundService, RefundNotSupportedError } from '../src/services/refund';
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

  it('cumulative guard: rejects before reservation if amount exceeds remaining balance', async () => {
    const refundService = new RefundService(tenv);
    let resolveCalled = false;
    const registrySpy = vi.spyOn(gatewayRegistry, 'resolve').mockImplementation((() => {
      resolveCalled = true;
      return {} as never;
    }) as never);

    await expect(
      refundService.createRefund({
        merchant_id: merchantId,
        transaction_id: trxId,
        amount: '150.00', // Exceeds 100.00 captured
        reason: 'too-much',
        initiated_by: null,
      })
    ).rejects.toThrow('Refund amount (150.00) exceeds remaining refundable amount (100.00)');

    expect(resolveCalled).toBe(false);

    // Confirm no ghost pending row exists
    const ghost = await db.prepare(
      `SELECT COUNT(*) AS n FROM op_refunds WHERE transaction_id = ? AND merchant_id = ?`
    ).bind(trxId, merchantId).first<{ n: number }>();
    expect(ghost?.n).toBe(0);

    registrySpy.mockRestore();
  });

  it('failure ordering: reserves row, calls gateway, then transitions row to failed on unsupported refund', async () => {
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

    await expect(
      refundService.createRefund({
        merchant_id: merchantId,
        transaction_id: trxId,
        amount: '10.00',
        reason: 'test-unsupported-failure-branch',
        initiated_by: null,
      })
    ).rejects.toThrow(RefundNotSupportedError);

    expect(resolveCalls).toBe(1);
    expect(refundCalls).toBe(1);

    // Verify row was transitioned to failed
    const row = await db.prepare(
      `SELECT amount, status FROM op_refunds WHERE transaction_id = ? AND reason = ?`
    ).bind(trxId, 'test-unsupported-failure-branch').first<{ amount: string; status: string }>();

    expect(row).toBeDefined();
    expect(row?.status).toBe('failed');

    registrySpy.mockRestore();
  });

  it('happy-path ordering: reserves pending row in DB first, THEN calls gateway resolve & refund with success', async () => {
    let resolveCalls = 0;
    let refundCalls = 0;
    const fakeAdapter = {
      refund: async () => {
        refundCalls++;
        return { success: true, refund_id: 'gw-ref-123' };
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
      amount: '20.00',
      reason: 'valid-partial-refund',
      initiated_by: null,
    });

    expect(resolveCalls).toBe(1);
    expect(refundCalls).toBe(1);
    expect(res.refund_row_id).toBeDefined();
    expect(res.refund_id).toBeDefined();

    // Verify row was reserved with pending status and gateway_refund_id recorded
    const row = await db.prepare(
      `SELECT amount, status, gateway_refund_id FROM op_refunds WHERE id = ?`
    ).bind(res.refund_row_id).first<{ amount: string; status: string; gateway_refund_id: string }>();

    expect(row).toBeDefined();
    expect(row?.status).toBe('pending');
    expect(row?.gateway_refund_id).toBe('gw-ref-123');

    registrySpy.mockRestore();
  });
});
