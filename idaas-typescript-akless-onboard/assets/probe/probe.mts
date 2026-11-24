import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import ECS = require('@alicloud/ecs20140526');
import OpenAPI = require('@alicloud/openapi-core');
import OSS = require('ali-oss');
import { IDaaSCredentialProviderFactory } from '@cloud-idaas/core-sdk';
import {
  createAlibabaCloudCredentialsProvider,
  type IDaaSPamAlibabaCloudCredentialsProvider,
} from '@cloud-idaas/akless-alibabacloud-adapter';

// @alicloud/log 1.2.6 is CommonJS and ships without TypeScript declarations.
const require = createRequire(import.meta.url);
const SLS = require('@alicloud/log') as new (options: {
  region: string;
  use_https: true;
  credentialsProvider: Pick<IDaaSPamAlibabaCloudCredentialsProvider, 'getCredentials'>;
}) => { getLogStore(project: string, logstore: string): Promise<unknown> };

type Provider = IDaaSPamAlibabaCloudCredentialsProvider;
type Request = () => Promise<unknown>;

class InputError extends Error {}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new InputError(`Missing environment variable ${name}`);
  return value;
}

function prepareProbe(service: string, region: string): (provider: Provider) => Promise<Request> {
  switch (service) {
    case 'oss': {
      const bucket = requiredEnv('OSS_BUCKET');
      const key = requiredEnv('OSS_OBJECT_KEY');
      return async (provider) => {
        const client = new OSS({
          ...(await provider.getOSSOptions()),
          // Check the SDK cache for every request so ali-oss cannot reuse an expired snapshot.
          refreshSTSTokenInterval: 0,
          bucket,
          region: `oss-${region}`,
          secure: true,
          authorizationV4: true,
        });
        return () => client.head(key);
      };
    }
    case 'sls': {
      const project = requiredEnv('SLS_PROJECT');
      const logstore = requiredEnv('SLS_LOGSTORE');
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(project)) {
        throw new InputError('SLS_PROJECT must be a DNS label');
      }
      return async (provider) => {
        const client = new SLS({ region, use_https: true, credentialsProvider: provider });
        return () => client.getLogStore(project, logstore);
      };
    }
    case 'openapi':
      return async (provider) => {
        const config = new OpenAPI.$OpenApiUtil.Config({
          regionId: region,
          protocol: 'HTTPS',
          credential: provider.toAlibabaCloudCredential(),
        });
        const client = new ECS.default(config);
        return () => client.describeRegions(new ECS.DescribeRegionsRequest({}));
      };
    default:
      throw new InputError('Usage: node dist/probe.mjs <oss|sls|openapi> [count] [interval-seconds] --allow-cloud-read');
  }
}

function safeErrorFields(error: unknown): Record<string, string | number> {
  if (!error || typeof error !== 'object') return {};
  const fields = error as Record<string, unknown>;
  return Object.fromEntries(Object.entries({
    errorCode: fields.errorCode,
    code: fields.code,
    statusCode: fields.statusCode,
    requestId: fields.requestId ?? fields.requestid,
  }).flatMap<[string, string | number]>(([key, value]) => {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return [[key, value]];
    if (typeof value === 'string' && /^[\w.-]{1,80}$/.test(value)) return [[key, value]];
    return [];
  }));
}

const result = { ok: false, stage: 'inputs', credentialAcquired: false, cloudCalled: false,
  refreshExpiryVerified: false, resourceDenialVerified: false, requestsSucceeded: 0,
  firstExpiration: '', lastSuccess: '', error: {} as Record<string, string | number> };
try {
  if (process.env.DEBUG || process.env.NODE_DEBUG) {
    throw new InputError('Clear DEBUG and NODE_DEBUG before sending signed requests');
  }
  const args = process.argv.slice(2);
  if (args.pop() !== '--allow-cloud-read') {
    throw new InputError('Pass --allow-cloud-read after confirming authorization for the test resource');
  }
  const [service = '', countArg = '1', intervalArg = '60', ...extra] = args;
  const count = Number(countArg);
  const interval = Number(intervalArg);
  if (extra.length || !Number.isSafeInteger(count) || count < 1 ||
      !Number.isSafeInteger(interval) || interval < 1 || interval > 2_147_483) {
    throw new InputError('Provide a positive integer count and an interval from 1 to 2147483 seconds');
  }
  const roleArn = requiredEnv('ALIBABA_CLOUD_ROLE_ARN');
  const region = requiredEnv('ALIBABA_CLOUD_REGION_ID');
  if (!/^[a-z]{2}(?:-[a-z0-9]+)+$/.test(region)) {
    throw new InputError('ALIBABA_CLOUD_REGION_ID must be a region ID such as cn-hangzhou');
  }
  const createProbe = prepareProbe(service, region);
  result.stage = 'idaas_initialization';
  await IDaaSCredentialProviderFactory.init();
  try {
    result.stage = 'pam_provider';
    const provider = createAlibabaCloudCredentialsProvider(roleArn);
    try {
      const { expiration } = await provider.getCredentials();
      result.credentialAcquired = true;
      result.firstExpiration = new Date(expiration).toISOString();
      const request = await createProbe(provider);
      result.stage = 'service_request';
      for (let index = 1; index <= count; index++) {
        if (index > 1) await delay(interval * 1000);
        const requestedAt = Date.now();
        result.cloudCalled = true;
        await request();
        result.requestsSucceeded++;
        result.lastSuccess = new Date().toISOString();
        if (requestedAt >= Date.parse(result.firstExpiration)) result.refreshExpiryVerified = true;
      }
    } finally {
      provider.close();
    }
  } finally {
    await IDaaSCredentialProviderFactory.close();
  }
  result.ok = true;
  result.stage = 'complete';
} catch (error) {
  result.error = error instanceof InputError ? { input: error.message } : safeErrorFields(error);
  process.exitCode = 1;
}
console.log('IDAAS_PROBE_RESULT ' + JSON.stringify(result));
