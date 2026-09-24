---
name: idaas-cred-init
description: 给本机 阿里云 skill / aliyun-cli / aws-cli / tccli 配置 IDaaS 无 AK 凭证（短时 STS 自动续期）。当用户提到云凭证接入、无 AK 登录、查询云角色、token 刷新、登出或排查接入失败时使用。只做编排，不接触凭证本身。
version: 0.1.0
---

# 云凭证接入（thin orchestration）

把开发者本机接入 IDaaS 无 AK 凭证的流程编排成一步引导：底层是 `alibaba-cloud-idaas` broker 的 `onboard` 命令（实例发现 → login → 发现角色 → 生成 profile + CLI 配置）。

目标：**一次登录，本机所有 aliyun-cli / aws-cli / tccli / 云 SDK 就近拿到 IDaaS 按权限换发的短时 STS，不落任何长期 AK。**

## 硬边界（安全，不可越）

1. **只编排、不做信任根**：凭证的持有、换发、注入全部在 broker。本技能**绝不**读取、打印、落盘、转发 refresh token / access token / STS（AK/SK/SecurityToken）。只调 broker 命令、读取其**非敏感**输出（`user_code`、`verification_uri`、profile 名称列表、角色名/ARN、验证结果 Y/N）。
2. **浏览器 MFA 必须由人完成**：设备码登录的浏览器 SSO/MFA 步骤**不可被自动化**。呈现 `user_code` 与链接后，**等待用户自己完成**并回来确认。
3. **不泄漏凭证到对话**：任何时候都不要把 token、AK/SK、缓存内容回显到对话、日志或新文件里。验证只看"调用是否成功"，不看凭证明文。
4. **只从授权来源装 broker**：broker 未安装/版本过旧时，仅从 GitHub（`aliyunidaas/alibaba-cloud-idaas`）静默下载，校验确是可执行文件后再启用。

## 前提（一次性，缺失 onboard 会失败）

1. **目标云角色**已在目标云账号完成配置（RAM/IAM/CAM OIDC provider + 角色 + 信任策略），已在 IDaaS 添加对应的云账号、云角色，且已完成当前登录用户/组的授权。

## 意图路由

根据用户消息自动判断走哪个流程：

| 用户意图 | 路由到 | 核心命令 |
|---------|--------|---------|
| "接入凭证" / "配置 CLI" / "onboard" | **流程 A：接入** | `onboard --instance <域名> --target <已安装的CLI>` |
| "看看我能用哪些角色" / "查看云角色" | **流程 B：查询角色** | `show roles --instance <域名>` |
| "token 过期了吗" / "token 过期了" / "刷新登录" / "aliyun/aws 报错" | **流程 C：刷新登录** | `login --profile <p>` 或 `login --instance <域名>` |
| "登出" / "清除凭证" | **流程 D：登出** | `logout --profile <p>` |

---

## 流程 A：接入（onboard）

### A0 检测 + 安装/版本校验

1. **检测本机 broker**：`<bin>` 解析顺序为 `$IDAAS_BIN`（已设且可执行）→ PATH 上的 `alibaba-cloud-idaas` → 已知安装路径（Windows 为 `%LOCALAPPDATA%\alibaba-cloud-idaas\alibaba-cloud-idaas.exe`）。执行 `<bin> version` 验证。
   - 找不到或不可运行 → 走第 3 步（安装）；可用 → 走第 4 步（版本校验）。
2. **查询 GitHub Releases 确定最新版**（走网页端 Atom 订阅源，不依赖 REST API——`api.github.com` 匿名按出口 IP 每小时 60 次限流，共享代理出口时极易 403）：
   - 请求 `https://github.com/aliyunidaas/alibaba-cloud-idaas/releases.atom`，取第一个 `<entry>` 的 tag（`<id>` 末段）为最新版；Atom 只含已发布 release（无 draft）、含 prerelease。用户明确要求稳定版时，扫描后续 `<entry>` 取第一个无 `-beta`/`-rc`/`-preview` 后缀的 tag；若全部带后缀，如实告知无稳定版。
   - tag 去掉前导 `v` 得 `VERSION`；不得自行猜测或写死版本号。
   - 查询失败时不得声称本机已是最新版：已有可运行 broker → 明确提示“未能完成最新版本校验”后继续；未安装 → 停止自动安装，提示检查 GitHub 网络后重试。
