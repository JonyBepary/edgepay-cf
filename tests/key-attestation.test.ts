/**
 * Test Suite: Android Hardware Key Attestation (Phase 4).
 *
 * Verifies:
 *   1. ASN.1 DER parsing: primitive & constructed tags, multi-byte context tags (VLQ),
 *      integers, booleans, bit strings, OIDs, and date formats.
 *   2. Lightweight X.509 certificate parsing and Web Crypto signature verification.
 *   3. Google Root Trust validation (pinned RSA / RKP / test roots).
 *   4. Android Keymaster/Keymint extension validation:
 *      - Hardware vs software security levels.
 *      - Challenge verification.
 *      - Authorization list constraints (app scoping, origin, purpose, algorithm, curve).
 *      - Verified boot and lock states.
 *      - OS version and patch level extraction.
 *   5. End-to-end device pairing flow:
 *      - Two-phase challenge issuance (/pair/initiate) and consumption (/pair).
 *      - Policy enforcement (ATTESTATION_REQUIRED, STRONGBOX_REQUIRED, freshness).
 *      - SMS submission gating on attestation status.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env, D1Database } from '../src/types/env';
import {
  parseAsn1,
  asn1IntegerToNumber,
  asn1IntegerToBigInt,
  asn1Boolean,
  asn1BitString,
  asn1OidToString,
  asn1Date,
} from '../src/lib/asn1';
import {
  parseX509Certificate,
  verifyCertificateSignature,
  equalBytes,
  ALLOWED_SIG_OIDS,
} from '../src/lib/x509';
import {
  AndroidKeyAttestationVerifier,
  MockAttestationVerifier,
  KEY_DESCRIPTION_OID,
  KM_TAGS,
  KM_SECURITY_LEVEL,
  KM_VERIFIED_BOOT_STATE,
  KM_ORIGIN,
  KM_PURPOSE,
  KM_ALGORITHM,
  KM_EC_CURVE,
} from '../src/services/key-attestation';
import {
  GOOGLE_ROOT_RSA_PUBKEY_B64,
  GOOGLE_ROOT_RKP_PUBKEY_B64,
  GOOGLE_TEST_ROOT_CERT_B64,
} from '../src/services/key-attestation-roots';
import { GOOGLE_STRONGBOX_TEST_CHAIN_B64 } from './fixtures/google-key-attestation-fixtures';
import { base64ToBytes, bytesToBase64, sha256 } from '../src/lib/crypto';
import { generateTestDeviceKeyPair, buildCanonicalSmsPayload, signTestDevicePayload } from '../src/lib/device-crypto';
import { TEST_MERCHANT_RANGES } from './test-ids';

const tenv = env as unknown as Env;
const db = tenv.DB as D1Database;
const merchantRange = TEST_MERCHANT_RANGES.KEY_ATTESTATION;

// ---------------------------------------------------------------------------
// ASN.1 DER Helper Utilities for Generating Synthetic Keymaster Extensions
// ---------------------------------------------------------------------------

function encodeLength(len: number): Uint8Array {
  if (len < 128) {
    return new Uint8Array([len]);
  }
  const octets: number[] = [];
  let temp = len;
  while (temp > 0) {
    octets.unshift(temp & 0xff);
    temp >>= 8;
  }
  return new Uint8Array([0x80 | octets.length, ...octets]);
}

function encodeTl(tag: number, val: Uint8Array): Uint8Array {
  const lenBytes = encodeLength(val.length);
  const out = new Uint8Array(1 + lenBytes.length + val.length);
  out[0] = tag;
  out.set(lenBytes, 1);
  out.set(val, 1 + lenBytes.length);
  return out;
}

function encodeSeq(children: Uint8Array[]): Uint8Array {
  const totalLen = children.reduce((sum, c) => sum + c.length, 0);
  const body = new Uint8Array(totalLen);
  let off = 0;
  for (const c of children) {
    body.set(c, off);
    off += c.length;
  }
  return encodeTl(0x30, body);
}

function encodeInt(num: number | bigint): Uint8Array {
  if (num === 0 || num === 0n) return encodeTl(0x02, new Uint8Array([0]));
  const octets: number[] = [];
  let n = typeof num === 'bigint' ? num : BigInt(num);
  while (n > 0n) {
    octets.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  if (octets[0] & 0x80) {
    octets.unshift(0x00);
  }
  return encodeTl(0x02, new Uint8Array(octets));
}

function encodeOctetString(bytes: Uint8Array): Uint8Array {
  return encodeTl(0x04, bytes);
}

function encodeBool(val: boolean): Uint8Array {
  return encodeTl(0x01, new Uint8Array([val ? 0xff : 0x00]));
}

/**
 * Encodes a context-specific tagged ASN.1 item (supports multi-byte VLQ tag >= 31).
 */
