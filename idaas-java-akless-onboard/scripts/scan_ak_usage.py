#!/usr/bin/env python3
"""Scan a Java repo for long-term Alibaba Cloud AK/SK usage and cloud-SDK credential
construction points, to plan IDaaS AK-less refactoring. Stdlib only.

Covers two layers:
1. .java sources (comments stripped, dependency/build dirs pruned incl. Gradle
   `build/`): AK literals, hardcoded constructor auth, env reads, manual STS,
   SDK imports, existing IDaaS integration.
2. Repo-wide non-code sweep (yaml/json/properties/.env/Dockerfile/CI...): literal
   AKs and plaintext secret assignments (application.yml is a classic AK home).

Usage: python3 scan_ak_usage.py --repo <root> --lang java [--json]
Output: JSON report {files_scanned, sdk_usage, ak_hits, static_auth_hits,
env_ak_reads, manual_sts_hits, config_hits, already_idaas, needs_refactor,
read_errors, scan_complete}. Read failures exit with code 1.
"""
import argparse
import json
import os
import re
import sys

SKIP_DIRS = {".git", "target", "build", "generated", ".gradle", "node_modules",
             "skill-build", ".idea", ".vscode", "bin", "out"}


# --- 硬编码 AK/SK 传参（各 SDK 构造模式） ---
# Match the call first; balanced outer arguments distinguish credential overloads.
RE_DEFAULT_PROFILE = re.compile(
    r"\bDefaultProfile\s*\.\s*getProfile\s*\("
)
# OSS V1: new OSSClientBuilder().build(endpoint, ak, sk) 或 build(endpoint, ak, sk, stsToken)
RE_OSS_V1_BUILD = re.compile(r"""OSSClientBuilder\s*\(\s*\)\s*\.\s*build\s*\([^)]*(?:"[^"]+"|[^",])[^"]*,[^)]*(?:"[^"]+"|[^",])[^"]*,[^)]+\)""")
# OSS V2: Config.builder()...accessKeyId("...").accessKeySecret("...")
RE_OSS_V2_CONFIG = re.compile(
    r"""\.accessKeyId\s*\(\s*"[^"]+"\s*\)"""
)
# 通用字段赋值: setAccessKeyId("..."), setAccessKeySecret("..."), .accessKeyId("...")
RE_AK_SETTER = re.compile(
    r"""(?:setAccessKeyId|setAccessKeySecret|accessKeyId|accessKeySecret)\s*\(\s*"[^"]+"\s*\)"""
)
# 腾讯云: new Credential("secretId", "secretKey")
RE_TENCENT_CRED = re.compile(
    r"""new\s+Credential\s*\(\s*"[^"]+"\s*,\s*"[^"]+"""
)
# COS: new BasicCOSCredentials("secretId", "secretKey")
RE_COS_CRED = re.compile(
    r"""new\s+BasicCOSCredentials\s*\(\s*"[^"]+"\s*,\s*"[^"]+"""
)
# AWS: StaticCredentialsProvider.create(AwsBasicCredentials.create("ak", "sk"))
RE_AWS_STATIC = re.compile(
    r"""StaticCredentialsProvider\s*\.\s*create\s*\("""
)

# --- 环境变量读取 ---
RE_ENV_AK = re.compile(
    r"""\bSystem\s*\.\s*getenv\s*\(\s*"(?:ALIBABA_CLOUD_ACCESS_KEY_ID|ALIBABA_CLOUD_ACCESS_KEY_SECRET"""
    r"""|OSS_ACCESS_KEY_ID|OSS_ACCESS_KEY_SECRET"""
    r'''|ACCESS_KEY_ID|ACCESS_KEY_SECRET)"\s*\)'''
)

# --- 手动 STS / AssumeRole ---
RE_MANUAL_STS = re.compile(
    r'\bAssumeRole(?:WithOIDC|WithSAML)?Request\b'
    r'|\.\s*assumeRole(?:WithOIDC|WithSAML)?\s*\('
    r'|\.\s*(?:setAction|setSysAction)\s*\(\s*"AssumeRole(?:WithOIDC|WithSAML)?"')

# --- SDK import 检测 ---
RE_IMPORT_OSS1 = re.compile(r"import\s+com\.aliyun\.oss\.(?:OSS|OSSClientBuilder)")
RE_IMPORT_OSS2 = re.compile(r"import\s+com\.aliyun\.sdk\.service\.oss2")
RE_IMPORT_SLS = re.compile(r"import\s+com\.aliyun\.openservices\.log\.(?:Client|\*)\s*;")
RE_IMPORT_OPENAPI = re.compile(r"import\s+com\.aliyuncs\.(?:DefaultAcsClient|IAcsClient|profile\.DefaultProfile)\b")
# credentials-java（通用凭证库，akless 通用适配器对接的接口来源）与 darabonba 新一代客户端
RE_IMPORT_CREDENTIALS_JAVA = re.compile(r"import\s+com\.aliyun\.credentials\.")
RE_IMPORT_TEAOPENAPI = re.compile(r"import\s+com\.aliyun\.teaopenapi\.")

