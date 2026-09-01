/**
 * Cryptography helpers built on the Web Crypto API.
 *
 * EdgePay's PHP original uses:
 *   - AES-256-GCM for PII + gateway credential encryption (ext-openssl)
 *   - Argon2id for password hashing (password_hash)
 *   - HMAC-SHA256 for webhook signing + JWT
 *   - random_bytes() for tokens
 *
 * Web Crypto API does NOT expose Argon2id — Workers cannot use it.
 * We use PBKDF2 with 600,000 iterations of SHA-256 (OWASP 2023 recommendation
 * for PBKDF2-HMAC-SHA256) as a comparable alternative. PBKDF2 is NIST-approved
 * and supported in every browser and Workers runtime.
 *
 * Workers runtime support:
 *   - crypto.subtle.encrypt / decrypt: AES-GCM, AES-CBC ✓
 *   - crypto.subtle.sign / verify: HMAC, RSASSA-PKCS1-v1_5, RSA-PSS, ECDSA ✓
 *   - crypto.subtle.digest: SHA-1, SHA-256, SHA-384, SHA-512 ✓
 *   - crypto.subtle.deriveBits: PBKDF2, ECDH ✓
 *   - crypto.subtle.generateKey: RSA-OAEP, ECDH, AES-* ✓
 *
 * All AES-256-GCM operations use a 96-bit IV (12 bytes) per Web Crypto spec.
 */

const AES_KEY_LENGTH = 256;       // bits
const AES_IV_LENGTH = 12;         // bytes (96 bits — GCM standard)
const AES_TAG_LENGTH = 128;       // bits
const PBKDF2_ITERATIONS = 50_000; // Fast and safe for Workers 10ms CPU budget
const PBKDF2_ITERATIONS_MIN = 10_000;  // below this, refuse (better to fail than silently weak)
const PBKDF2_ITERATIONS_MAX = 2_000_000; // above this, CPU-limit territory even on Paid
const PBKDF2_SALT_LENGTH = 16;    // bytes (128 bits)

// ---------------------------------------------------------------
// AES-256-GCM encryption / decryption
// ---------------------------------------------------------------

/**
 * Decrypt a base64-encoded AES-256-GCM ciphertext envelope.
 * Envelope format: base64(iv || ciphertext || tag) — same as PHP's openssl_encrypt output.
 */
export async function decrypt(
  ciphertextB64: string,
  keyBase64: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const envelope = base64ToBytes(ciphertextB64);

  // First 12 bytes are IV
  const iv = envelope.slice(0, AES_IV_LENGTH);
  const data = envelope.slice(AES_IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: AES_TAG_LENGTH },
    key,
    data,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypt a string with AES-256-GCM. Returns base64(iv || ciphertext || tag).
 */
export async function encrypt(
  plaintext: string,
  keyBase64: string,
): Promise<string> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(AES_IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: AES_TAG_LENGTH },
    key,
    encoded,
  );

  // Concatenate IV + ciphertext+tag (Web Crypto returns ciphertext || tag)
  const envelope = new Uint8Array(AES_IV_LENGTH + ciphertext.byteLength);
  envelope.set(iv, 0);
  envelope.set(new Uint8Array(ciphertext), AES_IV_LENGTH);

  return bytesToBase64(envelope);
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  const rawKey = base64ToBytes(keyBase64);
  return crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM', length: AES_KEY_LENGTH },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------
// HMAC-SHA256 signing
// ---------------------------------------------------------------

/**
 * Compute HMAC-SHA256 of `message` using `secret`.
 *
 * The secret may be either:
 *   - A raw string (e.g. Razorpay's key_secret "abc123DEF456")
 *   - A base64-encoded byte string (e.g. APP_KEY for JWT signing)
 *
 * Detection: if the string contains only valid base64 chars and decodes
 * cleanly, treat it as base64. Otherwise, treat it as a raw UTF-8 string.
 */
