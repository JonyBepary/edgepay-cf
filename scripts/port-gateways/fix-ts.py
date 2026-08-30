#!/usr/bin/env python3
"""
tsc-error-driven fixer v2 for src/gateways/generated/*.gateway.ts.

Improvements over v1:
  - method-scoped usage detection (indent-2 method bounds), not line windows
  - underscore renames for unused params (input/params/callbackData/credentials)
  - use-before-declaration: move the DECLARATION up above the first use
  - VerifyResult missing-prop injection for any `{ ... }` return shape
  - unreachable `?? ''` stripping after String()/template expressions
"""

import os
import re
import subprocess

TSC = './node_modules/.bin/tsc'
CHECK = 'src/gen-check.ts'
DIR = 'src/gateways/generated'


def run_tsc():
    r = subprocess.run([TSC, '--noEmit', '-p', 'tsconfig.json'],
                       capture_output=True, text=True, timeout=600)
    errs = []
    for line in r.stdout.split('\n'):
        m = re.match(r'^(src/gateways/generated/\S+\.ts)\((\d+),(\d+)\): error (TS\d+): (.*)$', line)
        if m:
            errs.append({'file': m.group(1), 'line': int(m.group(2)),
                         'col': int(m.group(3)), 'code': m.group(4), 'msg': m.group(5)})
    return errs


def method_bounds(lines):
    """[(start, end)] of indent-2 method bodies."""
    out = []
    in_m, s = False, 0
    for i, l in enumerate(lines):
        if re.match(r'^  (?:async )?\w+\(', l):
            in_m, s = True, i
        elif in_m and l.startswith('  }'):
            out.append((s, i))
            in_m = False
    return out


def find_method(lines, ln):
    for s, e in method_bounds(lines):
        if s <= ln <= e:
            return s, e
    return None