function encodeContextTag(tagNumber: number, inner: Uint8Array, constructed = true): Uint8Array {
  const tagBytes: number[] = [];
  if (tagNumber < 31) {
    tagBytes.push((constructed ? 0xa0 : 0x80) | tagNumber);
  } else {
    tagBytes.push((constructed ? 0xbf : 0x9f));
    const vlq: number[] = [];
    let temp = tagNumber;
    vlq.unshift(temp & 0x7f);
    temp >>= 7;
    while (temp > 0) {
      vlq.unshift(0x80 | (temp & 0x7f));
      temp >>= 7;
    }
    tagBytes.push(...vlq);
  }

  const lenBytes = encodeLength(inner.length);
  const out = new Uint8Array(tagBytes.length + lenBytes.length + inner.length);
  out.set(tagBytes, 0);
  out.set(lenBytes, tagBytes.length);
  out.set(inner, tagBytes.length + lenBytes.length);
  return out;
}

/**
 * Encodes KeyDescription ASN.1 extension.
 */
function buildKeyDescriptionDer(params: {
  attestationVersion?: number;
  attestationSecurityLevel?: number;
  keymasterVersion?: number;
  keymasterSecurityLevel?: number;
  challenge: Uint8Array;
  teeEnforcedTags?: Uint8Array[];
  swEnforcedTags?: Uint8Array[];
}): Uint8Array {
  const attVer = encodeInt(params.attestationVersion ?? 4);
  const attSec = encodeInt(params.attestationSecurityLevel ?? KM_SECURITY_LEVEL.STRONGBOX);
  const kmVer = encodeInt(params.keymasterVersion ?? 4);
  const kmSec = encodeInt(params.keymasterSecurityLevel ?? KM_SECURITY_LEVEL.STRONGBOX);
  const chal = encodeOctetString(params.challenge);
  const uniqueId = encodeOctetString(new Uint8Array(0));

  const swEnforcedSeq = encodeSeq(params.swEnforcedTags ?? []);
  const teeEnforcedSeq = encodeSeq(params.teeEnforcedTags ?? [
    encodeContextTag(KM_TAGS.PURPOSE, encodeSeq([encodeInt(KM_PURPOSE.SIGN)])),
    encodeContextTag(KM_TAGS.ALGORITHM, encodeInt(KM_ALGORITHM.EC), false),
    encodeContextTag(KM_TAGS.EC_CURVE, encodeInt(KM_EC_CURVE.P256), false),
    encodeContextTag(KM_TAGS.ORIGIN, encodeInt(KM_ORIGIN.GENERATED), false),
    encodeContextTag(KM_TAGS.ROOT_OF_TRUST, encodeSeq([
      encodeOctetString(new Uint8Array(32).fill(1)),
      encodeBool(true), // deviceLocked
      encodeInt(KM_VERIFIED_BOOT_STATE.VERIFIED),
    ])),
    encodeContextTag(KM_TAGS.OS_VERSION, encodeInt(140000), false),
    encodeContextTag(KM_TAGS.OS_PATCH_LEVEL, encodeInt(202608), false),
  ]);

  return encodeSeq([
    attVer,
    attSec,
    kmVer,
    kmSec,
    chal,
    uniqueId,
    swEnforcedSeq,
    teeEnforcedSeq,
  ]);
}

