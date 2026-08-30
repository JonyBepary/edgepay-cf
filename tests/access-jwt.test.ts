/**
 * Cloudflare Access JWT verification tests (review fix #4).
 *
 * The middleware must VERIFY the Cf-Access-Jwt-Assertion against the team
 * JWKS and FAIL CLOSED. These tests exercise the pure verifyAccessJwt()
 * with locally-generated keys for both algorithms Cloudflare Access uses:
 *   - ES256 (Access's default): JWT signatures are RAW r||s (64 bytes) —
 *     the middleware converts to DER for WebCrypto; the tests mint raw
 *     signatures the same way Access does.
 *   - RS256 (older teams)
 *
 * Every negative case returns null — callers fail closed on null.
 */

import { describe, it, expect } from 'vitest';
import {
  verifyAccessJwt,
  type AccessJwk,
} from '../src/middleware/cloudflare-access';

const TEAM = 'edgepay-test.cloudflareaccess.com';
const AUD = 'abcd1234deadbeef0000111122223333';

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Signature bytes -> raw r||s (what JWS/Access sends). Handles both
 * workerd behaviors: sign() may return DER (spec) or already-raw 64 bytes
 * (observed in workerd) — normalize to raw either way.
 */
function signatureToRaw(sig: ArrayBuffer): Uint8Array {
  const b = new Uint8Array(sig);
  if (b.length === 64) return b; // already raw r||s
  if (b[0] !== 0x30) throw new Error('not a DER sequence');
  let i = 2;
  const readInt = (): Uint8Array => {
    if (b[i] !== 0x02) throw new Error('not a DER integer');
    const len = b[i + 1];
    i += 2;
    const val = b.slice(i, i + len);
    i += len;
    // strip leading zeros, then left-pad to 32
    let start = 0;
    while (start < val.length - 1 && val[start] === 0) start++;
    const trimmed = val.slice(start);
    const out = new Uint8Array(32);
    out.set(trimmed, 32 - trimmed.length);
    return out;
  };
  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

/** raw r||s -> DER SEQUENCE (to exercise the middleware's DER passthrough). */
function rawToDer(raw: Uint8Array): Uint8Array {
  const encInt = (bytes: Uint8Array): number[] => {
    const copy = Array.from(bytes);
    if ((copy[0] & 0x80) !== 0) copy.unshift(0);
    return [0x02, copy.length, ...copy];
  };
  const body = [...encInt(raw.slice(0, 32)), ...encInt(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

async function mintEs256Jwt(claims: Record<string, unknown>, kid: string): Promise<{ jwt: string; jwk: AccessJwk }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as unknown as AccessJwk;
  jwk.kid = kid;
  jwk.alg = 'ES256';

  const header = b64url(enc(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid })));
  const payload = b64url(enc(JSON.stringify(claims)));
  const data = enc(`${header}.${payload}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, data);
  const rawSig = signatureToRaw(sig); // JWS wire format — this is the point of the test
  return { jwt: `${header}.${payload}.${b64url(rawSig)}`, jwk };
}

async function mintRs256Jwt(claims: Record<string, unknown>, kid: string): Promise<{ jwt: string; jwk: AccessJwk }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as unknown as AccessJwk;
  jwk.kid = kid;
  jwk.alg = 'RS256';

  const header = b64url(enc(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
  const payload = b64url(enc(JSON.stringify(claims)));
  const data = enc(`${header}.${payload}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data);
  return { jwt: `${header}.${payload}.${b64url(sig)}`, jwk };
}

const NOW = 1_750_000_000_000; // fixed clock

function goodClaims(): Record<string, unknown> {
  return {
    iss: `https://${TEAM}`,
    aud: [AUD],
    exp: Math.floor(NOW / 1000) + 600,
    iat: Math.floor(NOW / 1000) - 30,
    sub: 'user-uuid-1',
    email: 'ops@example.com',
    common: { email: 'ops@example.com', name: 'Ops' },
  };
}

const expectation = { teamDomain: TEAM, aud: AUD, now: NOW };

describe('verifyAccessJwt — valid tokens', () => {
  it('verifies an ES256 token (Access default) with a raw r||s signature', async () => {
    const { jwt, jwk } = await mintEs256Jwt(goodClaims(), 'key-es-1');
    const identity = await verifyAccessJwt(jwt, [jwk], expectation);
    expect(identity).not.toBeNull();
    expect(identity!.email).toBe('ops@example.com');
    expect(identity!.sub).toBe('user-uuid-1');
  });

  it('verifies an RS256 token', async () => {
    const { jwt, jwk } = await mintRs256Jwt(goodClaims(), 'key-rs-1');
    const identity = await verifyAccessJwt(jwt, [jwk], expectation);
    expect(identity).not.toBeNull();
    expect(identity!.email).toBe('ops@example.com');
  });

  it('verifies an ES256 token even if the signature arrives already in DER form (defensive passthrough)', async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as unknown as AccessJwk;
    jwk.kid = 'key-es-der';
    jwk.alg = 'ES256';
    const header = b64url(enc(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'key-es-der' })));
    const payload = b64url(enc(JSON.stringify(goodClaims())));
    const rawSig = signatureToRaw(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, enc(`${header}.${payload}`)),
    );
    // Synthesize a DER-encoded signature from the raw form (workerd's own
    // sign() output format varies); the middleware passes DER through
    // untouched (length !== 64).
    const derSig = rawToDer(rawSig);
    const identity = await verifyAccessJwt(`${header}.${payload}.${b64url(derSig)}`, [jwk], expectation);
    expect(identity).not.toBeNull();
  });
});

