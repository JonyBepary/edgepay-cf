/**
 * Payment service — core payment orchestration logic.
 *
 * EdgePay's PHP original splits this across:
 *   - PaymentIntentRepository (CRUD)
 *   - PaymentController (HTTP entry)
 *   - WebhookInboundProcessor (callback verification)
 *
 * In the CF Workers rebuild we consolidate into one PaymentService
 * since the orchestration is small and we want fewer D1 round-trips.
 *
 * Lifecycle:
 *   1. createIntent() — creates payment_intent + transaction (status=pending)
 *   2. initiate() — resolves gateway adapter, calls adapter.initiate()
 *   3. handleCallback() — gateway redirects customer back, calls adapter.verify()
 *   4. handleWebhook() — gateway POSTs to /webhook/{slug}, calls adapter.verifyWebhook()
 *   5. complete() — marks transaction completed, posts ledger entry, fires webhook
 */

import type { Env } from '../types/env';
import type { Money } from '../lib/money';
import { isZero } from '../lib/money';
import { randomUuid, randomToken } from '../lib/crypto';
import { decrypt } from '../lib/crypto';
import { gatewayRegistry } from '../gateways';
import { assertGatewayEnabled } from '../gateways/enabled';
import { postPaymentLedgerEntry } from './ledger';
import { WebhookDispatcher } from './webhook-dispatcher';
import { HttpError, NotFoundError, ValidationError } from '../lib/error';

export interface CreateIntentInput {
  merchant_id: number;
  amount: Money;
  currency: string;
  description?: string;
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  gateway_id?: number;
  gateway?: string;
  gateway_slug?: string;
  metadata?: Record<string, unknown>;
  expires_in_seconds?: number;       // default 15min
}

export interface CreateIntentResult {
  intent_id: number;
  token: string;
  checkout_url: string;
}

export class PaymentService {
  constructor(private readonly env: Env) {}

  /**
   * Create a payment intent. This is the first step in the payment flow.
   * The intent is given a token (random 32-byte hex) that the customer
   * will use to access the checkout page at /checkout/{token}.
   */
  async createIntent(input: CreateIntentInput): Promise<CreateIntentResult> {
    // Validate amount > 0
    if (isZero(input.amount)) {
      throw new ValidationError('Amount must be greater than zero');
    }

    const now = new Date().toISOString();
    const token = randomToken(32); // 64 hex chars
    const uuid = randomUuid();
    const expiresAt = new Date(
      Date.now() + (input.expires_in_seconds ?? 900) * 1000,
    ).toISOString();

    // Resolve gateway_id (supports numeric ID, string slug, or falls back to merchant's default gateway)
    let gatewayId = input.gateway_id;
    if (!gatewayId && (input.gateway || input.gateway_slug)) {
      const slug = input.gateway || input.gateway_slug;
      const gwRow = await this.env.DB.prepare(
        `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = ? LIMIT 1`
      ).bind(input.merchant_id, slug).first<{ id: number }>();
      if (gwRow) {
        gatewayId = gwRow.id;
      }
    }

    if (!gatewayId) {
      const defaultGw = await this.env.DB.prepare(
        `SELECT id FROM op_gateways WHERE merchant_id = ? LIMIT 1`
      ).bind(input.merchant_id).first<{ id: number }>();

      if (defaultGw) {
        gatewayId = defaultGw.id;
      } else {
        const gwRes = await this.env.DB.prepare(
          `INSERT INTO op_gateways (merchant_id, slug, name, type, status, priority, supported_currencies, created_at, updated_at)
           VALUES (?, 'manual', 'Manual Payment', 'manual', 'active', 0, '["BDT","USD"]', ?, ?)`
        ).bind(input.merchant_id, now, now).run();
        
        const seeded = await this.env.DB.prepare(
          `SELECT id FROM op_gateways WHERE merchant_id = ? AND slug = 'manual' LIMIT 1`
        ).bind(input.merchant_id).first<{ id: number }>();
        gatewayId = seeded?.id ?? Number(gwRes.meta?.last_row_id ?? 1);
      }
    }

    // Create the payment intent record
    const result = await this.env.DB.prepare(
      `INSERT INTO op_payment_intents
         (uuid, merchant_id, token, amount, currency, description,
          customer_id, gateway_id, status, metadata, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?)`
    ).bind(
      uuid,
      input.merchant_id,
      token,
      input.amount,
      input.currency.toUpperCase(),
      input.description ?? null,
      gatewayId,
      input.metadata ? JSON.stringify(input.metadata) : null,
      expiresAt,
      now,
      now,
    ).run();

    let intentId = result.meta?.last_row_id;
    if (!intentId) {
      const row = await this.env.DB.prepare(
        `SELECT id FROM op_payment_intents WHERE uuid = ? LIMIT 1`
      ).bind(uuid).first<{ id: number }>();
      intentId = row?.id;
    }
    if (!intentId) {
      throw new HttpError(500, 'Failed to create payment intent', 'INTENT_CREATE_FAILED');
    }

    // Create the initial transaction record
    const trxId = `op_${randomToken(12)}`;
    await this.env.DB.prepare(
      `INSERT INTO op_transactions
         (merchant_id, trx_id, payment_intent_id, gateway_id,
          amount, currency, fee, net_amount, status, gateway_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '0.00', ?, 'pending', 'pending', ?, ?)`
    ).bind(
      input.merchant_id,
      trxId,
      intentId,
      gatewayId,
      input.amount,
      input.currency.toUpperCase(),
      input.amount,  // net_amount = amount until fee applied at completion
      now,
      now,
    ).run();

    return {
      intent_id: intentId,
      token,
      checkout_url: `/checkout/${token}`,
    };
  }

