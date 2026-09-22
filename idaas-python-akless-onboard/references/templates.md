# 代码与配置改造模板

## 通用前置

```python
import os
from cloud_idaas.core import IDaaSCredentialProviderFactory

ROLE_ARN = os.environ["ALIBABA_CLOUD_ROLE_ARN"]
IDaaSCredentialProviderFactory.init()
```

## OSS V1（oss2）

```python
import oss2
from cloud_idaas.adapter.alibabacloud.pam import IDaaSPamAklessCredentialFactory

provider = IDaaSPamAklessCredentialFactory.get_oss_v1_credential_provider(
    role_arn=ROLE_ARN
)
auth = oss2.ProviderAuthV4(provider)
bucket = oss2.Bucket(auth, "https://oss-cn-hangzhou.aliyuncs.com", "your-bucket-name")
```

删除 `oss2.Auth(...)`、AK/SK 环境变量读取、手动 AssumeRole 与手动刷新逻辑。

## OSS V2（alibabacloud_oss_v2）

```python
import alibabacloud_oss_v2 as oss
from cloud_idaas.adapter.alibabacloud.pam import IDaaSPamAklessCredentialFactory

provider = IDaaSPamAklessCredentialFactory.get_oss_v2_credential_provider(
    role_arn=ROLE_ARN
)
cfg = oss.config.load_default()
cfg.credentials_provider = provider
client = oss.Client(cfg)
```

## SLS

```python
from aliyun.log import LogClient
from cloud_idaas.adapter.alibabacloud.pam import IDaaSPamAklessCredentialFactory

provider = IDaaSPamAklessCredentialFactory.get_sls_credential_provider(
    role_arn=ROLE_ARN
)
client = LogClient("cn-hangzhou.log.aliyuncs.com", credentials_provider=provider)
```

## 通用 OpenAPI

```python
from cloud_idaas.adapter.alibabacloud.pam import IDaaSPamAklessCredentialFactory

provider = IDaaSPamAklessCredentialFactory.get_alibaba_cloud_credentials_provider(
    role_arn=ROLE_ARN
)
credentials = provider.get_credentials()
```

每次使用前获取 `credentials`，不得将其存为模块级缓存。

## Client Secret

`authnMethod` 为 `CLIENT_SECRET_BASIC`、`CLIENT_SECRET_POST` 或 `CLIENT_SECRET_JWT` 时，运行环境必须注入 `clientSecretEnvVarName` 指定的变量。例如配置为 `IDAAS_CLIENT_SECRET` 时，只能由安全通道注入 `IDAAS_CLIENT_SECRET`；不得写入代码、配置或仓库。