3. **安装/升级（未安装或需升级时）→ 静默安装最新 release**：
   - OS 映射：`darwin→macosx`，`linux→linux`，Windows（msys/cygwin/mingw）→`windows`；ARCH 映射：`x86_64/amd64→amd64`，`arm64/aarch64→arm64`。
   - 期望资产名 `alibaba-cloud-idaas-${OS}-${VERSION}-${ARCH}.${EXT}`（Linux/macOS `.tgz`，Windows `.zip`）。Atom 无资产清单，需再请求 `https://github.com/aliyunidaas/alibaba-cloud-idaas/releases/expanded_assets/${TAG}`，按资产名精确匹配下载链接（href 为 `/aliyunidaas/...` 站点相对路径，前拼 `https://github.com` 得完整 URL）下载；不得拼固定版本下载地址，不得把 Source code 压缩包当二进制资产。
   - 找不到匹配资产 → 停止安装，展示 `TAG` 和可用资产名，提示该 release 未发布当前平台二进制。
   - 下载后解压：
     - Mac/Linux：`file` 校验可执行，`chmod +x` 赋权，移入 `/usr/local/bin`（不可写则 `~/.local/bin`）。
     - Windows：将匹配资产的完整下载 URL 传给本 skill 自带的安装脚本执行（`<skill-path>` 为本 skill 实际路径）；下载可能较慢，运行该命令时，将工具超时设为其允许的最长时长，避免下载中途终止。
       ```powershell
       powershell -ExecutionPolicy Bypass -File <skill-path>/scripts/Install-Broker-Windows.ps1 -DownloadUrl "<url>"
       ```
       脚本安装到 `%LOCALAPPDATA%\alibaba-cloud-idaas`，升级重跑即可覆盖。安装后**当前会话**以完整路径 `& "$env:LOCALAPPDATA\alibaba-cloud-idaas\alibaba-cloud-idaas.exe"` 作为 `<bin>`（用户 PATH 仅对新开终端生效）。
4. **已安装 → 与最新 `VERSION` 比较**（语义化版本规则，正确处理 prerelease，不用字符串字典序）：
   - 本地版本低 → 按第 3 步下载升级；等于 → 继续；高于（如开发版）→ 不自动降级，提示后继续。
   - 本地版本无法解析或 `<bin> version` 执行失败 → 视为无效安装，按第 3 步重装。
5. **检测已安装的 CLI 工具**：`aliyun version` / `aws --version` / `tccli --version` 逐个检测；按 broker 实际支持且已安装的 CLI 建议 `--target` 值（如三者都装 → `--target aliyun-cli,aws-cli,tencentcloud-cli`）。用户需要但未安装的 CLI → 按 `references/install-guides.md` 对应小节引导安装，**不阻塞**其他 CLI 的 onboard。
6. **成功判据**：`<bin> version` 可运行，且已完成与 GitHub 最新 release 的比较；若 GitHub 查询失败但已有可运行 broker，明确提示未完成最新版校验后可进入 A1。

### A1 收集接入参数（一轮交互）

- **先检查是否已有 profile**：跑 `<bin> show profiles`（或读配置文件：Mac/Linux `~/.cloud_idaas/idaas-cli.json`；Windows PowerShell `$env:USERPROFILE\.cloud_idaas\idaas-cli.json`）。
  - **已有 profile**（非首次接入）：`--instance` 和 `--client-id` 均可省略（自动从已有 profile 推断）。只需确认是否要 `--target`（追加其它 CLI 工具）或 `--prefix`（区分实例）。可直接进入 A2。
  - **无 profile**（首次接入）：**一条消息**同时收集：
    - **实例域名 `<domain>`**（必填，如 `acme.aliyunidaas.com`，含/不含 `https://` 皆可，自动规范化）。
    - **`--client-id`**（可选，省略时使用内置 `iap_cloud_idaas_cli` 系统应用——出厂预授权 PAM `.all`、不受 license 限制）。仅当用户有自己的 broker 客户端应用时传入覆盖。
    - 告知 A0 检测到的 CLI 工具，建议 `--target` 值；用户可覆盖。
    - 可选：`--vpc` / `--prefix`（默认按厂商自动选择），不提则用默认。
- 汇总为 onboard 参数交 A2。

### A2 后台启动 onboard

- 首次：`<bin> onboard --instance <domain> [--client-id <app_id>] [--target ..] [--vpc] [--prefix ..] > <log> 2>&1`
- 非首次（已有 profile）：`<bin> onboard [--target ..] > <log> 2>&1`（--instance / --client-id 自动推断）
- **后台运行**（因阻塞在设备码轮询等待人工 MFA）。

### A3 取并呈现设备码

- 启动约 2–3s 后读 `<log>`，抓 `input user code:` 取 `<USER_CODE>`；`or, direct open URL:` 取直连 URL。
- **只呈现 `<USER_CODE>` + 直连 URL**。**不要**转述 QR 字符画（`████` 块，chat 界面纯噪声）。

