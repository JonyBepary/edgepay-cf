/**
 * Gateway plugin selection — the ENABLED_GATEWAYS platform gate (v0.2.3).
 *
 * Cloudflare's "Deploy to Cloudflare" button lets the deployer customize
 * environment variables on the setup page. EdgePay uses ONE var —
 * ENABLED_GATEWAYS — as the gateway-plugin selector: a comma-separated
 * list of gateway slugs (or friendly aliases) that this deployment may
 * use. Everything not listed is DISABLED at the platform level:
 *
 *   - POST /api/v1/payments against a disabled gateway  -> 422 GATEWAY_DISABLED
 *   - POST /api/v1/refunds against a disabled gateway   -> 422 GATEWAY_DISABLED
 *   - POST /webhook/{gateway} for a disabled gateway    -> 404 UNKNOWN_GATEWAY
 *     (indistinguishable from an unregistered slug — fail closed, no
 *      information leak about the platform's adapter inventory)
 *
 * Semantics (documented in docs/GATEWAYS.md):
 *   - unset / empty / whitespace   -> ALL implemented gateways enabled
 *     (back-compat: deployments that never set the var keep v0.2.2 behavior)
 *   - "all" or "*" (single token)  -> ALL implemented gateways enabled
 *   - otherwise                    -> only listed gateways enabled; unknown
 *     tokens are dropped from the enabled set and surfaced via
 *     GET /api/v1/gateways as `dropped_aliases` (typo feedback, not a crash)
 *   - FAIL CLOSED: if the value is non-empty but contains ONLY unknown
 *     tokens, ZERO gateways are enabled (never silently enable everything
 *     because someone typo'd the list).
 *
 * What this gate is NOT: it is not per-merchant configuration. Merchants
 * still install/credentials gateways per-tenant (op_gateways +
 * op_gateway_configs, AES-256-GCM). ENABLED_GATEWAYS is the platform-level
 * ceiling: a merchant cannot use a gateway the platform has disabled.
 *
 * In-flight operations are exempt: existing transactions and refunds keep
 * reconciling through their gateway adapters even after that gateway is
 * disabled (stranding a completed payment mid-flight would lose money —
 * see services/payment.ts handleCallback + workflows/refund-reconciliation).
 */

import { GatewayDisabledError } from '../lib/error';

/** Registry slugs of every adapter implemented in this build. */
export const IMPLEMENTED_GATEWAY_SLUGS = [
  'stripe',
  'paypal',
  'bkash-api',
  'razorpay',
  'nagad-merchant-api',
] as const;

export type ImplementedGatewaySlug = (typeof IMPLEMENTED_GATEWAY_SLUGS)[number];

/**
 * Friendly aliases accepted by ENABLED_GATEWAYS, mapped to registry slugs.
 * The deploy-button field accepts both ("bkash" and "bkash-api") so the
 * value a user naturally types on the setup page just works.
 *
 * Expanded to the full 172-gateway catalog (5 implemented + 167 pending) so the
 * Deploy to Cloudflare button can offer every gateway as a selectable
 * plugin. Pending slugs map to themselves — they are considered "enabled"
 * at the platform gate but the registry will report them as `pending`
 * (no adapter yet) in GET /api/v1/gateways.
 */
