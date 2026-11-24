import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigException, PAM_SCOPE, loadConfig, validateConfig } from '@cloud-idaas/core-sdk';

const sdkDir = join(homedir(), '.cloud_idaas');
const placeholder = /(?:REPLACE[_-]?ME|CHANGE[_-]?ME|^\s*\$\{|^\s*<[^>]+>)/i;
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const pilotKeys = ['instance-id', 'client-id', 'issuer', 'token-endpoint', 'developer-endpoint', 'out'];

function absolute(path) {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path);
}

export function configPath(explicit, env = process.env) {
  return absolute(explicit ?? (env.CLOUD_IDAAS_CONFIG_PATH || join(sdkDir, 'client-config.json')));
}

function problemsFor(config, phase, env) {
  const problems = [];
  const auth = config.authnConfiguration;
  if (typeof config.developerApiEndpoint !== 'string' || !config.developerApiEndpoint.trim()) {
    problems.push('developerApiEndpoint is required for PAM');
  }
  const fields = { idaasInstanceId: config.idaasInstanceId, clientId: config.clientId, issuer: config.issuer,
    tokenEndpoint: config.tokenEndpoint, scope: config.scope, developerApiEndpoint: config.developerApiEndpoint,
    ...Object.fromEntries(['applicationFederatedCredentialName', 'clientSecretEnvVarName', 'privateKeyEnvVarName',
      'oidcTokenFilePath', 'oidcTokenFilePathEnvVarName', 'pluginName'].map((key) => ['authnConfiguration.' + key, auth[key]])) };
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && placeholder.test(value)) problems.push(key + ' contains a placeholder');
  }
  if (auth.authnMethod === 'PKCS7' && !['ALIBABA_CLOUD_ECS', 'AWS_EC2'].includes(auth.clientDeployEnvironment)) {
    problems.push('PKCS7 requires an SDK-supported deployment environment');
  }
  const oidcPath = auth.oidcTokenFilePath || auth.oidcTokenFilePathEnvVarName;
  if (auth.authnMethod === 'OIDC' && !oidcPath &&
      !['KUBERNETES', 'ALIBABA_CLOUD_ACK', 'AWS_EKS', 'AWS_ESK'].includes(auth.clientDeployEnvironment)) {
    problems.push('OIDC requires a Kubernetes-compatible deployment or an explicit token file source');
  }
  const credentialFields = [];
  if (auth.authnMethod.startsWith('CLIENT_SECRET_')) credentialFields.push('clientSecretEnvVarName');
  if (['PRIVATE_KEY_JWT', 'PCA'].includes(auth.authnMethod)) credentialFields.push('privateKeyEnvVarName');
  if (auth.authnMethod === 'OIDC' && !auth.oidcTokenFilePath && auth.oidcTokenFilePathEnvVarName) {
    credentialFields.push('oidcTokenFilePathEnvVarName');
  }
  for (const field of credentialFields) {
    const name = auth[field];
    if (typeof name !== 'string' || !envName.test(name)) {
      problems.push('authnConfiguration.' + field + ' must name an environment variable');
    } else if (phase === 'runtime' && !env[name]?.trim()) {
      problems.push('Missing runtime variable: ' + name);
    }
  }
  if (phase === 'runtime' && !env.ALIBABA_CLOUD_ROLE_ARN?.trim()) {
    problems.push('Missing runtime variable: ALIBABA_CLOUD_ROLE_ARN');
  }
  return { problems, credentialVariables: credentialFields.map((field) => auth[field]).filter((name) => envName.test(name)) };
}

export async function checkConfig(file, phase, env = process.env) {
  const path = configPath(file, env);
  try {
    const configuration = await loadConfig(path);
    const { problems, credentialVariables } = problemsFor(configuration, phase, env);
    return { ok: problems.length === 0, config: path, phase, problems, credentialVariables };
  } catch (error) {
    const code = error instanceof ConfigException ? error.errorCode : undefined;
    return { ok: false, config: path, phase, problems: ['Core rejected the configuration' + (code ? ': ' + code : '')] };
  }
}

async function canonical(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}

async function render(options) {
  const missing = pilotKeys.filter((key) => !options[key]?.trim()).map((key) => '--' + key);
  if (missing.length) return { ok: false, problems: ['Render requires ' + missing.join(', ')] };
  const federatedName = options['federated-credential-name'] ?? 'REPLACE_ME_federated_credential';
  const auth = options.deploy === 'secret' ? { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: 'IDAAS_CLIENT_SECRET' } :
    { authnMethod: options.deploy === 'ecs' ? 'PKCS7' : 'OIDC',
      clientDeployEnvironment: options.deploy === 'ecs' ? 'ALIBABA_CLOUD_ECS' : 'KUBERNETES',
      applicationFederatedCredentialName: federatedName };
  const config = {
    idaasInstanceId: options['instance-id'], clientId: options['client-id'],
    issuer: options.issuer, tokenEndpoint: options['token-endpoint'],
    developerApiEndpoint: options['developer-endpoint'], scope: PAM_SCOPE,
    authnConfiguration: { identityType: 'CLIENT', ...auth },
    httpConfiguration: { connectTimeout: 5000, readTimeout: 10000 },
  };
  try {
    validateConfig(config);
    const destination = await canonical(absolute(options.out));
    const fromSdk = relative(await canonical(sdkDir), destination);
    if (!fromSdk || (!isAbsolute(fromSdk) && fromSdk !== '..' && !fromSdk.startsWith('../') && !fromSdk.startsWith('..\\'))) {
      return { ok: false, problems: ['Choose a new output outside the SDK default config directory'] };
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(absolute(options.out), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ok: true, phase: 'pilot', written: destination, configurationReady: false,
      nextAction: 'replace_placeholders_and_validate', problems: [] };
  } catch (error) {
    const problem = error instanceof ConfigException ? 'Core rejected the pilot configuration: ' + error.errorCode :
      'Cannot create pilot configuration; choose a writable, new output path';
    return { ok: false, problems: [problem] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let options;
  try {
    ({ values: options } = parseArgs({ options: {
      ...Object.fromEntries([...pilotKeys, 'config', 'federated-credential-name'].map((key) => [key, { type: 'string' }])),
      phase: { type: 'string', default: 'runtime' }, render: { type: 'boolean' }, deploy: { type: 'string', default: 'ecs' },
    } }));
    if (!['code', 'runtime'].includes(options.phase) || !['ecs', 'k8s', 'secret'].includes(options.deploy) ||
        options.config === '' || (!options.render && pilotKeys.some((key) => options[key] !== undefined))) {
      throw new Error('Invalid options');
    }
  } catch {
    console.error('Usage: node check-config.mjs [--config <path>] [--phase code|runtime] or --render --deploy ecs|k8s|secret --instance-id <id> --client-id <id> --issuer <url> --token-endpoint <url> --developer-endpoint <url> --out <new-path>');
    process.exit(2);
  }
  const { credentialVariables, ...result } = options.render
    ? await render(options) : await checkConfig(options.config, options.phase);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
