#!/usr/bin/env python3
"""Scan a Python repo for long-term Alibaba Cloud AK/SK usage and cloud-SDK credential
construction points, to plan IDaaS AK-less refactoring. Stdlib only.

Usage: python3 scan_ak_usage.py --repo <root> [--json]
Output: JSON report {files_scanned, sdk_usage, ak_hits, static_auth_hits, env_ak_reads, manual_sts_hits}
"""
import argparse
import json
import os
import re
import sys

SKIP_DIRS = {".git", ".venv", "venv", "env", "node_modules", "__pycache__", ".tox", ".mypy_cache", "dist", "build", "skill-build", ".idea", ".vscode"}

RE_AK_LITERAL = re.compile(r"\bLTAI[0-9A-Za-z]{12,24}\b")
RE_STATIC_AUTH = re.compile(r"\boss2\.Auth(V4)?\s*\(")
RE_AK_KWARG = re.compile(r"\b(access_key_id|access_key_secret|accessKeyId|accessKeySecret)\s*=")
RE_ENV_AK = re.compile(r"(ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET|ACCESS_KEY_ID|ACCESS_KEY_SECRET)")
RE_MANUAL_STS = re.compile(r"(AssumeRole|assume_role|STS\.|sts_client|SecurityToken\s*=)")
RE_IMPORT_OSS1 = re.compile(r"(?:^|[,;\s])import\s+[^#\n]*\boss2\b|^\s*from\s+oss2\b", re.M)
RE_IMPORT_OSS2 = re.compile(r"(?:^|[,;\s])import\s+[^#\n]*\balibabacloud_oss_v2\b|^\s*from\s+alibabacloud_oss_v2\b", re.M)
RE_IMPORT_SLS = re.compile(r"(?:^|[,;\s])import\s+[^#\n]*\baliyun\.log\b|^\s*from\s+aliyun\.log\b|^\s*from\s+aliyun\s+import\s+[^#\n]*\blog\b", re.M)
RE_IDAAS_INIT = re.compile(r"IDaaSCredentialProviderFactory\.init\s*\(")
RE_IDAAS_PROVIDER = re.compile(r"IDaaSPamAklessCredentialFactory\.\w+")


def iter_py_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn.endswith(".py"):
                yield os.path.join(dirpath, fn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--json", action="store_true", help="print raw json only")
    args = ap.parse_args()
    root = os.path.abspath(args.repo)
    if not os.path.isdir(root):
        print(json.dumps({"error": "repo not found: %s" % root}))
        sys.exit(2)

    report = {"root": root, "files_scanned": 0, "sdk_usage": {}, "ak_hits": [],
              "static_auth_hits": [], "env_ak_reads": [], "manual_sts_hits": [],
              "already_idaas": []}
    for fp in iter_py_files(root):
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
        except OSError:
            continue
        report["files_scanned"] += 1
        rel = os.path.relpath(fp, root)
        lines = src.splitlines()

        for name, rx in (("oss_v1", RE_IMPORT_OSS1), ("oss_v2", RE_IMPORT_OSS2), ("sls", RE_IMPORT_SLS)):
            if rx.search(src):
                report["sdk_usage"].setdefault(name, []).append(rel)

        for i, ln in enumerate(lines, 1):
            if RE_AK_LITERAL.search(ln):
                report["ak_hits"].append({"file": rel, "line": i, "kind": "ak_literal", "text": ln.strip()[:120]})
            if RE_STATIC_AUTH.search(ln):
                report["static_auth_hits"].append({"file": rel, "line": i, "kind": "static_oss_auth", "text": ln.strip()[:120]})
            if RE_AK_KWARG.search(ln):
                report["ak_hits"].append({"file": rel, "line": i, "kind": "ak_kwarg", "text": ln.strip()[:120]})
            if RE_ENV_AK.search(ln):
                report["env_ak_reads"].append({"file": rel, "line": i, "kind": "env_ak", "text": ln.strip()[:120]})
            if RE_MANUAL_STS.search(ln):
                report["manual_sts_hits"].append({"file": rel, "line": i, "kind": "manual_sts", "text": ln.strip()[:120]})
        if RE_IDAAS_INIT.search(src) or RE_IDAAS_PROVIDER.search(src):
            report["already_idaas"].append(rel)

    report["needs_refactor"] = bool(report["ak_hits"] or report["static_auth_hits"] or report["env_ak_reads"])
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
