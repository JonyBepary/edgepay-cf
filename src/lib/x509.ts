/**
 * Lightweight X.509 Certificate Parser & Chain Verifier.
 *
 * Implements narrow X.509 v3 parsing and signature verification using
 * standard Web Crypto (crypto.subtle) without third-party dependencies.
 */

import {
  parseAsn1,
  asn1IntegerToBigInt,
  asn1BitString,
  asn1OidToString,
  asn1Date,
  asn1Boolean,
  type Asn1Node,
} from './asn1';
import { derToP1363 } from './device-crypto';

export interface X509Extension {
  oid: string;
  critical: boolean;
  extnValue: Uint8Array;
}

export interface ParsedX509Certificate {
  raw: Uint8Array;
  tbsRaw: Uint8Array;
  serialNumber: bigint;
  signatureAlgorithmOid: string;
  signatureBytes: Uint8Array;
  issuerRaw: Uint8Array;
  subjectRaw: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  spkiRaw: Uint8Array;
  spkiNode: Asn1Node;
  extensions: Map<string, X509Extension>;
}

export const ALLOWED_SIG_OIDS = new Set<string>([
  '1.2.840.113549.1.1.11',  // sha256WithRSAEncryption
  '1.2.840.113549.1.1.12',  // sha384WithRSAEncryption
  '1.2.840.113549.1.1.13',  // sha512WithRSAEncryption
  '1.2.840.10045.4.3.2',    // ecdsa-with-SHA256
  '1.2.840.10045.4.3.3',    // ecdsa-with-SHA384
  '1.2.840.10045.4.3.4',    // ecdsa-with-SHA512
]);

