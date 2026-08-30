#!/usr/bin/env python3
"""
Upstream PHP gateway-plugin repo -> EdgePay-CF (TS) adapter generator. v2

Primitive-based compiler. See header of analyze.py for pipeline context.

Port policies baked in (each emits a PORT-NOTE in the file header):
  1. Fake refunds ("Dynamic refund simulation") -> refund_not_supported.
  2. Sandbox "simulation" fallbacks in initiate (SIM_xxx redirect on API
     failure) -> unconditional throw. Never fake money movement.
  3. Webhook stubs / header-presence "simulations" -> fail-closed false.
  4. Callback-payload trust where upstream has no server-side verify API:
     kept (checkout callback token is the authenticity gate) + PORT-NOTE.

Usage:
  python3 generate.py <analysis.json> <plugin_repo> <out_dir>
"""

import json
import os
import re
import sys
from collections import OrderedDict

# ===============================================================
# PHP source utilities
# ===============================================================

def load_php(repo, slug):
    d = os.path.join(repo, slug)
    if not os.path.isdir(d):
        return None
    for f in sorted(os.listdir(d)):
        if f.endswith('.php'):
            return open(os.path.join(d, f)).read()
    return None

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

def extract_class_methods(src: str) -> dict:
    """Split class body into per-method source chunks."""
    methods = {}
    # methods look like:  public function name(...) { ... }
    # match with brace counting
    for m in re.finditer(r'(?:public|private|protected)\s+(?:static\s+)?function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\??[\\\w\|\[\]{}" ]+\s*)?\{', src):
        name = m.group(1)
        start = m.end() - 1
        depth = 0
        i = start
        while i < len(src):
            c = src[i]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    break
            i += 1
        methods[name] = src[start + 1:i]
    return methods

def php_string_literals(code: str) -> list:
    return re.findall(r"'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"", code)

def flatten_pairs(pairs):
    out = []
    for a, b in pairs:
        out.append(a if a else b)
    return out

# --------------------------------------------------------------- extractors

def extract_constants(src: str) -> dict:
    out = {}
    for m in re.finditer(r"const\s+(\w+)\s*=\s*'([^']*)'", src):
        out[m.group(1)] = m.group(2)
    return out

def extract_fields(method_src: str) -> list:
    fields = []
    for m in re.finditer(
        r"\[\s*'name'\s*=>\s*'([^']+)'\s*,\s*'label'\s*=>\s*'([^']*)'\s*,\s*'type'\s*=>\s*'([^']+)'\s*,(?:\s*'required'\s*=>\s*(true|false)\s*,?)?\s*(?:'options'\s*=>\s*\[([^\]]*)\]\s*,?\s*)?\s*(?:'default'\s*=>\s*'([^']*)'\s*,?\s*)?\]",
        method_src,
    ):
        name, label, ftype, req, options, default = m.groups()
        options_map = None
        if options:
            options_map = dict(re.findall(r"'([^']*)'\s*=>\s*'([^']*)'", options))
        fields.append({
            'name': name,
            'label': label,
            'type': ftype,
            'required': req != 'false',
            **({'options': options_map} if options_map else {}),
            **({'default': default} if default else {}),
        })
    return fields

def extract_metadata(src: str) -> dict:
    m = re.search(r"function metadata\(\).*?\{(.*?)\n\s*\}", src, re.S)
    if not m:
        return {}
    body = m.group(1)
    out = {}
    for k in ('name', 'slug', 'version', 'description', 'author', 'type'):
        km = re.search(rf"'{k}'\s*=>\s*'([^']*)'", body)
        if km:
            out[k] = km.group(1)
    return out

def extract_currencies(src: str) -> list:
    m = re.search(r"function supportedCurrencies.*?\{(.*?)\n\s*\}", src, re.S)
    if not m:
        return []
    return re.findall(r"'([A-Z]{3})'", m.group(1))

def extract_supports(src: str) -> list:
    m = re.search(r"function supports\(.*?\{(.*?)\n\s*\}", src, re.S)
    if not m:
        return []
    body = m.group(1)
    # match ('refund', 'recurring', ...) => true
    arms = re.findall(r"((?:'[^']+'\s*,?\s*)+)\s*=>\s*true", body)
    out = []
    for arm in arms:
        out += re.findall(r"'([^']+)'", arm)
    return out

def extract_curl_calls(method_src: str) -> list:
    """Extract curl_init URL + opts per call, in order."""
    calls = []
    for m in re.finditer(r'curl_init\(([^)]*)\)', method_src):
        url_expr = m.group(1).strip()
        calls.append({
            'url_expr': url_expr,
            'method': 'GET',
            'headers': [],
            'body_kind': None,
            'timeout': None,
            'userpwd': False,
        })
    for i, cm in enumerate(re.finditer(r'curl_setopt_array\(\s*\$\w+\s*,\s*\[(.*?)\]\s*\)', method_src, re.S)):
        if i >= len(calls):
            calls.append({'url_expr': None, 'method': 'GET', 'headers': [], 'body_kind': None, 'timeout': None, 'userpwd': False})
        call = calls[i]
        opts = cm.group(1)
        if 'CURLOPT_POST' in opts:
            call['method'] = 'POST'
        if 'CURLOPT_POSTFIELDS' in opts:
            if 'http_build_query' in opts:
                call['body_kind'] = 'form'
            elif 'json_encode' in opts:
                call['body_kind'] = 'json'
            else:
                call['body_kind'] = 'raw'
        tm = re.search(r'CURLOPT_TIMEOUT\s*=>\s*(\d+)', opts)
        if tm:
            call['timeout'] = int(tm.group(1))
        if 'CURLOPT_USERPWD' in opts:
            call['userpwd'] = True
        for hm in re.finditer(r"'([^']+: [^']*)'", opts):
            call['headers'].append(hm.group(1))
        # headers built via variables like 'Authorization: ' . $token
        for hm in re.finditer(r"'((?:Authorization|Content-Type|X-APP-Key|X-API-KEY|Accept)[^']*)'", opts):
            if hm.group(1) not in call['headers']:
                call['headers'].append(hm.group(1))
    return calls

def extract_response_reads(method_src: str) -> list:
    """All $data['key'] / $outData['key'] style reads."""
    reads = []
    for m in re.finditer(r"\$(?:data|outData|res|result|response(?:Data|Out)?)\['([^']+)'\]", method_src):
        if m.group(1) not in reads:
            reads.append(m.group(1))
    return reads

def extract_success_conditions(method_src: str) -> list:
    """String-equality conditions like $x === 'VALID'."""
    return re.findall(r"\$?(\w+)\s*(?:\?\?)?\s*(?:==|===)\s*'([^']*)'", method_src)

def detect_hash_usage(src: str) -> list:
    usage = []
    if re.search(r"\bmd5\(", src):
        usage.append('md5')
    for m in re.finditer(r"hash_hmac\(\s*'(\w+)'", src):
        usage.append(f"hmac-{m.group(1)}")
    for m in re.finditer(r"hash\(\s*'(\w+)'", src):
        usage.append(f"hash-{m.group(1)}")
    if 'base64_encode' in src:
        usage.append('base64')
    if 'openssl_sign' in src or 'openssl_verify' in src:
        usage.append('openssl-rsa')
    return usage

def detect_form_html(method_src: str) -> bool:
    return "'form_html'" in method_src or 'form_html' in method_src

def detect_token_grant(src: str) -> bool:
    return bool(re.search(r"token/grant|/token\b|grant_type|auth/login|/oauth|AccessToken|access_token", src, re.I))

def detect_return_true_webhook(src: str) -> bool:
    m = re.search(r"function verifyWebhook[^{]*\{([^{}]*)\}", src, re.S)
    if m:
        body = m.group(1).strip()
        # only "return true;" with at most a comment
        return bool(re.fullmatch(r"(?:/\*.*?\*/\s*)?return\s+true\s*;", body, re.S))
    return False

def structure_signature(analysis: dict) -> str:
    parts = []
    parts.append('form' if analysis['has_form_html'] else ('api' if analysis['curl_calls'] else 'none'))
    parts.append('token' if analysis['has_token_grant'] else 'plain')
    parts.append(f"curl{len(analysis['curl_calls'])}")
    parts.append('refund' if analysis['has_refund'] else 'norefund')
    parts.append('hmac' if any(u.startswith('hmac') for u in analysis['hash_usage']) else ('md5' if 'md5' in analysis['hash_usage'] else 'nohash'))
    return '+'.join(parts)

# --------------------------------------------------------------- main

def analyze_gateway(dirpath: str) -> dict:
    php_files = [f for f in os.listdir(dirpath) if f.endswith('.php')]
    manifest_path = os.path.join(dirpath, 'manifest.json')
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path) as f:
            manifest = json.load(f)
    if not php_files:
        return None

    php_path = os.path.join(dirpath, php_files[0])
    with open(php_path) as f:
        raw = f.read()
    src = strip_comments(raw)
    methods = extract_class_methods(src)

    curl_calls = []
    response_reads = {}
    success_conditions = {}
    for ctx in ('initiate', 'verify', 'refund', 'verifyWebhook'):
        m = methods.get(ctx)
        if m:
            curl_calls += [{'context': ctx, **c} for c in extract_curl_calls(m)]
            response_reads[ctx] = extract_response_reads(m)
            success_conditions[ctx] = extract_success_conditions(m)

    analysis = {
        'slug': os.path.basename(dirpath),
        'php_file': php_files[0],
        'manifest': manifest,
        'metadata': extract_metadata(src),
        'constants': extract_constants(src),
        'fields': extract_fields(methods.get('fields', '')),
        'currencies': extract_currencies(src),
        'supports': extract_supports(src),
        'has_form_html': detect_form_html(methods.get('initiate', '')),
        'has_refund': 'refund' in methods,
        'has_verify_webhook': 'verifyWebhook' in methods,
        'webhook_stub_true': detect_return_true_webhook(src),
        'has_token_grant': detect_token_grant(src),
        'hash_usage': detect_hash_usage(src),
        'curl_calls': curl_calls,
        'response_reads': response_reads,
        'success_conditions': success_conditions,
        'methods': sorted(methods.keys()),
        'loc': raw.count('\n'),
    }

    # confidence scoring
    flags = []
    confidence = 1.0
    if not analysis['fields']:
        flags.append('no-fields-extracted')
        confidence -= 0.4
    if not analysis['constants'] and not analysis['curl_calls']:
        flags.append('no-urls-found')
        confidence -= 0.3
    init_calls = [c for c in curl_calls if c['context'] == 'initiate']
    if not init_calls and not analysis['has_form_html']:
        flags.append('no-initiate-call')
        confidence -= 0.5
    if analysis['has_form_html'] and init_calls:
        flags.append('form+api-mixed')
        confidence -= 0.2
    if any(u.startswith('openssl') for u in analysis['hash_usage']):
        flags.append('rsa-signature')
        confidence -= 0.3
    if analysis['webhook_stub_true']:
        flags.append('webhook-stub-true')
    if re.search(r'\bencrypt\b|\bdecrypt\b', src, re.I):
        flags.append('manual-crypto')
        confidence -= 0.2
    # multi-curl in verify (besides token) is a more complex flow
    verify_calls = [c for c in curl_calls if c['context'] == 'verify']
    if len(verify_calls) > 2:
        flags.append('verify-multi-call')
        confidence -= 0.2
    analysis['flags'] = flags
    analysis['confidence'] = round(max(confidence, 0.0), 2)
    analysis['structure_signature'] = structure_signature(analysis)
    return analysis


    main()


