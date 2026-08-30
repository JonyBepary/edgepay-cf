#!/usr/bin/env python3
"""
Structural repair for generated adapters: move const declarations that were
inserted INTO multi-line gwJson({...}) call objects to AFTER the call's
closing line. Positional, idempotent.
"""

import os
import re

DIR = 'src/gateways/generated'

for f in sorted(os.listdir(DIR)):
    if not f.endswith('.gateway.ts'):
        continue
    path = os.path.join(DIR, f)
    lines = open(path).read().split('\n')
    changed = False
    i = 0
    while i < len(lines):
        if 'await gwJson({' in lines[i]:
            j = i + 1
            misplaced = []
            while j < len(lines) and re.match(r'^\s*const \w+ = ', lines[j]):
                misplaced.append(j)
                j += 1
            if misplaced and j < len(lines) and ('url:' in lines[j] or 'method:' in lines[j]):
                texts = [lines[k] for k in misplaced]
                for k in reversed(misplaced):
                    del lines[k]
                depth, k2 = 1, i + 1
                while k2 < len(lines) and depth > 0:
                    depth += lines[k2].count('{') - lines[k2].count('}')
                    k2 += 1
                insert_at = k2
                off = 0
                for t in texts:
                    name = re.match(r'\s*const (\w+) =', t).group(1)
                    already = any(
                        re.match(r'^\s*const ' + re.escape(name) + r' = ', l)
                        for l in lines[insert_at:insert_at + 6]
                    )
                    if not already:
                        lines.insert(insert_at + off, t)
                        off += 1
                changed = True
                i = insert_at + off
                continue
        i += 1
    if changed:
        open(path, 'w').write('\n'.join(lines))
        print('repaired', f)
print('repair pass done')
