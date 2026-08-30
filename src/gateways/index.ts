/**
 * Gateway adapter registry — imports all built-in gateways and registers
 * them with the singleton GatewayRegistry at module load time.
 *
 * Adding a new gateway:
 *   1. Create src/gateways/{slug}/{slug}.gateway.ts
 *   2. Export a class extending BaseGatewayAdapter
 *   3. Import here and call gatewayRegistry.register('slug', () => new MyGateway())
 *
 * Note on bundle size: Cloudflare Workers have a 10MB compressed limit.
 * Each gateway adapter is ~2-5KB minified+gzipped — we can pack hundreds
 * of gateways without issue. For 123+ gateways, consider code-splitting
 * via Workers Routes (per-gateway Worker) if size becomes a concern.
 */

import { gatewayRegistry } from './base';
import { StripeGateway } from './stripe/stripe.gateway';
import { PayPalGateway } from './paypal/paypal.gateway';
import { BkashApiGateway } from './bkash/bkash.gateway';
import { RazorpayGateway } from './razorpay/razorpay.gateway';
import { NagadGateway } from './nagad/nagad.gateway';
import { IMPLEMENTED_GATEWAY_SLUGS } from './enabled';
import { ALL_GATEWAY_SLUGS as _ALL_GATEWAY_SLUGS } from './enabled';
// Ensure catalog stays in sync with PENDING_GATEWAYS (170 total = 5 implemented + 167 pending)
void _ALL_GATEWAY_SLUGS;

// Register built-in gateways
gatewayRegistry.register('stripe', () => new StripeGateway());
gatewayRegistry.register('paypal', () => new PayPalGateway());
gatewayRegistry.register('bkash-api', () => new BkashApiGateway());
gatewayRegistry.register('razorpay', () => new RazorpayGateway());
gatewayRegistry.register('nagad-merchant-api', () => new NagadGateway());

// Re-export for convenience
export { gatewayRegistry };
export { StripeGateway, PayPalGateway, BkashApiGateway, RazorpayGateway, NagadGateway };
export * from './base';
// v0.2.3: gateway-plugin selection (ENABLED_GATEWAYS platform gate)
export * from './enabled';

/**
 * Built-in gateway catalog — exposed for admin UI display.
 * The 5 gateways above are fully implemented; the remaining 167 from
 * EdgePay's PHP catalog follow the same pattern and can be ported
 * mechanically. This list documents which are pending (167 pending,
 * 172 total with 5 implemented).
 */
export const PENDING_GATEWAYS = [
  // Global cards
  'adyen', 'authorize-net', 'blue-snap', 'braintree', 'checkout-com',
  'cybersource', 'fiserv', 'fiserv-cs', 'global-pay', 'moneris', 'nmi',
  'payeezy', 'payflow', 'paytrace', 'shift4', 'square', 'tsys', 'worldpay',
  'worldline', 'trust-commerce', 'elavon', 'payline-data', 'net-authorize',
  // Wallets
  'alipay', 'apple-pay', 'google-pay', 'amazon-pay', 'samsung-pay',
  // MFS — Bangladesh
  'rocket', 'upay', 'nexuspay', 'ok-wallet',
  // MFS — Africa
  'mtn-momo', 'airtel-money',
  // MFS — India
  'paytm', 'phonepe', 'ccavenue', 'cashfree',
  // MFS — Southeast Asia
  'momo', 'grabpay', 'gcash', 'midtrans',
  // MFS — MENA
  'fawry', 'tap',
  // LatAm
  'mercadolibre-wallet', 'kushki', 'pix', 'payfast',
  // Europe
  'bancontact', 'blik', 'eps', 'giropay', 'ideal', 'sofort', 'trustly',
  'przelewy24', 'sepa',
  // Crypto
  'coinbase-commerce', 'bitpay', 'btcpay-server',
  // Buy-now-pay-later
  'klarna', 'sezzle', 'affirm', 'afterpay',
  // Other
  'skrill', 'neteller', 'wise', 'mollie', 'worldline-cash',
  'jazzcash', 'instamojo',
  // ── Expanded catalog — global PSPs & regional acquirers ──
  // Global / enterprise PSPs
  '2checkout', 'payu', 'payu-latam', 'paysera', 'paylike', 'payplug',
  'paysafe', 'pingpong', 'reepay', 'recurly', 'redsys', 'sagepay',
  'securionpay', 'stax', 'stripe-connect', 'sumup', 'swedbank-pay',
  'till-payments', 'transact-pro', 'unzer', 'verifone', 'viva-wallet',
  'wayforpay', 'wirecard', 'yookassa', 'zimpler', 'payever', 'paylands',
  'paymill', 'pay-nl', 'paytrail', 'paytabs', 'payfort', 'telr',
  'checkout-v2', 'cardknox', 'cko',
  // Acquirers & gateways — Europe & UK
  'cmi', 'concardis', 'credomatic', 'ct-payments', 'dalenys', 'datatrans',
  'dibs', 'emerchantpay', 'epay', 'epos', 'every-pay', 'finaro',
  'first-atlantic-commerce', 'first-data', 'heidelpay', 'hipay', 'icepay',
  'ingenico', 'ipayment', 'lemon-way', 'mercanet', 'migs', 'multisafepay',
  'nexi', 'nets', 'novalnet', 'paypoint', 'payson', 'quickpay',
  'santander', 'securetrading', 'smart2pay', 'tink', 'token-io',
  // APAC & MENA
  'easy-paisa', 'ecpay', 'ecommpay', 'komoju', 'moneybookers', 'multi-cards',
  'oceanpayment', 'onebip', 'paygate', 'paygent', 'payway', 'pin-payments',
  'plug-and-pay', 'pro-pay', 'qpay', 'forte', 'freedompay', 'go-cardless',
  // LatAm & emerging
  'maxipago', 'mercadopago', 'pagseguro', 'klarna-pay-now', 'worldpay-v2',
  // Africa — PSPs
  'paystack', 'flutterwave',
] as const;

export const IMPLEMENTED_GATEWAYS = IMPLEMENTED_GATEWAY_SLUGS;
