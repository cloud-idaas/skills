import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scanner = fileURLToPath(new URL('./scan.mjs', import.meta.url));
const tools = process.env.IDAAS_SKILL_TOOLS ?? fileURLToPath(new URL('../assets/probe/', import.meta.url));
const init = "import { IDaaSCredentialProviderFactory as Core } from '@cloud-idaas/core-sdk'; await Core.init();";
const provider = "import { createAlibabaCloudCredentialsProvider as create } from '@cloud-idaas/akless-alibabacloud-adapter'; const source = create(role);";

function verify(t, files) {
  const repo = mkdtempSync(join(tmpdir(), 'idaas-auth-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    const path = join(repo, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  const result = spawnSync(process.execPath, [scanner, repo, '--verify', '--tools', tools], { encoding: 'utf8' });
  assert.ok(result.stdout, result.stderr);
  assert.doesNotMatch(result.stdout, /fixture-secret-value/);
  return { exit: result.status, ...JSON.parse(result.stdout) };
}

test('recognizes approved bindings in source files across ES modules and CommonJS', (t) => {
  const result = verify(t, {
    'oss.mts': init + provider + "\nimport OSS from 'ali-oss'; const options = await source.getOSSOptions(); new OSS({ ...options, refreshSTSTokenInterval: 0 });",
    'sls.cjs': "const Log = require('@alicloud/log'); const {createAlibabaCloudCredentialsProvider: create} = require('@cloud-idaas/akless-alibabacloud-adapter'); const credentialsProvider = create(role); new Log({ credentialsProvider });",
    'ecs.mts': provider + "\nimport ECS from '@alicloud/ecs20140526'; import API from '@alicloud/openapi-core'; const credential = source.toAlibabaCloudCredential(); new ECS.default(new API.$OpenApiUtil.Config({credential}));",
    'legacy.mts': provider + "\nimport { createRequire } from 'node:module'; const require = createRequire(import.meta.url); const { RPCClient } = require('@alicloud/pop-core'); new RPCClient({credentialsProvider: source});",
  });
  assert.equal(result.exit, 0, JSON.stringify(result.auth));
  assert.deepEqual(result.auth.clients.map(({ family, status }) => [family, status]).sort(), [
    ['legacy_openapi', 'idaas_provider'], ['openapi', 'idaas_provider'], ['oss', 'idaas_provider'], ['sls', 'idaas_provider'],
  ]);
  assert.equal(result.auth.initializationSites.length, 1);
});

test('rejects static constructors and fixed STS snapshots even with provider elsewhere', (t) => {
  const result = verify(t, {
    'app.mts': init + provider,
    'bad.mts': "import OSS from 'ali-oss'; import SLS from '@alicloud/log'; import ECS from '@alicloud/ecs20140526';\n" +
      "new OSS({\naccessKeyId: 'fixture-id',\naccessKeySecret: 'fixture-secret-value',\n});\n" +
      "new SLS({ accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret-value' });\n" +
      "new ECS.default({ securityToken: config.token });",
  });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.violations.filter(({ type }) => type === 'static_auth').map(({ family }) => family).sort(),
    ['openapi', 'oss', 'sls']);
});

test('warns on property assignments of provider credentials without flagging returns or comparisons', (t) => {
  const result = verify(t, { 'app.mjs': [
    init, provider, "import SLS from '@alicloud/log'; new SLS({ credentialsProvider: source });",
    'class Session {',
    '  async cache() { this.creds = await source.getCredentials(); }',
    '  pending() { this.pendingCreds = source.getCredentials(); }',
    '  async fresh() { return await source.getCredentials(); }',
    '  async matches() { return this.creds === await source.getCredentials(); }',
    '}',
  ].join('\n') });
  assert.equal(result.exit, 0);
  assert.deepEqual(result.warnings.filter(({ type }) => type === 'credential_cache_suspect'), [
    { path: 'app.mjs', line: 5, type: 'credential_cache_suspect' },
    { path: 'app.mjs', line: 6, type: 'credential_cache_suspect' },
  ]);
});

test('downgrades mutated aliases and blocks direct environment reads and fixed provider snapshots', (t) => {
  const result = verify(t, {
    'app.mts': init + provider + "\nimport OSS from 'ali-oss'; import SLS from '@alicloud/log';" +
      "\nconst opts = { credentialsProvider: source }; const alias = opts; alias.credentialsProvider = custom;" +
      "\nnew SLS(opts); new OSS({...await source.getCredentials()}); const secret = process.env.OSS_ACCESS_KEY_SECRET;",
  });
  assert.equal(result.exit, 1);
  assert.ok(result.auth.clients.some(({ family, status }) => family === 'sls' && status === 'unresolved'));
  assert.ok(result.violations.some(({ family, type }) => family === 'oss' && type === 'static_auth'));
  assert.ok(result.violations.some(({ type }) => type === 'static_credential_env_read'));
});

test('never passes unknown bindings, empty repositories, test-only clients, or parse errors', (t) => {
  for (const files of [{}, { 'app.test.mts': init + provider }, {
    'app.mts': init + "\nimport SLS from '@alicloud/log'; import { cred } from './other.mjs'; new SLS({ credentialsProvider: cred });",
  }, { 'app.mts': init + '\nconst broken = ;' }]) {
    const result = verify(t, files);
    assert.equal(result.ok, false);
    assert.ok(result.auth.reviewRequired || !result.auth.syntaxComplete);
    assert.notEqual(result.exit, 0);
  }
});

test('keeps config warnings and blocks likely plaintext without reporting values', (t) => {
  const result = verify(t, {
    '.env': 'ALIBABA_CLOUD_ACCESS_KEY_SECRET=fixture-secret-value',
    'deployment.yaml': 'env:\n  - name: ALIBABA_CLOUD_ACCESS_KEY_SECRET\n    value: fixture-secret-value',
  });
  assert.equal(result.exit, 1);
  assert.ok(result.violations.some(({ type }) => type === 'config_plaintext_credential'));
  assert.ok(result.warnings.some(({ type }) => type === 'k8s_env_credential_suspect'));
});

test('finds inline JSON, YAML blocks and shell fallback values and preserves explicit references', (t) => {
  const result = verify(t, {
    'settings.json': '{"nested":{"credentialSecret":"fixture-secret-value"}}',
    'application.yaml': 'component:\n  clientSecret: |-\n    fixture-secret-value\n',
    'Jenkinsfile': 'SERVER_SK=${DEPLOY_PASSWORD:-fixture-secret-value}',
    'Makefile': 'export CLIENT_SECRET=${DEPLOY_PASSWORD}',
    'docker.conf': 'CLIENT_SECRET = example',
  });
  assert.deepEqual(result.violations.map(({ path }) => path).sort(),
    ['Jenkinsfile', 'application.yaml', 'settings.json']);
});

test('separates static official credential instances from default-chain warnings', (t) => {
  const result = verify(t, {
    'app.mts': init + provider + "\nimport Credential from '@alicloud/credentials'; import SLS from '@alicloud/log';" +
      "\nnew SLS({credentialsProvider: source}); new Credential(); new Credential({type: 'sts', securityToken:'fixture-secret-value'});",
  });
  assert.ok(result.violations.some(({ type }) => type === 'static_credential_provider'));
  assert.ok(result.warnings.some(({ type }) => type === 'default_credential_chain'));
});

const migrated = init + provider + "\nimport SLS from '@alicloud/log'; new SLS({credentialsProvider: source});";

test('parity 1: resolves literal dynamic imports and rejects static credentials', (t) => {
  const load = "\nconst { default: OSS } = await import('ali-oss');";
  const staticClient = verify(t, {
    'app.mts': migrated + load + "new OSS({accessKeyId:'fixture-id',accessKeySecret:'fixture-secret-value'});",
  });
  assert.equal(staticClient.exit, 1, JSON.stringify(staticClient.auth));
  assert.ok(staticClient.violations.some(({ family, type }) => family === 'oss' && type === 'static_auth'));
  const dynamicClient = verify(t, {
    'app.mts': migrated + load + "new OSS({...await source.getOSSOptions(),refreshSTSTokenInterval:0});",
  });
  assert.equal(dynamicClient.exit, 0, JSON.stringify(dynamicClient.auth));
  assert.ok(dynamicClient.auth.clients.some(({ family, status }) => family === 'oss' && status === 'idaas_provider'));
  const conditionalImport = verify(t, {
    'app.mts': migrated + "\nimport OSS from 'ali-oss'; new OSS({...await source.getOSSOptions(),refreshSTSTokenInterval:0});" +
      "if (flag) {const {default:LazyOSS} = await import(`ali-oss`,{}); new LazyOSS(credentialsFromElsewhere);}",
  });
  assert.equal(conditionalImport.exit, 1);
  assert.ok(conditionalImport.auth.clients.some(({ family, status }) => family === 'oss' && status === 'unresolved'));
});

test('parity 1: recognizes an async SLS wrapper that delegates every credential call', (t) => {
  const result = verify(t, {
    'app.mts': init + provider + "\nimport SLS from '@alicloud/log';" +
      "const wrapped = {async getCredentials() {return await source.getCredentials();}};" +
      "new SLS({credentialsProvider:wrapped});",
  });
  assert.equal(result.exit, 0, JSON.stringify(result.auth));
  assert.equal(result.auth.clients[0].status, 'idaas_provider');
  const fixed = verify(t, {
    'app.mts': init + provider + "\nimport SLS from '@alicloud/log'; const cached = await source.getCredentials();" +
      "new SLS({credentialsProvider:{async getCredentials(){return cached;}}});",
  });
  assert.equal(fixed.exit, 1);
  assert.equal(fixed.auth.clients[0].status, 'unresolved');
});

test('parity 2: conditional clients and initialization cannot establish migration', (t) => {
  const branch = verify(t, {
    'app.mts': migrated + "\nimport OSS from 'ali-oss'; if (false) new OSS({...await source.getOSSOptions(),refreshSTSTokenInterval:0});",
  });
  assert.equal(branch.exit, 1, JSON.stringify(branch.auth));
  assert.ok(branch.auth.clients.some(({ family, status }) => family === 'oss' && status === 'unresolved'));
  const conditionalInit = verify(t, { 'app.mts': migrated.replace('await Core.init();', 'if (false) await Core.init();') });
  assert.equal(conditionalInit.exit, 1);
  assert.ok(conditionalInit.violations.some(({ type }) => type === 'missing_idaas_init'));
  const conditionalDefinition = verify(t, {
    'app.mts': init + "\nimport SLS from '@alicloud/log';" +
      "import { createAlibabaCloudCredentialsProvider as create } from '@cloud-idaas/akless-alibabacloud-adapter';" +
      "if (flag) { var maybe = create(role); } new SLS({credentialsProvider:maybe});",
  });
  assert.equal(conditionalDefinition.exit, 1);
});

test('parity 3: blocks environment destructuring and plaintext fields outside a recognized constructor', (t) => {
  const result = verify(t, {
    'app.mts': migrated + "\nconst env = process.env; const { OSS_ACCESS_KEY_SECRET: secret } = env;" +
      "const options = {accessKeySecret:'fixture-secret-value'}; customClient(options, secret);" +
      "const { ALIBABA_CLOUD_ROLE_ARN } = process.env; const empty = {accessKeySecret:''};",
    'client.spec.mts': "const { ACCESS_KEY_ID } = process['env']; void ACCESS_KEY_ID;",
  });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.violations.map(({ path, type }) => [path, type]).sort(), [
    ['app.mts', 'static_credential_env_read'], ['app.mts', 'static_credential_literal'],
    ['client.spec.mts', 'static_credential_env_read'],
  ]);
  assert.deepEqual(result.auth.clients.map(({ path }) => path), ['app.mts']);
  const assigned = verify(t, {
    'app.mts': migrated + "\nif (legacyFlag) { const env=process.env; ({OSS_ACCESS_KEY_SECRET:secret}=env);" +
      "const value='fixture-secret-value'; options.accessKeySecret=value; }",
  });
  assert.equal(assigned.exit, 1);
  assert.deepEqual(assigned.violations.map(({ type }) => type).sort(),
    ['static_credential_env_read', 'static_credential_literal']);
});

