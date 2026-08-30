/**
 * Registry slugs of every adapter registered in this build.
 *
 * Three adapter sources:
 *   - core: the five battle-tested hand-written adapters (pre-port)
 *   - hand: BD reference hand-ports (rocket, sslcommerz, aamarpay,
 *           shurjopay, portwallet)
 *   - generated: adapters produced by scripts/port-gateways/generate.py
 *   - planned: catalog-driven stubs for providers whose port is pending
 *     (listed in the catalog with status 'planned')
 *
 * A conformance test pins this list against the actual registry.
 */

export const CORE_GATEWAY_SLUGS = [
  'stripe',
  'paypal',
  'bkash-api',
  'razorpay',
  'nagad-merchant-api',
] as const;

export const HAND_PORTED_GATEWAY_SLUGS = [
  'rocket',
  'sslcommerz',
  'aamarpay',
  'shurjopay',
  'portwallet',
] as const;

import { GENERATED_GATEWAY_SLUGS } from './generated';
import { plannedGatewaySlugs } from './planned';

/** Every adapter slug registered in this build, including planned stubs. */
export const IMPLEMENTED_GATEWAY_SLUGS: readonly string[] = Array.from(
  new Set<string>([
    ...CORE_GATEWAY_SLUGS,
    ...HAND_PORTED_GATEWAY_SLUGS,
    ...GENERATED_GATEWAY_SLUGS,
    ...plannedGatewaySlugs(),
  ]),
).sort();

/** Slugs whose port is complete (excludes planned stubs). */
export const PORTED_GATEWAY_SLUGS: readonly string[] = Array.from(
  new Set<string>([
    ...CORE_GATEWAY_SLUGS,
    ...HAND_PORTED_GATEWAY_SLUGS,
    ...GENERATED_GATEWAY_SLUGS,
  ]),
).sort();
