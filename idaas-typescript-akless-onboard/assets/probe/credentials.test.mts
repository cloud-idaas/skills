import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ECS = require('@alicloud/ecs20140526');
import OpenAPI = require('@alicloud/openapi-core');
import OSS = require('ali-oss');
import { IDaaSCredentialProviderFactory as Core, PAM_SCOPE } from '@cloud-idaas/core-sdk';
import {
  createAlibabaCloudCredentialsProvider,
  type IDaaSPamAlibabaCloudCredentialsProvider,
} from '@cloud-idaas/akless-alibabacloud-adapter';

const lifetime = 60_000;
const require = createRequire(import.meta.url);
const SLS = require('@alicloud/log') as new (options: {
  endpoint: string;
  credentialsProvider: Pick<IDaaSPamAlibabaCloudCredentialsProvider, 'getCredentials'>;
}) => { getLogStore(project: string, logstore: string): Promise<unknown> };

type LegacyConfig = {
  endpoint: string;
  apiVersion: string;
  credentialsProvider?: Pick<IDaaSPamAlibabaCloudCredentialsProvider, 'getCredentials'>;
  accessKeyId?: string;
  accessKeySecret?: string;
  securityToken?: string;
};
const { RPCClient, ROAClient } = require('@alicloud/pop-core') as {
  RPCClient: new (options: LegacyConfig) => { request(action: string): Promise<unknown> };
  ROAClient: new (options: LegacyConfig) => { request(method: string, path: string): Promise<unknown> };
};

test('OSS, SLS and OpenAPI sign with the rotated STS token and stop on refresh failure', async (t) => {
  let now = Date.now();
  let issued = 0;
  let rejectRefresh = false;
  const provider = createAlibabaCloudCredentialsProvider({
    roleExternalId: 'fixture-role',
    cache: { clock: () => now, logger: { info() {}, warn() {}, error() {} } },
    pamClient: {
      async obtainAccessCredential() {
        if (rejectRefresh) throw new Error('simulated refresh failure');
        issued++;
        return { alibabaCloudStsToken: {
          accessKeyId: 'fixture-ak',
          accessKeySecret: 'fixture-sk',
          securityToken: 'fixture-token-' + issued,
          expiration: new Date(now + lifetime).toISOString(),
        } };
      },
    },
  });
  t.after(() => provider.close());

  const signedRequests: Array<[string | undefined, string | string[] | undefined]> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.has('Action')) {
      assert.ok(url.searchParams.get('Signature'));
      signedRequests.push(['legacy-rpc', url.searchParams.get('SecurityToken') ?? undefined]);
    } else {
      assert.ok(request.headers.authorization);
      signedRequests.push([request.url, request.headers['x-acs-security-token']]);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = '127.0.0.1:' + address.port;

  function captureTokens(tokens: string[]) {
    return {
      async request(_url: string, request: { headers: Record<string, string> }) {
        tokens.push(request.headers['x-oss-security-token']);
        return { status: 200, headers: {}, data: Buffer.alloc(0) };
      },
    };
  }
  const signedTokens: string[] = [];
  const staleTokens: string[] = [];
  const ossOptions = {
    ...(await provider.getOSSOptions()),
    refreshSTSTokenInterval: 0,
    bucket: 'fixture-bucket',
    region: 'oss-cn-hangzhou',
    secure: true,
    authorizationV4: true,
    urllib: captureTokens(signedTokens),
  };
  const oss = new OSS(ossOptions);
  const disabledRefresh = { ...ossOptions, refreshSTSTokenInterval: Infinity, urllib: captureTokens(staleTokens) };
  const ossWithoutRefresh = new OSS(disabledRefresh);

  const slsCredentials = {
    source: provider,
    async getCredentials() { return this.source.getCredentials(); },
  };
  const sls = new SLS({ endpoint, credentialsProvider: slsCredentials });
  const ecs = new ECS.default(new OpenAPI.$OpenApiUtil.Config({
    endpoint,
    protocol: 'HTTP',
    regionId: 'cn-hangzhou',
    credential: provider.toAlibabaCloudCredential(),
  }));
  const legacyConfig = { endpoint: 'http://' + endpoint, apiVersion: '2014-05-26' };
  const legacyRpc = new RPCClient({ ...legacyConfig, credentialsProvider: provider });
  const legacyRoa = new ROAClient({ ...legacyConfig, credentialsProvider: provider });
  const initial = await provider.getCredentials();
  const frozenRpc = new RPCClient({
    ...legacyConfig, accessKeyId: initial.accessKeyId, accessKeySecret: initial.accessKeySecret, securityToken: initial.securityToken,
  });
  const requests = [
    () => oss.head('fixture-object'),
    () => sls.getLogStore('', 'fixture-store'),
    () => ecs.describeRegions(new ECS.DescribeRegionsRequest({})),
    () => legacyRpc.request('DescribeRegions'),
    () => legacyRoa.request('GET', '/fixture-legacy-roa'),
  ];
  for (const request of requests) await request();
  await ossWithoutRefresh.head('fixture-object');
  assert.deepEqual(signedTokens, ['fixture-token-1']);
  assert.deepEqual(signedRequests, [
    ['/logstores/fixture-store?', 'fixture-token-1'],
    ['/', 'fixture-token-1'],
    ['legacy-rpc', 'fixture-token-1'],
    ['/fixture-legacy-roa', 'fixture-token-1'],
  ]);
  assert.equal(issued, 1);

  now += lifetime + 1;
  for (const request of requests) await request();
  await ossWithoutRefresh.head('fixture-object');
  assert.deepEqual(staleTokens, ['fixture-token-1', 'fixture-token-1']);
  assert.deepEqual(signedTokens, ['fixture-token-1', 'fixture-token-2']);
  assert.deepEqual(signedRequests.slice(4), [
    ['/logstores/fixture-store?', 'fixture-token-2'],
    ['/', 'fixture-token-2'],
    ['legacy-rpc', 'fixture-token-2'],
    ['/fixture-legacy-roa', 'fixture-token-2'],
  ]);
  assert.equal(issued, 2);
  await frozenRpc.request('DescribeRegions');
  assert.deepEqual(signedRequests.at(-1), ['legacy-rpc', 'fixture-token-1']);

  rejectRefresh = true;
  now += lifetime + 1;
  for (const request of requests) await assert.rejects(request);
  await assert.rejects(() => oss.head('fixture-object'));
  assert.equal(signedTokens.length, 2);
  assert.equal(signedRequests.length, 9);
});

