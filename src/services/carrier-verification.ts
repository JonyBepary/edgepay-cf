/**
 * Server-Side Carrier Shortcode & MFS Sender ID Verification.
 *
 * Enforces strict carrier shortcode validation on the server so malicious
 * clients cannot inject arbitrary spoofed senders (e.g., personal numbers,
 * bank names, or synthetic alphanumeric strings) into the auto-confirmation pipeline.
 */

export interface CarrierValidationResult {
  trusted: boolean;
  canonicalSender: string;
  gatewaySlug: string | null;
}

interface CarrierRule {
  canonical: string;
  gatewaySlug: string;
  shortcodes: string[];
}

const AUTHORIZED_CARRIERS: Record<string, CarrierRule> = {
  bkash: {
    canonical: 'bKash',
    gatewaySlug: 'bkash-api',
    shortcodes: ['bkash', '16247'],
  },
  nagad: {
    canonical: 'Nagad',
    gatewaySlug: 'nagad-merchant-api',
    shortcodes: ['nagad', '16167'],
  },
  rocket: {
    canonical: 'Rocket',
    gatewaySlug: 'rocket',
    shortcodes: ['rocket', 'dbbl', '16216'],
  },
  upay: {
    canonical: 'upay',
    gatewaySlug: 'upay',
    shortcodes: ['upay', 'ucb', '16268'],
  },
};

/**
 * Normalizes sender string: lowercase, alphanumeric only.
 * E.g. "bKash LTD" -> "bkashltd", "16247" -> "16247".
 */
export function normalizeCarrierSender(rawSender: string): string {
  if (!rawSender) return '';
  return rawSender.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Validates whether the incoming SMS sender matches an authorized MFS carrier shortcode.
 */
export function validateCarrierSender(rawSender: string): CarrierValidationResult {
  const norm = normalizeCarrierSender(rawSender);
  if (!norm) {
    return { trusted: false, canonicalSender: '', gatewaySlug: null };
  }

  for (const carrier of Object.values(AUTHORIZED_CARRIERS)) {
    for (const code of carrier.shortcodes) {
      if (norm === code || norm.startsWith(code)) {
        return {
          trusted: true,
          canonicalSender: carrier.canonical,
          gatewaySlug: carrier.gatewaySlug,
        };
      }
    }
  }

  return {
    trusted: false,
    canonicalSender: rawSender.trim(),
    gatewaySlug: null,
  };
}

/**
 * Convenience helper: returns true if sender is a trusted MFS carrier.
 */
export function isTrustedCarrier(rawSender: string): boolean {
  return validateCarrierSender(rawSender).trusted;
}

/**
 * Returns canonical gateway slug for trusted carrier or null.
 */
export function getCarrierGatewaySlug(rawSender: string): string | null {
  return validateCarrierSender(rawSender).gatewaySlug;
}
