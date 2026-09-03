/**
 * EdgePay Hosted Checkout Edge Worker Entrypoint
 * Framework: Hono + Workers Static Assets
 * Architecture: EdgePay Multi-Worker Trust Plane (Untrusted Customer Surface)
 */
import { Hono } from 'hono';

interface Bindings {
  API_ORIGIN: string;
  ENVIRONMENT: string;
  ASSETS: { fetch: typeof fetch };
}

const app = new Hono<{ Bindings: Bindings }>();

// Security headers & nonce CSP for customer checkout surface
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
app.get('/health', (c) => c.json({ status: 'ok', worker: 'edgepay-checkout', timestamp: new Date().toISOString() }));

// API Proxy for status polling (avoids direct cross-origin credentials)
app.get('/api/checkout/:token/status', async (c) => {
  const token = c.req.param('token');
  const apiOrigin = c.env.API_ORIGIN || 'http://localhost:8787';
  try {
    const res = await fetch(`${apiOrigin}/checkout/${token}/status`, {
      headers: { 'Accept': 'application/json' },
    });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return c.json({ status: 'error', message: 'Unable to reach payment core' }, 502);
  }
});

// Serve Checkout SPA / Static Assets
app.get('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
