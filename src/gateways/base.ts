/**
 * Payment Gateway Adapter Interface — TypeScript port of EdgePay's
 * GatewayAdapterInterface (PHP).
 *
 * Every gateway provider (Stripe, PayPal, bKash, etc.) implements this
 * interface. The interface stays tiny and explicit — no optional methods,
 * no defaults in the base contract. Where a gateway doesn't support a
 * feature (e.g. manual gateways can't refund via API), they throw
 * UnsupportedError or return { success: false, error: 'unsupported' }.
 *
 * In TypeScript we use an abstract class with default implementations
 * instead of PHP's GatewayDefaults trait — same effect, less boilerplate.
 *
 * Adapter lifecycle:
 *   1. EdgePay receives POST /api/v1/payments with gateway_id
 *   2. GatewayRegistry resolves adapter by slug
 *   3. Adapter.initiate() called → returns redirect_url or form_html
 *   4. Customer completes payment at gateway
 *   5. Gateway calls back /checkout/{token}/callback OR sends webhook
 *      to /webhook/{gateway}
 *   6. Adapter.verify() or Adapter.verifyWebhook() called
 *   7. If verified → mark transaction completed + post ledger entries
 */

import type { Money } from '../lib/money';

// ---------------------------------------------------------------
// Gateway context — optional runtime services threaded to adapters
// ---------------------------------------------------------------

/**
 * Services the platform makes available to adapters. Optional in every
 * signature so adapters stay unit-testable with plain objects.
 *
 * kv: cross-isolate cache backing store. Used by TokenCache for
 *     OAuth-style token grants (bKash, MTN MoMo, MPesa, ...). Adapters
 *     MUST treat it as an optimization — a missing KV degrades to
 *     per-request token grants, never a hard failure.
 */
export interface GatewayContext {
  kv?: import('../types/env').Env['KV'];
}

// ---------------------------------------------------------------
// Initiate payment parameters
// ---------------------------------------------------------------
export interface InitiateParams {
  /** Transaction amount as decimal string, e.g. "100.50" (bcmath-style) */
  amount: Money;
  /** ISO 4217 currency code, e.g. "USD", "BDT" */
  currency: string;
  /** EdgePay's internal transaction ID (UUID) */
  trx_id: string;
  /** URL the gateway should redirect to after payment completion */
  redirect_url: string;
  /** URL the gateway should redirect to on cancellation */
  cancel_url: string;
  /** Customer info (optional — used by some gateways for receipt) */
  customer?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  /** Free-form metadata preserved through the lifecycle */
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------
// Credentials — decrypted gateway config (passed to every adapter method)
// ---------------------------------------------------------------
export type Credentials = Record<string, string>;

// ---------------------------------------------------------------
// Initiate response — at least one of redirect_url / form_html / session_id
// ---------------------------------------------------------------
export interface InitiateResult {
  /** URL to redirect the customer's browser to (e.g. PayPal approval URL) */
  redirect_url?: string;
  /** Inline HTML form that auto-submits to the gateway (e.g. Razorpay) */
  form_html?: string;
  /** Gateway-side session ID for server-side verification (e.g. bKash paymentID) */
  session_id?: string;
}

// ---------------------------------------------------------------
// Verify response — return after gateway callback
// ---------------------------------------------------------------
export interface VerifyResult {
  success: boolean;
  gateway_trx_id: string;
  amount: Money | null;
  currency?: string;
  status: 'completed' | 'failed' | 'pending' | 'cancelled';
  error?: string;
  trx_id?: string;
}

// ---------------------------------------------------------------
// Webhook verification — uses raw body + headers for HMAC signature check
// ---------------------------------------------------------------
export interface VerifyWebhookInput {
  rawBody: string;
  headers: Record<string, string>;
  credentials: Credentials;
  /** Optional platform services (unused by most webhook verifiers). */
  ctx?: GatewayContext;
}

// ---------------------------------------------------------------
// Refund response
// ---------------------------------------------------------------
export interface RefundResult {
  success: boolean;
  refund_id?: string;
  error?: string;
}

// ---------------------------------------------------------------
// Gateway field definition — admin UI uses this to render the config form
// ---------------------------------------------------------------
export interface GatewayField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'checkbox' | 'textarea';
  required: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  default?: string;
}

// ---------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------
export interface GatewayMetadata {
  name: string;
  slug: string;
  version: string;
  description: string;
  author: string;
  type: 'gateway';
  icon?: string;
  supported_currencies: string[];
  capabilities: string[];     // ['refund', 'webhook', 'subscription']
}

// ---------------------------------------------------------------
// The abstract base class — adapters extend this
// ---------------------------------------------------------------
export abstract class BaseGatewayAdapter {
  /** Display metadata for the plugin catalog */
  abstract metadata(): GatewayMetadata;

  /** Configuration fields shown in the admin UI */
  fields(): GatewayField[] {
    return [];
  }

  /**
   * Initiate a payment. Implementations should make outbound HTTP calls
   * via the kit (src/gateways/kit/http.ts) so timeouts are enforced.
   */
  abstract initiate(
    params: InitiateParams,
    credentials: Credentials,
    ctx?: GatewayContext,
  ): Promise<InitiateResult>;

  /** Verify a synchronous callback (gateway redirects customer back here) */
  abstract verify(
    callbackData: Record<string, unknown>,
    credentials: Credentials,
    ctx?: GatewayContext,
  ): Promise<VerifyResult>;

  /**
   * Verify an asynchronous webhook (gateway POSTs to /webhook/{slug}).
   * Default impl: return false. Gateways that support webhooks override.
   */
  verifyWebhook(_input: VerifyWebhookInput): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * Issue a refund. Default: throw — gateways that don't support refunds
   * return error rather than throwing, so admin UI can show "unsupported".
   */
  refund(_gatewayTrxId: string, _amount: Money, _credentials: Credentials, _ctx?: GatewayContext): Promise<RefundResult> {
    return Promise.resolve({
      success: false,
      error: 'refund_not_supported',
    });
  }

  /**
   * Query the current status of a refund at the gateway. Used by the
   * RefundReconciliationWorkflow's poll loop. Default: 'pending' —
   * adapters without a status API keep the loop alive (the workflow
   * halts as errored after its poll window and pages for manual
   * review; it never silently gives up or polls forever).
   */
  queryRefundStatus(
    _gatewayRefundId: string,
    _credentials: Credentials,
  ): Promise<'completed' | 'pending' | 'failed'> {
    return Promise.resolve('pending');
  }

  /** Capability check */
  supports(feature: string): boolean {
    return this.metadata().capabilities.includes(feature);
  }

  /** Currencies supported natively */
  supportedCurrencies(): string[] {
    return this.metadata().supported_currencies;
  }
}

// ---------------------------------------------------------------
// Gateway Registry — factory + lookup
// ---------------------------------------------------------------
export class GatewayRegistry {
  private readonly adapters = new Map<string, () => BaseGatewayAdapter>();

  register(slug: string, factory: () => BaseGatewayAdapter): void {
    this.adapters.set(slug, factory);
  }

  /** Resolve an adapter instance by slug. Throws if not registered. */
  resolve(slug: string): BaseGatewayAdapter {
    const factory = this.adapters.get(slug);
    if (!factory) {
      throw new Error(`Gateway adapter not registered: ${slug}`);
    }
    return factory();
  }

  /** List all registered gateway slugs (for admin UI catalog) */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }

  has(slug: string): boolean {
    return this.adapters.has(slug);
  }
}

// Singleton registry — populated at module load by ./index.ts
export const gatewayRegistry = new GatewayRegistry();