def method_body(src, name):
    m = re.search(
        r'(?:public|private|protected)\s+(?:static\s+)?function\s+' + re.escape(name)
        + r'\s*\([^)]*\)\s*(?::\s*\??[\\\w\|\[\]{}"\' ]+\s*)?\{', src)
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

def match_balanced(s, start, open_ch, close_ch):
    """From an opening char index, return index just past the matching close."""
    depth = 0
    in_str = None
    i = start
    while i < len(s):
        c = s[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
        elif c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return -1

def split_top(s, sep=','):
    parts, depth, cur, in_str = [], 0, '', None
    i = 0
    while i < len(s):
        c = s[i]
        if in_str:
            cur += c
            if c == '\\':
                if i + 1 < len(s):
                    cur += s[i + 1]
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
            cur += c
        elif c in '([{':
            depth += 1
            cur += c
        elif c in ')]}':
            depth -= 1
            cur += c
        elif c == sep and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts if p.strip()]

def php_array_items(code):
    """Parse [ 'k' => expr, ... ] body -> [(key, expr)] or None."""
    if code is None:
        return None
    items = []
    for part in split_top(code):
        m = re.match(r"^'((?:[^'\\]|\\.)*)'\s*=>\s*(.*)$", part, re.S)
        if not m:
            m2 = re.match(r'^"((?:[^"\\]|\\.)*)"\s*=>\s*(.*)$', part, re.S)
            if not m2:
                return None
            m = m2
        items.append((m.group(1).replace("\\'", "'"), m.group(2).strip()))
    return items if items else []

def ts_str(s):
    return json.dumps(s, ensure_ascii=False)

# ===============================================================
# Expression compiler
# ===============================================================

class ExprCompileError(Exception):
    pass

class VarRegistry:
    def __init__(self, with_bases=False):
        self.paths = OrderedDict()
        if with_bases:
            self.paths['params'] = 'params'
            self.paths['credentials'] = 'credentials'
            self.paths['callbackData'] = 'cb'

    def set(self, var, expr):
        self.paths[var] = expr

    def get(self, var):
        return self.paths.get(var)

    def has(self, var):
        return var in self.paths

def split_concat(expr):
    parts, depth, in_str, cur = [], 0, None, ''
    i = 0
    while i < len(expr):
        c = expr[i]
        if in_str:
            cur += c
            if c == '\\':
                if i + 1 < len(expr):
                    cur += expr[i + 1]
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
            cur += c
        elif c in '([{':
            depth += 1
            cur += c
        elif c in ')]}':
            depth -= 1
            cur += c
        elif c == '.' and depth == 0:
            nxt = expr[i + 1] if i + 1 < len(expr) else ''
            prv = expr[i - 1] if i > 0 else ''
            if prv.isdigit() and nxt.isdigit():
                cur += c
            else:
                parts.append(cur)
                cur = ''
        else:
            cur += c
        i += 1
    if cur.strip() or (parts and cur == '') or cur.strip() == '':
        parts.append(cur)
    return [p.strip() for p in parts]

FN_MAP = [
    ('strtoupper', 'toUpperCase'), ('strtolower', 'toLowerCase'),
    ('trim', 'trim'), ('urlencode', 'encodeURIComponent'),
    ('rawurlencode', 'encodeURIComponent'), ('ltrim', 'trimStart'),
    ('ucfirst', '…ucfirst'),
]

def compile_expr(expr, regs, consts, depth=0):
    if depth > 12:
        raise ExprCompileError('expr too deep')
    expr = expr.strip().rstrip(';').strip()
    if not expr:
        raise ExprCompileError('empty')
    E = lambda e: compile_expr(e, regs, consts, depth + 1)

    # outer parens (balanced)
    if expr.startswith('(') and match_balanced(expr, 0, '(', ')') == len(expr):
        return E(expr[1:-1])

    # literals
    m = re.fullmatch(r"'((?:[^'\\]|\\.)*)'", expr)
    if m:
        return ts_str(m.group(1).replace("\\'", "'"))
    m = re.fullmatch(r'"((?:[^"\\]|\\.)*)"', expr)
    if m:
        inner = m.group(1)
        if '{$' in inner or '${' in inner:
            segs = re.split(r'\{\$(\w+)\}', inner)
            out = ''
            for idx, seg in enumerate(segs):
                if idx % 2 == 0:
                    out += seg
                else:
                    if not regs.has(seg):
                        raise ExprCompileError(f'interp ${seg} unregistered')
                    out += '${String(' + regs.get(seg) + ')}'
            return f'`{out}`'
        return ts_str(inner.replace('\\"', '"'))
    if re.fullmatch(r'-?\d+', expr):
        return expr
    if re.fullmatch(r'-?\d+\.\d+', expr):
        return expr
    if expr in ('true', 'false', 'null'):
        return expr

    # array literals: [ 'k' => v, ... ] or array('k' => v, ...) or ['a','b']
    if expr.startswith('array(') and expr.endswith(')'):
        inner = expr[len('array('):-1]
        expr = '[' + inner + ']'
    if expr.startswith('[') and expr.endswith(']'):
        inner = expr[1:-1]
        if inner.strip() == '':
            return '[]'
        items = php_array_items(inner)
        if items is not None:
            entries = ', '.join(f'[{ts_str(k)}]: {E(v)}' for k, v in items)
            return '{ ' + entries + ' }'
        vals = split_top(inner)
        if vals:
            return '[' + ', '.join(E(v) for v in vals) + ']'
        raise ExprCompileError('array literal items')

    # ternary
    for m in re.finditer(r'\?', expr):
        # ensure top-level ? (not inside parens/strings) — approximate via split
        pass
    tparts = split_ternary(expr)
    if tparts:
        cond, a, b = tparts
        return f'({compile_condition(cond, regs, consts, depth + 1)}) ? ({E(a)}) : ({E(b)})'

    # casts
    for cast, tsfn in (('(string)', 'String'), ('(float)', 'Number'), ('(bool)', 'Boolean'), ('(array)', None)):
        if expr.startswith(cast):
            inner = expr[len(cast):].strip()
            if tsfn is None:
                return E(inner)
            return f'{tsfn}({E(inner)})'
    if expr.startswith('(int)'):
        inner = expr[len('(int)'):].strip()
        return f'Math.trunc(Number({E(inner)}))'

    # $this->slug()/name()
    if re.fullmatch(r'\$this->slug\(\)', expr):
        return 'SLUG'
    if re.fullmatch(r'\$this->name\(\)', expr):
        return 'NAME'
    if re.fullmatch(r'uniqid\(\)', expr):
        return 'crypto.randomUUID().slice(0, 13)'
    if re.fullmatch(r'\$this->generateUuid\(\)', expr):
        return 'crypto.randomUUID()'
    m = re.fullmatch(r"uniqid\('([^']*)'(?:,\s*true)?\)", expr)
    if m:
        return f"`{m.group(1)}${{crypto.randomUUID().slice(0, 10)}}`"
    if re.fullmatch(r'time\(\)', expr):
        return 'Math.floor(Date.now() / 1000)'
    m = re.fullmatch(r'rand\((\d+),\s*(\d+)\)', expr)
    if m:
        return f'String(Math.floor({m.group(1)} + Math.random() * ({m.group(2)} - {m.group(1)})))'
    # $_SERVER superglobal — adapters have no request context; use safe default
    m = re.fullmatch(r"\$_SERVER\['([^']+)'\]\s*(\?\?\s*'([^']*)')?", expr)
    if m:
        return ts_str(m.group(3) or '127.0.0.1')

    # getString/getInt wrappers
    m = re.fullmatch(r'\$this->get(?:String|Int|Float)\((.*)\)', expr, re.S)
    if m:
        inner = m.group(1).strip()
        inner = re.sub(r'\s*\?\?\s*null$', '', inner)
        inner = re.sub(r"\s*\?\?\s*''$", '', inner)
        return f'String({E(inner)} ?? \'\')'

    # getArray($data, 'field')
    m = re.fullmatch(r"\$this->getArray\(\s*\$(\w+)\s*,\s*'([^']*)'\s*\)", expr)
    if m:
        if not regs.has(m.group(1)):
            raise ExprCompileError(f'getArray base ${m.group(1)}')
        base = regs.get(m.group(1))
        return f'(({base}) as Record<string, unknown>)[{ts_str(m.group(2))}] ?? {{}}'

    # hashes (async)
    m = re.fullmatch(r'md5\((.+)\)', expr, re.S)
    if m:
        return f'await md5Hex(String({E(m.group(1))}))'
    m = re.fullmatch(r"hash_hmac\('(\w+)',\s*(.+?),\s*(.+?)(?:,\s*true)?\)", expr, re.S)
    if m:
        algo = {'sha256': 'SHA-256', 'sha1': 'SHA-1', 'sha512': 'SHA-512', 'sha384': 'SHA-384'}.get(m.group(1))
        if not algo:
            raise ExprCompileError(f'hash_hmac {m.group(1)}')
        return f"await hmacHex('{algo}', String({E(m.group(2))}), String({E(m.group(3))}))"
    m = re.fullmatch(r"hash\('(\w+)',\s*(.+)\)", expr, re.S)
    if m:
        algo = {'sha256': 'SHA-256', 'sha1': 'SHA-1', 'sha512': 'SHA-512', 'sha384': 'SHA-384'}.get(m.group(1))
        if not algo:
            raise ExprCompileError(f'hash {m.group(1)}')
        return "await shaHex('" + algo + "', String(" + E(m.group(2)) + "))"

    m = re.fullmatch(r'base64_encode\((.+)\)', expr, re.S)
    if m:
        return f'btoa(String({E(m.group(1))}))'
    m = re.fullmatch(r'bin2hex\((.+)\)', expr, re.S)
    if m:
        return f'hexEncode(String({E(m.group(1))}))'
    # string fns
    for php, tsfn in FN_MAP:
        m = re.fullmatch(re.escape(php) + r'\((.+)\)', expr, re.S)
        if m and tsfn != '…ucfirst':
            if php in ('urlencode', 'rawurlencode'):
                return f'encodeURIComponent(String({E(m.group(1))}))'
            return f'String({E(m.group(1))}).{tsfn}()'
    m = re.fullmatch(r"rtrim\((.+?),\s*'([^']*)'\)", expr, re.S)
    if m:
        esc = re.escape(m.group(2)).replace('/', '\\/')
        return f"String({E(m.group(1))}).replace(/{esc}+$/, '')"
    m = re.fullmatch(r"str_replace\('([^']*)',\s*'([^']*)',\s*(.+)\)", expr, re.S)
    if m:
        return f"String({E(m.group(3))}).replace(/{re.escape(m.group(1))}/g, {ts_str(m.group(2))})"
    m = re.fullmatch(r'htmlspecialchars\((.+)\)', expr, re.S)
    if m:
        return f'escapeHtml(String({E(m.group(1))}))'
    m = re.fullmatch(r"number_format\(\s*\(float\)\s*(.+?),\s*(\d+),\s*'\.',\s*''\s*\)", expr, re.S)
    if m:
        return f'Number({E(m.group(1))}).toFixed({m.group(2)})'
    m = re.fullmatch(r"number_format\((.+?),\s*(\d+)\)", expr, re.S)
    if m:
        return f'Number({E(m.group(1))}).toFixed({m.group(2)})'

    # bcmath
    m = re.fullmatch(r"\(int\)\s*bcmul\(\s*\(string\)\s*\(float\)\s*(.+?),\s*'(\d+)',\s*\d+\s*\)", expr, re.S)
    if m:
        return f'String(Math.round(Number({E(m.group(1))}) * {m.group(2)}))'
    m = re.fullmatch(r"bcmul\(\s*(.+?),\s*'(\d+)',\s*\d+\s*\)", expr, re.S)
    if m:
        return f'String(Math.round(Number({E(m.group(1))}) * {m.group(2)}))'
    m = re.fullmatch(r"bcdiv\(\s*(.+?),\s*'(\d+)',\s*(\d+)\s*\)", expr, re.S)
    if m:
        return f'(Number({E(m.group(1))}) / {m.group(2)}).toFixed({m.group(3)})'
    m = re.fullmatch(r"bcadd\(\s*(.+?),\s*(.+?),\s*(\d+)\s*\)", expr, re.S)
    if m:
        return f'(Number({E(m.group(1))}) + Number({E(m.group(2))})).toFixed({m.group(3)})'

    # http_build_query
    m = re.fullmatch(r'http_build_query\(\[(.*)\]\)', expr, re.S)
    if m:
        items = php_array_items(m.group(1))
        if items is None:
            raise ExprCompileError('http_build_query items')
        entries = ', '.join(f'[{ts_str(k)}]: String({E(v)} ?? \'\')' for k, v in items)
        return 'queryString({ ' + entries + ' })'
    m = re.fullmatch(r'http_build_query\(\s*\$(\w+)\s*\)', expr)
    if m:
        if not regs.has(m.group(1)):
            raise ExprCompileError('http_build_query var')
        return f'queryString({regs.get(m.group(1))} as Record<string, string>)'
    m = re.fullmatch(r'http_build_query\(\s*array\((.*)\)\s*\)', expr, re.S)
    if m:
        items = php_array_items(m.group(1))
        if items is None:
            raise ExprCompileError('http_build_query array()')
        entries = ', '.join(f'[{ts_str(k)}]: String({E(v)} ?? \'\')' for k, v in items)
        return 'queryString({ ' + entries + ' })'

    # json_encode
    m = re.fullmatch(r'\(string\)\s*json_encode\(\s*\$(\w+)\s*\)', expr)
    if m:
        if not regs.has(m.group(1)):
            raise ExprCompileError('json_encode var')
        return f'JSON.stringify({regs.get(m.group(1))})'
    m = re.fullmatch(r'json_encode\(\s*\$(\w+)\s*\)', expr)
    if m:
        if not regs.has(m.group(1)):
            raise ExprCompileError('json_encode var')
        return f'JSON.stringify({regs.get(m.group(1))})'
    m = re.fullmatch(r'\(string\)\s*json_encode\(\[(.*)\]\)', expr, re.S)
    if m:
        items = php_array_items(m.group(1))
        if items is None:
            raise ExprCompileError('json_encode items')
        entries = ', '.join(f'[{ts_str(k)}]: {E(v)}' for k, v in items)
        return 'JSON.stringify({ ' + entries + ' })'
    m = re.fullmatch(r'json_encode\(\[(.*)\]\)', expr, re.S)
    if m:
        items = php_array_items(m.group(1))
        if items is None:
            raise ExprCompileError('json_encode items (no cast)')
        entries = ', '.join(f'[{ts_str(k)}]: {E(v)}' for k, v in items)
        return 'JSON.stringify({ ' + entries + ' })'

    # urlencode(http_build_query(...)) — handled by recursion

    # variables & array access
    m = re.fullmatch(r"\$credentials\['([^']+)'\]\s*(\?\?\s*(.+))?", expr, re.S)
    if m:
        fallback = E(m.group(3)) if m.group(2) else "''"
        return f'credentials[{ts_str(m.group(1))}] ?? {fallback}'
    m = re.fullmatch(r"\$params\['([^']+)'\]\s*(\?\?\s*(.+))?", expr, re.S)
    if m:
        fallback = E(m.group(3)) if m.group(2) else "''"
        return f'(params.{m.group(1)} ?? {fallback})'
    m = re.fullmatch(r"\$params\['([^']+)'\]\['([^']+)'\]\s*(\?\?\s*(.+))?", expr, re.S)
    if m:
        fallback = E(m.group(4)) if m.group(3) else "''"
        return f'((params.metadata ?? {{}}) as Record<string, unknown>)[{ts_str(m.group(2))}] ?? {fallback}'
    m = re.fullmatch(r"\$callbackData\['([^']+)'\]\s*\?\?\s*\$callbackData\['([^']+)'\]", expr)
    if m:
        return f"(cb[{ts_str(m.group(1))}] ?? cb[{ts_str(m.group(2))}])"
    m = re.fullmatch(r"\$callbackData\['([^']+)'\]\s*(\?\?\s*(.+))?", expr, re.S)
    if m:
        fallback = E(m.group(3)) if m.group(2) else "''"
        return f'(cb[{ts_str(m.group(1))}] ?? {fallback})'
    m = re.fullmatch(r"\$(\w+)\['([^']+)'\](\['([^']+)'\])?\s*(\?\?\s*(.+))?", expr, re.S)
    if m:
        if not regs.has(m.group(1)):
            raise ExprCompileError(f'array access ${m.group(1)} unregistered')
        base = regs.get(m.group(1))
        acc = f'(({base}) as Record<string, unknown>)[{ts_str(m.group(2))}]'
        if m.group(3):
            acc += f'[{ts_str(m.group(4))}]'
        fallback = E(m.group(6)) if m.group(5) else None
        return f'({acc} ?? {fallback})' if fallback else acc
    m = re.fullmatch(r'\$(\w+)', expr)
    if m:
        if regs.has(m.group(1)):
            return regs.get(m.group(1))
        raise ExprCompileError(f'var ${m.group(1)} unregistered')

    # self::CONST
    m = re.fullmatch(r'self::(\w+)', expr)
    if m:
        if m.group(1) not in consts:
            raise ExprCompileError(f'const {m.group(1)}')
        return m.group(1)

    # concat
    parts = split_concat(expr)
    if len(parts) > 1:
        segs = []
        for p in parts:
            if p in ("'", '"'):
                continue  # empty string literal in concat chain
            c = E(p)
            if c.startswith('"') and c.endswith('"'):
                try:
                    segs.append(json.loads(c))
                except Exception:
                    segs.append('${String(' + c + ')}')
            else:
                segs.append('${String(' + c + ')}')
        if not segs:
            return "''"
        return '`' + ''.join(segs) + '`'
    # single part that was wrapped by concat detection with empty string
    if len(parts) == 1 and parts[0] != expr.strip():
        return E(parts[0])

    raise ExprCompileError(f'unsupported: {expr[:100]}')


