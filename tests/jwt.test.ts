/**
 * JWT service tests (v0.2.2 — audit P2, jose best practices).
 *
 * Covers the three hardening changes:
 *   1. aud:"mobile" is SET on signing and REQUIRED on verification
 *   2. algorithms: ['HS256'] pinned in jwtVerify (alg-swap rejection)
 *   3. signing secret length >= 32 enforced at construction
 *
 * Plus the pre-existing contract: token type confusion (access vs refresh)
 * and issuer checking.
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { JwtService, createJwtService } from '../src/lib/jwt';

const SECRET_32 = '0123456789abcdef0123456789abcdef'; // exactly 32 chars
const SECRET_33 = '0123456789abcdef0123456789abcdefg'; // 33 chars
const PAYLOAD = {
  sub: '42',
  merchant_id: 7,
  device_id: 3,
  scope: ['read', 'write'],
} as const;

function service(secret = SECRET_32): JwtService {
  return new JwtService(secret, 'edgepay-cf', 3600, 2592000);
}

describe('JwtService — secret length enforcement (audit P2)', () => {
  it('rejects secrets shorter than 32 characters at construction', () => {
    expect(() => new JwtService('short')).toThrow(/at least 32 characters/);
    expect(() => new JwtService('a'.repeat(31))).toThrow(/got 31/);
  });

  it('accepts 32+ character secrets', () => {
    expect(() => new JwtService(SECRET_32)).not.toThrow();
    expect(() => new JwtService(SECRET_33)).not.toThrow();
  });

  it('createJwtService enforces the same floor', () => {
    expect(() => createJwtService({ JWT_SECRET: 'tiny' })).toThrow(/at least 32 characters/);
    expect(() => createJwtService({ JWT_SECRET: SECRET_32 })).not.toThrow();
  });
});

describe('JwtService — audience (audit P2)', () => {
  it('sets aud:"mobile" on issued access tokens and verifies them', async () => {
    const jwt = service();
    const token = await jwt.issueAccessToken({ ...PAYLOAD });
    const payload = await jwt.verify(token, 'access');
    expect(payload.aud).toBe('mobile');
    expect(payload.type).toBe('access');
    expect(payload.merchant_id).toBe(7);
  });

  it('sets aud:"mobile" on refresh tokens too', async () => {
    const jwt = service();
    const token = await jwt.issueRefreshToken({ ...PAYLOAD });
    const payload = await jwt.verify(token, 'refresh');
    expect(payload.aud).toBe('mobile');
    expect(payload.type).toBe('refresh');
  });

  it('REJECTS tokens minted for a different audience', async () => {
    // Sign a token with aud "admin" using the same secret + issuer.
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: '42', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setIssuer('edgepay-cf')
      .setAudience('admin') // ← wrong audience
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET_32));

    await expect(service().verify(token, 'access')).rejects.toThrow(/JWT verification failed/);
  });
});

describe('JwtService — algorithm pinning (audit P2)', () => {
  it('REJECTS tokens signed with HS384 even under the same secret', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: '42', type: 'access' })
      .setProtectedHeader({ alg: 'HS384' }) // ← algorithm outside the pin
      .setIssuedAt(now)
      .setIssuer('edgepay-cf')
      .setAudience('mobile')
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET_32));

    await expect(service().verify(token, 'access')).rejects.toThrow(/JWT verification failed/);
  });
});

describe('JwtService — pre-existing contract (regression)', () => {
  it('rejects token type confusion (access token passed as refresh)', async () => {
    const jwt = service();
    const token = await jwt.issueAccessToken({ ...PAYLOAD });
    await expect(jwt.verify(token, 'refresh')).rejects.toThrow(/Expected refresh token/);
  });

  it('rejects tokens from a different issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: '42', type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setIssuer('someone-else') // ← wrong issuer
      .setAudience('mobile')
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(SECRET_32));

    await expect(service().verify(token, 'access')).rejects.toThrow(/JWT verification failed/);
  });

  it('rejects garbage tokens without throwing raw errors', async () => {
    await expect(service().verify('not-a-jwt', 'access')).rejects.toThrow(/JWT verification failed/);
  });
});
