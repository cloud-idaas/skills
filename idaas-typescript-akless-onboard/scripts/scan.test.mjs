import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./scan.mjs', import.meta.url));

test('classifies code and config without disclosing matched values or walking dependencies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'idaas-nodejs-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'ignored.js'), 'const accessKeyId = "ignored"');
  writeFileSync(join(root, 'package-lock.json'), '{"accessKeyId":"ignored"}');
  writeFileSync(join(root, 'app.mts'), [
    "import OSS from 'ali-oss';",
    'const accessKeyId = "fixture-ak";',
    'const accessKeySecret = "fixture-not-a-secret";',
    'sdk.assumeRole({});',
    'provider.getOSSOptions();',
  ].join('\n'));
  writeFileSync(join(root, '.env.test'), 'ALIBABA_CLOUD_ACCESS_KEY_SECRET=fixture-env-value');

  const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /fixture-|ignored|node_modules|package-lock/);
  const report = JSON.parse(result.stdout);
  assert.equal(report.complete, true);
  assert.equal(report.scannedFiles, 2);
  assert.deepEqual(report.findings.filter(({ path }) => path === 'app.mts').map(({ line, type }) => [line, type]), [
    [1, 'cloud_sdk'],
    [2, 'credential_field'],
    [3, 'credential_field'],
    [4, 'manual_sts'],
    [5, 'idaas_provider'],
  ]);
  assert.deepEqual(report.findings.find(({ path, type }) => path === '.env.test' && type === 'credential_env'), {
    path: '.env.test', line: 1, type: 'credential_env',
  });
});

test('reports incomplete scans with an error exit code', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'idaas-nodejs-scan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'invalid.js'), Buffer.from([0xff]));
  const unreadable = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });
  assert.equal(unreadable.status, 2);
  assert.deepEqual(JSON.parse(unreadable.stdout).errors, [{ path: 'invalid.js', type: 'unreadable_file' }]);

  const absent = spawnSync(process.execPath, [scanner, join(root, 'missing')], { encoding: 'utf8' });
  assert.equal(absent.status, 2);
  assert.equal(JSON.parse(absent.stdout).complete, false);
});

test('verification flags plausible literals, reports review findings, and preserves incomplete status', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'idaas-nodejs-verify-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const literal = 'LTAI' + 'example0123456789';
  writeFileSync(join(root, 'service.Dockerfile'), 'ENV ALIBABA_CLOUD_ACCESS_KEY_ID=' + literal);
  const verify = () => spawnSync(process.execPath, [scanner, root, '--verify'], { encoding: 'utf8' });

  const blocked = verify();
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.ok(!blocked.stdout.includes(literal));
  assert.deepEqual(JSON.parse(blocked.stdout).violations.map(({ type }) => type).sort(),
    ['access_key_literal', 'config_plaintext_credential']);
  writeFileSync(join(root, 'service.Dockerfile'), 'ENV ALIBABA_CLOUD_ACCESS_KEY_ID=$FROM_ENV');
  const review = verify();
  assert.equal(review.status, 1, review.stderr);
  assert.equal(JSON.parse(review.stdout).auth.reason, 'no_production_sources');
  assert.deepEqual(JSON.parse(review.stdout).warnings, [
    { path: 'service.Dockerfile', line: 1, type: 'credential_env' },
  ]);
  writeFileSync(join(root, 'invalid.js'), Buffer.from([0xff]));
  const incomplete = verify();
  assert.equal(incomplete.status, 2, incomplete.stderr);
  assert.equal(JSON.parse(incomplete.stdout).ok, false);
});
