"""AK-less configuration validation/rendering for this skill.

This module is maintained locally and ships with the skill.
Code phase validates structure without reading credentials. Runtime phase also
checks that named credential variables are present; it does not call cloud APIs.
"""
import argparse
import json
import os
import re
import sys

PAM_SCOPE = 'urn:cloud:idaas:pam|cloud_account_role:obtain_access_credential'
REQUIRED_BASE = ('idaasInstanceId', 'clientId', 'issuer', 'tokenEndpoint', 'scope', 'developerApiEndpoint')
AUTHN_EXTRA = {
    'PKCS7': ('applicationFederatedCredentialName', 'clientDeployEnvironment'),
    'OIDC': ('applicationFederatedCredentialName', 'clientDeployEnvironment'),
    'CLIENT_SECRET_BASIC': ('clientSecretEnvVarName',),
    'CLIENT_SECRET_POST': ('clientSecretEnvVarName',),
    'CLIENT_SECRET_JWT': ('clientSecretEnvVarName',),
    'PRIVATE_KEY_JWT': ('privateKeyEnvVarName',),
}
SDK_CONFIG_DIR = os.path.expanduser('~/.cloud_idaas')
DEFAULT_CONFIG_NAMES = ('client-config.json',)
ENV_NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]*\Z')
PLACEHOLDER = re.compile(r'(?i)(?:REPLACE[_-]?ME|CHANGE[_-]?ME|^\s*\$\{|^\s*<[^>]+>)')


def validate(cfg, check_runtime_env=True, allow_placeholders=False):
    """Return field-only diagnostics; never echo supplied values or credentials."""
    problems = []
    if not isinstance(cfg, dict):
        return ['config JSON must be an object']

    def required_string(values, key, prefix=''):
        value = values.get(key)
        field = prefix + key
        if not isinstance(value, str) or not value.strip():
            problems.append(field + ' must be a non-empty string')
            return False
        if not allow_placeholders and PLACEHOLDER.search(value):
            problems.append(field + ' contains a placeholder; replace via platform delivery')
            return False
        return True

    for key in REQUIRED_BASE:
        required_string(cfg, key)
    if cfg.get('scope') != PAM_SCOPE:
        problems.append('scope must be ' + PAM_SCOPE)
    authn = cfg.get('authnConfiguration')
    if not isinstance(authn, dict):
        problems.append('authnConfiguration must be an object')
        return problems
    method = authn.get('authnMethod')
    if not isinstance(method, str) or method not in AUTHN_EXTRA:
        problems.append('unsupported authnConfiguration.authnMethod')
        return problems
    if 'identityType' in authn and authn['identityType'] != 'CLIENT':
        problems.append('authnConfiguration.identityType must be CLIENT')
    for key in AUTHN_EXTRA[method]:
        valid = required_string(authn, key, 'authnConfiguration.')
        if valid and key.endswith('EnvVarName'):
            name = authn[key]
            if not ENV_NAME.fullmatch(name):
                problems.append('authnConfiguration.' + key + ' must be an environment variable name')
            elif check_runtime_env and not os.environ.get(name):
                problems.append('required runtime environment variable is empty or missing: ' + name)
    expected = {'PKCS7': 'ALIBABA_CLOUD_ECS', 'OIDC': 'KUBERNETES'}.get(method)
    if expected and authn.get('clientDeployEnvironment') != expected:
        problems.append(method + ' requires clientDeployEnvironment=' + expected)
    http = cfg.get('httpConfiguration', {})
    if not isinstance(http, dict):
        problems.append('httpConfiguration must be an object')
    else:
        for key in ('connectTimeout', 'readTimeout'):
            if key in http and (type(http[key]) is not int or http[key] <= 0):
                problems.append('httpConfiguration.' + key + ' must be a positive integer')
    return problems


