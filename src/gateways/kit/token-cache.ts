/**
 * Gateway token cache — KV-backed, with per-isolate memory fronting.
 *
 * Eight+ providers use OAuth-style token grants (bKash, MTN MoMo, MPesa,
 * Orange Money, Airtel Money, PayMe, Instamojo, Mercado Pago, ...). PHP
 * cached tokens in a static array inside the FPM worker; Workers isolates
 * are ephemeral, so the cache MUST live in KV to be shared across isolates
 * and requests. Tokens are provider API credentials — short-lived (≤1h) by
 * design, and caching them saves one subrequest + provider rate-budget per
 * payment.
 *
 * Memory front: each isolate memoizes its last-known values so hot paths
 * avoid a KV read per call. KV remains the cross-isolate source of truth.
 */

export interface KvLike {
  get(key: string, options?: { type?: string }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CacheEntry {
  token: string;
  expiresAtMs: number;
}

const memCache = new Map<string, CacheEntry>();

export class TokenCache {
  constructor(private readonly kv?: KvLike) {}

  /**
   * Get a cached token for `key` (e.g. "bkash:token:live:APPKEY").
   * Returns null when absent or expired.
   */
  async get(key: string): Promise<string | null> {
    const now = Date.now();
    const mem = memCache.get(key);
    if (mem && mem.expiresAtMs > now) return mem.token;
    if (mem) memCache.delete(key);

    if (!this.kv) return null;
    try {
      const raw = await this.kv.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEntry;
      if (!parsed || typeof parsed.token !== 'string' || parsed.expiresAtMs <= now) {
        return null;
      }
      memCache.set(key, parsed);
      return parsed.token;
    } catch {
      // KV read failures must never break a payment — fall through to grant.
      return null;
    }
  }

  /**
   * Store a token. `ttlSec` should be shorter than the provider's real
   * lifetime (bKash tokens live ~60min; adapters cache 55min = 3300s).
   */
  async put(key: string, token: string, ttlSec: number): Promise<void> {
    const entry: CacheEntry = { token, expiresAtMs: Date.now() + ttlSec * 1000 };
    memCache.set(key, entry);
    if (!this.kv) return;
    try {
      // KV minimum TTL is 60s.
      await this.kv.put(key, JSON.stringify(entry), {
        expirationTtl: Math.max(60, Math.ceil(ttlSec * 1.1)),
      });
    } catch {
      // Same policy as get(): cache is an optimization, not a dependency.
    }
  }

  /** Test helper: clear memory cache */
  static _clearForTests(): void {
    memCache.clear();
  }
}
