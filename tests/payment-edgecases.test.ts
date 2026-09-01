import { describe, it, expect } from 'vitest';
import { createPaymentSchema, moneySchema, currencySchema } from '../src/lib/validation';

describe('Payment Intent & Money Edge Cases Validation', () => {
  it('validates correct money formats', () => {
    expect(moneySchema.safeParse('100').success).toBe(true);
    expect(moneySchema.safeParse('100.5').success).toBe(true);
    expect(moneySchema.safeParse('100.50').success).toBe(true);
    expect(moneySchema.safeParse('0.01').success).toBe(true);
    expect(moneySchema.safeParse('999999999.99').success).toBe(true);
  });

  it('rejects invalid money formats, negatives, and precision overflows', () => {
    expect(moneySchema.safeParse('100.555').success).toBe(false); // Max 2 fraction digits
    expect(moneySchema.safeParse('-100.00').success).toBe(false); // Negative
    expect(moneySchema.safeParse('1e5').success).toBe(false);     // Scientific notation
    expect(moneySchema.safeParse('abc').success).toBe(false);     // Non-numeric
    expect(moneySchema.safeParse('').success).toBe(false);        // Empty
    expect(moneySchema.safeParse('100,50').success).toBe(false);  // European comma in decimal
  });

  it('validates ISO 4217 currencies', () => {
    expect(currencySchema.safeParse('BDT').success).toBe(true);
    expect(currencySchema.safeParse('usd').success).toBe(true);
    expect(currencySchema.safeParse('EUR').success).toBe(true);
    expect(currencySchema.safeParse('USDT').success).toBe(false); // 4 letters
    expect(currencySchema.safeParse('12').success).toBe(false);   // Numbers
    expect(currencySchema.safeParse('$').success).toBe(false);    // Symbol
  });

  it('validates payment intent payload boundary limits', () => {
    // Valid intent
    const valid = createPaymentSchema.safeParse({
      amount: '500.00',
      currency: 'BDT',
      gateway: 'bkash',
      description: 'Clean description',
      expires_in_seconds: 3600,
    });
    expect(valid.success).toBe(true);

    // Expiry too small (< 60s)
    const tooFast = createPaymentSchema.safeParse({
      amount: '500.00',
      currency: 'BDT',
      expires_in_seconds: 10,
    });
    expect(tooFast.success).toBe(false);

    // Expiry too large (> 86400s)
    const tooLong = createPaymentSchema.safeParse({
      amount: '500.00',
      currency: 'BDT',
      expires_in_seconds: 999999,
    });
    expect(tooLong.success).toBe(false);

    // Description too large (> 1000 chars)
    const giantDesc = createPaymentSchema.safeParse({
      amount: '500.00',
      currency: 'BDT',
      description: 'x'.repeat(1001),
    });
    expect(giantDesc.success).toBe(false);
  });
});
