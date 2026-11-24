import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const assets = fileURLToPath(new URL('../assets/probe/', import.meta.url));
const report = { ok: false, language: 'typescript', stage: 'preconditions',
  cloudCalled: false, credentialAcquired: false, refreshExpiryVerified: false, resourceDenialVerified: false };
const started = performance.now();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const services = new Set(['oss', 'sls', 'openapi']);
const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|SystemRoot|ComSpec|TEMP|TMP|TMPDIR|npm_config_cache|npm_config_registry|HTTPS?_PROXY|NO_PROXY)$/i.test(key)));

function command(executable, args, cwd, env, timeout) {
  return spawnSync(executable, args, { cwd, env, timeout, encoding: 'utf8',
    maxBuffer: 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' && executable === npm });
}

function reason(problem) {
  return { reason: problem };
}

async function run() {
  const { values: options } = parseArgs({ options: {
    ...Object.fromEntries(['out', 'config', 'role-arn', 'region'].map((key) => [key, { type: 'string' }])),
    mode: { type: 'string', default: 'contract' }, service: { type: 'string', default: 'openapi' },
    count: { type: 'string', default: '1' }, interval: { type: 'string', default: '60' },
    'offline-deps': { type: 'boolean' }, 'allow-cloud-read': { type: 'boolean' },
  } });
  report.mode = options.mode;
  if (!['prepare', 'contract', 'smoke'].includes(options.mode)) return reason('invalid_mode');
  const prepare = options.mode === 'prepare';
  const smoke = options.mode === 'smoke';
  if (prepare !== Boolean(options.out?.trim())) return reason('prepare_requires_a_new_output_directory');
  const count = Number(options.count);
  const interval = Number(options.interval);
  const totalMs = (count - 1) * interval * 1000 + 180_000;
  if (smoke && (!options['allow-cloud-read'] || !services.has(options.service) ||
      !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(interval) ||
      interval < 1 || interval > 2_147_483 || totalMs > 2_147_483_647 || options.config === '')) {
    return reason('smoke_requires_allow_cloud_read_and_valid_inputs');
  }
  const runtimeEnv = { ...process.env };
  delete runtimeEnv.DEBUG;
  delete runtimeEnv.NODE_DEBUG;
  delete runtimeEnv.NODE_OPTIONS;
  if (smoke) {
    if (options['role-arn'] !== undefined) runtimeEnv.ALIBABA_CLOUD_ROLE_ARN = options['role-arn'];
    if (options.region !== undefined) runtimeEnv.ALIBABA_CLOUD_REGION_ID = options.region;
    if (!runtimeEnv.ALIBABA_CLOUD_ROLE_ARN?.trim() ||
        !/^[a-z]{2}(?:-[a-z0-9]+)+$/.test(runtimeEnv.ALIBABA_CLOUD_REGION_ID?.trim() ?? '')) {
      return reason('missing_role_or_invalid_region');
    }
  }
  let directory;
  let prepared = false;
  try {
    if (prepare) {
      const destination = resolve(options.out);
      try {
        await mkdir(dirname(destination), { recursive: true });
        await mkdir(destination);
      } catch {
        return reason('output_directory_creation_failed');
      }
      directory = destination;
    } else {
      directory = await mkdtemp(resolve(tmpdir(), 'idaas-ts-probe-'));
    }
    await cp(assets, directory, { recursive: true, filter: (path) =>
      !/(?:^|[/\\])(?:node_modules|dist|package-lock\.json)(?:[/\\]|$)/.test(path.slice(assets.length - 1)) });
    report.stage = 'dependencies';
    const install = command(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund',
      ...(options['offline-deps'] ? ['--offline'] : [])], directory, buildEnv, 180_000);
    if (install.status !== 0) return reason('dependencies_unavailable');
    if (prepare) {
      prepared = true;
      return { ok: true, stage: 'complete', prepared: directory };
    }
    if (smoke) {
      report.stage = 'configuration';
      const { checkConfig } = await import(pathToFileURL(resolve(directory, 'check-config.mjs')));
      const config = await checkConfig(options.config ?? runtimeEnv.CLOUD_IDAAS_CONFIG_PATH, 'runtime', runtimeEnv);
      if (!config.ok) return { reason: 'configuration_invalid', problems: config.problems };
      runtimeEnv.CLOUD_IDAAS_CONFIG_PATH = config.config;
    }
    report.stage = 'build';
    const built = command(process.execPath, ['node_modules/typescript/bin/tsc'], directory, buildEnv, 180_000);
    if (built.status !== 0) return reason('probe_build_failed');
    report.stage = 'execution';
    if (!smoke) {
      const result = command(process.execPath, ['--test', 'dist/credentials.test.mjs'], directory, buildEnv, 60_000);
      return result.status === 0 ? { ok: true, stage: 'complete', contractVerified: true } : reason('contract_failed');
    }
    report.service = options.service;
    const result = command(process.execPath, ['dist/probe.mjs', options.service, String(count), String(interval),
      '--allow-cloud-read'], directory, runtimeEnv, totalMs);
    const entry = result.stdout?.split(/\r?\n/).findLast((line) => line.startsWith('IDAAS_PROBE_RESULT '));
    if (!entry) return { reason: 'probe_output_unavailable', cloudCalled: null };
    const payload = JSON.parse(entry.slice('IDAAS_PROBE_RESULT '.length));
    const ok = result.status === 0 && payload.ok === true;
    return { ...payload, ok };
  } finally {
    if (directory && !prepared) await rm(directory, { recursive: true, force: true });
  }
}

try {
  Object.assign(report, await run());
} catch {
  report.reason = 'invalid_arguments_or_probe_tool_failed';
}
report.elapsedSeconds = Math.round(performance.now() - started) / 1000;
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
