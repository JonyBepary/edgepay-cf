/**
 * EdgePay Merchant Operations Panel — BFF (Backend-for-Frontend) Worker
 * Framework: Hono + Workers KV Sessions + Static Assets
 * Architecture: EdgePay Multi-Worker Trust Plane (Tenant Business Surface)
 */
import { Hono } from 'hono';

interface Bindings {
  API_ORIGIN: string;
  ENVIRONMENT: string;
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
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:;"
  );
});

// Health check
app.get('/health', (c) => c.json({ status: 'ok', worker: 'edgepay-merchant', timestamp: new Date().toISOString() }));

// BFF Login / Session Creation (Exchanges API key for secure httpOnly session)
app.post('/session/login', async (c) => {
  const body = await c.req.json<{ api_key?: string }>();
  if (!body.api_key || !body.api_key.startsWith('op_live_')) {
    return c.json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Valid live API key required' } }, 401);
  }

  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';
  // Validate key against core GET /api/v1/gateways
  try {
    const check = await fetch(`${apiOrigin}/api/v1/gateways`, {
      headers: { 'Authorization': `Bearer ${body.api_key}` },
    });
    if (!check.ok) {
      return c.json({ success: false, error: { code: 'AUTHENTICATION_FAILED', message: 'API key rejected by core' } }, 401);
    }
  } catch {
    // Demo fallback for local dev
  }

  const sessionId = crypto.randomUUID();
  const sessionData: SessionData = {
    merchantId: 1,
    merchantName: 'Metro Mart',
    apiKey: body.api_key,
    createdAt: new Date().toISOString(),
  };

  if (c.env.MERCHANT_SESSIONS) {
    await c.env.MERCHANT_SESSIONS.put(`sess:${sessionId}`, JSON.stringify(sessionData), { expirationTtl: 604800 });
  }

  c.header('Set-Cookie', `edgepay_sess=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);
  return c.json({ success: true, data: { merchant_name: sessionData.merchantName } });
});

// BFF Logout
app.post('/session/logout', async (c) => {
  c.header('Set-Cookie', `edgepay_sess=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return c.json({ success: true, message: 'Logged out successfully' });
});

// BFF API Proxy: injects Bearer API Key server-side so client never holds it in memory
app.all('/api/proxy/*', async (c) => {
  const path = c.req.path.replace('/api/proxy', '');
  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';

  // Demo fallback or extract session from cookie
  const cookie = c.req.header('Cookie') || '';
  const match = cookie.match(/edgepay_sess=([^;]+)/);
  const sessionId = match ? match[1] : null;

  let apiKey = 'op_live_demo_key';
  if (sessionId && c.env.MERCHANT_SESSIONS) {
    const raw = await c.env.MERCHANT_SESSIONS.get(`sess:${sessionId}`);
    if (raw) {
      apiKey = JSON.parse(raw).apiKey;
    }
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
