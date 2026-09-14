/**
 * Narrow ASN.1 DER Parser.
 *
 * Implements strict, lightweight DER decoding for X.509 certificates and
 * Android Key Attestation (KeyDescription) extensions.
 *
 * Features:
 *   - Definite-length only (rejects indefinite length per DER specification)
 *   - Supports multi-byte tag numbers (base-128 VLQ for tags >= 31, e.g. 702, 704)
 *   - Universal and context-specific tagged types
 *   - Native BigInt and number extraction
 *   - Full OID decoding
 */

export type Asn1TagClass = 'universal' | 'application' | 'context' | 'private';

export interface Asn1Node {
  tag: number;
  tagClass: Asn1TagClass;
  constructed: boolean;
  tagNumber: number;
  headerLength: number;
  length: number;
  valueBytes: Uint8Array;
  raw: Uint8Array;
  children?: Asn1Node[];
}

export const ASN1_TAGS = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OBJECT_IDENTIFIER: 0x06,
  ENUMERATED: 0x0a,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x10, // When constructed: 0x30
  SET: 0x11,      // When constructed: 0x31
} as const;

/**
 * Parses a single ASN.1 DER node starting at offset.
 */
export function parseAsn1Node(bytes: Uint8Array, offset = 0): { node: Asn1Node; nextOffset: number } {
  const startOffset = offset;
  if (offset >= bytes.length) {
    throw new Error(`Unexpected end of ASN.1 data at offset ${offset}`);
  }

  const firstByte = bytes[offset++];
  const tagClassNum = (firstByte & 0xc0) >> 6;
  const tagClass: Asn1TagClass =
    tagClassNum === 0 ? 'universal' :
    tagClassNum === 1 ? 'application' :
    tagClassNum === 2 ? 'context' : 'private';

  const constructed = (firstByte & 0x20) !== 0;

  let tagNumber = firstByte & 0x1f;
  if (tagNumber === 0x1f) {
    // Multi-byte tag number (base-128 VLQ)
    tagNumber = 0;
    while (offset < bytes.length) {
      const b = bytes[offset++];
      tagNumber = (tagNumber << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }

  if (offset >= bytes.length) {
    throw new Error(`Truncated ASN.1 header at offset ${offset}`);
  }

  const lengthByte = bytes[offset++];
  let length: number;

  if ((lengthByte & 0x80) === 0) {
    // Short form (0..127)
    length = lengthByte;
  } else {
    const numOctets = lengthByte & 0x7f;
    if (numOctets === 0) {
      throw new Error('Indefinite length encoding is forbidden in DER');
    }
    if (numOctets > 4) {
      throw new Error(`ASN.1 element length exceeds 4 bytes (${numOctets})`);
    }
    if (offset + numOctets > bytes.length) {
      throw new Error(`Truncated ASN.1 multi-byte length at offset ${offset}`);
    }

    length = 0;
    for (let i = 0; i < numOctets; i++) {
      length = (length << 8) | bytes[offset++];
    }
  }

  if (offset + length > bytes.length) {
    throw new Error(`ASN.1 node value truncated: needed ${length} bytes, only ${bytes.length - offset} available`);
  }

  const headerLength = offset - startOffset;
  const valueBytes = bytes.subarray(offset, offset + length);
  const raw = bytes.subarray(startOffset, offset + length);
  const nextOffset = offset + length;

  let children: Asn1Node[] | undefined;
  if (constructed) {
    children = [];
    let childOffset = 0;
    while (childOffset < valueBytes.length) {
      const parsedChild = parseAsn1Node(valueBytes, childOffset);
      children.push(parsedChild.node);
      childOffset = parsedChild.nextOffset;
    }
  }

  return {
    node: {
      tag: firstByte,
      tagClass,
      constructed,
      tagNumber,
      headerLength,
      length,
      valueBytes,
      raw,
      children,
    },
    nextOffset,
  };
}

/**
 * Parses a top-level ASN.1 DER element.
 */
export function parseAsn1(bytes: Uint8Array): Asn1Node {
  return parseAsn1Node(bytes, 0).node;
}

/**
 * Decodes DER INTEGER to BigInt.
 */
export function asn1IntegerToBigInt(node: Asn1Node): bigint {
  const bytes = node.valueBytes;
  if (bytes.length === 0) {
    throw new Error('Zero-length ASN.1 INTEGER');
  }

  const isNegative = (bytes[0] & 0x80) !== 0;
  let val = 0n;

  if (isNegative) {
    // Two's complement negative
    for (let i = 0; i < bytes.length; i++) {
      val = (val << 8n) | BigInt(~bytes[i] & 0xff);
    }
    return -(val + 1n);
  }

  for (let i = 0; i < bytes.length; i++) {
    val = (val << 8n) | BigInt(bytes[i]);
  }
  return val;
}

/**
 * Decodes DER INTEGER to number (throws if exceeds safe integer range).
 */
export function asn1IntegerToNumber(node: Asn1Node): number {
  const big = asn1IntegerToBigInt(node);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`ASN.1 integer ${big} overflows JavaScript safe integer`);
  }
  return Number(big);
}