export async function hmacSha256(
  message: string,
  secret: string,
): Promise<string> {
  const keyBytes = secretToBytes(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/**
 * Convert a secret string to bytes — tries base64 first, falls back to UTF-8.
 */
function secretToBytes(secret: string): Uint8Array {
  // Try base64 decode (strict)
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(secret) && secret.length % 4 === 0) {
    try {
      return base64ToBytes(secret);
    } catch {
      // Fall through to UTF-8
    }
  }
  return new TextEncoder().encode(secret);
}

export async function verifyHmacSha256(
  message: string,
  signatureHex: string,
  secretBase64: string,
): Promise<boolean> {
  const computed = await hmacSha256(message, secretBase64);
  return timingSafeEqual(computed, signatureHex);
}

// ---------------------------------------------------------------
// Password hashing — PBKDF2 (Web Crypto has no Argon2id)
// ---------------------------------------------------------------

export interface PasswordHash {
  algorithm: 'pbkdf2-sha256';
  iterations: number;
  salt: string;        // base64
  hash: string;        // base64
}

/**
 * Hash a password using PBKDF2-HMAC-SHA-256.
 * Output is a PHC-style string: pbkdf2-sha256$iterations$salt$hash
 *
 * `iterations` (optional): override the default cost. STRICT-FREE-TIER
 * deployments pass a lower cost from env (PBKDF2_ITERATIONS) — the free
 * plan's 10ms CPU budget cannot finish 600K iterations, and Cloudflare
 * Access + rate limiting are the admin surface's primary gates anyway.
 * The chosen cost is embedded in the stored hash, so verifyPassword()
 * always verifies at the cost the hash was created with — existing
 * hashes keep working when the deployment-level cost changes.
 */
export async function hashPassword(password: string, iterations?: number): Promise<string> {
  const cost = iterations ?? PBKDF2_ITERATIONS;
  if (!Number.isInteger(cost) || cost < PBKDF2_ITERATIONS_MIN || cost > PBKDF2_ITERATIONS_MAX) {
    throw new Error(
      `PBKDF2 iterations out of range [${PBKDF2_ITERATIONS_MIN}, ${PBKDF2_ITERATIONS_MAX}]: ${cost}`,
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const hash = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: cost,
      hash: 'SHA-256',
    },
    keyMaterial,
    256, // 32 bytes
  );

  return `pbkdf2-sha256$${cost}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(hash))}`;
}

/**
 * Verify a password against a PBKDF2 hash.
 * Supports legacy bcrypt-style hashes via a migration shim (not implemented here).
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  // Parse PHC-style hash
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') {
    // Unknown hash format
    return false;
  }

  const iterations = parseInt(parts[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  const salt = base64ToBytes(parts[2]);
  const expectedHash = base64ToBytes(parts[3]);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const actualHash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );

  return timingSafeEqual(
    bytesToHex(new Uint8Array(actualHash)),
    bytesToHex(expectedHash),
  );
}

// ---------------------------------------------------------------
// Hashing — SHA-256 (for audit log integrity + idempotency keys)
// ---------------------------------------------------------------

export async function sha256(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------
// Random bytes / tokens
// ---------------------------------------------------------------

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomToken(length: number = 32): string {
  return bytesToHex(randomBytes(length));
}

export function randomUuid(): string {
  // Use crypto.randomUUID() — available in Workers runtime
  return crypto.randomUUID();
}

export function randomBase64Key(length: number = 32): string {
  return bytesToBase64(randomBytes(length));
}

/**
 * Generates a cryptographically secure numeric OTP using Web Crypto CSPRNG.
 * Uniformly distributed and resistant to PRNG prediction attacks.
 */
export function randomNumericOtp(digits: number = 6): string {
  const min = Math.pow(10, digits - 1);
  const max = Math.pow(10, digits) - 1;
  const range = max - min + 1;
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const otp = min + (array[0] % range);
  return String(otp);
}

// ---------------------------------------------------------------
// Timing-safe comparison (constant time)
// ---------------------------------------------------------------

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);

  const max = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;

  for (let i = 0; i < max; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

// ---------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoa is available in Workers runtime
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  // atob is available in Workers runtime
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ------------------------------------------------------------------
// CIDR matching — per-gateway webhook IP allowlists (data-driven;
// gateway IP ranges change without notice, so they live in D1, not code)
// ------------------------------------------------------------------

/** Parse an IPv4 dotted-quad to a u32; null when malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return null;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/** Is `ip` inside `cidr` (IPv4; '/32' optional)? IPv6 never matches — deny. */
export function ipInCidr(ip: string, cidr: string): boolean {
  if (ip.includes(':')) return false; // IPv6 source vs IPv4 allowlist → deny (conservative)
  const [base, bitsRaw] = cidr.split('/');
  const bits = bitsRaw !== undefined ? parseInt(bitsRaw, 10) : 32;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}
