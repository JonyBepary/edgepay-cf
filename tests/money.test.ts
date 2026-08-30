/**
 * Money math tests (v0.2.2 — audit P2, decimal.js best practices).
 *
 * Covers:
 *   1. The isolated MoneyDecimal clone (Decimal.clone) — mutating the GLOBAL
 *      Decimal config must not affect money math.
 *   2. toMinorUnits' exact integer-string conversion + LOUD RangeError on
 *      values past 2^53 (the old toNumber() path silently corrupted them).
 *   3. The string-in/string-out bcmath contract at scale.
 */

import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  add, sub, mul, div, cmp, gt, isZero,
  toMinorUnits, fromMinorUnits, isValidMoney, ZERO,
} from '../src/lib/money';

describe('money — bcmath string contract', () => {
  it('adds without float drift', () => {
    expect(add('0.10', '0.20')).toBe('0.30');
    expect(add('0.1', '0.2')).toBe('0.30');
    expect(add('9999999999.99', '0.01')).toBe('10000000000.00');
  });

  it('subtracts, multiplies and divides at fixed scale', () => {
    expect(sub('10.00', '3.33')).toBe('6.67');
    expect(mul('19.99', '3')).toBe('59.97');
    expect(mul('0.07', '0.07')).toBe('0.00'); // rounds half-up at scale 2
    expect(div('1', '3', 6)).toBe('0.333333');
    expect(div('10', '4', 2)).toBe('2.50');
  });

  it('compares and classifies', () => {
    expect(cmp('10.00', '10.00')).toBe(0);
    expect(gt('10.01', '10.00')).toBe(true);
    expect(isZero(ZERO)).toBe(true);
    expect(isValidMoney('100.50')).toBe(true);
    expect(isValidMoney('100')).toBe(true);
    expect(isValidMoney('-100.50')).toBe(false); // amounts are unsigned at this layer
    expect(isValidMoney('abc')).toBe(false);
    expect(isValidMoney('100.555')).toBe(true); // permissive helper; the API zod schema is the strict boundary
  });
});

describe('money — Decimal.clone isolation (audit P2)', () => {
  it('money math is immune to global Decimal config mutations', () => {
    // decimal.js stores config as constructor properties; config()/set()
    // mutate-in-place and return the constructor. Snapshot manually.
    const snapshot = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 5 }); // trash the GLOBAL config
      // With the old code (Decimal.set + global constructor), precision 5
      // would round 1234567.89 + 0.01 to 5 significant digits.
      expect(add('1234567.89', '0.01')).toBe('1234567.90');
      expect(mul('9999999.99', '1')).toBe('9999999.99');
    } finally {
      Decimal.set(snapshot); // restore for other modules
    }
  });
});

describe('money — toMinorUnits exactness (audit P2)', () => {
  it('converts at the common exponents', () => {
    expect(toMinorUnits('100.50')).toBe(10050);
    expect(toMinorUnits('0.10')).toBe(10);
    expect(toMinorUnits('100', 0)).toBe(100);
    expect(toMinorUnits('0.99')).toBe(99);
  });

  it('handles the 2^53 boundary EXACTLY (old toNumber() path did not)', () => {
    // 90071992547409.91 * 100 = 9007199254740991 = Number.MAX_SAFE_INTEGER
    expect(toMinorUnits('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws a loud RangeError past the safe integer range', () => {
    // 90071992547409.93 * 100 = 9007199254740993 > 2^53 - 1
    expect(() => toMinorUnits('90071992547409.93')).toThrow(RangeError);
    expect(() => toMinorUnits('99999999999999999')).toThrow(/safe integer/);
  });

  it('round-trips through fromMinorUnits', () => {
    expect(fromMinorUnits(10050)).toBe('100.50');
    expect(fromMinorUnits(0)).toBe('0.00');
    expect(fromMinorUnits(1, 0)).toBe('1');
    expect(fromMinorUnits(toMinorUnits('1234.56'))).toBe('1234.56');
  });
});
