/**
 * EdgePay gateway catalog — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: the upstream PHP gateway-plugin repository (123 provider
 * modules). Regenerate with:
 *   python3 scripts/port-gateways/analyze.py <plugin-repo> scripts/port-gateways/analysis.json
 *   python3 scripts/port-gateways/build-catalog.py scripts/port-gateways/analysis.json src/gateways/catalog.data.ts 0.3.0
 *
 * Entry shape (CatalogEntry in ./catalog.ts):
 *   slug          registry slug (ENABLED_GATEWAYS accepts this + aliases)
 *   name/version/description/category/color   provider identity (manifest.json)
 *   currencies    ISO-4217 codes the adapter natively transacts
 *   capabilities  refund | verification | webhook (webhook only when a real
 *                 signature scheme exists — unsigned-webhook providers are
 *                 listed with flag `webhook-unsigned-rejected` instead)
 *   status        implemented (core 5) | ported (full TS port) | planned (catalog stub)
 *                 P0-7 quarantine: 'planned' also covers 16 quarantined
 *                 generated adapters whose port is broken (PHP leftover /
 *                 empty-redirect initiate / stub-only verify) — files are
 *                 kept on disk but hidden from the default list. See
 *                 docs/GATEWAYS-PLANNED.md.
 *   flags         legacy-md5 | webhook-unsigned-rejected | token-grant
 *   fields        credential definitions for the admin install UI —
 *                 NAMES only are stored; values live AES-256-GCM encrypted
 *                 in op_gateway_configs, never in this file
 */

// prettier-ignore
export const CATALOG_VERSION = '0.3.0';

// prettier-ignore
export type CatalogStatus = 'implemented' | 'ported' | 'planned';

/** Compact credential field tuple: [name, label, typeCode, required, options?] */
// prettier-ignore
export type CatalogFieldTuple = readonly [string, string, 't' | 'p' | 's' | 'c' | 'ta', 0 | 1] | readonly [string, string, 't' | 'p' | 's' | 'c' | 'ta', 0 | 1, Record<string, string>];

// prettier-ignore
export interface CatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly category: 'global' | 'mfs' | 'bank' | 'europe' | 'latam' | 'mena' | 'apac' | 'mobile' | 'express' | 'africa' | 'crypto';
  readonly color: string;
  readonly currencies: readonly string[];
  readonly capabilities: readonly string[];
  readonly status: CatalogStatus;
  readonly flags: readonly string[];
  readonly fields: readonly CatalogFieldTuple[];
}