def fix_round(errs):
    by_file = {}
    for e in errs:
        by_file.setdefault(e['file'], []).append(e)
    applied = 0
    for f, es in by_file.items():
        try:
            lines = open(f).read().split('\n')
        except FileNotFoundError:
            continue
        for e in sorted(es, key=lambda x: -x['line']):
            ln = e['line'] - 1
            if ln >= len(lines):
                continue
            text = lines[ln]
            code, msg = e['code'], e['msg']

            if code == 'TS6133':
                m = re.match(r"^'(\w+)' is declared", msg)
                if not m:
                    continue
                name = m.group(1)

                # unused method param -> underscore prefix
                if name in ('input', 'params', 'callbackData', 'credentials') and 'async' in text:
                    mb = find_method(lines, ln)
                    if mb:
                        ms, me = mb
                        body_txt = '\n'.join(lines[ms:me + 1])
                        body_txt_ns = re.sub(r'"(?:[^"\\]|\\.)*"', '""', body_txt)
                        if not re.search(r'(?<![\w$.])' + re.escape(name) + r'(?![\w:])', body_txt_ns):
                            new = re.sub(r'([\(,]\s*)' + re.escape(name) + r'(\s*:)', r'\1_' + name + r'\2', text, count=1)
                            if new != text:
                                lines[ln] = new
                                applied += 1
                                continue

                # unused const local -> delete (method-scoped check)
                if re.match(r'^\s*const ' + re.escape(name) + r' = ', text):
                    mb = find_method(lines, ln)
                    if not mb:
                        # module-level unused const (e.g. SLUG) — delete
                        if re.match(r'^const \w+ = ', text):
                            del lines[ln]
                            applied += 1
                        continue
                    ms, me = mb
                    def strip_strings(l2):
                        return re.sub(r'"(?:[^"\\]|\\.)*"|`(?:[^`])*`', '""', l2)
                    used = any(
                        j != ln and re.search(r'(?<![\w$.])' + re.escape(name) + r'(?![\w:])', strip_strings(l2))
                        for j, l2 in enumerate(lines[ms:me + 1], start=ms)
                    )
                    if not used:
                        del lines[ln]
                        applied += 1
                        continue

                # unused import member line
                if re.match(r'^\s*(type\s+)?' + re.escape(name) + r',?\s*$', text):
                    del lines[ln]
                    applied += 1
                    continue

            elif code in ('TS2741', 'TS2739'):
                known = {'amount', 'gateway_trx_id', 'status', 'trx_id'}
                props = [p for p in re.findall(r"'(\w+)'", msg) if p in known]
                if not props:
                    continue
                inject = ''
                for p in props:
                    if p == 'amount':
                        inject += ' amount: null,'
                    elif p == 'gateway_trx_id':
                        inject += " gateway_trx_id: '',"
                    elif p == 'status':
                        inject += " status: 'failed' as const,"
                    else:
                        inject += f' {p}: null,'
                # single-line object?
                m = re.search(r'\{([^{}]*)\}\s*(?:;|,)?\s*$', text)
                if m and 'success' in m.group(1):
                    new = text[:m.start()] + '{' + m.group(1) + inject + ' }' + text[m.end():]
                    lines[ln] = new
                    applied += 1
                    continue
                # multi-line return { ... } — inject before the closing '};'
                if 'return' in text and '{' in text:
                    for k in range(ln + 1, min(ln + 8, len(lines))):
                        if re.match(r'^\s*\};?\s*$', lines[k]) or lines[k].strip() == '};':
                            lines.insert(k, '      ' + inject.strip() + (',' if not inject.rstrip().endswith(',') else ''))
                            applied += 1
                            break

            elif code in ('TS2869', 'TS2881'):
                new = re.sub(r"(String\((?:[^()]|\([^()]*\))*\)) \?\? ''", r'\1', text)
                new = re.sub(r'("(?:[^"\\]|\\.)*")\s*\?\?\s*\'\'', '\\1', new)
                new = re.sub(r"(`(?:[^`])*`) \?\? ''", r'\1', new)
                if new != text:
                    lines[ln] = new
                    applied += 1

            elif code == 'TS2304':
                m = re.match(r"Cannot find name '(\w+)'", msg)
                if not m:
                    continue
                name = m.group(1)
                if name == 'credentials' and 'verifyWebhook' in lines[max(0, ln - 3):ln + 1].__str__() or (name == 'credentials' and any('verifyWebhook' in lines[k] for k in range(max(0, ln - 5), ln))):
                    # find the verifyWebhook signature above and destructure
                    for k in range(ln - 1, max(0, ln - 8), -1):
                        if 'async verifyWebhook' in lines[k]:
                            if 'const credentials = input.credentials;' not in lines[k + 1]:
                                lines.insert(k + 1, '    const credentials = input.credentials;')
                                applied += 1
                            break
                    continue
                if name in ('queryString', 'gwJson'):
                    # ensure kit/http import exists
                    has_import = any("from '../kit/http'" in l for l in lines[:30])
                    if has_import:
                        for k in range(30):
                            if "from '../kit/http'" in lines[k]:
                                if name not in lines[k]:
                                    lines[k] = lines[k].replace("import {", f"import {{ {name},", 1)
                                    applied += 1
                                break
                    else:
                        lines.insert(2, f"import {{ {name} }} from '../kit/http';")
                        applied += 1
                    continue
                if name == 'escapeHtml':
                    if not any("from '../kit/form'" in l for l in lines[:30]):
                        lines.insert(2, "import { escapeHtml } from '../kit/form';")
                        applied += 1
                    continue
                if name == 'consts':
                    new = text.replace('consts.', '')
                    if new != text:
                        lines[ln] = new
                        applied += 1
                        continue
                if name == 'd':
                    # missing response-var declaration
                    if 'const d = res.data' not in '\n'.join(lines[max(0, ln - 10):ln]):
                        lines.insert(ln, '    const d = res.data as Record<string, unknown>;')
                        applied += 1
                        continue

            elif code in ('TS2448', 'TS2454'):
                # never touch object-literal property lines (url:/method:/headers:)
                if re.match(r'^\s*\w+:\s', text):
                    continue
                m = re.match(r"Block-scoped variable '(\w+)' used", msg) or \
                    re.match(r"Variable '(\w+)' is used", msg)
                if not m:
                    continue
                name = m.group(1)
                # find declaration below; move it ABOVE line ln
                decl_idx = None
                mb = find_method(lines, ln)
                if not mb:
                    continue
                for j in range(ln + 1, mb[1] + 1):
                    if re.match(r'^\s*const ' + re.escape(name) + r' = ', lines[j]):
                        decl_idx = j
                        break
                if decl_idx is None:
                    continue
                decl_line = lines.pop(decl_idx)
                lines.insert(ln, decl_line)
                applied += 1

        if applied:
            open(f, 'w').write('\n'.join(lines))
    return applied


def main():
    open(CHECK, 'w').write("import './gateways/generated';\n")
    try:
        for i in range(8):
            errs = [e for e in run_tsc() if '/generated/' in e['file']]
            print(f'round {i}: {len(errs)} errors')
            if not errs:
                break
            n = fix_round(errs)
            print(f'  applied {n}')
            if n == 0:
                print('  no more mechanical fixes — remaining:')
                for e in errs[:20]:
                    print(f"    {os.path.basename(e['file'])}:{e['line']} {e['code']} {e['msg'][:80]}")
                break
        errs = [e for e in run_tsc() if '/generated/' in e['file']]
        print(f'final: {len(errs)} errors')
        for e in errs[:20]:
            print(f"  {os.path.basename(e['file'])}:{e['line']} {e['code']} {e['msg'][:80]}")
    finally:
        os.remove(CHECK)


if __name__ == '__main__':
    main()
