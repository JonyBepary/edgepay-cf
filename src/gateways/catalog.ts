/**
 * Gateway catalog reader — typed access to the 123-provider catalog.
 *
 * The catalog data (catalog.data.ts) is generated from the upstream PHP
 * gateway-plugin repository. This module is the human-facing API over
 * it: lookups, alias resolution, category grouping, and the expanded field
 * definitions the admin install UI renders.
 *
 * Never import catalog.data.ts directly — go through here so aliases and
 * field expansion stay consistent everywhere.
 */

import {
  CATALOG_VERSION,
  GATEWAY_CATALOG,
  type CatalogEntry,
  type CatalogStatus,
} from './catalog.data';

export { CATALOG_VERSION };
export type { CatalogEntry, CatalogStatus };

/** Field shape the admin UI / install API consumes. */
export interface CatalogField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'select' | 'checkbox' | 'textarea';
  required: boolean;
  options?: Record<string, string>;
}

export interface CatalogGatewayView extends Omit<CatalogEntry, 'fields'> {
  /** Expanded credential field definitions (names only — never values). */
  fields: CatalogField[];
}

function expandField(t: readonly unknown[]): CatalogField {
  const typeCodes: Record<string, CatalogField['type']> = {
    t: 'text',
    p: 'password',
    s: 'select',
    c: 'checkbox',
    ta: 'textarea',
  };
  return {
    name: String(t[0]),
    label: String(t[1]),
    type: typeCodes[String(t[2])] ?? 'text',
    required: t[3] === 1,
    ...(t[4] !== undefined && t[4] !== null ? { options: t[4] as Record<string, string> } : {}),
  };
}

/** All catalog entries (generated order: implemented → ported → experimental). */
export function catalogGateways(): CatalogGatewayView[] {
  return GATEWAY_CATALOG.map((e) => ({ ...e, fields: e.fields.map(expandField) }));
}

/** Look up a catalog entry by its registry slug. */
export function catalogFind(slug: string): CatalogGatewayView | undefined {
  const entry = GATEWAY_CATALOG.find((e) => e.slug === slug);
  return entry ? { ...entry, fields: entry.fields.map(expandField) } : undefined;
}

/**
 * Friendly aliases for ENABLED_GATEWAYS: every catalog slug maps to itself,
 * plus short-form aliases people naturally type.
 */
const EXTRA_ALIASES: Record<string, string> = {
  paypal: 'paypal', // registry slug (repo folder is paypal-checkout)
  'paypal-checkout': 'paypal',
  bkash: 'bkash-api',
  nagad: 'nagad-merchant-api',
  ssl: 'sslcommerz',
  mercadopago: 'mercadopago',
};

export function catalogAliases(): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const e of GATEWAY_CATALOG) aliases[e.slug] = e.slug;
  for (const [alias, slug] of Object.entries(EXTRA_ALIASES)) {
    if (aliases[slug]) aliases[alias] = slug;
  }
  return aliases;
}

/** Every registry slug in the catalog. */
export function catalogSlugs(): string[] {
  return GATEWAY_CATALOG.map((e) => e.slug);
}

/** Entries grouped by category (for the admin catalog page sections). */
export function catalogByCategory(): Record<string, CatalogGatewayView[]> {
  const groups: Record<string, CatalogGatewayView[]> = {};
  for (const e of GATEWAY_CATALOG) {
    const view = { ...e, fields: e.fields.map(expandField) };
    (groups[e.category] ??= []).push(view);
  }
  return groups;
}

/** Count by status — surfaced by GET /install readiness + docs. */
export function catalogCounts(): { total: number; implemented: number; ported: number; planned: number } {
  const count = (s: CatalogStatus) => GATEWAY_CATALOG.filter((e) => e.status === s).length;
  return {
    total: GATEWAY_CATALOG.length,
    implemented: count('implemented'),
    ported: count('ported'),
    planned: count('planned'),
  };
}
