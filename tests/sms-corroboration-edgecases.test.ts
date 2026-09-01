import { describe, it, expect } from 'vitest';
import { corroborateSmsPayment, senderToGatewaySlug, type OpenOrderCandidate, type SmsExtraction } from '../src/services/sms-corroboration';

describe('SMS Corroboration Edge Cases & Anti-Fraud Gates', () => {
  const baseOrder: OpenOrderCandidate = {
    transaction_row_id: 1,
    payment_intent_id: 10,
    amount: '500.00',
    currency: 'BDT',
    gateway_slug: 'bkash',
    customer_trx_id: 'BK998877',
  };

  it('rejects ambiguous orders when multiple open candidates have the exact same amount and TrxID', () => {
    const order2: OpenOrderCandidate = {
      transaction_row_id: 2,
      payment_intent_id: 11,
      amount: '500.00',
      currency: 'BDT',
      gateway_slug: 'bkash',
      customer_trx_id: 'BK998877',
    };

    const extraction: SmsExtraction = {
      amount: '500.00',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [baseOrder, order2], 'bkash');
    expect(decision.action).toBe('manual_review');
    if (decision.action === 'manual_review') {
      expect(decision.reason).toBe('ambiguous_match');
    }
  });

  it('holds in awaiting_customer_trx when no candidate has submitted matching TrxID yet', () => {
    const unclaimedOrder: OpenOrderCandidate = {
      transaction_row_id: 1,
      payment_intent_id: 10,
      amount: '500.00',
      currency: 'BDT',
      gateway_slug: 'bkash',
    };

    const extraction: SmsExtraction = {
      amount: '500.00',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [unclaimedOrder], 'bkash');
    expect(decision.action).toBe('manual_review');
    if (decision.action === 'manual_review') {
      expect(decision.reason).toBe('awaiting_customer_trx');
    }
  });

  it('rejects non-exact amount matching (e.g. 500.01 vs 500.00)', () => {
    const extraction: SmsExtraction = {
      amount: '500.01',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [baseOrder], 'bkash');
    expect(decision.action).toBe('manual_review');
    if (decision.action === 'manual_review') {
      expect(decision.reason).toBe('no_amount_match');
    }
  });

  it('rejects currency mismatches (e.g. order in USD, SMS in BDT)', () => {
    const usdOrder: OpenOrderCandidate = {
      transaction_row_id: 3,
      payment_intent_id: 12,
      amount: '50.00',
      currency: 'USD',
      gateway_slug: 'stripe',
      customer_trx_id: 'BK998877',
    };

    const extraction: SmsExtraction = {
      amount: '50.00',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [usdOrder], 'bkash');
    expect(decision.action).toBe('manual_review');
    if (decision.action === 'manual_review') {
      expect(decision.reason).toBe('currency_mismatch');
    }
  });

  it('rejects cross-gateway conflicts (e.g. order created on Nagad, SMS from bKash)', () => {
    const nagadOrder: OpenOrderCandidate = {
      transaction_row_id: 4,
      payment_intent_id: 13,
      amount: '500.00',
      currency: 'BDT',
      gateway_slug: 'nagad',
      customer_trx_id: 'BK998877',
    };

    const extraction: SmsExtraction = {
      amount: '500.00',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [nagadOrder], 'bkash');
    expect(decision.action).toBe('manual_review');
    if (decision.action === 'manual_review') {
      expect(decision.reason).toBe('gateway_conflict');
    }
  });

  it('confirms cleanly when exact amount, currency, TrxID, and gateway match', () => {
    const extraction: SmsExtraction = {
      amount: '500.00',
      trx_id: 'BK998877',
      currency: 'BDT',
      gateway_slug: 'bkash',
      confidence: 1.0,
      parser: 'regex',
    };

    const decision = corroborateSmsPayment(extraction, [baseOrder], 'bkash');
    expect(decision.action).toBe('confirm');
    if (decision.action === 'confirm') {
      expect(decision.order.payment_intent_id).toBe(10);
      expect(decision.gateway_slug).toBe('bkash');
    }
  });

  it('normalizes sender IDs cleanly', () => {
    expect(senderToGatewaySlug('bKash')).toBe('bkash-api');
    expect(senderToGatewaySlug('bKash LTD')).toBe('bkash-api');
    expect(senderToGatewaySlug('NAGAD')).toBe('nagad-merchant-api');
    expect(senderToGatewaySlug('Rocket')).toBe('rocket');
    expect(senderToGatewaySlug('UNKNOWN_CARRIER')).toBeNull();
  });
});
