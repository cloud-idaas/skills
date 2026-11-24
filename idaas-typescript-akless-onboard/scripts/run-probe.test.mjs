import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('prepare creates missing parents and refuses to overwrite an existing destination', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'idaas-probe-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const runner = join(root, 'skill', 'scripts', 'run-probe.mjs');
  const assets = join(root, 'skill', 'assets', 'probe');
  mkdirSync(dirname(runner), { recursive: true });
  mkdirSync(assets, { recursive: true });
  copyFileSync(new URL('./run-probe.mjs', import.meta.url), runner);
  writeFileSync(join(assets, 'package.json'), JSON.stringify({ name: 'probe-fixture', version: '1.0.0', private: true }));

  const output = join(root, 'missing-parent', 'nested', 'probe');
  const args = [runner, '--mode', 'prepare', '--out', output, '--offline-deps'];
  const options = { encoding: 'utf8', env: { ...process.env, npm_config_cache: join(root, 'npm-cache') } };
  const prepared = spawnSync(process.execPath, args, options);
  assert.equal(prepared.status, 0, prepared.stdout || prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).prepared, output);

  const manifest = join(output, 'package.json');
  assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).name, 'probe-fixture');
  writeFileSync(manifest, 'existing output');

  const repeated = spawnSync(process.execPath, args, options);
  assert.equal(repeated.status, 1, repeated.stdout || repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).reason, 'output_directory_creation_failed');
  assert.equal(readFileSync(manifest, 'utf8'), 'existing output');
});
