#!/usr/bin/env python3
"""Scan a Go repo for long-term Alibaba Cloud AK/SK usage and cloud-SDK credential
construction points, to plan IDaaS AK-less refactoring. Stdlib only.

Covers two layers:
1. .go sources (comments stripped, dependency/build dirs pruned): AK literals,
   struct-field/setter hardcoding, oss.New with AK args, env reads, manual STS,
   SDK imports, existing IDaaS integration.
2. Repo-wide non-code sweep (yaml/json/toml/properties/.env/sh/Dockerfile/CI...):
   literal AKs and plaintext secret assignments.

Usage: python3 scan_ak_usage.py --repo <root> [--lang go] [--json]
Output: JSON report, findings per file plus '_project', '_config', '_errors',
and '_scan_complete'. Read failures are structured errors and exit with code 1.
"""
import os
import re
import json
import sys

SKIP_DIRS = {".git", "vendor", "testdata", "node_modules", "skill-build",
             "build", "dist", "bin", "out", ".idea", ".vscode"}

RE_AK_KWARG = re.compile(r'(?:AccessKeyId|AccessKeySecret|AccessKeyID|SecretKey|SecretId)\s*:\s*"[^"]+"')
# SDK v2 style setters: .WithAccessKeyId("...") / .WithAccessKeySecret("...")
RE_AK_SETTER = re.compile(r'\.With(?:AccessKeyId|AccessKeySecret)\s*\(\s*"[^"]+"\s*\)')

# OSS V1 patterns - oss.New(endpoint, ak, sk, ...) with non-empty ak/sk
RE_OSS_NEW = re.compile(r'\boss\s*\.\s*New\s*\(')

# Environment variable patterns
RE_ENV_AK = re.compile(r'\bos\s*\.\s*(?:Getenv|LookupEnv)\s*\(\s*"(?:ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET|ACCESS_KEY_ID|ACCESS_KEY_SECRET|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET)"\s*\)')

# Manual STS patterns
RE_MANUAL_STS = re.compile(r'\bAssumeRole(?:WithOIDC|WithSAML)?(?:Request)?\b')

# SDK import patterns
RE_IMPORT_OSS1 = re.compile(r'"github\.com/aliyun/aliyun-oss-go-sdk/oss"')
RE_IMPORT_OSS2 = re.compile(r'"github\.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"')
RE_IMPORT_SLS = re.compile(r'"github\.com/aliyun/aliyun-log-go-sdk"')
RE_IMPORT_OPENAPI = re.compile(r'"github\.com/aliyun/alibaba-cloud-sdk-go/sdk"')
# credentials-go：通用凭证库，被 darabonba 新一代 OpenAPI 客户端消费（akless 通用适配器对接的接口来源）
RE_IMPORT_CREDENTIALS_GO = re.compile(r'"github\.com/aliyun/credentials-go(?:/[^"]*)?"')
# Product clients and the OpenAPI client base, excluding Tea/utility packages.
RE_IMPORT_DARABONBA = re.compile(
    r'"github\.com/alibabacloud-go/(?:[a-zA-Z0-9-]+-[0-9]{8}|darabonba-openapi)'
    r'(?:/v[0-9]+)?/client"')

# IDaaS integration patterns
RE_IDAAS_INIT = re.compile(r'factory\.GetInstance\(\)\.Initialize\s*\(')
RE_IDAAS_FACTORY_IMPORT = re.compile(
    r'(?:\bimport\s+(?:\(\s*)?|(?m:^[ \t]*))(?:(\w+)\s+)?'
    r'"github\.com/cloud-idaas/idaas-go-core-sdk/factory"')
IDAAS_INIT_METHOD = (r'(?:Init(?:WithConfig)?\s*\('
                     r'|GetInstance\s*\(\s*\)\s*\.\s*Initialize\s*\()')
RE_IDAAS_PROVIDER = re.compile(
    r'\bpam\s*\.\s*(?:Get(?:AlibabaCloud|OSSV1|OSSV2|SLS)CredentialsProvider'
    r'|NewIDaaSPam(?:AlibabaCloud|OSSV1|OSSV2|SLS)CredentialsProvider)\s*\('
)

# Helpers are maintained within this skill for standalone installation.
from akless_common import RE_AK_LITERAL, strip_comments, iter_code_units, iter_call_arguments, scan_config_file
from akless_common import iter_repo_files, is_test_source, iter_config_files as _iter_config_files
from akless_common import iter_additional_auth_findings


