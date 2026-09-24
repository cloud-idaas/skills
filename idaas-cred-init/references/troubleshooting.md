# 失败处理（按阶段分类，把错误映射为可读提示）

流程各阶段出错时，按本文件对应小节排查。运行时（onboard 完成后）的高频问题保留在 SKILL.md 就地可读。

## 安装阶段

| 现象 | 排查方向 |
|------|---------|
| GitHub 版本查询不可达（`releases.atom`） | 无法确定最新版本。若已有可运行 broker，可继续使用但明确说明未完成最新版校验；若未安装则停止，检查网络后重试。不得回退到 skill 内的固定版本。 |
| 最新 release 没有当前 OS/ARCH 资产 | 展示 release tag 与 `expanded_assets` 清单中的资产名，确认发布流程是否缺少对应平台产物；不得误用 Source code 压缩包。 |
| 下载 URL 不可达 / 404 | 使用 `expanded_assets` 清单中该资产的完整 `releases/download/...` 链接重试；或从源码构建：`go install github.com/aliyunidaas/alibaba-cloud-idaas@latest`。 |
| 下载文件非可执行（file 检查失败） | 下载包可能损坏或返回错误页。确认资产名和 URL 有效，重试；若持续失败，从源码构建。 |
| Windows 安装后 `alibaba-cloud-idaas` 命令找不到 | 用户 PATH 只对新开终端生效。当前会话以完整路径 `& "$env:LOCALAPPDATA\alibaba-cloud-idaas\alibaba-cloud-idaas.exe"` 作为 `<bin>`，或重开终端。 |
| 本地版本低于 GitHub 最新 release | 按 A0 从最新 release 重新下载安装，或 `go install github.com/aliyunidaas/alibaba-cloud-idaas@latest`。 |
| 本地版本高于 GitHub 最新 release | 可能是开发版或自行构建版本；不自动降级，提示后继续。 |
| 本地版本无法解析 | 将当前安装视为无效，重新安装 GitHub 最新 release；版本比较必须支持 prerelease。 |
| aliyun-cli 未安装 | `aliyun version` 检测。按 `references/install-guides.md` 的 aliyun-cli 小节安装。不阻塞 aws-cli / tccli 接入。 |
| aws-cli 未安装 | `aws --version` 检测。按 `references/install-guides.md` 的 aws-cli 小节安装。不阻塞 aliyun-cli / tccli 接入。 |
| TCCLI 未安装 | `tccli --version` 检测。按 `references/install-guides.md` 的 tccli 小节安装。不阻塞 aliyun-cli / aws-cli 接入。  |

## 发现阶段

| 现象 | 排查方向 |
|------|---------|
| 发现端点 404 / 不可达 | 确认实例域名拼写正确。 |
| DNS 解析失败 | 确认域名拼写正确、本机 DNS 可解析该域名（`nslookup <域名>` 测试）。 |
| TLS 证书错误 | 检查系统时间是否正确（`date`）、是否需安装企业根证书。 |

## 登录阶段

| 现象 | 排查方向 |
|------|---------|
| `operation_denied_by_license` | broker 客户端应用受 license 限制（如收费应用跑在免费实例）。联系管理员更换为不受限的应用，或升级实例 license。 |
| `has not been authorized by resource server` | broker 客户端未委派到 PAM 资源服务器的 scope。联系管理员为该 `--client-id` 应用配置到 PAM `urn:cloud:idaas:pam` 的 M2M 委派（scope: `cloud_account_role:obtain_access_credential`）。 |
| 设备码 3 分钟超时 | 用户未及时完成浏览器 MFA。重新执行 `<bin> login --instance <域名> --force-new`。 |
| `access_denied` | 用户在浏览器拒绝了授权。重新登录并在浏览器中批准。 |
| `expired_token` | 设备码已过期（服务端侧）。重新执行 `login --force-new`。 |
| `invalid_client` | client_id 不存在或未开 device_code grant。确认 `--client-id` 指定的应用在 IDaaS 中存在、为公共客户端、且已开启 device_code 授权。 |
| `invalid_scope` / `scope_not_found` | scope 格式错误或客户端未授权该 scope。当前默认值为 `urn:cloud:idaas:pam\|.all offline_access`；若自定义了 `--scope`，确认格式为一个或多个空格分隔的 `audience\|scope-value`，并按需包含 `offline_access`。 |
| 系统时间偏差导致登录失败 | JWT 签发/验证时间窗口不匹配。同步系统时间（`ntpdate` 或系统设置）后重试。 |
| 登录超时 / 网络不可达 | 用 `<bin> login --instance <domain> --force-new` 单独刷新登录，再 `<bin> onboard --instance <domain>` 重试。 |