/**
 * Decodes DER BOOLEAN.
 */
export function asn1Boolean(node: Asn1Node): boolean {
  if (node.valueBytes.length !== 1) {
    throw new Error(`Invalid DER BOOLEAN length: ${node.valueBytes.length}`);
  }
  return node.valueBytes[0] !== 0;
}

/**
 * Decodes DER OBJECT IDENTIFIER to dotted decimal string (e.g. "1.3.6.1.4.1.11129.2.1.17").
 */
export function asn1OidToString(node: Asn1Node): string {
  const bytes = node.valueBytes;
  if (bytes.length === 0) {
    throw new Error('Empty ASN.1 OBJECT IDENTIFIER');
  }

  const firstByte = bytes[0];
  const first = Math.min(2, Math.floor(firstByte / 40));
  const second = firstByte - first * 40;

  const parts: (number | string)[] = [first, second];

  let current = 0n;
  for (let i = 1; i < bytes.length; i++) {
    const b = bytes[i];
    current = (current << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(current.toString());
      current = 0n;
    }
  }

  return parts.join('.');
}

/**
 * Decodes DER BIT STRING, returning unused bit count and raw content.
 */
export function asn1BitString(node: Asn1Node): { unusedBits: number; bytes: Uint8Array } {
  if (node.valueBytes.length === 0) {
    throw new Error('Empty ASN.1 BIT STRING');
  }
  const unusedBits = node.valueBytes[0];
  const bytes = node.valueBytes.subarray(1);
  return { unusedBits, bytes };
}

/**
 * Decodes UTCTime or GeneralizedTime into a JavaScript Date.
 */
export function asn1Date(node: Asn1Node): Date {
  const str = new TextDecoder('ascii').decode(node.valueBytes);

  if (node.tagNumber === ASN1_TAGS.UTC_TIME) {
    // Format: YYMMDDhhmm[ss]Z
    const match = str.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/);
    if (!match) throw new Error(`Invalid UTCTime format: ${str}`);

    let year = parseInt(match[1], 10);
    year += year >= 50 ? 1900 : 2000;
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    const second = match[6] ? parseInt(match[6], 10) : 0;
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  if (node.tagNumber === ASN1_TAGS.GENERALIZED_TIME) {
    // Format: YYYYMMDDhhmmss[Z]
    const match = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/);
    if (!match) throw new Error(`Invalid GeneralizedTime format: ${str}`);

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1;
    const day = parseInt(match[3], 10);
    const hour = parseInt(match[4], 10);
    const minute = parseInt(match[5], 10);
    const second = parseInt(match[6], 10);
    return new Date(Date.UTC(year, month, day, hour, minute, second));
  }

  throw new Error(`Expected date tag (UTCTime / GeneralizedTime), got tag ${node.tagNumber}`);
}

/**
 * Finds a child context-tagged element ([tagNumber]) inside a constructed node.
 */
export function findContextTag(node: Asn1Node, tagNumber: number): Asn1Node | undefined {
  if (!node.children) return undefined;
  return node.children.find(child => child.tagClass === 'context' && child.tagNumber === tagNumber);
}
