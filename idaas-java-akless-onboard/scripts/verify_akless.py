#!/usr/bin/env python3
"""Verify that Java code has been properly migrated to IDaaS akless authentication.

Blocking violations (exit code 1):
- Source/configuration read failures (verification is incomplete)
- AK/SK literals or hardcoded constructor auth with literal AK args
  (build(endpoint, "LTAI...", "secret") / build(endpoint, ak, sk))
- Environment variable reads for AK/SK
- Files using cloud SDKs while the project has no real (non-comment) IDaaS init/provider
- Literal AK/SK or plaintext secrets left in non-code config files (application.yml, CI...)

Warnings (review manually, do not fail the gate):
- Constructor hits whose arguments are neither string literals nor credential-named
  variables — the legal migrated form build(endpoint, provider, clientConfiguration)
  is shape-identical to a legacy call without parsing, so it must not block delivery
- Residual manual STS / AssumeRole code
- Suspected caching of short-term credentials (SKILL forbids it)
- Suspected inline credentials in YAML env lists (names/values need manual review)
- Non-Alibaba-Cloud static credentials (Tencent COS / AWS) — out of this migration's scope

Usage: python3 verify_akless.py --repo <root> [--lang java] [--json]
Output: JSON report {violations, warnings, ok, ...}. Exit 0 iff no blocking violations.
"""
import os
import re
import json
import sys

# Import patterns from scan script
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from akless_common import is_test_source
from scan_ak_usage import (
    iter_java_files,
    iter_config_files,
    scan_config_file,
    strip_comments,
    iter_code_units,
    RE_AK_LITERAL,
    RE_DEFAULT_PROFILE,
    has_default_profile_static_auth,
    iter_auth_warnings,
    RE_OSS_V1_BUILD,
    oss_auth_pattern,
    RE_OSS_V2_CONFIG,
    sls_constructor_pattern,
    has_sls_static_auth,
    RE_AK_SETTER,
    RE_TENCENT_CRED,
    RE_COS_CRED,
    RE_AWS_STATIC,
    RE_ENV_AK,
    RE_MANUAL_STS,
    RE_IMPORT_OSS1,
    RE_IMPORT_OSS2,
    RE_IMPORT_SLS,
    RE_IMPORT_OPENAPI,
    RE_IMPORT_CREDENTIALS_JAVA,
    RE_IMPORT_TEAOPENAPI,
    RE_IDAAS_INIT,
    RE_IDAAS_PROVIDER,
)

from akless_common import iter_call_arguments, iter_additional_auth_findings

# Non-alibabacloud credential constructors are surfaced for review but must not
# block an Alibaba Cloud akless migration.
WARN_TYPES = {"tencent_cred", "cos_cred", "aws_static"}

# Identifiers that clearly denote long-term credentials (provider-shaped names don't).
RE_CRED_NAME = re.compile(r"(?i)(?:[\w$]+\s*\.\s*)*(?:get)?(?:access_?key(?:_?(?:id|secret))?|secret_?key|secret|ak|sk|security_?token|token)\s*(?:\(\s*\))?")
RE_OSS_BUILD_CALL = re.compile(r'\bOSSClientBuilder\s*\(\s*\)\s*\.\s*build\s*\(')
RE_STRING_LITERAL = re.compile(r'"(?:[^"\\]|\\.)*"\Z')

# Suspected credential caching: getCredentials() result stored into a field, a
# constant/static slot, or a cache-named variable. Fetching per use is sanctioned.
RE_CRED_CACHE = re.compile(r"""(?ix)
(?:
    \bthis\.[\w$]+\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | \b[\w$]+\.[\w$]+\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | \b(?-i:[A-Z][A-Z0-9_$]{2,})\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | \bstatic\s+[\w<>.$?]+\s+[\w$]+\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | (?:^|[;{}])\s*[\w$]+\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | \b(?:private|protected|public)\s+(?:(?:final|volatile|transient)\s+)*[\w<>.$?]+\s+[\w$]+\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
  | \b\w*(?:cached|cache|saved|stored|global|persist)\w*\s*=\s*[\w.$]*\.getCredentials\s*\(\s*\)
)""")



