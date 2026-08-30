/**
 * Hash helpers for gateway adapters — Web Crypto wrappers plus a pure-TS MD5.
 *
 * Why MD5 lives here: three providers (DBBL Rocket, PortWallet, Payfast)
 * mandate MD5-concat signature schemes at THEIR endpoint — we cannot upgrade
 * the algorithm unilaterally. Web Crypto deliberately omits MD5, so this is
 * a compact RFC 1321 implementation used ONLY by those adapters. It is never
 * used for password hashing, credential storage, or any security-sensitive
 * EdgePay-internal purpose (see lib/crypto.ts for those).
 *
 * Everything else (HMAC-SHA*, SHA-1/256/384/512 digests) goes through
 * crypto.subtle — async, Workers-native.
 */

import { timingSafeEqual } from './timing-safe';

// ---------------------------------------------------------------
// MD5 — RFC 1321, pure TypeScript (legacy gateway signature schemes only)
// ---------------------------------------------------------------

/** Per-round shift amounts (RFC 1321). */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** Sine-derived constants table (RFC 1321 §3.4). */
const MD5_K = (() => {
  const t = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  }
  return t;
})();

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/**
 * MD5 digest of a UTF-8 string, hex-encoded lowercase.
 * Pinned by tests against RFC 1321 test vectors.
 */
export function md5Hex(input: string): string {
  const msg = new TextEncoder().encode(input);

  // Pad: 0x80, zeros, then 64-bit little-endian bit length.
  const paddedLen = (((msg.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  const bitLen = msg.length * 8;
  dv.setUint32(paddedLen - 8, bitLen >>> 0, true);
  dv.setUint32(paddedLen - 4, Math.floor(bitLen / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (f + a + MD5_K[i] + m[g]) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(sum, MD5_S[i])) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);

  let hex = '';
  for (const byte of out) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// ---------------------------------------------------------------
// HMAC / digest via Web Crypto
// ---------------------------------------------------------------

export type ShaAlgo = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let hex = '';
  for (const byte of view) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * HMAC digest of a UTF-8 string, hex-encoded. e.g. hmacHex('SHA-256', body, secret).
 *
 * Empty key: Web Crypto rejects zero-length HMAC keys with a DataError.
 * Adapters may be handed unconfigured credentials (merchant half-installed a
 * gateway, callback arrived with no config rows) — in that case return an
 * impossible signature ('') so every comparison fails closed instead of
 * bubbling a 500 through the payment path.
 */
export async function hmacHex(algo: ShaAlgo, data: string, key: string): Promise<string> {
  if (key === '') {
    return '';
  }
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return bytesToHex(sig);
}

/** HMAC digest of raw bytes, hex-encoded. For body-hash style schemes. */
export async function hmacHexBytes(algo: ShaAlgo, data: ArrayBuffer | Uint8Array, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  );
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, bytes);
  return bytesToHex(sig);
}

/** Plain digest of a UTF-8 string, hex-encoded. e.g. shaHex('SHA-256', s). */
export async function shaHex(algo: ShaAlgo, data: string): Promise<string> {
  const digest = await crypto.subtle.digest(algo, new TextEncoder().encode(data));
  return bytesToHex(digest);
}

/** HMAC digest, base64-encoded (some providers want base64 not hex). */
export async function hmacB64(algo: ShaAlgo, data: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: algo },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---------------------------------------------------------------
// Signature comparison
// ---------------------------------------------------------------

export { timingSafeEqual };