def has_idaas_initialization(content):
    """Recognize public SDK initializers with their file-local import binding."""
    code = strip_comments(content)
    bindings = RE_IDAAS_FACTORY_IMPORT.findall(code)
    if not bindings:
        # Retain recognition of existing legacy snippets without import context.
        return bool(RE_IDAAS_INIT.search(code))
    return any(alias != '_' and re.search(
        r'\b' + re.escape(alias or 'factory') + r'\s*\.\s*' + IDAAS_INIT_METHOD, code)
        for alias in bindings)


def has_idaas_provider_call(content):
    code = strip_comments(content)
    bindings = re.findall(
        r'(?:\bimport\s+(?:\(\s*)?|(?m:^[ \t]*))(?:(\w+)\s+)?'
        r'"github\.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"', code)
    names = [alias or 'pam' for alias in bindings if alias != '_'] if bindings else ['pam']
    return any(re.search(RE_IDAAS_PROVIDER.pattern.replace(r'\bpam', r'\b' + re.escape(name)), code)
               for name in names)


def sls_factory_pattern(content):
    bindings = re.findall(
        r'(?:\bimport\s+(?:\(\s*)?|(?m:^[ \t]*))(?:(\w+)\s+)?'
        r'"github\.com/aliyun/aliyun-log-go-sdk"', strip_comments(content))
    names = [alias or 'sls' for alias in bindings if alias != '_']
    return re.compile(r'\b(?:' + '|'.join(map(re.escape, names)) + r')\s*\.\s*'
                      r'(?:CreateNormalInterface|NewStaticCredentialsProvider)\s*\(') if names else re.compile(r'(?!)')


def oss_package_names(content):
    """Resolve file-local OSS import names, preserving legacy snippet support."""
    code = strip_comments(content)
    bindings = re.findall(
        r'(?:\bimport\s+(?:\(\s*)?|(?m:^[ \t]*))(?:(\w+)\s+)?'
        r'"github\.com/aliyun/aliyun-oss-go-sdk/oss"', code)
    return [name or 'oss' for name in bindings if name != '_'] if bindings else ['oss']


def has_oss_static_auth(code, package_names=('oss',)):
    if not package_names:
        return False
    callee = re.compile(r'\b(?:' + '|'.join(re.escape(n) for n in package_names) + r')\s*\.\s*New\s*\(')
    for args in iter_call_arguments(code, callee):
        if len(args) >= 3 and any(arg not in ('""', '``') for arg in args[1:3]):
            return True
    return False


def iter_auth_warnings(content):
    """Surface credential-shaped expressions without claiming their origin."""
    field = re.compile(r'\b(?:AccessKeyId|AccessKeyID|AccessKeySecret|SecretKey|SecretId)\s*:\s*([^,}\r\n]+)')
    setter = re.compile(r'\.\s*With(?:AccessKeyId|AccessKeySecret)\s*\(')
    literal = re.compile(r'(?:"(?:\\.|[^"\\])*"|`[^`]*`)\Z')
    for line, code in iter_code_units(content):
        if any(not m.group(1).strip().startswith(('"', '`')) for m in field.finditer(code)):
            yield {'line': line, 'kind': 'ak_field_suspect', 'severity': 'warning'}
        if any(len(args) == 1 and not literal.fullmatch(args[0])
               for args in iter_call_arguments(code, setter)):
            yield {'line': line, 'kind': 'ak_setter_suspect', 'severity': 'warning'}


def iter_config_files(root, read_errors=None):
    return _iter_config_files(root, SKIP_DIRS, read_errors)


def iter_go_files(root, read_errors=None):
    """Iterate over source files and surface directory traversal failures."""
    for filepath in iter_repo_files(root, SKIP_DIRS, read_errors):
        if filepath.endswith(".go"):
            yield filepath


