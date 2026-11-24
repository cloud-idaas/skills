import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tools = process.env.IDAAS_SKILL_TOOLS ?? fileURLToPath(new URL('../assets/probe/', import.meta.url));
const fixture = {
  idaasInstanceId: 'fixture-instance', clientId: 'fixture-client',
  issuer: 'https://example.invalid', tokenEndpoint: 'https://example.invalid/token',
  developerApiEndpoint: 'https://example.invalid/developer', scope: 'urn:cloud:idaas:pam|.all',
  authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: 'FIXTURE_PASSWORD' },
};

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'idaas-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkDir = join(root, '.cloud_idaas');
  mkdirSync(sdkDir);
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root };
  const run = (args, extra = {}) => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [join(tools, 'check-config.mjs'), ...args],
      { env: { ...env, ...extra }, encoding: 'utf8' });
    assert.ok(stdout, stderr);
    assert.doesNotMatch(stdout + stderr, /fixture-secret-value/);
    return { status, ...JSON.parse(stdout) };
  };
  return { root, sdkDir, run };
}

test('config priority is explicit, environment, default and runtime checks the named variables', (t) => {
  const { root, sdkDir, run } = setup(t);
  writeFileSync(join(sdkDir, 'client-config.json'), JSON.stringify(fixture));
  assert.equal(run(['--phase', 'code']).ok, true);
  const missing = join(root, 'missing.json');
  assert.equal(run(['--phase', 'code'], { CLOUD_IDAAS_CONFIG_PATH: missing }).ok, false);
  assert.equal(run(['--config', missing, '--phase', 'code'],
    { CLOUD_IDAAS_CONFIG_PATH: join(sdkDir, 'client-config.json') }).ok, false);
  assert.ok(run([]).problems.some((item) => item.includes('FIXTURE_PASSWORD')));
  assert.equal(run([], { FIXTURE_PASSWORD: 'fixture-secret-value', ALIBABA_CLOUD_ROLE_ARN: 'fixture-role' }).ok, true);
});

test('renders SDK-valid pilots for ECS, Kubernetes and secret auth without overwriting or following output links', (t) => {
  const { root, sdkDir, run } = setup(t);
  const render = (deploy, destination) => run(['--render', '--deploy', deploy, '--instance-id', fixture.idaasInstanceId,
    '--client-id', fixture.clientId, '--issuer', fixture.issuer, '--token-endpoint', fixture.tokenEndpoint,
    '--developer-endpoint', fixture.developerApiEndpoint, '--out', destination]);
  for (const [deploy, method, placeholder] of [['ecs', 'PKCS7', true],
    ['k8s', 'OIDC', true], ['secret', 'CLIENT_SECRET_POST', false]]) {
    const output = join(root, deploy + '.json');
    const result = render(deploy, output);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.configurationReady, false);
    const before = readFileSync(output, 'utf8');
    const config = JSON.parse(before);
    assert.equal(config.scope, fixture.scope);
    assert.equal(config.authnConfiguration.authnMethod, method);
    assert.equal(run(['--phase', 'code', '--config', output]).ok, !placeholder);
    assert.equal(render('secret', output).ok, false);
    assert.equal(readFileSync(output, 'utf8'), before);
  }
  assert.equal(render('secret', join(sdkDir, 'refuse.json')).ok, false);
  const link = join(root, 'linked');
  symlinkSync(sdkDir, link, 'junction');
  assert.equal(render('secret', join(link, 'refuse.json')).ok, false);
});

test('verifies SDK deployment combinations and respects OIDC file precedence', (t) => {
  const { root, run } = setup(t);
  const path = join(root, 'config.json');
  const check = (authnConfiguration, flags = ['--phase', 'code'], env = {}) => {
    writeFileSync(path, JSON.stringify({ ...fixture, authnConfiguration }));
    return run(['--config', path, ...flags], env);
  };
  const pkcs7 = { authnMethod: 'PKCS7', applicationFederatedCredentialName: 'fixture-federated' };
  assert.equal(check({ ...pkcs7, clientDeployEnvironment: 'KUBERNETES' }).ok, false);
  assert.equal(check({ ...pkcs7, clientDeployEnvironment: 'ALIBABA_CLOUD_ECS' }).ok, true);
  const oidc = { ...pkcs7, authnMethod: 'OIDC', clientDeployEnvironment: 'KUBERNETES',
    oidcTokenFilePathEnvVarName: 'FIXTURE_OIDC_FILE' };
  const env = { ALIBABA_CLOUD_ROLE_ARN: 'fixture-role' };
  assert.equal(check(oidc, [], env).ok, false);
  assert.equal(check({ ...oidc, oidcTokenFilePath: '/path/in/deployment' }, [], env).ok, true);
});