### A4 等待人工 MFA

- 不自动化。等后台完成通知（onboard 登录成功后自动续跑 list→generate→writeCLI 并退出）。
- 退出码 0 → A5；超时/非 0 → 提示 `<bin> login --instance <domain> --force-new` 先刷新登录，再 onboard 重试。

### A5 读取生成结果

- 读 `<log>` 尾 `Done. Generated N profile(s)` + 跑 `<bin> show profiles`。
- N≥1 → A6；N=0 → references/troubleshooting.md（列角色阶段）。

### A6 选默认角色（仅 N>1）

当 onboard 生成了多个 profile 时，**必须**让用户选择默认角色。单角色跳过此步。

#### A6.1 展示角色列表并询问用户

按厂商分组展示生成的 profile，让用户选择默认：
**注意**：每个 CLI 工具独立选择默认。按已配置的 CLI 逐厂商询问（如先阿里云默认角色，再 AWS，再腾讯云）。如果某个厂商只有一个角色，自动设为该厂商默认，无需询问。

#### A6.2 按选择设置默认

用户选择后，**按已配置的 CLI 分别设默认**：
- **aliyun-cli**：`aliyun configure switch --profile <chosen>`
- **aws-cli**：`aws configure set credential_process "<bin> fetch-token --profile <chosen>" --profile default`
- **tccli**：
  - Mac: `echo 'export TCCLI_PROFILE=<chosen>' >> ~/.zshrc && source ~/.zshrc`
  - Linux: `echo 'export TCCLI_PROFILE=<chosen>' >> ~/.bashrc && source ~/.bashrc`
  - Windows PowerShell: `[Environment]::SetEnvironmentVariable("TCCLI_PROFILE", "<chosen>", "User"); $env:TCCLI_PROFILE = "<chosen>"`
- 写后验证各文件值正确。

### A7 验证（按已配置的 CLI 分别验证）

- **aliyun-cli 已安装且 --target 含 aliyun-cli**：
  `aliyun --profile <chosen> sts GetCallerIdentity` → 退出 0 + JSON 含 `AccountId/Arn`（可展示）；失败 → references/troubleshooting.md（A7 验证阶段）。
- **aws-cli 已安装且 --target 含 aws-cli**：
  `aws --profile <chosen> sts get-caller-identity` → 退出 0 + JSON 含 `UserId/Arn`（可展示）；失败 → references/troubleshooting.md（A7 验证阶段）。
- **tccli 已安装且 --target 含 tencentcloud-cli**：
  `tccli --profile <chosen> sts GetCallerIdentity` → 退出 0 + JSON 含 `AccountId/Arn`（可展示）；失败 → references/troubleshooting.md（A7 验证阶段）。
- **每个 CLI 独立验证、独立报告**。一个失败不影响另一个的报告。
- **验证失败 ≠ 接入失败**：profile 已就绪时，告知用户"修复后直接重试，无需重新 onboard"。
- 边界：**不**运行 `<bin> fetch-token`、**不**捕获其 stdout。

### A8 完成

- 列可用 profile + 当前默认。
- 给示例（按已配置的 CLI 分别给）：
  - aliyun: `aliyun --profile <p> oss ls`
  - aws: `aws --profile <p> s3 ls`
  - tccli: `tccli --profile <p> cvm DescribeRegions`
- **token 生命周期说明**：
  - STS 自动续期（process_command/credential_process 透明触发 fetch-token）。
  - access token 过期：`<bin> login --profile <p>` 刷新（--instance / --client-id 自动从 profile 读），不重跑 onboard。
  - refresh token 过期（长期未用）：`<bin> login --instance <域名> [--client-id <app_id>] --force-new` 重新登录。
  - 彻底清除：`<bin> logout --profile <p>`（保留 profile 配置）。
  - 后续追加 CLI 工具或刷新角色：直接 `<bin> onboard`（--instance / --client-id 自动推断）。

---

## 流程 B：查询角色（show roles）

当用户只想查看可用角色、暂不接入时：

1. 检测 broker（同 A0，但只检测不安装——若未装则提示先安装）。
2. **检查是否已有 profile**：
   - 已有 profile：直接 `<bin> show roles`（--instance / --client-id 自动推断）。
   - 无 profile：询问实例域名（`--client-id` 可选），运行 `<bin> show roles --instance <域名> [--client-id <app_id>]`。
