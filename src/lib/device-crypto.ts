/**
 * Device Cryptography & Hardware-Backed Signature Verification.
 *
 * Implements Android Keystore (StrongBox / TEE) signature verification:
 *   - ECDSA with NIST P-256 curve and SHA-256 (ES256 / SHA256withECDSA).
 *   - Supports both Android standard DER-encoded ASN.1 signatures and
 *     Web Crypto IEEE P1363 (64-byte raw r || s) signatures.
 *   - Replay protection canonical payload construction.
 *   - Key rotation verification.
 */

import { base64ToBytes, bytesToBase64 } from './crypto';

export interface DeviceSignatureParams {
  deviceId: number | string;
  nonce: string;
  timestamp: number | string;
  sender: string;
  body: string;
}
 
export const ROTATE_KEY_MARKER = 'rotate-key';
export const RECORD_SEPARATOR = '\x1e';

/**
 * Canonical field encoder:
 * 1. Normalizes unicode string using standard NFC (Unicode Normalization Form C).
 * 2. Computes exact UTF-8 byte length (protecting against multibyte/emoji mismatch).
 * 3. Emits `<utf8_byte_len>:<nfc_string>` (eliminating delimiter collisions & field-shifting).
 */
export function encodeCanonicalField(val: string | number): string {
  const normalized = String(val).normalize('NFC');
  const bytes = new TextEncoder().encode(normalized);
  return `${bytes.length}:${normalized}`;
}

/**
 * Builds canonical string for SMS payload signing using length-prefixed fields:
 * `${len(deviceId)}:${deviceId}\x1e${len(nonce)}:${nonce}\x1e${len(timestamp)}:${timestamp}\x1e${len(sender)}:${sender}\x1e${len(body)}:${body}`
 */
export function buildCanonicalSmsPayload(params: DeviceSignatureParams): string {
  return [
    encodeCanonicalField(params.deviceId),
    encodeCanonicalField(params.nonce),
    encodeCanonicalField(params.timestamp),
    encodeCanonicalField(params.sender),
    encodeCanonicalField(params.body),
  ].join(RECORD_SEPARATOR);
}

/**
 * Builds canonical string for device key rotation:
 * `${len(deviceId)}:${deviceId}\x1e${len(nonce)}:${nonce}\x1e${len(timestamp)}:${timestamp}\x1e10:rotate-key\x1e${len(newPublicKey)}:${newPublicKey}`
 */
export function buildCanonicalKeyRotationPayload(params: {
  deviceId: number | string;
  nonce: string;
  timestamp: number | string;
  newPublicKey: string;
}): string {
  return [
    encodeCanonicalField(params.deviceId),
    encodeCanonicalField(params.nonce),
    encodeCanonicalField(params.timestamp),
    encodeCanonicalField(ROTATE_KEY_MARKER),
    encodeCanonicalField(params.newPublicKey),
  ].join(RECORD_SEPARATOR);
}

/**
 * Converts standard ASN.1 DER-encoded ECDSA signature to 64-byte IEEE P1363 (r || s).
 * Android's java.security.Signature.getInstance("SHA256withECDSA") emits DER:
 * 0x30 [len] 0x02 [r_len] [r...] 0x02 [s_len] [s...]
 */
export function derToP1363(der: Uint8Array, keySize = 32): Uint8Array {
  // If already matches IEEE P1363 (2 * keySize), return as-is
  if (der.length === keySize * 2) {
    return der;
  }

  if (der[0] !== 0x30) {
    throw new Error('Invalid DER signature: missing sequence tag');
  }

  let offset = 2; // skip 0x30 [len]
  if (der[1] & 0x80) {
    offset = 2 + (der[1] & 0x7f);
  }

  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing integer tag for r');
  }
  const rLen = der[offset + 1];
  offset += 2;
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  if (der[offset] !== 0x02) {
    throw new Error('Invalid DER signature: missing integer tag for s');
  }
  const sLen = der[offset + 1];
  offset += 2;
  const sBytes = der.slice(offset, offset + sLen);

  // Strip leading 0x00 padding bytes if present
  let rTrimmed = rBytes;
  while (rTrimmed.length > 1 && rTrimmed[0] === 0 && (rTrimmed[1] & 0x80) !== 0) {
    rTrimmed = rTrimmed.slice(1);
  }
  let sTrimmed = sBytes;
  while (sTrimmed.length > 1 && sTrimmed[0] === 0 && (sTrimmed[1] & 0x80) !== 0) {
    sTrimmed = sTrimmed.slice(1);
  }

  let targetSize = keySize;
  if (targetSize === 32 && (rTrimmed.length > 32 || sTrimmed.length > 32)) {
    if (rTrimmed.length <= 48 && sTrimmed.length <= 48) {
      targetSize = 48; // P-384
    } else if (rTrimmed.length <= 66 && sTrimmed.length <= 66) {
      targetSize = 66; // P-521
    }
  }

  if (rTrimmed.length > targetSize) throw new Error('Invalid DER r length');
  if (sTrimmed.length > targetSize) throw new Error('Invalid DER s length');

  const p1363 = new Uint8Array(targetSize * 2);
  p1363.set(rTrimmed, targetSize - rTrimmed.length);
  p1363.set(sTrimmed, targetSize * 2 - sTrimmed.length);

  return p1363;
}

