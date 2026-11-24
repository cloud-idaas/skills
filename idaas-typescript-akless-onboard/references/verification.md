# Node.js 无 AK 验证

## 准备探针

在隔离目录安装 [探针依赖](../assets/probe/)。创建一个新的探针子目录，保持业务仓库和 Skill 安装目录干净。`<skill-dir>` 使用绝对路径。依赖已缓存时可传 `--offline-deps`。

```sh
probe_dir="$(mktemp -d)/probe"
node "<skill-dir>/scripts/run-probe.mjs" --mode prepare --out "$probe_dir"
```

## 配置检查

使用探针目录中与示例同版本的 Core SDK 读取配置。现有配置可在改造前检查，可将 `--config` 省略以复用 SDK 的环境变量和默认路径。

```sh
node "$probe_dir/check-config.mjs" --config /absolute/path/client-config.json --phase code
node "$probe_dir/check-config.mjs" --config /absolute/path/client-config.json --phase runtime
```

`code` 检查 JSON、SDK 字段、PAM 端点、关键占位符和 SDK 支持的联邦部署组合。失败时可继续扫描和独立代码检查，运行前须修正配置。`runtime` 另外检查角色 ARN 和所需变量是否非空，只报告变量名，默认即此阶段。联邦身份可用性由实际运行验收。两个阶段均不向云端发请求。

用户要求生成试点配置时，显式传 `--render --out`。输出用新文件，拒绝覆盖或写入 SDK 默认目录。以下以 Kubernetes 为例，也可选择 `ecs` 或 `secret`。输出仅表示可以补全的试点结构，替换占位符后再执行正式检查。

```sh
node "$probe_dir/check-config.mjs" --render --deploy k8s \
  --instance-id '<instance-id>' --client-id '<client-id>' --issuer '<issuer-url>' \
  --token-endpoint '<token-url>' --developer-endpoint '<developer-url>' --out '<new-file>'
```

## 离线验证

1. 执行 `node "<skill-dir>/scripts/scan.mjs" "<repo>" --verify --tools "$probe_dir"`。词法报告及 TypeScript/JavaScript 语法树报告一起输出。分析使用隔离探针固定的 TypeScript 编译器，业务文件只被解析，不加载业务依赖、执行应用代码或读取项目编译插件。
2. 检查 `auth.clients`。`idaas_provider` 表示识别到同文件的动态绑定。修复 `static_auth`，复核 `unresolved` 和无生产客户端的报告。分析支持可解析为常量的 CommonJS 和动态导入，也能追踪直接或经同一对象成员逐次取证的异步 SLS 包装。条件控制流、已改写的配置、传入无法分析的配置函数、或无法证明刷新间隔为零的 OSS 绑定要求复核。核对 `initializationSites`，确认同作用域内先等待 Core 初始化完成再创建默认 provider。跨文件或依赖注入的实际启动顺序须按入口核对。逐项处理 [扫描告警](scanning.md)。退出码 1 表示阻断或需人工复核，2 表示读取或解析不完整。
3. 按 [构建与验证](build.md) 构建受影响的业务包，分别记录实际命令和结果。
4. 执行 `node "<skill-dir>/scripts/run-probe.mjs" --mode contract`（依赖已缓存时可加 `--offline-deps`）。实际 SDK 使用回环端点验证 Core 初始化完成顺序和 PAM 取证，并用受控时钟验证 OSS、SLS、新旧 OpenAPI 的首次签名、轮转和刷新失败。固定快照及 OSS 关闭刷新会继续用旧令牌签名，探针包含这两个反例。探针通过只证明参考客户端的契约。

## 测试环境验证

