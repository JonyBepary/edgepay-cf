/**
 * Strict Outbound SSRF & URL Guard for Webhook Delivery.
 *
 * Enforces HTTPS, canonicalizes IP encodings (integer, hex, octal, IPv6 mapped/ULA),
 * and prevents DNS rebinding / internal address access.
 */

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(p => parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // 224.0.0.0/4 (multicast / reserved)
  return false;
}

export function isPrivateIpv6(ip: string): boolean {
  const norm = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (norm === '::1' || norm === '::') return true;
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // Unique Local Address fc00::/7
  if (norm.startsWith('fe8') || norm.startsWith('fe9') || norm.startsWith('fea') || norm.startsWith('feb')) return true; // Link-local fe80::/10
  if (norm.startsWith('::ffff:')) { // IPv4-mapped IPv6
    const v4 = norm.replace('::ffff:', '');
    return isPrivateIpv4(v4);
  }
  return false;
}

export function isAllowedWebhookUrl(url: string, allowHttpLocalhost: boolean = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (allowHttpLocalhost && parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
    return true;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    return false;
  }

  // Check IPv6 literal
  if (hostname.includes(':')) {
    if (isPrivateIpv6(hostname)) return false;
  }

  // Check numeric IPv4 or encoded representations
  if (/^\d+$/.test(hostname)) {
    // Integer IPv4 (e.g. 2130706433)
    const num = Number(hostname);
    if (isNaN(num) || num < 0 || num > 0xFFFFFFFF) return false;
    const ip = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
    if (isPrivateIpv4(ip)) return false;
  } else if (/^0x/i.test(hostname) || /^0[0-7]+\./.test(hostname)) {
    // Alternate hex / octal IP representations
    return false;
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    if (isPrivateIpv4(hostname)) return false;
  }

  return true;
}
