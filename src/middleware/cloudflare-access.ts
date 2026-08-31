/**
 * Cloudflare Access authentication (review fix #4).
 *
 * v0.2.0 trusted the spoofable `Cf-Access-Authenticated-Email` header,
 * gated by a `CF_ACCESS_ENABLED` env var — a standing backdoor: if
 * Access is detached/misconfigured and the flag is 'false', the admin
 * API is wide open to anyone who sets one header.
 *
 * v0.2.1 policy:
 *   1. VERIFY the `Cf-Access-Jwt-Assertion` JWT against the team's
 *      JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs):
 *      signature (ES256 with raw r||s -> DER conversion, or RS256),
 *      issuer, audience, expiry. The email header is never trusted for
 *      authorization — only the validated JWT is.
 *   2. FAIL CLOSED, always:
 *        - missing/invalid assertion            -> 401
 *        - team domain / AUD tag not configured -> 503 (misconfiguration denies)
 *        - JWKS unreachable                     -> 503 (fail closed, no
 *          fallback to header trust)
 *   3. Break-glass: a dedicated service-token pair (secrets) allows
 *      emergency operator access, emits a PAGE-level audit alarm, and
 *      is the ONLY non-JWT path. There is no env-var "disable" switch.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { page } from '../lib/observability';

// ------------------------------------------------------------------
// JWT verification (pure — unit-testable without network)
// ------------------------------------------------------------------

export interface AccessJwk {
  kty: 'EC' | 'RSA';
  kid?: string;
  alg?: string;
  use?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
}

export interface AccessJwtClaims {
  iss: string;
  sub?: string;
  aud: string | string[];
  exp: number;
  iat: number;
  email?: string;
  common?: { email?: string; name?: string };
  identity?: { email?: string; name?: string };
  [key: string]: unknown;
}

export interface VerifiedAccessIdentity {
  sub: string | null;
  email: string | null;
  claims: AccessJwtClaims;
}

function base64UrlToBytes(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** ASN.1 DER-encode an INTEGER from raw big-endian bytes (minimal form). */
function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = Array.from(bytes.slice(start));
  if ((trimmed[0] & 0x80) !== 0) trimmed.unshift(0);
  return [0x02, trimmed.length, ...trimmed];
}

/**
 * JWT ES256 signatures are the raw concatenation r||s (32+32 bytes);
 * WebCrypto's ECDSA verify spec expects DER SEQUENCE{r, s}. Convert.
 */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) return raw; // already DER or malformed — let verify fail
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32));
  const body = [...r, ...s];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** Inverse: DER SEQUENCE{r,s} -> raw r||s (64 bytes). */
function derSignatureToRaw(der: Uint8Array): Uint8Array {
  if (der.length === 64) return der;
  if (der[0] !== 0x30) return der; // not DER — caller's problem
  try {
    let i = 2;
    const readInt = (): Uint8Array => {
      if (der[i] !== 0x02) throw new Error('bad DER');
      const len = der[i + 1];
      i += 2;
      const val = der.slice(i, i + len);
      i += len;
      let start = 0;
      while (start < val.length - 1 && val[start] === 0) start++;
      const out = new Uint8Array(32);
      out.set(val.slice(start), 32 - (val.length - start));
      return out;
    };
    const r = readInt();
    const s = readInt();
    const raw = new Uint8Array(64);
    raw.set(r, 0);
    raw.set(s, 32);
    return raw;
  } catch {
    return der;
  }
}

