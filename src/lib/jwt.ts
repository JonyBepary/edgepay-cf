/**
 * JWT service — built on the `jose` library (Web Crypto-compatible).
 *
 * EdgePay uses JWTs for:
 *   - Mobile companion device authentication (after OTP pairing)
 *   - Refresh tokens
 *
 * Algorithm: HS256 (HMAC-SHA256) — symmetric key derived from env.JWT_SECRET
 *   - Workers runtime does NOT have Argon2id; we use PBKDF2 for password hashing.
 *   - For JWT signing, HMAC-SHA256 is fine — it's the same algorithm EdgePay uses.
 *
 * v0.2.2 (audit P2, jose best practices):
 *   - `aud: "mobile"` is now SET on signing and REQUIRED on verification
 *     (audience confusion between future token consumers becomes impossible).
 *   - `algorithms: ['HS256']` is pinned in jwtVerify — blocks alg-swap /
 *     "none" attacks and accidental HS384/RS256 drift.
 *   - The signing secret is length-checked at construction (>= 32 chars) —
 *     HS256 with a short secret is trivially brute-forceable.
 *
 * Token shape:
 *   {
 *     iss: "edgepay-cf",
 *     sub: "<user_id>",          // merchant user id
 *     aud: "mobile",              // audience (SET since v0.2.2)
 *     iat: 1700000000,
 *     exp: 1700003600,
 *     jti: "<random>",           // unique token id (for revocation tracking)
 *     scope: ["read", "write"],
 *     merchant_id: 1,
 *     device_id: 12,
 *     type: "access" | "refresh"
 *   }
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const ALG = 'HS256';
const ISSUER = 'edgepay-cf';
const AUDIENCE = 'mobile';
const MIN_SECRET_LENGTH = 32;

export interface EdgePayJwtPayload extends JWTPayload {
  sub: string;          // user_id (string form of integer)
  merchant_id: number;
  device_id?: number;
  scope: string[];
  type: 'access' | 'refresh';
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export class JwtService {
  constructor(
    private readonly secret: string,
    private readonly issuer: string = ISSUER,
    private readonly accessTtlSec: number = 3600,
    private readonly refreshTtlSec: number = 2592000, // 30 days
  ) {
    // v0.2.2 (audit P2): fail fast on weak secrets. HS256 security rests
    // entirely on secret entropy; a short secret is a silent vulnerability.
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length}). ` +
        'Generate one with: openssl rand -base64 32',
      );
    }
  }

  async issueAccessToken(payload: Omit<EdgePayJwtPayload, 'iss' | 'iat' | 'exp' | 'type' | 'jti'>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...payload, type: 'access' })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(now)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime(now + this.accessTtlSec)
      .setJti(crypto.randomUUID())
      .sign(secretKey(this.secret));
  }

  async issueRefreshToken(payload: Omit<EdgePayJwtPayload, 'iss' | 'iat' | 'exp' | 'type' | 'jti'>): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...payload, type: 'refresh' })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt(now)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setExpirationTime(now + this.refreshTtlSec)
      .setJti(crypto.randomUUID())
      .sign(secretKey(this.secret));
  }

  async verify(token: string, expectedType: 'access' | 'refresh' = 'access'): Promise<EdgePayJwtPayload> {
    try {
      const { payload } = await jwtVerify(token, secretKey(this.secret), {
        issuer: this.issuer,
        audience: AUDIENCE,
        algorithms: [ALG],
      });
      const edgepayPayload = payload as EdgePayJwtPayload;
      if (edgepayPayload.type !== expectedType) {
        throw new Error(`Expected ${expectedType} token, got ${edgepayPayload.type}`);
      }
      return edgepayPayload;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid token';
      throw new Error(`JWT verification failed: ${message}`);
    }
  }
}

/**
 * Factory — pulls configuration from env vars at startup.
 */
export function createJwtService(env: { JWT_SECRET: string; JWT_ISSUER?: string; JWT_TTL_SECONDS?: string; REFRESH_TOKEN_TTL_SECONDS?: string }): JwtService {
  return new JwtService(
    env.JWT_SECRET,
    env.JWT_ISSUER ?? ISSUER,
    parseInt(env.JWT_TTL_SECONDS ?? '3600', 10),
    parseInt(env.REFRESH_TOKEN_TTL_SECONDS ?? '2592000', 10),
  );
}