test('parity 4: handles reordered YAML env fields without warning on references', (t) => {
  const result = verify(t, {
    'app.mts': migrated,
    'reordered.yaml': 'env:\n  - value: fixture-secret-value\n    name: OSS_ACCESS_KEY_SECRET\n',
    'reference.yaml': 'env:\n  - name: OSS_ACCESS_KEY_SECRET\n    value: "${DEPLOY_SECRET}"\n',
    'ci-reference.yaml': 'env:\n  - name: OSS_ACCESS_KEY_SECRET\n    value: "$(DEPLOY_SECRET)"\n',
    'value-from.yaml': 'env:\n  - valueFrom:\n      secretKeyRef:\n        name: credentials\n        key: current\n    name: OSS_ACCESS_KEY_SECRET\n',
    'non-env.yaml': 'metadata:\n  - name: OSS_ACCESS_KEY_SECRET\n    value: fixture-secret-value\n',
  });
  assert.equal(result.exit, 0);
  assert.deepEqual(result.warnings.filter(({ type }) => type === 'k8s_env_credential_suspect')
    .map(({ path, line }) => [path, line]), [['reordered.yaml', 2]]);
});

test('parity 4: blocks dotted keys and plain shell defaults while keeping real references', (t) => {
  const result = verify(t, {
    'app.mts': migrated,
    'service.properties': 'credentials.accessKeySecret=fixture-secret-value',
    '.env': 'OSS_ACCESS_KEY_SECRET=${DEPLOY_SECRET-fixture-secret-value}',
    '.env.example': 'OSS_ACCESS_KEY_SECRET=${DEPLOY_SECRET-example}',
    'references.properties': 'credentials.accessKeySecret=${deployment-secret}\n',
  });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.violations.map(({ path, type }) => [path, type]).sort(), [
    ['.env', 'config_plaintext_credential'], ['.env.example', 'config_plaintext_credential'],
    ['service.properties', 'config_plaintext_credential'],
  ]);
});