const SIG_ALGS: Record<string, { name: string; hash: string }> = {
  // RSASSA-PKCS1-v1_5
  '1.2.840.113549.1.1.11': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
  '1.2.840.113549.1.1.12': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
  '1.2.840.113549.1.1.13': { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' },
  // ECDSA
  '1.2.840.10045.4.3.2': { name: 'ECDSA', hash: 'SHA-256' },
  '1.2.840.10045.4.3.3': { name: 'ECDSA', hash: 'SHA-384' },
  '1.2.840.10045.4.3.4': { name: 'ECDSA', hash: 'SHA-512' },
};

/**
 * Parses an X.509 certificate from DER bytes.
 */
export function parseX509Certificate(certDer: Uint8Array): ParsedX509Certificate {
  const root = parseAsn1(certDer);
  if (!root.children || root.children.length < 3) {
    throw new Error('Invalid X.509 certificate structure');
  }

  const tbsNode = root.children[0];
  const sigAlgNode = root.children[1];
  const sigValNode = root.children[2];

  const tbsRaw = tbsNode.raw;
  const sigAlgOid = asn1OidToString(sigAlgNode.children ? sigAlgNode.children[0] : sigAlgNode);
  const sigBitString = asn1BitString(sigValNode);
  const signatureBytes = sigBitString.bytes;

  if (!tbsNode.children || tbsNode.children.length < 6) {
    throw new Error('Invalid TBSCertificate structure');
  }

  let idx = 0;
  // Version [0] EXPLICIT INTEGER (optional, defaults to v1)
  if (tbsNode.children[idx].tagClass === 'context' && tbsNode.children[idx].tagNumber === 0) {
    idx++;
  }

  const serialNumberNode = tbsNode.children[idx++];
  const serialNumber = asn1IntegerToBigInt(serialNumberNode);

  // Skip signature AlgorithmIdentifier in TBS (already read from outer)
  idx++;

  const issuerNode = tbsNode.children[idx++];
  const issuerRaw = issuerNode.raw;

  const validityNode = tbsNode.children[idx++];
  if (!validityNode.children || validityNode.children.length < 2) {
    throw new Error('Invalid Validity structure');
  }
  const notBefore = asn1Date(validityNode.children[0]);
  const notAfter = asn1Date(validityNode.children[1]);

  const subjectNode = tbsNode.children[idx++];
  const subjectRaw = subjectNode.raw;

  const spkiNode = tbsNode.children[idx++];
  const spkiRaw = spkiNode.raw;

  // Extensions [3] EXPLICIT Extensions OPTIONAL
  const extensions = new Map<string, X509Extension>();
  while (idx < tbsNode.children.length) {
    const optNode = tbsNode.children[idx++];
    if (optNode.tagClass === 'context' && optNode.tagNumber === 3) {
      // optNode has children: [0] -> SEQUENCE of Extension
      const extsSeq = optNode.children?.[0];
      if (extsSeq?.children) {
        for (const extNode of extsSeq.children) {
          if (!extNode.children || extNode.children.length < 2) continue;
          const extOid = asn1OidToString(extNode.children[0]);
          let critical = false;
          let valIdx = 1;
          if (extNode.children.length > 2 && extNode.children[1].tagNumber === 0x01) {
            critical = asn1Boolean(extNode.children[1]);
            valIdx = 2;
          }
          const valNode = extNode.children[valIdx];
          extensions.set(extOid, {
            oid: extOid,
            critical,
            extnValue: valNode.valueBytes,
          });
        }
      }
    }
  }

  return {
    raw: certDer,
    tbsRaw,
    serialNumber,
    signatureAlgorithmOid: sigAlgOid,
    signatureBytes,
    issuerRaw,
    subjectRaw,
    notBefore,
    notAfter,
    spkiRaw,
    spkiNode,
    extensions,
  };
}

/**
 * Checks byte-for-byte equality of two Uint8Arrays.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Verifies that a child certificate is correctly signed by parent certificate.
 */
export async function verifyCertificateSignature(
  child: ParsedX509Certificate,
  parent: ParsedX509Certificate
): Promise<boolean> {
  if (!ALLOWED_SIG_OIDS.has(child.signatureAlgorithmOid)) {
    throw new Error(`UNSUPPORTED_SIG_ALG: ${child.signatureAlgorithmOid}`);
  }
  const algInfo = SIG_ALGS[child.signatureAlgorithmOid];
  if (!algInfo) {
    throw new Error(`UNSUPPORTED_SIG_ALG: ${child.signatureAlgorithmOid}`);
  }

  try {
    let cryptoKey: CryptoKey;
    let signatureToVerify: Uint8Array = child.signatureBytes;

    if (algInfo.name === 'RSASSA-PKCS1-v1_5') {
      cryptoKey = await crypto.subtle.importKey(
        'spki',
        parent.spkiRaw,
        { name: 'RSASSA-PKCS1-v1_5', hash: algInfo.hash },
        false,
        ['verify']
      );
    } else if (algInfo.name === 'ECDSA') {
      let curve = 'P-256';
      let keySize = 32;
      try {
        const algId = parent.spkiNode.children?.[0];
        if (algId?.children && algId.children.length > 1) {
          const curveOid = asn1OidToString(algId.children[1]);
          if (curveOid === '1.3.132.0.34') {
            curve = 'P-384';
            keySize = 48;
          } else if (curveOid === '1.3.132.0.35') {
            curve = 'P-521';
            keySize = 66;
          }
        }
      } catch {
        // Fall back to P-256
      }

      cryptoKey = await crypto.subtle.importKey(
        'spki',
        parent.spkiRaw,
        { name: 'ECDSA', namedCurve: curve },
        false,
        ['verify']
      );
      // X.509 ECDSA signature is ASN.1 DER (r || s); convert to IEEE P1363 for Web Crypto
      signatureToVerify = derToP1363(child.signatureBytes, keySize);
    } else {
      return false;
    }

    return await crypto.subtle.verify(
      algInfo.name === 'ECDSA' ? { name: 'ECDSA', hash: algInfo.hash } : { name: 'RSASSA-PKCS1-v1_5' },
      cryptoKey,
      signatureToVerify,
      child.tbsRaw
    );
  } catch {
    return false;
  }
}