describe('verifyAccessJwt — fail closed on every tamper vector', () => {
  it('rejects a tampered payload (signature no longer matches)', async () => {
    const { jwt, jwk } = await mintEs256Jwt(goodClaims(), 'key-es-2');
    const parts = jwt.split('.');
    const evil = b64url(enc(JSON.stringify({ ...goodClaims(), email: 'attacker@example.com' })));
    const identity = await verifyAccessJwt(`${parts[0]}.${evil}.${parts[2]}`, [jwk], expectation);
    expect(identity).toBeNull();
  });

  it('rejects a wrong audience (token for a DIFFERENT Access app)', async () => {
    const { jwt, jwk } = await mintEs256Jwt({ ...goodClaims(), aud: ['some-other-app-aud'] }, 'key-es-3');
    expect(await verifyAccessJwt(jwt, [jwk], expectation)).toBeNull();
  });

  it('rejects an expired token (even within clock-skew tolerance)', async () => {
    const { jwt, jwk } = await mintEs256Jwt({ ...goodClaims(), exp: Math.floor(NOW / 1000) - 3600 }, 'key-es-4');
    expect(await verifyAccessJwt(jwt, [jwk], expectation)).toBeNull();
  });

  it('rejects a token from a different Access team (issuer mismatch)', async () => {
    const { jwt, jwk } = await mintEs256Jwt({ ...goodClaims(), iss: 'https://evil.cloudflareaccess.com' }, 'key-es-5');
    expect(await verifyAccessJwt(jwt, [jwk], expectation)).toBeNull();
  });

  it('rejects a key not in the team JWKS (unknown kid)', async () => {
    const { jwt } = await mintEs256Jwt(goodClaims(), 'key-not-in-jwks');
    const { jwk: otherJwk } = await mintEs256Jwt(goodClaims(), 'key-different');
    expect(await verifyAccessJwt(jwt, [otherJwk], expectation)).toBeNull();
  });

  it('rejects a validly-signed token whose key has the wrong algorithm family', async () => {
    const { jwt: esJwt } = await mintEs256Jwt(goodClaims(), 'key-mix');
    const { jwk: rsJwk } = await mintRs256Jwt(goodClaims(), 'key-mix');
    expect(await verifyAccessJwt(esJwt, [rsJwk], expectation)).toBeNull();
  });

  it('rejects malformed tokens without throwing', async () => {
    const { jwk } = await mintEs256Jwt(goodClaims(), 'key-es-6');
    expect(await verifyAccessJwt('not-a-jwt', [jwk], expectation)).toBeNull();
    expect(await verifyAccessJwt('a.b.c.d', [jwk], expectation)).toBeNull();
    expect(await verifyAccessJwt('!!!.???.###', [jwk], expectation)).toBeNull();
    expect(await verifyAccessJwt('', [jwk], expectation)).toBeNull();
  });
});
