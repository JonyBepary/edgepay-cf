/**
 * EdgePay OpenAPI 3.1 document (v0.2.3).
 *
 * Single source of truth for the platform's public API surface, served as
 * JSON at /api/openapi.json and rendered by Scalar at /api/reference.
 *
 * Authoring rules:
 *   - Every path here MUST mirror a route in src/controllers/* — this file
 *     is hand-maintained (the routes predate zod-openapi; migrating them to
 *     @hono/zod-openapi codegen is possible future work, but the hand-written
 *     document stays authoritative for the wire contract).
 *   - Money is ALWAYS a decimal string ("100.50"), never a JS float — the
 *     same contract as src/lib/validation.ts (moneySchema).
 *   - Response envelope is ALWAYS { success, data? , error? } — the shape
 *     pinned by tests/api-middleware.test.ts and lib/error.ts.
 *   - buildOpenApiDocument(env) so `servers` and `info.version` reflect the
 *     actual deployment (APP_URL / APP_VERSION / APP_NAME vars).
 */

import type { Env } from './types/env';

export type OpenApiDocument = Record<string, unknown>;

/** Shared response-envelope JSON schemas. */
const envelopeSchemas = {
  SuccessEnvelope: {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', const: true },
      data: { type: 'object', additionalProperties: true },
    },
  },
  ErrorEnvelope: {
    type: 'object',
    required: ['success', 'error'],
    properties: {
      success: { type: 'boolean', const: false },
      error: { $ref: '#/components/schemas/Error' },
    },
  },
  Error: {
    type: 'object',
    required: ['code'],
    properties: {
      code: {
        type: 'string',
        description: 'Machine-readable error code (e.g. VALIDATION_ERROR, NOT_FOUND, GATEWAY_DISABLED, RATE_LIMIT_EXCEEDED).',
        examples: ['VALIDATION_ERROR'],
      },
      message: { type: 'string', description: 'Human-readable explanation.' },
      details: {
        description: 'Structured details (e.g. zod issue list for VALIDATION_ERROR).',
      },
    },
  },
  Money: {
    type: 'string',
    description: 'Decimal amount string with 0-2 fraction digits. The API never accepts or returns floating-point money.',
    pattern: '^\\d+(\\.\\d{1,2})?$',
    examples: ['100.50', '2500', '0.99'],
  },
  Currency: {
    type: 'string',
    description: 'ISO 4217 alphabetic currency code (case-insensitive on input, upper-cased by the API).',
    pattern: '^[A-Za-z]{3}$',
    examples: ['BDT', 'USD'],
  },
  Transaction: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      trx_id: { type: 'string', description: 'Public transaction reference (prefixed edgepay_trx_…).' },
      payment_intent_id: { type: 'integer', nullable: true },
      gateway_trx_id: { type: 'string', nullable: true, description: 'Gateway-side transaction reference.' },
      amount: { $ref: '#/components/schemas/Money' },
      currency: { $ref: '#/components/schemas/Currency' },
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'refunded', 'partially_refunded', 'expired'],
      },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
  },
  CreatePaymentRequest: {
    type: 'object',
    required: ['amount', 'currency'],
    properties: {
      amount: { $ref: '#/components/schemas/Money' },
      currency: { $ref: '#/components/schemas/Currency' },
      description: { type: 'string', maxLength: 1000 },
      gateway_id: {
        type: 'integer',
        minimum: 1,
        description: 'Numeric id of the merchant-installed gateway to charge with (e.g. 2 for bKash Personal, 3 for Nagad). Optional; checkout page lets customer pick when omitted.',
      },
      gateway: {
        type: 'string',
        description: 'Gateway slug (e.g. "bkash", "nagad", "rocket", "sslcommerz", "stripe"). Alternative to numeric gateway_id.',
        example: 'bkash',
      },
      gateway_slug: {
        type: 'string',
        description: 'Alias for gateway slug.',
        example: 'bkash',
      },
      customer: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 200 },
          email: { type: 'string', format: 'email' },
          phone: { type: 'string', maxLength: 30 },
        },
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'Free-form metadata preserved through the payment lifecycle and echoed in outbound webhooks.',
      },
      expires_in_seconds: {
        type: 'integer',
        minimum: 60,
        maximum: 86400,
        description: 'Intent expiry window (default 3600).',
      },
    },
  },
  CreateRefundRequest: {
    type: 'object',
    required: ['transaction_id'],
    properties: {
      transaction_id: {
        type: 'string',
        maxLength: 64,
        description: 'The trx_id of a COMPLETED transaction to refund.',
      },
      amount: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description: 'Partial-refund amount. Omit to refund the full remaining amount.',
      },
      reason: { type: 'string', maxLength: 500 },
    },
  },
  GatewayInfo: {
    type: 'object',
    properties: {
      slug: { type: 'string', examples: ['bkash-api'] },
      name: { type: 'string', examples: ['bKash (Merchant API)'] },
      version: { type: 'string' },
      description: { type: 'string' },
      supported_currencies: { type: 'array', items: { type: 'string' } },
      capabilities: {
        type: 'array',
        items: { type: 'string', enum: ['refund', 'webhook', 'subscription'] },
      },
      config_fields: {
        type: 'array',
        description: 'Credential field definitions for the admin config form — names/labels/types only, never values.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            type: { type: 'string', enum: ['text', 'password', 'select', 'checkbox', 'textarea'] },
            required: { type: 'boolean' },
          },
        },
      },
    },
  },
} as const;

