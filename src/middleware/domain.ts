/**
 * Multi-brand domain resolution middleware.
 *
 * Port of EdgePay's PHP DomainMiddleware. In EdgePay the master installation
 * domain serves the admin UI; each "brand" gets a custom domain (verified
 * via DNS TXT record) that serves only checkout/webhook flows.
 *
 * Cloudflare Workers variant:
 *   - On Workers, custom domains are configured via:
 *     1. Cloudflare Custom Hostnames API (SaaS product — requires CF SSL for SaaS)
 *     2. Or simply: a route binding `pay.brand.com/*` → edgepay-cf worker
 *   - The Worker inspects the `Host` header to resolve brand context
 *   - Per-request brand resolution cached in KV (TTL 5 min)
 *
 * Behavior:
 *   1. If Host == APP_DOMAIN or localhost → no brand context (admin territory)
 *   2. Else → look up domain in D1 (with KV cache)
 *      a. Not found or inactive → 404
 *      b. Pending DNS verification → 503
 *      c. Active + verified → inject merchant_id, domain_type into c.var
 *   3. If domain_type === 'checkout' and path starts with /admin → 404 (hard block)
 *   4. If domain_type === 'api' and path doesn't start with /api → 404
 */

import type { MiddlewareHandler } from 'hono';
import type { Env } from '../types/env';
import type { Domain, Merchant } from '../types/db';

const KV_CACHE_TTL = 300; // 5 minutes
const KV_KEY_PREFIX = 'domain:';

interface DomainCacheEntry {
  domain: Domain;
  merchant: Merchant;
  resolved_at: number;
}

export const domainMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }> = async (c, next) => {
  const host = c.req.header('Host');
  if (!host) {
    return await next();
  }

  // Normalize host — strip port (works for IPv4 + bracketed IPv6)
  let hostname = host;
  if (hostname.startsWith('[')) {
    // IPv6 — [::1]:8080
    const closeBracket = hostname.indexOf(']');
    if (closeBracket > 0) {
      hostname = hostname.slice(1, closeBracket);
    }
  } else {
    const colonPos = hostname.lastIndexOf(':');
    if (colonPos > 0) {
      hostname = hostname.slice(0, colonPos);
    }
  }
  hostname = hostname.toLowerCase().trim();

  // Master domain → no brand context
  const masterDomain = (c.env.APP_DOMAIN ?? '').toLowerCase();
  if (hostname === masterDomain || hostname === 'localhost' || hostname === '127.0.0.1') {
    c.set('customDomain', null);
    c.set('domainType', null);
    c.set('merchantId', null);
    c.set('merchant', null);
    return await next();
  }

  // Check if installed (skip during /install wizard)
  const installFlag = await c.env.KV.get('system:installed');
  if (installFlag !== 'true' && !c.req.path.startsWith('/install')) {
    return await next();
  }

  // Resolve brand context — KV cache first
  const cached = await c.env.KV.get<DomainCacheEntry>(`${KV_KEY_PREFIX}${hostname}`, 'json');
  if (cached && Date.now() - cached.resolved_at < KV_CACHE_TTL * 1000) {
    if (cached.domain.status !== 'active' || !cached.domain.dns_verified) {
      return c.json({
        success: false,
        error: { code: 'DOMAIN_NOT_VERIFIED', message: 'DNS verification pending' },
      }, 503);
    }
    c.set('domain', cached.domain);
    c.set('merchantId', cached.merchant.id);
    c.set('merchant', cached.merchant);
    c.set('domainType', cached.domain.type as 'checkout' | 'api' | 'admin');
    c.set('customDomain', hostname);

    return enforceDomainRouting(c, next, cached.domain);
  }

  // Cache miss → query D1
  const domainRow = await c.env.DB.prepare(

    `SELECT * FROM op_domains WHERE domain = ? AND status != 'inactive' LIMIT 1`
).bind(hostname).first<Domain>();

  if (!domainRow) {
    return c.html('<h1>404 Not Found</h1>', 404);
  }

  if (domainRow.status === 'pending' || !domainRow.dns_verified) {
    return c.html('<h1>Domain Not Verified</h1><p>DNS verification pending.</p>', 503);
  }

  // Resolve merchant
  const merchant = await c.env.DB.prepare(

    `SELECT * FROM op_merchants WHERE id = ? AND status = 'active' LIMIT 1`
).bind(domainRow.merchant_id).first<Merchant>();

  if (!merchant) {
    return c.html('<h1>404 Not Found</h1>', 404);
  }

  // Warm the cache
  const cacheEntry: DomainCacheEntry = {
    domain: domainRow,
    merchant,
    resolved_at: Date.now(),
  };
  c.executionCtx.waitUntil(
    c.env.KV.put(`${KV_KEY_PREFIX}${hostname}`, JSON.stringify(cacheEntry), {
      expirationTtl: KV_CACHE_TTL,
    }),
  );

  c.set('domain', domainRow);
  c.set('merchantId', merchant.id);
  c.set('merchant', merchant);
  c.set('domainType', domainRow.type as 'checkout' | 'api' | 'admin');
  c.set('customDomain', hostname);

  return enforceDomainRouting(c, next, domainRow);
};

async function enforceDomainRouting(
  c: Parameters<MiddlewareHandler<{ Bindings: Env; Variables: AppVariables }>>[0],
  next: () => Promise<void>,
  domain: Domain,
): Promise<Response | void> {
  const path = c.req.path;
  const isAsset = path.startsWith('/assets/') || path.startsWith('/storage/') || path === '/favicon.ico';

  if (!isAsset) {
    if (domain.type === 'checkout') {
      const isCheckoutRoute = path.startsWith('/checkout/') || path.startsWith('/invoice/') || path.startsWith('/pay/') || path.startsWith('/webhook/');
      if (!isCheckoutRoute) {
        return c.html('<h1>404 Not Found</h1>', 404);
      }
    } else if (domain.type === 'api') {
      if (!path.startsWith('/api/')) {
        return c.html('<h1>404 Not Found</h1>', 404);
      }
    }
  }

  // Hard-block /admin on custom domains
  if (path.startsWith('/admin/') || path === '/admin') {
    return c.html('', 404);
  }

  await next();
}

// Hono's AppVariables — declared globally to avoid circular imports
interface AppVariables {
  requestId: string;
  merchantId: number | null;
  merchant: import('../types/db').Merchant | null;
  domain: import('../types/db').Domain | null;
  domainType: 'checkout' | 'api' | 'admin' | null;
  customDomain: string | null;
  authType: 'bearer' | 'jwt' | 'session' | null;
  authSubject: number | null;
  authScopes: string[];
  csrfToken: string;
  startTime: number;
}