/**
 * Converts IEEE P1363 (64 bytes) signature to DER format (useful for testing).
 */
export function p1363ToDer(p1363: Uint8Array): Uint8Array {
  if (p1363.length !== 64) {
    throw new Error('Expected 64-byte P1363 signature');
  }
  let r = p1363.slice(0, 32);
  let s = p1363.slice(32, 64);

  // Remove leading zeros
  let rStart = 0;
  while (rStart < r.length - 1 && r[rStart] === 0) rStart++;
  r = r.slice(rStart);
  // If high bit set, prefix with 0x00
  if (r[0] & 0x80) {
    const padded = new Uint8Array(r.length + 1);
    padded.set(r, 1);
    r = padded;
  }

  let sStart = 0;
  while (sStart < s.length - 1 && s[sStart] === 0) sStart++;
  s = s.slice(sStart);
  if (s[0] & 0x80) {
    const padded = new Uint8Array(s.length + 1);
    padded.set(s, 1);
    s = padded;
  }

  const totalLen = 2 + r.length + 2 + s.length;
  const der = new Uint8Array(2 + totalLen);
  der[0] = 0x30;
  der[1] = totalLen;
  der[2] = 0x02;
  der[3] = r.length;
  der.set(r, 4);
  const sOffset = 4 + r.length;
  der[sOffset] = 0x02;
  der[sOffset + 1] = s.length;
  der.set(s, sOffset + 2);
  return der;
}

/**
 * Imports a device public key (SPKI base64 / PEM or JWK).
 */
export async function importDevicePublicKey(
  keyInput: string | JsonWebKey,
  algorithm = 'ES256',
): Promise<CryptoKey> {
  if (algorithm !== 'ES256') {
    throw new Error(`Unsupported device key algorithm: ${algorithm}`);
  }

  if (typeof keyInput === 'object') {
    return crypto.subtle.importKey(
      'jwk',
      keyInput,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }

  let cleanB64 = keyInput.trim();
  // Strip PEM headers if present
  cleanB64 = cleanB64
    .replace(/-----BEGIN[ A-Z0-9_-]+-----/g, '')
    .replace(/-----END[ A-Z0-9_-]+-----/g, '')
    .replace(/\s+/g, '');

  // Check if it's JSON JWK string
  if (cleanB64.startsWith('{') && cleanB64.endsWith('}')) {
    const jwk = JSON.parse(cleanB64) as JsonWebKey;
    return crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  }

  const spkiBytes = base64ToBytes(cleanB64);
  return crypto.subtle.importKey(
    'spki',
    spkiBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
}

/**
 * Verifies a device signature against a canonical payload.
 */
export async function verifyDeviceSignature(params: {
  publicKey: string | JsonWebKey;
  signature: string | Uint8Array;
  payload: string | Uint8Array;
  algorithm?: string;
}): Promise<boolean> {
  try {
    const key = await importDevicePublicKey(params.publicKey, params.algorithm ?? 'ES256');

    let sigBytes: Uint8Array;
    if (typeof params.signature === 'string') {
      const clean = params.signature.trim().replace(/\s+/g, '');
      sigBytes = base64ToBytes(clean);
    } else {
      sigBytes = params.signature;
    }

    // Convert DER to IEEE P1363 if needed
    const p1363Sig = derToP1363(sigBytes);

    const dataBytes =
      typeof params.payload === 'string'
        ? new TextEncoder().encode(params.payload)
        : params.payload;

    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      key,
      p1363Sig,
      dataBytes,
    );
  } catch {
    return false;
  }
}

/**
 * Test helper: generate a P-256 key pair and export public key in SPKI base64 format.
 */
export async function generateTestDeviceKeyPair(): Promise<{
  publicKeySpkiB64: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = (await crypto.subtle.exportKey('spki', keyPair.publicKey)) as ArrayBuffer;
  const publicKeySpkiB64 = bytesToBase64(new Uint8Array(spki));
  return {
    publicKeySpkiB64,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
}

/**
 * Test helper: sign payload using a private key and return DER-encoded base64 signature.
 */
export async function signTestDevicePayload(
  privateKey: CryptoKey,
  payload: string | Uint8Array,
  format: 'der' | 'p1363' = 'der',
): Promise<string> {
  const data = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const rawSig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: { name: 'SHA-256' } },
    privateKey,
    data,
  );
  const p1363Bytes = new Uint8Array(rawSig);
  const finalBytes = format === 'der' ? p1363ToDer(p1363Bytes) : p1363Bytes;
  return bytesToBase64(finalBytes);
}