/** Common JSON error responses by status. */
function errorResponses(...statuses: number[]): Record<string, unknown> {
  const descriptions: Record<number, string> = {
    400: 'Validation error (VALIDATION_ERROR) or malformed request.',
    401: 'Missing/invalid credentials (UNAUTHORIZED / SIGNATURE_INVALID).',
    403: 'Authenticated but not allowed (FORBIDDEN / IP_NOT_ALLOWED / GEO_BLOCKED).',
    404: 'Resource not found (NOT_FOUND / UNKNOWN_GATEWAY).',
    409: 'Conflicting state (CONFLICT / ALREADY_INSTALLED).',
    410: 'Expired (OTP_EXPIRED).',
    422: 'Semantically rejected (GATEWAY_DISABLED / REFUND_REJECTED).',
    429: 'Rate limit exceeded (RATE_LIMIT_EXCEEDED).',
    502: 'Upstream gateway failure (GATEWAY_ERROR / REFUND_FAILED).',
    503: 'Dependency misconfigured or unavailable (SERVICE_UNAVAILABLE).',
  };
  const out: Record<string, unknown> = {};
  for (const status of statuses) {
    out[String(status)] = {
      description: descriptions[status] ?? 'Error.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
  }
  return out;
}

const MERCHANT_RATE_LIMIT_NOTE =
  'Rate limits (per API key, via native Ratelimit bindings): 120 reads/min, 30 writes/min. Absence of the binding degrades to allow+metric, never fail-open silently.';

export function buildOpenApiDocument(env: Pick<Env, 'APP_URL' | 'APP_VERSION' | 'APP_NAME'>): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: `${env.APP_NAME || 'EdgePay'} API`,
      version: env.APP_VERSION || '0.0.0',
      summary: 'Self-hosted payment ledger for BD/AF mobile-payment merchants on Cloudflare Workers.',
      description: [
        'EdgePay is a multi-brand payment platform: unified payment intents across card and mobile-financial-service gateways, a GAAP double-entry ledger serialized through one Durable Object per merchant, and signed outbound webhooks.',
        '',
        '**Authentication**',
        '- Merchant API (`/api/v1/*`): `Authorization: Bearer op_live_…` API keys with `read` / `write` / `admin` scopes.',
        '- Mobile companion (`/api/mobile/v1/*`): `Authorization: Bearer <JWT>` (HS256, aud `mobile`) issued after OTP device pairing.',
        '- Admin API (`/api/admin/v1/*`): sits behind Cloudflare Access (JWT verified fail-closed against the team JWKS) AND requires an admin-scope API key. A break-glass service token exists for emergencies and pages on every use.',
        '',
        `**Conventions** — every JSON response uses the envelope \`{ success, data? , error? }\`. Money is always a decimal string. ${MERCHANT_RATE_LIMIT_NOTE}`,
        '',
        '**Interactive reference** — this document is rendered by [Scalar](https://scalar.com) at `/api/reference`.',
      ].join('\n'),
      license: { name: 'MIT' },
    },
    servers: [{ url: env.APP_URL || 'https://example.workers.dev', description: 'This deployment (APP_URL)' }],
    tags: [
      { name: 'Health', description: 'Liveness and configuration probes.' },
      { name: 'Merchant API', description: 'Server-to-server payment orchestration (Bearer API key).' },
      { name: 'Mobile Companion', description: 'Flutter companion app: pairing, dashboard, SMS forwarding (JWT).' },
      { name: 'Admin API', description: 'Operator surface behind Cloudflare Access (admin-scope API key).' },
      { name: 'Inbound Webhooks', description: 'Gateway → EdgePay asynchronous payment events.' },
      { name: 'Checkout', description: 'Browser-facing hosted checkout (HTML).' },
      { name: 'Setup', description: 'First-run installation wizard.' },
      { name: 'Documentation', description: 'This OpenAPI document and its Scalar rendering.' },
    ],
    security: [{ ApiKeyAuth: [] }],

    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'op_live_<prefix>_<secret>',
          description: 'Merchant API key created via POST /api/v1/api-keys (shown once). Scopes: read, write, admin.',
        },
        MobileJwt: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Mobile companion access token (HS256, issuer edgepay-cf, audience mobile). Obtain via OTP pairing; refresh via /api/mobile/v1/devices/token-refreshes.',
        },
        AccessJwt: {
          type: 'apiKey',
          in: 'header',
          name: 'Cf-Access-Jwt-Assertion',
          description: 'Cloudflare Access JWT for /api/admin/v1/*. Verified against the team JWKS, fail-closed (missing team/AUD config ⇒ 503, never open). Alternative: break-glass service token credentials.',
        },
      },
      schemas: envelopeSchemas,
      parameters: {
        IdempotencyKey: {
          name: 'X-Idempotency-Key',
          in: 'header',
          required: false,
          schema: { type: 'string', maxLength: 128 },
          description: 'Client-generated key; replays with the same key return the original result instead of double-charging.',
        },
        LimitParam: {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', default: 20 },
          description: 'Maximum rows to return (per-route caps apply).',
        },
      },
    },

    paths: {
      // -----------------------------------------------------------------
      // Health
      // -----------------------------------------------------------------
      '/api/v1/health': {
        get: {
          tags: ['Health'],
          summary: 'Liveness probe',
          description: 'Unauthenticated. Reports version, environment, and which optional bindings (Workers AI) are present. Does not touch D1.',
          security: [],
          responses: {
            200: {
              description: 'Worker is alive.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          status: { type: 'string', const: 'ok' },
                          version: { type: 'string' },
                          environment: { type: 'string', enum: ['development', 'staging', 'production'] },
                          timestamp: { type: 'string', format: 'date-time' },
                          durable_objects: { type: 'boolean' },
                          workflows: { type: 'boolean' },
                          workers_ai: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // -----------------------------------------------------------------
      // Merchant API
      // -----------------------------------------------------------------
      '/api/v1/gateways': {
        get: {
          tags: ['Merchant API'],
          summary: 'Gateway-plugin catalog for this deployment',
          description:
            'Reflects the ENABLED_GATEWAYS platform gate: which gateway adapters this deployment may use (with credential field definitions — names only, never values), which ENABLED_GATEWAYS tokens were dropped as unrecognized (typo feedback), and how many adapters remain in the port backlog. Per-merchant gateway installs and credentials live in D1 (AES-256-GCM) and are configured in the admin UI.',
          responses: {
            200: {
              description: 'Enabled gateway catalog.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          enabled: { type: 'array', items: { $ref: '#/components/schemas/GatewayInfo' } },
                          all_enabled: {
                            type: 'boolean',
                            description: 'True when ENABLED_GATEWAYS is unset/blank/all — every adapter available.',
                          },
                          dropped_aliases: { type: 'array', items: { type: 'string' } },
                          pending_count: {
                            type: 'integer',
                            description: 'Adapters in the catalog that are not yet ported (see docs/GATEWAYS.md).',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/v1/payments': {
        post: {
          tags: ['Merchant API'],
          summary: 'Create a payment intent',
          description:
            'Creates a payment intent + pending transaction and returns the hosted checkout URL. The gateway itself is chosen at execute time (explicit gateway_id here, or by the customer on the checkout page). Gateway must be enabled on this deployment (ENABLED_GATEWAYS) or execution returns 422 GATEWAY_DISABLED.',
          parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreatePaymentRequest' } },
            },
          },
          responses: {
            201: {
              description: 'Intent created.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          intent_id: { type: 'integer' },
                          token: { type: 'string', description: 'Checkout token — the secret URL element.' },
                          checkout_url: {
                            type: 'string',
                            description: 'Hosted checkout URL; redirect the customer here.',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 422, 429),
          },
        },
      },

      '/api/v1/payments/{payment_id}': {
        get: {
          tags: ['Merchant API'],
          summary: 'Fetch a payment intent',
          parameters: [
            {
              name: 'payment_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: {
            200: {
              description: 'Intent + transaction state.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          id: { type: 'integer' },
                          amount: { $ref: '#/components/schemas/Money' },
                          currency: { $ref: '#/components/schemas/Currency' },
                          status: { type: 'string' },
                          expires_at: { type: 'string', format: 'date-time' },
                          transaction: { $ref: '#/components/schemas/Transaction' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 404, 429),
          },
        },
      },

      '/api/v1/transactions': {
        get: {
          tags: ['Merchant API'],
          summary: 'List transactions',
          parameters: [{ $ref: '#/components/parameters/LimitParam' }],
          responses: {
            200: {
              description: 'Most recent transactions (cap 100).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/v1/transactions/{trx_id}': {
        get: {
          tags: ['Merchant API'],
          summary: 'Fetch a transaction by reference',
          parameters: [
            { name: 'trx_id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Transaction detail (includes ledger posting state).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { $ref: '#/components/schemas/Transaction' },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 404, 429),
          },
        },
      },

      '/api/v1/refunds': {
        post: {
          tags: ['Merchant API'],
          summary: 'Refund a completed transaction',
          description:
            'Synchronous refund path: verifies the transaction is completed, the gateway is enabled on this deployment, then calls the gateway refund API and records the refund. For gateway-refunds that need polling, the admin API path (POST /api/admin/v1/refunds) drives the per-refund reconciliation workflow instead.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/CreateRefundRequest' } },
            },
          },
          responses: {
            201: {
              description: 'Refund recorded as completed.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          refund_id: { type: 'string' },
                          gateway_refund_id: { type: 'string', nullable: true },
                          amount: { $ref: '#/components/schemas/Money' },
                          currency: { $ref: '#/components/schemas/Currency' },
                          status: { type: 'string', enum: ['completed'] },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 404, 422, 429, 502),
          },
        },
      },

      '/api/v1/customers': {
        get: {
          tags: ['Merchant API'],
          summary: 'List customers',
          parameters: [{ $ref: '#/components/parameters/LimitParam' }],
          responses: {
            200: {
              description: 'Recently created customers (cap 100).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            uuid: { type: 'string' },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/v1/api-keys': {
        get: {
          tags: ['Merchant API'],
          summary: 'List API keys (admin scope)',
          description: 'Key hashes are never returned — only prefixes, scopes and rotation metadata.',
          responses: {
            200: {
              description: 'API keys for the merchant.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            name: { type: 'string' },
                            key_prefix: { type: 'string' },
                            scopes: { type: 'array', items: { type: 'string', enum: ['read', 'write', 'admin'] } },
                            status: { type: 'string', enum: ['active', 'revoked'] },
                            last_used_at: { type: 'string', format: 'date-time', nullable: true },
                            expires_at: { type: 'string', format: 'date-time', nullable: true },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 403, 429),
          },
        },
        post: {
          tags: ['Merchant API'],
          summary: 'Create an API key (admin scope)',
          description: 'Returns the full key exactly once — store it immediately; only a SHA-256 hash is persisted.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' },
                    scopes: {
                      type: 'array',
                      items: { type: 'string', enum: ['read', 'write', 'admin'] },
                      default: ['read', 'write'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Key created — the secret is shown only in this response.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          api_key: { type: 'string', examples: ['op_live_a1b2c3d4e5f6_…'] },
                          key_prefix: { type: 'string' },
                          scopes: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },

      '/api/v1/webhooks/tests': {
        post: {
          tags: ['Merchant API'],
          summary: 'Send a test webhook',
          description: 'Enqueues a webhook.test event to the merchant\u2019s registered endpoint so integrators can verify HMAC signature validation before going live.',
          responses: {
            200: {
              description: 'Test event queued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      error: { nullable: true },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/v1/webhooks/deliveries': {
        get: {
          tags: ['Merchant API'],
          summary: 'Recent webhook deliveries',
          parameters: [{ $ref: '#/components/parameters/LimitParam' }],
          responses: {
            200: {
              description: 'Delivery log (inbound + outbound), newest first (cap 200).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            event: { type: 'string' },
                            url: { type: 'string' },
                            direction: { type: 'string', enum: ['inbound', 'outbound'] },
                            status_code: { type: 'integer', nullable: true },
                            response_time_ms: { type: 'integer', nullable: true },
                            attempt: { type: 'integer' },
                            status: { type: 'string', enum: ['pending', 'delivered', 'failed'] },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },
      // -----------------------------------------------------------------
      // Mobile Companion API
      // -----------------------------------------------------------------
      '/api/mobile/v1/devices': {
        post: {
          tags: ['Mobile Companion'],
          summary: 'Pair a device with a 6-digit OTP',
          description:
            'No auth — the OTP (printed by the admin dashboard) IS the credential. Marks the OTP used, registers the device, and returns access + refresh JWTs (aud mobile).',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['otp'],
                  properties: {
                    otp: { type: 'string', pattern: '^\\d{6}$' },
                    device_name: { type: 'string', default: 'Unknown device' },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: 'Device paired; tokens issued.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          device_id: { type: 'string', format: 'uuid' },
                          access_token: { type: 'string' },
                          refresh_token: { type: 'string' },
                          token_type: { type: 'string', const: 'Bearer' },
                          expires_in: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 404, 410, 429),
          },
        },
      },

      '/api/mobile/v1/devices/token-refreshes': {
        post: {
          tags: ['Mobile Companion'],
          summary: 'Exchange a refresh token for a new access token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refresh_token'],
                  properties: { refresh_token: { type: 'string' } },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'New access token.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          access_token: { type: 'string' },
                          token_type: { type: 'string', const: 'Bearer' },
                          expires_in: { type: 'integer' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 429),
          },
        },
      },

      '/api/mobile/v1/devices/heartbeats': {
        post: {
          tags: ['Mobile Companion'],
          summary: 'Device heartbeat',
          description: 'Refreshes last_heartbeat_at so the admin dashboard can flag stale devices.',
          security: [{ MobileJwt: [] }],
          responses: {
            200: {
              description: 'Heartbeat recorded.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { success: { type: 'boolean' }, data: { type: 'object', properties: { status: { type: 'string' } } } },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/mobile/v1/dashboard': {
        get: {
          tags: ['Mobile Companion'],
          summary: 'Today-at-a-glance summary',
          security: [{ MobileJwt: [] }],
          responses: {
            200: {
              description: 'Today\u2019s counts/revenue plus the 5 most recent transactions.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          today: {
                            type: 'object',
                            properties: {
                              today_count: { type: 'integer' },
                              today_revenue: { type: 'string' },
                              pending_count: { type: 'integer' },
                            },
                          },
                          recent_transactions: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/mobile/v1/sms': {
        post: {
          tags: ['Mobile Companion'],
          summary: 'Forward an SMS to the parse queue',
          description:
            'The companion app forwards MFS confirmation SMS (bKash/Nagad/Rocket…). Parsing is async (queue): regex templates first, Workers AI fallback for the long tail. Deduplicated by content hash.',
          security: [{ MobileJwt: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['sender', 'body'],
                  properties: {
                    sender: { type: 'string', description: 'Sender number/alpha tag, e.g. "bKash".' },
                    body: { type: 'string', description: 'Full SMS body.' },
                    received_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Accepted for async parsing.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object', properties: { status: { type: 'string', const: 'queued' } } },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 429),
          },
        },
      },

      '/api/mobile/v1/notifications': {
        get: {
          tags: ['Mobile Companion'],
          summary: 'Device notifications',
          security: [{ MobileJwt: [] }],
          responses: {
            200: {
              description: 'Latest 50 notifications for this device.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            event: { type: 'string' },
                            payload: { type: 'object', additionalProperties: true },
                            read_at: { type: 'string', format: 'date-time', nullable: true },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 429),
          },
        },
      },

      '/api/mobile/v1/notifications/acknowledgements': {
        post: {
          tags: ['Mobile Companion'],
          summary: 'Mark notifications read',
          security: [{ MobileJwt: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['notification_ids'],
                  properties: {
                    notification_ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Count of acknowledged notifications.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: { type: 'object', properties: { acknowledged: { type: 'integer' } } },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 429),
          },
        },
      },

      // -----------------------------------------------------------------
      // Admin API — behind Cloudflare Access AND admin-scope API key
      // -----------------------------------------------------------------
      '/api/admin/v1/domains/verifications': {
        post: {
          tags: ['Admin API'],
          summary: 'Re-verify a custom domain\u2019s DNS TXT record',
          description:
            'Checks _edgepay-verification.<domain> TXT via Cloudflare DNS-over-HTTPS and activates the domain when the token matches. (Per-brand custom hostnames via Cloudflare for SaaS are provisioned separately — see services/custom-hostnames.ts.)',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['domain'], properties: { domain: { type: 'string' } } },
              },
            },
          },
          responses: {
            200: {
              description: 'Verification result.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          verified: { type: 'boolean' },
                          expected_token: { type: 'string' },
                          lookup: { type: 'string', description: 'The TXT record name queried.' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
      },

      '/api/admin/v1/sms-templates': {
        get: {
          tags: ['Admin API'],
          summary: 'List SMS parse templates',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          responses: {
            200: {
              description: 'Regex templates tried (in order) against forwarded SMS.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            gateway_slug: { type: 'string' },
                            name: { type: 'string' },
                            regex_pattern: { type: 'string' },
                            sample_sms: { type: 'string', nullable: true },
                            status: { type: 'string', enum: ['active', 'disabled'] },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 403, 429),
          },
        },
      },

      '/api/admin/v1/sms-templates/{id}': {
        put: {
          tags: ['Admin API'],
          summary: 'Update an SMS template',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    regex_pattern: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'disabled'], default: 'active' },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },

      '/api/admin/v1/devices': {
        get: {
          tags: ['Admin API'],
          summary: 'List paired companion devices',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          responses: {
            200: {
              description: 'Paired devices with heartbeat state.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            uuid: { type: 'string', format: 'uuid' },
                            device_name: { type: 'string' },
                            status: { type: 'string', enum: ['active', 'revoked'] },
                            last_heartbeat_at: { type: 'string', format: 'date-time', nullable: true },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 403, 429),
          },
        },
      },

      '/api/admin/v1/devices/{id}': {
        delete: {
          tags: ['Admin API'],
          summary: 'Revoke a paired device',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            200: { description: 'Deleted.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
            ...errorResponses(401, 403, 429),
          },
        },
      },

      '/api/admin/v1/sms-queues': {
        get: {
          tags: ['Admin API'],
          summary: 'Recent forwarded SMS + parse status',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          responses: {
            200: {
              description: 'Last 100 SMS rows (newest first).',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            sender: { type: 'string' },
                            body: { type: 'string' },
                            match_status: { type: 'string', description: 'matched | unmatched | manual_review' },
                            created_at: { type: 'string', format: 'date-time' },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(401, 403, 429),
          },
        },
      },

      '/api/admin/v1/sms-queues/{id}/retries': {
        post: {
          tags: ['Admin API'],
          summary: 'Re-enqueue an SMS for parsing',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: {
            200: { description: 'Re-queued.', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' } } } } } },
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },

      '/api/admin/v1/refunds': {
        post: {
          tags: ['Admin API'],
          summary: 'Create a workflow-driven refund',
          description:
            'Writes the refund row, calls the gateway when supported, and creates a per-refund reconciliation workflow instance (refund-{id}) that polls the gateway to terminal state and posts the idempotent ledger reversal. This is the recommended refund path for gateways with async settlement.',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['transaction_id', 'amount'],
                  properties: {
                    transaction_id: { type: 'integer', description: 'Numeric transaction id (not trx_id).' },
                    amount: { $ref: '#/components/schemas/Money' },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            202: {
              description: 'Refund accepted; workflow instance created and now reconciling.',
              content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } } },
            },
            ...errorResponses(400, 401, 403, 404, 422, 429),
          },
        },
      },

      '/api/admin/v1/reconcile': {
        post: {
          tags: ['Admin API'],
          summary: 'Trigger the reconciliation battery manually',
          description: 'Runs the same battery as the daily 02:00 sweep: pending posting replay + DO/D1 consistency verification + stuck-refund re-drive.',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          responses: {
            200: {
              description: 'Reconciliation summary.',
              content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } } },
            },
            ...errorResponses(401, 403, 429),
          },
        },
      },

      '/api/admin/v1/ledger/trial-balance': {
        get: {
          tags: ['Admin API'],
          summary: 'Trial balance + ledger consistency report',
          description:
            'Per-merchant account balances from the double-entry ledger plus the Durable-Object/D1 consistency verdict. See docs/POSTING-PROTOCOL.md for the normative posting rules.',
          security: [{ ApiKeyAuth: [], AccessJwt: [] }],
          responses: {
            200: {
              description: 'Trial balance and consistency check.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          trial_balance: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                account_code: { type: 'string' },
                                account_name: { type: 'string' },
                                debit: { type: 'string' },
                                credit: { type: 'string' },
                                balance: { type: 'string' },
                              },
                            },
                          },
                          consistency: { type: 'object', additionalProperties: true },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },

      // -----------------------------------------------------------------
      // Inbound webhooks (gateway → EdgePay)
      // -----------------------------------------------------------------
      '/webhook/{gateway}': {
        post: {
          tags: ['Inbound Webhooks'],
          summary: 'Receive an asynchronous gateway event',
          description: [
            'Three defense layers, in order:',
            '1. **IP allowlist** (data-driven per gateway, op_gateway_ips) — when configured, requests outside the CIDRs are rejected before signature work.',
            '2. **Geo fallback** — only when no allowlist exists: request country must be BD/AF/SG/US.',
            '3. **Signature verification** (adapter-specific HMAC/RSA over the raw body) — ALWAYS required.',
            '',
            'Events are deduplicated per (merchant, gateway, event_id); payment-completion events complete the matching transaction and post the idempotent ledger entry. Gateways disabled via ENABLED_GATEWAYS return 404 UNKNOWN_GATEWAY (indistinguishable from unregistered).',
          ].join('\n'),
          security: [],
          parameters: [
            {
              name: 'gateway',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: ['stripe', 'paypal', 'bkash-api', 'razorpay', 'nagad-merchant-api'] },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
                description: 'Gateway-specific payload. The trx_id correlation key is embedded by each adapter during initiate().',
              },
            },
          },
          responses: {
            200: {
              description: 'Processed or duplicate.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          status: { type: 'string', enum: ['processed', 'duplicate'] },
                          event_id: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 403, 404),
          },
        },
      },

      // -----------------------------------------------------------------
      // Checkout (browser-facing HTML)
      // -----------------------------------------------------------------
      '/checkout/{token}': {
        get: {
          tags: ['Checkout'],
          summary: 'Render the hosted checkout page',
          description: 'Browser-facing HTML (also mounted at /invoice/{token} and /pay/{slug}). No JSON. CSRF-protected form.',
          security: [],
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Checkout HTML page.', content: { 'text/html': { schema: { type: 'string' } } } },
            404: { description: 'Unknown/expired token.', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/checkout/{token}/initiate': {
        post: {
          tags: ['Checkout'],
          summary: 'Execute the payment at the gateway',
          description: 'Called by the checkout form. Resolves the gateway adapter (must be enabled on this deployment), calls initiate(), and returns the redirect target. CSRF token required.',
          security: [],
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Redirect URL / inline form for the gateway.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
            ...errorResponses(400, 404, 422),
          },
        },
      },
      '/checkout/{token}/callback': {
        get: {
          tags: ['Checkout'],
          summary: 'Synchronous gateway callback',
          description: 'The customer\u2019s browser lands here after paying; the adapter verifies the callback and the transaction completes (ledger posting + outbound webhook).',
          security: [],
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'Result page (HTML).', content: { 'text/html': { schema: { type: 'string' } } } },
            404: { description: 'Unknown token.', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/checkout/{token}/status': {
        get: {
          tags: ['Checkout'],
          summary: 'Poll the payment status',
          security: [],
          parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Current intent/transaction status.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: { status: { type: 'string' }, paid: { type: 'boolean' } },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(404),
          },
        },
      },

      // -----------------------------------------------------------------
      // Setup
      // -----------------------------------------------------------------
      '/install': {
        get: {
          tags: ['Setup'],
          summary: 'Pre-install requirements check',
          description:
            'Anonymous, and only meaningful before installation (302 to / afterwards). Reports binding presence, secret POSTURE (length-class only: ok/weak/missing — never content), and the gateway-plugin selection (ENABLED_GATEWAYS) including typo feedback for dropped aliases.',
          security: [],
          responses: {
            200: {
              description: 'Requirements, secret posture and enabled gateways.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          requirements: {
                            type: 'object',
                            properties: {
                              workers_runtime: { type: 'string' },
                              d1_database: { type: 'string', enum: ['ok', 'missing'] },
                              kv_namespace: { type: 'string', enum: ['ok', 'missing'] },
                              r2_bucket: { type: 'string', enum: ['ok', 'missing'] },
                              webhook_queue: { type: 'string', enum: ['ok', 'missing'] },
                            },
                          },
                          secrets: {
                            type: 'object',
                            description: 'ok | weak | missing — length class only.',
                            properties: {
                              jwt_secret: { type: 'string', enum: ['ok', 'weak', 'missing'] },
                              app_key: { type: 'string', enum: ['ok', 'weak', 'missing'] },
                              encryption_key: { type: 'string', enum: ['ok', 'weak', 'missing'] },
                            },
                          },
                          gateways: {
                            type: 'object',
                            properties: {
                              enabled: { type: 'array', items: { type: 'string' } },
                              dropped_aliases: { type: 'array', items: { type: 'string' } },
                              all_enabled: { type: 'boolean' },
                            },
                          },
                          version: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['Setup'],
          summary: 'Run the installation wizard',
          description:
            'Creates the platform merchant, the super-admin (PBKDF2 — see PBKDF2_ITERATIONS for the free-tier CPU note), and the default chart of accounts, then sets the KV install lock. Rate limited to 3/hour per IP.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['merchant_name', 'admin_email', 'admin_password'],
                  properties: {
                    merchant_name: { type: 'string' },
                    merchant_email: { type: 'string', format: 'email' },
                    admin_name: { type: 'string' },
                    admin_email: { type: 'string', format: 'email' },
                    admin_password: { type: 'string', minLength: 12 },
                    timezone: { type: 'string', default: 'UTC' },
                    currency: { type: 'string', default: 'BDT' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Installation completed; next steps returned.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          merchant_id: { type: 'integer' },
                          admin_uuid: { type: 'string', format: 'uuid' },
                          install_completed: { type: 'boolean' },
                          next_steps: { type: 'array', items: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 409, 429),
          },
        },
      },

      '/install/bootstrap-key': {
        post: {
          tags: ['Setup'],
          summary: 'Bootstrap or recover an admin API key',
          description:
            'Generates a new active admin Bearer API key using merchant super-admin email and password. Use when an existing deployment needs an API key or recovery without database access.',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['admin_email', 'admin_password'],
                  properties: {
                    admin_email: { type: 'string', format: 'email' },
                    admin_password: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'New API key generated.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      data: {
                        type: 'object',
                        properties: {
                          merchant_id: { type: 'integer' },
                          api_key: { type: 'string' },
                          message: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            ...errorResponses(400, 401, 429),
          },
        },
      },

      // -----------------------------------------------------------------
      // Documentation
      // -----------------------------------------------------------------
      '/api/reference': {
        get: {
          tags: ['Documentation'],
          summary: 'Interactive API reference (Scalar)',
          description:
            'Renders this OpenAPI document with Scalar. The page ships a tailored CSP (pinned CDN script + per-request nonce; no unsafe-inline scripts).',
          security: [],
          responses: {
            200: { description: 'Scalar reference HTML page.', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/api/openapi.json': {
        get: {
          tags: ['Documentation'],
          summary: 'This OpenAPI document',
          security: [],
          responses: {
            200: {
              description: 'OpenAPI 3.1 JSON.',
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
            },
          },
        },
      },
    },

    // -----------------------------------------------------------------
    // Outbound webhook events (OpenAPI 3.1 top-level `webhooks`)
    // -----------------------------------------------------------------
    webhooks: {
      'payment.completed': {
        post: {
          tags: ['Inbound Webhooks'],
          summary: 'payment.completed — outbound to the merchant\u2019s endpoint',
          description: [
            'Delivered via the webhook-out queue (3 attempts, exponential backoff, DLQ after final failure).',
            '',
            '**Signature** — HMAC-SHA256 over the exact JSON body bytes using the merchant webhook secret:',
            '- `X-EdgePay-Signature: <hex hmac>`',
            '- `X-EdgePay-Timestamp: <unix ms>`',
            '',
            'Verify with a constant-time comparison over the raw body. Envelope: `{ event, data, timestamp, signature? }`.',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    event: { type: 'string', const: 'payment.completed' },
                    timestamp: { type: 'string', format: 'date-time' },
                    data: {
                      type: 'object',
                      properties: {
                        trx_id: { type: 'string' },
                        amount: { $ref: '#/components/schemas/Money' },
                        currency: { $ref: '#/components/schemas/Currency' },
                        gateway_trx_id: { type: 'string', nullable: true },
                        customer: { type: 'object', additionalProperties: true },
                        metadata: { type: 'object', additionalProperties: true },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Acknowledged (any 2xx stops retries).' },
            default: { description: 'Non-2xx after 3 attempts moves the delivery to the DLQ with alerting.' },
          },
        },
      },
      'refund.completed': {
        post: {
          tags: ['Inbound Webhooks'],
          summary: 'refund.completed — outbound to the merchant\u2019s endpoint',
          description: 'Fired by the per-refund reconciliation workflow when the refund reaches terminal state and the ledger reversal posts. Same HMAC signing scheme as payment.completed.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    event: { type: 'string', const: 'refund.completed' },
                    timestamp: { type: 'string', format: 'date-time' },
                    data: {
                      type: 'object',
                      properties: {
                        refund_id: { type: 'string' },
                        transaction_id: { type: 'string' },
                        amount: { $ref: '#/components/schemas/Money' },
                        currency: { $ref: '#/components/schemas/Currency' },
                        status: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Acknowledged.' },
            default: { description: 'Retried with backoff; DLQ after final failure.' },
          },
        },
      },
      'webhook.test': {
        post: {
          tags: ['Inbound Webhooks'],
          summary: 'webhook.test — outbound test event',
          description: 'Triggered by POST /api/v1/webhooks/tests so integrators can verify their HMAC validation. Same signing scheme.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    event: { type: 'string', const: 'webhook.test' },
                    timestamp: { type: 'string', format: 'date-time' },
                    data: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: 'Acknowledged.' },
            default: { description: 'Retried with backoff.' },
          },
        },
      },
    },
  };
}