## 列角色阶段

| 现象 | 排查方向 |
|------|---------|
| `list` 返回空 / `no assumable cloud roles found` | 当前用户未被 PS 授权任何云角色。CLI 会输出 `hint: 请联系管理员在 PS 授权规则中把目标云角色授予你或你所在的组，然后重试 onboard`。请管理员在授权规则中把目标角色授予该用户/组。 |
| API 401 | access token 已过期。`<bin> login --profile <p>` 刷新后重试；失败（refresh token 也过期或无 profile）则 `<bin> login --instance <域名> --force-new` 重新登录。 |
| API 403 | token 的 aud/scope 不满足 PAM 换发权限。当前默认 scope 为 `urn:cloud:idaas:pam\|.all offline_access`；若自定义了 `--scope`，确认包含所需 PAM scope。 |
| API 500 / 502 / 503 | 服务端临时不可用。稍后重试；若持续出现，联系管理员检查服务端状态。 |
| 网络超时 | POP 端点不可达。检查网络到 `eiam-developerapi.<region>.aliyuncs.com` 的连通性。 |

## 配置写入阶段

| 现象 | 排查方向 |
|------|---------|
| 配置文件损坏 | `~/.aliyun/config.json`、`~/.aws/config`、`~/.tccli/<profile>.credential`、`~/.cloud_idaas/idaas-cli.json`（Windows PowerShell: 将 `~/` 换为 `$env:USERPROFILE\`）损坏或无法解析。备份后删除，重试 onboard。 |
| `~/.aliyun/` 写入失败 | 检查目录权限或手动创建（Mac/Linux: `mkdir -p ~/.aliyun`; Windows PowerShell: `New-Item -ItemType Directory -Force "$env:USERPROFILE\.aliyun"`）。 |
| `~/.aws/` 写入失败 | 检查目录权限或手动创建（Mac/Linux: `mkdir -p ~/.aws`; Windows PowerShell: `New-Item -ItemType Directory -Force "$env:USERPROFILE\.aws"`）。 |
| `~/.tccli/` 写入失败 | 检查目录权限或手动创建（Mac/Linux: `mkdir -p ~/.tccli`; Windows PowerShell: `New-Item -ItemType Directory -Force "$env:USERPROFILE\.tccli"`）。 |
| profile 名冲突 | 两个实例的同名角色生成同名 profile。使用 `--prefix` 区分不同实例（如 `--prefix acme-prod`）。 |

## 验证阶段

| 现象 | 排查方向 |
|------|---------|
| 换发 `obtain` 403 | 角色未完成云厂商侧配置 / IDaaS未授权用户/组。 |
| 换发 `obtain` 400 `invalid_client_credential` / `invalid_audience` | 服务端 PAM→云 STS 内部联邦的 `client_assertion(private_key_jwt)` audience 配置无效。**非客户端可修复**，需联系后端/管理员核对云账号 onboarding 与联邦 audience。Profile 已生成，修复后直接重试，无需重新 onboard。 |
| aliyun-cli profile 不存在 | 确认 `--target aliyun-cli` 是否指定。手动检查 Mac/Linux: `cat ~/.aliyun/config.json`; Windows PowerShell: `Get-Content "$env:USERPROFILE\.aliyun\config.json"`。 |
| aws-cli profile 不存在 | 确认 `--target aws-cli` 是否指定。手动检查 Mac/Linux: `cat ~/.aws/config`; Windows PowerShell: `Get-Content "$env:USERPROFILE\.aws\config"`。 |
| tccli credential 不存在或为空 | 确认 `--target tencentcloud-cli` 是否指定。手动检查 Mac/Linux: `ls ~/.tccli/*.credential`; Windows PowerShell: `Get-ChildItem "$env:USERPROFILE\.tccli\*.credential"`。。 |
| 验证超时 | 网络延迟。直接重试 `aliyun --profile <p> sts GetCallerIdentity`、`aws --profile <p> sts get-caller-identity` 或 `tccli --profile <p> sts GetCallerIdentity`。 |