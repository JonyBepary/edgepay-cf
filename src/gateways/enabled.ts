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
 */
export const GATEWAY_ALIASES: Record<string, ImplementedGatewaySlug> = {
  stripe: 'stripe',
  paypal: 'paypal',
  bkash: 'bkash-api',
  'bkash-api': 'bkash-api',
  razorpay: 'razorpay',
  nagad: 'nagad-merchant-api',
  'nagad-merchant-api': 'nagad-merchant-api',
};

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
    const canonical = GATEWAY_ALIASES[token];
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
