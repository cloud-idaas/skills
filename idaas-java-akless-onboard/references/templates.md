# 代码与配置改造模板

## Maven 依赖

在 `pom.xml` 中添加：

```xml
<dependency>
    <groupId>com.cloud-idaas</groupId>
    <artifactId>idaas-java-akless-alibabacloud-adapter</artifactId>
    <version>[0.0.2-beta,)</version>
</dependency>
```

> **版本由 adapter 驱动，不要手动钉死 core-sdk**：`idaas-java-core-sdk` 是 `idaas-java-akless-alibabacloud-adapter` 的传递依赖（adapter 的 pom 已声明其依赖的 core-sdk 版本），业务 pom 无需、也不应单独声明 core-sdk 版本——手动钉会与 adapter 要求的版本脱节（例如旧模板写 `0.0.6-beta`，而 core-sdk 会持续迭代到更高版本，单独钉死即用到未经 adapter 验证的组合）。adapter 用版本区间 `[0.0.2-beta,)` 自动取公开 Maven 仓（Maven Central / 阿里云公共镜像）最新发布版，SDK 持续迭代时无需修改业务 pom。注意区间会解析到满足条件的**最高**版本（可能包含更新的 beta），发布前建议人工复核实际解析版本；若团队规范禁用版本区间，可在 [mvnrepository.com](https://mvnrepository.com/artifact/com.cloud-idaas/idaas-java-akless-alibabacloud-adapter) 查公开仓最新版显式填入，但 core-sdk 始终让 adapter 传递引入、不单独声明版本。

## Gradle 依赖

沿用项目已有版本管理方式。与 Maven 相同，只直接声明 adapter，Core SDK 由 adapter 传递引入。

Groovy DSL（`build.gradle`）：

```groovy
dependencies {
    implementation 'com.cloud-idaas:idaas-java-akless-alibabacloud-adapter:[0.0.2-beta,)'
}
```

Kotlin DSL（`build.gradle.kts`）：

```kotlin
dependencies {
    implementation("com.cloud-idaas:idaas-java-akless-alibabacloud-adapter:[0.0.2-beta,)")
}
```

若项目使用 dependency locking、版本目录或固定版本约束，保持原规范，并记录实际解析的 adapter 版本。构建入口和多模块选择见 `build.md`。

## 通用前置（Core SDK 初始化）

所有场景必须先初始化 IDaaS Core SDK，且**整个进程只需初始化一次**（通常在应用启动时或 `main()` 方法中）。

```java
import com.cloud_idaas.core.factory.IDaaSCredentialProviderFactory;

// 初始化 IDaaS Core SDK（进程级单例，只需调用一次）
IDaaSCredentialProviderFactory.init();
```

> 若 `init()` 按编译器提示声明 checked exception，在启动入口显式处理并 fail-fast（抛异常终止启动），不要吞异常继续运行。

`roleArn` 通常从环境变量读取：

```java
String roleArn = System.getenv("ALIBABA_CLOUD_ROLE_ARN");
```

## OSS V1（aliyun-sdk-oss）

```java
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.common.auth.CredentialsProvider;

import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;

// 创建 OSS V1 凭证提供者
CredentialsProvider ossV1Provider =
    IDaaSPamAklessCredentialFactory.getOSSV1CredentialProvider(roleArn);

// 创建 OSS V1 客户端（使用 akless 凭证）
OSS ossClient = new OSSClientBuilder().build("https://oss-cn-hangzhou.aliyuncs.com", ossV1Provider);
```

需要连接池/超时等客户端配置时用三参重载（同样合规，verify 会将其列为待复核 warning 而非 blocking）：

```java
ClientBuilderConfiguration conf = new ClientBuilderConfiguration();
conf.setConnectionTimeout(5000);
OSS ossClient = new OSSClientBuilder().build(endpoint, ossV1Provider, conf);
```

删除 `new OSSClientBuilder().build(endpoint, accessKeyId, accessKeySecret)`、AK/SK 环境变量读取、手动 AssumeRole 与手动刷新逻辑。

## OSS V2（alibabacloud-oss-v2）

```java
import com.aliyun.sdk.service.oss2.OSSClient;
import com.aliyun.sdk.service.oss2.credentials.CredentialsProvider;

import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;

// 创建 OSS V2 凭证提供者
CredentialsProvider ossV2Provider =
    IDaaSPamAklessCredentialFactory.getOSSV2CredentialProvider(roleArn);

// 创建 OSS V2 客户端（使用 akless 凭证；OSSClient 是 AutoCloseable）
try (OSSClient client = OSSClient.newBuilder()
        .credentialsProvider(ossV2Provider)
        .region("cn-hangzhou")
        .build()) {
    // ... 在此执行 API 调用
}
```

`OSSClient` 实现了 `AutoCloseable`：短生命周期场景用 try-with-resources 及时释放；常驻服务可持有单例客户端，并在应用退出时 close。

## SLS（aliyun-log）

```java
import com.aliyun.openservices.log.Client;
import com.aliyun.openservices.log.common.auth.CredentialsProvider;

import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;

// 创建 SLS 凭证提供者
CredentialsProvider slsProvider =
    IDaaSPamAklessCredentialFactory.getSLSCredentialProvider(roleArn);

// 创建 SLS 客户端（使用 akless 凭证）
Client client = new Client("cn-hangzhou.log.aliyuncs.com", slsProvider);
```

## 通用 OpenAPI：常驻客户端持有动态 provider

新旧客户端凭证接口不同，按项目实际 SDK 二选一。下面示例包含启动初始化、客户端构造和最小只读调用；运行前需配置 `ALIBABA_CLOUD_ROLE_ARN`、`ALIBABA_CLOUD_REGION_ID` 及 Core SDK 配置路径，且已授权外部访问。产品 SDK 依赖沿用项目现有兼容版本，示例产品为 ECS。

### Darabonba 新版客户端

通过 `com.aliyun.credentials.Client(provider)` 桥接到 `Config.credential`，客户端长期持有 provider，不把 `CredentialModel` 拷贝进静态 AK/SK 配置。

```java
import com.aliyun.credentials.provider.AlibabaCloudCredentialsProvider;
import com.cloud_idaas.core.factory.IDaaSCredentialProviderFactory;
import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;

public class OpenApiExample {
    public static void main(String[] args) throws Exception {
        String roleArn = requiredEnv("ALIBABA_CLOUD_ROLE_ARN");
        String region = requiredEnv("ALIBABA_CLOUD_REGION_ID");
        IDaaSCredentialProviderFactory.init();
        AlibabaCloudCredentialsProvider provider =
            IDaaSPamAklessCredentialFactory.getAlibabaCloudCredentialsProvider(roleArn);
        com.aliyun.teaopenapi.models.Config config = new com.aliyun.teaopenapi.models.Config()
            .setRegionId(region)
            .setCredential(new com.aliyun.credentials.Client(provider));
        com.aliyun.ecs20140526.Client client = new com.aliyun.ecs20140526.Client(config);
        client.describeRegions(new com.aliyun.ecs20140526.models.DescribeRegionsRequest());
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException("Missing environment variable: " + name);
        }
        return value;
    }
}
```

### 旧版 `aliyun-java-sdk-core`

`com.aliyuncs.auth.AlibabaCloudCredentialsProvider` 与 `com.aliyun.credentials.provider.AlibabaCloudCredentialsProvider` 不同。桥接函数在每次签名时获取一份完整 STS，避免在应用启动时创建一次 `BasicSessionCredentials` 后永久复用。

```java
import com.aliyun.credentials.models.CredentialModel;
import com.aliyun.credentials.provider.AlibabaCloudCredentialsProvider;
import com.aliyuncs.DefaultAcsClient;
import com.aliyuncs.auth.BasicSessionCredentials;
import com.aliyuncs.profile.DefaultProfile;
import com.aliyuncs.ecs.model.v20140526.DescribeRegionsRequest;
import com.cloud_idaas.core.factory.IDaaSCredentialProviderFactory;
import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;

public class LegacyOpenApiExample {
    public static void main(String[] args) throws Exception {
        String roleArn = requiredEnv("ALIBABA_CLOUD_ROLE_ARN");
        String region = requiredEnv("ALIBABA_CLOUD_REGION_ID");
        IDaaSCredentialProviderFactory.init();
        AlibabaCloudCredentialsProvider provider =
            IDaaSPamAklessCredentialFactory.getAlibabaCloudCredentialsProvider(roleArn);
        com.aliyuncs.auth.AlibabaCloudCredentialsProvider bridge = () -> {
            CredentialModel current = provider.getCredentials();
            return new BasicSessionCredentials(current.getAccessKeyId(),
                current.getAccessKeySecret(), current.getSecurityToken());
        };
        DefaultAcsClient client = new DefaultAcsClient(DefaultProfile.getProfile(region), bridge);
        try {
            client.getAcsResponse(new DescribeRegionsRequest());
        } finally {
            client.shutdown();
        }
    }

    private static String requiredEnv(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException("Missing environment variable: " + name);
        }
        return value;
    }
}
```

常驻服务在启动时创建 provider/client，在服务退出时按客户端接口释放资源。不要缓存 `provider.getCredentials()` 的返回值或增加手动刷新；旧版 SDK 不支持所示 provider 构造器时先调整 SDK 版本，不回退长期 AK/SK。

接口依据：[credentials-java provider 构造器](https://github.com/aliyun/credentials-java/blob/master/src/main/java/com/aliyun/credentials/Client.java)、[旧版 DefaultAcsClient](https://github.com/aliyun/aliyun-openapi-java-sdk/blob/master/aliyun-java-sdk-core/src/main/java/com/aliyuncs/DefaultAcsClient.java)。

## Client Secret

`authnMethod` 为 `CLIENT_SECRET_BASIC`、`CLIENT_SECRET_POST` 或 `CLIENT_SECRET_JWT` 时，运行环境必须注入 `clientSecretEnvVarName` 指定的变量。例如配置为 `IDAAS_CLIENT_SECRET` 时，只能由安全通道注入 `IDAAS_CLIENT_SECRET`；不得写入代码、配置或仓库。
