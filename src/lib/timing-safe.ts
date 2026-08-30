/**
 * Timing-safe string comparison for signature checks.
 *
 * Workers has no node:crypto timingSafeEqual; this is the constant-work
 * equivalent: always compares both full strings, accumulates XOR
 * differences, and only converts to boolean at the end. Length is not
 * secret in gateway-signature contexts (header formats are public), but we
 * still fold it into the accumulator rather than early-returning.
 */

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);

  const max = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < max; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }

  return diff === 0;
}