def scan_file(filepath):
    """Scan a single Go file for AK/SK usage patterns."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except (IOError, OSError) as e:
        print(f"Warning: Failed to read {filepath}: {e}", file=sys.stderr)
        return None

    result = {
        'ak_literals': [],
        'ak_kwargs': [],
        'ak_setters': [],
        'oss_new_ak': [],
        'env_ak': [],
        'manual_sts': [],
        'sdk_imports': [],
        'idaas_init': has_idaas_initialization(content),
        'idaas_provider': has_idaas_provider_call(content),
        'auth_warnings': list(iter_auth_warnings(content)),
        'auth_findings': list(iter_additional_auth_findings(content, 'go')),
    }
    oss_names = oss_package_names(content)
    sls_factory = sls_factory_pattern(content)

    for line_no, code_portion in iter_code_units(content):
        if not code_portion.strip():
            continue

        if sls_factory.search(code_portion):
            result['auth_warnings'].append({'line': line_no, 'kind': 'sls_static_auth', 'severity': 'warning'})

        # Check patterns on code portion
        if RE_AK_LITERAL.search(code_portion):
            result['ak_literals'].append(line_no)
        if RE_AK_KWARG.search(code_portion):
            result['ak_kwargs'].append(line_no)
        if RE_AK_SETTER.search(code_portion):
            result['ak_setters'].append(line_no)
        if has_oss_static_auth(code_portion, oss_names):
            result['oss_new_ak'].append(line_no)
        if RE_ENV_AK.search(code_portion):
            result['env_ak'].append(line_no)
        if RE_MANUAL_STS.search(code_portion):
            result['manual_sts'].append(line_no)

        # Check SDK imports
        if RE_IMPORT_OSS1.search(code_portion):
            result['sdk_imports'].append('oss_v1')
        if RE_IMPORT_OSS2.search(code_portion):
            result['sdk_imports'].append('oss_v2')
        if RE_IMPORT_SLS.search(code_portion):
            result['sdk_imports'].append('sls')
        if RE_IMPORT_OPENAPI.search(code_portion):
            result['sdk_imports'].append('openapi')
        if RE_IMPORT_CREDENTIALS_GO.search(code_portion):
            result['sdk_imports'].append('credentials_go')
        if RE_IMPORT_DARABONBA.search(code_portion):
            result['sdk_imports'].append('darabonba')

    return result


def scan_directory(root_dir):
    """Scan all Go files plus non-code configs in directory."""
    results = {}
    project_has_init = False
    project_has_provider = False
    read_errors = []

    for filepath in iter_go_files(root_dir, read_errors):
        rel_path = os.path.relpath(filepath, root_dir)

        file_result = scan_file(filepath)
        if file_result is None:
            read_errors.append({'file': rel_path, 'line': 0, 'kind': 'read_error',
                                'text': 'Source could not be read; scan incomplete'})
            continue
        results[rel_path] = file_result

        if file_result['idaas_init'] and not is_test_source(filepath, root_dir):
            project_has_init = True
        if file_result['idaas_provider'] and not is_test_source(filepath, root_dir):
            project_has_provider = True

    config_hits = []
    for fp in iter_config_files(root_dir, read_errors):
        for hit in scan_config_file(fp, root_dir):
            (read_errors if hit['kind'] == 'read_error' else config_hits).append(hit)

    results['_project'] = {
        'has_idaas_init': project_has_init,
        'has_idaas_provider': project_has_provider,
    }
    results['_config'] = config_hits
    results['_errors'] = read_errors
    results['_scan_complete'] = not read_errors

    return results


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--lang", default="go", choices=["go"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    root_dir = args.repo

    if not os.path.isdir(root_dir):
        print(f"Error: {root_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    results = scan_directory(root_dir)

    read_errors = results['_errors']
    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        # Human-readable output
        project = results.pop('_project', {})
        config_hits = results.pop('_config', [])
        results.pop('_errors', None)
        results.pop('_scan_complete', None)
        print(f"Scanned {len(results)} Go files")
        print(f"Project IDaaS status: init={project.get('has_idaas_init', False)}, provider={project.get('has_idaas_provider', False)}")
        print()

        for filepath, data in sorted(results.items()):
            issues = [f"{h['kind']} ({h['severity']}): line {h['line']}"
                      for h in data['auth_warnings'] + data['auth_findings']]
            if data['ak_literals']:
                issues.append(f"AK literals: {data['ak_literals']}")
            if data['ak_kwargs']:
                issues.append(f"AK kwargs: {data['ak_kwargs']}")
            if data.get('ak_setters'):
                issues.append(f"AK setters: {data['ak_setters']}")
            if data['oss_new_ak']:
                issues.append(f"OSS V1 with AK: {data['oss_new_ak']}")
            if data['env_ak']:
                issues.append(f"Env AK: {data['env_ak']}")
            if data['manual_sts']:
                issues.append(f"Manual STS: {data['manual_sts']}")

            if issues or data['sdk_imports']:
                print(f"{filepath}:")
                if data['sdk_imports']:
                    print(f"  SDK imports: {', '.join(set(data['sdk_imports']))}")
                for issue in issues:
                    print(f"  {issue}")
                if data['idaas_init']:
                    print(f"  ✓ IDaaS init")
                if data['idaas_provider']:
                    print(f"  ✓ IDaaS provider")
                print()

        if config_hits:
            print(f"Config-file credential findings ({len(config_hits)}):")
            for h in config_hits:
                print(f"  {h['file']}:{h['line']} [{h['kind']}] {h['text']}")
            print()

    if read_errors:
        if not args.json:
            for error in read_errors:
                print(f"{error['file']} [read_error] {error['text']}")
        sys.exit(1)


if __name__ == '__main__':
    main()
