/**
 * EdgePay Platform Admin Console Worker
 * Framework: Hono + Cloudflare Access Application + Static Assets
 * Architecture: EdgePay Multi-Worker Trust Plane (Platform Admin Surface)
 */
import { Hono } from 'hono';

interface Bindings {
  API_ORIGIN: string;
  ENVIRONMENT: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
  ADMIN_API_KEY?: string;
  ASSETS: { fetch: typeof fetch };
}

const app = new Hono<{ Bindings: Bindings }>();

// Security headers for platform admin console
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
app.get('/health', (c) => c.json({ status: 'ok', worker: 'edgepay-admin', timestamp: new Date().toISOString() }));

// Access-mediated Admin Proxy: forwards calls attaching Access Service Token & Admin Bearer key
app.all('/api/admin/*', async (c) => {
  const path = c.req.path;
  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';

  const headers = new Headers(c.req.raw.headers);
  if (c.env.ADMIN_API_KEY) {
    headers.set('Authorization', `Bearer ${c.env.ADMIN_API_KEY}`);
  }
  if (c.env.CF_ACCESS_CLIENT_ID && c.env.CF_ACCESS_CLIENT_SECRET) {
    headers.set('CF-Access-Client-Id', c.env.CF_ACCESS_CLIENT_ID);
    headers.set('CF-Access-Client-Secret', c.env.CF_ACCESS_CLIENT_SECRET);
  }

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

// Serve Admin SPA / Static Assets
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
