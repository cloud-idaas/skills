#!/usr/bin/env python3
"""Validate a platform-delivered IDaaS client-config.json for the AK-less (PAM) scenario,
or render one from a template for pilot use when no platform delivery exists yet.

Validate:  python3 render_config.py --config <path>
Render:    python3 render_config.py --render --deploy ecs|k8s|secret \
               --instance-id idaas_xxx --client-id app_xxx \
               --issuer https://.../oauth2 --token-endpoint https://.../oauth2/token \
               --developer-endpoint eiam-developerapi.cn-hangzhou.aliyuncs.com \
               [--federated-credential-name xxx] [--out <path>]

Stdlib only. Never invents instance/app ids: render requires them explicitly.
"""
import argparse
import json
import os
import sys

REQUIRED_BASE = ["idaasInstanceId", "clientId", "issuer", "tokenEndpoint", "scope", "authnConfiguration"]
PAM_SCOPE = "urn:cloud:idaas:pam|cloud_account_role:obtain_access_credential"

AUTHN_EXTRA = {
    "PKCS7": ["applicationFederatedCredentialName", "clientDeployEnvironment"],
    "OIDC": ["applicationFederatedCredentialName", "clientDeployEnvironment"],
    "CLIENT_SECRET_BASIC": ["clientSecretEnvVarName"],
    "CLIENT_SECRET_POST": ["clientSecretEnvVarName"],
    "CLIENT_SECRET_JWT": ["clientSecretEnvVarName"],
    "PRIVATE_KEY_JWT": ["privateKeyEnvVarName"],
}
CLIENT_SECRET_METHODS = {"CLIENT_SECRET_BASIC", "CLIENT_SECRET_POST", "CLIENT_SECRET_JWT"}


def validate(cfg, check_runtime_env=True):
    problems = []
    for k in REQUIRED_BASE:
        if not cfg.get(k):
            problems.append("missing required field: %s" % k)
    if cfg.get("scope") != PAM_SCOPE:
        problems.append("scope must be '%s' for AK-less, got '%s'" % (PAM_SCOPE, cfg.get("scope")))
    if not cfg.get("developerApiEndpoint"):
        problems.append("missing developerApiEndpoint (required to exchange cloud-role StsToken)")
    authn = cfg.get("authnConfiguration") or {}
    method = authn.get("authnMethod")
    if not method:
        problems.append("missing authnConfiguration.authnMethod")
    else:
        for k in AUTHN_EXTRA.get(method, []):
            if not authn.get(k):
                problems.append("authnMethod=%s requires authnConfiguration.%s" % (method, k))
        if check_runtime_env and method in CLIENT_SECRET_METHODS:
            secret_env_var_name = authn.get("clientSecretEnvVarName")
            if secret_env_var_name and not os.environ.get(secret_env_var_name):
                problems.append(
                    "authnMethod=%s requires non-empty environment variable named by "
                    "authnConfiguration.clientSecretEnvVarName: %s" % (method, secret_env_var_name)
                )
        if method == "PKCS7" and authn.get("clientDeployEnvironment") != "ALIBABA_CLOUD_ECS":
            problems.append("PKCS7 requires clientDeployEnvironment=ALIBABA_CLOUD_ECS")
        if method == "OIDC" and authn.get("clientDeployEnvironment") != "KUBERNETES":
            problems.append("OIDC requires clientDeployEnvironment=KUBERNETES")
    return problems


def render(args):
    authn = {"identityType": "CLIENT"}
    if args.deploy == "ecs":
        authn.update({"authnMethod": "PKCS7",
                      "applicationFederatedCredentialName": args.federated_credential_name or "REPLACE_ME_pkcs7_federated_credential",
                      "clientDeployEnvironment": "ALIBABA_CLOUD_ECS"})
    elif args.deploy == "k8s":
        authn.update({"authnMethod": "OIDC",
                      "applicationFederatedCredentialName": args.federated_credential_name or "REPLACE_ME_oidc_federated_credential",
                      "clientDeployEnvironment": "KUBERNETES"})
    else:
        authn.update({"authnMethod": "CLIENT_SECRET_POST", "clientSecretEnvVarName": "IDAAS_CLIENT_SECRET"})
    cfg = {
        "idaasInstanceId": args.instance_id,
        "clientId": args.client_id,
        "issuer": args.issuer,
        "tokenEndpoint": args.token_endpoint,
        "scope": PAM_SCOPE,
        "developerApiEndpoint": args.developer_endpoint,
        "authnConfiguration": authn,
        "httpConfiguration": {"connectTimeout": 5000, "readTimeout": 10000},
    }
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--render", action="store_true")
    ap.add_argument("--deploy", choices=["ecs", "k8s", "secret"], default="ecs")
    ap.add_argument("--instance-id")
    ap.add_argument("--client-id")
    ap.add_argument("--issuer")
    ap.add_argument("--token-endpoint")
    ap.add_argument("--developer-endpoint")
    ap.add_argument("--federated-credential-name")
    ap.add_argument("--out")
    args = ap.parse_args()

    if args.render:
        missing = [k for k in ("instance_id", "client_id", "issuer", "token_endpoint", "developer_endpoint") if not getattr(args, k)]
        if missing:
            print(json.dumps({"ok": False, "error": "render requires: " + ", ".join("--" + m.replace("_", "-") for m in missing)}))
            sys.exit(2)
        cfg = render(args)
        problems = validate(cfg, check_runtime_env=False)
        out = args.out or os.path.expanduser("~/.cloud_idaas/client-config.json")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        print(json.dumps({"ok": not problems, "written": out, "config": cfg, "problems": problems,
                          "warning": "pilot-rendered config: replace REPLACE_ME placeholders with platform-provided federated credential names"},
                         ensure_ascii=False, indent=2))
        return

    if not args.config:
        args.config = os.environ.get("CLOUD_IDAAS_CONFIG_PATH") or os.path.expanduser("~/.cloud_idaas/client-config.json")
    if not os.path.exists(args.config):
        print(json.dumps({"ok": False, "error": "config not found: %s (ask platform team to deliver it)" % args.config}))
        sys.exit(2)
    with open(args.config, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    problems = validate(cfg)
    result = {"ok": not problems, "config": args.config, "problems": problems}
    if problems:
        result["next_action"] = "stop_and_resolve_configuration"
    else:
        result["next_action"] = "continue_to_scan"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    sys.exit(0 if not problems else 1)


if __name__ == "__main__":
    main()
