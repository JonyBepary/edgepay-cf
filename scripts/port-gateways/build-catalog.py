#!/usr/bin/env python3
"""
Build src/gateways/catalog.data.ts from the analyzer output.

The catalog is the single source of truth for "which gateways exist" —
consumed by:
  - src/gateways/enabled.ts     (ENABLED_GATEWAYS validation + aliases)
  - GET /api/v1/gateways        (deployer-facing catalog API)
  - the admin install UI        (credential field definitions)

Per gateway: identity (slug/name/category/color), currencies, capabilities,
credential field definitions, port status, and security flags.

Registry slug reconciliation:
  - plugin-repo 'paypal-checkout' -> registry slug 'paypal' (v0.2.2 name)
  - everything else keeps its repo folder slug

Usage: python3 build-catalog.py <analysis.json> <out: catalog.data.ts> <version>
"""

import json
import re
import sys

# Registry slugs of adapters that existed before the port (hand-written,
# battle-tested). The port generator skips these.
PRE_EXISTING = {
    'stripe': None,
    'paypal-checkout': 'paypal',
    'bkash-api': None,
    'razorpay': None,
    'nagad-merchant-api': None,
}

# Hand-ported adapters (BD reference set + special flows) — generator skips these.
HAND_PORTED = {
    'rocket', 'sslcommerz', 'aamarpay', 'shurjopay', 'portwallet',  # BD set
}

# Status is derived from the actual adapter sources:
#   implemented  -> PRE_EXISTING (core 5)
#   ported       -> HAND_PORTED or emitted by generate.py (generated/index.ts)
#   planned      -> everything else (ships a catalog-driven stub adapter)


def load_generated_slugs(path):
    try:
        text = open(path).read()
        import re as _re
        return set(_re.findall(r"^  '([a-z0-9-]+)',$", text, _re.M))
    except FileNotFoundError:
        return set()


GENERATED_SLUGS = load_generated_slugs('src/gateways/generated/index.ts')

FIELD_TYPE_MAP = {'text': 't', 'password': 'p', 'select': 's', 'checkbox': 'c', 'textarea': 'ta'}


def class_name(slug: str) -> str:
    parts = re.split(r'[-_]', slug)
    return ''.join(p[:1].upper() + p[1:] for p in parts if p)