export const GATEWAY_ALIASES: Record<string, string> = {
  // Implemented — canonical + aliases
  stripe: 'stripe',
  paypal: 'paypal',
  bkash: 'bkash-api',
  'bkash-api': 'bkash-api',
  razorpay: 'razorpay',
  nagad: 'nagad-merchant-api',
  'nagad-merchant-api': 'nagad-merchant-api',
  // ── Pending catalog (165) — each maps to itself ──
  adyen: 'adyen',
  'authorize-net': 'authorize-net',
  'blue-snap': 'blue-snap',
  braintree: 'braintree',
  'checkout-com': 'checkout-com',
  cybersource: 'cybersource',
  fiserv: 'fiserv',
  'fiserv-cs': 'fiserv-cs',
  'global-pay': 'global-pay',
  moneris: 'moneris',
  nmi: 'nmi',
  payeezy: 'payeezy',
  payflow: 'payflow',
  paytrace: 'paytrace',
  shift4: 'shift4',
  square: 'square',
  tsys: 'tsys',
  worldpay: 'worldpay',
  worldline: 'worldline',
  'trust-commerce': 'trust-commerce',
  elavon: 'elavon',
  'payline-data': 'payline-data',
  'net-authorize': 'net-authorize',
  alipay: 'alipay',
  'apple-pay': 'apple-pay',
  'google-pay': 'google-pay',
  'amazon-pay': 'amazon-pay',
  'samsung-pay': 'samsung-pay',
  rocket: 'rocket',
  upay: 'upay',
  nexuspay: 'nexuspay',
  'ok-wallet': 'ok-wallet',
  'mtn-momo': 'mtn-momo',
  'airtel-money': 'airtel-money',
  paytm: 'paytm',
  phonepe: 'phonepe',
  ccavenue: 'ccavenue',
  cashfree: 'cashfree',
  momo: 'momo',
  grabpay: 'grabpay',
  gcash: 'gcash',
  midtrans: 'midtrans',
  fawry: 'fawry',
  tap: 'tap',
  'mercadolibre-wallet': 'mercadolibre-wallet',
  kushki: 'kushki',
  pix: 'pix',
  payfast: 'payfast',
  bancontact: 'bancontact',
  blik: 'blik',
  eps: 'eps',
  giropay: 'giropay',
  ideal: 'ideal',
  sofort: 'sofort',
  trustly: 'trustly',
  przelewy24: 'przelewy24',
  sepa: 'sepa',
  'coinbase-commerce': 'coinbase-commerce',
  bitpay: 'bitpay',
  'btcpay-server': 'btcpay-server',
  klarna: 'klarna',
  sezzle: 'sezzle',
  affirm: 'affirm',
  afterpay: 'afterpay',
  skrill: 'skrill',
  neteller: 'neteller',
  wise: 'wise',
  mollie: 'mollie',
  'worldline-cash': 'worldline-cash',
  jazzcash: 'jazzcash',
  instamojo: 'instamojo',
  '2checkout': '2checkout',
  payu: 'payu',
  'payu-latam': 'payu-latam',
  paysera: 'paysera',
  paylike: 'paylike',
  payplug: 'payplug',
  paysafe: 'paysafe',
  pingpong: 'pingpong',
  reepay: 'reepay',
  recurly: 'recurly',
  redsys: 'redsys',
  sagepay: 'sagepay',
  securionpay: 'securionpay',
  stax: 'stax',
  'stripe-connect': 'stripe-connect',
  sumup: 'sumup',
  'swedbank-pay': 'swedbank-pay',
  'till-payments': 'till-payments',
  'transact-pro': 'transact-pro',
  unzer: 'unzer',
  verifone: 'verifone',
  'viva-wallet': 'viva-wallet',
  wayforpay: 'wayforpay',
  wirecard: 'wirecard',
  yookassa: 'yookassa',
  zimpler: 'zimpler',
  payever: 'payever',
  paylands: 'paylands',
  paymill: 'paymill',
  'pay-nl': 'pay-nl',
  paytrail: 'paytrail',
  paytabs: 'paytabs',
  payfort: 'payfort',
  telr: 'telr',
  'checkout-v2': 'checkout-v2',
  cardknox: 'cardknox',
  cko: 'cko',
  cmi: 'cmi',
  concardis: 'concardis',
  credomatic: 'credomatic',
  'ct-payments': 'ct-payments',
  dalenys: 'dalenys',
  datatrans: 'datatrans',
  dibs: 'dibs',
  emerchantpay: 'emerchantpay',
  epay: 'epay',
  epos: 'epos',
  'every-pay': 'every-pay',
  finaro: 'finaro',
  'first-atlantic-commerce': 'first-atlantic-commerce',
  'first-data': 'first-data',
  heidelpay: 'heidelpay',
  hipay: 'hipay',
  icepay: 'icepay',
  ingenico: 'ingenico',
  ipayment: 'ipayment',
  'lemon-way': 'lemon-way',
  mercanet: 'mercanet',
  migs: 'migs',
  multisafepay: 'multisafepay',
  nexi: 'nexi',
  nets: 'nets',
  novalnet: 'novalnet',
  paypoint: 'paypoint',
  payson: 'payson',
  quickpay: 'quickpay',
  santander: 'santander',
  securetrading: 'securetrading',
  smart2pay: 'smart2pay',
  tink: 'tink',
  'token-io': 'token-io',
  'easy-paisa': 'easy-paisa',
  ecpay: 'ecpay',
  ecommpay: 'ecommpay',
  komoju: 'komoju',
  moneybookers: 'moneybookers',
  'multi-cards': 'multi-cards',
  oceanpayment: 'oceanpayment',
  onebip: 'onebip',
  paygate: 'paygate',
  paygent: 'paygent',
  payway: 'payway',
  'pin-payments': 'pin-payments',
  'plug-and-pay': 'plug-and-pay',
  'pro-pay': 'pro-pay',
  qpay: 'qpay',
  forte: 'forte',
  freedompay: 'freedompay',
  'go-cardless': 'go-cardless',
  maxipago: 'maxipago',
  mercadopago: 'mercadopago',
  pagseguro: 'pagseguro',
  'klarna-pay-now': 'klarna-pay-now',
  'worldpay-v2': 'worldpay-v2',
  paystack: 'paystack',
  flutterwave: 'flutterwave',
};

