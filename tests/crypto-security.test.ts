/**
 * Cryptography & Security Invariants Test Suite (EDGE-P2-017, V3-004, EDGE-P2-016).
 */
import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  timingSafeEqual,
  randomNumericOtp,
  randomBase64Key,
  sha256,
  PBKDF2_ITERATIONS,
  PBKDF2_ITERATIONS_MIN,
  PBKDF2_ITERATIONS_MAX,
  getPbkdf2Iterations,
} from '../src/lib/crypto';
import { parseEnabledGateways, isGatewayEnabled } from '../src/gateways/enabled';

describe('PBKDF2 Password Hashing & OWASP 600K Compliance (EDGE-P2-017, V10-004)', () => {
  it('pins default PBKDF2 iterations to OWASP 600,000 standard (V10-004)', () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
    expect(PBKDF2_ITERATIONS_MIN).toBe(10_000);
    expect(PBKDF2_ITERATIONS_MAX).toBe(2_000_000);
    expect(getPbkdf2Iterations()).toBe(600_000);
    expect(getPbkdf2Iterations({ PBKDF2_ITERATIONS: '25000' })).toBe(25_000);
    // Out of bounds fallback
    expect(getPbkdf2Iterations({ PBKDF2_ITERATIONS: '5000' })).toBe(600_000);
  });

  it('hashes and verifies passwords with PBKDF2-HMAC-SHA256', async () => {
    // Test with standard 10,000 cost for fast unit test execution
    const password = 'SuperSecurePassword!2026';
    const hash = await hashPassword(password, 10_000);
    
    expect(hash).toMatch(/^pbkdf2-sha256\$10000\$/);
    
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);

    const isInvalid = await verifyPassword('WrongPassword', hash);
    expect(isInvalid).toBe(false);
  });

  it('rejects iterations below security threshold PBKDF2_ITERATIONS_MIN', async () => {
    await expect(hashPassword('test', 5_000)).rejects.toThrow(/out of range/i);
  });

  it('verifyPassword rejects hashes with out-of-range iterations', async () => {
    const malformedHash = 'pbkdf2-sha256$500$c2FsdA==$aGFzaA==';
    expect(await verifyPassword('test', malformedHash)).toBe(false);
  });
});

describe('AES-256-GCM Encryption & Decryption Envelope', () => {
  it('encrypts and decrypts sensitive data accurately', async () => {
    const rawKey = randomBase64Key(32);
    const plaintext = JSON.stringify({
      merchant_id: 42,
      api_key: 'op_live_testkey123',
      secret: 'supersecret',
    });

    const encrypted = await encrypt(plaintext, rawKey);
    expect(encrypted).not.toEqual(plaintext);

    const decrypted = await decrypt(encrypted, rawKey);
    expect(decrypted).toEqual(plaintext);
    expect(JSON.parse(decrypted)).toEqual({
      merchant_id: 42,
      api_key: 'op_live_testkey123',
      secret: 'supersecret',
    });
  });
});

describe('Timing-Safe Comparison & Entropy Helpers', () => {
  it('compares equal and non-equal strings safely', () => {
    expect(timingSafeEqual('abcdef123456', 'abcdef123456')).toBe(true);
    expect(timingSafeEqual('abcdef123456', 'abcdef123457')).toBe(false);
    expect(timingSafeEqual('short', 'longer_string')).toBe(false);
  });

  it('generates cryptographically secure OTPs of specified length', () => {
    const otp6 = randomNumericOtp(6);
    expect(otp6).toMatch(/^\d{6}$/);

    const otp8 = randomNumericOtp(8);
    expect(otp8).toMatch(/^\d{8}$/);
  });

  it('computes sha256 hex digests accurately', async () => {
    const hash = await sha256('EdgePay');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('Gateway Enablement Fail-Closed Default (EDGE-P2-016)', () => {
  it('enables all adapters when ENABLED_GATEWAYS is empty or all', () => {
    const empty = parseEnabledGateways('');
    expect(empty.allEnabled).toBe(true);
    expect(empty.enabled.length).toBeGreaterThan(10);

    const all = parseEnabledGateways('all');
    expect(all.allEnabled).toBe(true);
  });

  it('enables ONLY explicitly listed gateways and fails closed on typos', () => {
    const specific = parseEnabledGateways('bkash, nagad');
    expect(specific.enabled).toContain('bkash-api');
    expect(specific.enabled).toContain('nagad-merchant-api');
    expect(specific.enabled).not.toContain('stripe');

    const env = { ENABLED_GATEWAYS: 'bkash, nagad' };
    expect(isGatewayEnabled(env, 'bkash-api')).toBe(true);
    expect(isGatewayEnabled(env, 'stripe')).toBe(false);

    // Fail closed: completely unrecognized gateway enables NOTHING
    const typo = parseEnabledGateways('nonexistent_gateway_slug');
    expect(typo.enabled.length).toBe(0);
    expect(typo.dropped).toContain('nonexistent_gateway_slug');
  });
});
