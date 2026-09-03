/**
 * EdgePay Merchant Operations Panel — BFF (Backend-for-Frontend) Worker
 * Framework: Hono + Workers KV Sessions + Web Crypto AES-256-GCM + Static Assets
 * Architecture: EdgePay Multi-Worker Trust Plane (Tenant Business Surface)
 */
import { Hono } from 'hono';

interface Bindings {
  API_ORIGIN: string;
  ENVIRONMENT: string;
  ENCRYPTION_KEY?: string;
  SESSION_SECRET?: string;
  MERCHANT_SESSIONS: KVNamespace;
  ASSETS: { fetch: typeof fetch };
}

interface SessionData {
  merchantId: number;
  merchantName: string;
  apiKey: string;
  createdAt: string;
}

const app = new Hono<{ Bindings: Bindings }>();

// Security headers for merchant panel
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https:;"
  );
});

// Helper: Derive CryptoKey from secret string (SHA-256 digest)
async function getSessionCryptoKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyBytes = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Helper: Seal session payload using AES-256-GCM
async function sealSessionPayload(data: string, secret: string): Promise<string> {
  const key = await getSessionCryptoKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(data));
  const ivB64 = btoa(String.fromCharCode(...iv));
  const cipherB64 = btoa(String.fromCharCode(...new Uint8Array(cipher)));
  return `${ivB64}:${cipherB64}`;
}

// Helper: Unseal session payload using AES-256-GCM
async function unsealSessionPayload(sealed: string, secret: string): Promise<string | null> {
  try {
    const parts = sealed.split(':');
    if (parts.length !== 2) return null;
    const [ivB64, cipherB64] = parts;
    const iv = Uint8Array.from(atob(ivB64), ch => ch.charCodeAt(0));
    const cipher = Uint8Array.from(atob(cipherB64), ch => ch.charCodeAt(0));
    const key = await getSessionCryptoKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

function resolveSessionSecret(env: Bindings): string {
  return env.ENCRYPTION_KEY || env.SESSION_SECRET || 'edgepay_merchant_session_seal_k3y_production_fallback';
}

// Health check
app.get('/health', (c) => c.json({ status: 'ok', worker: 'edgepay-merchant', timestamp: new Date().toISOString() }));

// BFF Login / Session Creation (Exchanges API key for secure httpOnly session)
app.post('/session/login', async (c) => {
  const body = await c.req.json<{ api_key?: string }>().catch(() => ({ api_key: undefined }));
  if (!body.api_key || typeof body.api_key !== 'string' || !body.api_key.startsWith('op_live_')) {
    return c.json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Valid live API key required (op_live_...)' } }, 401);
  }

  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';

  // Fail-closed validation against core GET /api/v1/gateways
  try {
    const check = await fetch(`${apiOrigin}/api/v1/gateways`, {
      headers: { 'Authorization': `Bearer ${body.api_key}` },
    });
    if (!check.ok) {
      return c.json({ success: false, error: { code: 'AUTHENTICATION_FAILED', message: 'API key rejected by core payment service' } }, 401);
    }
  } catch {
    // Strict fail-closed: network failure to reach core rejects authentication
    return c.json({ success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Core authentication service unavailable' } }, 502);
  }

  const sessionId = crypto.randomUUID();
  const sessionData: SessionData = {
    merchantId: 1,
    merchantName: 'Metro Mart',
    apiKey: body.api_key,
    createdAt: new Date().toISOString(),
  };

  const secret = resolveSessionSecret(c.env);
  const sealed = await sealSessionPayload(JSON.stringify(sessionData), secret);

  if (c.env.MERCHANT_SESSIONS) {
    await c.env.MERCHANT_SESSIONS.put(`sess:${sessionId}`, sealed, { expirationTtl: 86400 });
  }

  c.header('Set-Cookie', `__Host-edgepay_sess=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
  return c.json({ success: true, data: { merchant_name: sessionData.merchantName } });
});

// BFF Logout
app.post('/session/logout', async (c) => {
  const cookie = c.req.header('Cookie') || '';
  const match = cookie.match(/(?:__Host-)?edgepay_sess=([^;]+)/);
  const sessionId = match ? match[1] : null;

  if (sessionId && c.env.MERCHANT_SESSIONS) {
    await c.env.MERCHANT_SESSIONS.delete(`sess:${sessionId}`);
  }

  c.header('Set-Cookie', `__Host-edgepay_sess=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return c.json({ success: true, message: 'Logged out successfully' });
});

// BFF API Proxy: injects Bearer API Key server-side so client never holds it in memory
app.all('/api/proxy/*', async (c) => {
  const path = c.req.path.replace('/api/proxy', '');
  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';

  // Extract session from cookie
  const cookie = c.req.header('Cookie') || '';
  const match = cookie.match(/(?:__Host-)?edgepay_sess=([^;]+)/);
  const sessionId = match ? match[1] : null;

  if (!sessionId) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Active merchant session required' } }, 401);
  }

  let apiKey: string | null = null;
  if (c.env.MERCHANT_SESSIONS) {
    const raw = await c.env.MERCHANT_SESSIONS.get(`sess:${sessionId}`);
    if (raw) {
      const secret = resolveSessionSecret(c.env);
      const unsealed = await unsealSessionPayload(raw, secret);
      if (unsealed) {
        try {
          apiKey = (JSON.parse(unsealed) as SessionData).apiKey;
        } catch {
          apiKey = null;
        }
      }
    }
  }

  // Reject if unsealed apiKey is missing or invalid — NO DEMO KEY FALLBACK
  if (!apiKey) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired merchant session' } }, 401);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  headers.delete('Cookie');

  const proxyRes = await fetch(`${apiOrigin}${path}`, {
    method: c.req.method,
    headers,
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.raw.arrayBuffer(),
  });

  return new Response(proxyRes.body, {
    status: proxyRes.status,
    headers: proxyRes.headers,
  });
});

// Serve Merchant Dashboard SPA / Static Assets
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