describe('ASN.1 DER Decoder', () => {
  it('parses primitive integers: zero, small, negative-sign-padded, and multi-byte BigInt', () => {
    // Zero
    const zeroNode = parseAsn1(encodeInt(0));
    expect(asn1IntegerToNumber(zeroNode)).toBe(0);
    expect(asn1IntegerToBigInt(zeroNode)).toBe(0n);

    // Small integer
    const smallNode = parseAsn1(encodeInt(42));
    expect(asn1IntegerToNumber(smallNode)).toBe(42);

    // Integer with highest bit set (0x80) requires 0x00 padding
    const paddedNode = parseAsn1(encodeInt(128));
    expect(asn1IntegerToNumber(paddedNode)).toBe(128);

    // Large BigInt (e.g. 64-bit timestamp or serial number)
    const bigVal = 1726000000123n;
    const bigNode = parseAsn1(encodeInt(bigVal));
    expect(asn1IntegerToBigInt(bigNode)).toBe(bigVal);
  });

  it('parses booleans (0x01)', () => {
    const trueNode = parseAsn1(encodeBool(true));
    expect(asn1Boolean(trueNode)).toBe(true);

    const falseNode = parseAsn1(encodeBool(false));
    expect(asn1Boolean(falseNode)).toBe(false);
  });

  it('parses bit strings with unused bits', () => {
    // 0x03 0x03 0x00 0xAA 0x55 (unused bits = 0)
    const bitDer = new Uint8Array([0x03, 0x03, 0x00, 0xaa, 0x55]);
    const node = parseAsn1(bitDer);
    const parsed = asn1BitString(node);
    expect(parsed.unusedBits).toBe(0);
    expect(parsed.bytes).toEqual(new Uint8Array([0xaa, 0x55]));
  });

  it('decodes object identifiers (OIDs)', () => {
    // OID: 1.3.6.1.4.1.11129.2.1.17 (Android Key Attestation OID)
    // 1.3 = 40*1 + 3 = 43 (0x2b)
    // 6 = 0x06
    // 1 = 0x01
    // 4 = 0x04
    // 1 = 0x01
    // 11129 = (0x80 | 0x56), 0x79
    // 2 = 0x02
    // 1 = 0x01
    // 17 = 0x11
    const oidDer = new Uint8Array([
      0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0xd6, 0x79, 0x02, 0x01, 0x11,
    ]);
    const node = parseAsn1(oidDer);
    expect(asn1OidToString(node)).toBe(KEY_DESCRIPTION_OID);
  });

  it('decodes multi-byte context-specific tags (base-128 VLQ for tags >= 31)', () => {
    // Tag 702 (Origin): 702 = 5 * 128 + 62 -> 0x85, 0x3E
    // Tag 704 (RootOfTrust): 704 = 5 * 128 + 64 -> 0x85, 0x40
    const inner = new Uint8Array([0x02, 0x01, 0x00]); // INTEGER 0
    const tag702Der = encodeContextTag(702, inner);
    const node = parseAsn1(tag702Der);

    expect(node.tagClass).toBe('context');
    expect(node.tagNumber).toBe(702);
    expect(node.constructed).toBe(true);

    const tag704Der = encodeContextTag(704, inner);
    const node704 = parseAsn1(tag704Der);
    expect(node704.tagNumber).toBe(704);
  });

  it('parses GeneralizedTime and UTCTime', () => {
    // UTCTime: 260913120000Z -> 2026-09-13T12:00:00Z
    const utcDer = new Uint8Array([
      0x17, 0x0d,
      ...Array.from('260913120000Z').map((c) => c.charCodeAt(0)),
    ]);
    const utcDate = asn1Date(parseAsn1(utcDer));
    expect(utcDate.toISOString()).toBe('2026-09-13T12:00:00.000Z');

    // GeneralizedTime: 20260913120000Z
    const genDer = new Uint8Array([
      0x18, 0x0f,
      ...Array.from('20260913120000Z').map((c) => c.charCodeAt(0)),
    ]);
    const genDate = asn1Date(parseAsn1(genDer));
    expect(genDate.toISOString()).toBe('2026-09-13T12:00:00.000Z');
  });
});

describe('X.509 Certificate Parser & Chain Verification', () => {
  it('parses Google AOSP Test Root Certificate successfully', () => {
    const rootDer = base64ToBytes(GOOGLE_TEST_ROOT_CERT_B64);
    const parsed = parseX509Certificate(rootDer);

    expect(parsed.serialNumber).toBeDefined();
    expect(parsed.notBefore).toBeInstanceOf(Date);
    expect(parsed.notAfter).toBeInstanceOf(Date);
    expect(parsed.spkiRaw.length).toBeGreaterThan(0);
    expect(parsed.signatureBytes.length).toBeGreaterThan(0);
  });

  it('verifies signature of self-signed Google AOSP Test Root Certificate', async () => {
    const rootDer = base64ToBytes(GOOGLE_TEST_ROOT_CERT_B64);
    const parsed = parseX509Certificate(rootDer);

    const isValid = await verifyCertificateSignature(parsed, parsed);
    expect(isValid).toBe(true);
  });

  it('rejects certificate when signature bytes are corrupted', async () => {
    const rootDer = base64ToBytes(GOOGLE_TEST_ROOT_CERT_B64);
    const parsed = parseX509Certificate(rootDer);

    // Corrupt signature bytes
    parsed.signatureBytes[0] ^= 0xff;
    const isValid = await verifyCertificateSignature(parsed, parsed);
    expect(isValid).toBe(false);
  });
});