def slug_str(s: str) -> str:
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def main():
    analysis_path, out_path, version = sys.argv[1], sys.argv[2], sys.argv[3]
    data = json.load(open(analysis_path))

    entries = []
    for r in data:
        repo_slug = r['slug']
        registry_slug = PRE_EXISTING.get(repo_slug, None) if repo_slug in PRE_EXISTING else repo_slug
        if repo_slug in PRE_EXISTING and PRE_EXISTING[repo_slug] is None:
            registry_slug = repo_slug

        manifest = r['manifest']
        meta = r['metadata'] or {}
        currencies = r['currencies'] or []
        supports = set(r['supports'] or [])
        creds = r['fields'] or []

        if repo_slug in PRE_EXISTING:
            status = 'implemented'
        elif repo_slug in HAND_PORTED or repo_slug in GENERATED_SLUGS:
            status = 'ported'
        else:
            status = 'planned'

        # capabilities for metadata(): refund / webhook / verification
        capabilities = []
        if r['has_refund']:
            capabilities.append('refund')
        if 'verification' in supports or r['curl_calls']:
            capabilities.append('verification')
        # webhook capability only when a REAL signature scheme exists
        has_real_webhook = r['has_verify_webhook'] and not r['webhook_stub_true']
        if has_real_webhook:
            capabilities.append('webhook')

        flags = []
        if 'md5' in r.get('hash_usage', []):
            flags.append('legacy-md5')
        if r['webhook_stub_true']:
            flags.append('webhook-unsigned-rejected')
        if r['has_token_grant']:
            flags.append('token-grant')
        if not currencies:
            currencies = []

        # fields as compact tuples: [name, label, type, required(0/1), options?]
        field_tuples = []
        for f in creds:
            name = f['name']
            label = f.get('label') or name
            ftype = FIELD_TYPE_MAP.get(f.get('type', 'text'), 't')
            req = '1' if f.get('required', True) else '0'
            opts = f.get('options')
            if opts:
                opts_lit = ', ' + json.dumps(opts, separators=(',', ':'), ensure_ascii=False).replace('"', "'")
                field_tuples.append(f"    [{slug_str(name)}, {slug_str(label)}, '{ftype}', {req}{opts_lit}]")
            else:
                field_tuples.append(f"    [{slug_str(name)}, {slug_str(label)}, '{ftype}', {req}]")

        entries.append({
            'repo_slug': repo_slug,
            'registry_slug': registry_slug,
            'name': meta.get('name') or manifest.get('name') or repo_slug,
            'version': meta.get('version') or manifest.get('version') or '1.0.0',
            'description': (meta.get('description') or manifest.get('description') or '').strip(),
            'category': manifest.get('category', 'global'),
            'color': manifest.get('color', '#0F766E'),
            'currencies': currencies,
            'capabilities': capabilities,
            'status': status,
            'flags': flags,
            'fields': field_tuples,
        })

    # order: implemented first, then ported, then experimental; within: by name
    order = {'implemented': 0, 'ported': 1, 'planned': 2}
    entries.sort(key=lambda e: (order[e['status']], e['name'].lower()))

    lines = []
    lines.append('/**')
    lines.append(' * EdgePay gateway catalog — GENERATED FILE, DO NOT EDIT BY HAND.')
    lines.append(' *')
    lines.append(' * Source of truth: the EdgePay-Gateway-Plugin repository (123 provider')
    lines.append(' * modules). Regenerate with:')
    lines.append(' *   python3 scripts/port-gateways/analyze.py <plugin-repo> scripts/port-gateways/analysis.json')
    lines.append(' *   python3 scripts/port-gateways/build-catalog.py scripts/port-gateways/analysis.json src/gateways/catalog.data.ts ' + version)
    lines.append(' *')
    lines.append(' * Entry shape (CatalogEntry in ./catalog.ts):')
    lines.append(' *   slug          registry slug (ENABLED_GATEWAYS accepts this + aliases)')
    lines.append(' *   name/version/description/category/color   provider identity (manifest.json)')
    lines.append(' *   currencies    ISO-4217 codes the adapter natively transacts')
    lines.append(' *   capabilities  refund | verification | webhook (webhook only when a real')
    lines.append(' *                 signature scheme exists — unsigned-webhook providers are')
    lines.append(' *                 listed with flag `webhook-unsigned-rejected` instead)')
    lines.append(' *   status        implemented (core 5) | ported (full TS port) | planned (catalog stub)')
    lines.append(' *   flags         legacy-md5 | webhook-unsigned-rejected | token-grant')
    lines.append(' *   fields        credential definitions for the admin install UI —')
    lines.append(' *                 NAMES only are stored; values live AES-256-GCM encrypted')
    lines.append(' *                 in op_gateway_configs, never in this file')
    lines.append(' */')
    lines.append('')
    lines.append('// prettier-ignore')
    lines.append('export const CATALOG_VERSION = ' + slug_str(version) + ';')
    lines.append('')
    lines.append('// prettier-ignore')
    lines.append("export type CatalogStatus = 'implemented' | 'ported' | 'planned';")
    lines.append('')
    lines.append('/** Compact credential field tuple: [name, label, typeCode, required, options?] */')
    lines.append('// prettier-ignore')
    lines.append('export type CatalogFieldTuple = readonly [string, string, \'t\' | \'p\' | \'s\' | \'c\' | \'ta\', 0 | 1] | readonly [string, string, \'t\' | \'p\' | \'s\' | \'c\' | \'ta\', 0 | 1, Record<string, string>];')
    lines.append('')
    lines.append('// prettier-ignore')
    lines.append('export interface CatalogEntry {')
    lines.append('  readonly slug: string;')
    lines.append('  readonly name: string;')
    lines.append('  readonly version: string;')
    lines.append('  readonly description: string;')
    lines.append('  readonly category: \'global\' | \'mfs\' | \'bank\' | \'europe\' | \'latam\' | \'mena\' | \'apac\' | \'mobile\' | \'express\' | \'africa\' | \'crypto\';')
    lines.append('  readonly color: string;')
    lines.append('  readonly currencies: readonly string[];')
    lines.append('  readonly capabilities: readonly string[];')
    lines.append('  readonly status: CatalogStatus;')
    lines.append('  readonly flags: readonly string[];')
    lines.append('  readonly fields: readonly CatalogFieldTuple[];')
    lines.append('}')
    lines.append('')
    lines.append('// prettier-ignore')
    lines.append('export const GATEWAY_CATALOG: readonly CatalogEntry[] = [')

    for e in entries:
        lines.append('  {')
        lines.append(f"    slug: {slug_str(e['registry_slug'])},")
        lines.append(f"    name: {slug_str(e['name'])},")
        lines.append(f"    version: {slug_str(e['version'])},")
        lines.append(f"    description: {slug_str(e['description'])},")
        lines.append(f"    category: {slug_str(e['category'])},")
        lines.append(f"    color: {slug_str(e['color'])},")
        lines.append(f"    currencies: [{', '.join(slug_str(c) for c in e['currencies'])}],")
        lines.append(f"    capabilities: [{', '.join(slug_str(c) for c in e['capabilities'])}],")
        lines.append(f"    status: {slug_str(e['status'])},")
        lines.append(f"    flags: [{', '.join(slug_str(f) for f in e['flags'])}],")
        if e['fields']:
            lines.append('    fields: [')
            lines.append(',\n'.join(e['fields']))
            lines.append('    ],')
        else:
            lines.append('    fields: [],')
        lines.append('  },')
    lines.append('];')
    lines.append('')

    with open(out_path, 'w') as f:
        f.write('\n'.join(lines))

    print(f'wrote {out_path}: {len(entries)} entries')
    print(f"  implemented: {sum(1 for e in entries if e['status'] == 'implemented')}")
    print(f"  ported:      {sum(1 for e in entries if e['status'] == 'ported')}")
    print(f"  planned:      {sum(1 for e in entries if e['status'] == 'planned')}")


if __name__ == '__main__':
    main()