  /**
   * Initiate payment with a specific gateway. Resolves the adapter, decrypts
   * credentials, and calls adapter.initiate().
   */
  async initiatePayment(intentId: number, gatewayId: number): Promise<{
    redirect_url?: string;
    form_html?: string;
    session_id?: string;
  }> {
    const intent = await this.env.DB.prepare(

      `SELECT pi.*, t.trx_id
       FROM op_payment_intents pi
       JOIN op_transactions t ON t.payment_intent_id = pi.id
       WHERE pi.id = ?
       LIMIT 1`
).bind(intentId).first<{
      id: number;
      merchant_id: number;
      amount: Money;
      currency: string;
      token: string;
      trx_id: string;
    }>();

    if (!intent) throw new NotFoundError('Payment intent');

    // Resolve gateway
    const gateway = await this.env.DB.prepare(
      `SELECT id, slug, name, type FROM op_gateways WHERE id = ? AND merchant_id = ? AND status = 'active' LIMIT 1`
    ).bind(gatewayId, intent.merchant_id).first<{ id: number; slug: string; name: string; type: string }>();

    if (!gateway) throw new NotFoundError('Gateway');

    if (gateway.type !== 'manual') {
      assertGatewayEnabled(this.env, gateway.slug);
    }

    // Load + decrypt credentials
    const credRows = await this.env.DB.prepare(

      `SELECT field_name, field_value FROM op_gateway_configs
       WHERE gateway_id = ? AND merchant_id = ?`
).bind(gatewayId, intent.merchant_id).all<{ field_name: string; field_value: string }>();

    const credentials: Record<string, string> = {};
    for (const row of credRows.results) {
      try {
        credentials[row.field_name] = await decrypt(row.field_value, this.env.ENCRYPTION_KEY);
      } catch {
        // Skip fields that fail to decrypt (likely corrupted)
      }
    }

    let result: { redirect_url?: string; form_html?: string; action?: string; account_number?: string; instructions?: string } = {};

    if (gateway.type === 'manual') {
      const manual = await this.env.DB.prepare(
        `SELECT account_number, instructions FROM op_manual_gateways WHERE gateway_id = ? LIMIT 1`
      ).bind(gatewayId).first<{ account_number: string; instructions: string }>();

      result = {
        action: 'manual_payment',
        account_number: manual?.account_number ?? '01815300789',
        instructions: manual?.instructions ?? 'Send money to account',
      };
    } else {
      // Resolve adapter
      const adapter = gatewayRegistry.resolve(gateway.slug);

      // Build redirect/cancel URLs (using brand domain if set)
      const baseUrl = this.env.APP_URL;
      const redirectUrl = `${baseUrl}/checkout/${intent.token}/callback`;
      const cancelUrl = `${baseUrl}/checkout/${intent.token}/cancel`;

      // Call adapter
      result = await adapter.initiate(
        {
          amount: intent.amount,
          currency: intent.currency,
          trx_id: intent.trx_id,
          redirect_url: redirectUrl,
          cancel_url: cancelUrl,
        },
        credentials,
        { kv: this.env.KV },
      );
    }

    // Update transaction to processing
    await this.env.DB.prepare(

      `UPDATE op_transactions SET status = 'processing', updated_at = ? WHERE payment_intent_id = ?`
).bind(new Date().toISOString(), intentId).run();

    await this.env.DB.prepare(

      `UPDATE op_payment_intents SET status = 'processing', gateway_id = ?, updated_at = ? WHERE id = ?`
).bind(gatewayId, new Date().toISOString(), intentId).run();

    return result;
  }

