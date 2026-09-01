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
 *
 * Fixes applied (payment-integrity):
 *  - Body hashing does NOT consume the request body (uses raw.clone()).
 *  - 4xx responses are never cached (only 2xx/3xx).
 *  - Concurrent D1 uniqueness handled via ON CONFLICT DO NOTHING + swallowed error.
 *  - Expired rows are deleted synchronously before re-processing.
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

type IdempotencyOptions = {
  /** When true, missing key returns 400 instead of passthrough (used for refunds). */
  required?: boolean;
};

export function createIdempotencyMiddleware(opts: IdempotencyOptions = {}): MiddlewareHandler<{
  Bindings: Env;
  Variables: { merchantId?: number | null };
}> {
  const required = !!opts.required;
  return async (c, next) => {
    // Only applies to POST/PUT/PATCH
    if (!['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
      return await next();
    }

    const idempotencyKey = c.req.header(HEADER_NAME);
    if (!idempotencyKey) {
      if (required) {
        return c.json(
          {
            success: false,
            error: {
              code: 'IDEMPOTENCY_KEY_REQUIRED',
              message: 'X-Idempotency-Key header is required for this operation',
            },
          },
          400,
        );
      }
      // Idempotency key optional but recommended for payment endpoints
      return await next();
    }

    // Validate key format (UUID v4 or any 8-64 char alphanumeric)
    if (!/^[a-zA-Z0-9_-]{8,64}$/.test(idempotencyKey)) {
      return c.json(
        {
          success: false,
          error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency key must be 8-64 alphanumeric chars' },
        },
        400,
      );
    }

    // Determine merchant_id (from domain middleware or bearer auth)
    const merchantId = c.get('merchantId');
    if (!merchantId) {
      return next(); // Let auth middleware fail with proper 401
    }

    // Compute request body hash WITHOUT consuming the original request stream.
    // Using raw.clone() leaves the original body intact for downstream zValidator/json parsing.
    let body = '';
    try {
      body = await c.req.raw.clone().text();
    } catch {
      body = '';
    }
    const bodyHash = await sha256(body);

    // Look up existing idempotency record
    const existing = await c.env.DB.prepare(
      `SELECT id, request_body_hash, response_status, response_body, expires_at
       FROM op_idempotency_keys
       WHERE merchant_id = ? AND key = ?
       LIMIT 1`,
    )
      .bind(merchantId, idempotencyKey)
      .first<{
        id: number;
        request_body_hash: string;
        response_status: number;
        response_body: string;
        expires_at: string;
      }>();

    if (existing) {
      // Check expiry
      if (new Date(existing.expires_at) < new Date()) {
        // Expired — delete synchronously before re-processing so the subsequent INSERT
        // does not hit a stale UNIQUE row (waitUntil would leave the row visible to the INSERT).
        try {
          await c.env.DB.prepare(`DELETE FROM op_idempotency_keys WHERE id = ?`).bind(existing.id).run();
        } catch {
          // ignore delete failure; ON CONFLICT handling will cover it
        }
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
    // Do NOT cache 4xx (client errors) — validation, auth, conflict etc. should be retryable
    // with corrected payloads. Only cache 2xx/3xx.
    if (response && response.status >= 200 && response.status < 400) {
      const responseStatus = response.status;
      let responseText = '';
      try {
        responseText = await response.clone().text();
      } catch {
        responseText = '';
      }

      // Store (fire-and-forget) with concurrent-uniqueness safety.
      // ON CONFLICT DO NOTHING prevents a second concurrent request with the same
      // (merchant_id, key) from throwing a D1 UNIQUE constraint error (which would
      // surface as 500). The winner's row remains; the loser is ignored.
      const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
      const createdAt = new Date().toISOString();
      c.executionCtx.waitUntil(
        (async () => {
          try {
            await c.env.DB.prepare(
              `INSERT INTO op_idempotency_keys (merchant_id, key, request_body_hash, response_status, response_body, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(merchant_id, key) DO NOTHING`,
            )
              .bind(merchantId, idempotencyKey, bodyHash, responseStatus, responseText, expiresAt, createdAt)
              .run();
          } catch {
            // Swallow D1 unique violation / transient errors — idempotency is best-effort
          }
        })(),
      );
    }
  };
}

// Default export for backward compatibility (optional key)
export const idempotencyMiddleware = createIdempotencyMiddleware();