def render(args):
    authn = {'identityType': 'CLIENT'}
    if args.deploy in ('ecs', 'k8s'):
        authn.update(authnMethod='PKCS7' if args.deploy == 'ecs' else 'OIDC',
                     applicationFederatedCredentialName=args.federated_credential_name or 'REPLACE_ME_federated_credential',
                     clientDeployEnvironment='ALIBABA_CLOUD_ECS' if args.deploy == 'ecs' else 'KUBERNETES')
    else:
        authn.update(authnMethod='CLIENT_SECRET_POST', clientSecretEnvVarName='IDAAS_CLIENT_SECRET')
    return dict(idaasInstanceId=args.instance_id, clientId=args.client_id, issuer=args.issuer,
                tokenEndpoint=args.token_endpoint, scope=PAM_SCOPE, developerApiEndpoint=args.developer_endpoint,
                authnConfiguration=authn, httpConfiguration=dict(connectTimeout=5000, readTimeout=10000))


def emit_failure(problems, config_path=None, exit_code=2):
    result = dict(ok=False, problems=problems, next_action='stop_and_resolve_configuration')
    if config_path:
        result['config'] = config_path
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code)


def resolve_config_path(explicit=None):
    """Explicit/env paths are authoritative, even when missing; never silently fall back."""
    if explicit:
        path = os.path.expanduser(explicit)
        return path, [path]
    env_path = os.environ.get('CLOUD_IDAAS_CONFIG_PATH')
    if env_path:
        path = os.path.expanduser(env_path)
        return path, [path]
    path = os.path.join(SDK_CONFIG_DIR, DEFAULT_CONFIG_NAMES[0])
    return path, [path]


def main(default_lang='go'):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config')
    parser.add_argument('--phase', choices=('code', 'runtime'), default='runtime',
                        help='code checks structure only; runtime also checks named credential variables')
    parser.add_argument('--render', action='store_true')
    parser.add_argument('--deploy', choices=('ecs', 'k8s', 'secret'), default='ecs')
    for key in ('instance-id', 'client-id', 'issuer', 'token-endpoint', 'developer-endpoint',
                'federated-credential-name', 'out'):
        parser.add_argument('--' + key)
    parser.add_argument('--lang', choices=('go', 'java'), default=default_lang)
    args = parser.parse_args()
    if args.render:
        missing = [key for key in ('instance_id', 'client_id', 'issuer', 'token_endpoint', 'developer_endpoint', 'out')
                   if not getattr(args, key)]
        if missing:
            emit_failure(['render requires: ' + ', '.join('--' + key.replace('_', '-') for key in missing)])
        cfg = render(args)
        problems = validate(cfg, check_runtime_env=False, allow_placeholders=True)
        if problems:
            emit_failure(problems)
        out = os.path.realpath(os.path.expanduser(args.out))
        default_dir = os.path.realpath(SDK_CONFIG_DIR)
        if out == default_dir or out.startswith(default_dir + os.sep):
            emit_failure(['refusing to write a rendered pilot config into the SDK default config dir'])
        try:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            # Exclusive creation prevents both accidental overwrites and symlink replacement.
            with open(out, 'x', encoding='utf-8') as stream:
                json.dump(cfg, stream, ensure_ascii=False, indent=2)
        except OSError:
            emit_failure(['cannot create pilot config; choose a writable, new --out path'], out)
        print(json.dumps(dict(ok=True, written=out, config=out, problems=[], phase='pilot',
                              configuration_ready=False, next_action='replace_placeholders_and_validate',
                              warning='Pilot structure only; replace REPLACE_ME values and validate before runtime use.'),
                         ensure_ascii=False, indent=2))
        return
    config_path, candidates = resolve_config_path(args.config)
    try:
        with open(config_path, encoding='utf-8') as stream:
            cfg = json.load(stream)
    except (OSError, UnicodeError, json.JSONDecodeError):
        emit_failure(['config missing, unreadable or invalid JSON; specify the platform-delivered path via '
                      '--config or CLOUD_IDAAS_CONFIG_PATH. searched: ' + ', '.join(candidates)], config_path)
    problems = validate(cfg, check_runtime_env=args.phase == 'runtime')
    if problems:
        emit_failure(problems, config_path, exit_code=1 if isinstance(cfg, dict) else 2)
    print(json.dumps(dict(ok=True, config=config_path, problems=[], phase=args.phase,
                          runtime_env_checked=args.phase == 'runtime',
                          next_action='continue_to_scan' if args.phase == 'code' else 'continue_to_runtime_verification'),
                     ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