  /**
   * Handle the synchronous callback (gateway redirects customer back).
   * Calls adapter.verify() with the query/body params.
   */
  async handleCallback(intentId: number, callbackData: Record<string, unknown>): Promise<{
    success: boolean;
    status: string;
  }> {
    const intent = await this.env.DB.prepare(

      `SELECT pi.*, t.id AS trx_db_id, t.trx_id, g.slug AS gateway_slug
       FROM op_payment_intents pi
       JOIN op_transactions t ON t.payment_intent_id = pi.id
       JOIN op_gateways g ON g.id = pi.gateway_id
       WHERE pi.id = ?
       LIMIT 1`
).bind(intentId).first<{
      id: number;
      merchant_id: number;
      amount: Money;
      currency: string;
      trx_db_id: number;
      trx_id: string;
      gateway_slug: string;
    }>();

    if (!intent) throw new NotFoundError('Payment intent');

    const adapter = gatewayRegistry.resolve(intent.gateway_slug);

    // Load credentials
    const credRows = await this.env.DB.prepare(

      `SELECT gc.field_name, gc.field_value FROM op_gateway_configs gc
       JOIN op_payment_intents pi ON pi.gateway_id = gc.gateway_id
       WHERE pi.id = ?`
).bind(intentId).all<{ field_name: string; field_value: string }>();

    const credentials: Record<string, string> = {};
    for (const row of credRows.results) {
      try {
        credentials[row.field_name] = await decrypt(row.field_value, this.env.ENCRYPTION_KEY);
      } catch { /* skip */ }
    }

    const verifyResult = await adapter.verify(callbackData, credentials, { kv: this.env.KV });

    if (verifyResult.success) {
      await this.completeTransaction(intent.trx_db_id, intent.id, verifyResult.gateway_trx_id);
    } else {
      await this.env.DB.prepare(

        `UPDATE op_transactions SET status = 'failed', updated_at = ? WHERE id = ?`
).bind(new Date().toISOString(), intent.trx_db_id).run();
    }

    return { success: verifyResult.success, status: verifyResult.status };
  }

  /**
   * Complete a transaction — marks as completed, posts ledger, dispatches webhook.
   * This is the "money-received" moment.
   *
   * v0.2.1: the ledger posting is AWAITED, not fire-and-forget. With the
   * posting protocol the call is idempotent per payment intent, so even
   * if a webhook redelivery or SMS race invokes this twice, the ledger
   * posts exactly once — and callers see the true posted state in the
   * response instead of racing a waitUntil promise. (v0.2.0 referenced
   * an undefined execution context here — the posting could silently
   * never run.)
   */
  async completeTransaction(
    transactionDbId: number,
    paymentIntentId: number,
    gatewayTrxId: string,
  ): Promise<void> {
    const tx = await this.env.DB
      .prepare(
        `SELECT t.*, pi.merchant_id FROM op_transactions t
         JOIN op_payment_intents pi ON pi.id = t.payment_intent_id
         WHERE t.id = ? LIMIT 1`,
      )
      .bind(transactionDbId)
      .first<{
        id: number;
        trx_id: string;
        merchant_id: number;
        amount: Money;
        currency: string;
        fee: Money;
        net_amount: Money;
      }>();

    if (!tx) throw new NotFoundError('Transaction');

    const now = new Date().toISOString();

    // Mark transaction completed
    await this.env.DB
      .prepare(
        `UPDATE op_transactions
         SET status = 'completed', gateway_trx_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(gatewayTrxId, now, transactionDbId)
      .run();

    await this.env.DB
      .prepare(
        `UPDATE op_payment_intents SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(now, now, paymentIntentId)
      .run();

    // Post double-entry ledger — AWAITED (idempotent per payment intent:
    // a webhook redelivery or SMS race cannot double-post; see
    // services/ledger.ts + docs/POSTING-PROTOCOL.md)
    await postPaymentLedgerEntry(
      this.env,
      tx.merchant_id,
      paymentIntentId,
      tx.amount,
      tx.fee,
      tx.currency,
    );

    // Dispatch merchant webhook (queue producer send — quick, and the
    // queue consumer owns delivery retries)
    const dispatcher = new WebhookDispatcher(this.env);
    await dispatcher.dispatch({
      merchant_id: tx.merchant_id,
      event: 'payment.completed',
      data: {
        transaction_id: tx.trx_id,
        gateway_trx_id: gatewayTrxId,
        amount: tx.amount,
        currency: tx.currency,
        fee: tx.fee,
        status: 'completed',
      },
    });
  }
}