3. （可选 `--config` 指定配置文件、`--json` 机器可读输出）
4. 以表格呈现：角色名 / Role ARN / 厂商 / 状态。
5. 询问"要接入吗？"——是 → 转流程 A（已有 profile 则跳过 A1）；否 → 结束。

---

## 流程 C：刷新登录（login）

当用户报告 token 过期、aliyun/aws 报错时：

1. 询问是哪个 profile 报错（或跑 `<bin> show profiles` 列出让用户选）。
2. **判断刷新方式**：
   - **access token 过期（常见）**：`<bin> login --profile <p>`（从 profile 自动读 issuer+scope+client_id，**不需再传 --instance / --client-id**，重新设备码登录）。
   - **refresh token 也过期（长期未用）**：`<bin> login --instance <域名> [--client-id <app_id>] --force-new`（`--client-id` 仅在要覆盖内置系统应用时提供）。
   - 不确定 → 先试 `--profile`，失败再 `--instance [--client-id] --force-new`。
3. 呈现设备码、等待 MFA（同 A3-A4）。
4. 验证：
   - aliyun: `aliyun --profile <p> sts GetCallerIdentity`
   - aws: `aws --profile <p> sts get-caller-identity`
   - tccli: **静态凭证，验证前先刷凭证文件**：`<bin> fetch-token --profile <p> --output ~/.tccli/<p>.credential`，再 `tccli --profile <p> sts GetCallerIdentity`
5. 明确告知：
   - aliyun/aws：**只需 login 刷新，不需重跑 onboard**（不覆盖配置）
   - tccli：凭证需定期执行 `fetch-token --output` 刷新（过期时间见运行时失败表）

---

## 流程 D：登出（logout）

当用户想清除凭证时：

1. 询问要登出哪个 profile（或全部）。
2. **先预览**：`<bin> logout --profile <p> --dry-run` → 展示将清除哪些缓存文件。
3. 确认后执行：`<bin> logout --profile <p>`（或 `logout` 清全部）。
4. 告知：profile 配置保留，重新 `login` 即可恢复。

---

## 凭证消费方（接入后）

| 路径 | 状态 | 说明 |
|------|------|------|
| **aliyun-cli（External）** | ✅ | `onboard --target aliyun-cli` 写 `~/.aliyun/config.json`（Windows: `%USERPROFILE%\.aliyun\config.json`），零改即用，自动续期。 |
| **aws-cli（credential_process）** | ✅ | `onboard --target aws-cli` 写 `~/.aws/config`（Windows: `%USERPROFILE%\.aws\config`），零改即用，自动续期。 |
| **tccli（静态凭证）** | ⚠️ | `onboard --target tencentcloud-cli` 写 `~/.tccli/<profile>.credential`（Windows: `%USERPROFILE%\.tccli\<profile>.credential`），临时凭证需定期用 `fetch-token --profile <p> --output ~/.tccli/<p>.credential` 刷新。 |
| **阿里云 SDK（credentials_uri）** | 🔧 进行中 | 需 `serve` + `ALIBABA_CLOUD_CREDENTIALS_URI` env。onboard 暂不自动写。如实说明现状。 |

> **安全边界**：`fetch-token` 的 stdout 含完整 STS，仅供 CLI 消费。**本技能不得直接运行 `fetch-token`、也不得捕获或回显其 stdout**。

## 失败处理

出错时按阶段查 `references/troubleshooting.md`。运行时（onboard 完成后）的高频问题见下表。

### 运行时（onboard 完成后）

| 现象 | 排查方向 |
|------|---------|
| refresh token 过期（长期未用） | `<bin> login --instance <域名> [--client-id <app_id>] --force-new` 重新登录（不是 `--profile`，因为 refresh 已失效需重新设备码；实例域名必填，`--client-id` 仅在覆盖内置系统应用时提供）。 |
| `IDAAS_PROFILE` 未设 | 省略 `--profile` 时 broker 按优先级解析 profile：flag > env > onboard 写入的 `current_profile` 兜底；需显式指定时设置环境变量（Mac: `echo 'export IDAAS_PROFILE=<profile名>' >> ~/.zshrc && source ~/.zshrc`；Linux: `echo 'export IDAAS_PROFILE=<profile名>' >> ~/.bashrc && source ~/.bashrc`；Windows PowerShell: `[Environment]::SetEnvironmentVariable("IDAAS_PROFILE", "<profile名>", "User"); $env:IDAAS_PROFILE = "<profile名>"`）。 |
| serve daemon 未运行（SDK 路径） | 执行 `<bin> serve --ssrf-token <token>` 启动。确认 `ALIBABA_CLOUD_CREDENTIALS_URI` 环境变量已设。 |