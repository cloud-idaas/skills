#!/usr/bin/env python3
"""Native syntax-tree credential binding analysis. No target code is executed."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from scan_ak_usage import SKIP_DIRS
from akless_common import iter_repo_files, is_test_source

LANG = 'go'


def native_parse(paths):
    here = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix='akless-ast-') as temp:
        if LANG == 'go':
            command = ['go', 'run', str(here / 'auth_ast.go')]
            payload = json.dumps(paths)
        else:
            build = subprocess.run(['javac', '-encoding', 'UTF-8', '-proc:none', '-d', temp,
                                    str(here / 'AuthAst.java')], capture_output=True, timeout=60)
            if build.returncode:
                raise RuntimeError('parser_build_failed')
            command = ['java', '-cp', temp, 'AuthAst']
            payload = '\n'.join(paths) + '\n'
        result = subprocess.run(command, input=payload, text=True, capture_output=True,
                                timeout=120, env=dict(os.environ, GO111MODULE='off'))
        if result.returncode:
            raise RuntimeError('parser_failed')
        return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]


class Bindings:
    def __init__(self, unit):
        self.unit = unit
        self.events = unit['events']

    def definitions(self, name, scope):
        scopes = [scope]
        if LANG == 'java' and '/' in scope:
            scopes.append(scope.rsplit('/', 1)[0])
        scopes.append('global')
        for owner in scopes:
            found = [e for e in self.events if e['kind'] == 'def' and e['scope'] == owner and e['name'] == name]
            if found:
                return found
        return []

    def canonical(self, value, scope, depth=0):
        if depth > 8:
            return ''
        kind = value.get('kind')
        if kind == 'ref':
            name = value['name']
            defs = self.definitions(name, scope)
            if defs:
                return self.canonical(defs[0]['value'], scope, depth + 1) if len(defs) == 1 and not defs[0]['uncertain'] else ''
            first, *rest = name.split('.')
            return '.'.join([self.unit['imports'].get(first, first), *rest])
        if kind == 'member':
            return self.canonical(value['base'], scope, depth + 1) + '.' + value['name']
        if kind == 'call':
            return self.canonical(value['base'], scope, depth + 1)
        return ''

    def credential(self, value, scope, depth=0):
        if depth > 8:
            return 'unresolved'
        kind = value.get('kind')
        if kind == 'ref' or (kind == 'member' and value.get('base', {}).get('name') == 'this'):
            name = value['name']
            defs = self.definitions(name, scope)
            if len(defs) == 1 and not defs[0]['uncertain']:
                return self.credential(defs[0]['value'], defs[0]['scope'], depth + 1)
        if kind == 'literal':
            return 'empty' if value.get('empty') else 'static_auth'
        if kind == 'object':
            fields = value['fields']
            for key in ('Credential', 'CredentialsProvider', 'source'):
                if key in fields:
                    return self.credential(fields[key], scope, depth + 1)
            if any(k in fields for k in ('AccessKeyId', 'AccessKeyID', 'AccessKeySecret')):
                return 'static_auth'
        if kind == 'call':
            name = self.canonical(value['base'], scope)
            if (name.startswith('github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam.')
                    or name.startswith('com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory.')):
                go_methods = {prefix + family + 'CredentialsProvider'
                              for prefix in ('Get', 'NewIDaaSPam') for family in ('AlibabaCloud', 'OSSV1', 'OSSV2', 'SLS')}
                java_methods = {'getAlibabaCloudCredentialsProvider', 'getOSSV1CredentialProvider',
                                'getOSSV2CredentialProvider', 'getSLSCredentialProvider'}
                methods = go_methods if name.startswith('github.com/') else java_methods
                if name.rsplit('.', 1)[-1] in methods:
                    return 'idaas_provider'
            if name.endswith(('.WithCredentialsProvider', '.SetCredentialsProvider', '.credentialsProvider', '.setCredential', 'com.aliyun.credentials.Client')):
                args = value.get('args', [])
                if args:
                    return self.credential(args[0], scope, depth + 1)
            options = {'WithRegion', 'WithEndpoint', 'WithUsePathStyle', 'WithRetryMaxAttempts'}
            if value.get('base', {}).get('name') in options:
                # Resolve this bounded SDK builder chain by its root, rather
                # than spending the alias recursion budget on option calls.
                receiver = value['base']['base']
                root = receiver
                for _ in range(16):
                    base = root.get('base', {})
                    if root.get('kind') != 'call' or base.get('name') not in options | {'WithCredentialsProvider'}:
                        break
                    root = base['base']
                if self.canonical(root, scope) in {
                        'github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss.LoadDefaultConfig',
                        'github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss.NewConfig'}:
                    return self.credential(receiver, scope, depth + 1)
            # A unique zero-argument same-file function is the supported factory case.
            if not value.get('args') and value.get('base', {}).get('kind') == 'ref' and '.' not in value['base'].get('name', ''):
                short = name.rsplit('.', 1)[-1]
                functions = [e for e in self.events if e['kind'] == 'function' and e['name'] == short and e['value']['params'] == 0 and (LANG != 'java' or e['scope'].rsplit('/', 1)[0] == scope.rsplit('/', 1)[0])]
                if len(functions) == 1:
                    returns = [e for e in self.events if e['kind'] == 'return' and e['scope'] == functions[0]['scope']]
                    if len(returns) == 1 and not returns[0]['uncertain']:
                        return self.credential(returns[0]['value'], returns[0]['scope'], depth + 1)
        return 'unresolved'

    def clients(self):
        results = []
        for event in self.events:
            if event['kind'] != 'call':
                continue
            call, scope = event['value'], event['scope']
            name = self.canonical(call['base'], scope)
            args = call.get('args', [])
            candidates, family = [], None
            if name.endswith(('.WithCredentialsProvider', '.SetCredentialsProvider', '.credentialsProvider', '.setCredential')):
                candidates, family = args[:1], 'credential_binding'
            elif 'aliyun-oss-go-sdk/oss.New' == name.split('github.com/aliyun/')[-1]:
                candidates, family = args[1:3], 'oss_v1_static'
            elif name.endswith(('.CreateNormalInterface', '.NewStaticCredentialsProvider')) and 'aliyun-log-go-sdk' in name:
                candidates, family = args[1:3] if name.endswith('.CreateNormalInterface') else args[:2], 'sls_static'
            elif name.endswith('.CreateNormalInterfaceV2') and 'aliyun-log-go-sdk' in name:
                candidates, family = args[1:2], 'sls'
            elif (name.startswith('github.com/aliyun/alibaba-cloud-sdk-go/sdk.')
                  and name.endswith(('.NewClientWithAccessKey', '.NewClientWithStsToken'))):
                candidates, family = args[1:3], 'openapi_static'
            elif name == 'github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss/credentials.NewStaticCredentialsProvider':
                candidates, family = args[:2], 'static_credential_provider'
            elif name.endswith('.NewClientWithOptions') and 'alibaba-cloud-sdk-go' in name:
                candidates, family = args[2:3], 'openapi'
            elif name.endswith('.NewClient') and any(s in name for s in ('alibabacloud-go/', 'oss-go-sdk-v2/oss')):
                candidates, family = args[:1], 'cloud_client'
            elif name.startswith('com.aliyun.oss.OSSClientBuilder') and name.endswith('.build'):
                candidates, family = args[1:2] if len(args) < 3 else args[1:3], 'oss_v1'
            elif name == 'com.aliyun.oss.OSSClient':
                candidates, family = args[1:3], 'oss_v1'
            elif name in ('com.aliyun.openservices.log.Client', 'com.aliyuncs.DefaultAcsClient'):
                candidates, family = args[1:2], 'cloud_client'
            elif name.startswith('com.aliyun.') and name.endswith('.Client') and 'credentials.' not in name:
                candidates, family = args[:1], 'cloud_client'
            if family is None:
                continue
            states = [self.credential(v, scope) for v in candidates]
            state = 'unresolved'
            if states and 'idaas_provider' in states:
                state = 'idaas_provider'
            elif 'static_auth' in states:
                state = 'static_auth'
            if family in ('openapi_static', 'static_credential_provider'):
                state = 'static_auth' if len(candidates) == 2 else 'unresolved'
            # Empty AK/SK in OSS V1 is legal only with an actual provider option.
            if family == 'oss_v1_static' and all(s == 'empty' for s in states):
                options = [self.credential(v, scope) for v in args[3:]]
                state = 'idaas_provider' if 'idaas_provider' in options else 'unresolved'
            if event['uncertain'] and state == 'idaas_provider':
                state = 'unresolved'
            results.append(dict(line=event['line'], scope=scope, family=family, status=state))
        return results


def analyze(root):
    errors = []
    paths = [str(Path(p).resolve()) for p in iter_repo_files(str(root), SKIP_DIRS, errors)
             if p.endswith('.go' if LANG == 'go' else '.java') and not is_test_source(p, str(root))]
    if not paths:
        return dict(ok=False, syntax_complete=not errors, clients=[], errors=errors,
                    review_required=True, reason='no_production_sources')
    try:
        units = native_parse(paths)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        return dict(ok=False, syntax_complete=False, clients=[], errors=[dict(kind='parser_unavailable_or_failed')], review_required=True)
    clients = []
    initialization_sites = []
    for unit in units:
        rel = os.path.relpath(unit['file'], root)
        if unit.get('error'):
            errors.append(dict(file=rel, kind='parse_failed'))
            continue
        bindings = Bindings(unit)
        clients.extend(dict(c, file=rel) for c in bindings.clients())
        for event in unit['events']:
            if event['kind'] == 'call':
                name = bindings.canonical(event['value']['base'], event['scope'])
                if (name.startswith('github.com/cloud-idaas/idaas-go-core-sdk/factory.') and name.endswith(('.Init', '.InitWithConfig', '.GetInstance.Initialize'))) or name == 'com.cloud_idaas.core.factory.IDaaSCredentialProviderFactory.init':
                    initialization_sites.append(dict(file=rel, line=event['line'], scope=event['scope']))
    if len(units) != len(paths):
        errors.append(dict(kind='incomplete_parser_output'))
    review = not any(c['family'] != 'credential_binding' for c in clients) or any(c['status'] == 'unresolved' for c in clients)
    return dict(ok=not errors and bool(clients) and not review and all(c['status'] == 'idaas_provider' for c in clients),
                syntax_complete=not errors, clients=clients, errors=errors, review_required=review,
                initialization_sites=initialization_sites,
                runtime_order_verified=False, analysis='same_file_bounded_dataflow')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    root = Path(args.repo).resolve()
    result = analyze(root) if root.is_dir() else dict(ok=False, syntax_complete=False, errors=[dict(kind='repo_not_found')])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(0 if result['ok'] else 1)


if __name__ == '__main__':
    main()
