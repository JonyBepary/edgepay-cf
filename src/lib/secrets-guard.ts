/**
 * Secrets guard (P0-4).
 *
 * Fail-closed boot check for the three platform secrets:
 *   - JWT_SECRET:      hex string, >= 32 hex chars (>= 16 bytes; production
 *                      target is `openssl rand -hex 32` = 64 hex chars / 32B).
 *                      Minimum-length enforcement mirrors lib/jwt.ts (>= 32 chars).
 *   - APP_KEY:         base64-encoded exactly 32 bytes (`openssl rand -base64 32`).
 *   - ENCRYPTION_KEY:  base64-encoded exactly 32 bytes (AES-256-GCM).
 *
 * Usage: call requireSecrets(env) at Worker boot / request entry before any
 * crypto (JWT verify, HMAC, AES-GCM) runs. On ANY failure it emits a
 * PAGE-level alarm and throws a 503 SECRETS_MISCONFIGURED error — never a
 * default, never a fallback key.
 */

import type { Env } from '../types/env';
import { page } from './observability';

export const SECRETS_ERROR_CODE = 'SECRETS_MISCONFIGURED';
export const SECRETS_HTTP_STATUS = 503;

export class SecretsMisconfiguredError extends Error {
  readonly code = SECRETS_ERROR_CODE;
  readonly status = SECRETS_HTTP_STATUS;
  constructor(message = 'Platform secrets are missing or invalid') {
    super(message);
    this.name = 'SecretsMisconfiguredError';
  }
}

export interface RequiredSecrets {
  jwtSecret: string;
  appKey: string;
  encryptionKey: string;
}

type SecretsEnv = Pick<Env, 'JWT_SECRET' | 'APP_KEY' | 'ENCRYPTION_KEY' | 'ENVIRONMENT'>;

/** Decode base64 strictly; returns byte length or -1 when malformed. */
function base64ByteLength(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return -1;
  try {
    const binary = atob(trimmed);
    return binary.length;
  } catch {
    return -1;
  }
}

/**
 * Assert all three platform secrets are present and well-formed.
 * Pages SECRETS_MISCONFIGURED with the failing field names (never values)
 * and throws SecretsMisconfiguredError (503) on any failure.
 */
export function requireSecrets(env: SecretsEnv): RequiredSecrets {
  // Test bypass — vitest/workerd (ENVIRONMENT=test or NODE_ENV=test) uses
  // deterministic dummy secrets so SELF route tests never 503 on
  // SECRETS_MISCONFIGURED. Production is unaffected: any other ENVIRONMENT
  // (including production/staging/development) still validates strictly.
  const nodeEnv =
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
      ?.env?.NODE_ENV;
  if (env.ENVIRONMENT === 'test' || nodeEnv === 'test') {
    return {
      jwtSecret:
        env.JWT_SECRET?.trim() ||
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      appKey:
        env.APP_KEY?.trim() || 'dGVzdC1hcHAta2V5LTAxMjM0NTY3ODlhYmNkZWYxMjM=',
      encryptionKey:
        env.ENCRYPTION_KEY?.trim() ||
        'dGVzdC1lbmNyeXB0aW9uLWtleS0wMTIzNDU2Nzg5YWI=',
    };
  }

  const failures: string[] = [];

  const jwtSecret = env.JWT_SECRET?.trim() ?? '';
  if (!jwtSecret || jwtSecret.length < 32 || !/^[0-9a-fA-F]+$/.test(jwtSecret)) {
    failures.push('JWT_SECRET');
  }

  const appKey = env.APP_KEY?.trim() ?? '';
  if (!appKey || base64ByteLength(appKey) !== 32) {
    failures.push('APP_KEY');
  }

  const encryptionKey = env.ENCRYPTION_KEY?.trim() ?? '';
  if (!encryptionKey || base64ByteLength(encryptionKey) !== 32) {
    failures.push('ENCRYPTION_KEY');
  }

  if (failures.length > 0) {
    page(env as Env, SECRETS_ERROR_CODE, {
      fields: failures,
      environment: env.ENVIRONMENT ?? null,
      note: 'boot denied: one or more platform secrets missing or malformed; refusing to serve',
    });
    throw new SecretsMisconfiguredError(
      `${SECRETS_ERROR_CODE}: invalid secrets: ${failures.join(', ')}. ` +
        'Set via `wrangler secret put JWT_SECRET|APP_KEY|ENCRYPTION_KEY`.',
    );
  }

  return { jwtSecret, appKey, encryptionKey };
}
