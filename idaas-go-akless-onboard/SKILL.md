---
name: idaas-go-akless-onboard
description: Automates refactoring of Go Alibaba Cloud workloads (OSS V1/V2, SLS, generic OpenAPI) from long-term AccessKey/SecretKey to IDaaS AK-less short-term STS credentials. Use when a developer asks to onboard/integrate IDaaS 无AK, remove hardcoded AK/SK, or convert Go cloud code to IDaaS PAM credential providers.
metadata:
  version: "0.3.2"
---

# IDaaS Go 无 AK 接入改造

将 Go 业务代码中的长期 AK/SK 改为 IDaaS PAM 短期凭证，完成扫描、改写、敏感信息清理和分阶段验收。

## 输入与执行约定

- 本地改造需要目标仓库路径与 Go 1.22+。先识别项目构建方式，按 `references/build.md` 确定依赖与验证范围。
- 运行验收还需要平台配置的完整路径、真实角色 ARN（优先 `ALIBABA_CLOUD_ROLE_ARN`）及部署环境认证资料。缺失时记录待补项，继续可独立完成的本地工作；不得臆造 ARN、身份参数或 Secret。
- 以下命令中的 `<skill-dir>` 指本 skill 的安装目录，`<repo>` 指目标业务仓库；从任意工作目录使用脚本的绝对路径，不能把业务仓库当作 skill 目录。
- 用户已授权改造仓库时，在授权范围内直接处理业务文件和明确关联的旧凭证配置；存在范围歧义、第三方目录、跨云认证或可能仍被其他用途共享的凭证时，汇总一次确认。遵守用户已有确认要求。

## 执行流程

1. **扫描与本地配置检查**
   - 先执行 `python3 <skill-dir>/scripts/scan_ak_usage.py --repo <repo> --lang go --json`，扫描不依赖运行时凭证。按 [扫描结果与边界](references/scanning.md) 检查完整性；退出码非零或扫描不完整时，不能判为通过。
   - 汇报 SDK 类型、静态认证、环境变量读取、手动 STS、已有 IDaaS 接入和配置命中。仅报告位置与类型，不输出凭证原文；疑似凭据及重载调用按参考文档逐项复核，不自动删除。
   - 自动排除脚本已知的依赖、构建目录；其他疑似非业务目录先保留为待判断项，不擅自改动。
   - 已有平台配置时执行 `python3 <skill-dir>/scripts/render_config.py --config <path> --lang go --phase code`，检查结构和关键字段占位符，不检查 Secret 环境变量。无效配置记录待修正项；可继续扫描和代码改造，但不得用于初始化或冒烟。
   - 配置路径按显式 `--config` → `CLOUD_IDAAS_CONFIG_PATH` → `~/.cloud_idaas/client-config.json` 选择；显式/环境变量路径无效时直接报错，不静默回退。文件名不限；`cloud_idaas.json` 等非默认文件必须显式传入或设置环境变量。
   - `--render` 仅在用户要求时生成试点结构，必须显式 `--out`，不写 SDK 默认目录、不覆盖已有文件；生成成功仅表示结构合法。关键字段 `REPLACE_ME` 未替换时，正式 code/runtime 校验均拒绝通过。
2. **确定改造范围**
   - 在用户授权范围内直接实施；仅对上述歧义项集中确认，不为每个文件重复请求批准。
   - 缺少角色 ARN 时，代码从部署环境读取并在启动时检查非空，保留运行待补项；缺少平台配置时仅接入配置加载路径，不生成身份值。尽量完成编译和本地静态检查。
   - 扫描没有命中仅表示“未发现可识别的静态认证”，还需核对 SDK 客户端和 verify 结果，不能直接宣布运行验收完成。