test('parity 5: cannot pass a disabled, delayed or unproven OSS refresh interval', (t) => {
  const setup = migrated + "\nimport OSS from 'ali-oss'; const options = await source.getOSSOptions();";
  for (const interval of ['Infinity', 'Number.POSITIVE_INFINITY', '60_000', 'fromConfig()', 'undefined']) {
    const result = verify(t, { 'app.mts': setup + "new OSS({...options,refreshSTSTokenInterval:" + interval + "});" });
    assert.equal(result.exit, 1, interval);
    assert.ok(result.auth.clients.some(({ family, status }) => family === 'oss' && status === 'unresolved'));
  }
  assert.equal(verify(t, { 'app.mts': setup + "new OSS(options);" }).exit, 1);
  assert.equal(verify(t, { 'app.mts': setup + "new OSS({refreshSTSTokenInterval:0,...options});" }).exit, 1);
  const zero = verify(t, { 'app.mts': setup + "const interval = 0; new OSS({...options,refreshSTSTokenInterval:interval});" });
  assert.equal(zero.exit, 0, JSON.stringify(zero.auth));
});

test('alignment: testdata and vendored code do not count as production', (t) => {
  for (const path of ['testdata/client.mts', 'packages/shared/vendor/client.mts']) {
    const result = verify(t, { [path]: migrated });
    assert.equal(result.exit, 1, path);
    assert.equal(result.auth.reason, 'no_production_sources');
  }
  assert.equal(verify(t, { 'bin/app.mts': migrated }).exit, 0);
});

