#!/usr/bin/env python3
"""Build isolated SDK probes. Contract mode never calls cloud endpoints."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from akless_config import resolve_config_path, validate

LANG = 'java'


def command(argv, cwd, env, timeout):
    return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout)


def run(args):
    started = time.monotonic()
    report = dict(ok=False, mode=args.mode, language=LANG, cloud_called=False,
                  refresh_expiry_verified=False, stage='preconditions')
    env = dict(os.environ)
    if args.mode == 'smoke':
        if not args.allow_cloud_read:
            report['reason'] = 'smoke_requires_allow_cloud_read'
            return report
        path, _ = resolve_config_path(args.config)
        try:
            config = json.loads(Path(path).read_text())
        except (OSError, ValueError, UnicodeError):
            report['reason'] = 'configuration_unreadable'
            return report
        problems = validate(config)
        if problems:
            report['reason'] = 'configuration_invalid'
            report['problems'] = problems
            return report
        env['CLOUD_IDAAS_CONFIG_PATH'] = str(Path(path).resolve())
        for key, value in (('ALIBABA_CLOUD_ROLE_ARN', args.role_arn), ('ALIBABA_CLOUD_REGION_ID', args.region)):
            if value:
                env[key] = value
            if not env.get(key, '').strip():
                report['reason'] = 'missing_' + key
                return report
    try:
        with tempfile.TemporaryDirectory(prefix='akless-probe-') as temp:
            work = Path(temp) / 'probe'
            shutil.copytree(Path(__file__).resolve().parents[1] / 'assets' / 'probe', work)
            # Build processes do not need deployment secrets; SDK probes receive
            # credentials only at runtime. Do not execute any business build hooks.
            build_env = {k: v for k, v in env.items() if not any(s in k.upper() for s in ('SECRET', 'TOKEN', 'PRIVATE_KEY', 'ACCESS_KEY'))}
            if args.mode == 'smoke':
                auth = config['authnConfiguration']
                for field in ('clientSecretEnvVarName', 'privateKeyEnvVarName'):
                    build_env.pop(auth.get(field, ''), None)
            report['stage'] = 'build'
            if LANG == 'go':
                if args.offline_deps:
                    build_env['GOPROXY'] = 'off'
                binary = str(work / ('probe.exe' if os.name == 'nt' else 'probe'))
                built = command(['go', 'build', '-mod=mod', '-o', binary, '.'], work, build_env, 180)
                runtime = [binary, args.mode]
            else:
                argv = ['mvn', '-B', '-q'] + (['-o'] if args.offline_deps else [])
                built = command(argv + ['compile', 'dependency:build-classpath', '-Dmdep.outputFile=classpath.txt'], work, build_env, 180)
                if built.returncode == 0:
                    cp = str(work / 'target' / 'classes') + os.pathsep + (work / 'classpath.txt').read_text().strip()
                    runtime = ['java', '-cp', cp, 'AklessProbe', args.mode]
            if built.returncode:
                report['reason'] = 'probe_build_failed'
                return report
            report['stage'] = 'execution'
            report['cloud_called'] = args.mode == 'smoke'
            result = command(runtime, work, env if args.mode == 'smoke' else build_env, 60)
            # SDK logs may include server responses. Never forward stdout/stderr.
            payload = json.loads(result.stdout.splitlines()[-1])
            for key in ('credential_acquired', 'failed_stage', 'scope'):
                if key in payload:
                    report[key] = payload[key]
            report['ok'] = result.returncode == 0 and payload.get('ok') is True
            report['stage'] = 'complete' if report['ok'] else 'execution'
            if args.mode == 'smoke':
                report['action'] = 'ecs:DescribeRegions'
                report['resource_denial_verified'] = False
    except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
        report['reason'] = 'probe_tool_unavailable_timeout_or_invalid_output'
    finally:
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('contract', 'smoke'), default='contract')
    parser.add_argument('--config')
    parser.add_argument('--role-arn')
    parser.add_argument('--region')
    parser.add_argument('--allow-cloud-read', action='store_true')
    parser.add_argument('--offline-deps', action='store_true')
    args = parser.parse_args()
    report = run(args)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['ok'] else 1)


if __name__ == '__main__':
    main()