3. **按 SDK 类型改写**
   - OSS V1：`oss.New(endpoint, ak, sk, ...)` 改为 `pam.GetOSSV1CredentialsProvider(roleArn)` + `oss.New(endpoint, "", "", oss.SetCredentialsProvider(credProvider), ...)`。
   - OSS V2：改为 `pam.GetOSSV2CredentialsProvider(roleArn)` + `oss.NewConfig().WithCredentialsProvider(credProvider)`。
   - SLS：改为 `pam.GetSLSCredentialsProvider(roleArn)` + `(&sls.Client{Endpoint: ep}).WithCredentialsProvider(credProvider)`。
   - 通用 OpenAPI：改为 `pam.GetAlibabaCloudCredentialsProvider(roleArn)`；`credProvider` 实现了 `credentials.Credential` 接口，对 darabonba 新一代客户端直接传入即可，旧版 SDK 通过模板中的桥接 provider 接入（每次签名取值，不缓存）。
   - 严格按 `references/templates.md` 使用对应 provider；不得缓存短期凭证。
   - 角色 ARN 优先从 `ALIBABA_CLOUD_ROLE_ARN` 读取；删除旧 AK/SK、手动 AssumeRole 与手动刷新逻辑。
   - 添加 `github.com/cloud-idaas/idaas-go-akless-alibabacloud-adapter` 依赖到 `go.mod`。
4. **本地验证**
   - 执行 `python3 <skill-dir>/scripts/verify_akless.py --repo <repo> --lang go --json`。blocking 必须处理；warnings 逐条确认并记录结论，不能留下未解释项。
   - 再执行 `python3 <skill-dir>/scripts/analyze_auth.py --repo <repo> --json`，按 [语法分析与探针](references/verification.md) 逐客户端检查绑定；解析失败或 unresolved 不得作为通过，人工复核结论单独记录。
   - 执行 `python3 <skill-dir>/scripts/run_probe.py --mode contract` 验证参考桥接方案的离线签名契约；依赖解析可能联网，业务 API 调用不出本机。
   - 按 `references/build.md` 执行项目构建、静态检查和测试；失败时在范围内修复，无法解决则明确报告失败，不标记本地验证通过。
   - scan/verify 是词法检查，支持多行调用，但不证明运行路径或多模块接入完整；逐个核对业务客户端实际使用的 provider。Go `_test.go` 和 Java `src/test/` 中的初始化不用于满足生产代码的项目级接入检查；仍需人工核对各业务模块和运行入口。
5. **运行验收**
   - 仅在配置、角色 ARN、部署认证资料齐备时，执行 `render_config.py --config <path> --lang go --phase runtime`（不指定 phase 时也默认 runtime）。检查 `CLIENT_SECRET_*` / `PRIVATE_KEY_JWT` 指定变量非空；只报告变量名，不输出值。PKCS7/OIDC 不要求 Client Secret。
   - code/runtime 校验均不访问云端；runtime 校验成功只证明本次配置与变量检查通过，不代表取得 STS 或业务授权成功。
   - 已获只读访问授权时，可按 [语法分析与探针](references/verification.md) 运行 `run_probe.py --mode smoke --allow-cloud-read`；该探针仅执行 ECS DescribeRegions，不替代业务资源权限和真实续期验收。
   - 将同一配置路径传给实际 SDK 初始化；外部冒烟按用户授权执行，使用最小只读调用；写入操作须单独授权。403 时核对 PAM 功能权限与目标角色数据权限，不改回长期 AK/SK。
   - 按 `references/checklist.md` 验证获批/未获批资源以及跨有效期续期。资料或授权不足时交付本地改造结果，明确列出尚未运行的验收项。

## 凭证与交付

- 不输出、生成、写入或提交 Secret；不缓存业务侧取得的短期凭证快照。provider 内部的受控缓存与自动刷新属于 SDK 职责。
- 交付分别报告：改造文件与依赖、本地构建/静态检查结果、warnings 处理结论、运行验收结果或待补项。未执行的验证标记“未执行”，不能视为通过。
