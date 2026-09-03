/**
 * EdgePay Platform Configuration & Tuning Central Registry.
 *
 * This single file controls all default parameters, bootstrap policies,
 * gateway defaults, security thresholds, timeouts, and nullable ranges.
 *
 * All values can be tuned prior to deployment via:
 * 1. wrangler.jsonc ("vars")
 * 2. .dev.vars / Cloudflare Secrets
 * 3. Dynamic overrides via this centralized config
 */

import type { Env } from '../types/env';
import { randomNumericOtp } from '../lib/crypto';

/**
 * Normalizes a configuration string that might represent a null/nil/disabled state.
 * Returns null if the value is empty, 'null', 'none', 'nil', or 'disabled'.
 */
export function normalizeNullableString(val: string | null | undefined): string | null {
  if (!val) return null;
  const trimmed = val.trim();
  const lower = trimmed.toLowerCase();
  if (lower === '' || lower === 'null' || lower === 'none' || lower === 'nil' || lower === 'disabled' || lower === 'undefined') {
    return null;
  }
  return trimmed;
}

export interface GatewaySeedConfig {
  slug: string;
  name: string;
  type: 'manual' | 'api';
  currencies: string[];
  priority: number;
}

export interface SmsTemplateSeedConfig {
  gateway_slug: string;
  name: string;
  regex: string;
  sample: string;
}

export interface PlatformConfig {
  app: {
    name: string;
    version: string;
    url: string | null;
    domain: string | null;
    environment: string;
    logLevel: string;
  };
  admin: {
    email: string | null;
    password: string | null;
    timezone: string;
    language: string;
  };
  mfs: {
    defaultPhone: string | null;
    pairingOtp: string;
    autoSeedManualGateways: boolean;
  };
  financial: {
    defaultCurrency: string;
    webhookUrl: string | null;
    webhookMaxRetries: number;
    webhookBackoffMs: number;
  };
  security: {
    jwtIssuer: string;
    jwtTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    sessionTtlSeconds: number;
    rateLimitMaxRequests: number;
    rateLimitWindowSeconds: number;
  };
  gateways: {
    enabledList: string[];
    defaultSeedGateways: GatewaySeedConfig[];
    defaultSmsTemplates: SmsTemplateSeedConfig[];
  };
}

export const DEFAULT_SEED_GATEWAYS: GatewaySeedConfig[] = [
  { slug: 'bkash', name: 'bKash Personal / Agent', type: 'manual', currencies: ['BDT'], priority: 1 },
  { slug: 'nagad', name: 'Nagad Personal / Agent', type: 'manual', currencies: ['BDT'], priority: 2 },
  { slug: 'rocket', name: 'DBBL Rocket Personal', type: 'manual', currencies: ['BDT'], priority: 3 },
  { slug: 'bkash-api', name: 'bKash Direct Merchant API', type: 'api', currencies: ['BDT'], priority: 4 },
  { slug: 'nagad-merchant-api', name: 'Nagad Direct Merchant API', type: 'api', currencies: ['BDT'], priority: 5 },
  { slug: 'sslcommerz', name: 'SSLCommerz Gateway', type: 'api', currencies: ['BDT', 'USD'], priority: 6 },
  { slug: 'stripe', name: 'Stripe Cards & Wallets', type: 'api', currencies: ['USD', 'EUR', 'GBP', 'BDT'], priority: 7 },
  { slug: 'paypal', name: 'PayPal Global Express', type: 'api', currencies: ['USD', 'EUR', 'GBP'], priority: 8 },
  { slug: 'razorpay', name: 'Razorpay Payment Gateway', type: 'api', currencies: ['INR', 'USD'], priority: 9 },
];

