/**
 * Error handling — custom error classes and HTTP error handlers.
 *
 * EdgePay's PHP original distinguishes:
 *   - ClientError (400): bad request payload
 *   - UnauthorizedError (401): missing/invalid auth
 *   - ForbiddenError (403): valid auth, insufficient scope
 *   - NotFoundError (404): resource not found
 *   - ConflictError (409): duplicate resource
 *   - RateLimitError (429): rate limit exceeded
 *   - ServerError (500): unexpected internal failure
 *   - ServiceUnavailable (503): maintenance / dependency outage
 */

import type { Context } from 'hono';
import type { Env } from '../types/env';

// ---------------------------------------------------------------
// Custom error classes — typed for clean error mapping
// ---------------------------------------------------------------
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = 'Forbidden') {
    super(403, message, 'FORBIDDEN');
  }
}

export class NotFoundError extends HttpError {
  constructor(resource: string = 'Resource') {
    super(404, `${resource} not found`, 'NOT_FOUND');
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class RateLimitError extends HttpError {
  constructor(public retryAfter: number, message = 'Rate limit exceeded') {
    super(429, message, 'RATE_LIMIT_EXCEEDED');
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message = 'Service temporarily unavailable') {
    super(503, message, 'SERVICE_UNAVAILABLE');
  }
}

export class GatewayError extends HttpError {
  constructor(message: string, public gatewayResponse?: unknown) {
    // Gateway payloads may carry credentials/PII — never place them in
    // `details` (which the error handler serializes to clients). The raw
    // payload is logged server-side only; clients get the safe message.
    super(502, message, 'GATEWAY_ERROR', undefined);
  }
}

/**
 * v0.2.3: the gateway exists as an adapter but is not enabled on this
 * deployment (ENABLED_GATEWAYS platform gate — see src/gateways/enabled.ts).
 * Thrown at NEW-operation entry points only, never on in-flight flows.
 */
export class GatewayDisabledError extends HttpError {
  constructor(slug: string) {
    super(
      422,
      `Gateway '${slug}' is not enabled on this deployment. Add it to the ENABLED_GATEWAYS environment variable (see docs/GATEWAYS.md).`,
      'GATEWAY_DISABLED',
    );
  }
}

// ---------------------------------------------------------------
// Hono error handler — converts errors to JSON responses
// ---------------------------------------------------------------
export async function errorHandler(err: Error, c: Context<{ Bindings: Env }>): Promise<Response> {
  // Log the error (structured). Gateway payloads are logged server-side
  // only — never serialized to the client in production.
  const requestId = c.get('requestId') ?? 'unknown';
  const env = c.env;
  const isProd = env.ENVIRONMENT === 'production';

  // Console.log in Workers goes to wrangler tail / Logpush
  console.error(JSON.stringify({
    level: err instanceof HttpError && err.status < 500 ? 'warn' : 'error',
    request_id: requestId,
    method: c.req.method,
    path: c.req.path,
    error: err.name,
    message: err.message,
    code: err instanceof HttpError ? err.code : 'INTERNAL_ERROR',
    details: err instanceof HttpError ? err.details : undefined,
    gateway_response: err instanceof GatewayError ? err.gatewayResponse : undefined,
    stack: env.ENVIRONMENT === 'development' ? err.stack : undefined,
    timestamp: new Date().toISOString(),
  }));

  // HttpError → JSON response
  if (err instanceof HttpError) {
    const body: Record<string, unknown> = {
      success: false,
      error: {
        code: err.code,
        message: err.message,
      },
      request_id: requestId,
    };

    if (err.details !== undefined) {
      // Gateway payloads stay server-side in production — clients only
      // ever see the safe message. Development may include details.
      if (err instanceof GatewayError && isProd) {
        // intentionally omitted
      } else {
        (body.error as { details?: unknown }).details = err.details;
      }
    }

    // Defense-in-depth: even if a GatewayError ever carries details,
    // never serialize the raw gateway response outside development.
    if (err instanceof GatewayError && !isProd && err.gatewayResponse !== undefined) {
      (body.error as { details?: unknown }).details = err.gatewayResponse;
    }

    const headers: Record<string, string> = {};

    if (err instanceof RateLimitError) {
      headers['Retry-After'] = String(err.retryAfter);
    }

    return c.json(body, err.status as 400, headers);
  }

  // Unknown error — never leak internals in production
  const message = env.ENVIRONMENT === 'development'
    ? err.message
    : 'An internal error occurred. Please try again.';

  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message,
      ...(env.ENVIRONMENT === 'development' && { stack: err.stack }),
    },
    request_id: requestId,
  }, 500);
}

// ---------------------------------------------------------------
// 404 handler — invoked by Hono when no route matches
// ---------------------------------------------------------------
export function notFoundHandler(c: Context<{ Bindings: Env }>): Response {
  const requestId = c.get('requestId') ?? 'unknown';

  // Browser-facing routes: return HTML 404
  const accept = c.req.header('Accept') ?? '';
  if (!accept.includes('application/json') && !c.req.path.startsWith('/api/')) {
    return c.html(
      `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404 — Not Found</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#0b1f3a;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{text-align:center;max-width:560px;padding:2rem}
h1{font-size:6rem;margin:0;color:#f38020}
p{font-size:1.1rem;color:#94a3b8}
a{color:#f38020;text-decoration:none}
</style>
</head>
<body>
<div class="box">
<h1>404</h1>
<p>The page you requested could not be found.</p>
<p><a href="/">Go home →</a></p>
</div>
</body>
</html>`,
      404,
      { 'X-Request-Id': requestId },
    );
  }

  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Not Found',
    },
    request_id: requestId,
  }, 404);
}
