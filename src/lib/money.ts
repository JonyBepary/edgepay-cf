/**
 * Decimal.js wrapper — bcmath equivalent for monetary math.
 *
 * EdgePay's PHP original uses bcmath strings throughout to avoid
 * floating-point precision loss in monetary calculations:
 *   bcadd('0.1', '0.2', 2) === '0.30'  // string result, no float
 *
 * In TypeScript we use decimal.js (10 KB gzipped) with the same
 * string-in, string-out convention. Never let monetary math touch
 * JS number type — IEEE 754 floats lose precision past 2^53.
 *
 * v0.2.2 (audit P2): configuration moved from the GLOBAL Decimal
 * (Decimal.set mutates every import of decimal.js in the isolate)
 * to an isolated clone — MoneyDecimal. Money math is now immune to
 * config drift caused by any other module touching the global.
 * https://mikemcl.github.io/decimal.js/#clone
 */

import Decimal from 'decimal.js';

// Isolated configuration context for finance: 30 digits of precision,
// round-half-up for money. The global Decimal is left untouched.
const MoneyDecimal = Decimal.clone({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Money = string; // Always a decimal string, e.g. "100.50"

/**
 * Add two monetary amounts. Returns string to avoid float drift.
 *   add('0.10', '0.20') → '0.30'
 */
export function add(a: Money, b: Money, scale: number = 2): Money {
  return new MoneyDecimal(a).plus(new MoneyDecimal(b)).toFixed(scale);
}

export function sub(a: Money, b: Money, scale: number = 2): Money {
  return new MoneyDecimal(a).minus(new MoneyDecimal(b)).toFixed(scale);
}

export function mul(a: Money, b: Money | number, scale: number = 2): Money {
  return new MoneyDecimal(a).times(new MoneyDecimal(b)).toFixed(scale);
}

export function div(a: Money, b: Money | number, scale: number = 6): Money {
  return new MoneyDecimal(a).div(new MoneyDecimal(b)).toFixed(scale);
}

export function cmp(a: Money, b: Money): number {
  return new MoneyDecimal(a).cmp(new MoneyDecimal(b));
}

export function gt(a: Money, b: Money): boolean {
  return new MoneyDecimal(a).gt(new MoneyDecimal(b));
}

export function gte(a: Money, b: Money): boolean {
  return new MoneyDecimal(a).gte(new MoneyDecimal(b));
}

export function lt(a: Money, b: Money): boolean {
  return new MoneyDecimal(a).lt(new MoneyDecimal(b));
}

export function lte(a: Money, b: Money): boolean {
  return new MoneyDecimal(a).lte(new MoneyDecimal(b));
}

export function isZero(a: Money): boolean {
  return new MoneyDecimal(a).isZero();
}

export function isPositive(a: Money): boolean {
  return new MoneyDecimal(a).isPositive();
}

export function isNegative(a: Money): boolean {
  return new MoneyDecimal(a).isNegative();
}

/**
 * Convert an amount to gateway "minor units" (e.g. cents for USD, paisa for BDT).
 *   toMinorUnits('100.50', 2) → 10050
 *   toMinorUnits('100', 0)    → 100
 *
 * v0.2.2 (audit P2): the old `.toNumber()` conversion silently lost
 * precision past 2^53. The integer-string path (toFixed(0) → parseInt)
 * is exact, and the isSafeInteger guard fails LOUD on overflow instead
 * of handing a corrupted amount to a gateway.
 */
export function toMinorUnits(amount: Money, exponent: number = 2): number {
  const scaled = new MoneyDecimal(amount)
    .times(new MoneyDecimal(10).pow(exponent))
    .toFixed(0);
  const minor = parseInt(scaled, 10);
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError(
      `toMinorUnits: ${amount} at exponent ${exponent} exceeds the safe integer range`,
    );
  }
  return minor;
}

/**
 * Inverse of toMinorUnits — converts integer minor units back to a Money string.
 *   fromMinorUnits(10050, 2) → '100.50'
 */
export function fromMinorUnits(minor: number, exponent: number = 2): Money {
  return new MoneyDecimal(minor).div(new MoneyDecimal(10).pow(exponent)).toFixed(exponent);
}

/**
 * Format a Money string for display (thousand separators, currency symbol).
 * Caller can format with Intl.NumberFormat if needed.
 */
export function format(amount: Money, currency: string, locale: string = 'en-US'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
  }).format(new MoneyDecimal(amount).toNumber());
}

/**
 * Validate that a string is a valid monetary amount.
 *   isValidMoney('100.50') → true
 *   isValidMoney('100.5')  → true
 *   isValidMoney('100')    → true
 *   isValidMoney('abc')    → false
 */
export function isValidMoney(value: string): boolean {
  try {
    new MoneyDecimal(value);
    return /^\d+(\.\d+)?$/.test(value);
  } catch {
    return false;
  }
}

/**
 * Zero constant for convenience.
 */
export const ZERO: Money = '0.00';