def split_ternary(expr):
    """Split top-level ternary cond ? a : b. Returns tuple or None."""
    depth = 0
    in_str = None
    i = 0
    q_pos = None
    while i < len(expr):
        c = expr[i]
        if in_str:
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == '?' and depth == 0:
            if i + 1 < len(expr) and expr[i + 1] == '>':  # ?-> nullsafe
                i += 2
                continue
            q_pos = i
            break
        i += 1
    if q_pos is None:
        return None
    # find matching colon at depth 0 after ?
    depth = 0
    in_str = None
    j = q_pos + 1
    c_pos = None
    while j < len(expr):
        c = expr[j]
        if in_str:
            if c == '\\':
                j += 2
                continue
            if c == in_str:
                in_str = None
            j += 1
            continue
        if c in ('"', "'"):
            in_str = c
        elif c in '([{':
            depth += 1
        elif c in ')]}':
            depth -= 1
        elif c == ':' and depth == 0:
            # skip PHP :: static resolution (self::CONST) and ?: / :? sequences
            nxt = expr[j + 1] if j + 1 < len(expr) else ''
            prv = expr[j - 1] if j > 0 else ''
            if nxt == ':' or prv == ':':
                j += 1
                continue
            c_pos = j
            break
        j += 1
    if c_pos is None:
        return None
    return (expr[:q_pos].strip(), expr[q_pos + 1:c_pos].strip(), expr[c_pos + 1:].strip())

# ===============================================================
# Condition compiler
# ===============================================================

