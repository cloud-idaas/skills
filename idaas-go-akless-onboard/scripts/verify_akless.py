#!/usr/bin/env python3
"""Verify that Go code has been properly migrated to IDaaS akless authentication.

Blocking violations (exit code 1):
- Source/configuration read failures (verification is incomplete)
- AK/SK literals or hardcoded struct fields / WithAccessKeyId setters
- oss.New(...) still constructed with AK/SK arguments
- Environment variable reads for AK/SK
- Files using cloud SDKs while the project has no real (non-comment) IDaaS init/provider
- Literal AK/SK or plaintext secrets left in non-code config files (yaml/env/CI/...)

Warnings (review manually, do not fail the gate):
- Residual manual STS / AssumeRole code
- Suspected caching of short-term credentials (SKILL forbids it)
- Suspected inline credentials in YAML env lists (names/values need manual review)

Usage: python3 verify_akless.py --repo <root> [--lang go] [--json]
Output: JSON report {violations, warnings, ok, ...}. Exit 0 iff no blocking violations.
"""
import os
import re
import json
import sys

# Import patterns from scan script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from akless_common import is_test_source, iter_additional_auth_findings
from scan_ak_usage import (
    iter_go_files,
    iter_config_files,
    scan_config_file,
    strip_comments,
    iter_code_units,
    RE_AK_LITERAL,
    RE_AK_KWARG,
    RE_AK_SETTER,
    has_oss_static_auth,
    oss_package_names,
    iter_auth_warnings,
    RE_ENV_AK,
    RE_MANUAL_STS,
    RE_IMPORT_OSS1,
    RE_IMPORT_OSS2,
    RE_IMPORT_SLS,
    RE_IMPORT_OPENAPI,
    RE_IMPORT_CREDENTIALS_GO,
    RE_IMPORT_DARABONBA,
    has_idaas_initialization,
    RE_IDAAS_PROVIDER,
    has_idaas_provider_call,
    sls_factory_pattern,
)

# Suspected credential caching: GetCredential() result stored into a package-level
# var, a struct/interface field, or a cache-named variable. Fetching into a plain
# local per use is the sanctioned pattern and is NOT flagged.
RE_CRED_CACHE = re.compile(r"""(?ix)
(?:
    \bvar\s+[\w\s,*.]+\s*=?\s*[\w.]*\.GetCredential\s*\(\s*\)
  | \b[\w.]+\.[\w]+\s*=\s*[\w.]*\.GetCredential\s*\(\s*\)
  | [,{]\s*\w+\s*:\s*[\w.]*\.GetCredential\s*\(\s*\)
  | \b\w*(?:cached|cache|saved|stored|global|persist)\w*\s*(?::=|=)\s*[\w.]*\.GetCredential\s*\(\s*\)
)""")


def verify_file(filepath, root_dir, project_has_init, project_has_provider):
    """Verify a single Go file for akless compliance."""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except (IOError, OSError) as e:
        print(f"Warning: Failed to read {filepath}: {e}", file=sys.stderr)
        return [{
            'file': os.path.relpath(filepath, root_dir), 'line': 0,
            'type': 'source_read_error', 'severity': 'blocking',
            'message': 'Source could not be read; verification incomplete'
        }], False, False, False

    violations = []
    rel_path = os.path.relpath(filepath, root_dir)

    has_cloud_sdk = False
    has_idaas_init = has_idaas_initialization(content)
    has_idaas_provider = has_idaas_provider_call(content)
    oss_names = oss_package_names(content)
    sls_factory = sls_factory_pattern(content)
    for finding in iter_additional_auth_findings(content, 'go'):
        violations.append(dict(file=rel_path, line=finding['line'], type=finding['kind'],
                               severity=finding['severity'],
                               message='Cloud credential constructor/signing path requires migration or review [REDACTED]'))
    for finding in iter_auth_warnings(content):
        violations.append({'file': rel_path, 'line': finding['line'],
                           'type': finding['kind'], 'severity': 'warning',
                           'message': 'Credential-shaped expression requires provider/source review: [REDACTED]'})

    for line_no, code_portion in iter_code_units(content):
        if not code_portion.strip():
            continue

        if sls_factory.search(code_portion):
            violations.append(dict(file=rel_path, line=line_no, type="sls_static_auth",
                                   severity="blocking", message="SLS static credential factory must be migrated [REDACTED]"))

        # Check for AK/SK violations
        if RE_AK_LITERAL.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'ak_literal',
                'severity': 'blocking',
                'message': f'AK/SK literal found: [REDACTED]'
            })

        if RE_AK_KWARG.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'ak_kwarg',
                'severity': 'blocking',
                'message': f'AK/SK in struct field: [REDACTED]'
            })

        if RE_AK_SETTER.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'ak_setter',
                'severity': 'blocking',
                'message': f'AK/SK passed via SDK setter: [REDACTED]'
            })

        if has_oss_static_auth(code_portion, oss_names):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'oss_new_ak',
                'severity': 'blocking',
                'message': f'OSS V1 client created with AK/SK: [REDACTED]'
            })

        if RE_ENV_AK.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'env_ak',
                'severity': 'blocking',
                'message': f'AK/SK read from environment: [REDACTED]'
            })

        # Manual STS residue and credential caching are warnings (need human review)
        if RE_MANUAL_STS.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'manual_sts',
                'severity': 'warning',
                'message': f'Manual STS/AssumeRole residue, should be removed by migration (review): [REDACTED]'
            })

        if RE_CRED_CACHE.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'cred_cache_suspect',
                'severity': 'warning',
                'message': f'Suspected caching of short-term credential, must fetch per use: [REDACTED]'
            })

        # Check for SDK imports (on code portion, not raw line: commented imports don't count)
        if RE_IMPORT_OSS1.search(code_portion) or RE_IMPORT_OSS2.search(code_portion) or \
           RE_IMPORT_SLS.search(code_portion) or RE_IMPORT_OPENAPI.search(code_portion) or \
           RE_IMPORT_CREDENTIALS_GO.search(code_portion) or RE_IMPORT_DARABONBA.search(code_portion):
            has_cloud_sdk = True

        # Check for IDaaS integration

    # Check if file uses cloud SDK but lacks IDaaS integration
    if has_cloud_sdk:
        if not has_idaas_init and not project_has_init:
            violations.append({
                'file': rel_path,
                'line': 0,
                'type': 'missing_idaas_init',
                'severity': 'blocking',
                'message': 'File uses cloud SDK but IDaaS init not found (neither in file nor project)'
            })

        if not has_idaas_provider and not project_has_provider:
            violations.append({
                'file': rel_path,
                'line': 0,
                'type': 'missing_idaas_provider',
                'severity': 'blocking',
                'message': 'File uses cloud SDK but IDaaS provider not found (neither in file nor project)'
            })

    return violations, has_cloud_sdk, has_idaas_init, has_idaas_provider


