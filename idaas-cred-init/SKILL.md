---
name: idaas-cred-init
description: 给本机 阿里云 skill / aliyun-cli / aws-cli / tccli 配置 IDaaS 无 AK 凭证（短时 STS 自动续期）。当用户提到云凭证接入、无 AK 登录、查询云角色（含权限模板创建/授权的角色发现）、token 刷新、登出或排查接入失败时使用。只做编排，不接触凭证本身。
metadata:
  version: "0.3.0"
---

# 云凭证接入（thin orchestration）

把开发者本机接入 IDaaS 无 AK 凭证的流程编排成一步引导：底层是 `alibaba-cloud-idaas` broker 的 `onboard` 命令（实例发现 → login → 发现角色 → 生成 profile + CLI 配置）。

目标：**一次登录，本机所有 aliyun-cli / aws-cli / tccli / 云 SDK 就近拿到 IDaaS 按权限换发的短时 STS，不落任何长期 AK。**

## 硬边界（安全，不可越）

1. **只编排、不做信任根**：凭证的持有、换发、注入全部在 broker。本技能**绝不**读取、打印、落盘、转发 refresh token / access token / STS（AK/SK/SecurityToken）。只调 broker 命令、读取其**非敏感**输出（`user_code`、`verification_uri`、profile 名称列表、角色名/ARN、验证结果 Y/N）。
2. **浏览器 MFA 必须由人完成**：设备码登录的浏览器 SSO/MFA 步骤**不可被自动化**。呈现 `user_code` 与链接后，**等待用户自己完成**并回来确认。
3. **不泄漏凭证到对话**：任何时候都不要把 token、AK/SK、缓存内容回显到对话、日志或新文件里。验证只看"调用是否成功"，不看凭证明文。
4. **只从授权来源装 broker**：broker 未安装/版本过旧时，仅从 GitHub（`aliyunidaas/alibaba-cloud-idaas`）静默下载，校验确是可执行文件后再启用。

## 接入前提与模板角色发现能力

