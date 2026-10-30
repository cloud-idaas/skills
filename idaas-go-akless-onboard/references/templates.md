# 代码与配置改造模板

## go.mod 依赖

添加依赖后让 `go mod tidy` 按依赖约束解析版本，**不要手动钉死版本号**：

```bash
go get github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter
go mod tidy
```

> **版本由 adapter 驱动**：先添加 adapter，再由 `go mod tidy` 为业务代码引用的 Core SDK 整理直接依赖。保留 adapter 的最低版本约束与项目已有的更高兼容版本；不要额外 `go get core-sdk@latest` 强制升级未经验证的组合，也不要降级至 adapter 要求以下。Go MVS 会选择依赖图要求的最高最低版本，`tidy` 不会自动把已有高版本降回 adapter 的最低版本。记录实际解析版本，按 `build.md` 编译验证。

## 通用前置（Core SDK 初始化）

所有场景必须先初始化 IDaaS Core SDK，且**整个进程只需初始化一次**（通常在 `main()` 或 `init()` 中）。

```go
import (
    "log"

    idaasconfig "github.com/cloud-idaas/idaas-go-core-sdk/config"
    "github.com/cloud-idaas/idaas-go-core-sdk/factory"
)

// 初始化 IDaaS Core SDK（进程级单例，只需调用一次）
idaasCfg, err := idaasconfig.NewConfigReader().LoadWithPriority("")
if err != nil {
    log.Fatalf("Failed to load IDaaS config: %v", err)
}
if err := factory.GetInstance().Initialize(idaasCfg); err != nil {
    log.Fatalf("Failed to initialize IDaaS: %v", err)
}
```

> `LoadWithPriority("")` 传空串时由 Core SDK 按内置优先级查找：`CLOUD_IDAAS_CONFIG_PATH` → 默认路径 `~/.cloud_idaas/client-config.json`。配置文件**名不限、完整路径才是关键**；平台指定其他路径时显式传入：`LoadWithPriority("/path/to/config.json")`。

`roleArn` 通常从环境变量读取：

```go
import "os"

roleArn := os.Getenv("ALIBABA_CLOUD_ROLE_ARN")
```

## OSS V1（aliyun-oss-go-sdk）

```go
import (
    "github.com/aliyun/aliyun-oss-go-sdk/oss"

    "github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
)

// 创建 OSS V1 凭证提供者
credProvider, err := pam.GetOSSV1CredentialsProvider(roleArn)
if err != nil {
    log.Fatalf("Failed to create OSS V1 provider: %v", err)
}

// 创建 OSS V1 客户端（使用 akless 凭证）
client, err := oss.New(endpoint, "", "",
    oss.AuthVersion(oss.AuthV4),
    oss.Region(region),
    oss.SetCredentialsProvider(credProvider))
if err != nil {
    log.Fatalf("Failed to create OSS client: %v", err)
}
bucketClient, err := client.Bucket("your-bucket-name")
```

删除 `oss.New(endpoint, ak, sk, ...)`、AK/SK 环境变量读取、手动 AssumeRole 与手动刷新逻辑。

> **OSS V1 建议启用预检**：OSS V1 SDK 的 `GetCredentials()` 不返回 error，失败时降级为空凭证 + 告警，错误难以从下游 OSS 403 反推。上线首启/调试期建议用 `WithPreflight()` 在构造时即换一次 STS、fail-fast 验证整条链路（Core SDK → OIDC → PAM → STS）。`GetOSSV1CredentialsProvider(roleArn)` 不接受选项，启用预检需走高级构造器：
>
> ```go
> // coreCredProvider 由 Core SDK 提供：factory.GetIDaaSCredentialProvider()
> base, err := pam.NewIDaaSPamAlibabaCloudCredentialsProvider(
>     pam.WithRoleArn(roleArn),
>     pam.WithCredentialProvider(coreCredProvider),
>     pam.WithDeveloperApiEndpoint(developerApiEndpoint),
>     pam.WithIdaasInstanceId(idaasInstanceId),
>     pam.WithPreflight(), // 构造时即做一次 STS 预检
> )
> if err != nil { log.Fatalf("preflight failed: %v", err) }
> credProvider := pam.NewIDaaSPamOSSV1CredentialsProvider(base)
> ```
>
> 高级构造器需显式传入 Core SDK 凭证提供者、实例 ID 与 PAM 端点（不从单例读取）；单实例、不需预检时仍用 `GetOSSV1CredentialsProvider(roleArn)` 即可。

## OSS V2（alibabacloud-oss-go-sdk-v2）

```go
import (
    oss "github.com/aliyun/alibabacloud-oss-go-sdk-v2/oss"

    "github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
)

// 创建 OSS V2 凭证提供者
credProvider, err := pam.GetOSSV2CredentialsProvider(roleArn)
if err != nil {
    log.Fatalf("Failed to create OSS V2 provider: %v", err)
}

// 创建 OSS V2 客户端（使用 akless 凭证）
cfg := oss.NewConfig().
    WithRegion(region).
    WithCredentialsProvider(credProvider)
client := oss.NewClient(cfg)
```

## SLS（aliyun-log-go-sdk）