def verify_directory(root_dir):
    """Verify all Go files plus non-code configs in directory."""
    all_violations = []
    files_with_cloud_sdk = 0
    files_with_idaas_init = 0
    files_with_idaas_provider = 0
    total_files = 0

    read_errors = []
    source_files = list(iter_go_files(root_dir, read_errors))

    # First pass: project-level IDaaS integration, judged on comment-stripped code
    # only (a doc comment must not make the whole project "already onboarded").
    project_has_init = False
    project_has_provider = False
    for filepath in source_files:
        if is_test_source(filepath, root_dir):
            continue
        try:
            with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
                code = strip_comments(f.read())
        except (IOError, OSError) as e:
            print(f"Warning: Failed to read {filepath}: {e}", file=sys.stderr)
            continue
        if has_idaas_initialization(code):
            project_has_init = True
        if has_idaas_provider_call(code):
            project_has_provider = True

    # Second pass: verify each file
    for filepath in source_files:
        total_files += 1
        violations, has_cloud_sdk, has_idaas_init, has_idaas_provider = verify_file(
            filepath, root_dir, project_has_init, project_has_provider
        )
        all_violations.extend(violations)

        if has_cloud_sdk:
            files_with_cloud_sdk += 1
        if has_idaas_init:
            files_with_idaas_init += 1
        if has_idaas_provider:
            files_with_idaas_provider += 1

    # Third pass: non-code config sweep (checklist promises no long-term AK in
    # code, config, images and CI). Literal AKs and plaintext secrets are blocking.
    for fp in iter_config_files(root_dir, read_errors):
        for h in scan_config_file(fp, root_dir):
            vtype = {'ak_literal': 'ak_literal_config', 'read_error': 'config_read_error',
                     'k8s_env_credential_suspect': 'k8s_env_credential_suspect'}.get(h['kind'], 'config_secret')
            all_violations.append({
                'file': h['file'],
                'line': h['line'],
                'type': vtype,
                'severity': h.get('severity', 'blocking'),
                'message': h['text'] if h['kind'] in ('read_error', 'k8s_env_credential_suspect') else 'Long-term AK/SK found in non-code file: [REDACTED]'
            })

    for error in read_errors:
        all_violations.append({
            'file': error['file'], 'line': 0, 'type': 'directory_read_error',
            'severity': 'blocking', 'message': error['text']
        })

    blocking = [v for v in all_violations if v.get('severity', 'blocking') != 'warning']
    warnings = [v for v in all_violations if v.get('severity') == 'warning']
    return {
        'total_files': total_files,
        'files_with_cloud_sdk': files_with_cloud_sdk,
        'files_with_idaas_init': files_with_idaas_init,
        'files_with_idaas_provider': files_with_idaas_provider,
        'project_has_idaas_init': project_has_init,
        'project_has_idaas_provider': project_has_provider,
        'violations': blocking,
        'warnings': warnings,
        'ok': len(blocking) == 0,
        'passed': len(blocking) == 0,
    }


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--lang", default="go", choices=["go"])
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    root_dir = args.repo
    output_json = args.json

    if not os.path.isdir(root_dir):
        print(f"Error: {root_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    result = verify_directory(root_dir)

    if output_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        # Human-readable output
        print(f"Verified {result['total_files']} Go files")
        print(f"Files with cloud SDK: {result['files_with_cloud_sdk']}")
        print(f"Files with IDaaS init: {result['files_with_idaas_init']}")
        print(f"Files with IDaaS provider: {result['files_with_idaas_provider']}")
        print(f"Project has IDaaS init: {result['project_has_idaas_init']}")
        print(f"Project has IDaaS provider: {result['project_has_idaas_provider']}")
        print()

        if result['violations']:
            print(f"Found {len(result['violations'])} blocking violations:")
            for v in result['violations']:
                if v['line'] > 0:
                    print(f"  {v['file']}:{v['line']} [{v['type']}] {v['message']}")
                else:
                    print(f"  {v['file']} [{v['type']}] {v['message']}")
        if result['warnings']:
            print(f"Found {len(result['warnings'])} warnings (non-blocking, review manually):")
            for v in result['warnings']:
                print(f"  {v['file']}:{v['line']} [{v['type']}] {v['message']}")
        if not result['violations'] and not result['warnings']:
            print("✓ No violations found - code is akless compliant!")

        print()
        print(f"Result: {'PASS' if result['passed'] else 'FAIL'}")

    sys.exit(0 if result['passed'] else 1)


if __name__ == '__main__':
    main()