先按 [配置与身份](templates.md#配置和身份) 核对配置与部署身份，在已获授权的环境注入以下变量。三个探针启动时都通过实际 SDK 初始化并向 PAM 取证。示例输出阶段、首次 STS 到期时间、请求序号和成功状态。

| 环境变量 | 用途 |
| --- | --- |
| `CLOUD_IDAAS_CONFIG_PATH` | 平台下发的配置文件绝对路径。未显式注入时使用 SDK 默认路径。 |
| `ALIBABA_CLOUD_ROLE_ARN` | 平台已授权的 RAM 角色 ARN。 |
| `ALIBABA_CLOUD_REGION_ID` | 目标地域，例如 `cn-hangzhou`。 |
| `OSS_BUCKET`、`OSS_OBJECT_KEY` | OSS 已授权的测试对象。 |
| `SLS_PROJECT`、`SLS_LOGSTORE` | SLS 已授权的测试 Logstore。 |

运行验收使用与业务进程一致的配置和身份。探针先做运行配置检查，关闭 SDK 调试输出，并仅呈现结构化结果。许可仅限固定只读请求。默认执行 ECS `DescribeRegions`，按批准的资源也可选择 OSS `head` 或 SLS `getLogStore`。

```sh
node "<skill-dir>/scripts/run-probe.mjs" --mode smoke --allow-cloud-read \
  --config /absolute/path/client-config.json --region cn-hangzhou
node "<skill-dir>/scripts/run-probe.mjs" --mode smoke --service oss --allow-cloud-read
node "<skill-dir>/scripts/run-probe.mjs" --mode smoke --service sls --allow-cloud-read
```

可用 `--count 70 --interval 60` 让同一客户端跨期发起请求。根据首批 STS 到期时间选择足够长的运行时间。`refreshExpiryVerified` 只在首批到期后发起的请求成功时为真。`cloudCalled` 表示已尝试业务 SDK 请求，仍可能在发送前失败；`requestsSucceeded` 记录实际成功数。权限拒绝须另用经过批准的受限资源对照核实，单次只读探针不推断这个结果。记录测试环境、角色、版本、时间、成功数及脱敏错误字段。

| 失败情况 | 排查方法 |
| --- | --- |
| 依赖缺失或编译失败 | 对照探针依赖与锁文件运行 `npm ls`，核对 Node.js、模块制式、SDK 版本以及实际使用的服务客户端。 |
| 配置错误或初始化失败 | 核查实际加载路径、应用与实例标识、Token Endpoint、PAM scope 及部署身份来源。通过无效路径或缺失的配置变量验证错误，恢复后再运行。 |
| 权限不足 | 区分初始化、PAM 取证、服务调用三个阶段。依次核对应用取证权限与 RAM 角色的资源或 Action 权限。权限对照使用已批准的受限测试角色或资源。 |
| 凭证失效或刷新失败 | 核对客户端仍引用 provider、刷新回调仍生效，以及部署身份和 PAM 通路可用。默认模式下 SDK 可使用仍有效的缓存；当前凭证实际到期且刷新失败时，调用应失败。离线测试可复现此边界。真实失败演练使用隔离测试资源和已经批准的故障条件。 |

按 [验收与回退清单](checklist.md) 汇总结果。

## 与 Go 实现的差异

- Go 用标准库解析语法。Node.js 使用探针中固定版本的 TypeScript 编译器，因为 Node.js 运行时没有公开的 JavaScript/TypeScript AST 解析接口。依赖可从缓存安装。
- Go 配置检查要求 Go 客户端使用的细粒度 PAM scope。TypeScript PAM 默认 provider 固定申请 `urn:cloud:idaas:pam|.all`，生成配置使用此值。校验平台下发的配置时保留其默认 scope，因为 Core 初始化会先按该 scope 获取令牌，PAM 后续单独申请自己的 scope。
- Go 为 OSS V1/V2 选择不同 provider，Node.js `ali-oss` 通过异步刷新回调提供同等能力。Node.js 旧版 `pop-core` 从 1.8.0 支持直接传动态 provider，早于该版本的客户端需要升级。新版 OpenAPI 继续使用 `Config.credential`。
- TypeScript 的联邦检查接受其 SDK 自带的 ECS/EC2 PKCS7、Kubernetes 兼容 OIDC 和显式 OIDC token 文件来源。需要业务注册自定义认证插件或注入自定义凭证源的应用，用业务进程验证同一入口。