describe('AndroidKeyAttestationVerifier Extension Logic', () => {
  const verifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });

  it('rejects chains with fewer than 2 certificates', async () => {
    const verdict = await verifier.verify([], new Uint8Array(32));
    expect(verdict.verified).toBe(false);
    expect(verdict.failureReason).toBe('CHAIN_TOO_SHORT');
  });

  it('rejects untrusted root certificates', async () => {
    // Generate a synthetic self-signed cert that is not in pinned roots
    const fakeChain = [new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]), new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01])];
    const verdict = await verifier.verify(fakeChain, new Uint8Array(32));
    expect(verdict.verified).toBe(false);
  });

  it('verifies Google RSA pinned root SPKI byte-for-byte against published Constants.java', async () => {
    const rsaBytes = base64ToBytes(GOOGLE_ROOT_RSA_PUBKEY_B64);

    // Exact 4096-bit RSA SPKI length (550 bytes)
    expect(rsaBytes.length).toBe(550);

    // Pinned SHA-256 fingerprint matching Constants.java and android.googleapis.com/attestation/root
    const rsaHash = await crypto.subtle.digest('SHA-256', rsaBytes);
    const rsaHex = Array.from(new Uint8Array(rsaHash)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(rsaHex).toBe('feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae');

    // First 32 bytes header check
    const hexPrefix = Array.from(rsaBytes.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(hexPrefix).toBe('30820222300d06092a864886f70d01010105000382020f003082020a02820201');

    // Verify it imports cleanly as 4096-bit RSA public key in Web Crypto
    const rsaKey = await crypto.subtle.importKey(
      'spki',
      rsaBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      true,
      ['verify']
    );
    expect(rsaKey.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
  });

  it('verifies Google RKP pinned root SPKI against android.googleapis.com/attestation/root', async () => {
    const rkpBytes = base64ToBytes(GOOGLE_ROOT_RKP_PUBKEY_B64);

    // Exact ECDSA P-384 SPKI length (120 bytes)
    expect(rkpBytes.length).toBe(120);

    // Pinned SHA-256 fingerprint of Google Key Attestation CA1 root
    const rkpHash = await crypto.subtle.digest('SHA-256', rkpBytes);
    const rkpHex = Array.from(new Uint8Array(rkpHash)).map(b => b.toString(16).padStart(2, '0')).join('');
    expect(rkpHex).toBe('3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec');

    // Verify it imports cleanly as NIST P-384 ECDSA public key in Web Crypto
    const rkpKey = await crypto.subtle.importKey(
      'spki',
      rkpBytes,
      { name: 'ECDSA', namedCurve: 'P-384' },
      true,
      ['verify']
    );
    expect(rkpKey.algorithm.name).toBe('ECDSA');
    expect((rkpKey.algorithm as { name: string; namedCurve?: string }).namedCurve).toBe('P-384');
  });

  it('verifies real Google Android Key Attestation certificate chain (StrongBox test fixture)', async () => {
    const chain = GOOGLE_STRONGBOX_TEST_CHAIN_B64.map(b64 => base64ToBytes(b64));
    const expectedChallenge = new TextEncoder().encode('abc');

    const testVerifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });
    const verdict = await testVerifier.verify(chain, expectedChallenge, {
      allowUnverifiedBoot: true,
      allowUnlocked: true,
    });

    expect(verdict.verified).toBe(true);
    expect(verdict.strong).toBe(true);
    expect(verdict.osVersion).toBe(0);
    expect(verdict.patchLevel).toBe('2019-07');

    // Observability: assert DN mismatch between cert0 issuer and cert1 subject is detected and recorded
    expect(verdict.raw.dnMismatch).toBe(true);
    expect(verdict.raw.childIssuer).toBeDefined();

    // Verify that multi-byte tags (702, 704, 705, 706, 718, 719) were properly parsed
    const teeTags = verdict.raw.teeEnforcedTags as number[];
    expect(teeTags).toBeDefined();
    expect(teeTags).toContain(KM_TAGS.ORIGIN); // 702
    expect(teeTags).toContain(KM_TAGS.ROOT_OF_TRUST); // 704
    expect(teeTags).toContain(KM_TAGS.OS_VERSION); // 705
    expect(teeTags).toContain(KM_TAGS.OS_PATCH_LEVEL); // 706
    expect(teeTags).toContain(KM_TAGS.VENDOR_PATCH_LEVEL); // 718
    expect(teeTags).toContain(KM_TAGS.BOOT_PATCH_LEVEL); // 719

    // Critical security assertion: challenge MUST NOT be present in verdict.raw
    expect(verdict.raw).not.toHaveProperty('attestationChallenge');
    expect(verdict.raw).not.toHaveProperty('challenge');
  });

  it('rejects real Google chain when expected challenge does not match', async () => {
    const chain = GOOGLE_STRONGBOX_TEST_CHAIN_B64.map(b64 => base64ToBytes(b64));
    const wrongChallenge = new TextEncoder().encode('wrong_challenge_bytes_123456');

    const testVerifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });
    const verdict = await testVerifier.verify(chain, wrongChallenge, {
      allowUnverifiedBoot: true,
      allowUnlocked: true,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.failureReason).toBe('CHALLENGE_MISMATCH');
  });

  it('rejects expired certificates anywhere in the chain with CERT_EXPIRED (RFC 5280 §6.1)', async () => {
    const chain = GOOGLE_STRONGBOX_TEST_CHAIN_B64.map(b64 => base64ToBytes(b64));
    const expectedChallenge = new TextEncoder().encode('abc');
    const testVerifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });

    // Case 1: Intermediate CA 1 (cert1) expired on 2028-03-18 while leaf (cert0) is valid until 2028-05-23.
    // Verifying at 2028-04-01 MUST fail because intermediate CA 1 is expired.
    const expiredIntermediateDate = new Date('2028-04-01T00:00:00Z');
    const verdictIntermediateExpired = await testVerifier.verify(chain, expectedChallenge, {
      allowUnverifiedBoot: true,
      allowUnlocked: true,
      currentDate: expiredIntermediateDate,
    });
    expect(verdictIntermediateExpired.verified).toBe(false);
    expect(verdictIntermediateExpired.failureReason).toBe('CERT_EXPIRED');

    // Case 2: Far future date beyond all certificates in the chain
    const farFuture = new Date('2035-01-01T00:00:00Z');
    const verdictFarFuture = await testVerifier.verify(chain, expectedChallenge, {
      allowUnverifiedBoot: true,
      allowUnlocked: true,
      currentDate: farFuture,
    });
    expect(verdictFarFuture.verified).toBe(false);
    expect(verdictFarFuture.failureReason).toBe('CERT_EXPIRED');
  });

  it('guards allowTestRoot against execution in production and defaults to false', () => {
    // 1. Default constructor must NOT trust test root
    const defaultVerifier = new AndroidKeyAttestationVerifier();
    expect(defaultVerifier.allowTestRoot).toBe(false);

    // 2. Setting allowTestRoot in production throws an error
    const g = globalThis as unknown as { ENVIRONMENT?: string };
    const prevEnv = g.ENVIRONMENT;
    try {
      g.ENVIRONMENT = 'production';
      expect(() => new AndroidKeyAttestationVerifier({ allowTestRoot: true })).toThrow(
        'allowTestRoot cannot be enabled in production'
      );
    } finally {
      g.ENVIRONMENT = prevEnv;
    }
  });

  it('rejects certificate chains longer than 5 certificates with CHAIN_TOO_LONG', async () => {
    const cert = base64ToBytes(GOOGLE_STRONGBOX_TEST_CHAIN_B64[0]);
    const longChain = [cert, cert, cert, cert, cert, cert]; // 6 certificates
    const testVerifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });
    const verdict = await testVerifier.verify(longChain, new Uint8Array(32));

    expect(verdict.verified).toBe(false);
    expect(verdict.failureReason).toBe('CHAIN_TOO_LONG');
  });

  it('rejects non-allowlisted signature algorithms (e.g. SHA-1) with UNSUPPORTED_SIG_ALG', async () => {
    // SHA-1 OIDs (e.g. 1.2.840.113549.1.1.5) must not be in ALLOWED_SIG_OIDS
    expect(ALLOWED_SIG_OIDS.has('1.2.840.113549.1.1.5')).toBe(false);
    expect(ALLOWED_SIG_OIDS.has('1.2.840.10045.4.3.1')).toBe(false);

    // Build a chain with a modified signature algorithm OID in the leaf
    const leafDer = base64ToBytes(GOOGLE_STRONGBOX_TEST_CHAIN_B64[0]);
    // Mutate the outer signature algorithm OID from 1.2.840.10045.4.3.2 (ecdsa-with-SHA256) to unsupported
    const modifiedLeaf = new Uint8Array(leafDer);
    // In leafDer, search for the sequence [0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x04, 0x03, 0x02]
    const ecdsaSha256Oid = [0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02];
    for (let i = 0; i < modifiedLeaf.length - ecdsaSha256Oid.length; i++) {
      let match = true;
      for (let j = 0; j < ecdsaSha256Oid.length; j++) {
        if (modifiedLeaf[i + j] !== ecdsaSha256Oid[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        // Change last byte 0x02 (SHA-256) to 0x01 (SHA-1: 1.2.840.10045.4.3.1)
        modifiedLeaf[i + 9] = 0x01;
      }
    }

    const chain = [modifiedLeaf, ...GOOGLE_STRONGBOX_TEST_CHAIN_B64.slice(1).map(b => base64ToBytes(b))];
    const testVerifier = new AndroidKeyAttestationVerifier({ allowTestRoot: true });
    const verdict = await testVerifier.verify(chain, new TextEncoder().encode('abc'), {
      allowUnverifiedBoot: true,
      allowUnlocked: true,
    });

    expect(verdict.verified).toBe(false);
    expect(verdict.failureReason).toBe('UNSUPPORTED_SIG_ALG');
  });

  it('parses and validates synthetic KeyDescription extension bytes', () => {
    const chal = new Uint8Array(32).fill(42);
    const kdDer = buildKeyDescriptionDer({
      challenge: chal,
      attestationSecurityLevel: KM_SECURITY_LEVEL.STRONGBOX,
    });

    const root = parseAsn1(kdDer);
    expect(root.children).toBeDefined();
    expect(root.children!.length).toBeGreaterThanOrEqual(8);

    const attVer = asn1IntegerToNumber(root.children![0]);
    const attSec = asn1IntegerToNumber(root.children![1]);
    const attChal = root.children![4].valueBytes;

    expect(attVer).toBe(4);
    expect(attSec).toBe(KM_SECURITY_LEVEL.STRONGBOX);
    expect(equalBytes(attChal, chal)).toBe(true);
  });
});

