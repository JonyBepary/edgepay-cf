#!/usr/bin/env python3
"""
Cluster PHP adapter method bodies by NORMALIZED structure: replace strings,
numbers, variable names and whitespace so only the code SHAPE remains.
Prints distinct body shapes with member lists — this tells us exactly how
many hand-written TS templates the generator needs.

Usage: python3 cluster-methods.py <plugin_repo_dir>
"""

import os
import re
import sys
from collections import defaultdict

def normalize(code: str) -> str:
    # strip comments
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.S)
    code = re.sub(r'//[^\n]*', '', code)
    # strings -> S
    code = re.sub(r"'(?:[^'\\]|\\.)*'", 'S', code)
    code = re.sub(r'"(?:[^"\\]|\\.)*"', 'S', code)
    # numbers -> N
    code = re.sub(r'\b\d+(?:\.\d+)?\b', 'N', code)
    # $data / $outData style data arrays -> D
    code = re.sub(r'\$(?:data|outData|res(?:ponse)?(?:Data|Out)?|result|body)\b', 'D', code)
    # credentials -> C, params -> P
    code = re.sub(r'\$credentials\b', 'C', code)
    code = re.sub(r'\$params\b', 'P', code)
    # callbackData -> CB
    code = re.sub(r'\$callbackData\b', 'CB', code)
    # other variables -> V
    code = re.sub(r'\$\w+', 'V', code)
    # collapse whitespace
    code = re.sub(r'\s+', ' ', code).strip()
    return code

def method_body(src: str, name: str) -> str | None:
    m = re.search(r'(?:public|private|protected)\s+(?:static\s+)?function\s+' + re.escape(name) + r'\s*\([^)]*\)\s*(?::\s*\??[\\\w\|\[\]{}" ]+\s*)?\{', src)
    if not m:
        return None
    start = m.end() - 1
    depth = 0
    i = start
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    return src[start + 1:i]

def strip_comments(src):
    """String-literal-aware comment stripper.

    The naive regex version ate '//' inside URL strings ('https://...'),
    corrupting every extracted constant that contained a URL. This walker
    tracks quote state so comments are only removed OUTSIDE strings.
    """
    out = []
    i = 0
    n = len(src)
    in_str = None
    while i < n:
        c = src[i]
        if in_str:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(src[i + 1])
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
            out.append(c)
            i += 1
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '/':
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        if c == '/' and i + 1 < n and src[i + 1] == '*':
            j = src.find('*/', i + 2)
            i = n if j < 0 else j + 2
            out.append(' ')
            continue
        if c == '#':
            j = src.find('\n', i)
            i = n if j < 0 else j
            continue
        out.append(c)
        i += 1
    return ''.join(out)

def main():
    repo = sys.argv[1]
    shapes = defaultdict(lambda: {'members': [], 'example': None})

    for entry in sorted(os.listdir(repo)):
        dirpath = os.path.join(repo, entry)
        if not os.path.isdir(dirpath) or entry.startswith('.'):
            continue
        php_files = [f for f in os.listdir(dirpath) if f.endswith('.php')]
        if not php_files:
            continue
        src = strip_comments(open(os.path.join(dirpath, php_files[0])).read())

        for method in ('initiate', 'verify', 'refund', 'verifyWebhook'):
            body = method_body(src, method)
            if body is None:
                continue
            norm = normalize(body)
            # further collapse: remove S/N runs to merge trivially-similar
            key = f'{method}:{norm[:600]}'
            shapes[key]['members'].append(entry)
            if shapes[key]['example'] is None:
                shapes[key]['example'] = entry

    # report shapes sorted by membership
    print(f'{len(shapes)} distinct normalized method bodies\n')
    for key, info in sorted(shapes.items(), key=lambda kv: -len(kv[1]['members'])):
        method = key.split(':', 1)[0]
        members = info['members']
        print(f'== {method} ({len(members)}): {members[:10]}{"..." if len(members) > 10 else ""}')
        print(f'   example: {info["example"]}')
        print(f'   shape: {key.split(":", 1)[1][:340]}')
        print()

if __name__ == '__main__':
    main()
