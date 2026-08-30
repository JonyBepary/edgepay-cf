/**
 * Planned-gateway stubs — catalog-driven adapters for providers whose port
 * is not yet complete.
 *
 * Why stubs exist: the catalog must list all 123 providers (the deploy-time
 * selector and the admin UI need the full inventory), but a handful of
 * upstream PHP adapters implement flows this port does not yet carry
 * (payment-token decryption, XML payloads, AES-CBC form crypto, ...).
 * Shipping a catalog entry WITHOUT an adapter would make ENABLED_GATEWAYS
 * validation inconsistent; shipping a half-wrong adapter is worse.
 *
 * Behaviour — deliberately loud and fail-closed:
 *   - metadata()/fields() come from the catalog (admin UI renders correctly)
 *   - initiate() throws GatewayNotPortedError (surfaces as 502 GATEWAY_ERROR)
 *   - verify() returns failed, verifyWebhook() returns false
 *   - catalog status: 'planned' — GET /api/v1/gateways marks them clearly
 */

import {
  BaseGatewayAdapter,
  type GatewayMetadata,
  type GatewayField,
  type InitiateParams,
  type InitiateResult,
  type VerifyResult,
  type VerifyWebhookInput,
  type Credentials,
} from '../base';
import { GATEWAY_CATALOG, type CatalogEntry } from '../catalog.data';
import { gatewayRegistry } from '../base';

export class GatewayNotPortedError extends Error {
  constructor(slug: string) {
    super(
      `Gateway "${slug}" is listed in the catalog but its adapter port is not ` +
      `complete in this build. It cannot process payments yet — see ` +
      `docs/GATEWAYS.md (planned gateways).`,
    );
    this.name = 'GatewayNotPortedError';
  }
}

class PlannedGatewayStub extends BaseGatewayAdapter {
  constructor(private readonly entry: CatalogEntry) {
    super();
  }

  metadata(): GatewayMetadata {
    return {
      name: this.entry.name,
      slug: this.entry.slug,
      version: this.entry.version,
      description: this.entry.description,
      author: 'EdgePay Gateway Suite (AGPLv3) (planned)',
      type: 'gateway',
      supported_currencies: [...this.entry.currencies],
      capabilities: [...this.entry.capabilities],
    };
  }

  fields(): GatewayField[] {
    return this.entry.fields.map((f) => ({
      name: String(f[0]),
      label: String(f[1]),
      type: (['text', 'password', 'select', 'checkbox', 'textarea'].includes(String(f[2]))
        ? String(f[2])
        : 'text') as GatewayField['type'],
      required: f[3] === 1,
      ...(f[4] !== undefined ? { options: f[4] as Record<string, string> } : {}),
    })) as GatewayField[];
  }

  async initiate(_params: InitiateParams, _credentials: Credentials): Promise<InitiateResult> {
    throw new GatewayNotPortedError(this.entry.slug);
  }

  async verify(_callbackData: Record<string, unknown>, _credentials: Credentials): Promise<VerifyResult> {
    return { success: false, gateway_trx_id: '', amount: null, status: 'failed' };
  }

  async verifyWebhook(_input: VerifyWebhookInput): Promise<boolean> {
    return false;
  }
}

/**
 * Register stubs for every catalog gateway that no adapter has claimed yet.
 * MUST be imported after the real adapter registrations (core + hand +
 * generated) so the "already registered" check sees them.
 */
export function registerPlannedGateways(): string[] {
  const registered: string[] = [];
  for (const entry of GATEWAY_CATALOG) {
    if (entry.status !== 'planned') continue;
    if (gatewayRegistry.has(entry.slug)) continue;
    gatewayRegistry.register(entry.slug, () => new PlannedGatewayStub(entry));
    registered.push(entry.slug);
  }
  return registered;
}

/** Catalog slugs that ship as planned stubs in this build. */
export function plannedGatewaySlugs(): string[] {
  return GATEWAY_CATALOG.filter((e) => e.status === 'planned').map((e) => e.slug);
}
