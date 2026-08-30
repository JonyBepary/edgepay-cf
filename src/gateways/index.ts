/**
 * Gateway adapter registry — imports all built-in gateways and registers
 * them with the singleton GatewayRegistry at module load time.
 *
 * Adapter sources (registration order matters — planned stubs register LAST
 * so real adapters claim their slugs first):
 *   1. core 5 (hand-written, battle-tested)
 *   2. BD hand-ports (rocket, sslcommerz, aamarpay, shurjopay, portwallet)
 *   3. generated adapters (scripts/port-gateways — the full catalog port)
 *   4. planned stubs (catalog-driven; see ./planned)
 */

import { gatewayRegistry } from './base';
import { StripeGateway } from './stripe/stripe.gateway';
import { PayPalGateway } from './paypal/paypal.gateway';
import { BkashApiGateway } from './bkash/bkash.gateway';
import { RazorpayGateway } from './razorpay/razorpay.gateway';
import { NagadGateway } from './nagad/nagad.gateway';
import { RocketGateway } from './rocket/rocket.gateway';
import { SslCommerzGateway } from './sslcommerz/sslcommerz.gateway';
import { AamarpayGateway } from './aamarpay/aamarpay.gateway';
import { ShurjopayGateway } from './shurjopay/shurjopay.gateway';
import { PortWalletGateway } from './portwallet/portwallet.gateway';
import { registerPlannedGateways } from './planned';

// Register built-in gateways
gatewayRegistry.register('stripe', () => new StripeGateway());
gatewayRegistry.register('paypal', () => new PayPalGateway());
gatewayRegistry.register('bkash-api', () => new BkashApiGateway());
gatewayRegistry.register('razorpay', () => new RazorpayGateway());
gatewayRegistry.register('nagad-merchant-api', () => new NagadGateway());

// BD hand-ported reference adapters
gatewayRegistry.register('rocket', () => new RocketGateway());
gatewayRegistry.register('sslcommerz', () => new SslCommerzGateway());
gatewayRegistry.register('aamarpay', () => new AamarpayGateway());
gatewayRegistry.register('shurjopay', () => new ShurjopayGateway());
gatewayRegistry.register('portwallet', () => new PortWalletGateway());

// Full-catalog generated adapters (registers itself on import)
import './generated';

// Planned stubs last (catalog-driven; skips anything already registered)
registerPlannedGateways();

// Re-export for convenience
export { gatewayRegistry };
export { StripeGateway, PayPalGateway, BkashApiGateway, RazorpayGateway, NagadGateway };
export { RocketGateway, SslCommerzGateway, AamarpayGateway, ShurjopayGateway, PortWalletGateway };
export * from './base';
// v0.2.3+: gateway-plugin selection (ENABLED_GATEWAYS platform gate)
export * from './enabled';
// v0.3.0: full 123-provider catalog
export * from './catalog';
