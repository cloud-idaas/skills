import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeAuth } from './analyze-auth.mjs';

const excludedDirectories = new Set([
  '.git', 'node_modules', 'bower_components', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  'skill-build', 'vendor', 'testdata', '.idea', '.vscode',
]);
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.cts', '.mts', '.tsx']);
const configExtensions = new Set(['.json', '.yaml', '.yml', '.toml', '.properties', '.ini', '.sh', '.ps1',
  '.tf', '.tfvars', '.xml', '.env', '.cfg', '.conf', '.bash']);
const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']);
const rules = [
  ['cloud_sdk', /['"](?:ali-oss|@alicloud\/[^'"]+|aliyun-sdk)['"]/],
  ['credential_field', /\b(?:access[_-]?key[_-]?(?:id|secret)|secret[_-]?access[_-]?key|security[_-]?token|sts[_-]?token)\b/i],
  ['credential_env', /\b(?:ALIBABA_CLOUD|ALICLOUD|ALIYUN|OSS|SLS)_(?:ACCESS_KEY(?:_(?:ID|SECRET))?|SECRET_ACCESS_KEY|SECURITY_TOKEN|STS_TOKEN)\b/],
  ['access_key_literal', /\bLTAI[A-Za-z\d]{12,}\b/],
  ['manual_sts', /\b(?:assumeRole(?:WithOIDC|WithSAML)?|AssumeRole(?:WithOIDC|WithSAML)?Request|new\s+STS)\b/],
  ['idaas_provider', /\b(?:IDaaSCredentialProviderFactory|createAlibabaCloudCredentialsProvider|getOSSOptions|createSLSCredentialsProvider|toAlibabaCloudCredential)\b/],
];

const [repo, mode, toolsFlag, toolsDir, ...extra] = process.argv.slice(2);
const verify = mode === '--verify';
if (!repo || (mode && !verify) || (toolsFlag && (toolsFlag !== '--tools' || !toolsDir)) || extra.length) {
  console.error('Usage: node scan.mjs <application-repository> [--verify [--tools <prepared-probe>]]');
  process.exit(2);
}

const root = resolve(repo);
const findings = [];
const errors = [];
const sourceFiles = new Map();
const decoder = new TextDecoder('utf-8', { fatal: true });
const credentialName = /(?:^|[._-])(?:access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?(?:access[_-]?)?key|security[_-]?token|credential[_-]?(?:id|secret)|client[_-]?secret)$|(?:[_-]|(?:^|\.)archive\.)(?:ak|sk)$/i;
const configCredentialName = /(?:access[_-]?key(?:[_-]?(?:id|secret))?|secret[_-]?(?:access[_-]?)?key|security[_-]?token|credential[_-]?(?:id|secret)|client[_-]?secret|[_-](?:ak|sk)|archive[.-](?:ak|sk))$/i;
const configAssignment = /(?<![\w.-])(?:-D)?["']?([\w.-]+)["']?\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|\$\{[^}]*\}|\{\{.*?\}\}|[^\s,{}\[\]]+)/g;
const explicitReference = /^\$\{[A-Za-z_][\w.:-]*\}$|^\$[A-Za-z_]\w*$|^%[A-Za-z_]\w*%$|^\{\{.*\}\}$|^<[^>]+>$/;
const marker = /^(?:sample|example|placeholder|dummy|test|fake|null|none|true|false|~|(?:replace|change)[_-]?me(?:[_-][a-z\d_-]+)?|\*+|x{3,})$/i;
const configLimit = 2 * 1024 * 1024;
let scannedFiles = 0;

function isProduction(path) {
  return !/(?:^|[/\\])(?:__tests__|tests?|__mocks__|fixtures)(?:[/\\]|$)/i.test(path) &&
    !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/i.test(path);
}

function scalarValue(raw) {
  const scalar = raw.match(/^\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|.*?)(?:\s+#.*)?$/)?.[1] ?? raw;
  return scalar.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
}

function yamlValue(lines, index, raw, indent) {
  const scalar = scalarValue(raw);
  if (!/^[|>][1-9+-]*$/.test(scalar)) return { value: scalar, end: index + 1 };
  const body = [];
  let end = index + 1;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    body.push(line.trim());
  }
  return { value: body.join(' ').trim(), end };
}

function plainFallback(value) {
  return value.match(/^\$\{[\w.]+:-?([^}]+)\}$/)?.[1] ??
    value.match(/^\$\{[A-Z_][A-Z\d_]*-([^}]+)\}$/)?.[1];
}

