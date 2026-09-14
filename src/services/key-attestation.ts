/**
 * Android Hardware Key Attestation Verifier.
 *
 * Validates hardware-backed TEE / StrongBox key attestation chains (Keymaster / Keymint)
 * against Google's hardware root certificates per AOSP Attestation specification.
 *
 * References:
 *   - https://developer.android.com/privacy-and-security/security-key-attestation
 *   - AOSP: hardware/interfaces/security/keymint/aidl/android/hardware/security/keymint/Attestation.kt
 */

import {
  parseAsn1,
  asn1IntegerToNumber,
  asn1Boolean,
  type Asn1Node,
} from '../lib/asn1';
import {
  parseX509Certificate,
  verifyCertificateSignature,
  equalBytes,
  ALLOWED_SIG_OIDS,
  type ParsedX509Certificate,
} from '../lib/x509';
import { base64ToBytes, bytesToBase64, bytesToHex } from '../lib/crypto';
import type { Env } from '../types/env';
import {
  GOOGLE_ROOT_RSA_PUBKEY_B64,
  GOOGLE_ROOT_RKP_PUBKEY_B64,
  GOOGLE_TEST_ROOT_CERT_B64,
} from './key-attestation-roots';

export const KEY_DESCRIPTION_OID = '1.3.6.1.4.1.11129.2.1.17';

// Keymaster / Keymint tag definitions
export const KM_TAGS = {
  PURPOSE: 1,
  ALGORITHM: 2,
  KEY_SIZE: 3,
  DIGEST: 5,
  EC_CURVE: 10,
  NO_AUTH_REQUIRED: 503,
  USER_AUTH_TYPE: 504,
  AUTH_TIMEOUT: 505,
  ALL_APPLICATIONS: 600,
  ORIGIN: 702,
  ROOT_OF_TRUST: 704,
  OS_VERSION: 705,
  OS_PATCH_LEVEL: 706,
  VENDOR_PATCH_LEVEL: 718,
  BOOT_PATCH_LEVEL: 719,
} as const;

export const KM_PURPOSE = {
  SIGN: 2,
} as const;

export const KM_ALGORITHM = {
  EC: 3,
} as const;

export const KM_EC_CURVE = {
  P256: 1,
} as const;

export const KM_ORIGIN = {
  GENERATED: 0,
} as const;

export const KM_SECURITY_LEVEL = {
  SOFTWARE: 0,
  TRUSTED_ENVIRONMENT: 1,
  STRONGBOX: 2,
} as const;

export const KM_VERIFIED_BOOT_STATE = {
  VERIFIED: 0,
  SELF_SIGNED: 1,
  UNVERIFIED: 2,
  FAILED: 3,
} as const;

export interface AttestationVerdict {
  verified: boolean;
  strong: boolean;              // StrongBox (2) vs TEE (1)
  verifiedBoot: boolean;        // vbState == VERIFIED (0)
  deviceLocked: boolean;
  osVersion: number;            // e.g. 140000 for Android 14
  patchLevel: string;           // YYYY-MM
  raw: Record<string, unknown>; // extension contents for audit (attestationChallenge redacted)
  failureReason?: string;
}

export interface AttestationVerifyOptions {
  allowUnverifiedBoot?: boolean;
  allowUnlocked?: boolean;
  requireStrongBox?: boolean;
  currentDate?: Date;
  env?: Env;
  merchantId?: number;
}

export interface AttestationVerifier {
  verify(
    chain: Uint8Array[],
    expectedChallenge: Uint8Array,
    options?: AttestationVerifyOptions
  ): Promise<AttestationVerdict>;
}

/**
 * Extracts tagged items from an AuthorizationList ASN.1 SEQUENCE.
 */
function parseAuthorizationList(seqNode?: Asn1Node): Map<number, Asn1Node> {
  const map = new Map<number, Asn1Node>();
  if (!seqNode?.children) return map;

  for (const item of seqNode.children) {
    if (item.tagClass === 'context') {
      // The context-specific tagNumber is the Keymaster tag (e.g. 1, 2, 702, 704)
      map.set(item.tagNumber, item);
    }
  }
  return map;
}

/**
 * Android Key Attestation Verifier implementation.
 */
export class AndroidKeyAttestationVerifier implements AttestationVerifier {
  readonly allowTestRoot: boolean;
  private readonly pinnedRoots: Uint8Array[];
  private readonly testRootCertDer?: Uint8Array;