def compile_condition(expr, regs, consts, depth=0):
    expr = expr.strip()
    if depth > 10:
        raise ExprCompileError('cond too deep')
    C = lambda e: compile_condition(e, regs, consts, depth + 1)

    if expr.startswith('(') and match_balanced(expr, 0, '(', ')') == len(expr):
        return C(expr[1:-1])

    m = re.fullmatch(r'in_array\(\s*(.+?),\s*\[(.*?)\]\s*(?:,\s*true)?\)', expr, re.S)
    if m:
        inner = compile_expr(m.group(1), regs, consts)
        vals = [compile_expr(v, regs, consts) for v in split_top(m.group(2))]
        return f'[{", ".join(vals)}].includes(String({inner}))'
    m = re.fullmatch(r'!empty\((.+)\)', expr, re.S)
    if m:
        return f"(String({compile_expr(m.group(1), regs, consts)} ?? '') !== '')"
    m = re.fullmatch(r'empty\((.+)\)', expr, re.S)
    if m:
        return f"(String({compile_expr(m.group(1), regs, consts)} ?? '') === '')"
    m = re.fullmatch(r'isset\((.+)\)', expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f'({e} !== undefined && {e} !== null)'
    m = re.fullmatch(r'!isset\((.+)\)', expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f'({e} === undefined || {e} === null)'
    m = re.fullmatch(r"strpos\((.+?),\s*'([^']*)'\)\s*!==?\s*false", expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f"String({e}).includes({ts_str(m.group(2))})"
    m = re.fullmatch(r"strpos\((.+?),\s*'([^']*)'\)\s*===?\s*false", expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f"(!String({e}).includes({ts_str(m.group(2))}))"
    m = re.fullmatch(r'is_array\((.+)\)', expr, re.S)
    if m:
        return 'res.data !== null'  # context: json_decode result
    m = re.fullmatch(r'is_numeric\((.+)\)', expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f'(!isNaN(Number({e})))'
    m = re.fullmatch(r'\$this->isUuid\((.+)\)', expr, re.S)
    if m:
        e = compile_expr(m.group(1), regs, consts)
        return f'(/^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$/i).test(String({e}))'
    m = re.fullmatch(r'!\$(\w+)', expr)
    if m:
        return f'!{regs.get(m.group(1))}' if regs.has(m.group(1)) else 'false'
    m = re.fullmatch(r'\$(\w+)', expr)
    if m:
        if regs.has(m.group(1)):
            return f'(String({regs.get(m.group(1))} ?? \'\') !== \'\')'
        raise ExprCompileError(f'cond var ${m.group(1)}')

    if expr in ('true', 'false', 'null'):
        return expr

    # boolean ops
    for op in ('&&', '||'):
        parts = split_bool(expr, op)
        if len(parts) > 1:
            return (' ' + op + ' ').join(f'({C(p)})' for p in parts)

    m = re.fullmatch(r'(.+?)\s*(===|!==|==|!=)\s*(.+)', expr, re.S)
    if m:
        left = compile_expr(m.group(1), regs, consts)
        right = compile_expr(m.group(3), regs, consts)
        opmap = {'===': '===', '!==': '!==', '==': '===', '!=': '!=='}
        return f'String({left}) {opmap[m.group(2)]} String({right})'
    raise ExprCompileError(f'cond unsupported: {expr[:80]}')


def split_bool(expr, op):
    parts, depth, cur, in_str = [], 0, '', None
    sym = op[0]
    i = 0
    while i < len(expr):
        c = expr[i]
        if in_str:
            cur += c
            if c == '\\':
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
            cur += c
        elif c in '([{':
            depth += 1
            cur += c
        elif c in ')]}':
            depth -= 1
            cur += c
        elif c == sym and depth == 0 and i + 1 < len(expr) and expr[i + 1] == sym:
            parts.append(cur)
            cur = ''
            i += 2
            continue
        else:
            cur += c
        i += 1
    if cur.strip():
        parts.append(cur)
    return [p.strip() for p in parts if p.strip()]


def simplify_ts(s):
    # balanced simplifications only — never drop a paren without its partner
    s = s.replace(" ?? '') ?? ''", " ?? '')")
    s = s.replace(" ?? null) ?? ''", " ?? '')")
    s = s.replace("?? '' ?? ''", "?? ''")
    s = re.sub(r'String\((`[^`]*`)\)', r'\1', s)
    # String(String(x)) -> String(x), balanced, repeated for nesting
    for _ in range(4):
        s2 = re.sub(r'String\((String\([^()]*\))\)', r'\1', s)
        if s2 == s:
            break
        s = s2
    # String(String(x).fn()) -> String(x).fn()
    for _ in range(4):
        s2 = re.sub(r'String\((String\([^()]*\)\.\w+\(\))\)', r'\1', s)
        if s2 == s:
            break
        s = s2
    return s

# ===============================================================
# Statement scanner: generic var registration + curl extraction
# ===============================================================

def extract_statements(body):
    """Split method body into top-level statements (rough)."""
    stmts = []
    depth = 0
    in_str = None
    cur = ''
    i = 0
    while i < len(body):
        c = body[i]
        if in_str:
            cur += c
            if c == '\\':
                if i + 1 < len(body):
                    cur += body[i + 1]
                i += 2
                continue
            if c == in_str:
                in_str = None
            i += 1
            continue
        if c in ('"', "'"):
            in_str = c
            cur += c
        elif c == '{':
            depth += 1
            cur += c
        elif c == '}':
            depth -= 1
            cur += c
            if depth == 0 and cur.strip():
                stmts.append(cur.strip())
                cur = ''
        elif c == ';' and depth == 0:
            if cur.strip():
                stmts.append(cur.strip())
            cur = ''
        else:
            cur += c
        i += 1
    if cur.strip():
        stmts.append(cur.strip())
    return stmts


def register_assignments(body, regs, consts, uses):
    """Sequential pre-pass: compile simple assignments and register vars.
    Handles the common local-var chains. Returns list of TS emit lines for
    assignments that must appear before the request (mode/baseUrl/payload/etc)."""
    lines = []
    for stmt in extract_statements(body):
        m = re.fullmatch(r'\$(\w+)\s*=\s*(.+)', stmt, re.S)
        if not m:
            continue
        var, rhs = m.group(1), m.group(2).strip()
        if var in ('ch', 'response', 'httpCode', 'data', 'outData', 'res', 'err', 'responseOut', 'responseJson'):
            continue
        # skip inside if-blocks (statements containing { are not simple)
        if '{' in stmt:
            # still allow "if (...) {...}" skip
            continue
        try:
            ts_expr = compile_expr(rhs, regs, consts)
        except ExprCompileError:
            continue
        if ts_expr is None:
            continue
        ts_expr = simplify_ts(ts_expr)
        if var == 'mode':
            lines.append(f'const mode = {ts_expr};')
            regs.set('mode', 'mode')
        elif var in ('baseUrl', 'endpoint', 'url', 'authUrl', 'apiUrl', 'verifyUrl'):
            lines.append(f'const {var} = {ts_expr};')
            regs.set(var, var)
        elif rhs.startswith('['):
            lines.append(f'const {var}: Record<string, unknown> = {ts_expr};')
            regs.set(var, var)
        else:
            if ts_expr.startswith('await ') or 'await ' in ts_expr:
                lines.append(f'const {var} = {ts_expr};')
            else:
                lines.append(f'const {var} = {ts_expr};')
            regs.set(var, var)
        for sym in ('md5Hex', 'hmacHex', 'shaHex'):
            if sym in ts_expr:
                uses.add(sym)
    return lines


def extract_curl_calls(body):
    """Extract curl calls with balanced-paren args and balanced option arrays."""
    calls = []
    for m in re.finditer(r'curl_init\(', body):
        start = m.end()
        end = match_balanced(body, start - 1 + (0 if body[start - 1] == '(' else 0), '(', ')')
        # careful: body[start-1] is '('
        end = match_balanced(body, start - 1, '(', ')')
        if end < 0:
            continue
        url_expr = body[start:end - 1].strip()
        calls.append({
            'url_expr': url_expr, 'method': 'GET', 'headers': [],
            'body_expr': None, 'body_kind': None, 'timeout': None, 'userpwd': None,
        })
    for m in re.finditer(r'curl_setopt_array\(\s*\$\w+\s*,', body):
        # options array starts at the '[' after comma
        rest = body[m.end():]
        if not rest.lstrip().startswith('['):
            continue
        lb = m.end() + rest.index('[')
        rb = match_balanced(body, lb, '[', ']')
        if rb < 0:
            continue
        opts = body[lb + 1:rb - 1]
        # split options at top level
        idx = len(calls) - 1
        if idx < 0:
            calls.append({'url_expr': None, 'method': 'GET', 'headers': [],
                          'body_expr': None, 'body_kind': None, 'timeout': None, 'userpwd': None})
            idx = len(calls) - 1
        call = calls[idx]
        for opt in split_top(opts):
            om = re.match(r'(CURLOPT_\w+)\s*=>\s*(.*)', opt, re.S)
            if not om:
                continue
            key, val = om.group(1), om.group(2).strip().rstrip(',').strip()
            if key == 'CURLOPT_POST':
                call['method'] = 'POST' if val == 'true' else call['method']
            elif key == 'CURLOPT_POSTFIELDS':
                call['body_expr'] = val
                if 'http_build_query' in val:
                    call['body_kind'] = 'form'
                elif 'json_encode' in val:
                    call['body_kind'] = 'json'
                else:
                    call['body_kind'] = 'raw'
            elif key == 'CURLOPT_TIMEOUT':
                tm = re.fullmatch(r'(\d+)', val)
                if tm:
                    call['timeout'] = int(tm.group(1))
            elif key == 'CURLOPT_USERPWD':
                call['userpwd'] = val
            elif key == 'CURLOPT_HTTPHEADER':
                # array of header strings — kept RAW (may be concat exprs like
                # 'Authorization: Bearer ' . $secretKey, compiled at emit time)
                hm = re.match(r"\[(.*)\]", val, re.S)
                if hm:
                    for h in split_top(hm.group(1)):
                        h = h.strip()
                        if h.startswith("'"):
                            call['headers'].append(h)
    return calls

# ===============================================================
# Method compilers v3 — two-phase (pre-request / post-response)
# ===============================================================

DATA_VARS = {'data', 'outData', 'res', 'response', 'responseOut', 'responseJson', 'responseData', 'body'}
ASSIGN_SKIP = DATA_VARS | {'ch', 'httpCode', 'err', 'curlErr', 'result', 'status', 'results'}
TOKEN_HELPERS = {'getToken', 'getAccessToken', 'getClientToken'}
URL_HELPERS = {'getEndpoint', 'getBaseUrl'}


def compile_header(h_raw, regs, consts):
    """Compile a raw PHP header expression (literal or concat) to
    (name, ts_value). Returns None when not a Name: value header."""
    try:
        compiled = simplify_ts(compile_expr(h_raw, regs, consts))
    except ExprCompileError:
        return None
    if compiled.startswith('"'):
        try:
            inner = json.loads(compiled)
        except Exception:
            return None
        if ':' in inner:
            name, _, val = inner.partition(':')
            return name.strip(), ts_str(val.strip())
        return None
    if compiled.startswith('`'):
        m = re.match(r'`([^:`]+):\s*(.*)`', compiled, re.S)
        if m:
            return m.group(1).strip(), '`' + m.group(2) + '`'
    return None


def has_sim_fallback(body):
    return 'SIM_' in body or ("uniqid()" in body and 'gateway_trx_id=' in body)


def find_return_arrays(body):
    out = []
    for m in re.finditer(r'return\s*\[', body):
        lb = m.end() - 1
        rb = match_balanced(body, lb, '[', ']')
        if rb < 0:
            continue
        out.append(body[lb + 1:rb - 1])
    return out


def is_sim_return(items):
    for k, v in items:
        if 'SIM_' in v or 'uniqid()' in v:
            return True
    return False


def compile_helper_inline(helper_name, cls_src, regs, consts, uses):
    """Inline a simple private helper (getEndpoint/getBaseUrl): compile its
    return expression with the caller's registry."""
    body = method_body(cls_src, helper_name)
    if body is None:
        raise ExprCompileError(f'helper {helper_name} not found')
    # register helper-local credential reads
    for am in re.finditer(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$credentials\['([^']+)'\][^)]*\)", body):
        regs.set(am.group(1), f"credentials.{am.group(2)} ?? ''")
    rm = re.search(r'return\s+(.+?)\s*;', body, re.S)
    if not rm:
        raise ExprCompileError(f'helper {helper_name} no return')
    return simplify_ts(compile_expr(rm.group(1), regs, consts))


def extract_token_helper(cls_src, helper_name):
    """Extract OAuth grant details from a getToken-style helper.
    Returns dict(url_expr_fn, headers, body_kind, body_items, token_path) or None."""
    body = method_body(cls_src, helper_name)
    if body is None:
        return None
    calls = extract_curl_calls(body)
    if not calls:
        return None
    call = calls[0]
    # token path: $data['id_token'] / ['access_token'] / ['token']
    tp = re.search(r"\$data\['(id_token|access_token|token|auth_token)'\]", body)
    token_path = tp.group(1) if tp else 'access_token'
    body_items = None
    if call['body_kind'] == 'json':
        be = call['body_expr']
        m = re.fullmatch(r'\(string\)\s*json_encode\(\[(.*)\]\)', be, re.S)
        if m:
            body_items = php_array_items(m.group(1))
    return {
        'call': call,
        'token_path': token_path,
        'body_items': body_items,
        'body': body,
    }


def compile_assignments_phased(body, cls_src, regs, consts, uses, token_helper):
    """Two-phase assignment registration. Returns (pre_lines, post_lines).
    pre = emitted before the HTTP request; post = after `const d = ...`."""
    pre, post = [], []
    # every json_decode result var maps onto the single parsed object `d`
    for jm in re.finditer(r'\$(\w+)\s*(?<![<>!=])=(?!=)\s*json_decode', body):
        if jm.group(1) not in ('data', 'outData'):
            regs.set(jm.group(1), 'd')
    regs.set('data', 'd')
    regs.set('outData', 'd')
    # iterate over ALL assignments incl. inside if-blocks, in source order
    for m in re.finditer(r'\$(\w+)\s*(?<![<>!=])=(?!=)\s*(.+?)\s*;', body, re.S):
        var, rhs = m.group(1), m.group(2).strip()
        if var in ASSIGN_SKIP or regs.has(var):
            continue
        # guard: accidental matches like `$x == 'v') { ...` or control flow
        if re.match(r'^(=|\)|\?|\{|return|throw|if\s*\()', rhs):
            continue
        if 'throw new' in rhs or rhs.startswith('==') or 'runtimeException' in rhs.lower():
            continue
        if var == 'mode':
            ts_expr = compile_expr(rhs, regs, consts) if not rhs.startswith("$this->getString($credentials['mode']") else None
            if ts_expr is None:
                pre.append("const mode = String(credentials.mode ?? 'sandbox');")
            else:
                pre.append(f'const mode = {simplify_ts(ts_expr)};')
            regs.set('mode', 'mode')
            continue
        # token helper calls
        tm = re.fullmatch(r'\$this->(getToken|getAccessToken|getClientToken)\((.*?)\)', rhs, re.S)
        if tm:
            helper = tm.group(1)
            args = [a.strip() for a in split_top(tm.group(2))]
            ts_args = []
            for a in args:
                if a.startswith('$'):
                    av = a[1:]
                    if regs.has(av):
                        ts_args.append(regs.get(av))
                    elif av == 'credentials':
                        ts_args.append('credentials')
                    else:
                        ts_args.append('undefined as unknown as string')
                elif a == '$credentials':
                    ts_args.append('credentials')
                else:
                    ts_args.append(simplify_ts(compile_expr(a, regs, consts)))
            pre.append(f'const {var} = await this.getToken({", ".join(ts_args)});')
            regs.set(var, var)
            token_helper['name'] = helper
            continue
        # URL helper calls
        um = re.fullmatch(r"\$this->(getEndpoint|getBaseUrl)\(\$credentials(?:,\s*'([^']*)')?\)", rhs)
        if um:
            try:
                ts_expr = compile_helper_inline(um.group(1), cls_src, regs, consts, uses)
            except ExprCompileError:
                ts_expr = None
            if ts_expr is None:
                ts_expr = f"consts.{list(consts.keys())[0]}" if consts else "''"
            if um.group(2):
                ts_expr = f'`$' + '{String(' + ts_expr + ')}' + um.group(2) + '`'
            pre.append(f'const {var} = {ts_expr};')
            regs.set(var, var)
            continue
        # $x = $this->getArray($data, 'field')
        gm = re.fullmatch(r"\$this->getArray\(\s*\$(\w+)\s*,\s*'([^']+)'\s*\)", rhs)
        if gm and regs.has(gm.group(1)):
            base = regs.get(gm.group(1))
            ts_expr = f"(({base}) as Record<string, unknown>)[{ts_str(gm.group(2))}] ?? {{}}"
            post.append(f'const {var} = {ts_expr};')
            regs.set(var, var)
            continue
        # getString/getInt/getFloat wrappers over credentials/params/data compile fine
        if re.fullmatch(r'\$this->get(?:String|Int|Float)\(.*\)', rhs, re.S):
            try:
                ts_expr = simplify_ts(compile_expr(rhs, regs, consts))
                is_post = bool(re.search(r'(?<![\w$.\"\'])(d)(?![\w])', ts_expr))
                (post if is_post else pre).append(f'const {var} = {ts_expr};')
                regs.set(var, var)
                continue
            except ExprCompileError:
                continue
        if rhs.startswith('$this->'):
            continue  # other helper calls unsupported at assignment level
        if re.search(r'\b(curl_|openssl_|password_)', rhs):
            continue
        try:
            ts_expr = simplify_ts(compile_expr(rhs, regs, consts))
        except ExprCompileError:
            continue
        if ts_expr is None:
            continue
        for sym in ('md5Hex', 'hmacHex', 'shaHex'):
            if sym in ts_expr:
                uses.add(sym)
        if ' d' in f' {ts_expr}' or '(d)' in ts_expr or 'd)' in ts_expr or 'd[' in ts_expr or ' d ' in f' {ts_expr} ':
            pass
        is_post = bool(re.search(r'(?<![\w$.\"\'])(d)(?![\w])', ts_expr))
        if re.search(r'\(\(d\)| d\[|\bd\b', ts_expr):
            post.append(f'const {var} = {ts_expr};')
        else:
            pre.append(f'const {var} = {ts_expr};')
        regs.set(var, var)
    return pre, post


def compile_initiate(body, fx, slug, cls_src):
    regs, consts, uses = fx.regs, fx.consts, fx.uses
    lines = []
    token_helper = {}

    has_form = '<form' in body or 'form_html' in body
    form_keys = []
    for ret in find_return_arrays(body):
        items = php_array_items(ret)
        if not items:
            continue
        d = dict(items)
        if 'form_html' in d:
            form_keys.append(d['form_html'])
    if form_keys and ('<form' in body or any('$' in v for v in form_keys)):
        # error-div-only returns don't count as the form archetype
        real_form = any(('<form' in v) or (v.startswith('$')) for v in form_keys)
        if real_form or '<form' in body:
            return compile_form_html(body, fx, slug, cls_src)

    calls = extract_curl_calls(body)
    if not calls:
        raise ExprCompileError('initiate: no curl, no form')
    call = calls[0]

    pre, post = compile_assignments_phased(body, cls_src, regs, consts, uses, token_helper)
    lines.extend(pre)

    # payload
    body_arg = ''
    if call['body_kind'] == 'json':
        be = call['body_expr']
        payload_expr = None
        m = re.fullmatch(r'\(string\)\s*json_encode\(\s*\$(\w+)\s*\)', be)
        if m:
            if not regs.has(m.group(1)):
                raise ExprCompileError('initiate: payload var unregistered')
            body_arg = f'body: JSON.stringify({regs.get(m.group(1))}),'
        else:
            m = re.fullmatch(r'(?:\(string\)\s*)?json_encode\(\[(.*)\]\)', be, re.S)
            if m:
                items = php_array_items(m.group(1))
                if items is None:
                    raise ExprCompileError('initiate: json items')
                entries = ', '.join(f'[{ts_str(k)}]: {simplify_ts(compile_expr(v, regs, consts))}' for k, v in items)
                lines.append(f'const payload: Record<string, unknown> = {{ {entries} }};')
                body_arg = 'body: JSON.stringify(payload),'
            else:
                raise ExprCompileError('initiate: json body variant')
    elif call['body_kind'] == 'form':
        be = call['body_expr']
        m = re.fullmatch(r'http_build_query\(\s*\$(\w+)\s*\)', be)
        if m:
            if not regs.has(m.group(1)):
                raise ExprCompileError('initiate: form var')
            body_arg = f'body: queryString({regs.get(m.group(1))} as Record<string, string>),'
            uses.add('queryString')
        else:
            body_arg = f'body: {simplify_ts(compile_expr(be, regs, consts))},'

    url_ts = simplify_ts(compile_expr(call['url_expr'], regs, consts))
    header_lines = {}
    if call['body_kind']:
        ct = 'application/json' if call['body_kind'] == 'json' else 'application/x-www-form-urlencoded'
        header_lines['Content-Type'] = ts_str(ct)
    for h in call['headers']:
        ch = compile_header(h, regs, consts)
        if not ch:
            continue
        hname, hval = ch
        if hname == 'Content-Type':
            continue
        header_lines[hname] = hval
    if call['userpwd']:
        header_lines['Authorization'] = '`Basic ${btoa(' + simplify_ts(compile_expr(call['userpwd'], regs, consts)) + ')}`'

    timeout = (call.get('timeout') or 15) * 1000
    lines.append('const res = await gwJson({')
    lines.append(f'  url: {url_ts},')
    lines.append(f"  method: '{call['method']}',")
    if header_lines:
        lines.append('  headers: { ' + ', '.join(f'[{ts_str(k)}]: {v}' for k, v in header_lines.items()) + ' },')
    if body_arg:
        lines.append(f'  {body_arg}')
    lines.append(f'  timeoutMs: {timeout},')
    lines.append('});')
    uses.add('gwJson')

    http_gate = re.search(r'\$httpCode\s*!==?\s*(\d+)', body)
    if http_gate:
        lines.append(f'if (res.status !== {http_gate.group(1)}) throw new Error(`${{SLUG}}: HTTP ${{res.status}} ${{res.text}}`);')
    lines.append('if (res.data === null) throw new Error(`${SLUG}: invalid response`);')
    lines.append('const d = res.data as Record<string, unknown>;')
    regs.set('data', 'd')
    regs.set('outData', 'd')
    lines.extend(post)

    candidates = []
    for ret in find_return_arrays(body):
        items = php_array_items(ret)
        if not items or is_sim_return(items):
            continue
        if any('$data' in v or '$outData' in v for k, v in items):
            candidates.append(items)
    if not candidates:
        for ret in find_return_arrays(body):
            items = php_array_items(ret)
            if items and not is_sim_return(items):
                candidates.append(items)
    if not candidates:
        # var-return: $res = [...]; ... return $res;
        vm = re.search(r'\$(\w+)\s*=\s*(\[.*?\])\s*;(.*?)return\s+\$\1\s*;', body, re.S)
        if vm:
            items = php_array_items(vm.group(2)[1:-1] if vm.group(2).startswith('[') else vm.group(2))
            if items:
                # merge conditional additions: $res['key'] = expr;
                for am in re.finditer(r"\$\w+\['([^']+)'\]\s*=\s*(.+?)\s*;", vm.group(3)):
                    if all(k != am.group(1) for k, _ in items):
                        items.append((am.group(1), am.group(2)))
                candidates.append(items)
    if not candidates:
        raise ExprCompileError('initiate: no real return')
    items = candidates[-1]

    entries = []
    for k, v in items:
        if k == 'redirect_url':
            entries.append(f'      redirect_url: ({simplify_ts(compile_expr(v, regs, consts))} || undefined) as string | undefined,')
        elif k == 'session_id':
            entries.append(f'      session_id: ({simplify_ts(compile_expr(v, regs, consts))} || undefined) as string | undefined,')
    if not entries:
        raise ExprCompileError('initiate: no redirect/session mapping')
    lines.append('return {')
    lines.extend(entries)
    lines.append('    };')
    fx.token_helper = token_helper
    return lines, 'rest'


def compile_form_html(body, fx, slug, cls_src):
    """Form archetype. Two strategies:
    1. RAW: the form_html value is a compileable concat chain (JS-widget HTML,
       custom checkout pages) — emit it verbatim. Most faithful to upstream.
    2. KIT: classic auto-submit POST form — rebuild via buildAutoSubmitForm
       with escaped fields.
    """
    regs, consts, uses = fx.regs, fx.consts, fx.uses
    lines = []
    token_helper = {}
    pre, _post = compile_assignments_phased(body, cls_src, regs, consts, uses, token_helper)
    lines.extend(pre)
    fx.token_helper = token_helper

    # locate the form_html return + its value
    form_val = None
    for ret in find_return_arrays(body):
        items = php_array_items(ret)
        if not items:
            continue
        d = dict(items)
        if 'form_html' in d:
            form_val = d['form_html']
            break

    if form_val is None:
        raise ExprCompileError('form: no form_html return')

    # Strategy 1: raw compile (handles $html vars and direct concat chains)
    try:
        html_ts = simplify_ts(compile_expr(form_val, regs, consts))
        if '`' not in html_ts[:1] and html_ts.startswith('`'):
            pass
        # guard: template literals in embedded JS would break — check for ${ sequences
        # that did NOT come from our own interpolation markers is hard; instead
        # reject if the raw PHP value contains backticks
        if '`' not in form_val:
            if not lines or all('form_html' not in l for l in lines):
                pass
            lines.append(f'return {{ form_html: {html_ts} }};')
            return lines, 'form-raw'
    except ExprCompileError:
        pass

    # Strategy 2: auto-submit kit form
    am = re.search(r'<form\s+action="\s*(.*?)\s*"', body, re.S)
    if not am:
        am = re.search(r'<form[^>]*\baction="\s*(.*?)\s*"', body, re.S)
    if not am:
        raise ExprCompileError('form: no action')
    action_ts = simplify_ts(compile_expr(am.group(1), regs, consts))

    fields = []
    for im in re.finditer(r'name="([^"]+)"\s+value="([^"]*)"', body, re.S):
        name, vexpr = im.group(1), im.group(2)
        if not vexpr.strip():
            continue
        # quote fragments: value="' . X . '" — the leading/trailing quotes are
        # halves of adjacent string literals; complete them so concat parses
        if vexpr.startswith("' . ") and vexpr.endswith(" . '"):
            vexpr = "'' . " + vexpr[4:-4] + " . ''"
        elif vexpr.startswith("' . "):
            vexpr = "'' . " + vexpr[4:]
        elif vexpr.endswith(" . '"):
            vexpr = vexpr[:-4] + " . ''"
        try:
            ts_v = simplify_ts(compile_expr(vexpr, regs, consts))
        except ExprCompileError as e:
            raise ExprCompileError(f'form field {name}: {e}')
        fields.append((name, ts_v))
    if not fields:
        raise ExprCompileError('form: no fields')

    entries = ', '.join(f"[{ts_str(n)}]: String({v} ?? '')" for n, v in fields)
    lines.append(f'const fields: Record<string, string> = {{ {entries} }};')
    lines.append(f'return {{ form_html: buildAutoSubmitForm({action_ts}, fields) }};')
    uses.add('buildAutoSubmitForm')
    return lines, 'form'


def register_callback_reads(body, regs):
    for am in re.finditer(
        r"\$(\w+)\s*=\s*\$this->getString\(\s*\$callbackData\['([^']+)'\]\s*(?:\?\?\s*\$callbackData\['([^']+)'\])?[^)]*\)",
        body,
    ):
        expr = f"cb[{ts_str(am.group(2))}]"
        if am.group(3):
            expr += f" ?? cb[{ts_str(am.group(3))}]"
        regs.set(am.group(1), expr)
    for am in re.finditer(r"\$(\w+)\s*=\s*\$callbackData\['([^']+)'\]\s*\?\?\s*\$callbackData\['([^']+)'\]\s*;", body):
        regs.set(am.group(1), f"cb[{ts_str(am.group(2))}] ?? cb[{ts_str(am.group(3))}]")


def compile_verify(body, fx, slug, cls_src):
    regs, consts, uses = fx.regs, fx.consts, fx.uses
    lines = []
    lines.append('const cb = callbackData as Record<string, unknown>;')
    register_callback_reads(body, regs)

    calls = extract_curl_calls(body)

    guard = re.search(r"if\s*\(\s*!\s*\$(\w+)\s*\)\s*\{", body) or re.search(r"if\s*\(\s*\$(\w+)\s*===?\s*''\s*\)\s*\{", body)
    if guard and regs.has(guard.group(1)) and guard.group(1) not in DATA_VARS:
        lines.append(f"if (String({regs.get(guard.group(1))} ?? '') === '') {{")
        lines.append("      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };")
        lines.append('    }')

    if not calls:
        return compile_verify_trust(body, fx, slug, lines, cls_src)

    call = calls[0]
    token_helper = {}
    pre, post = compile_assignments_phased(body, cls_src, regs, consts, uses, token_helper)
    lines.extend(pre)
    fx.token_helper = token_helper

    url_ts = simplify_ts(compile_expr(call['url_expr'], regs, consts))

    header_lines = {}
    for h in call['headers']:
        ch = compile_header(h, regs, consts)
        if not ch:
            continue
        hname, hval = ch
        if hname == 'Content-Type':
            continue
        header_lines[hname] = hval
    if call['userpwd']:
        header_lines['Authorization'] = '`Basic ${btoa(' + simplify_ts(compile_expr(call['userpwd'], regs, consts)) + ')}`'

    body_arg = ''
    if call['body_kind'] == 'json':
        be = call['body_expr']
        m = re.fullmatch(r'\(string\)\s*json_encode\(\s*\$(\w+)\s*\)', be)
        if m and regs.has(m.group(1)):
            body_arg = f'body: JSON.stringify({regs.get(m.group(1))}),'
        else:
            m = re.fullmatch(r'(?:\(string\)\s*)?json_encode\(\[(.*)\]\)', be, re.S)
            if m:
                items = php_array_items(m.group(1))
                if items is None:
                    raise ExprCompileError('verify: json items')
                entries = ', '.join(f'[{ts_str(k)}]: {simplify_ts(compile_expr(v, regs, consts))}' for k, v in items)
                lines.append(f'const payload: Record<string, unknown> = {{ {entries} }};')
                body_arg = 'body: JSON.stringify(payload),'

    timeout = (call.get('timeout') or 10) * 1000
    lines.append('const res = await gwJson({')
    lines.append(f'  url: {url_ts},')
    lines.append(f"  method: '{call['method']}',")
    if header_lines:
        lines.append('  headers: { ' + ', '.join(f'[{ts_str(k)}]: {v}' for k, v in header_lines.items()) + ' },')
    if body_arg:
        lines.append(f'  {body_arg}')
    lines.append(f'  timeoutMs: {timeout},')
    lines.append('});')
    uses.add('gwJson')
    http_gate = re.search(r'\$httpCode\s*!==?\s*(\d+)', body)
    if http_gate:
        lines.append(f'if (res.status !== {http_gate.group(1)}) {{')
        lines.append("      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };")
        lines.append('    }')
    lines.append('if (res.data === null) {')
    lines.append("      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };")
    lines.append('    }')
    lines.append('const d = res.data as Record<string, unknown>;')
    regs.set('data', 'd')
    regs.set('outData', 'd')
    lines.extend(post)
    return finish_verify(body, fx, slug, lines)


def compile_verify_trust(body, fx, slug, lines, cls_src):
    regs, consts = fx.regs, fx.consts
    gm = re.search(r"if\s*\(\s*\(\s*\$callbackData\['([^']+)'\][^)]*\)\s*!==?\s*true\s*\)\s*\{", body)
    if gm:
        lines.append(f"if (String(cb[{ts_str(gm.group(1))}] ?? '') !== 'true') {{")
        lines.append("      return { success: false, gateway_trx_id: '', amount: null, status: 'failed' as const };")
        lines.append('    }')

    pre, _ = compile_assignments_phased(body, cls_src, regs, consts, fx.uses, {})
    lines.extend(pre)

    rets = [php_array_items(r) for r in find_return_arrays(body)]
    rets = [r for r in rets if r]
    if not rets:
        raise ExprCompileError('trust verify: no return')
    items = rets[-1]

    cond = None
    sm = re.search(r'\$(?:success|paid)\s*=\s*(.*?);', body, re.S)
    if sm:
        try:
            cond = compile_condition(sm.group(1), regs, consts)
        except ExprCompileError:
            cond = None
    lines.append('// PORT-NOTE: upstream verifies via the callback payload only (no')
    lines.append('// server-side API); the unguessable checkout callback token is the')
    lines.append('// authenticity gate for this flow.')
    lines.append(f'const ok = {cond};' if cond else 'const ok = false;')
    entries = compile_result_entries(items, fx, 'ok')
    lines.append('return {')
    lines.extend(entries)
    lines.append('    };')
    return lines


def finish_verify(body, fx, slug, lines):
    regs, consts = fx.regs, fx.consts

    for am in re.finditer(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$(\w+)\['([^']+)'\][^)]*?\)", body):
        if regs.has(am.group(2)):
            base = regs.get(am.group(2))
            regs.set(am.group(1), f"(({base}) as Record<string, unknown>)[{ts_str(am.group(3))}]")
    for am in re.finditer(r"\$(\w+)\s*=\s*\$this->getArray\(\s*\$(\w+)\s*,\s*'([^']+)'\s*\)", body):
        if regs.has(am.group(2)):
            base = regs.get(am.group(2))
            regs.set(am.group(1), f"(({base}) as Record<string, unknown>)[{ts_str(am.group(3))}]")
    for am in re.finditer(r"\$(\w+)\s*=\s*\$(\w+)\['([^']+)'\]", body):
        if regs.has(am.group(2)) and not regs.has(am.group(1)):
            base = regs.get(am.group(2))
            regs.set(am.group(1), f"(({base}) as Record<string, unknown>)[{ts_str(am.group(3))}]")

    # Pattern A: $success = <cond>;
    cond = None
    for var in ('success', 'paid', 'valid'):
        sm = re.search(rf'\${var}\s*=\s*(.*?);', body, re.S)
        if sm:
            try:
                cond = compile_condition(sm.group(1), regs, consts)
                break
            except ExprCompileError:
                pass

    # Pattern B: if (<cond>) { return ['success' => true, <data mapping>] }
    # Pattern C: $success = false; ... if (<cond>) { $success = true; }
    if cond is None:
        cm = re.search(r'if\s*\((.+?)\)\s*\{\s*\$(?:success|paid|valid)\s*=\s*true\s*;', body, re.S)
        if cm:
            try:
                cond = compile_condition(cm.group(1), regs, consts)
            except ExprCompileError:
                pass

    success_items = None
    if cond is None:
        for im in re.finditer(r'if\s*\((.+?)\)\s*\{\s*return\s*\[', body, re.S):
            cond_raw = im.group(1)
            rb = match_balanced(body, im.end() - 1, '[', ']')
            if rb < 0:
                continue
            ret_items = php_array_items(body[im.end():rb - 1])
            if not ret_items:
                continue
            sv = dict(ret_items).get('success', '')
            if sv == 'true':
                try:
                    cond = compile_condition(cond_raw, regs, consts)
                    success_items = ret_items
                    break
                except ExprCompileError:
                    continue

    if cond is None:
        raise ExprCompileError('verify: success condition not found')

    lines.append('const ok = ' + cond + ';')

    if success_items is not None:
        items = success_items
    else:
        rets = [php_array_items(r) for r in find_return_arrays(body)]
        rets = [r for r in rets if r and not is_sim_return(r)]
        if not rets:
            vm = re.search(r'\$(\w+)\s*=\s*(\[.*?\])\s*;(.*?)return\s+\$\1\s*;', body, re.S)
            if vm:
                vi = php_array_items(vm.group(2)[1:-1] if vm.group(2).startswith('[') else vm.group(2))
                if vi:
                    for am in re.finditer(r"\$\w+\['([^']+)'\]\s*=\s*(.+?)\s*;", vm.group(3)):
                        if all(k != am.group(1) for k, _ in vi):
                            vi.append((am.group(1), am.group(2)))
                    rets.append(vi)
        if not rets:
            raise ExprCompileError('verify: no return')
        items = rets[-1]
    entries = compile_result_entries(items, fx, 'ok')
    if not any('success:' in e for e in entries):
        raise ExprCompileError('verify: return mapping failed')
    lines.append('return {')
    lines.extend(entries)
    lines.append('    };')
    return lines


def compile_result_entries(items, fx, ok_var):
    regs, consts = fx.regs, fx.consts
    entries = []
    for k, v in items:
        if k == 'success':
            entries.append(f'      success: {ok_var},')
        elif k == 'status':
            m = re.fullmatch(r"\$(\w+)\s*\?\s*'completed'\s*:\s*'(\w+)'", v)
            if m and regs.has(m.group(1)):
                entries.append(f"      status: ({ok_var} ? 'completed' : '{m.group(2)}') as VerifyResult['status'],")
            else:
                entries.append(f"      status: ({ok_var} ? 'completed' : 'failed') as VerifyResult['status'],")
        elif k == 'amount':
            if v == 'null':
                entries.append('      amount: null,')
            else:
                try:
                    entries.append(f"      amount: (String({simplify_ts(compile_expr(v, regs, consts))} ?? '') || null) as string | null,")
                except ExprCompileError:
                    entries.append('      amount: null,')
        elif k in ('gateway_trx_id', 'trx_id'):
            try:
                ts_v = simplify_ts(compile_expr(v, regs, consts))
                entries.append(f"      {k}: String({ts_v} ?? ''),")
            except ExprCompileError:
                entries.append(f"      {k}: '',")
    return entries


def classify_refund(body):
    if body is None:
        return ('none',)
    if 'curl_init' in body:
        return ('real',)
    if re.search(r"return\s*\[\s*'success'\s*=>\s*true", body):
        return ('fake',)
    return ('none',)


def classify_webhook(body):
    if body is None:
        return ('stub_false',)
    stripped = body.strip()
    if re.fullmatch(r'(?:/\*.*?\*/\s*)?return\s+true\s*;', stripped, re.S):
        return ('stub_true',)
    if re.fullmatch(r'(?:/\*.*?\*/\s*)?return\s+false\s*;', stripped, re.S):
        return ('stub_false',)
    if 'hash_equals' in body and ('hash_hmac' in body or 'md5(' in body or re.search(r"hash\('", body)):
        return ('real_hmac',)
    if 'hash_equals' in body:
        return ('static_secret',)
    if 'foreach' in body and 'return true' in body and 'hash' not in body:
        return ('header_presence',)
    return ('uncompilable',)


def compile_webhook(body, fx, slug, kind):
    regs, consts = fx.regs, fx.consts
    if kind in ('stub_true', 'header_presence'):
        return [
            '// PORT-SECURITY: upstream accepted these webhooks without a signature',
            '// check (stub / header-presence only). Ported FAIL-CLOSED: unsigned',
            '// events are rejected. Payments complete via the signed checkout',
            '// callback + server-side verify() instead.',
            'return false;',
        ]
    if kind == 'stub_false':
        return ['return false;']
    if kind == 'static_secret':
        hm = re.search(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$credentials\['([^']+)'\][^)]*\)", body)
        header_names = re.findall(r"\$headers\['([^']+)'\]", body)
        if hm and header_names:
            cred = hm.group(2)
            header = header_names[0]
            lines = [
                f'const expected = credentials[{ts_str(cred)}] ?? \'\';',
                "if (expected === '') return false; // fail-closed: secret not configured",
                f'const provided = input.headers[{ts_str(header)}] ?? \'\';',
                f'const providedLower = input.headers[{ts_str(header.lower())}] ?? \'\';',
                'return timingSafeEqual(expected, (provided || providedLower));',
            ]
            fx.uses.add('timingSafeEqual')
            return lines
    if kind == 'real_hmac':
        # generic extraction attempt
        sm = re.search(r"\$(\w+)\s*=\s*hash_hmac\('(\w+)',\s*\$(\w+),\s*\$(\w+)\)", body)
        cm = re.search(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$credentials\['([^']+)'\]", body)
        hm_hdr = re.search(r"\$headers\['([^']+)'\]", body)
        if sm and cm and hm_hdr:
            algo = {'sha256': 'SHA-256', 'sha1': 'SHA-1', 'sha512': 'SHA-512'}.get(sm.group(2))
            if algo:
                body_var, secret_field, header = sm.group(3), cm.group(2), hm_hdr.group(1)
                body_ts = 'input.rawBody' if body_var in ('rawBody',) else 'input.rawBody'
                lines = [
                    f"const secret = credentials[{ts_str(secret_field)}] ?? '';",
                    "if (secret === '') return false; // fail-closed",
                    f'const provided = input.headers[{ts_str(header)}] ?? \'\';',
                    'if (provided === \'\') return false;',
                    f"const expected = await hmacHex('{algo}', {body_ts}, secret);",
                    'return timingSafeEqual(expected, provided);',
                ]
                fx.uses.update(['hmacHex', 'timingSafeEqual'])
                return lines
    return [
        '// PORT-REVIEW: upstream webhook scheme not extracted — fail-closed.',
        'return false;',
    ]


# ===============================================================
# Emitter + main
# ===============================================================

def pascal(slug):
    name = ''.join(p[:1].upper() + p[1:] for p in re.split(r'[-_.]', slug) if p)
    # TS identifiers cannot start with a digit (2checkout -> Gw2Checkout)
    if name[:1].isdigit():
        name = 'Gw' + name
    return name


class FlowContext:
    def __init__(self, consts):
        self.consts = consts
        self.regs = VarRegistry(with_bases=True)
        self.uses = set()
        self.token_helper = {}


def extract_constants_full(src):
    return {m.group(1): m.group(2) for m in re.finditer(r"const\s+(\w+)\s*=\s*'([^']*)'", src)}


def compile_refund_real(body, fx, slug):
    regs, consts, uses = fx.regs, fx.consts, fx.uses
    lines = []
    calls = extract_curl_calls(body)
    if not calls:
        raise ExprCompileError('refund: no curl')
    call = calls[0]
    lines.extend(register_assignments(body, regs, consts, uses))
    url_ts = simplify_ts(compile_expr(call['url_expr'], regs, consts))
    header_lines = {}
    for h in call['headers']:
        hm = re.match(r'([^:]+):\s*(.*)', h, re.S)
        if hm:
            hname, hval = hm.group(1).strip(), hm.group(2).strip()
            if hname == 'Content-Type':
                continue
            if hval.startswith(('$', 'self::')) or hval.startswith("' . "):
                try:
                    header_lines[hname] = simplify_ts(compile_expr(hval, regs, consts))
                except ExprCompileError:
                    continue
            else:
                header_lines[hname] = ts_str(hval)
    if call['userpwd']:
        header_lines['Authorization'] = '`Basic ${btoa(' + simplify_ts(compile_expr(call['userpwd'], regs, consts)) + ')}`'
    body_arg = ''
    if call['body_kind'] == 'json':
        be = call['body_expr']
        m = re.fullmatch(r'\(string\)\s*json_encode\(\s*\$(\w+)\s*\)', be)
        if m and regs.has(m.group(1)):
            body_arg = f'body: JSON.stringify({regs.get(m.group(1))}),'
        else:
            m = re.fullmatch(r'\(string\)\s*json_encode\(\[(.*)\]\)', be, re.S)
            if m:
                items = php_array_items(m.group(1))
                if items is None:
                    raise ExprCompileError('refund: json items')
                entries = ', '.join(f'[{ts_str(k)}]: {simplify_ts(compile_expr(v, regs, consts))}' for k, v in items)
                lines.append(f'const payload: Record<string, unknown> = {{ {entries} }};')
                body_arg = 'body: JSON.stringify(payload),'
            else:
                raise ExprCompileError('refund: body variant')
    timeout = (call.get('timeout') or 15) * 1000
    lines.append('const res = await gwJson({')
    lines.append(f'  url: {url_ts},')
    lines.append(f"  method: '{call['method']}',")
    if header_lines:
        lines.append('  headers: { ' + ', '.join(f'[{ts_str(k)}]: {v}' for k, v in header_lines.items()) + ' },')
    if body_arg:
        lines.append(f'  {body_arg}')
    lines.append(f'  timeoutMs: {timeout},')
    lines.append('});')
    uses.add('gwJson')
    lines.append('if (res.data === null) {')
    lines.append("      return { success: false, error: 'invalid_response' };")
    lines.append('    }')
    lines.append('const d = res.data as Record<string, unknown>;')
    regs.set('data', 'd')
    for am in re.finditer(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$(\w+)\['([^']+)'\][^)]*?\)\s*;", body):
        if regs.has(am.group(2)):
            regs.set(am.group(1), f"(({regs.get(am.group(2))}) as Record<string, unknown>)[{ts_str(am.group(3))}]")
    rm = re.search(r"return\s*\[(.*?)\]\s*;", body, re.S)
    if not rm:
        raise ExprCompileError('refund: no return')
    items = php_array_items(rm.group(1))
    if not items:
        raise ExprCompileError('refund: return items')
    d = dict(items)
    try:
        success_ts = compile_condition(d.get('success', 'false'), regs, consts)
    except ExprCompileError:
        success_ts = 'false'
    rid_ts = None
    try:
        rid_ts = simplify_ts(compile_expr(d.get('refund_id', "''"), regs, consts))
    except ExprCompileError:
        rid_ts = None
    lines.append(f'const ok = {success_ts};')
    if rid_ts:
        lines.append(f"return {{ success: ok, refund_id: ok ? String({rid_ts} ?? '') : undefined, error: ok ? undefined : 'refund_failed' }};")
    else:
        lines.append("return { success: ok, error: ok ? undefined : 'refund_failed' };")
    return lines


def generate_gateway(analysis, repo, out_dir):
    slug = analysis['slug']
    src = load_php(repo, slug)
    if src is None:
        return ('skip', slug, 'no php')
    src_nc = strip_comments(src)
    consts = extract_constants_full(src_nc)
    fx = FlowContext(consts)

    init_body = method_body(src_nc, 'initiate')
    verify_body = method_body(src_nc, 'verify')
    refund_body = method_body(src_nc, 'refund')
    webhook_body = method_body(src_nc, 'verifyWebhook')

    notes = []
    sim_stripped = False
    try:
        if has_sim_fallback(init_body or ''):
            sim_stripped = True
        init_lines, init_kind = compile_initiate(init_body, fx, slug, src_nc)
    except ExprCompileError as e:
        return ('flag', slug, f'initiate: {e}')

    # verify gets a FRESH registry (sharing consts/uses/token state) —
    # otherwise locals registered while compiling initiate suppress the
    # same-name declarations verify needs.
    fx.regs = VarRegistry(with_bases=True)
    try:
        verify_lines = compile_verify(verify_body, fx, slug, src_nc)
    except ExprCompileError as e:
        return ('flag', slug, f'verify: {e}')

    if sim_stripped:
        notes.append('sandbox "simulation" fallback (SIM_/uniqid fake success) stripped — API failure now throws')

    refund_kind = classify_refund(refund_body)
    refund_lines = None
    if refund_kind[0] == 'fake':
        notes.append('upstream refund is a simulation (no API call) — ported as refund_not_supported')
    elif refund_kind[0] == 'real':
        try:
            refund_lines = compile_refund_real(refund_body, fx, slug)
        except ExprCompileError as e:
            refund_kind = ('none',)
            notes.append(f'refund uncompilable ({e}) — omitted')

    wh_kind = classify_webhook(webhook_body)
    if wh_kind[0] in ('stub_true', 'header_presence'):
        notes.append('upstream webhook check was a stub/presence-only — ported fail-closed')
    wh_lines = compile_webhook(webhook_body, fx, slug, wh_kind[0])

    name = analysis['metadata'].get('name') or analysis['manifest'].get('name') or pascal(slug)
    currencies = analysis['currencies'] or []
    capabilities = ['verification']
    if refund_kind[0] == 'real':
        capabilities.append('refund')
    if wh_kind[0] in ('real_hmac', 'static_secret'):
        capabilities.append('webhook')

    kit_syms = [s for s in ('gwJson', 'queryString', 'buildAutoSubmitForm') if s in fx.uses]
    if fx.token_helper and fx.token_helper.get('name'):
        if 'gwJson' not in kit_syms:
            kit_syms.append('gwJson')
    lib_syms = [s for s in ('md5Hex', 'hmacHex', 'shaHex', 'timingSafeEqual') if s in fx.uses]

    cls = pascal(slug) + 'Gateway'
    out = []
    out.append('/**')
    out.append(f' * {name} gateway adapter — part of the EdgePay gateway suite.')
    out.append(' * GENERATED by scripts/port-gateways/generate.py — regenerate, do not hand-edit.')
    out.append(f' * Flow: {init_kind}.')
    for n in notes:
        out.append(f' * PORT-NOTE: {n}.')
    out.append(' */')
    out.append('')
    out.append("import {")
    out.append('  BaseGatewayAdapter,')
    out.append('  type GatewayMetadata,')
    out.append('  type GatewayField,')
    out.append('  type InitiateParams,')
    out.append('  type InitiateResult,')
    out.append('  type VerifyResult,')
    out.append('  type RefundResult,')
    out.append('  type Credentials,')
    out.append('  type GatewayContext,')
    out.append("} from '../base';")
    if kit_syms:
        if 'buildAutoSubmitForm' in kit_syms:
            http_syms = [s for s in kit_syms if s != 'buildAutoSubmitForm']
            if http_syms:
                out.append(f"import {{ {', '.join(http_syms)} }} from '../kit/http';")
            out.append("import { buildAutoSubmitForm } from '../kit/form';")
        else:
            out.append(f"import {{ {', '.join(kit_syms)} }} from '../kit/http';")
    if fx.token_helper and fx.token_helper.get('name'):
        out.append("import { TokenCache } from '../kit/token-cache';")
    if lib_syms:
        out.append(f"import {{ {', '.join(lib_syms)} }} from '../../lib/hash';")
    out.append('')

    const_names = list(consts.keys())
    for k, v in consts.items():
        out.append(f'const {k} = {ts_str(v)};')
    if const_names:
        out.append('')
    out.append(f'const SLUG = {ts_str(slug)};')
    out.append('')

    out.append(f'export class {cls} extends BaseGatewayAdapter {{')
    out.append('  metadata(): GatewayMetadata {')
    out.append('    return {')
    out.append(f'      name: {ts_str(name)},')
    out.append(f'      slug: {ts_str(slug)},')
    out.append("      version: '1.0.0',")
    out.append(f'      description: {ts_str((analysis["metadata"].get("description") or name).strip())},')
    out.append("      author: 'EdgePay Gateway Suite (AGPLv3)',")
    out.append("      type: 'gateway',")
    out.append(f'      supported_currencies: [{", ".join(ts_str(c) for c in currencies)}],')
    out.append(f'      capabilities: [{", ".join(ts_str(c) for c in capabilities)}],')
    out.append('    };')
    out.append('  }')
    out.append('')
    out.append('  fields(): GatewayField[] {')
    out.append('    return [')
    for f in analysis['fields']:
        req = 'true' if f.get('required', True) else 'false'
        ftype = f.get('type', 'text')
        if ftype in ('text', 'password', 'select', 'checkbox', 'textarea'):
            out.append(f"      {{ name: {ts_str(f['name'])}, label: {ts_str(f.get('label', f['name']))}, type: {ts_str(ftype)} as const, required: {req} }},")
        else:
            out.append(f"      {{ name: {ts_str(f['name'])}, label: {ts_str(f.get('label', f['name']))}, type: 'text' as const, required: {req} }},")
    out.append('    ];')
    out.append('  }')
    out.append('')
    out.append('  async initiate(params: InitiateParams, credentials: Credentials, _ctx?: GatewayContext): Promise<InitiateResult> {')
    for ln in init_lines:
        out.append('    ' + ln if ln else '')
    out.append('  }')
    out.append('')
    verify_uses_creds = any('credentials' in ln for ln in verify_lines)
    verify_param = 'credentials' if verify_uses_creds else '_credentials'
    out.append(f'  async verify(callbackData: Record<string, unknown>, {verify_param}: Credentials, _ctx?: GatewayContext): Promise<VerifyResult> {{')
    for ln in verify_lines:
        out.append('    ' + ln if ln else '')
    out.append('  }')
    out.append('')
    out.append('  async verifyWebhook(input: { rawBody: string; headers: Record<string, string>; credentials: Credentials }): Promise<boolean> {')
    for ln in wh_lines:
        out.append('    ' + ln if ln else '')
    out.append('  }')
    if fx.token_helper and fx.token_helper.get('name'):
        tok = extract_token_helper(src_nc, fx.token_helper['name'])
        out.append('')
        out.append('  private async getToken(baseUrl: string | undefined, credentials: Credentials, _ctx?: GatewayContext): Promise<string> {')
        if tok and tok['call'].get('url_expr'):
            tcall = tok['call']
            tregs = VarRegistry()
            tregs.set('baseUrl', 'baseUrl')
            for am in re.finditer(r"\$(\w+)\s*=\s*\$this->getString\(\s*\$credentials\['([^']+)'\][^)]*\)", method_body(src_nc, fx.token_helper['name']) or ''):
                tregs.set(am.group(1), f"credentials.{am.group(2)} ?? ''")
            try:
                t_url = simplify_ts(compile_expr(tcall['url_expr'], tregs, consts))
            except ExprCompileError:
                t_url = "String(baseUrl ?? '')"
            tok_path = tok['token_path']
            out.append('    // OAuth-style token grant, KV + isolate-memoized (55min TTL).')
            out.append('    const cache = new TokenCache(_ctx?.kv);')
            out.append('    const cacheKey = `token:__SLUG__:${String(baseUrl ?? \'\')}`;'.replace('__SLUG__', slug))
            out.append('    const cached = await cache.get(cacheKey);')
            out.append('    if (cached) return cached;')
            tok_headers = {}
            for h in tcall['headers']:
                hm = re.match(r'([^:]+):\s*(.*)', h, re.S)
                if hm:
                    hname, hval = hm.group(1).strip(), hm.group(2).strip()
                    if hval.startswith('$'):
                        try:
                            tok_headers[hname] = simplify_ts(compile_expr(hval, tregs, consts))
                        except ExprCompileError:
                            pass
                    else:
                        tok_headers[hname] = ts_str(hval)
            tok_body_arg = ''
            if tok['body_items']:
                entries = ', '.join(f"[{ts_str(k)}]: {simplify_ts(compile_expr(v, tregs, consts))}" for k, v in tok['body_items'])
                out.append(f'    const payload: Record<string, unknown> = {{ {entries} }};')
                tok_body_arg = 'body: JSON.stringify(payload),'
            out.append('    const res = await gwJson({')
            out.append(f'      url: {t_url},')
            out.append("      method: 'POST',")
            if tok_headers:
                out.append('      headers: { ' + ', '.join(f'[{ts_str(k)}]: {v}' for k, v in tok_headers.items()) + ' },')
            if tok_body_arg:
                out.append(f'      {tok_body_arg}')
            out.append('      timeoutMs: 15000,')
            out.append('    });')
            out.append("    if (res.data === null) return '';")
            out.append(f'    const token = String((res.data as Record<string, unknown>)[{ts_str(tok_path)}] ?? \'\');')
            out.append("    if (token !== '') await cache.put(cacheKey, token, 3300);")
            out.append('    return token;')
            out.append('  }')
        else:
            out.append("    return ''; // PORT-REVIEW: token helper not extracted")
            out.append('  }')
    if refund_kind[0] == 'real' and refund_lines:
        out.append('')
        out.append('  async refund(gatewayTrxId: string, amount: string, credentials: Credentials, _ctx?: GatewayContext): Promise<RefundResult> {')
        for ln in refund_lines:
            out.append('    ' + ln if ln else '')
        out.append('  }')
    elif refund_kind[0] == 'fake':
        out.append('')
        out.append('  // PORT-SECURITY: upstream PHP faked refund success without any')
        out.append('  // provider API call. A fake refund ID would post ledger entries for')
        out.append('  // money that never moved — this port reports refund_not_supported.')
        out.append('  async refund(_gatewayTrxId: string, _amount: string, _credentials: Credentials): Promise<RefundResult> {')
        out.append("    return { success: false, error: 'refund_not_supported' };")
        out.append('  }')
    out.append('}')
    out.append('')

    with open(os.path.join(out_dir, f'{slug}.gateway.ts'), 'w') as f:
        f.write('\n'.join(out))
    return ('ok', slug, init_kind)


def main():
    analysis_path, repo, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out_dir, exist_ok=True)
    data = json.load(open(analysis_path))

    SKIP = {
        'stripe', 'paypal-checkout', 'bkash-api', 'razorpay', 'nagad-merchant-api',
        'rocket', 'sslcommerz', 'aamarpay', 'alipay', 'paytm', 'trustly', 'cashmaal',
    }

    ok, flagged, skipped = [], [], []
    for analysis in data:
        if analysis['slug'] in SKIP:
            skipped.append(analysis['slug'])
            continue
        status, slug, info = generate_gateway(analysis, repo, out_dir)
        if status == 'ok':
            ok.append((slug, info))
        elif status == 'flag':
            flagged.append((slug, info))
        else:
            skipped.append(f'{slug}({info})')

    print(f'generated: {len(ok)}  flagged: {len(flagged)}  skipped: {len(skipped)}')
    for slug, info in sorted(flagged):
        print(f'  FLAG {slug}: {info}')

    ok_sorted = sorted(ok, key=lambda x: x[0])
    lines = []
    lines.append('/**')
    lines.append(' * Generated gateway adapters — GENERATED FILE (scripts/port-gateways/generate.py).')
    lines.append(' * One lazy factory per ported provider. Do not edit; regenerate.')
    lines.append(' */')
    lines.append('')
    lines.append("import { gatewayRegistry } from '../base';")
    for slug, _ in ok_sorted:
        lines.append(f"import {{ {pascal(slug)}Gateway }} from './{slug}.gateway';")
    lines.append('')
    lines.append('/** Registry slugs of every adapter produced by the port pipeline. */')
    lines.append('export const GENERATED_GATEWAY_SLUGS = [')
    for slug, _ in ok_sorted:
        lines.append(f"  '{slug}',")
    lines.append('] as const;')
    lines.append('')
    for slug, _ in ok_sorted:
        lines.append(f"gatewayRegistry.register('{slug}', () => new {pascal(slug)}Gateway());")
    lines.append('')
    with open(os.path.join(out_dir, 'index.ts'), 'w') as f:
        f.write('\n'.join(lines))
    print(f'index.ts: {len(ok)} registrations')


if __name__ == '__main__':
    main()
