/**
 * Authentication middleware — bearer API keys + JWT for mobile.
 *
 * EdgePay's PHP original has 3 auth middlewares:
 *   - BearerAuthMiddleware (merchant API)
 *   - AdminBearerAuthMiddleware (admin API)
 *   - JwtAuthMiddleware (mobile companion API)
 *
 * On HonoJS we expose them as factory functions that return middleware
 * with the expected scope/role requirements.
 *
 * API key format: `op_live_<prefix>_<rest>` — the prefix (first 12 chars
 * after `op_live_`) is stored in plaintext for DB index lookup; the rest
 * is hashed with SHA-256 for verification.
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { sha256, timingSafeEqual } from '../lib/crypto';
import { UnauthorizedError, ForbiddenError } from '../lib/error';

interface ApiVariables {
  merchantId: number | null;
  authSubject: number | null;
  authScopes: string[];
  authType: 'bearer' | 'jwt' | 'session' | null;
}


/**
 * Bearer API key auth — used for merchant REST API.
 * Requires scopes; pass ['*'] to allow any scope.
 */
export function requireBearerApiAuth(scopes: string[] = ['read', 'write', 'admin']): MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }

    const apiKey = authHeader.slice(7);

    // API key format: op_live_<prefix>_<rest>
    const keyMatch = apiKey.match(/^op_live_([a-z0-9]{12})_([a-z0-9]+)$/i);
    if (!keyMatch) {
      throw new UnauthorizedError('Malformed API key');
    }

    const prefix = keyMatch[1];
    const keyHash = await sha256(apiKey);

    // Look up by prefix (index lookup)
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

    if (!keyRow) {
      throw new UnauthorizedError('Invalid API key');
    }

    if (keyRow.merchant_status !== 'active') {
      throw new ForbiddenError('Merchant account suspended');
    }

    if (keyRow.expires_at && new Date(keyRow.expires_at) < new Date()) {
      throw new UnauthorizedError('API key expired');
    }

    // Verify the full hash (timing-safe)
    const storedHash = await c.env.DB.prepare(

      `SELECT key_hash FROM op_api_keys WHERE id = ?`
).bind(keyRow.id).first<{ key_hash: string }>();

    if (!storedHash || !timingSafeEqual(storedHash.key_hash, keyHash)) {
      throw new UnauthorizedError('Invalid API key');
    }

    // Check scopes
    const grantedScopes = JSON.parse(keyRow.scopes || '[]') as string[];
    const hasScope = grantedScopes.includes('*') || scopes.some(s => grantedScopes.includes(s));
    if (!hasScope) {
      throw new ForbiddenError(`Required scope not granted: ${scopes.join(', ')}`);
    }

    // Attach to context
    c.set('authType', 'bearer');
    c.set('authSubject', keyRow.id);
    c.set('authScopes', grantedScopes);

    // Tenant isolation: if domain middleware resolved a merchant, the API key must belong to the same merchant
    const domainMerchantId = c.get('merchantId');
    if (domainMerchantId != null && domainMerchantId !== keyRow.merchant_id) {
      throw new ForbiddenError('Tenant mismatch: API key does not belong to this domain');
    }
    c.set('merchantId', keyRow.merchant_id);

    // Update last_used_at (fire-and-forget)
    c.executionCtx.waitUntil(
      c.env.DB.prepare(

        `UPDATE op_api_keys SET last_used_at = ? WHERE id = ?`
).bind(new Date().toISOString(), keyRow.id).run(),
    );

    await next();
  };
}

/**
 * JWT auth — used for mobile companion API.
 * Token issued after device pairing.
 */
export function requireJwtAuth(): MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> {
  return async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing Authorization header');
    }

    const token = authHeader.slice(7);

    // Dynamic import to avoid loading jose on every request (tree-shake friendly)
    const { createJwtService } = await import('../lib/jwt');
    const jwt = createJwtService(c.env);

    let payload;
    try {
      payload = await jwt.verify(token, 'access');
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    c.set('authType', 'jwt');
    c.set('authSubject', parseInt(payload.sub, 10));
    c.set('authScopes', payload.scope);
    // Tenant isolation: if domain middleware resolved a merchant, the JWT must belong to the same merchant
    const domainMerchantIdForJwt = c.get('merchantId');
    if (domainMerchantIdForJwt != null && domainMerchantIdForJwt !== payload.merchant_id) {
      throw new ForbiddenError('Tenant mismatch: JWT does not belong to this domain');
    }
    c.set('merchantId', payload.merchant_id);

    await next();
  };
}

/**
 * Require a specific scope — chained after requireBearerApiAuth.
 */
export function requireScope(scope: string): MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> {
  return async (c, next) => {
    const scopes = c.get('authScopes') ?? [];
    if (!scopes.includes('*') && !scopes.includes(scope)) {
      throw new ForbiddenError(`Required scope: ${scope}`);
    }
    await next();
  };
}
