/**
 * Idempotency middleware — port of EdgePay's PHP IdempotencyMiddleware.
 *
 * Allows clients to safely retry POST /api/v1/payments without double-charging.
 * Client passes `X-Idempotency-Key: <uuid>` header; server stores the key +
 * request body hash + response. Subsequent requests with the same key within
 * 24h return the cached response.
 *
 * Storage: D1 op_idempotency_keys table (write-through, single-row lookup by
 * (merchant_id, key) composite index).
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import { sha256 } from '../lib/crypto';
import { ConflictError } from '../lib/error';

const HEADER_NAME = 'X-Idempotency-Key';
const TTL_HOURS = 24;

interface CachedResponse {
  status: number;
  body: string;
}

export const idempotencyMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: { merchantId?: number | null };
}> = async (c, next) => {
  // Only applies to POST/PUT/PATCH
  if (!['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    return await next();
  }

  const idempotencyKey = c.req.header(HEADER_NAME);
  if (!idempotencyKey) {
    // Idempotency key optional but recommended for payment endpoints
    return await next();
  }

  // Validate key format (UUID v4 or any 8-64 char alphanumeric)
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(idempotencyKey)) {
    return c.json({
      success: false,
      error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency key must be 8-64 alphanumeric chars' },
    }, 400);
  }

  // Determine merchant_id (from domain middleware or bearer auth)
  const merchantId = c.get('merchantId');
  if (!merchantId) {
    return next(); // Let auth middleware fail with proper 401
  }

  // Compute request body hash
  const body = await c.req.text();
  const bodyHash = await sha256(body);

  // Look up existing idempotency record
  const existing = await c.env.DB.prepare(

    `SELECT id, request_body_hash, response_status, response_body, expires_at
     FROM op_idempotency_keys
     WHERE merchant_id = ? AND key = ?
     LIMIT 1`
).bind(merchantId, idempotencyKey).first<{
    id: number;
    request_body_hash: string;
    response_status: number;
    response_body: string;
    expires_at: string;
  }>();

  if (existing) {
    // Check expiry
    if (new Date(existing.expires_at) < new Date()) {
      // Expired — delete and continue
      c.executionCtx.waitUntil(
        c.env.DB.prepare(
`DELETE FROM op_idempotency_keys WHERE id = ?`
).bind(existing.id).run(),
      );
    } else {
      // Same key, different body? → conflict
      if (existing.request_body_hash !== bodyHash) {
        throw new ConflictError(
          'Idempotency key was used with a different request body. Use a new key.',
        );
      }

      // Return cached response
      const cached: CachedResponse = {
        status: existing.response_status,
        body: existing.response_body,
      };

      return new Response(cached.body, {
        status: cached.status,
        headers: { 'Content-Type': 'application/json', 'X-Idempotent-Replay': 'true' },
      });
    }
  }

  // No existing record — process the request and capture response
  await next();

  // Capture the response
  // Note: Hono 4.x — after next(), c.res is populated with the produced Response.
  const response = c.res;
  if (response && response.status >= 200 && response.status < 500) {
    const responseStatus = response.status;
    const responseText = await response.clone().text();

    // Store (fire-and-forget)
    c.executionCtx.waitUntil(
      c.env.DB.prepare(

        `INSERT INTO op_idempotency_keys (merchant_id, key, request_body_hash, response_status, response_body, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
).bind(merchantId,
          idempotencyKey,
          bodyHash,
          responseStatus,
          responseText,
          new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString(),
          new Date().toISOString(),).run(),
    );
  }
};