def ctor_severity(code_portion, ctor_type, oss_pattern=RE_OSS_BUILD_CALL):
    """Only explicit credential arguments block ambiguous OSS overloads."""
    if ctor_type != 'oss_v1_build':
        # Other patterns identify credential use; profile overloads were filtered
        # by their balanced argument count before reaching this function.
        return 'blocking'
    for args in iter_call_arguments(code_portion, oss_pattern):
        if len(args) < 3:
            continue
        credentials = args[1:3]
        if all(RE_STRING_LITERAL.fullmatch(arg) for arg in credentials):
            return 'blocking'
        if any(RE_CRED_NAME.fullmatch(arg) for arg in credentials):
            return 'blocking'
    return 'warning'


def verify_file(filepath, root_dir, project_has_init, project_has_provider):
    """Verify a single Java file for akless compliance."""
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

    sls_call = sls_constructor_pattern(content)
    oss_call = oss_auth_pattern(content)
    has_cloud_sdk = False
    has_idaas_init = False
    has_idaas_provider = False
    for finding in iter_additional_auth_findings(content, 'java'):
        violations.append(dict(file=rel_path, line=finding['line'], type=finding['kind'],
                               severity=finding['severity'],
                               message='Cloud credential constructor/signing path requires migration or review [REDACTED]'))
    for finding in iter_auth_warnings(content):
        violations.append({'file': rel_path, 'line': finding['line'],
                           'type': finding['kind'], 'severity': 'warning',
                           'message': 'Credential/provider overload requires source review: [REDACTED]'})

    for line_no, code_portion in iter_code_units(content):
        if not code_portion.strip():
            continue

        # Check for AK/SK literal violations on code portion
        if RE_AK_LITERAL.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'ak_literal',
                'severity': 'blocking',
                'message': f'AK/SK literal found: [REDACTED]'
            })

        # Check for SDK constructor violations
        for rx_name, rx in [
            ('default_profile', RE_DEFAULT_PROFILE),
            ('oss_v1_build', oss_call),
            ('oss_v2_config', RE_OSS_V2_CONFIG),
            ('sls_client', sls_call),
            ('ak_setter', RE_AK_SETTER),
            ('tencent_cred', RE_TENCENT_CRED),
            ('cos_cred', RE_COS_CRED),
            ('aws_static', RE_AWS_STATIC),
        ]:
            if (has_default_profile_static_auth(code_portion) if rx_name == 'default_profile'
                    else has_sls_static_auth(code_portion, sls_call) if rx_name == 'sls_client'
                    else any(len(args) >= 3 for args in iter_call_arguments(code_portion, rx)) if rx_name == 'oss_v1_build'
                    else rx.search(code_portion)):
                severity = "warning" if rx_name in WARN_TYPES else ctor_severity(code_portion, rx_name, rx)
                blocking = severity == "blocking"
                detail = ("Hardcoded AK/SK in %s" % rx_name) if blocking else \
                         ("%s constructor requires manual credential/provider review" % rx_name)
                violations.append({
                    'file': rel_path,
                    'line': line_no,
                    'type': rx_name,
                    'severity': severity,
                    'message': f'{detail}: [REDACTED]'
                })

        # Environment variable reads
        if RE_ENV_AK.search(code_portion):
            violations.append({
                'file': rel_path,
                'line': line_no,
                'type': 'env_ak',
                'severity': 'blocking',
                'message': f'AK/SK read from environment: [REDACTED]'
            })

        # Manual STS / credential caching: warnings (need human review)
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
           RE_IMPORT_CREDENTIALS_JAVA.search(code_portion) or RE_IMPORT_TEAOPENAPI.search(code_portion):
            has_cloud_sdk = True

        # Check for IDaaS integration
        if RE_IDAAS_INIT.search(code_portion):
            has_idaas_init = True
        if RE_IDAAS_PROVIDER.search(code_portion):
            has_idaas_provider = True

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
    """Verify all Java files plus non-code configs in directory."""
    all_violations = []
    files_with_cloud_sdk = 0
    files_with_idaas_init = 0
    files_with_idaas_provider = 0
    total_files = 0

    read_errors = []
    source_files = list(iter_java_files(root_dir, read_errors))

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
        if RE_IDAAS_INIT.search(code):
            project_has_init = True
        if RE_IDAAS_PROVIDER.search(code):
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
    ap.add_argument("--lang", default="java", choices=["java"])
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
        print(f"Verified {result['total_files']} Java files")
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