function isReference(value) {
  return explicitReference.test(value) && !/^\$\{[A-Z_][A-Z\d_]*-/.test(value) && !/:[^}]+}$/.test(value);
}

function scanYamlEnv(lines, file) {
  const owned = new Set();
  let envIndent;
  let itemIndent;
  let fieldIndent;
  let entry = {};
  function finishItem() {
    if (credentialName.test(entry.name ?? '') && entry.value) {
      const { value, line, end } = entry.value;
      for (let i = line; i < end; i++) owned.add(i);
      if (!entry.valueFrom && value && !marker.test(value) && !isReference(value) &&
          !/^\$\([A-Z_]\w*\)$/i.test(value)) {
        findings.push({ path: file, line: line + 1, type: 'k8s_env_credential_suspect' });
      }
    }
    entry = {};
  }
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    const item = line.match(/^\s*-\s+(name|value|valueFrom)\s*:\s*(.*)$/);
    if (envIndent !== undefined && (indent < envIndent || (indent === envIndent && !item))) {
      finishItem();
      envIndent = itemIndent = fieldIndent = undefined;
    }
    if (envIndent === undefined) {
      if (/^\s*env:\s*(?:#.*)?$/.test(line)) envIndent = indent;
      continue;
    }
    let field;
    if (item && (itemIndent === undefined || itemIndent === indent)) {
      finishItem();
      itemIndent = indent;
      fieldIndent = line.indexOf(item[1], indent + 1);
      field = item;
    } else if (indent === fieldIndent) {
      field = line.match(/^\s*(name|value|valueFrom)\s*:\s*(.*)$/);
    }
    if (!field) continue;
    const [, key, raw] = field;
    if (key === 'name') entry.name = scalarValue(raw);
    if (key === 'valueFrom') entry.valueFrom = true;
    if (key === 'value') entry.value = { line: index, ...yamlValue(lines, index, raw, fieldIndent) };
  }
  finishItem();
  return owned;
}

function scanConfig(lines, file) {
  const yaml = /\.ya?ml$/i.test(file);
  const yamlEnvLines = yaml ? scanYamlEnv(lines, file) : new Set();
  let yamlBlockEnd = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.trim() || /^\s*#/.test(line) || index < yamlBlockEnd || yamlEnvLines.has(index)) continue;
    const indent = line.match(/^\s*/)[0].length;
    const matches = [...line.matchAll(configAssignment)];
    const docker = line.match(/^\s*ENV\s+([\w-]+)\s+(.+?)\s*$/i);
    if (docker && configCredentialName.test(docker[1])) matches.push(docker);
    const types = new Set();
    for (const match of matches) {
      if (!configCredentialName.test(match[1])) continue;
      const { value, end } = yaml ? yamlValue(lines, index, match[2], indent) : { value: scalarValue(match[2]), end: 0 };
      yamlBlockEnd = Math.max(yamlBlockEnd, end);
      if (!value || marker.test(value)) continue;
      const fallback = plainFallback(value);
      if (fallback && !fallback.startsWith('$')) {
        types.add('config_plaintext_credential');
        continue;
      }
      if (isReference(value)) continue;
      if (/^\$|^\{\{|^<[^>]+>$/.test(value)) {
        types.add('config_credential_suspect');
      } else {
        types.add('config_plaintext_credential');
      }
    }
    for (const type of types) findings.push({ path: file, line: index + 1, type });
  }
}

function scanFile(path, isSource) {
  const file = relative(root, path);
  let source;
  try {
    if (!isSource && statSync(path).size > configLimit) {
      errors.push({ path: file, type: 'oversize_config' });
      return;
    }
    source = decoder.decode(readFileSync(path));
  } catch {
    errors.push({ path: file, type: 'unreadable_file' });
    return;
  }

  const lines = source.split(/\r\n|\n|\r/);
  if (isSource && verify) sourceFiles.set(path, source);
  if (isSource && /\b(?:oss|ali-oss)\b/i.test(source) && /\bauthorization\b/i.test(source)) {
    const signer = lines.findIndex((line) => /\b(?:createHmac|HmacSHA[12])\b/i.test(line));
    if (signer >= 0) findings.push({ path: file, line: signer + 1, type: 'manual_oss_signer' });
  }
  if (!isSource) scanConfig(lines, file);
  scannedFiles++;
  for (const [number, line] of lines.entries()) {
    for (const [type, pattern] of rules) {
      if (pattern.test(line)) findings.push({ path: file, line: number + 1, type });
    }
  }
}

function scanDirectory(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    errors.push({ path: relative(root, directory) || '.', type: 'unreadable_directory' });
    return;
  }

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!excludedDirectories.has(entry.name)) scanDirectory(path);
    } else if (entry.isFile() && !lockfiles.has(entry.name)) {
      const name = basename(path).toLowerCase();
      if (
        sourceExtensions.has(extname(name)) || configExtensions.has(extname(name)) ||
        name === '.env' ||
        name.startsWith('.env.') ||
        name === 'dockerfile' ||
        name.startsWith('dockerfile.') ||
        name.endsWith('.dockerfile') ||
        ['jenkinsfile', 'makefile'].includes(name)
      ) scanFile(path, sourceExtensions.has(extname(name)));
    }
  }
}

