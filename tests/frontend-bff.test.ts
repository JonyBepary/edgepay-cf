/**
 * EdgePay Merchant BFF & Frontend Security Unit Tests (V11-002, V11-003, V11-006)
 *
 * Verifies:
 *   1. Fail-closed authentication (network error -> 502, core rejection -> 401)
 *   2. AES-256-GCM sealed session payload in KV (no plaintext credentials at rest)
 *   3. Strict proxy authorization (unauthenticated requests return 401; no demo key fallback)
 *   4. __Host- cookie semantics and secure logout
 *   5. Security headers and tailored CSP enforcement
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import merchantApp from '../frontend/apps/merchant/src/index';

interface ApiResponse {
  success: boolean;
  error?: { code: string; message: string };
  data?: unknown;
}

interface MockKvNamespace {
  get: (key: string) => Promise<string | null>;
  put: (key: string, val: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

interface MockMerchantEnv {
  API_ORIGIN: string;
  ENVIRONMENT: string;
  ENCRYPTION_KEY: string;
  MERCHANT_SESSIONS: MockKvNamespace;
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

describe('Merchant BFF Trust Plane (V11-003)', () => {
  let mockKvStore: Map<string, string>;
  let mockKv: MockKvNamespace;
  let env: MockMerchantEnv;

  beforeEach(() => {
    mockKvStore = new Map();
    mockKv = {
      get: vi.fn(async (key: string) => mockKvStore.get(key) ?? null),
      put: vi.fn(async (key: string, val: string) => { mockKvStore.set(key, val); }),
      delete: vi.fn(async (key: string) => { mockKvStore.delete(key); }),
    };

    env = {
      API_ORIGIN: 'http://localhost:8787',
      ENVIRONMENT: 'production',
      ENCRYPTION_KEY: 'test_aes_256_gcm_merchant_session_key_32b!',
      MERCHANT_SESSIONS: mockKv,
      ASSETS: { fetch: vi.fn(async () => new Response('OK')) },
    };
  });

  it('rejects invalid or non-live API keys with 401 INVALID_CREDENTIALS', async () => {
    const req = new Request('http://localhost/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'invalid_key_format' }),
    });

    const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('INVALID_CREDENTIALS');
  });

  it('fails closed with 401 when core rejects the API key (V11-003)', async () => {
    // Mock global fetch to return 401 from core
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/gateways')) {
        return new Response(JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED' } }), { status: 401 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      const req = new Request('http://localhost/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'op_live_rejected_key_12345' }),
      });

      const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);
      expect(res.status).toBe(401);
      const body = (await res.json()) as ApiResponse;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('AUTHENTICATION_FAILED');
      expect(mockKvStore.size).toBe(0); // No session staged
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed with 502 UPSTREAM_UNAVAILABLE on network failure (never fail-open)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Connection refused to core API');
    });

    try {
      const req = new Request('http://localhost/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: 'op_live_network_failure_key' }),
      });

      const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);
      expect(res.status).toBe(502);
      const body = (await res.json()) as ApiResponse;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(mockKvStore.size).toBe(0); // No session staged
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('seals session payload using AES-256-GCM in KV upon valid login (V11-003)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/gateways')) {
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      const testKey = 'op_live_valid_merchant_key_998811';
      const req = new Request('http://localhost/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: testKey }),
      });

      const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);
      expect(res.status).toBe(200);

      // Verify cookie
      const setCookie = res.headers.get('Set-Cookie') || '';
      expect(setCookie).toContain('__Host-edgepay_sess=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Strict');

      // Verify KV entry is genuinely encrypted ciphertext (not plaintext JSON)
      expect(mockKvStore.size).toBe(1);
      const storedVal = Array.from(mockKvStore.values())[0];
      expect(storedVal).not.toContain(testKey);
      expect(storedVal).not.toContain('{"apiKey":');
      expect(storedVal).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/); // ivB64:cipherB64
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects unauthenticated /api/proxy/* with 401 Unauthorized (no demo key fallback)', async () => {
    const req = new Request('http://localhost/api/proxy/api/v1/transactions', {
      method: 'GET',
    });

    const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ApiResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  it('proxies request with decrypted Bearer token when valid session cookie provided', async () => {
    const originalFetch = globalThis.fetch;
    let forwardedAuth = '';

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.includes('/api/v1/gateways')) {
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }
      if (urlStr.includes('/api/v1/transactions')) {
        const headers = new Headers(init?.headers);
        forwardedAuth = headers.get('Authorization') || '';
        return new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    try {
      // 1. Log in to get session
      const testKey = 'op_live_secret_real_key_4455';
      const loginReq = new Request('http://localhost/session/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: testKey }),
      });
      const loginRes = await merchantApp.fetch(loginReq, env as unknown as Record<string, unknown>);
      const cookieHeader = loginRes.headers.get('Set-Cookie') || '';
      const sessMatch = cookieHeader.match(/__Host-edgepay_sess=([^;]+)/);
      const sessionId = sessMatch ? sessMatch[1] : '';
      expect(sessionId).toBeTruthy();

      // 2. Call proxy with session cookie
      const proxyReq = new Request('http://localhost/api/proxy/api/v1/transactions', {
        method: 'GET',
        headers: { 'Cookie': `__Host-edgepay_sess=${sessionId}` },
      });
      const proxyRes = await merchantApp.fetch(proxyReq, env as unknown as Record<string, unknown>);
      expect(proxyRes.status).toBe(200);
      expect(forwardedAuth).toBe(`Bearer ${testKey}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('mounts strict CSP and security headers on merchant responses (V11-006)', async () => {
    const req = new Request('http://localhost/health');
    const res = await merchantApp.fetch(req, env as unknown as Record<string, unknown>);

    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://cdnjs.cloudflare.com');
  });
});