  constructor(options?: { allowTestRoot?: boolean }) {
    const isProd =
      (typeof process !== 'undefined' && process.env?.NODE_ENV === 'production') ||
      (typeof globalThis !== 'undefined' && (globalThis as unknown as { ENVIRONMENT?: string }).ENVIRONMENT === 'production');
    if (options?.allowTestRoot && isProd) {
      throw new Error('allowTestRoot cannot be enabled in production');
    }
    this.allowTestRoot = options?.allowTestRoot === true;
    this.pinnedRoots = [
      base64ToBytes(GOOGLE_ROOT_RSA_PUBKEY_B64),
      base64ToBytes(GOOGLE_ROOT_RKP_PUBKEY_B64),
    ];
    if (this.allowTestRoot) {
      this.testRootCertDer = base64ToBytes(GOOGLE_TEST_ROOT_CERT_B64);
    }
  }

  async verify(
    chain: Uint8Array[],
    expectedChallenge: Uint8Array,
    options?: AttestationVerifyOptions
  ): Promise<AttestationVerdict> {
    if (!chain || chain.length < 2) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: {},
        failureReason: 'CHAIN_TOO_SHORT',
      };
    }

    if (chain.length > 5) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: {},
        failureReason: 'CHAIN_TOO_LONG',
      };
    }

    // 1. Parse all certificates in the chain
    const parsedCerts: ParsedX509Certificate[] = [];
    try {
      for (const der of chain) {
        parsedCerts.push(parseX509Certificate(der));
      }
    } catch {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: {},
        failureReason: 'CERT_PARSE_FAILED',
      };
    }

    const now = options?.currentDate ?? new Date();
    const rawAudit: Record<string, unknown> = {};

    // 2. Verify validity dates, signature algorithms, and signatures along the chain
    for (let i = 0; i < parsedCerts.length; i++) {
      const cert = parsedCerts[i];

      // RFC 5280 §6.1 requires checking validity on every certificate in the chain
      if (now < cert.notBefore || now > cert.notAfter) {
        return {
          verified: false,
          strong: false,
          verifiedBoot: false,
          deviceLocked: false,
          osVersion: 0,
          patchLevel: '',
          raw: rawAudit,
          failureReason: 'CERT_EXPIRED',
        };
      }

      if (!ALLOWED_SIG_OIDS.has(cert.signatureAlgorithmOid)) {
        return {
          verified: false,
          strong: false,
          verifiedBoot: false,
          deviceLocked: false,
          osVersion: 0,
          patchLevel: '',
          raw: rawAudit,
          failureReason: 'UNSUPPORTED_SIG_ALG',
        };
      }

      if (i < parsedCerts.length - 1) {
        const parent = parsedCerts[i + 1];

        // Observability: record DN mismatch if child issuer != parent subject
        if (!equalBytes(cert.issuerRaw, parent.subjectRaw)) {
          rawAudit.dnMismatch = true;
          rawAudit.childIssuer = bytesToHex(cert.issuerRaw.subarray(0, 16));
          if (options?.env) {
            try {
              const { metric } = await import('../lib/observability');
              metric(options.env, 'attestation_dn_mismatch', {
                merchant_id: options.merchantId,
                child_issuer: rawAudit.childIssuer as string,
              });
            } catch {
              // Observability failure non-fatal
            }
          }
        }

        try {
          const validSig = await verifyCertificateSignature(cert, parent);
          if (!validSig) {
            return {
              verified: false,
              strong: false,
              verifiedBoot: false,
              deviceLocked: false,
              osVersion: 0,
              patchLevel: '',
              raw: rawAudit,
              failureReason: 'CHAIN_SIGNATURE_INVALID',
            };
          }
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes('UNSUPPORTED_SIG_ALG')) {
            return {
              verified: false,
              strong: false,
              verifiedBoot: false,
              deviceLocked: false,
              osVersion: 0,
              patchLevel: '',
              raw: rawAudit,
              failureReason: 'UNSUPPORTED_SIG_ALG',
            };
          }
          return {
            verified: false,
            strong: false,
            verifiedBoot: false,
            deviceLocked: false,
            osVersion: 0,
            patchLevel: '',
            raw: rawAudit,
            failureReason: 'CHAIN_SIGNATURE_INVALID',
          };
        }
      }
    }

    // 3. Verify root of the chain against pinned Google Roots
    const rootCert = parsedCerts[parsedCerts.length - 1];
    let rootTrusted = false;

    for (const pinnedSpki of this.pinnedRoots) {
      if (equalBytes(rootCert.spkiRaw, pinnedSpki)) {
        rootTrusted = true;
        break;
      }
    }

    if (!rootTrusted && this.testRootCertDer) {
      const testRootParsed = parseX509Certificate(this.testRootCertDer);
      if (equalBytes(rootCert.spkiRaw, testRootParsed.spkiRaw) || equalBytes(rootCert.raw, this.testRootCertDer)) {
        rootTrusted = true;
      }
    }

    if (!rootTrusted) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'ROOT_NOT_TRUSTED',
      };
    }

    // 4. Extract Attestation Extension (OID 1.3.6.1.4.1.11129.2.1.17) from Leaf Cert
    const leafCert = parsedCerts[0];
    const attExt = leafCert.extensions.get(KEY_DESCRIPTION_OID);
    if (!attExt) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'EXTENSION_MISSING',
      };
    }

    // 5. Parse KeyDescription SEQUENCE
    let keyDesc: Asn1Node;
    try {
      keyDesc = parseAsn1(attExt.extnValue);
    } catch {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'KEY_DESCRIPTION_MALFORMED',
      };
    }

    if (!keyDesc.children || keyDesc.children.length < 8) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'KEY_DESCRIPTION_TRUNCATED',
      };
    }

    const attestationVersion = asn1IntegerToNumber(keyDesc.children[0]);
    const attestationSecurityLevel = asn1IntegerToNumber(keyDesc.children[1]);
    const keymasterVersion = asn1IntegerToNumber(keyDesc.children[2]);
    const keymasterSecurityLevel = asn1IntegerToNumber(keyDesc.children[3]);
    const attestationChallenge = keyDesc.children[4].valueBytes;
    const swEnforced = parseAuthorizationList(keyDesc.children[6]);
    const teeEnforced = parseAuthorizationList(keyDesc.children[7]);

    // Audit object
    Object.assign(rawAudit, {
      attestationVersion,
      attestationSecurityLevel,
      keymasterVersion,
      keymasterSecurityLevel,
      swEnforcedTags: Array.from(swEnforced.keys()),
      teeEnforcedTags: Array.from(teeEnforced.keys()),
    });

    // 6. Validate Attestation Challenge
    if (!equalBytes(attestationChallenge, expectedChallenge)) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'CHALLENGE_MISMATCH',
      };
    }

    // 7. Security Level Check (Software attestation must be rejected)
    if (attestationSecurityLevel === KM_SECURITY_LEVEL.SOFTWARE) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'NOT_HARDWARE',
      };
    }

    const strong = attestationSecurityLevel === KM_SECURITY_LEVEL.STRONGBOX;
    if (options?.requireStrongBox && !strong) {
      return {
        verified: false,
        strong: false,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'STRONGBOX_REQUIRED',
      };
    }

    // 8. Authorization list checks
    // AllApplications [600] MUST NOT be present
    if (swEnforced.has(KM_TAGS.ALL_APPLICATIONS) || teeEnforced.has(KM_TAGS.ALL_APPLICATIONS)) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'KEY_NOT_APP_SCOPED',
      };
    }

    // TEE-enforced is authoritative
    if (teeEnforced.size === 0) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'TEE_ENFORCED_EMPTY',
      };
    }

    // Origin [702] must be KM_ORIGIN_GENERATED (0)
    const originNode = teeEnforced.get(KM_TAGS.ORIGIN);
    if (!originNode || !originNode.children || asn1IntegerToNumber(originNode.children[0]) !== KM_ORIGIN.GENERATED) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'ORIGIN_INVALID',
      };
    }

    // Purpose [1] must include KM_PURPOSE_SIGN (2)
    const purposeNode = teeEnforced.get(KM_TAGS.PURPOSE);
    let hasSignPurpose = false;
    if (purposeNode?.children) {
      const target = purposeNode.children[0].children ? purposeNode.children[0].children : purposeNode.children;
      for (const p of target) {
        if (asn1IntegerToNumber(p) === KM_PURPOSE.SIGN) {
          hasSignPurpose = true;
          break;
        }
      }
    }
    if (!hasSignPurpose) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'PURPOSE_INVALID',
      };
    }

    // Algorithm [2] must be KM_ALGORITHM_EC (3)
    const algNode = teeEnforced.get(KM_TAGS.ALGORITHM);
    if (algNode?.children && asn1IntegerToNumber(algNode.children[0]) !== KM_ALGORITHM.EC) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'ALGORITHM_INVALID',
      };
    }

    // EcCurve [10] must be KM_EC_CURVE_P256 (1)
    const curveNode = teeEnforced.get(KM_TAGS.EC_CURVE);
    if (curveNode?.children && asn1IntegerToNumber(curveNode.children[0]) !== KM_EC_CURVE.P256) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'CURVE_INVALID',
      };
    }

    // RootOfTrust [704]
    const rootOfTrustNode = teeEnforced.get(KM_TAGS.ROOT_OF_TRUST);
    let verifiedBoot = false;
    let deviceLocked = false;

    if (rootOfTrustNode?.children) {
      const rotSeq = rootOfTrustNode.children[0];
      if (rotSeq.children && rotSeq.children.length >= 3) {
        deviceLocked = asn1Boolean(rotSeq.children[1]);
        const vbState = asn1IntegerToNumber(rotSeq.children[2]);
        verifiedBoot = vbState === KM_VERIFIED_BOOT_STATE.VERIFIED;
        rawAudit.rootOfTrust = {
          deviceLocked,
          verifiedBootState: vbState,
          verifiedBootKeyB64: bytesToBase64(rotSeq.children[0].valueBytes),
        };
      }
    }

    if (!verifiedBoot && !options?.allowUnverifiedBoot) {
      return {
        verified: false,
        strong,
        verifiedBoot: false,
        deviceLocked,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'VERIFIED_BOOT_FAILED',
      };
    }

    if (!deviceLocked && !options?.allowUnlocked) {
      return {
        verified: false,
        strong,
        verifiedBoot,
        deviceLocked: false,
        osVersion: 0,
        patchLevel: '',
        raw: rawAudit,
        failureReason: 'DEVICE_UNLOCKED',
      };
    }

    // OS Version [705] & OS Patch Level [706]
    let osVersion = 0;
    const osVerNode = teeEnforced.get(KM_TAGS.OS_VERSION);
    if (osVerNode?.children) {
      osVersion = asn1IntegerToNumber(osVerNode.children[0]);
      rawAudit.osVersion = osVersion;
    }

    let patchLevel = '';
    const patchNode = teeEnforced.get(KM_TAGS.OS_PATCH_LEVEL);
    if (patchNode?.children) {
      const patchInt = asn1IntegerToNumber(patchNode.children[0]);
      // Formatted as YYYYMM
      const year = Math.floor(patchInt / 100);
      const month = String(patchInt % 100).padStart(2, '0');
      patchLevel = `${year}-${month}`;
      rawAudit.osPatchLevel = patchLevel;
    }

    return {
      verified: true,
      strong,
      verifiedBoot,
      deviceLocked,
      osVersion,
      patchLevel,
      raw: rawAudit,
    };
  }
}