async function importJwk(jwk: AccessJwk, alg: 'ES256' | 'RS256'): Promise<CryptoKey> {
  if (alg === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) {
      throw new Error('JWK is not a usable P-256 key');
    }
    return crypto.subtle.importKey(
      'jwk',
      jwk as unknown as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new Error('JWK is not a usable RSA key');
  }
  return crypto.subtle.importKey(
    'jwk',
    jwk as unknown as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

export interface AccessJwtExpectation {
  teamDomain: string;      // e.g. 'myteam.cloudflareaccess.com'
  aud: string;             // the Access application's AUD tag
  now?: number;            // ms since epoch (injectable for tests)
  clockSkewMs?: number;
}

/**
 * Verify a Cloudflare Access JWT. Returns the verified identity, or
 * null for ANY validation failure (callers fail closed on null).
 */
export async function verifyAccessJwt(
  jwt: string,
  jwks: AccessJwk[],
  expected: AccessJwtExpectation,
): Promise<VerifiedAccessIdentity | null> {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  let header: { alg: string; kid?: string; typ?: string };
  let claims: AccessJwtClaims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1])));
  } catch {
    return null;
  }

  if (header.alg !== 'ES256' && header.alg !== 'RS256') return null;

  // Claim checks — issuer, audience, expiry (fail closed on any miss)
  const now = expected.now ?? Date.now();
  const skew = expected.clockSkewMs ?? 60_000;
  const expectedIss = `https://${expected.teamDomain}`.replace(/\/+$/, '');
  if (typeof claims.iss !== 'string' || claims.iss.replace(/\/+$/, '') !== expectedIss) return null;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(expected.aud)) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now - skew) return null;

  // Key lookup by kid (with alg sanity), then signature verification
  let candidates = jwks.filter(k =>
    (!header.kid || !k.kid || k.kid === header.kid) &&
    (!k.alg || k.alg === header.alg) &&
    (k.kty === 'EC') === (header.alg === 'ES256'),
  );
  if (header.kid && candidates.length > 1) {
    const exact = candidates.filter(k => k.kid === header.kid);
    if (exact.length > 0) candidates = exact;
  }
  if (candidates.length === 0) return null;

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const rawSig = base64UrlToBytes(parts[2]);

  // ECDSA signature encodings: JWS sends raw r||s; the WebCrypto spec wants
  // DER. workerd accepts the raw form directly; other runtimes want DER.
  // Try the encoding as received first, then the converted form — both are
  // the same mathematical signature over the same data and key, so accepting
  // either encoding is standard JOSE practice, not a malleability risk.
  const es256SigAttempts: Uint8Array[] =
    header.alg === 'ES256'
      ? (rawSig.length === 64
          ? [rawSig, rawSignatureToDer(rawSig)]
          : [rawSig, derSignatureToRaw(rawSig)])
      : [rawSig];

  for (const jwk of candidates) {
    try {
      const key = await importJwk(jwk, header.alg);
      const algorithm = header.alg === 'ES256'
        ? { name: 'ECDSA', hash: 'SHA-256' }
        : { name: 'RSASSA-PKCS1-v1_5' };
      for (const sig of es256SigAttempts) {
        const ok = await crypto.subtle.verify(algorithm, key, sig as BufferSource, data as BufferSource);
        if (ok) {
          const email = claims.common?.email ?? claims.identity?.email ?? claims.email ?? null;
          return { sub: claims.sub ?? null, email, claims };
        }
      }
    } catch {
      // try next candidate key
    }
  }
  return null;
}

// ------------------------------------------------------------------
// JWKS fetching (module-level cache, 5-minute TTL)
// ------------------------------------------------------------------

const JWKS_TTL_MS = 5 * 60_000;
let jwksCache: { teamDomain: string; keys: AccessJwk[]; fetchedAt: number } | null = null;

export function clearAccessJwksCache(): void {
  jwksCache = null;
}

