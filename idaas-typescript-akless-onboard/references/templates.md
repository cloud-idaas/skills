# Node.js 代码与配置改造模板

## 兼容及依赖

- IDaaS TypeScript SDK 面向服务端 Node.js，SDK 支持 Node.js 20、22、24，JavaScript ESM/CommonJS 及 TypeScript 4.7+。本目录的 TypeScript 探针使用 `NodeNext` 和固定 TypeScript 版本构建。
- 示例使用以下已验证组合。为目标项目新增依赖时，用现有包管理器保留兼容的已锁定版本并记录实际解析结果。Core 是应用直接引用的依赖，适配器传递引入 PAM SDK。确认应用与 PAM 解析到同一份 Core。
- 按业务项目使用的包管理器更新 manifest 和锁文件。只添加实际使用的服务客户端。示例的客户端版本见 [package.json](../assets/probe/package.json)。

```sh
npm install @cloud-idaas/core-sdk@0.1.0-beta.1 @cloud-idaas/akless-alibabacloud-adapter@0.1.0-beta.2
```

## 配置和身份

使用平台下发的 SDK 配置文件。Core 查找顺序为显式 `init(path)`、`CLOUD_IDAAS_CONFIG_PATH`、`~/.cloud_idaas/client-config.json`。核对配置里的实例、应用、Issuer、Token Endpoint、`developerApiEndpoint` 及 `authnConfiguration`。当前 TypeScript PAM 默认 provider 明确申请 `urn:cloud:idaas:pam|.all`，确认应用获授该 scope。保留平台下发配置，出现差异先核实对应的应用权限。

- Client Secret 和私钥从配置引用的变量安全注入，核对变量是否非空即可。
- 使用联邦身份时，核对部署环境和平台配置匹配。OIDC 核对联邦凭证与 token 文件来源，ECS PKCS#7 核对受信任的部署身份。
- 将 `ALIBABA_CLOUD_ROLE_ARN` 的值传给 `createAlibabaCloudCredentialsProvider(roleArn)`。该参数在 TypeScript SDK 中称为 `roleExternalId`，在阿里云场景沿用平台已授权的 RAM 角色 ARN。
- 分别核对应用的 PAM 取证权限和目标角色的资源访问权限。

## 通用前置

在进程启动入口初始化一次。使用显式路径时，配置检查与业务进程必须读取同一路径。保持 provider 至最后一个业务请求完成，在应用的关闭钩子上先关闭自有 provider，再关闭共享 Core 工厂。

```js
import { IDaaSCredentialProviderFactory } from '@cloud-idaas/core-sdk';
import { createAlibabaCloudCredentialsProvider } from '@cloud-idaas/akless-alibabacloud-adapter';

const roleArn = process.env.ALIBABA_CLOUD_ROLE_ARN?.trim();
const region = process.env.ALIBABA_CLOUD_REGION_ID?.trim();
if (!roleArn || !region) throw new Error('Configure the role ARN and region');

await IDaaSCredentialProviderFactory.init();
const provider = createAlibabaCloudCredentialsProvider(roleArn);
```

下面各段接在通用前置之后，按项目实际使用的客户端选择。CommonJS 使用各模块的 `require()` 导出，并在异步入口中等待初始化。TypeScript 的完整类型和运行路径见 [探针源码](../assets/probe/probe.mts)。

## OSS

将 `ali-oss` 初始化中的固定 AK/SK 或 STS 改为完整的可刷新选项。保留生产代码原有的 Bucket、地域和网络配置。

```js
import OSS from 'ali-oss';

const oss = new OSS({
  ...(await provider.getOSSOptions()),
  refreshSTSTokenInterval: 0,
  bucket: process.env.OSS_BUCKET,
  region: 'oss-' + region,
  secure: true,
  authorizationV4: true,
});
```

`ali-oss@6.23.0` 在等待刷新回调前推进刷新计时。将 `refreshSTSTokenInterval: 0` 放在 `getOSSOptions()` 的展开之后，让每次请求检查 IDaaS SDK 自有缓存。这样刷新失败后的下一次请求也会检查，实际 PAM 换票仍按需触发。有效间隔无法证明为零时，静态验收要求复核。更换版本时复测这一行为。

## SLS

将构造器中的固定凭证替换为 `credentialsProvider`。`@alicloud/log@1.2.6` 每次签名前调用异步 `getCredentials()`，该版本没有自带 TypeScript 声明。TypeScript 项目可沿用探针中只覆盖所用方法的类型声明。

```js
import SLS from '@alicloud/log';

const sls = new SLS({ region, use_https: true, credentialsProvider: provider });
```

## 通用 OpenAPI

选择支持 Darabonba `Config.credential` 的产品客户端。以下用 ECS 举例，保留项目实际依赖的产品和已有接口。

```js
import ECS from '@alicloud/ecs20140526';
import OpenAPI from '@alicloud/openapi-core';

const config = new OpenAPI.$OpenApiUtil.Config({
  regionId: region,
  protocol: 'HTTPS',
  credential: provider.toAlibabaCloudCredential(),
});
const ecs = new ECS.default(config);
```

### 旧版 RPC / ROA

`@alicloud/pop-core@1.8.0` 的 RPCClient 和 ROAClient 都支持 `credentialsProvider`，每次签名前调用 `getCredentials()`。IDaaS provider 已实现此接口，可以直接传入。保留旧客户端的产品 Endpoint、API 版本和请求方法，删除原有固定凭证字段。下例的 ROA 路径由业务产品和 API 决定。SDK 依据见 [RPC 源码](https://github.com/aliyun/openapi-core-nodejs-sdk/blob/master/lib/rpc.js) 和 [ROA 源码](https://github.com/aliyun/openapi-core-nodejs-sdk/blob/master/lib/roa.js)。

```js
import POP from '@alicloud/pop-core';

const rpc = new POP.RPCClient({
  endpoint: 'https://ecs.aliyuncs.com',
  apiVersion: '2014-05-26',
  credentialsProvider: provider,
});
const roa = new POP.ROAClient({
  endpoint: productEndpoint,
  apiVersion: productApiVersion,
  credentialsProvider: provider,
});
```

无法接收 provider 的旧 SDK 版本先升级到有此接口的版本，或迁到新版 OpenAPI。业务侧不保存一次性凭证快照，不自建刷新线程。只读调用和跨期验证见 [运行验收](verification.md#测试环境验证)。