/**
 * Mock Attestation Verifier for hermetic unit and integration testing.
 */
export class MockAttestationVerifier implements AttestationVerifier {
  private static nextVerdict?: Partial<AttestationVerdict>;

  static setNextVerdict(verdict?: Partial<AttestationVerdict>): void {
    MockAttestationVerifier.nextVerdict = verdict;
  }

  static reset(): void {
    MockAttestationVerifier.nextVerdict = undefined;
  }

  async verify(
    _chain: Uint8Array[],
    _expectedChallenge: Uint8Array,
    options?: AttestationVerifyOptions
  ): Promise<AttestationVerdict> {
    if (MockAttestationVerifier.nextVerdict) {
      const v = MockAttestationVerifier.nextVerdict;
      return {
        verified: v.verified ?? true,
        strong: v.strong ?? (options?.requireStrongBox ? true : false),
        verifiedBoot: v.verifiedBoot ?? true,
        deviceLocked: v.deviceLocked ?? true,
        osVersion: v.osVersion ?? 140000,
        patchLevel: v.patchLevel ?? '2026-08',
        raw: v.raw ?? { mock: true },
        failureReason: v.failureReason,
      };
    }

    return {
      verified: true,
      strong: options?.requireStrongBox ? true : false,
      verifiedBoot: true,
      deviceLocked: true,
      osVersion: 140000,
      patchLevel: '2026-08',
      raw: { mock: true, simulated: 'hardware_backed_key_attestation' },
    };
  }
}