# --- 已接入 IDaaS 检测 ---
RE_IDAAS_INIT = re.compile(r"IDaaSCredentialProviderFactory\.init\s*\(")
RE_IDAAS_PROVIDER = re.compile(r"IDaaSPamAklessCredentialFactory\.\w+")

# Helpers are maintained within this skill for standalone installation.
from akless_common import RE_AK_LITERAL, strip_comments, iter_code_units, iter_call_arguments, scan_config_file
from akless_common import iter_repo_files, iter_config_files as _iter_config_files
from akless_common import iter_additional_auth_findings


def oss_auth_pattern(content):
    code = strip_comments(content)
    builder_type = r'(?:com\.aliyun\.oss\.)?OSSClientBuilder'
    receivers = re.findall(builder_type + r'\s+(\w+)\s*[;=]', code)
    receivers += re.findall(r'\b(\w+)\s*=\s*new\s+' + builder_type + r'\s*\(', code)
    direct = builder_type + r'\s*\(\s*\)'
    names = '|'.join(re.escape(name) for name in set(receivers))
    receiver = '(?:' + direct + ('|' + names if names else '') + ')'
    return re.compile(r'\b(?:new\s+(?:com\.aliyun\.oss\.)?OSSClient\s*\('
                      + '|' + receiver + r'\s*\.\s*build\s*\()')


def has_default_profile_static_auth(code):
    """Three/four-argument overloads supply AK/SK, including variable expressions.

    Zero/one-argument profiles contain no explicit credentials. Nested argument
    calls must not turn a region-only profile into a static-auth finding.
    """
    return any(len(args) >= 3 for args in iter_call_arguments(code, RE_DEFAULT_PROFILE))


def sls_constructor_pattern(content):
    """Resolve short Client names only when an SLS import binds that name.

    Fully qualified SLS calls need no import. An explicit unrelated Client import
    takes precedence over an SLS wildcard import.
    """
    code = strip_comments(content)
    explicit = re.findall(r'\bimport\s+([\w.]+\.Client)\s*;', code)
    qualified = r'com\.aliyun\.openservices\.log\.Client'
    bound = ('com.aliyun.openservices.log.Client' in explicit if explicit else
             bool(RE_IMPORT_SLS.search(code)))
    names = qualified + (r'|Client' if bound else '')
    return re.compile(r'\bnew\s+(?:' + names + r')\s*\(')


def has_sls_static_auth(code, constructor):
    literal = re.compile(r'"(?:\\.|[^"\\])*"\Z')
    return any(len(args) >= 3 and all(literal.fullmatch(arg) for arg in args[:3])
               for args in iter_call_arguments(code, constructor))


def iter_auth_warnings(content):
    """Variable arguments may be credentials or legal provider overloads."""
    sls = sls_constructor_pattern(content)
    setter = re.compile(r'\.\s*(?:setAccessKeyId|setAccessKeySecret|accessKeyId|accessKeySecret)\s*\(')
    literal = re.compile(r'"(?:\\.|[^"\\])*"\Z')
    for line, code in iter_code_units(content):
        if any(len(args) >= 3 and not all(literal.fullmatch(arg) for arg in args[:3])
               for args in iter_call_arguments(code, sls)):
            yield {'line': line, 'kind': 'sls_client_suspect', 'severity': 'warning'}
        if any(len(args) == 1 and not literal.fullmatch(args[0])
               for args in iter_call_arguments(code, setter)):
            yield {'line': line, 'kind': 'ak_setter_suspect', 'severity': 'warning'}


def iter_config_files(root, read_errors=None):
    return _iter_config_files(root, SKIP_DIRS, read_errors)