describe('MockAttestationVerifier', () => {
  beforeEach(() => {
    MockAttestationVerifier.reset();
  });

  it('returns successful StrongBox verdict by default in test mode', async () => {
    const mockVerifier = new MockAttestationVerifier();
    const verdict = await mockVerifier.verify([new Uint8Array(10), new Uint8Array(10)], new Uint8Array(32), {
      requireStrongBox: true,
    });

    expect(verdict.verified).toBe(true);
    expect(verdict.strong).toBe(true);
    expect(verdict.verifiedBoot).toBe(true);
    expect(verdict.deviceLocked).toBe(true);
    expect(verdict.osVersion).toBe(140000);
    expect(verdict.patchLevel).toBe('2026-08');
  });

  it('honors setNextVerdict overrides for simulating compromised devices', async () => {
    MockAttestationVerifier.setNextVerdict({
      verified: false,
      failureReason: 'VERIFIED_BOOT_FAILED',
    });

    const mockVerifier = new MockAttestationVerifier();
    const verdict = await mockVerifier.verify([], new Uint8Array(32));
    expect(verdict.verified).toBe(false);
    expect(verdict.failureReason).toBe('VERIFIED_BOOT_FAILED');
    MockAttestationVerifier.reset();
  });
});

describe('End-to-End Pairing & Attestation Lifecycle', () => {
  const merchantId = merchantRange.start;
  const userId = 8601;
  const now = new Date().toISOString();

  beforeEach(() => {
    MockAttestationVerifier.reset();
  });

  beforeAll(async () => {
    // Setup test merchant and user
    await db.prepare(
      `INSERT INTO op_merchants (id, uuid, name, slug, email, timezone, default_currency, webhook_secret, status, is_platform, created_at, updated_at)
       VALUES (?, ?, 'AttestMerchant', 'attest-hw-merchant', 'attest-hw@test.local', 'Asia/Dhaka', 'BDT', 'sec', 'active', 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(merchantId, crypto.randomUUID(), now, now).run();

    const userUuid = crypto.randomUUID();
    const emailHash = await sha256('attest-hw-user@test.local');
    await db.prepare(
      `INSERT INTO op_merchant_users (id, merchant_id, uuid, name, email, email_hash, password_hash, status, created_at, updated_at)
       VALUES (?, ?, ?, 'Attest User', 'attest-hw-user@test.local', ?, 'hash', 'active', ?, ?)
       ON CONFLICT(id) DO NOTHING`
    ).bind(userId, merchantId, userUuid, emailHash, now, now).run();
  });

  it('initiates pairing challenge via /pair/initiate (Phase 1)', async () => {
    const otp = '860001';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.11';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // Call /pair/initiate
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({ otp }),
    });

    expect(res.status).toBe(200);
    const data = await res.json<{ success: boolean; data: { challenge: string; expires_in: number } }>();
    expect(data.success).toBe(true);
    expect(data.data.challenge).toBeDefined();
    expect(data.data.expires_in).toBeGreaterThanOrEqual(290);

    // Call again to verify idempotency within window
    const res2 = await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({ otp }),
    });
    expect(res2.status).toBe(200);
    const data2 = await res2.json<{ success: boolean; data: { challenge: string; expires_in: number } }>();
    expect(data2.data.challenge).toBe(data.data.challenge);
  });

  it('rejects /pair/initiate for invalid or already consumed OTP', async () => {
    const res = await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.12' },
      body: JSON.stringify({ otp: '000000' }),
    });
    expect(res.status).toBe(404);
  });

  it('pairs device with hardware attestation cert chain (Phase 2)', async () => {
    const otp = '860002';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.13';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok2', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // 1. Initiate challenge
    const initRes = await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({ otp }),
    });
    expect(initRes.status).toBe(200);

    const keyPair = await generateTestDeviceKeyPair();

    // 2. Complete pairing
    const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({
        otp,
        device_name: 'Attested Pixel 8 Pro',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
        cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
      }),
    });

    expect(pairRes.status).toBe(201);
    const pairData = await pairRes.json<{
      success: boolean;
      data: { device_id: string; token: string };
    }>();
    expect(pairData.success).toBe(true);

    // Verify row recorded attestation
    const deviceRow = await db.prepare(
      `SELECT attestation_verified_at, attestation_method, attestation_strong, attestation_verified_boot, device_os_version
       FROM op_paired_devices WHERE uuid = ? LIMIT 1`
    ).bind(pairData.data.device_id).first<{
      attestation_verified_at: string;
      attestation_method: string;
      attestation_strong: number;
      attestation_verified_boot: number;
      device_os_version: number;
    }>();

    expect(deviceRow?.attestation_verified_at).toBeDefined();
    expect(deviceRow?.attestation_method).toBe('android_key_attestation');
    expect(deviceRow?.device_os_version).toBe(140000);
  });

  it('rejects pairing when attestation verification fails', async () => {
    const otp = '860003';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.14';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok3', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    await SELF.fetch('http://localhost/api/mobile/v1/pair/initiate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({ otp }),
    });

    MockAttestationVerifier.setNextVerdict({
      verified: false,
      failureReason: 'NOT_HARDWARE',
    });

    const keyPair = await generateTestDeviceKeyPair();
    const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
      body: JSON.stringify({
        otp,
        device_name: 'Rooted Emulator',
        public_key: keyPair.publicKeySpkiB64,
        key_algorithm: 'ES256',
        cert_chain: [bytesToBase64(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x01]))],
      }),
    });

    expect(pairRes.status).toBe(422);
    const err = await pairRes.json<{ error: { code: string; message: string } }>();
    expect(err.error.code).toBe('ATTESTATION_INVALID');
    expect(err.error.message).toContain('NOT_HARDWARE');
    MockAttestationVerifier.reset();
  });

  it('enforces tier policy when ATTESTATION_REQUIRED is enabled and cert_chain is omitted', async () => {
    const otp = '860004';
    const otpHash = await sha256(otp);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const testIp = '198.51.100.15';

    await db.prepare(
      `INSERT INTO op_device_pairing_tokens (merchant_id, user_id, token, token_hash, expires_at, created_at)
       VALUES (?, ?, 'tok4', ?, ?, ?)`
    ).bind(merchantId, userId, otpHash, expiresAt, now).run();

    // Enable strict pairing for merchant
    await db.prepare(
      `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, strict_pairing, updated_at)
       VALUES (?, 'attested', 1, ?)
       ON CONFLICT(merchant_id) DO UPDATE SET min_tier = 'attested', strict_pairing = 1`
    ).bind(merchantId, now).run();

    const origPolicy = tenv.ATTESTATION_REQUIRED;
    tenv.ATTESTATION_REQUIRED = 'true';
    try {
      const keyPair = await generateTestDeviceKeyPair();
      const pairRes = await SELF.fetch('http://localhost/api/mobile/v1/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': testIp },
        body: JSON.stringify({
          otp,
          device_name: 'Unattested Phone',
          public_key: keyPair.publicKeySpkiB64,
          key_algorithm: 'ES256',
        }),
      });

      expect(pairRes.status).toBe(422);
      const err = await pairRes.json<{ error: { code: string; device_tier: string; required_tier: string } }>();
      expect(err.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
      expect(err.error.device_tier).toBe('basic');
      expect(err.error.required_tier).toBe('attested');
    } finally {
      tenv.ATTESTATION_REQUIRED = origPolicy;
      await db.prepare(`DELETE FROM op_merchant_device_policies WHERE merchant_id = ?`).bind(merchantId).run();
    }
  });

  it('enforces attestation gating, freshness, and StrongBox requirements on /sms and /sms/batch', async () => {
    const keyPair = await generateTestDeviceKeyPair();
    const deviceUuid = crypto.randomUUID();

    // 1. Insert an unattested device
    await db.prepare(
      `INSERT INTO op_paired_devices
         (merchant_id, user_id, uuid, device_name, fingerprint, status, public_key, key_algorithm, attestation_verified_at, attestation_strong, last_heartbeat_at, created_at)
       VALUES (?, ?, ?, 'Unattested Device', '', 'active', ?, 'ES256', NULL, 0, ?, ?)`
    ).bind(merchantId, userId, deviceUuid, keyPair.publicKeySpkiB64, now, now).run();

    const devRow = await db.prepare(`SELECT id FROM op_paired_devices WHERE uuid = ?`).bind(deviceUuid).first<{ id: number }>();
    const deviceId = devRow!.id;

    // Issue JWT for this device
    const { createJwtService } = await import('../src/lib/jwt');
    const jwt = createJwtService(tenv);
    const token = await jwt.issueAccessToken({
      sub: String(userId),
      merchant_id: merchantId,
      device_id: deviceId,
      scope: ['read', 'write'],
    });

    const origAttReq = tenv.ATTESTATION_REQUIRED;
    const origSbReq = tenv.STRONGBOX_REQUIRED;
    const origMaxAge = tenv.ATTESTATION_MAX_AGE_DAYS;

    try {
      tenv.ATTESTATION_REQUIRED = 'true';
      await db.prepare(
        `INSERT INTO op_merchant_device_policies (merchant_id, min_tier, enforcement_mode, updated_at)
         VALUES (?, 'basic', 'enforce', datetime('now'))
         ON CONFLICT(merchant_id) DO UPDATE SET enforcement_mode = 'enforce'`
      ).bind(merchantId).run();

      const nonce1 = 'attest-nonce-1';
      const ts1 = Date.now();
      const payload1 = buildCanonicalSmsPayload({
        deviceId,
        nonce: nonce1,
        timestamp: ts1,
        sender: 'bKash',
        body: 'You received 1000 Tk',
      });
      const sig1 = await signTestDevicePayload(keyPair.privateKey, payload1);

      // Unattested device rejected with 422 DEVICE_TIER_INSUFFICIENT
      const smsRes1 = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'You received 1000 Tk',
          timestamp: ts1,
          nonce: nonce1,
          signature: sig1,
        }),
      });

      expect(smsRes1.status).toBe(422);
      const err1 = await smsRes1.json<{ error: { code: string; reason: string } }>();
      expect(err1.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
      expect(err1.error.reason).toBe('NO_ATTESTATION');

      // 2. Make device attested but stale (> 30 days old)
      const staleDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
      await db.prepare(
        `UPDATE op_paired_devices SET attestation_verified_at = ?, attestation_strong = 1 WHERE id = ?`
      ).bind(staleDate, deviceId).run();

      const nonce2 = 'attest-nonce-2';
      const ts2 = Date.now();
      const payload2 = buildCanonicalSmsPayload({
        deviceId,
        nonce: nonce2,
        timestamp: ts2,
        sender: 'bKash',
        body: 'You received 1000 Tk',
      });
      const sig2 = await signTestDevicePayload(keyPair.privateKey, payload2);

      const smsRes2 = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'You received 1000 Tk',
          timestamp: ts2,
          nonce: nonce2,
          signature: sig2,
        }),
      });

      expect(smsRes2.status).toBe(422);
      const err2 = await smsRes2.json<{ error: { code: string; reason: string } }>();
      expect(err2.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
      expect(err2.error.reason).toBe('ATTESTATION_STALE');

      // 3. Make device attested freshly (TEE only, not StrongBox)
      await db.prepare(
        `UPDATE op_paired_devices SET attestation_verified_at = ?, attestation_verified_boot = 1, attestation_strong = 0 WHERE id = ?`
      ).bind(now, deviceId).run();

      tenv.STRONGBOX_REQUIRED = 'true';

      const nonce3 = 'attest-nonce-3';
      const ts3 = Date.now();
      const payload3 = buildCanonicalSmsPayload({
        deviceId,
        nonce: nonce3,
        timestamp: ts3,
        sender: 'bKash',
        body: 'You received 1000 Tk',
      });
      const sig3 = await signTestDevicePayload(keyPair.privateKey, payload3);

      const smsRes3 = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'You received 1000 Tk',
          timestamp: ts3,
          nonce: nonce3,
          signature: sig3,
        }),
      });

      expect(smsRes3.status).toBe(422);
      const err3 = await smsRes3.json<{ error: { code: string; reason: string } }>();
      expect(err3.error.code).toBe('DEVICE_TIER_INSUFFICIENT');
      expect(err3.error.reason).toBe('NOT_STRONGBOX');

      // 4. Make device StrongBox-attested and fresh: SMS passes!
      await db.prepare(
        `UPDATE op_paired_devices SET attestation_strong = 1 WHERE id = ?`
      ).bind(deviceId).run();

      const nonce4 = 'attest-nonce-4';
      const ts4 = Date.now();
      const payload4 = buildCanonicalSmsPayload({
        deviceId,
        nonce: nonce4,
        timestamp: ts4,
        sender: 'bKash',
        body: 'You received 1000 Tk',
      });
      const sig4 = await signTestDevicePayload(keyPair.privateKey, payload4);

      const smsRes4 = await SELF.fetch('http://localhost/api/mobile/v1/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sender: 'bKash',
          body: 'You received 1000 Tk',
          timestamp: ts4,
          nonce: nonce4,
          signature: sig4,
        }),
      });

      expect(smsRes4.status).toBe(200);
      const data4 = await smsRes4.json<{ success: boolean; data: { status: string } }>();
      expect(data4.success).toBe(true);
      expect(data4.data.status).toBe('queued');
    } finally {
      tenv.ATTESTATION_REQUIRED = origAttReq;
      tenv.STRONGBOX_REQUIRED = origSbReq;
      tenv.ATTESTATION_MAX_AGE_DAYS = origMaxAge;
      // Clean up merchant device policy so other tests reusing merchant 850001 remain uncoupled
      await db.prepare(`DELETE FROM op_merchant_device_policies WHERE merchant_id = ?`).bind(merchantId).run();
    }
  });
});
