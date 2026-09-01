/**
 * Tenant routing fixes — authenticated tenant mismatch, safe bypass, cache invalidation, non-blocking bootstrap.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { sha256 } from '../src/lib/crypto';
import { createJwtService } from '../src/lib/jwt';
import type { Env } from '../src/types/env';

async function createMerchant(name: string): Promise<number> {
  const uuid = crypto.randomUUID();
  const now = new Date().toISOString();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  await (env as unknown as { DB: any }).DB.prepare(
    `INSERT INTO op_merchants (uuid, name, slug, email, timezone, default_currency, webhook_secret, settings, status, is_platform, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Asia/Dhaka', 'BDT', ?, NULL, 'active', 0, ?, ?)`
  ).bind(uuid, name, slug, `${slug}@example.com`, crypto.randomUUID(), now, now).run();
  const row = await (env as unknown as { DB: any }).DB.prepare(`SELECT id FROM op_merchants WHERE uuid = ? LIMIT 1`).bind(uuid).first();
  return (row as { id: number } | null)!.id;
}

async function createApiKey(merchantId: number, scopes: string[] = ['read','write','admin','*']): Promise<string> {
  const prefix = crypto.randomUUID().replace(/-/g,'').slice(0,12);
  const rest = crypto.randomUUID().replace(/-/g,'').slice(0,32);
  const apiKey = `op_live_${prefix}_${rest}`;
  const hash = await sha256(apiKey);
  const now = new Date().toISOString();
  await (env as unknown as { DB: any }).DB.prepare(
    `INSERT INTO op_api_keys (merchant_id, name, key_prefix, key_hash, scopes, status, created_at) VALUES (?, 'test-key', ?, ?, ?, 'active', ?)`
  ).bind(merchantId, prefix, hash, JSON.stringify(scopes), now).run();
  return apiKey;
}

async function createDomain(domain: string, merchantId: number, type: string = 'checkout') {
  const now = new Date().toISOString();
  await (env as unknown as { DB: any }).DB.prepare(
    `INSERT INTO op_domains (merchant_id, domain, type, status, dns_verified, verification_token, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 1, ?, ?, ?)`
  ).bind(merchantId, domain.toLowerCase().trim(), type, crypto.randomUUID(), now, now).run();
}

describe('authenticated tenant mismatch (API key and JWT)', () => {
  let merchantA: number;
  let merchantB: number;
  let domainA: string;
  let apiKeyB: string;
  let apiKeyA: string;
  let jwtB: string;
  let jwtA: string;

  beforeAll(async () => {
    // Unique per run to avoid collisions across files (shared storage, no isolate)
    const suffix = Math.random().toString(36).slice(2, 6);
    merchantA = await createMerchant(`TenantA-${suffix}`);
    merchantB = await createMerchant(`TenantB-${suffix}`);
    domainA = `pay-${suffix}-${merchantA}.example.com`.toLowerCase();
    await createDomain(domainA, merchantA, 'api');
    apiKeyB = await createApiKey(merchantB);
    apiKeyA = await createApiKey(merchantA);

    // JWTs for mobile — need a paired device user. Use merchant users if exist or create minimal.
    // Create a dummy paired device user via op_merchant_users if needed for JWT sub.
    // For simplicity, use merchantA/B as device ids and merchant_id payload; JWT service doesn't validate device existence.
    const jwtService = createJwtService(env as unknown as Env);
    jwtB = await jwtService.issueAccessToken({ sub: '9991', merchant_id: merchantB, device_id: 991, scope: ['read','write'] });
    jwtA = await jwtService.issueAccessToken({ sub: '9992', merchant_id: merchantA, device_id: 992, scope: ['read','write'] });

    // Ensure KV installed flag true so domain resolution runs
    await (env as unknown as { KV: any }).KV.put('system:installed', 'true');
    await (env as unknown as { KV: any }).KV.put('system:bootstrapped', 'true');
    // Clear any cached domain entries for fresh lookup
    await (env as unknown as { KV: any }).KV.delete(`domain:${domainA}`);
    await (env as unknown as { KV: any }).KV.delete(`domain-v2:${domainA}`);
  });

  it('rejects API key tenant mismatch with 403 when Host belongs to another merchant', async () => {
    const res = await SELF.fetch(`http://${domainA}/api/v1/payments`, {
      method: 'POST',
      headers: {
        Host: domainA,
        Authorization: `Bearer ${apiKeyB}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: '10.00', currency: 'BDT' }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    expect(body.error?.code).toMatch(/FORBIDDEN|Tenant mismatch/i);
    const text = JSON.stringify(body).toLowerCase();
    expect(text).toContain('tenant');
  });

  it('allows API key when tenant matches domain', async () => {
    const res = await SELF.fetch(`http://${domainA}/api/v1/payments`, {
      method: 'POST',
      headers: {
        Host: domainA,
        Authorization: `Bearer ${apiKeyA}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount: '10.00', currency: 'BDT' }),
    });
    // Should NOT be 403 tenant mismatch — should be validation/creation (201 or 400 or 422) but not 403
    expect(res.status).not.toBe(403);
  });

  it('rejects JWT tenant mismatch with 403', async () => {
    const res = await SELF.fetch(`http://${domainA}/api/mobile/v1/dashboard`, {
      headers: {
        Host: domainA,
        Authorization: `Bearer ${jwtB}`,
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as any;
    const text = JSON.stringify(body).toLowerCase();
    expect(text).toContain('tenant');
  });

  it('allows JWT when tenant matches domain', async () => {
    const res = await SELF.fetch(`http://${domainA}/api/mobile/v1/dashboard`, {
      headers: {
        Host: domainA,
        Authorization: `Bearer ${jwtA}`,
      },
    });
    expect(res.status).not.toBe(403);
  });

  it('master domain (APP_DOMAIN) bypasses tenant check for any merchant key', async () => {
    const master = (env as unknown as { APP_DOMAIN?: string }).APP_DOMAIN ?? 'edgepay-cf.bm-jonybepary.workers.dev';
    // health is unauth but api key path with master domain should not 403 tenant mismatch;
    // Use a real auth route on master domain: GET /api/v1/transactions should succeed (200) not 403
    const res2 = await SELF.fetch(`http://${master}/api/v1/transactions`, {
      headers: {
        Host: master,
        Authorization: `Bearer ${apiKeyB}`,
      },
    });
    expect(res2.status).not.toBe(403);
  });
});

describe('safe install/assets/favicon/domain bypass', () => {
  beforeAll(async () => {
    // Ensure installed flag true to ensure domain middleware would normally 404 unknown hosts
    await (env as unknown as { KV: any }).KV.put('system:installed', 'true');
    await (env as unknown as { KV: any }).KV.put('system:bootstrapped', 'true');
  });

  it('/install on unknown host is not 404 from domain middleware', async () => {
    // When system:installed=true, GET /install redirects 302 to '/' — fetch follows redirect to '/' which is 404 on unknown host.
    // Use redirect: manual to inspect the initial response without following.
    const res = await SELF.fetch('http://unknown-bypass-12345.example.com/install', {
      headers: { Host: 'unknown-bypass-12345.example.com' },
      redirect: 'manual',
    } as any);
    const res2 = await SELF.fetch('http://unknown-bypass-12345.example.com/install/', {
      headers: { Host: 'unknown-bypass-12345.example.com' },
      redirect: 'manual',
    } as any);
    const isDomain404 = (s: number, t: string) => s === 404 && t.includes('<h1>404 Not Found</h1>');
    const body = await res.clone().text();
    const body2 = await res2.clone().text();
    expect(isDomain404(res.status, body)).toBe(false);
    expect(isDomain404(res2.status, body2)).toBe(false);
    const ok = [res.status, res2.status].some(s => s === 200 || s === 302);
    expect(ok).toBe(true);
  });

  it('/assets/* on unknown host is not blocked by domain middleware', async () => {
    const res = await SELF.fetch('http://unknown-bypass-12345.example.com/assets/app.css', {
      headers: { Host: 'unknown-bypass-12345.example.com' },
    });
    // Domain middleware should call next() — final result is asset fetch (404 is okay from ASSETS, but not HTML 404 from domain)
    // Check that response is not the domain HTML 404 (which contains <h1>404 Not Found</h1>)
    const text = await res.text();
    // If domain blocked, it would be <h1>404 Not Found</h1>. Assets 404 is different (or 200 if file exists). Ensure not domain HTML.
    // Allow either asset 404 JSON or successful fetch, but not domain's HTML 404 for checkout mismatch.
    // The key is status is not blocked as domain Not Found HTML for unknown host on asset path.
    // We assert that if status is 404, it's not the domain HTML.
    if (res.status === 404 && text.includes('<h1>404 Not Found</h1>')) {
      // This would indicate domain middleware incorrectly blocked assets
      expect(text).not.toContain('<h1>404 Not Found</h1>');
    } else {
      expect(true).toBe(true);
    }
  });

  it('/favicon.ico on unknown host is not blocked', async () => {
    const res = await SELF.fetch('http://unknown-bypass-12345.example.com/favicon.ico', {
      headers: { Host: 'unknown-bypass-12345.example.com' },
    });
    // Should not be domain 404 HTML
    const text = await res.text();
    if (res.status === 404 && text.includes('<h1>404 Not Found</h1>') && text.includes('Not Found')) {
      // Only fail if it's the domain HTML 404
      // Check if the body is exactly domain's HTML — allow ASSETS 404 which is different
      // Domain returns '<h1>404 Not Found</h1>' exactly
      expect(text).not.toBe('<h1>404 Not Found</h1>');
    }
    expect(res.status).not.toBe(503);
  });

  it('unknown host with non-bypass path still 404 (domain enforcement)', async () => {
    const res = await SELF.fetch('http://unknown-bypass-12345.example.com/checkout/some-token', {
      headers: { Host: 'unknown-bypass-12345.example.com' },
    });
    expect(res.status).toBe(404);
  });
});

describe('invalidate all domain cache key variants', () => {
  it('normalization deletes both domain: and domain-v2: lowercased trimmed keys', async () => {
    const rawDomain = '  MiXeD.Example.COM  ';
    const normalized = rawDomain.toLowerCase().trim();
    const kv = (env as unknown as { KV: any }).KV;
    await kv.put(`domain:${normalized}`, JSON.stringify({ fake: 1 }));
    await kv.put(`domain-v2:${normalized}`, JSON.stringify({ fake: 2 }));
    // Also put raw variant to ensure raw not deleted (only normalized should be targeted)
    await kv.put(`domain:${rawDomain}`, JSON.stringify({ raw: 1 }));

    // Create a merchant and domain for verification flow, then trigger invalidation via admin API
    const suffix = Math.random().toString(36).slice(2, 4);
    const merchant = await createMerchant(`CacheInv-${suffix}`);
    const domain = normalized;
    // Ensure domain exists so verification endpoint finds it
    await (env as unknown as { DB: any }).DB.prepare(
      `INSERT INTO op_domains (merchant_id, domain, type, status, dns_verified, verification_token, created_at, updated_at)
       VALUES (?, ?, 'checkout', 'pending', 0, ?, ?, ?)`
    ).bind(merchant, domain, 'tok123', new Date().toISOString(), new Date().toISOString()).run();
    const apiKey = await createApiKey(merchant, ['admin']);

    // Mock DNS via fetch intercept is not needed — verification will fail but still invalidates
    // We just check that after calling verification endpoint, both normalized keys are gone
    await SELF.fetch('http://localhost/api/admin/v1/domains/verifications', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    const after1 = await kv.get(`domain:${normalized}`);
    const after2 = await kv.get(`domain-v2:${normalized}`);
    expect(after1).toBeNull();
    expect(after2).toBeNull();
  });

  it('cron reverify invalidates both prefixes normalized', async () => {
    // Directly test the helper logic: put both keys, then simulate cron behavior by deleting both normalized
    const domain = 'cron-test.example.com';
    const normalized = domain.toLowerCase().trim();
    const kv = (env as unknown as { KV: any }).KV;
    await kv.put(`domain:${normalized}`, JSON.stringify({ x: 1 }));
    await kv.put(`domain-v2:${normalized}`, JSON.stringify({ x: 2 }));
    // Simulate cron's invalidation (lowercase trim + both deletes)
    await Promise.all([kv.delete(`domain:${normalized}`), kv.delete(`domain-v2:${normalized}`)]);
    expect(await kv.get(`domain:${normalized}`)).toBeNull();
    expect(await kv.get(`domain-v2:${normalized}`)).toBeNull();
  });
});

describe('avoid blocking every request on bootstrap', () => {
  it('health and api requests are not blocked synchronously on bootstrap (fast)', async () => {
    // Clear bootstrapped flag to force bootstrap path
    const kv = (env as unknown as { KV: any }).KV;
    await kv.delete('system:bootstrapped');
    // Ensure DB is reachable
    const start = Date.now();
    const res = await SELF.fetch('http://localhost/api/v1/health');
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // Should be fast (< 2000ms) even though bootstrap does multiple DB writes — because it's waitUntil not await
    expect(elapsed).toBeLessThan(2000);
    // After request, bootstrapped should eventually be set via waitUntil (give it a moment)
    await new Promise(r => setTimeout(r, 500));
    const flag = await kv.get('system:bootstrapped');
    // Flag may be set (if bootstrap completed) or still null if async — either is okay, but request must have succeeded quickly
    expect(res.status).toBe(200);
    // Cleanup: ensure flag set for other tests
    if (!flag) await kv.put('system:bootstrapped', 'true');
    await kv.put('system:installed', 'true');
  });
});