1. **目标云角色**已在目标云账号完成配置（RAM/IAM/CAM OIDC provider + 角色 + 信任策略），并在 IDaaS 配置云账号和角色。当前登录用户须通过直接授权（含组继承），或通过已授权、处于 ENABLED 状态且用途为 USER 的权限模板获得角色访问权限；模板关联角色及云侧信任配置仍须有效。
2. **模板角色发现能力**：支持该能力的配套 Broker 在 `onboard`、`show roles` 及其重试/续页请求中，须固定设置 `includePermissionTemplateRoles=true`，并消费全部 `NextToken`。这不是用户接入参数，不询问用户、不提供 false 选项，不添加未经 Broker 支持的 CLI flag。按 [配套版本核验](references/role-discovery.md#配套版本核验) 分级处理：常规接入不因能力未确认而中断；以模板角色为验收目标时才要求先确认配套能力。不能仅凭“已是最新版”认定支持。

## 意图路由

根据用户消息自动判断走哪个流程：

| 用户意图 | 路由到 | 核心命令 |
|---------|--------|---------|
| "接入凭证" / "配置 CLI" / "onboard" | **流程 A：接入** | `onboard --instance <域名> --target <已安装的CLI>` |
| "看看我能用哪些角色" / "查看云角色" / "我申请过哪些权限模板" | **流程 B：查询角色** | `show roles --instance <域名>` |
| "token 过期了吗" / "token 过期了" / "刷新登录" / "aliyun/aws 报错" | **流程 C：刷新登录** | `login --profile <p>` 或 `login --instance <域名>` |
| "登出" / "清除凭证" | **流程 D：登出** | `logout --profile <p>` |

---

## 流程 A：接入（onboard）

### A0 检测 + 安装/版本校验

**指定本地 CLI 测试**：用户明确提供本地可执行文件（或 `IDAAS_BIN`）并要求不下载/不升级时，固定使用该路径，执行 `version` 验证后跳过 GitHub 查询及安装/升级步骤。不因 PATH 上另有版本而替换它；文件不存在或不可运行时停止并报告，不自动下载兜底。模板能力仍按配套版本核验确认，不能仅凭版本号认定支持。`IDAAS_BIN` 是 Skill 选择可执行文件的约定，不是 CLI 自身的参数。

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
6. **成功判据**：`<bin> version` 可运行，且已完成与 GitHub 最新 release 的比较；若 GitHub 查询失败但已有可运行 broker，明确提示未完成最新版校验后可进入 A1。版本新旧检查与模板角色发现能力检查分开记录，按 [配套版本核验](references/role-discovery.md#配套版本核验) 分级处理；常规接入可继续，模板角色专项验收须先确认配套能力。

### 配置兼容性检查

首次写入云 CLI 配置前阅读 [配置与默认身份](references/configuration-compatibility.md)。用 `onboard --help`、`show instance --help`、`configure --help` 核对实际能力，不仅凭版本号假定新参数存在。新版本仅写 AWS 具名 profile；旧版可能自动建立 default，不能不提示就使用旧行为。用户指定本地 CLI 时继续遵守 A0，不擅自下载替换。存在多实例时明确核对目标域名、客户端及配置路径，不能沿用另一个实例的 client-id。

### A1 收集接入参数（一轮交互）

- **先检查是否已有 profile**：跑 `<bin> show profiles [--config <本轮绝对配置路径>]`，以命令打印的实际路径为准，不读取或输出整份配置。路径优先级为显式 `--config`、`ALIBABA_CLOUD_IDAAS_CONFIG_FILE`、已存在的旧路径 `~/.aliyun/alibaba-cloud-idaas.json`，最后为 `~/.cloud_idaas/idaas-cli.json`；Windows 的 `~` 对应用户目录。
  - **已有 profile**（非首次接入）：先核对所选 profile 对应的实例和 client-id；目标唯一且符合用户意图时可省略。多个实例/客户端有歧义时让用户指定，不从列表首项猜测。确认 `--target`、配置路径及必要的 `--prefix`。
  - **无 profile**（首次接入）：**一条消息**同时收集：
    - **实例域名 `<domain>`**（必填，如 `acme.aliyunidaas.com`，含/不含 `https://` 皆可，自动规范化）。
    - **`--client-id`**（可选，省略时使用内置 `iap_cloud_idaas_cli` 系统应用）。该应用的客户端 scope 授权不等于用户授权：用户还须有该应用访问权限及所需 PAM scope；系统应用可能不显示在普通应用列表。相关拒绝按 troubleshooting 的登录阶段排查。仅当用户有自己的 broker 客户端应用时传入覆盖。
    - 告知 A0 检测到的 CLI 工具，建议 `--target` 值；用户可覆盖。
    - 可选：`--vpc` / `--prefix`（默认按厂商自动选择），不提则用默认。
- 使用 AWS 时说明 ARN 的 partition 只决定兼容默认地域，不代表业务资源地域；用户要求覆盖且 CLI 支持时才传 `--aws-region`，不擅自改写已有合法地域。
- 汇总参数并确认实例发现端点属于本轮获授权环境，再交 A2；测试使用独立绝对配置路径并保留该路径到后续查询和刷新。

### A2 后台启动 onboard

- 首次：`<bin> onboard --instance <domain> [--client-id <app_id>] [--target ..] [--vpc] [--prefix ..] > <log> 2>&1`
- 非首次（已有 profile）：`<bin> onboard [--target ..] > <log> 2>&1`（--instance / --client-id 自动推断）
- **后台运行**（因阻塞在设备码轮询等待人工 MFA）。
- 角色发现由配套 Broker 固定使用 `includePermissionTemplateRoles=true` 并拉完分页；保持上述命令形式，不为此增加交互开关或手工绕过 Broker 调 API。

### A3 取并呈现设备码

- 启动约 2–3s 后读 `<log>`，抓 `input user code:` 取 `<USER_CODE>`；`or, direct open URL:` 取直连 URL。
- **只呈现 `<USER_CODE>` + 直连 URL**。**不要**转述 QR 字符画（`████` 块，chat 界面纯噪声）。

### A4 等待人工 MFA

- 不自动化。等后台完成通知（onboard 登录成功后自动续跑 list→generate→writeCLI 并退出）。
- 登录成功不等于配置成功。退出码 0 后进入 A5；非 0 时先按实际错误分阶段判断，不自动重跑 login。`FAILED <target>` 或部分成功时，报告已保存的 Broker 配置及失败的云工具，修复原因后仅重试相应 target；无角色、地域冲突、配置损坏和权限错误不能解释成登录过期。
- 若后续首次云调用再次出现设备授权，按 [阶段口径](references/troubleshooting.md#认证与授权阶段口径) 记录发生阶段、是否为新的设备流及可用请求标识；不直接称“两次登录”，不自动重跑 login/onboard、不清理缓存。授权确认页面不等于重新身份认证。

### A5 读取生成结果

- 读取完整退出状态、`SUCCESS <target>`/`FAILED <target>` 和生成数量，再跑 `<bin> show profiles [--config <绝对配置路径>]`。只有对应 target 实际写入成功，才报告该工具接入成功；旧 CLI 的退出码 0 不能代替文件/错误检查。
- 自动化需要结构化结果时，仅在 help 支持后使用 `--result-file <全新绝对路径.json>`。该文件与登录提示分离，读取 schema_version、status、stage、broker_config_saved 和 targets；不覆盖旧结果文件，不把失败 target 的 configuration_files 当作全部已写成功。结果文件写入失败也会非零退出，不能因此断言云配置未生成。
- N≥1 → A6；N=0 → references/troubleshooting.md（列角色阶段）。只有 Broker 完整发现所有页且成功退出，才可把结果作为完整角色列表；分页失败或超限不得当作成功或“没有授权”。

### A6 选择验证角色及是否修改默认身份

按云厂商展示本轮生成的 profile，让用户选择本次验证使用的角色。单角色可直接用该角色验证，但不能据此擅自覆盖任何既有默认身份。多个角色不能由名称、返回顺序或模板创建标志预选。

Broker 输出含 `createdByPermissionTemplate` 时，标注“模板创建：是/否/未知”；仅作背景信息，不能推断授权来源、筛选角色或预填默认。

默认保留各工具既有身份，A7 一律显式传 `--profile`。首次空配置时 CLI 可能初始化 Broker/阿里云 current；如实报告实际值。AWS 新版只写具名 profile，不能把“已生成”说成“已设默认”。

只有用户明确选择更改默认时，分别说明并执行：

- 阿里云：`aliyun configure switch --profile <chosen>`，只影响阿里云 CLI。
- Broker：确认 `configure switch --help` 支持后，运行 `<bin> configure switch --profile <chosen> [--config <绝对配置路径>]`，只影响 Broker。旧 CLI 不支持时保留现有值，继续用显式 profile，不编造参数或改写其他实例配置。
- AWS：优先使用显式 `--profile`，或按用户要求在其实际会话中设置 `AWS_PROFILE`。若要求持久更改 default，按配置参考先检查已有 provider、credentials 和环境覆盖，单独确认影响；不得重拼遗漏 `--config` 的 credential_process，也不静默覆盖 SSO 默认。
- 腾讯云：优先显式 profile。只有用户要求持久默认时，说明并确认 shell/用户环境变量影响，再设置 TCCLI_PROFILE；不自动追加用户 shell 配置。

选择或写入后，支持时通过 `<bin> show status --profile <chosen> [--config <绝对配置路径>]` 核对 Broker/阿里云/AWS 各侧状态。默认身份不同不等于错误，也不能自动同步为同一值。

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

- 列出可用 profile、各工具实际默认和本轮验证结果；没有变更的默认明确保留，不宣称已同步。
- 给示例（按已配置的 CLI 分别给）：
  - aliyun: `aliyun --profile <p> oss ls`
  - aws: `aws --profile <p> s3 ls`
  - tccli: `tccli --profile <p> cvm DescribeRegions`
- **token 生命周期说明**：
  - 阿里云/AWS 的 STS 通过 process_command/credential_process 透明触发 fetch-token 自动续期；腾讯云使用静态凭证文件，不宣称自动续期，需要按实际支持的导出命令显式刷新。
  - access token 过期：`<bin> login --profile <p> [--config <本轮绝对配置路径>]` 刷新（--instance / --client-id 自动从 profile 读），不重跑 onboard。
  - refresh token 过期（长期未用）：确认该阶段错误后，用 `<bin> login --profile <p> [--config <本轮绝对配置路径>] --force-new` 重新授权，保留原实例和客户端上下文。
  - 清除选中登录缓存：按流程 D 先预览并确认；保留本轮配置上下文及 profile 配置，不自行执行全局登出。
  - 后续追加 CLI 工具或刷新角色：直接 `<bin> onboard`（--instance / --client-id 自动推断）。

---

## 流程 B：查询角色（show roles）

当用户只想查看可用角色、暂不接入时：

本流程涵盖直接授权 + 权限模板角色，由配套 Broker 固定 true 发现，见 [角色发现契约与验收](references/role-discovery.md)。`show roles` 展示当前可发现角色，不提供权限模板申请历史或审批状态；用户询问“我申请过哪些权限模板”时，先区分当前可用角色与申请记录，不能从角色列表反推申请历史。

1. 检测 broker（同 A0，但只检测不安装——若未装则提示先安装），并按 [配套版本核验](references/role-discovery.md#配套版本核验) 区分常规查询与模板角色专项验收。能力未确认时，常规查询继续并提示结果可能不含模板角色；专项验收先完成配套能力核验。
2. **检查是否已有 profile**：
   - 已有 profile：核对实例/client-id 与用户意图后运行 `<bin> show roles [--instance <目标域名>] [--client-id <目标客户端>] [--config <绝对配置路径>]`；有歧义先让用户明确，不猜测。
   - 无 profile：询问实例域名（`--client-id` 可选），运行 `<bin> show roles --instance <域名> [--client-id <app_id>]`。
3. （可选 `--config` 指定配置文件、`--json` 机器可读输出）
4. 配套 Broker 固定传 `includePermissionTemplateRoles=true` 并自动消费全部分页；不向用户询问该值，不添加同名 CLI flag。分页错误或超限时报告失败，不能将部分输出描述为全部可用角色。
5. 以表格呈现：角色名 / Role ARN / 厂商 / 状态。Broker 输出含 `createdByPermissionTemplate` 时，增列“模板创建”：true=是、false=否、null=未知。该字段表示角色自身是否由模板创建，不能据此判断本次授权来源，也不用于过滤或预填默认角色选择；Broker 未输出该字段时不显示该列、不自行补值。
6. 询问"要接入吗？"——是 → 转流程 A（已有 profile 则跳过 A1）；否 → 结束。

---

## 流程 C：刷新登录（login）

当用户报告 token 过期、aliyun/aws 报错时，先按 troubleshooting 的阶段口径确认是否属于登录问题；云 API、配置、授权或地域错误不自动转成重新登录：

1. 确认报错 profile 和本轮绝对配置路径（或跑 `<bin> show profiles [--config <路径>]` 列出让用户选）。
2. **判断刷新方式**：
   - **确认需刷新**：`<bin> login --profile <p> [--config <路径>]`，沿用该 profile 的 issuer/client-id/scope；是否需要设备授权由实际运行结果决定，不承诺一定弹窗或一定复用。
   - **确认必须重新授权**：同一命令加 `--force-new`，仍保留 profile/config 上下文。无 profile 时才收集明确实例和客户端，不借用其他实例的配置。
   - 原因不确定时先记录错误阶段和可用请求标识，不自动切换到另一个实例或强制重新授权。
3. 仅当实际生成设备码时呈现链接、等待人工操作（同 A3-A4）；再次出现授权页按阶段参考记录，不直接认定又做了一次身份认证。
4. 验证：
   - aliyun: `aliyun --profile <p> sts GetCallerIdentity`
   - aws: `aws --profile <p> sts get-caller-identity`
   - tccli: **静态凭证，用户确认刷新指定文件后**：`<bin> fetch-token --profile <p> [--config <路径>] --output <已确认的绝对凭证文件路径>`，不读取文件/凭证 stdout，再 `tccli --profile <p> sts GetCallerIdentity`。
5. 明确告知：
   - aliyun/aws：**只需 login 刷新，不需重跑 onboard**（不覆盖配置）
   - tccli：凭证需定期执行 `fetch-token --output` 刷新（过期时间见运行时失败表）

---

## 流程 D：登出（logout）

当用户想清除凭证时：

1. 询问要登出哪个 profile（或全部）。
2. **先预览**：`<bin> logout --profile <p> --dry-run` → 展示将清除哪些缓存文件。当前 logout 不支持 --config；若使用独立配置，对该次子进程设置 `ALIBABA_CLOUD_IDAAS_CONFIG_FILE=<本轮绝对路径>`，不改全局环境或编造参数。独立配置仍共享缓存，dry-run 不能证明其他配置文件的消费者不受影响，须说明影响边界。
3. 确认后用相同进程环境执行：`<bin> logout --profile <p>`；仅用户明确要求全局清理时才执行无 profile 的 logout。
4. 告知：profile 配置保留，重新 `login` 即可恢复。

---

## 凭证消费方（接入后）

| 路径 | 状态 | 说明 |
|------|------|------|
| **aliyun-cli（External）** | ✅ | `onboard --target aliyun-cli` 写 `~/.aliyun/config.json`（Windows: `%USERPROFILE%\.aliyun\config.json`），零改即用，自动续期。 |
| **aws-cli（credential_process）** | ✅ | `onboard --target aws-cli` 写 `~/.aws/config`（Windows: `%USERPROFILE%\.aws\config`），零改即用，自动续期。 |
| **tccli（静态凭证）** | ⚠️ | `onboard --target tencentcloud-cli` 写 `~/.tccli/<profile>.credential`（Windows: `%USERPROFILE%\.tccli\<profile>.credential`），临时凭证需定期用 `fetch-token --profile <p> --output ~/.tccli/<p>.credential` 刷新。 |
| **阿里云 SDK（credentials_uri）** | 🔧 进行中 | 需 `serve` + `ALIBABA_CLOUD_CREDENTIALS_URI` env。onboard 暂不自动写。如实说明现状。 |

> **安全边界**：`fetch-token` 的凭证 stdout 仅供 CLI 消费，本技能不得捕获或回显。仅在用户需要刷新 tccli 指定文件时，可用显式 `--output <绝对路径>` 直接落文件；不读取文件内容，也不运行会把凭证输出到对话中的命令。

## 失败处理

出错时按阶段查 `references/troubleshooting.md`。运行时（onboard 完成后）的高频问题见下表。

### 运行时（onboard 完成后）

| 现象 | 排查方向 |
|------|---------|
| refresh token 过期（长期未用） | 确认是登录阶段错误后，用 `<bin> login --profile <p> [--config <本轮绝对配置路径>] --force-new` 重新授权；无 profile 时显式指定实例和已确认的 client-id，不重跑 onboard。 |
| `IDAAS_PROFILE` 未设 | 省略 `--profile` 时 broker 按优先级解析 profile：flag > env > onboard 写入的 `current_profile` 兜底；需显式指定时设置环境变量（Mac: `echo 'export IDAAS_PROFILE=<profile名>' >> ~/.zshrc && source ~/.zshrc`；Linux: `echo 'export IDAAS_PROFILE=<profile名>' >> ~/.bashrc && source ~/.bashrc`；Windows PowerShell: `[Environment]::SetEnvironmentVariable("IDAAS_PROFILE", "<profile名>", "User"); $env:IDAAS_PROFILE = "<profile名>"`）。 |
| serve daemon 未运行（SDK 路径） | 执行 `<bin> serve --ssrf-token <token>` 启动。确认 `ALIBABA_CLOUD_CREDENTIALS_URI` 环境变量已设。 |