// prettier-ignore
export const GATEWAY_CATALOG: readonly CatalogEntry[] = [
  {
    slug: 'bkash-api',
    name: 'bKash API',
    version: '1.0.0',
    description: 'bKash tokenized checkout API integration',
    category: 'mfs',
    color: '#E2136E',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'implemented',
    flags: ['token-grant'],
    fields: [
    ['app_key', 'App Key', 't', 1],
    ['app_secret', 'App Secret', 'p', 1],
    ['username', 'Username', 't', 1],
    ['password', 'Password', 'p', 1]
    ],
  },
  {
    slug: 'nagad-merchant-api',
    name: 'Nagad Merchant API',
    version: '1.0.0',
    description: 'Nagad Merchant API payment gateway integration',
    category: 'mfs',
    color: '#F15A22',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'implemented',
    flags: [],
    fields: [
    ['nagad_app_account', 'Nagad App Account (phone)', 't', 1],
    ['nagad_merchant_id', 'Nagad Merchant ID', 't', 1],
    ['nagad_private_key', 'Merchant Private Key', 'ta', 1],
    ['nagad_public_key', 'Nagad PG Public Key', 'ta', 1]
    ],
  },
  {
    slug: 'paypal',
    name: 'PayPal Checkout',
    version: '1.0.0',
    description: 'Accept PayPal Checkout payments directly from customers.',
    category: 'global',
    color: '#003087',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'implemented',
    flags: ['token-grant'],
    fields: [
    ['paypal_client_id', 'PayPal Client ID', 't', 1],
    ['paypal_secret', 'PayPal Secret', 't', 1]
    ],
  },
  {
    slug: 'razorpay',
    name: 'Razorpay',
    version: '1.0.0',
    description: 'Razorpay payment gateway integration for EdgePay',
    category: 'bank',
    color: '#3399FF',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'implemented',
    flags: [],
    fields: [
    ['key_id', 'Key ID', 't', 1],
    ['key_secret', 'Key Secret', 'p', 1],
    ['webhook_secret', 'Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    version: '1.0.0',
    description: 'Stripe payment gateway — cards, wallets, international payments',
    category: 'global',
    color: '#635BFF',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'implemented',
    flags: [],
    fields: [
    ['publishable_key', 'Publishable Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1],
    ['webhook_secret', 'Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: '2checkout',
    name: '2Checkout',
    version: '1.0.0',
    description: '2Checkout payment gateway integration for EdgePay',
    category: 'global',
    color: '#FF5F00',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_code', 'Merchant Code', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'aamarpay',
    name: 'Aamarpay',
    version: '1.0.0',
    description: 'Aamarpay payment gateway integration',
    category: 'mfs',
    color: '#FF6B00',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['store_id', 'Store ID', 't', 1],
    ['signature_key', 'Signature Key', 'p', 1]
    ],
  },
  {
    slug: 'adyen',
    name: 'Adyen',
    version: '1.0.0',
    description: 'Adyen payment gateway integration for EdgePay',
    category: 'global',
    color: '#00CC66',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'API Key', 'p', 1],
    ['merchant_account', 'Merchant Account', 't', 1],
    ['client_key', 'Client Key', 't', 1],
    ['hmac_key', 'HMAC Key', 'p', 1]
    ],
  },
  {
    slug: 'affirm',
    name: 'Affirm',
    version: '1.0.0',
    description: 'Affirm checkout integration for EdgePay',
    category: 'global',
    color: '#4A90E2',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['public_key', 'Public Key', 't', 1],
    ['private_key', 'Private Key', 'p', 1]
    ],
  },
  {
    slug: 'afterpay',
    name: 'Afterpay',
    version: '1.0.0',
    description: 'Afterpay / Clearpay checkout integration for EdgePay',
    category: 'global',
    color: '#B2FCE4',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'amazon-pay',
    name: 'Amazon Pay',
    version: '1.0.0',
    description: 'Amazon Pay checkout integration for EdgePay',
    category: 'global',
    color: '#FF9900',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['store_id', 'Store ID', 't', 1],
    ['public_key_id', 'Public Key ID', 't', 1],
    ['private_key', 'Private Key (PEM)', 'ta', 1]
    ],
  },
  {
    slug: 'authorize-net',
    name: 'Authorize.Net',
    version: '1.0.0',
    description: 'Authorize.Net payment gateway integration for EdgePay',
    category: 'global',
    color: '#243F60',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_login_id', 'API Login ID', 't', 1],
    ['transaction_key', 'Transaction Key', 'p', 1],
    ['signature_key', 'Signature Key', 'p', 1]
    ],
  },
  {
    slug: 'bancontact',
    name: 'Bancontact',
    version: '1.0.0',
    description: 'Bancontact payment gateway integration for EdgePay',
    category: 'bank',
    color: '#FFE600',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_key', 'Mollie API Key', 'p', 1]
    ],
  },
  {
    slug: 'biller-genie',
    name: 'Biller Genie',
    version: '1.0.0',
    description: 'Biller Genie payment gateway integration for EdgePay',
    category: 'global',
    color: '#0D9488',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Biller Genie API Key', 'p', 1]
    ],
  },
  {
    slug: 'bitpay',
    name: 'BitPay',
    version: '1.0.0',
    description: 'BitPay crypto checkout integration for EdgePay',
    category: 'global',
    color: '#1A2B49',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_token', 'BitPay API Token', 'p', 1]
    ],
  },
  {
    slug: 'bluesnap',
    name: 'BlueSnap',
    version: '1.0.0',
    description: 'BlueSnap payment gateway integration for EdgePay',
    category: 'global',
    color: '#0A1E3F',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_username', 'API Username', 't', 1],
    ['api_password', 'API Password', 'p', 1]
    ],
  },
  {
    slug: 'btcpay',
    name: 'BTCPay Server',
    version: '1.0.0',
    description: 'BTCPay Server payment gateway integration for EdgePay',
    category: 'global',
    color: '#F5A623',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['server_url', 'BTCPay Server URL', 't', 1],
    ['api_key', 'API Key (Greenfield)', 'p', 1],
    ['store_id', 'Store ID', 't', 1],
    ['webhook_secret', 'Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: 'cellfin',
    name: 'CellFin',
    version: '1.0.0',
    description: 'Islami Bank Bangladesh PLC (IBBL) CellFin MFS and digital wallet payment integration',
    category: 'global',
    color: '#4CAF50',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['api_key', 'API Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'chase-paymentech',
    name: 'Chase Paymentech',
    version: '1.0.0',
    description: 'Chase Paymentech payment gateway integration for EdgePay',
    category: 'global',
    color: '#115E59',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['terminal_id', 'Terminal ID', 't', 1],
    ['bin', 'BIN (e.g. 000001)', 't', 1]
    ],
  },
  {
    slug: 'coinbase-commerce',
    name: 'Coinbase Commerce',
    version: '1.0.0',
    description: 'Coinbase Commerce payment gateway integration for EdgePay',
    category: 'global',
    color: '#0052FF',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'API Key', 'p', 1],
    ['shared_secret', 'Shared Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: 'cybersource',
    name: 'Cybersource',
    version: '1.0.0',
    description: 'Cybersource payment gateway integration for EdgePay',
    category: 'global',
    color: '#003366',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['api_key_id', 'API Key ID', 't', 1],
    ['shared_secret', 'Shared Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'dana',
    name: 'DANA Wallet',
    version: '1.0.0',
    description: 'DANA Wallet payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#108EE9',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['secret_key', 'Xendit Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'rocket',
    name: 'DBBL Rocket',
    version: '1.0.0',
    description: 'DBBL Rocket payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#8C2070',
    currencies: [],
    capabilities: [],
    status: 'ported',
    flags: ['legacy-md5', 'webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'dlocal',
    name: 'dLocal',
    version: '1.0.0',
    description: 'dLocal payment gateway integration for EdgePay',
    category: 'global',
    color: '#0038FF',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['x_login', 'dLocal Login ID', 't', 1],
    ['x_trans_key', 'dLocal Transaction Key', 'p', 1],
    ['secret_key', 'dLocal Webhook Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'easypaisa',
    name: 'Easypaisa',
    version: '1.0.0',
    description: 'Easypaisa payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#009944',
    currencies: [],
    capabilities: [],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['store_id', 'Store ID', 't', 1],
    ['hash_key', 'Hash Key', 'p', 1]
    ],
  },
  {
    slug: 'ebanx',
    name: 'Ebanx',
    version: '1.0.0',
    description: 'Ebanx payment gateway integration for Latin America',
    category: 'latam',
    color: '#000000',
    currencies: ['BRL', 'MXN', 'ARS', 'COP', 'CLP', 'PEN', 'USD'],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['integration_key', 'Integration Key', 'p', 1]
    ],
  },
  {
    slug: 'elavon',
    name: 'Elavon',
    version: '1.0.0',
    description: 'Elavon payment gateway integration for EdgePay',
    category: 'global',
    color: '#0F172A',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['user_id', 'User ID', 't', 1],
    ['pin', 'User PIN', 'p', 1]
    ],
  },
  {
    slug: 'fastspring',
    name: 'FastSpring',
    version: '1.0.0',
    description: 'FastSpring payment gateway integration for EdgePay',
    category: 'global',
    color: '#FF3F00',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_username', 'API Username', 't', 1],
    ['api_password', 'API Password', 'p', 1],
    ['shared_secret', 'Webhook Shared Secret', 'p', 1]
    ],
  },
  {
    slug: 'fattmerchant',
    name: 'Fattmerchant',
    version: '1.0.0',
    description: 'Fattmerchant payment gateway integration for EdgePay',
    category: 'global',
    color: '#4F46E5',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Fattmerchant Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'first-data',
    name: 'First Data',
    version: '1.0.0',
    description: 'First Data payment gateway integration for EdgePay',
    category: 'global',
    color: '#004B87',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['gateway_id', 'Gateway ID', 't', 1],
    ['password', 'Password', 'p', 1],
    ['hmac_key', 'HMAC Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'fiserv',
    name: 'Fiserv',
    version: '1.0.0',
    description: 'Fiserv payment gateway integration for EdgePay',
    category: 'global',
    color: '#FF5F00',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['store_id', 'Store ID', 't', 1],
    ['shared_secret', 'Shared Secret', 'p', 1]
    ],
  },
  {
    slug: 'flutterwave',
    name: 'Flutterwave',
    version: '1.0.0',
    description: 'Flutterwave payment gateway integration for EdgePay',
    category: 'global',
    color: '#F5A623',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['public_key', 'Public Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1],
    ['secret_hash', 'Webhook Secret Hash', 'p', 0]
    ],
  },
  {
    slug: 'gcash',
    name: 'GCash Wallet',
    version: '1.0.0',
    description: 'GCash Wallet payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#1976D2',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['public_api_key', 'Public API Key', 't', 1],
    ['secret_api_key', 'Secret API Key', 'p', 1]
    ],
  },
  {
    slug: 'global-payments',
    name: 'Global Payments',
    version: '1.0.0',
    description: 'Global Payments payment gateway integration for EdgePay',
    category: 'global',
    color: '#002D62',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['account_id', 'Account ID', 't', 1],
    ['api_key', 'API Key', 'p', 1]
    ],
  },
  {
    slug: 'gocardless',
    name: 'GoCardless',
    version: '1.0.0',
    description: 'GoCardless direct debit integration for EdgePay',
    category: 'global',
    color: '#205FFF',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: ['token-grant'],
    fields: [
    ['access_token', 'Access Token', 't', 1],
    ['webhook_secret', 'Webhook Secret', 't', 1]
    ],
  },
  {
    slug: 'grabpay',
    name: 'GrabPay',
    version: '1.0.0',
    description: 'GrabPay payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#00B14F',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['client_id', 'Client ID', 't', 1],
    ['client_secret', 'Client Secret', 'p', 1]
    ],
  },
  {
    slug: 'heartland',
    name: 'Heartland',
    version: '1.0.0',
    description: 'Heartland payment gateway integration for EdgePay',
    category: 'global',
    color: '#1E3A8A',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Heartland Secret API Key', 'p', 1]
    ],
  },
  {
    slug: 'helcim',
    name: 'Helcim',
    version: '1.0.0',
    description: 'Helcim payment gateway integration for EdgePay',
    category: 'global',
    color: '#0369A1',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['account_id', 'Helcim Account ID', 't', 1],
    ['api_token', 'API Token', 'p', 1]
    ],
  },
  {
    slug: 'ideal',
    name: 'iDEAL',
    version: '1.0.0',
    description: 'iDEAL payment gateway integration for EdgePay',
    category: 'bank',
    color: '#EC008C',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_key', 'Mollie API Key', 'p', 1]
    ],
  },
  {
    slug: 'kakaopay',
    name: 'KakaoPay',
    version: '1.0.0',
    description: 'KakaoPay payment gateway integration for EdgePay',
    category: 'global',
    color: '#FFCD00',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['admin_key', 'Admin Key', 't', 1],
    ['cid', 'Merchant CID (e.g. TC0ONETIME)', 't', 1]
    ],
  },
  {
    slug: 'mpesa',
    name: 'M-Pesa Safaricom',
    version: '1.0.0',
    description: 'M-Pesa Safaricom payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#4EAD4A',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: ['token-grant'],
    fields: [
    ['consumer_key', 'Consumer Key', 't', 1],
    ['consumer_secret', 'Consumer Secret', 'p', 1],
    ['business_shortcode', 'Business Shortcode (Paybill)', 't', 1],
    ['passkey', 'Lipa Na M-Pesa Passkey', 'p', 1]
    ],
  },
  {
    slug: 'maya',
    name: 'Maya Wallet',
    version: '1.0.0',
    description: 'Maya Wallet payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#00F076',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['public_key', 'Public API Key', 't', 1],
    ['secret_key', 'Secret API Key', 'p', 1]
    ],
  },
  {
    slug: 'mercadopago',
    name: 'Mercado Pago',
    version: '1.0.0',
    description: 'Mercado Pago payment gateway integration for EdgePay',
    category: 'global',
    color: '#00B1EA',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['access_token', 'Access Token', 'p', 1]
    ],
  },
  {
    slug: 'mercadolibre-wallet',
    name: 'MercadoLibre Wallet',
    version: '1.0.0',
    description: 'MercadoLibre Wallet payment gateway integration for EdgePay',
    category: 'global',
    color: '#FFE600',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['access_token', 'Access Token', 'p', 1]
    ],
  },
  {
    slug: 'midtrans',
    name: 'Midtrans',
    version: '1.0.0',
    description: 'Midtrans payment gateway integration for Indonesia/APAC',
    category: 'apac',
    color: '#172b53',
    currencies: ['IDR', 'USD', 'SGD'],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['server_key', 'Server Key', 'p', 1],
    ['client_key', 'Client Key', 't', 1]
    ],
  },
  {
    slug: 'mobikwik',
    name: 'MobiKwik',
    version: '1.0.0',
    description: 'MobiKwik Zaakpay hosted checkout integration',
    category: 'mfs',
    color: '#004b93',
    currencies: ['INR'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant Identifier (MID)', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'mollie',
    name: 'Mollie Payments',
    version: '1.0.0',
    description: 'Mollie Payments payment gateway integration for EdgePay',
    category: 'global',
    color: '#202020',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_key', 'Mollie API Key', 'p', 1]
    ],
  },
  {
    slug: 'momo',
    name: 'MoMo Wallet',
    version: '1.0.0',
    description: 'MoMo E-wallet payment integration for Vietnam',
    category: 'mfs',
    color: '#A50064',
    currencies: ['VND'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['partner_code', 'Partner Code', 't', 1],
    ['access_key', 'Access Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'moneris',
    name: 'Moneris',
    version: '1.0.0',
    description: 'Moneris payment gateway integration for EdgePay',
    category: 'global',
    color: '#B91C1C',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['store_id', 'Store ID', 't', 1],
    ['api_token', 'API Token', 'p', 1]
    ],
  },
  {
    slug: 'neteller',
    name: 'Neteller',
    version: '1.0.0',
    description: 'Neteller payment gateway integration for EdgePay',
    category: 'global',
    color: '#8CC63F',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['client_id', 'Neteller Client ID', 't', 1],
    ['client_secret', 'Neteller Client Secret', 'p', 1]
    ],
  },
  {
    slug: 'nexuspay',
    name: 'NexusPay',
    version: '1.0.0',
    description: 'Dutch-Bangla Bank Limited (DBBL) NexusPay payment gateway integration',
    category: 'global',
    color: '#009688',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'nmi',
    name: 'NMI',
    version: '1.0.0',
    description: 'NMI payment gateway integration for EdgePay',
    category: 'global',
    color: '#0F172A',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['security_key', 'Security Key (Private API Key)', 'p', 1]
    ],
  },
  {
    slug: 'ok-wallet',
    name: 'OK Wallet',
    version: '1.0.0',
    description: 'ONE Bank OK Wallet mobile financial services payment integration',
    category: 'global',
    color: '#3F51B5',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['api_key', 'API Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'opay',
    name: 'OPay',
    version: '1.0.0',
    description: 'OPay Cashier Checkout and Digital Wallet Integration',
    category: 'mfs',
    color: '#00B5A3',
    currencies: ['NGN', 'EGP'],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['public_key', 'Public Key (Bearer token)', 't', 1],
    ['secret_key', 'Secret Key (Webhook Signature key)', 'p', 1]
    ],
  },
  {
    slug: 'opennode',
    name: 'OpenNode',
    version: '1.0.0',
    description: 'OpenNode payment gateway integration for EdgePay',
    category: 'global',
    color: '#1A1A1A',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_key', 'API Key (Charge Permission)', 'p', 1]
    ],
  },
  {
    slug: 'ovo',
    name: 'OVO Wallet',
    version: '1.0.0',
    description: 'OVO Wallet payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#4C2A86',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['secret_key', 'Xendit Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'payline-data',
    name: 'Payline Data',
    version: '1.0.0',
    description: 'Payline Data payment gateway integration for EdgePay',
    category: 'global',
    color: '#0284C7',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['api_key', 'API Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'payme',
    name: 'PayMe by HSBC',
    version: '1.0.0',
    description: 'PayMe by HSBC payment gateway integration for EdgePay',
    category: 'global',
    color: '#E60028',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['client_id', 'Client ID', 't', 1],
    ['client_secret', 'Client Secret', 'p', 1],
    ['signing_key', 'Signing Key ID', 't', 1]
    ],
  },
  {
    slug: 'payment-depot',
    name: 'Payment Depot',
    version: '1.0.0',
    description: 'Payment Depot payment gateway integration for EdgePay',
    category: 'global',
    color: '#059669',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Payment Depot API Key', 'p', 1]
    ],
  },
  {
    slug: 'payoneer',
    name: 'Payoneer',
    version: '1.0.0',
    description: 'Payoneer payment gateway integration for EdgePay',
    category: 'global',
    color: '#FF4E00',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['client_id', 'Payoneer Client ID', 't', 1],
    ['client_secret', 'Payoneer Client Secret', 'p', 1]
    ],
  },
  {
    slug: 'paystack',
    name: 'Paystack',
    version: '1.0.0',
    description: 'Paystack payment gateway integration for EdgePay',
    category: 'global',
    color: '#3ECF8E',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['public_key', 'Public Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'paytrace',
    name: 'Paytrace',
    version: '1.0.0',
    description: 'Paytrace payment gateway integration for EdgePay',
    category: 'global',
    color: '#4F46E5',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['username', 'Paytrace Username', 't', 1],
    ['password', 'Paytrace Password', 'p', 1]
    ],
  },
  {
    slug: 'payu',
    name: 'PayU India',
    version: '1.0.0',
    description: 'PayU India secure checkout integration',
    category: 'mfs',
    color: '#84c01a',
    currencies: ['INR'],
    capabilities: ['verification'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_key', 'Merchant Key', 't', 1],
    ['salt', 'Merchant Salt', 'p', 1]
    ],
  },
  {
    slug: 'phonepe',
    name: 'PhonePe',
    version: '1.0.0',
    description: 'PhonePe payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#5F259F',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['salt_key', 'Salt Key', 'p', 1],
    ['salt_index', 'Salt Index', 't', 1]
    ],
  },
  {
    slug: 'portwallet',
    name: 'PortWallet',
    version: '1.0.0',
    description: 'PortWallet payment gateway and aggregator service supporting cards and MFS',
    category: 'global',
    color: '#FF5722',
    currencies: ['BDT', 'USD'],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['legacy-md5'],
    fields: [
    ['app_key', 'App Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'promptpay',
    name: 'PromptPay QR',
    version: '1.0.0',
    description: 'PromptPay QR payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#003B70',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['secret_key', 'Omise Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'rapyd',
    name: 'Rapyd',
    version: '1.0.0',
    description: 'Rapyd payment gateway integration for EdgePay',
    category: 'global',
    color: '#FF5A00',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['access_key', 'Rapyd Access Key', 't', 1],
    ['secret_key', 'Rapyd Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'sezzle',
    name: 'Sezzle',
    version: '1.0.0',
    description: 'Sezzle checkout integration for EdgePay',
    category: 'global',
    color: '#8A5CF5',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['public_key', 'Public Key', 't', 1],
    ['private_key', 'Private Key', 'p', 1]
    ],
  },
  {
    slug: 'shift4',
    name: 'Shift4',
    version: '1.0.0',
    description: 'Shift4 payment gateway integration for EdgePay',
    category: 'global',
    color: '#000000',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'API Secret Key', 'p', 1],
    ['webhook_secret', 'Webhook Secret', 'p', 1]
    ],
  },
  {
    slug: 'shopeepay',
    name: 'ShopeePay',
    version: '1.0.0',
    description: 'ShopeePay e-wallet integration via Omise hosted sources',
    category: 'mfs',
    color: '#EE4D2D',
    currencies: ['THB', 'MYR', 'SGD'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['secret_key', 'Omise Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'shurjopay',
    name: 'shurjoPay',
    version: '1.0.0',
    description: 'Accept shurjoPay payments directly from customers.',
    category: 'mobile',
    color: '#eb7324',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['prefix', 'Transaction Prefix', 't', 1],
    ['username', 'Username', 't', 1],
    ['password', 'Password', 't', 1]
    ],
  },
  {
    slug: 'skrill',
    name: 'Skrill',
    version: '1.0.0',
    description: 'Skrill payment gateway integration for EdgePay',
    category: 'global',
    color: '#8A1538',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['pay_to_email', 'Skrill Account Email', 't', 1],
    ['secret_word', 'Skrill Secret Word', 'p', 1]
    ],
  },
  {
    slug: 'square',
    name: 'Square Payments',
    version: '1.0.0',
    description: 'Square Payments payment gateway integration for EdgePay',
    category: 'global',
    color: '#000000',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['access_token', 'Access Token', 'p', 1],
    ['location_id', 'Location ID', 't', 1]
    ],
  },
  {
    slug: 'sslcommerz',
    name: 'SSLCommerz',
    version: '1.0.0',
    description: 'SSLCommerz payment gateway for Bangladesh',
    category: 'global',
    color: '#2B4BC0',
    currencies: ['BDT', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'SGD'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['store_id', 'Store ID', 't', 1],
    ['store_passwd', 'Store Password', 'p', 1]
    ],
  },
  {
    slug: 'stax',
    name: 'Stax',
    version: '1.0.0',
    description: 'Stax payment gateway integration for EdgePay',
    category: 'global',
    color: '#4F46E5',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Stax Secret API Key', 'p', 1]
    ],
  },
  {
    slug: 'tap',
    name: 'Tap',
    version: '1.0.0',
    description: 'Trust Axiata Pay (Tap) mobile financial services and digital checkout integration',
    category: 'global',
    color: '#E91E63',
    currencies: ['BDT'],
    capabilities: ['verification'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['api_key', 'API Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'touch-n-go',
    name: 'Touch \'n Go eWallet',
    version: '1.0.0',
    description: 'Touch \'n Go eWallet payment integration via Stripe PaymentIntent',
    category: 'mfs',
    color: '#0052B4',
    currencies: ['MYR'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['secret_key', 'Stripe Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'truemoney',
    name: 'TrueMoney Wallet',
    version: '1.0.0',
    description: 'TrueMoney e-wallet integration via Omise hosted sources',
    category: 'mfs',
    color: '#FF8F00',
    currencies: ['THB'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['secret_key', 'Omise Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'trustcommerce',
    name: 'TrustCommerce',
    version: '1.0.0',
    description: 'TrustCommerce payment gateway integration for EdgePay',
    category: 'global',
    color: '#024731',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['custid', 'Customer ID', 't', 1],
    ['password', 'Password', 'p', 1]
    ],
  },
  {
    slug: 'tsys',
    name: 'TSYS',
    version: '1.0.0',
    description: 'TSYS payment gateway integration for EdgePay',
    category: 'global',
    color: '#0D9488',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['device_id', 'Device ID', 't', 1]
    ],
  },
  {
    slug: 'upay',
    name: 'Upay',
    version: '1.0.0',
    description: 'Upay payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#FFCC00',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected', 'token-grant'],
    fields: [
    ['api_key', 'API Key', 't', 1],
    ['api_secret', 'API Secret', 'p', 1],
    ['merchant_id', 'Merchant ID', 't', 1]
    ],
  },
  {
    slug: 'wechat-pay',
    name: 'WeChat Pay',
    version: '1.0.0',
    description: 'WeChat Pay payment gateway integration for EdgePay',
    category: 'global',
    color: '#09BB07',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['app_id', 'App ID', 't', 1],
    ['mch_id', 'Merchant ID', 't', 1],
    ['private_key', 'Merchant Private Key', 'ta', 1],
    ['serial_no', 'Certificate Serial Number', 't', 1]
    ],
  },
  {
    slug: 'wise',
    name: 'Wise',
    version: '1.0.0',
    description: 'Wise payment gateway integration for EdgePay',
    category: 'global',
    color: '#00E676',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_token', 'API Token', 'p', 1],
    ['profile_id', 'Profile ID', 't', 1]
    ],
  },
  {
    slug: 'worldline',
    name: 'Worldline Connect',
    version: '1.0.0',
    description: 'Worldline Connect payment gateway integration for EdgePay',
    category: 'bank',
    color: '#0066B3',
    currencies: [],
    capabilities: ['verification'],
    status: 'ported',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['api_key', 'API Key (Key ID)', 't', 1],
    ['api_secret', 'API Secret', 'p', 1],
    ['merchant_id', 'Merchant ID', 't', 1]
    ],
  },
  {
    slug: 'worldpay',
    name: 'Worldpay',
    version: '1.0.0',
    description: 'Worldpay payment gateway integration for EdgePay',
    category: 'global',
    color: '#0F172A',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['service_key', 'Service Key', 'p', 1],
    ['client_key', 'Client Key', 't', 1]
    ],
  },
  {
    slug: 'xendit',
    name: 'Xendit',
    version: '1.0.0',
    description: 'Xendit payment gateway integration for Southeast Asia',
    category: 'apac',
    color: '#1572E8',
    currencies: ['IDR', 'PHP', 'USD', 'SGD'],
    capabilities: ['verification', 'webhook'],
    status: 'ported',
    flags: [],
    fields: [
    ['api_key', 'Secret API Key', 'p', 1],
    ['callback_token', 'Callback Verification Token', 'p', 1]
    ],
  },
  {
    slug: 'airtel-money',
    name: 'Airtel Money',
    version: '1.0.0',
    description: 'Airtel Money payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#FF0000',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['client_id', 'Client ID', 't', 1],
    ['client_secret', 'Client Secret', 'p', 1]
    ],
  },
  {
    slug: 'alipay',
    name: 'Alipay Global',
    version: '1.0.0',
    description: 'Alipay Global payment gateway integration for EdgePay',
    category: 'global',
    color: '#00A4FF',
    currencies: [],
    capabilities: [],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['app_id', 'App ID (Partner ID)', 't', 1],
    ['private_key', 'Private Key', 'ta', 1],
    ['alipay_public_key', 'Alipay Public Key', 'ta', 0]
    ],
  },
  {
    slug: 'apple-pay',
    name: 'Apple Pay',
    version: '1.0.0',
    description: 'Apple Pay Express Checkout gateway plugin',
    category: 'express',
    color: '#080D1A',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['publishable_key', 'Stripe Publishable Key', 't', 0],
    ['secret_key', 'Stripe Secret Key', 'p', 0],
    ['webhook_secret', 'Stripe Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: 'billplz',
    name: 'Billplz',
    version: '1.0.0',
    description: 'Billplz Direct Debit payment integration for Malaysia',
    category: 'mfs',
    color: '#00AFEC',
    currencies: ['MYR'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['api_key', 'API Key', 'p', 1],
    ['signature_key', 'X-Signature Key', 'p', 1],
    ['collection_id', 'Collection ID', 't', 1]
    ],
  },
  {
    slug: 'binance-merchant-api',
    name: 'Binance Pay',
    version: '1.0.0',
    description: 'Binance Pay merchant API gateway integration',
    category: 'global',
    color: '#F0B90B',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_api_key', 'Merchant API Key', 't', 1],
    ['merchant_secret_key', 'Merchant Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'binance-personal',
    name: 'Binance Personal Address',
    version: '1.0.0',
    description: 'Binance Personal Address payment gateway integration for EdgePay',
    category: 'global',
    color: '#F3BA2F',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['wallet_address', 'Binance Smart Chain (BSC) Address', 't', 1],
    ['bscscan_api_key', 'BscScan API Key', 'p', 0]
    ],
  },
  {
    slug: 'blik',
    name: 'BLIK',
    version: '1.0.0',
    description: 'BLIK payment gateway integration for EdgePay',
    category: 'europe',
    color: '#000000',
    currencies: ['PLN'],
    capabilities: ['refund', 'verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['pos_id', 'POS ID', 't', 1],
    ['crc_key', 'CRC Key', 'p', 1],
    ['api_key', 'API Key', 'p', 1]
    ],
  },
  {
    slug: 'braintree',
    name: 'Braintree',
    version: '1.0.0',
    description: 'Braintree payment gateway integration for EdgePay',
    category: 'global',
    color: '#3465A4',
    currencies: [],
    capabilities: ['refund', 'verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['public_key', 'Public Key', 't', 1],
    ['private_key', 'Private Key', 'p', 1]
    ],
  },
  {
    slug: 'cashfree',
    name: 'Cashfree',
    version: '1.0.0',
    description: 'Cashfree PG hosted checkout integration',
    category: 'mfs',
    color: '#2d62e6',
    currencies: ['INR'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['client_id', 'Client ID', 't', 1],
    ['client_secret', 'Client Secret', 'p', 1]
    ],
  },
  {
    slug: 'cashmaal',
    name: 'CashMaal',
    version: '1.0.0',
    description: 'CashMaal payment gateway integration',
    category: 'global',
    color: '#1F95F4',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: [],
    fields: [
    ['web_id', 'Website ID (web_id)', 't', 1]
    ],
  },
  {
    slug: 'ccavenue',
    name: 'CCAvenue',
    version: '1.0.0',
    description: 'CCAvenue payment gateway integration for EdgePay',
    category: 'bank',
    color: '#F58220',
    currencies: [],
    capabilities: [],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['access_code', 'Access Code', 't', 1],
    ['working_key', 'Working Key', 'p', 1]
    ],
  },
  {
    slug: 'checkout-com',
    name: 'Checkout.com',
    version: '1.0.0',
    description: 'Checkout.com payment gateway integration for EdgePay',
    category: 'global',
    color: '#000000',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['public_key', 'Public API Key', 't', 1],
    ['secret_key', 'Secret API Key', 'p', 1],
    ['webhook_secret', 'Webhook Signature Secret', 'p', 1]
    ],
  },
  {
    slug: 'eps',
    name: 'EPS',
    version: '1.0.0',
    description: 'EPS payment gateway integration',
    category: 'mfs',
    color: '#019A44',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['store_id', 'Store ID', 't', 1],
    ['hash_key', 'Hash Key', 'p', 1],
    ['username', 'Username', 't', 1],
    ['password', 'Password', 'p', 1]
    ],
  },
  {
    slug: 'fawry',
    name: 'Fawry Pay',
    version: '1.0.0',
    description: 'Fawry Pay gateway integration for Egypt/MENA',
    category: 'mena',
    color: '#fcb813',
    currencies: ['EGP', 'USD'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_code', 'Merchant Code', 't', 1],
    ['security_key', 'Security Key (Secret)', 'p', 1]
    ],
  },
  {
    slug: 'giropay',
    name: 'Giropay',
    version: '1.0.0',
    description: 'Giropay payment gateway integration for EdgePay',
    category: 'europe',
    color: '#002F6C',
    currencies: ['EUR'],
    capabilities: ['refund', 'verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['project_id', 'Project ID', 't', 1],
    ['project_password', 'Project Password/Key', 'p', 1]
    ],
  },
  {
    slug: 'google-pay',
    name: 'Google Pay',
    version: '1.0.0',
    description: 'Google Pay Express Checkout gateway plugin',
    category: 'express',
    color: '#4285F4',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['publishable_key', 'Stripe Publishable Key', 't', 0],
    ['secret_key', 'Stripe Secret Key', 'p', 0],
    ['webhook_secret', 'Stripe Webhook Secret', 'p', 0]
    ],
  },
  {
    slug: 'instamojo',
    name: 'Instamojo',
    version: '1.0.0',
    description: 'Instamojo secure payment request API integration',
    category: 'mfs',
    color: '#00a294',
    currencies: ['INR'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['client_id', 'Client ID', 't', 1],
    ['client_secret', 'Client Secret', 'p', 1],
    ['salt', 'Secret Salt (Salt from Developer Profile)', 'p', 1]
    ],
  },
  {
    slug: 'jazzcash',
    name: 'JazzCash',
    version: '1.0.0',
    description: 'JazzCash payment gateway integration for EdgePay',
    category: 'mfs',
    color: '#FFCC00',
    currencies: [],
    capabilities: [],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['password', 'Password', 'p', 1],
    ['integrity_salt', 'Integrity Salt', 'p', 1]
    ],
  },
  {
    slug: 'klarna',
    name: 'Klarna',
    version: '1.0.0',
    description: 'Klarna payment gateway integration for EdgePay',
    category: 'global',
    color: '#FFB3C7',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['username', 'API Username (UID)', 't', 1],
    ['password', 'API Password', 'p', 1]
    ],
  },
  {
    slug: 'kushki',
    name: 'Kushki',
    version: '1.0.0',
    description: 'Kushki payment gateway integration for Latin America',
    category: 'latam',
    color: '#e83e8c',
    currencies: ['USD', 'COP', 'MXN', 'PEN', 'CLP'],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['private_merchant_id', 'Private Merchant ID', 'p', 1],
    ['public_merchant_id', 'Public Merchant ID', 't', 1]
    ],
  },
  {
    slug: 'mtn-momo',
    name: 'MTN Mobile Money',
    version: '1.0.0',
    description: 'MTN Mobile Money Collection API Integration',
    category: 'mfs',
    color: '#FFCC00',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected', 'token-grant'],
    fields: [
    ['api_user_id', 'API User ID (UUID)', 't', 1],
    ['api_key', 'API Key', 'p', 1],
    ['subscription_key', 'Subscription Key (Ocp-Apim-Subscription-Key)', 'p', 1]
    ],
  },
  {
    slug: 'myfatoorah',
    name: 'MyFatoorah',
    version: '1.0.0',
    description: 'MyFatoorah V2 Invoice and Payment Gateway Integration',
    category: 'global',
    color: '#00A9E0',
    currencies: ['KWD', 'SAR', 'AED', 'BHD', 'OMR', 'QAR', 'EGP', 'USD', 'EUR'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['api_key', 'API Token (Bearer)', 'p', 1],
    ['webhook_secret', 'Webhook Secret Key', 'p', 0]
    ],
  },
  {
    slug: 'now-payments',
    name: 'NowPayments Crypto',
    version: '1.0.0',
    description: 'Accept NowPayments Crypto payments directly from customers.',
    category: 'global',
    color: '#4CC38A',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['now_payment_api_key', 'NOWPayments API Key', 't', 1],
    ['now_payment_ipn_secret', 'NOWPayments IPN Secret Key', 't', 1]
    ],
  },
  {
    slug: 'orange-money',
    name: 'Orange Money',
    version: '1.0.0',
    description: 'Orange Money Web Payment API Integration',
    category: 'mfs',
    color: '#FF6600',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected', 'token-grant'],
    fields: [
    ['client_id', 'Consumer Key (Client ID)', 't', 1],
    ['client_secret', 'Consumer Secret (Client Secret)', 'p', 1],
    ['merchant_key', 'Merchant Key', 'p', 1]
    ],
  },
  {
    slug: 'oxapay',
    name: 'OxaPay Crypto',
    version: '1.0.0',
    description: 'Accept OxaPay Crypto payments directly from customers.',
    category: 'crypto',
    color: '#f15a24',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_api_key', 'Merchant API Key', 't', 1]
    ],
  },
  {
    slug: 'paddle',
    name: 'Paddle',
    version: '1.0.0',
    description: 'Paddle payment gateway integration for EdgePay',
    category: 'global',
    color: '#00FF88',
    currencies: [],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['api_key', 'Paddle API Key', 'p', 1],
    ['webhook_secret', 'Webhook Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'pagseguro',
    name: 'PagSeguro',
    version: '1.0.0',
    description: 'PagSeguro payment gateway integration for EdgePay',
    category: 'global',
    color: '#00B1EA',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['email', 'Merchant Email', 't', 1],
    ['token', 'API Token', 'p', 1]
    ],
  },
  {
    slug: 'payfast',
    name: 'Payfast',
    version: '1.0.0',
    description: 'Payfast payment gateway integration for South Africa',
    category: 'africa',
    color: '#e35e25',
    currencies: ['ZAR'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['legacy-md5'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['merchant_key', 'Merchant Key', 't', 1],
    ['passphrase', 'Secure Passphrase', 'p', 0]
    ],
  },
  {
    slug: 'paystation',
    name: 'PayStation',
    version: '1.0.0',
    description: 'Accept PayStation payments directly from customers.',
    category: 'mobile',
    color: '#e01a22',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['merchant_password', 'Merchant Password', 't', 1],
    ['checkout_items', 'Checkout Items', 't', 0]
    ],
  },
  {
    slug: 'paytabs',
    name: 'PayTabs',
    version: '1.0.0',
    description: 'PayTabs payment gateway integration for EdgePay',
    category: 'mena',
    color: '#007cbe',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['profile_id', 'PayTabs Profile ID', 't', 1],
    ['server_key', 'Server Key', 'p', 1]
    ],
  },
  {
    slug: 'paytm',
    name: 'Paytm',
    version: '1.0.0',
    description: 'Paytm secure transaction token showPaymentPage integration',
    category: 'mfs',
    color: '#002970',
    currencies: ['INR'],
    capabilities: ['verification'],
    status: 'planned',
    flags: [],
    fields: [
    ['mid', 'Merchant ID (MID)', 't', 1],
    ['merchant_key', 'Merchant Key', 'p', 1],
    ['website', 'Website (e.g. WEBSTAGING or DEFAULT)', 't', 1]
    ],
  },
  {
    slug: 'pix',
    name: 'Pix Dynamic',
    version: '1.0.0',
    description: 'Pix Dynamic payment gateway integration for EdgePay',
    category: 'bank',
    color: '#32B4A4',
    currencies: [],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: ['token-grant'],
    fields: [
    ['access_token', 'Mercado Pago Access Token', 'p', 1]
    ],
  },
  {
    slug: 'przelewy24',
    name: 'Przelewy24',
    version: '1.0.0',
    description: 'Przelewy24 payment gateway integration for EdgePay',
    category: 'europe',
    color: '#D32F2F',
    currencies: ['PLN', 'EUR', 'GBP', 'USD'],
    capabilities: ['refund', 'verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['merchant_id', 'Merchant ID', 't', 1],
    ['pos_id', 'POS ID', 't', 1],
    ['crc_key', 'CRC Key', 'p', 1],
    ['api_key', 'API Key/Reports Key', 'p', 1]
    ],
  },
  {
    slug: 'sofort',
    name: 'Sofort',
    version: '1.0.0',
    description: 'Sofort payment gateway integration for EdgePay',
    category: 'europe',
    color: '#FFB3C7',
    currencies: ['EUR', 'CHF', 'GBP', 'PLN', 'HUF'],
    capabilities: ['refund', 'verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['customer_id', 'Customer ID', 't', 1],
    ['project_id', 'Project ID', 't', 1],
    ['api_key', 'API Key', 'p', 1]
    ],
  },
  {
    slug: 'tap-payments',
    name: 'Tap Payments',
    version: '1.0.0',
    description: 'Tap Payments (goSell API v2) Checkout Integration',
    category: 'global',
    color: '#00A3FF',
    currencies: ['KWD', 'SAR', 'AED', 'BHD', 'OMR', 'QAR', 'EGP', 'USD', 'GBP', 'EUR'],
    capabilities: ['verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['secret_key', 'Secret Key (sk_...)', 'p', 1],
    ['webhook_secret', 'Webhook Shared Secret', 'p', 0]
    ],
  },
  {
    slug: 'toss',
    name: 'Toss Payments',
    version: '1.0.0',
    description: 'Toss Payments payment gateway integration for EdgePay',
    category: 'global',
    color: '#0064FF',
    currencies: [],
    capabilities: ['verification'],
    status: 'planned',
    flags: ['webhook-unsigned-rejected'],
    fields: [
    ['client_key', 'Client Key', 't', 1],
    ['secret_key', 'Secret Key', 'p', 1]
    ],
  },
  {
    slug: 'trustly',
    name: 'Trustly',
    version: '1.0.0',
    description: 'Trustly bank payment gateway integration for EdgePay',
    category: 'europe',
    color: '#43B02A',
    currencies: ['EUR', 'SEK', 'NOK', 'DKK', 'GBP', 'PLN'],
    capabilities: ['refund', 'verification', 'webhook'],
    status: 'planned',
    flags: [],
    fields: [
    ['username', 'API Username', 't', 1],
    ['password', 'API Password', 'p', 1],
    ['private_key', 'Merchant Private Key (PEM)', 'ta', 0]
    ],
  },
];

/**
 * P0-7 quarantine helpers — planned-subset support for
 * GET /api/v1/gateways (?include=planned) and docs.
 *
 * `planned` = 37 catalog scaffolds + 16 quarantined broken ports = 53.
 * Files for quarantined adapters stay on disk (generated/*.gateway.ts)
 * but are hidden from the default list; explicit opt-in surfaces them
 * as fail-closed planned stubs (GatewayNotPortedError on initiate).
 */
export const PLANNED_GATEWAY_SLUGS: readonly string[] = GATEWAY_CATALOG.filter(
  (e) => e.status === 'planned',
).map((e) => e.slug);

export const PLANNED_GATEWAY_COUNT: number = PLANNED_GATEWAY_SLUGS.length;