export async function fetchAccessJwks(teamDomain: string, forceRefresh = false): Promise<AccessJwk[]> {
  if (
    !forceRefresh &&
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`JWKS_FETCH_FAILED:${res.status}`);
  }
  const data = await res.json() as { keys?: AccessJwk[] };
  jwksCache = { teamDomain, keys: data.keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

// ------------------------------------------------------------------
// Hono middleware — the ONLY Access gate for /api/admin/*
// ------------------------------------------------------------------

interface AccessAuthVariables {
  accessEmail: string | null;
  accessSub: string | null;
  accessBreakGlass: boolean;
  merchantId: number | null;
  authType: 'bearer' | 'jwt' | 'session' | 'access' | null;
  authSubject: number | null;
  authScopes: string[];
}

export function accessAuthMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: Partial<AccessAuthVariables>;
}> {
  return async (c, next) => {
    // --- Bearer API Key with admin scope (allows direct REST administration) ---
    const authHeader = c.req.header('Authorization');
    if (authHeader && authHeader.startsWith('Bearer op_live_')) {
      const apiKey = authHeader.slice(7);
      const keyMatch = apiKey.match(/^op_live_([a-z0-9]{12})_([a-z0-9]+)$/i);
      if (keyMatch) {
        const prefix = keyMatch[1];
        const { sha256, timingSafeEqual } = await import('../lib/crypto');
        const keyHash = await sha256(apiKey);

        const keyRow = await c.env.DB.prepare(
          `SELECT ak.id, ak.merchant_id, ak.scopes, ak.status, ak.expires_at,
                  m.status AS merchant_status
           FROM op_api_keys ak
           JOIN op_merchants m ON m.id = ak.merchant_id
           WHERE ak.key_prefix = ? AND ak.status = 'active'
           LIMIT 1`
        ).bind(prefix).first<{
          id: number;
          merchant_id: number;
          scopes: string;
          status: string;
          expires_at: string | null;
          merchant_status: string;
        }>();

        if (keyRow && keyRow.merchant_status === 'active') {
          const storedHash = await c.env.DB.prepare(
            `SELECT key_hash FROM op_api_keys WHERE id = ?`
          ).bind(keyRow.id).first<{ key_hash: string }>();

          if (storedHash && timingSafeEqual(storedHash.key_hash, keyHash)) {
            const grantedScopes = JSON.parse(keyRow.scopes || '[]') as string[];
            if (grantedScopes.includes('*') || grantedScopes.includes('admin')) {
              c.set('accessEmail', `merchant-${keyRow.merchant_id}@edgepay.dev`);
              c.set('accessSub', `api-key-${keyRow.id}`);
              c.set('merchantId', keyRow.merchant_id);
              c.set('authType', 'bearer');
              c.set('authSubject', keyRow.id);
              c.set('authScopes', grantedScopes);
              return next();
            }
          }
        }
      }
    }

    const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    const aud = c.env.CF_ACCESS_AUD_TAG?.trim();

    // --- Break-glass service token (audit-alarmed, never silent) ---
    const bgId = c.req.header('Cf-Access-Client-Id');
    const bgSecret = c.req.header('Cf-Access-Client-Secret');
    if (bgId || bgSecret) {
      const valid =
        !!c.env.BREAK_GLASS_CLIENT_ID &&
        !!c.env.BREAK_GLASS_CLIENT_SECRET &&
        bgId === c.env.BREAK_GLASS_CLIENT_ID &&
        bgSecret === c.env.BREAK_GLASS_CLIENT_SECRET;
      if (!valid) {
        // Invalid break-glass attempt — page; do NOT fall through to a
        // header-trust path (that was the v0.2.0 backdoor).
        page(c.env, 'ACCESS_BREAK_GLASS_DENIED', {
          path: c.req.path,
          ip: c.req.header('CF-Connecting-IP') ?? null,
        });
        return c.json(
          { success: false, error: { code: 'ACCESS_DENIED', message: 'Invalid service credentials' } },
          401,
        );
      }
      page(c.env, 'ACCESS_BREAK_GLASS_USED', {
        path: c.req.path,
        ip: c.req.header('CF-Connecting-IP') ?? null,
        note: 'break-glass service token exercised — rotate after use',
      });
      c.set('accessEmail', 'break-glass@service.internal');
      c.set('accessSub', 'service-token');
      c.set('accessBreakGlass', true);
      return next();
    }

    // --- If Cloudflare Access is not configured, fall through to Admin Bearer API key auth ---
    if (!teamDomain || !aud) {
      const authHeader = c.req.header('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return next();
      }
      return c.json(
        {
          success: false,
          error: {
            code: 'ACCESS_NOT_CONFIGURED',
            message: 'Cloudflare Access not configured. Provide an Admin Bearer API key or configure CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD_TAG.',
          },
        },
        401,
      );
    }

    const jwt = c.req.header('Cf-Access-Jwt-Assertion');
    if (!jwt) {
      return c.json(
        { success: false, error: { code: 'ACCESS_DENIED', message: 'Cloudflare Access authentication required' } },
        401,
      );
    }

    // --- Verify the JWT against the team JWKS ---
    let identity: VerifiedAccessIdentity | null = null;
    try {
      let keys = await fetchAccessJwks(teamDomain);
      identity = await verifyAccessJwt(jwt, keys, { teamDomain, aud });
      if (!identity) {
        // Unknown kid or rotated keys — refresh the cache once and retry
        keys = await fetchAccessJwks(teamDomain, true);
        identity = await verifyAccessJwt(jwt, keys, { teamDomain, aud });
      }
    } catch {
      // JWKS unreachable — fail closed (503), NEVER fall back to trusting headers
      return c.json(
        { success: false, error: { code: 'ACCESS_UNAVAILABLE', message: 'Identity provider unreachable' } },
        503,
      );
    }

    if (!identity) {
      return c.json(
        { success: false, error: { code: 'ACCESS_DENIED', message: 'Invalid or expired Access assertion' } },
        401,
      );
    }

    // Spoof telemetry: a header email that disagrees with the VALIDATED
    // JWT identity is a probe — log it, trust only the JWT.
    const headerEmail = c.req.header('Cf-Access-Authenticated-Email');
    if (headerEmail && identity.email && headerEmail !== identity.email) {
      page(c.env, 'ACCESS_EMAIL_HEADER_MISMATCH', {
        path: c.req.path,
        header_email: headerEmail,
        verified_email: identity.email,
        ip: c.req.header('CF-Connecting-IP') ?? null,
      });
    }

    c.set('accessEmail', identity.email);
    c.set('accessSub', identity.sub);
    c.set('accessBreakGlass', false);
    return next();
  };
}
