#!/usr/bin/env python3
"""Post-refactor verification for IDaaS AK-less onboarding. Stdlib only.

Usage: python3 verify_akless.py --repo <root>
Checks:
  1. No long-term AK literals (LTAI...) or access_key_id=/access_key_secret= kwargs.
  2. No static oss2.Auth( / oss2.AuthV4( construction.
  3. No reads of AK/SK environment variables.
  4. At least one IDaaSCredentialProviderFactory.init() and one IDaaSPamAklessCredentialFactory.* call
     in files that use oss2 / alibabacloud_oss_v2 / aliyun.log.
Output JSON {ok, violations, checked_files}.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan_ak_usage import iter_py_files, RE_AK_LITERAL, RE_STATIC_AUTH, RE_AK_KWARG, RE_ENV_AK, RE_IMPORT_OSS1, RE_IMPORT_OSS2, RE_IMPORT_SLS, RE_IDAAS_INIT, RE_IDAAS_PROVIDER  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    args = ap.parse_args()
    root = os.path.abspath(args.repo)
    violations = []
    checked = 0
    cloud_files = 0
    for fp in iter_py_files(root):
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
        except OSError:
            continue
        checked += 1
        rel = os.path.relpath(fp, root)
        for i, ln in enumerate(src.splitlines(), 1):
            if RE_AK_LITERAL.search(ln):
                violations.append({"file": rel, "line": i, "rule": "ak_literal", "text": ln.strip()[:120]})
            if RE_STATIC_AUTH.search(ln):
                violations.append({"file": rel, "line": i, "rule": "static_oss_auth", "text": ln.strip()[:120]})
            if RE_AK_KWARG.search(ln):
                violations.append({"file": rel, "line": i, "rule": "ak_kwarg", "text": ln.strip()[:120]})
            if RE_ENV_AK.search(ln):
                violations.append({"file": rel, "line": i, "rule": "env_ak_read", "text": ln.strip()[:120]})
        uses_cloud = bool(RE_IMPORT_OSS1.search(src) or RE_IMPORT_OSS2.search(src) or RE_IMPORT_SLS.search(src))
        if uses_cloud:
            cloud_files += 1
            if not (RE_IDAAS_INIT.search(src) and RE_IDAAS_PROVIDER.search(src)):
                violations.append({"file": rel, "line": 0, "rule": "missing_idaas_provider",
                                   "text": "uses cloud SDK but lacks IDaaSCredentialProviderFactory.init()/IDaaSPamAklessCredentialFactory"})
    ok = not violations
    print(json.dumps({"ok": ok, "checked_files": checked, "cloud_sdk_files": cloud_files, "violations": violations},
                     ensure_ascii=False, indent=2))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