/** Full catalog — 5 implemented + 167 pending = 172 total. */
export const ALL_GATEWAY_SLUGS: readonly string[] = [
  ...IMPLEMENTED_GATEWAY_SLUGS,
  'adyen', 'authorize-net', 'blue-snap', 'braintree', 'checkout-com',
  'cybersource', 'fiserv', 'fiserv-cs', 'global-pay', 'moneris', 'nmi',
  'payeezy', 'payflow', 'paytrace', 'shift4', 'square', 'tsys', 'worldpay',
  'worldline', 'trust-commerce', 'elavon', 'payline-data', 'net-authorize',
  'alipay', 'apple-pay', 'google-pay', 'amazon-pay', 'samsung-pay',
  'rocket', 'upay', 'nexuspay', 'ok-wallet',
  'mtn-momo', 'airtel-money',
  'paytm', 'phonepe', 'ccavenue', 'cashfree',
  'momo', 'grabpay', 'gcash', 'midtrans',
  'fawry', 'tap',
  'mercadolibre-wallet', 'kushki', 'pix', 'payfast',
  'bancontact', 'blik', 'eps', 'giropay', 'ideal', 'sofort', 'trustly',
  'przelewy24', 'sepa',
  'coinbase-commerce', 'bitpay', 'btcpay-server',
  'klarna', 'sezzle', 'affirm', 'afterpay',
  'skrill', 'neteller', 'wise', 'mollie', 'worldline-cash',
  'jazzcash', 'instamojo',
  '2checkout', 'payu', 'payu-latam', 'paysera', 'paylike', 'payplug',
  'paysafe', 'pingpong', 'reepay', 'recurly', 'redsys', 'sagepay',
  'securionpay', 'stax', 'stripe-connect', 'sumup', 'swedbank-pay',
  'till-payments', 'transact-pro', 'unzer', 'verifone', 'viva-wallet',
  'wayforpay', 'wirecard', 'yookassa', 'zimpler', 'payever', 'paylands',
  'paymill', 'pay-nl', 'paytrail', 'paytabs', 'payfort', 'telr',
  'checkout-v2', 'cardknox', 'cko',
  'cmi', 'concardis', 'credomatic', 'ct-payments', 'dalenys', 'datatrans',
  'dibs', 'emerchantpay', 'epay', 'epos', 'every-pay', 'finaro',
  'first-atlantic-commerce', 'first-data', 'heidelpay', 'hipay', 'icepay',
  'ingenico', 'ipayment', 'lemon-way', 'mercanet', 'migs', 'multisafepay',
  'nexi', 'nets', 'novalnet', 'paypoint', 'payson', 'quickpay',
  'santander', 'securetrading', 'smart2pay', 'tink', 'token-io',
  'easy-paisa', 'ecpay', 'ecommpay', 'komoju', 'moneybookers', 'multi-cards',
  'oceanpayment', 'onebip', 'paygate', 'paygent', 'payway', 'pin-payments',
  'plug-and-pay', 'pro-pay', 'qpay', 'forte', 'freedompay', 'go-cardless',
  'maxipago', 'mercadopago', 'pagseguro', 'klarna-pay-now', 'worldpay-v2',
  'paystack', 'flutterwave',
];

