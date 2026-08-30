/**
 * Port-kit tests — MD5 (RFC 1321 vectors), HMAC/SHA helpers, timing-safe
 * compare, auto-submit form escaping, and the KV token cache.
 *
 * MD5 correctness is load-bearing: three legacy gateways (Rocket,
 * PortWallet, Payfast) sign with provider-mandated MD5 — a wrong digest
 * would produce signatures those providers reject (or worse, accept
 * incorrectly in verify()).
 */

import { describe, expect, it } from 'vitest';
import { md5Hex, hmacHex, shaHex } from '../src/lib/hash';
import { timingSafeEqual } from '../src/lib/timing-safe';
import { buildAutoSubmitForm, escapeHtml } from '../src/gateways/kit/form';
import { TokenCache } from '../src/gateways/kit/token-cache';
import { gwJson } from '../src/gateways/kit/http';

describe('md5Hex (RFC 1321 test vectors)', () => {
  it('empty string', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
  it('abc', () => {
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('message digest', () => {
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
  });
  it('alphabet', () => {
    expect(md5Hex('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });
  it('long vector (RFC 1321 §A.5)', () => {
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890'))
      .toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
  it('multi-byte UTF-8 input', () => {
    // md5("héllo") over UTF-8 bytes
    expect(md5Hex('héllo')).toBe('be50e8478cf24ff3595bc7307fb91b50'); // verified vs Python hashlib
  });
});

describe('Web Crypto helpers', () => {
  it('hmacHex matches a known HMAC-SHA256 vector', async () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
    expect(await hmacHex('SHA-256', 'what do ya want for nothing?', 'Jefe'))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('shaHex matches a known SHA-256 vector', async () => {
    expect(await shaHex('SHA-256', 'abc'))
      .toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('timingSafeEqual', () => {
  it('accepts equal strings', () => {
    expect(timingSafeEqual('deadbeef', 'deadbeef')).toBe(true);
  });
  it('rejects different strings of equal length', () => {
    expect(timingSafeEqual('deadbeef', 'deadbee1')).toBe(false);
  });
  it('rejects different lengths', () => {
    expect(timingSafeEqual('a', 'ab')).toBe(false);
  });
});

describe('buildAutoSubmitForm', () => {
  it('escapes HTML in names and values (no attribute breakout)', () => {
    const html = buildAutoSubmitForm('https://gw.example/pay', {
      'amount': '100.00',
      'note': `"><script>alert(1)</script>`,
    });
    expect(html).toContain('action="https://gw.example/pay"');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });
  it('auto-submits via the named form id', () => {
    const html = buildAutoSubmitForm('https://gw.example/pay', { a: 'b' });
    expect(html).toMatch(/getElementById\("edgepay-gateway-form"\)\.submit\(\)/);
  });
  it('escapeHtml covers the OWASP core set', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

describe('TokenCache', () => {
  it('returns null on miss and caches puts (KV-backed)', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    };
    const cache = new TokenCache(kv as never);
    expect(await cache.get('bkash:token:live:APP')).toBeNull();
    await cache.put('bkash:token:live:APP', 'tok123', 3300);
    expect(await cache.get('bkash:token:live:APP')).toBe('tok123');
    // a second cache instance (fresh isolate) reads through KV
    const cache2 = new TokenCache(kv as never);
    expect(await cache2.get('bkash:token:live:APP')).toBe('tok123');
  });
  it('degrades to per-isolate memory without KV (never throws)', async () => {
    const cache = new TokenCache(undefined);
    expect(await cache.get('k')).toBeNull();
    await cache.put('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
  });
});

describe('gwJson', () => {
  it('normalizes non-JSON bodies to data:null (PHP json_decode guard parity)', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('<html>not json</html>', { status: 200 })) as never;
    try {
      const res = await gwJson({ url: 'https://gw.example/x' });
      expect(res.ok).toBe(true);
      expect(res.data).toBeNull();
      expect(res.text).toContain('not json');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