test('alignment: resolves constant module names through import and require', (t) => {
  for (const load of ["const {default: OSS} = await import(pkg);", "const OSS = require(pkg);"]) {
    const result = verify(t, {
      'app.mts': migrated + "\nconst prefix='ali-'; const pkg=prefix + 'oss'; " + load +
        "new OSS({accessKeyId:fromConfig,accessKeySecret:fromConfig});",
    });
    assert.equal(result.exit, 1);
    assert.ok(result.violations.some(({ family, type }) => family === 'oss' && type === 'static_auth'));
  }
});

test('alignment: ignores type-only imports while checking mixed imports for runtime bindings', (t) => {
  const types = "\nimport type Legacy from '@alicloud/pop-core';\nimport { type Client } from '@alicloud/ecs20140526';";
  assert.equal(verify(t, { 'app.mts': migrated + types }).exit, 0);
  for (const bindings of ['default as ECS, type Client', '']) {
    const result = verify(t, { 'app.mts': migrated + types.replace('type Client', bindings) });
    assert.equal(result.exit, 1);
    assert.ok(result.auth.reviewRequired);
  }
});

test('alignment: traces a provider stored on the wrapper without accepting fixed snapshots', (t) => {
  const source = migrated.split('new SLS')[0];
  for (const providerField of ['source', 'provider: source']) {
    const member = providerField.split(':')[0];
    const safe = source + "new SLS({credentialsProvider:{" + providerField +
      ", async getCredentials(){return this." + member + ".getCredentials();}}});";
    assert.equal(verify(t, { 'app.mts': safe }).exit, 0);
    const bad = safe.replace('this.' + member + '.getCredentials()', 'this.' + member);
    assert.equal(verify(t, { 'app.mts': bad }).exit, 1);
  }
  const copied = source + "const wrapped={source,async getCredentials(){return this.source.getCredentials();}};" +
    "new SLS({credentialsProvider:{getCredentials:wrapped.getCredentials}});";
  assert.equal(verify(t, { 'app.mts': copied }).exit, 1);
});