test('default provider requires completed Core initialization and obtains STS over loopback', async (t) => {
  const envName = 'IDAAS_SKILL_CONTRACT_SECRET';
  const previous = process.env[envName];
  process.env[envName] = 'fixture-client-secret';
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    const isWarmup = request.url === '/token';
    requests.push(isWarmup ? 'machine_token' : 'pam');
    response.setHeader('content-type', 'application/json');
    if (isWarmup) {
      response.end(JSON.stringify({ access_token: 'fixture-machine-token', expires_in: 3600, token_type: 'Bearer' }));
    } else if (request.url?.includes('/actions/obtainAccessCredential') &&
               request.headers.authorization === 'Bearer fixture-machine-token') {
      response.end(JSON.stringify({ cloudAccountRoleAccessCredential: { alibabaCloudStsToken: {
        accessKeyId: 'fixture-access-id', accessKeySecret: 'fixture-access-secret', securityToken: 'fixture-role-token',
        expiration: new Date(Date.now() + 60_000).toISOString(),
      } } }));
    } else {
      response.statusCode = 400;
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = 'http://127.0.0.1:' + address.port;
  const ready = Core.init({
    idaasInstanceId: 'fixture-instance',
    clientId: 'fixture-client',
    issuer: endpoint,
    tokenEndpoint: endpoint + '/token',
    developerApiEndpoint: endpoint,
    scope: PAM_SCOPE,
    authnConfiguration: { authnMethod: 'CLIENT_SECRET_POST', clientSecretEnvVarName: envName },
  });
  try {
    assert.throws(() => createAlibabaCloudCredentialsProvider('fixture-role'), { errorCode: 'IDaaSCredentialProviderFactoryNotInit' });
    await ready;
    const provider = createAlibabaCloudCredentialsProvider('fixture-role');
    try {
      assert.equal((await provider.getCredentials()).securityToken, 'fixture-role-token');
      assert.deepEqual(requests, ['machine_token', 'pam']);
    } finally {
      provider.close();
    }
    await Core.close();
    assert.throws(() => createAlibabaCloudCredentialsProvider('fixture-role'), { errorCode: 'IDaaSCredentialProviderFactoryNotInit' });
  } finally {
    await ready.catch(() => {});
    await Core.close();
  }
});
