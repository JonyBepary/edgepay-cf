#!/usr/bin/env python3
"""
Final surgical fixes for known generated-adapter patterns that the generic
compiler/fixer can't express. Idempotent. Runs LAST in the pipeline.

1. `{ success: ok }` returns missing VerifyResult props -> full mapping.
2. `String(1 ?? '')` numeric-literal fallback -> `String(1)`.
3. Duplicate `const payload` in one method -> rename second.
4. queryString(obj-literal) casts -> double-cast via unknown.
5. escapeHtml import inside docblock -> move below it.
"""

import json
import re

DIR = 'src/gateways/generated'


def fix_return_shape(src):
    return src.replace(
        "return {\n          success: ok,\n        };",
        "return {\n          success: ok,\n          gateway_trx_id: '',\n          amount: null,\n          status: (ok ? 'completed' : 'failed') as VerifyResult['status'],\n        };")


def fix_numeric_fallbacks(src):
    return re.sub(r'String\((\d+) \?\? \'\'\)', r'String(\1)', src)


def fix_duplicate_payload(src):
    lines = src.split('\n')
    # find methods with TWO `const payload` declarations; rename the second
    method_ranges = []
    in_m, s = False, 0
    for i, l in enumerate(lines):
        if re.match(r'^  (?:async )?\w+\(', l):
            in_m, s = True, i
        elif in_m and l.startswith('  }'):
            method_ranges.append((s, i))
            in_m = False
    rename_targets = []
    for ms, me in method_ranges:
        decls = [j for j in range(ms, me + 1) if re.match(r'^\s*const payload(:| =)', lines[j])]
        if len(decls) >= 2:
            rename_targets.append(decls[1])
    for j in reversed(rename_targets):
        # rename decl + its references until the next gwJson close
        name = 'payloadRequest'
        k = j
        while k < len(lines) and not re.match(r'^\s*}\);', lines[k]):
            lines[k] = re.sub(r'\bpayload\b(?!\s*Request)', name, lines[k]) if k > j else lines[k].replace('const payload', f'const {name}', 1)
            k += 1
    return '\n'.join(lines)


def fix_double_cast(src):
    return src.replace(
        'queryString(payload as Record<string, string>)',
        'queryString(payload as unknown as Record<string, string>)')


def fix_escapehtml_import(src):
    if "import { escapeHtml } from '../kit/form';" in src:
        # ensure it's NOT inside the docblock
        lines = src.split('\n')
        for i, l in enumerate(lines):
            if "import { escapeHtml } from '../kit/form';" in l:
                # inside comment? check for */ before it without /**
                before = '\n'.join(lines[:i])
                if before.count('/*') > before.count('*/'):
                    del lines[i]
                    # insert after the closing */
                    for j in range(i, len(lines)):
                        if lines[j].strip().endswith('*/'):
                            lines.insert(j + 1, "import { escapeHtml } from '../kit/form';")
                            break
                break
        return '\n'.join(lines)
    return src


import os


def fix_optional_chains(src):
    """Deep-response reads must not throw on missing intermediate objects:
    ((d) as Record<string, unknown>)["a"]  nested inside another access —
    convert inner casts to optional chaining."""
    # repeated passes handle multi-level nesting
    for _ in range(3):
        # match casts that are IMMEDIATELY indexed:  ((X) as Record<...>)["k"]
        # and wrap: ((X) as Record<...> | undefined)?.["k"]  when X itself is an index expr
        new = re.sub(
            r'\(\(\(\(\(\(([^()]*)\) as Record<string, unknown>\)\["([^"]+)"\]\) as Record<string, unknown>\)\["([^"]+)"\]\)',
            r'(((((\1) as Record<string, unknown>)["\2"]) as Record<string, unknown> | undefined)?.["\3"]',
            src)
        if new == src:
            break
        src = new
    return src
for f in sorted(os.listdir(DIR)):
    if not f.endswith('.gateway.ts'):
        continue
    path = os.path.join(DIR, f)
    src = open(path).read()
    orig = src
    src = fix_return_shape(src)
    src = fix_numeric_fallbacks(src)
    src = fix_double_cast(src)
    src = fix_escapehtml_import(src)
    body_after_imports = src.split("} from '../base';", 1)[-1]
    if re.search(r'escapeHtml\(', body_after_imports.split("from '../kit/form';")[-1]) and "from '../kit/form'" not in src:
        src = src.replace("} from '../base';", "} from '../base';\nimport { escapeHtml } from '../kit/form';", 1)
    src = fix_duplicate_payload(src)
    src = nested_optional(src)
    src = add_callback_guards(src)
    src = fix_optional_chains(src)
    if src != orig:
        open(path, 'w').write(src)
        print('finalized', f)
print('finalize pass done')