export const DEFAULT_SMS_TEMPLATES: SmsTemplateSeedConfig[] = [
  {
    gateway_slug: 'bkash',
    name: 'bKash Personal Cash In / Send Money',
    regex: 'You have received Tk ([0-9,.]+)(?: from [0-9]+)?\\.?(?: Ref:? [^.]*\\.)? Fee Tk [0-9,.]+\\.? Balance Tk [0-9,.]+\\.? TrxID ([A-Z0-9]+)',
    sample: 'You have received Tk 1,500.00 from 01711000000. Fee Tk 0.00. Balance Tk 5,500.00. TrxID 9H7X6Y5Z at 15/01/2026 14:30',
  },
  {
    gateway_slug: 'nagad',
    name: 'Nagad Money Received',
    regex: 'Money Received\\.\\s*Amount:\\s*Tk\\s*([0-9,.]+)\\s*Sender:\\s*[0-9]+\\s*TxnID:\\s*([A-Z0-9]+)',
    sample: 'Money Received. Amount: Tk 2,000.00 Sender: 01811000000 TxnID: 71K3L9MN at 15/01/2026 15:00',
  },
  {
    gateway_slug: 'rocket',
    name: 'Rocket Cash-In / P2P',
    regex: 'Tk([0-9,.]+) received from [0-9]+(?:\\.[^.]*)?\\s*TxnId:([A-Z0-9]+)',
    sample: 'Tk500.00 received from 01911000000. TxnId:1029384756',
  },
];

/**
 * Resolves the unified platform configuration from environment bindings
 * with full support for nullable, optional, and default fallbacks.
 */
export function getPlatformConfig(env: Env): PlatformConfig {
  const adminEmail = normalizeNullableString(env.ADMIN_EMAIL) ?? (env.ENVIRONMENT === 'production' ? null : 'admin@edgepay.internal');
  const adminPassword = normalizeNullableString(env.ADMIN_PASSWORD);
  const defaultPhone = normalizeNullableString(env.DEFAULT_MFS_NUMBER);
  const defaultWebhook = normalizeNullableString(env.DEFAULT_WEBHOOK_URL);
  
  // Pairing OTP: If configured use it; otherwise always generate a cryptographically secure 6-digit OTP.
  // There is no predictable fallback (no '123456') in any environment.
  const customOtp = normalizeNullableString(env.DEFAULT_PAIRING_OTP);
  const pairingOtp = customOtp ?? randomNumericOtp(6);

  const enabledGatewaysRaw = env.ENABLED_GATEWAYS ?? '';
  const enabledList = enabledGatewaysRaw
    ? enabledGatewaysRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_SEED_GATEWAYS.map(g => g.slug);

  // Filter seed gateways to only those enabled in the deployment
  const defaultSeedGateways = DEFAULT_SEED_GATEWAYS.filter(g => 
    enabledList.length === 0 || enabledList.includes(g.slug)
  );

  return {
    app: {
      name: env.APP_NAME ?? 'EdgePay',
      version: env.APP_VERSION ?? '0.3.0',
      url: normalizeNullableString(env.APP_URL),
      domain: normalizeNullableString(env.APP_DOMAIN),
      environment: env.ENVIRONMENT ?? 'production',
      logLevel: env.LOG_LEVEL ?? 'info',
    },
    admin: {
      email: adminEmail,
      password: adminPassword,
      timezone: env.DEFAULT_TIMEZONE ?? 'Asia/Dhaka',
      language: env.DEFAULT_LANGUAGE ?? 'en',
    },
    mfs: {
      defaultPhone,
      pairingOtp,
      autoSeedManualGateways: true,
    },
    financial: {
      defaultCurrency: env.DEFAULT_CURRENCY ?? 'BDT',
      webhookUrl: defaultWebhook,
      webhookMaxRetries: parseInt(env.WEBHOOK_MAX_RETRIES ?? '3', 10),
      webhookBackoffMs: parseInt(env.WEBHOOK_BACKOFF_MS ?? '60000', 10),
    },
    security: {
      jwtIssuer: env.JWT_ISSUER ?? 'edgepay-cf',
      jwtTtlSeconds: parseInt(env.JWT_TTL_SECONDS ?? '3600', 10),
      refreshTokenTtlSeconds: parseInt(env.REFRESH_TOKEN_TTL_SECONDS ?? '2592000', 10),
      sessionTtlSeconds: parseInt(env.SESSION_TTL_SECONDS ?? '86400', 10),
      rateLimitMaxRequests: parseInt(env.RATE_LIMIT_MAX_REQUESTS ?? '120', 10),
      rateLimitWindowSeconds: parseInt(env.RATE_LIMIT_WINDOW_SECONDS ?? '60', 10),
    },
    gateways: {
      enabledList,
      defaultSeedGateways,
      defaultSmsTemplates: DEFAULT_SMS_TEMPLATES,
    },
  };
}