```go
import (
    sls "github.com/aliyun/aliyun-log-go-sdk"

    "github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
)

// 创建 SLS 凭证提供者
credProvider, err := pam.GetSLSCredentialsProvider(roleArn)
if err != nil {
    log.Fatalf("Failed to create SLS provider: %v", err)
}

// 创建 SLS 客户端（使用 akless 凭证）
client := (&sls.Client{Endpoint: "cn-hangzhou.log.aliyuncs.com"}).WithCredentialsProvider(credProvider)
```

## 通用 OpenAPI：常驻客户端持有动态 provider

下面两条路径二选一，沿用项目已有产品版本。示例以 ECS `DescribeRegions` 只读接口为例；执行前仍需运行验收资料和外部访问授权。provider 与客户端可在进程中复用；业务侧不保存 `GetCredential()` 返回的快照。

### Darabonba 新版客户端

先使用本页“通用前置”初始化 Core SDK，再调用以下函数创建客户端。将 provider 放入 `Config.Credential`，SDK 每次签名时获取有效凭证；不要把一次性 AK/SK/Token 写入配置。

```go
package onboard

import (
    "fmt"
    ecs "github.com/alibabacloud-go/ecs-20140526/v4/client"
    openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
    "github.com/alibabacloud-go/tea/tea"
    "github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
)

func NewOpenAPIClient(roleArn, region string) (*ecs.Client, error) {
    if roleArn == "" || region == "" {
        return nil, fmt.Errorf("role ARN and region must be configured")
    }
    provider, err := pam.GetAlibabaCloudCredentialsProvider(roleArn)
    if err != nil {
        return nil, err
    }
    return ecs.NewClient(&openapi.Config{
        RegionId: tea.String(region),
        Credential: provider,
    })
}

func DescribeRegions(client *ecs.Client) error {
    _, err := client.DescribeRegions(&ecs.DescribeRegionsRequest{})
    return err
}
```

### 旧版 `alibaba-cloud-sdk-go`

旧版的 `sdk/auth/credentials.CredentialsProvider` 与 `credentials-go.Credential` 是不同接口。用桥接 provider，每次签名重新向 IDaaS provider 取快照；不能在启动时取一次 STS 后构造 `StsTokenCredential` 并长期复用。

```go
package onboard

import (
    "fmt"
    "github.com/aliyun/alibaba-cloud-sdk-go/sdk"
    legacycred "github.com/aliyun/alibaba-cloud-sdk-go/sdk/auth/credentials"
    "github.com/aliyun/alibaba-cloud-sdk-go/sdk/requests"
    credential "github.com/aliyun/credentials-go/credentials"
    "github.com/alibabacloud-go/tea/tea"
    "github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter/pam"
)

type pamBridge struct { source credential.Credential }

func (p *pamBridge) GetProviderName() string { return "idaas_pam" }

func (p *pamBridge) GetCredentials() (*legacycred.Credentials, error) {
    model, err := p.source.GetCredential()
    if err != nil { return nil, err }
    if model == nil { return nil, fmt.Errorf("IDaaS returned no credential") }
    return &legacycred.Credentials{
        AccessKeyId: tea.StringValue(model.AccessKeyId),
        AccessKeySecret: tea.StringValue(model.AccessKeySecret),
        SecurityToken: tea.StringValue(model.SecurityToken),
        ProviderName: p.GetProviderName(),
    }, nil
}

func NewLegacyOpenAPIClient(roleArn, region string) (*sdk.Client, error) {
    if roleArn == "" || region == "" {
        return nil, fmt.Errorf("role ARN and region must be configured")
    }
    provider, err := pam.GetAlibabaCloudCredentialsProvider(roleArn)
    if err != nil { return nil, err }
    return sdk.NewClientWithOptions(region, sdk.NewConfig(), &pamBridge{source: provider})
}

func DescribeLegacyRegions(client *sdk.Client) error {
    request := requests.NewCommonRequest()
    request.Scheme = "https"
    request.Domain = "ecs.aliyuncs.com"
    request.Version = "2014-05-26"
    request.ApiName = "DescribeRegions"
    request.Method = "POST"
    _, err := client.ProcessCommonRequest(request)
    return err
}
```

桥接 provider 内只保存源 provider，每次 `GetCredentials()` 都重新取值；不增加手动 AssumeRole、刷新线程或凭证字段缓存。产品 SDK 版本过旧而不接受动态 provider 时，先升级至可用接口版本或迁移新版客户端，不退回静态 STS。

接口依据：[IDaaS adapter](https://github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter)、[旧版 SDK provider 转换](https://github.com/aliyun/alibaba-cloud-sdk-go/blob/master/sdk/auth/credential.go)。

## Client Secret

`authnMethod` 为 `CLIENT_SECRET_BASIC`、`CLIENT_SECRET_POST` 或 `CLIENT_SECRET_JWT` 时，运行环境必须注入 `clientSecretEnvVarName` 指定的变量。例如配置为 `IDAAS_CLIENT_SECRET` 时，只能由安全通道注入 `IDAAS_CLIENT_SECRET`；不得写入代码、配置或仓库。
