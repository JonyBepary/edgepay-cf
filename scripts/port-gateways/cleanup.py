#!/usr/bin/env python3
"""
Post-generation cleanup for src/gateways/generated/*.gateway.ts.

Fixes mechanical issues the template emitter can't easily avoid:
  1. Unused const declarations (TS6133) — dropped.
  2. Use-before-declaration ordering (TS2448/2454) — declarations moved
     below their dependencies (only within straight-line method bodies,
     never across the request/return boundary INTO earlier position).

Run after generate.py. Idempotent.
"""

import os
import re
import sys

DIR = 'src/gateways/generated'

DECL_RE = re.compile(r'^(\s*)const (\w+) = ')


def method_bounds(lines):
    """Yield (start, end) line ranges of async method bodies (indent 2)."""
    out = []
    in_method = False
    start = 0
    for i, l in enumerate(lines):
        if re.match(r'^  (?:async )?\w+\(', l):
            in_method = True
            start = i
        elif in_method and l.startswith('  }'):
            out.append((start, i))
            in_method = False
    return out


def cleanup_method(lines, s, e):
    changed = False
    body = lines[s:e]

    # --- pass 1: drop unused declarations
    for _ in range(3):
        dropped = False
        for i, l in enumerate(body):
            m = DECL_RE.match(l)
            if not m:
                continue
            name = m.group(2)
            uses = 0
            for j, l2 in enumerate(body):
                if j == i:
                    continue
                if re.search(rf'(?<![\w$.]){re.escape(name)}(?![\w])', l2):
                    uses += 1
                    break
            if uses == 0:
                body.pop(i)
                dropped = True
                changed = True
                break
        if not dropped:
            break

    # --- pass 2: move use-before-declaration down
    for _ in range(5):
        moved = False
        declared = {}
        for i, l in enumerate(body):
            m = DECL_RE.match(l)
            if m:
                declared.setdefault(m.group(2), i)
        for i, l in enumerate(body):
            m = DECL_RE.match(l)
            if not m:
                continue
            name = m.group(2)
            refs = set(re.findall(r'(?<![\w$.])(\w+)(?![\w])', l)) - {name}
            for ref in refs:
                if ref in declared and declared[ref] > i:
                    # dependency declared later: move this line after it
                    dep_idx = declared[ref]
                    # don't move past 'return' statements
                    segment = body[i:dep_idx + 1]
                    if any(ln.strip().startswith('return') for ln in segment):
                        break
                    line = body.pop(i)
                    # recompute dep position after pop
                    insert_at = dep_idx  # after pop it shifted by -1 for i<dep
                    body.insert(insert_at, line)
                    moved = True
                    changed = True
                    break
            if moved:
                break
        if not moved:
            break

    lines[s:e] = body
    return changed


def main():
    total_changed = 0
    for f in sorted(os.listdir(DIR)):
        if not f.endswith('.gateway.ts'):
            continue
        path = os.path.join(DIR, f)
        lines = open(path).read().split('\n')
        orig = list(lines)
        for s, e in method_bounds(lines):
            cleanup_method(lines, s, e)
        if lines != orig:
            open(path, 'w').write('\n'.join(lines))
            total_changed += 1
    print(f'cleanup: {total_changed} files modified')


if __name__ == '__main__':
    main()