test('alignment: waits for Core initialization before using the default provider', (t) => {
  for (const bad of [
    migrated.replace('await Core.init();', 'Core.init();'),
    migrated.replace('await Core.init();', 'const pending=Core.init();') + '\nawait pending;',
    migrated.replace('await Core.init();', 'async function setup(){await Core.init();}'),
    migrated.replace('await Core.init();', 'await Promise.race([Core.init(), anotherTask()]);'),
    migrated.replace('await Core.init();', 'await Core.init().catch(()=>{});'),
    migrated.replace('await Core.init();', 'await Core.init(); await Core.close();'),
  ]) {
    assert.equal(verify(t, { 'app.mts': bad }).exit, 1, bad);
  }
  for (const good of [
    migrated,
    migrated.replace('await Core.init();', 'const ready=Core.init(); const startup=ready; await startup;'),
    migrated.replace('await Core.init();', 'async function setup(){await Core.init();} await setup();'),
    migrated.replace('await Core.init();', 'await Promise.all([Core.init(), anotherTask()]);'),
    migrated + 'await Core.close();',
  ]) {
    assert.equal(verify(t, { 'app.mts': good }).exit, 0, good);
  }
});

test('alignment: code after an unconditional return cannot establish initialization or a production binding', (t) => {
  const result = verify(t, {
    'app.mts': init.replace('await Core.init();', '') + provider.split('const source')[0] +
      "import SLS from '@alicloud/log'; async function start(){ return; await Core.init();" +
      "const source=create('fixture'); new SLS({credentialsProvider:source}); } await start();",
  });
  assert.equal(result.exit, 1);
  assert.equal(result.auth.initializationSites.length, 0);
  assert.ok(result.auth.clients.some(({ status }) => status === 'unresolved'));
});

test('alignment: follows named environment reads through constant keys and process aliases', (t) => {
  const cases = [
    "const key='OSS_ACCESS_KEY_SECRET'; consume(process.env[key]);",
    "const {env: runtime}=process; const {OSS_ACCESS_KEY_SECRET}=runtime; consume(OSS_ACCESS_KEY_SECRET);",
    "import processAlias from 'node:process'; const runtime=processAlias['env']; const key='ACCESS_KEY_ID'; consume(runtime[key]);",
    "const key='OSS_ACCESS_KEY_SECRET'; consume(globalThis.process.env[key]);",
  ];
  for (const code of cases) {
    const result = verify(t, { 'app.mts': migrated + '\n' + code });
    assert.equal(result.exit, 1, code);
    assert.ok(result.violations.some(({ type }) => type === 'static_credential_env_read'));
  }
  assert.equal(verify(t, { 'app.mts': migrated + "\nconst process={env:{OSS_ACCESS_KEY_SECRET:'fixture'}}; consume(process.env['OSS_ACCESS_KEY_SECRET']);" }).exit, 0);
});

