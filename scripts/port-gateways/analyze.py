#!/usr/bin/env python3
"""
Upstream PHP gateway-plugin repo (PHP) → EdgePay-CF (TS) port analyzer.

Reads every gateway module in the cloned plugin repo and extracts a
structured description of each adapter: manifest, constants, credential
fields, curl call shapes, response reads, success conditions, hash usage,
token-grant presence. Emits analysis.json + a human-readable report.

The PHP modules are template-generated (identical docblocks and guard
patterns), so structure is highly regular. Each file gets:
  - a structure_signature (fingerprint of methods + call shapes)
  - a confidence score (how completely the flow was extracted)
  - flags for anything needing hand-porting

Usage: python3 analyze.py <plugin_repo_dir> <output_json> [report_txt]
"""

import json
import os
import re
import sys
from collections import Counter, defaultdict

# --------------------------------------------------------------- helpers

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


def main():
    repo_dir = sys.argv[1]
    out_json = sys.argv[2]
    report_path = sys.argv[3] if len(sys.argv) > 3 else None

    results = []
    for entry in sorted(os.listdir(repo_dir)):
        dirpath = os.path.join(repo_dir, entry)
        if os.path.isdir(dirpath) and not entry.startswith('.'):
            r = analyze_gateway(dirpath)
            if r:
                results.append(r)

    # stats
    sig_counter = Counter(r['structure_signature'] for r in results)
    flag_counter = Counter(f for r in results for f in r['flags'])
    cat_counter = Counter(r['manifest'].get('category', '?') for r in results)

    report_lines = []
    report_lines.append(f"Analyzed {len(results)} gateway modules")
    report_lines.append(f"\nCategories: {dict(cat_counter.most_common())}")
    report_lines.append(f"\nStructure signatures ({len(sig_counter)} distinct):")
    for sig, n in sig_counter.most_common():
        report_lines.append(f"  {n:3d}  {sig}")
    report_lines.append(f"\nFlags: {dict(flag_counter.most_common())}")

    low_conf = [r for r in results if r['confidence'] < 0.7]
    report_lines.append(f"\nLow-confidence (<0.7): {len(low_conf)}")
    for r in sorted(low_conf, key=lambda x: x['confidence']):
        report_lines.append(f"  {r['confidence']:.2f}  {r['slug']:28s} {','.join(r['flags'])}")

    # webhook stubs + md5 + token grant lists
    report_lines.append("\nWebhook return-true stubs: " + ', '.join(r['slug'] for r in results if r['webhook_stub_true']))
    report_lines.append("MD5 users: " + ', '.join(r['slug'] for r in results if 'md5' in r['hash_usage']))
    report_lines.append("Token-grant flows: " + ', '.join(r['slug'] for r in results if r['has_token_grant']))
    report_lines.append("RSA signatures: " + ', '.join(r['slug'] for r in results if any(u.startswith('openssl') for u in r['hash_usage'])))
    report_lines.append("Refund implemented: " + str(sum(1 for r in results if r['has_refund'])))

    with open(out_json, 'w') as f:
        json.dump(results, f, indent=1)

    report = '\n'.join(report_lines)
    print(report)
    if report_path:
        with open(report_path, 'w') as f:
            f.write(report + '\n')


if __name__ == '__main__':
    main()