scanDirectory(root);
const complete = errors.length === 0;
const report = { complete, scannedFiles, findings, errors };
if (verify) {
  let auth = { clients: [], errors: [], findings: [], initializationSites: [],
    syntaxComplete: true, reviewRequired: true, reason: 'no_production_sources', runtimeOrderVerified: false };
  if (sourceFiles.size) {
    const toolRoot = toolsDir ? resolve(toolsDir) : fileURLToPath(new URL('../assets/probe/', import.meta.url));
    try {
      const { default: ts } = await import(pathToFileURL(join(toolRoot, 'node_modules/typescript/lib/typescript.js')));
      auth = analyzeAuth(ts, sourceFiles, (path) => isProduction(relative(root, path)));
      for (const row of [...auth.clients, ...auth.errors, ...auth.findings, ...auth.initializationSites]) {
        row.path = relative(root, row.path);
      }
    } catch {
      auth.errors.push({ type: 'parser_unavailable_or_failed' });
      auth.syntaxComplete = false;
      auth.reason = 'parser_unavailable_or_failed';
    }
  }
  const staticFindingTypes = ['static_credential_env_read', 'static_credential_provider', 'static_credential_literal',
    'initialization_before_provider_unverified'];
  const violations = findings.filter(({ type }) => ['access_key_literal', 'config_plaintext_credential'].includes(type))
    .concat(auth.findings.filter(({ type }) => staticFindingTypes.includes(type)));
  const warnings = findings.filter(({ type }) => ['credential_field', 'credential_env', 'manual_sts',
    'k8s_env_credential_suspect', 'config_credential_suspect', 'manual_oss_signer'].includes(type))
    .concat(auth.findings.filter(({ type }) => !staticFindingTypes.includes(type)));
  for (const { path, line, family, status } of auth.clients) {
    if (status === 'static_auth') violations.push({ path, line, type: status, family });
  }
  if (auth.clients.length && !auth.initializationSites.length && auth.syntaxComplete) {
    violations.push({ type: 'missing_idaas_init' });
  }
  const ok = complete && auth.syntaxComplete && !auth.reviewRequired && violations.length === 0;
  Object.assign(report, { ok, violations, warnings, auth });
  if (!ok) process.exitCode = auth.syntaxComplete ? 1 : 2;
}
console.log(JSON.stringify(report, null, 2));
if (!complete) process.exitCode = 2;