test('alignment: scans camel-prefixed credential names in config and preserves references', (t) => {
  const result = verify(t, {
    'app.mts': migrated,
    'service.properties': 'idaasClientSecret=fixture-secret-value\nmyAccessKeyId=fixture-access-id',
    'dynamic.properties': 'idaasClientSecret=${APP_SECRET}',
    'environment.yaml': 'env:\n  - name: IDAAS_CLIENT_SECRET\n    value: fixture-secret-value\n',
  });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.violations.map(({ path, line }) => [path, line]), [
    ['service.properties', 1], ['service.properties', 2],
  ]);
  assert.ok(result.warnings.some(({ path, type }) => path === 'environment.yaml' && type === 'k8s_env_credential_suspect'));
});

test('alignment: does not trust options rewritten through Reflect or its aliases', (t) => {
  const setup = migrated + "\nimport OSS from 'ali-oss'; const options={...await source.getOSSOptions(),refreshSTSTokenInterval:0};";
  for (const write of [
    "Reflect.set(options,'refreshSTSTokenInterval',Infinity);",
    "const alias=options; const set=Reflect['set']; set(alias,'refreshSTSTokenInterval',Infinity);",
    "Reflect.defineProperty(options,'refreshSTSTokenInterval',{value:Infinity});",
    "Reflect.deleteProperty(options,'refreshSTSTokenInterval');",
  ]) {
    const result = verify(t, { 'app.mts': setup + write + 'new OSS(options);' });
    assert.equal(result.exit, 1, write);
    assert.ok(result.auth.clients.some(({ family, status }) => family === 'oss' && status === 'unresolved'));
  }
});

test('alignment: follows mutations through object members, destructuring and unproven configuration helpers', (t) => {
  const setup = migrated + "\nimport OSS from 'ali-oss'; const options={...await source.getOSSOptions(),refreshSTSTokenInterval:0};";
  for (const write of [
    "const holder={options}; const alias=holder.options; Reflect.set(alias,'refreshSTSTokenInterval',Infinity);",
    "const holder={options}; holder.options.refreshSTSTokenInterval=Infinity;",
    "const holder={options}; const {options:alias}=holder; Reflect.set(alias,'refreshSTSTokenInterval',Infinity);",
    "const holder={options}; configure(holder);",
  ]) {
    const result = verify(t, { 'app.mts': setup + write + 'new OSS(options);' });
    assert.equal(result.exit, 1, write);
    assert.ok(result.auth.clients.some(({ family, status }) => family === 'oss' && status === 'unresolved'));
  }
  const frozen = verify(t, { 'app.mts': setup + 'Object.freeze(options); new OSS(options);' });
  assert.equal(frozen.exit, 0, JSON.stringify(frozen.auth));
  const independent = verify(t, {
    'app.mts': setup + "\nconst copy={...options}; Reflect.set(copy,'refreshSTSTokenInterval',Infinity); new OSS(options);",
  });
  assert.equal(independent.exit, 0, JSON.stringify(independent.auth));
  for (const projection of [
    "const project='fixture-project'; const options={project,credentialsProvider:source}; log(project);",
    "const project=process.env.SLS_PROJECT; const options={project,credentialsProvider:source}; log(project);",
    "const options={project:'fixture-project',credentialsProvider:source}; const {project}=options; log(project);",
    "const options={project:'fixture-project',credentialsProvider:source}; log(options.project);",
  ]) {
    const result = verify(t, { 'app.mts': migrated + projection + 'new SLS(options);' });
    assert.equal(result.exit, 0, JSON.stringify(result.auth));
  }
});