def iter_java_files(root, read_errors=None):
    """Iterate over source files and surface directory traversal failures."""
    for filepath in iter_repo_files(root, SKIP_DIRS, read_errors):
        if filepath.endswith(".java"):
            yield filepath


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--lang", default="java", choices=["java"])
    ap.add_argument("--json", action="store_true", help="print raw json only")
    args = ap.parse_args()
    root = os.path.abspath(args.repo)
    if not os.path.isdir(root):
        print(json.dumps({"error": "repo not found: %s" % root}))
        sys.exit(2)

    report = {
        "root": root,
        "lang": "java",
        "files_scanned": 0,
        "sdk_usage": {},
        "ak_hits": [],
        "static_auth_hits": [],
        "env_ak_reads": [],
        "manual_sts_hits": [],
        "config_hits": [],
        "already_idaas": [],
        "read_errors": [],
    }

    for fp in iter_java_files(root, report['read_errors']):
        try:
            with open(fp, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
        except (IOError, OSError) as e:
            report['read_errors'].append({'file': os.path.relpath(fp, root), 'line': 0,
                                          'kind': 'read_error', 'text': 'Source could not be read; scan incomplete'})
            continue
        report["files_scanned"] += 1
        rel = os.path.relpath(fp, root)
        report['static_auth_hits'].extend(
            dict(hit, file=rel, text='[REDACTED]') for hit in iter_auth_warnings(src))
        report['static_auth_hits'].extend(
            dict(hit, file=rel, text='[REDACTED]') for hit in iter_additional_auth_findings(src, 'java'))

        # 按去注释后的完整调用扫描，同时累积代码视图供文件级判定使用
        sls_call = sls_constructor_pattern(src)
        oss_call = oss_auth_pattern(src)
        code_only_parts = []
        for i, code_portion in iter_code_units(src):
            code_only_parts.append(code_portion)
            if not code_portion.strip():
                continue

            # AK 字面量
            if RE_AK_LITERAL.search(code_portion):
                report["ak_hits"].append({"file": rel, "line": i, "kind": "ak_literal", "text": "[REDACTED]"})

            # 静态认证构造（各 SDK 硬编码 AK/SK）
            for rx_name, rx in [
                ("default_profile", RE_DEFAULT_PROFILE),
                ("oss_v1_build", oss_call),
                ("oss_v2_config", RE_OSS_V2_CONFIG),
                ("sls_client", sls_call),
                ("ak_setter", RE_AK_SETTER),
                ("tencent_cred", RE_TENCENT_CRED),
                ("cos_cred", RE_COS_CRED),
                ("aws_static", RE_AWS_STATIC),
            ]:
                if (has_default_profile_static_auth(code_portion) if rx_name == 'default_profile'
                        else has_sls_static_auth(code_portion, sls_call) if rx_name == 'sls_client'
                        else any(len(args) >= 3 for args in iter_call_arguments(code_portion, rx)) if rx_name == 'oss_v1_build'
                        else rx.search(code_portion)):
                    report["static_auth_hits"].append({
                        "file": rel, "line": i, "kind": rx_name, "text": "[REDACTED]"
                    })

            # 环境变量读取
            if RE_ENV_AK.search(code_portion):
                report["env_ak_reads"].append({"file": rel, "line": i, "kind": "env_ak", "text": "[REDACTED]"})

            # 手动 STS
            if RE_MANUAL_STS.search(code_portion):
                report["manual_sts_hits"].append({"file": rel, "line": i, "kind": "manual_sts", "text": "[REDACTED]"})

        # 文件级检测统一基于去注释后的代码视图：注释掉的 import/接入示例不算数
        code_text = "\n".join(code_only_parts)
        for name, rx in (("oss_v1", RE_IMPORT_OSS1), ("oss_v2", RE_IMPORT_OSS2),
                         ("sls", RE_IMPORT_SLS), ("openapi", RE_IMPORT_OPENAPI),
                         ("credentials_java", RE_IMPORT_CREDENTIALS_JAVA),
                         ("teaopenapi", RE_IMPORT_TEAOPENAPI)):
            if rx.search(code_text):
                report["sdk_usage"].setdefault(name, []).append(rel)

        # 已接入 IDaaS 检测
        if RE_IDAAS_INIT.search(code_text) or RE_IDAAS_PROVIDER.search(code_text):
            report["already_idaas"].append(rel)

    # 非代码配置文件普查（application.yml / CI / Dockerfile / .env ...）
    for fp in iter_config_files(root, report['read_errors']):
        for hit in scan_config_file(fp, root):
            report['read_errors' if hit['kind'] == 'read_error' else 'config_hits'].append(hit)

    report["needs_refactor"] = bool(
        report["ak_hits"] or any(h.get('severity') != 'warning' for h in report["static_auth_hits"]) or report["env_ak_reads"]
        or report["manual_sts_hits"]
        or any(h.get("severity") != "warning" for h in report["config_hits"])
    )
    report["needs_review"] = any(h.get("severity") == "warning"
                               for h in report["config_hits"] + report["static_auth_hits"])
    report["scan_complete"] = not report["read_errors"]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    sys.exit(0 if report["scan_complete"] else 1)


if __name__ == "__main__":
    main()