/** Fast lookup for any slug in the 172-gateway catalog (implemented + pending). */
export const GATEWAY_CATALOG: ReadonlySet<string> = new Set(ALL_GATEWAY_SLUGS);

/** Parsed result of an ENABLED_GATEWAYS value. */
export interface GatewaySelection {
  /** Canonical registry slugs that are enabled (ordered, deduped). */
  enabled: string[];
  /** Unrecognized tokens from the raw value (typo feedback). */
  dropped: string[];
  /** True when the default "everything" posture is active. */
  allEnabled: boolean;
  /** The raw env value the selection was parsed from ("" when unset). */
  raw: string;
}

const ALL_TOKENS = new Set(['all', '*']);

/** Split an ENABLED_GATEWAYS value on commas, semicolons and/or whitespace. */
function tokenize(raw: string): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Pure parser — unit-testable without bindings. Memoized wrapper for env
 * access lives in gatewaySelection() below.
 */
export function parseEnabledGateways(raw: string | undefined | null): GatewaySelection {
  const value = (raw ?? '').trim();
  const base: GatewaySelection = { enabled: [], dropped: [], allEnabled: false, raw: value };

  if (value === '') {
    // Unset/blank -> every adapter (v0.2.2 back-compat default).
    return { ...base, enabled: [...IMPLEMENTED_GATEWAY_SLUGS], allEnabled: true };
  }

  const tokens = tokenize(value);
  if (tokens.length === 1 && ALL_TOKENS.has(tokens[0])) {
    return { ...base, enabled: [...IMPLEMENTED_GATEWAY_SLUGS], allEnabled: true };
  }

  const enabled: string[] = [];
  const dropped: string[] = [];
  for (const token of tokens) {
    // Resolve via alias map first, then via catalog (pending slugs map to themselves)
    const canonical = GATEWAY_ALIASES[token] ?? (GATEWAY_CATALOG.has(token) ? token : undefined);
    if (canonical && !enabled.includes(canonical)) {
      enabled.push(canonical);
    } else if (!canonical) {
      dropped.push(token);
    }
  }

  // FAIL CLOSED: an explicit-but-entirely-unknown list enables NOTHING.
  return { ...base, enabled, dropped };
}

/**
 * Memoized selection for a given raw value. Parsing is cheap but happens
 * on request paths (webhook + payment), so cache the last value — the
 * env string is immutable for the life of an isolate.
 */
let selectionCache: { raw: string; selection: GatewaySelection } | null = null;

export function gatewaySelection(raw: string | undefined | null): GatewaySelection {
  const key = (raw ?? '').trim();
  if (selectionCache && selectionCache.raw === key) {
    return selectionCache.selection;
  }
  const selection = parseEnabledGateways(raw);
  selectionCache = { raw: key, selection };
  return selection;
}

/** Minimal env shape so this module is testable without full Env. */
export interface GatewaySelectionEnv {
  ENABLED_GATEWAYS?: string;
}

/** Is the given registry slug enabled on this deployment? */
export function isGatewayEnabled(env: GatewaySelectionEnv, slug: string): boolean {
  return gatewaySelection(env.ENABLED_GATEWAYS).enabled.includes(slug);
}

/**
 * Throw GatewayDisabledError (422) unless the slug is enabled. Used at the
 * NEW-operation entry points (payment initiate, merchant refund, inbound
 * webhook) — never on in-flight reconciliation paths.
 */
export function assertGatewayEnabled(env: GatewaySelectionEnv, slug: string): void {
  if (!isGatewayEnabled(env, slug)) {
    throw new GatewayDisabledError(slug);
  }
}
