# 配置、默认身份与配套能力

本文件用于写入云 CLI 配置、处理多实例或用户选择默认身份时。Skill 只编排，不读取凭证缓存，不运行 fetch-token 获取其 stdout。

## 能力与旧版本

先查询实际 CLI help。配套开发版本提供确定性实例/client-id 解析、AWS 分区默认地域、具名 AWS profile、逐 target 结果、`configure switch` 和扩充的 status。没有这些能力的旧版本仍可用于原有流程，但必须说明边界，不把版本号或命令名称作为完整能力证明。

新参数只在 help 明确支持时使用。用户提供本地 CLI 且要求不升级时，不自动下载安装替换。若旧版会自动建立 AWS default，写入前告知影响并取得用户对该行为的明确选择；也可先用 `--target none` 验证角色发现，保留云 CLI 原配置。

## 多实例和配置路径

已有 profile 不代表目标唯一。核对选定 profile 的实例/issuer/client-id，显式参数优先，实例间不串用应用。多个不同候选时让用户选择，不选择“列表第一个”。需要时用绝对 `--config` 路径隔离本轮配置，并在后续 show/login/configure 命令中保持一致。

profile 冲突不能通过删除原配置解决。相同身份应继续复用已有名称；不同实例、账号或角色即使名称相同也必须保留原身份，选择新前缀或接受 CLI 的稳定冲突名称。

## AWS 地域

`aws`、`aws-cn`、`aws-us-gov` 分别使用该分区的兼容默认；ARN 只能推断分区，不能推断业务地域。保留已有合法地域。地域冲突时停止并说明，用户确认且 CLI 支持后才传 `--aws-region`。GovCloud 等端到端能力不能只凭配置生成即宣称已验证。

身份验证使用 `aws --profile <chosen> sts get-caller-identity`。环境/命令行地域覆盖仍需按 AWS CLI 规则检查。`InvalidClientTokenId` 不能直接等同于 IDaaS 登录失效。

## 默认身份

Broker、aliyun、AWS、tccli 的默认各自独立。保留旧默认，验证使用显式 profile；只有用户明确要求才更改对应工具。

若用户要求持久修改 AWS default，先检查现有 default provider、`~/.aws/credentials` 是否存在默认凭证及环境覆盖，仅检查字段是否存在，不输出凭证。旧 SSO、source_profile 等与新 provider 冲突时，不混写或自动删除。确认具体迁移后，只复用选中具名 profile 已生成的完整 credential_process 和 region；不能重拼忽略绝对 --config 路径。默认优先推荐显式 --profile，或由用户在其会话设置 AWS_PROFILE。

新 CLI 的 `configure switch --profile <name> [--config <path>]` 只修改 Broker，不改变云 CLI 默认。没有该命令的旧版继续显式指定 profile，不编造 flag 或直接覆盖整份配置。

## 失败与环境边界

每个 target 单独记录成功/失败。配置损坏、地域冲突、写权限或无角色都不是重新登录的理由；部分配置已成功时不宣称全部完成，修复具体原因后仅重试失败 target。不全局清缓存，不删除 seed，不覆盖其他工具设置。

写入和功能验证前必须确认实例域名以及发现返回的 instance_id/issuer/DeveloperAPI 对应本次授权环境。文档中的客户域名或历史示例不是当前用户授予的测试目标。未确认不能代入执行。

## 其他写入边界

AWS 配置和共享凭证路径遵循 `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`。检查同名身份冲突时只检查字段是否存在，不读取或输出值。腾讯云配置是静态凭证，已有 `.credential` 无法证明属于本轮；配套新 CLI 会保留原文件并报错，改用新前缀，或由用户明确备份并移除指定文件后重试，不自动覆盖。prefix 使用字母、数字、点、下划线、连字符。独立 `--config` 只隔离 Broker 配置，不隔离原有 Token 缓存；不要承诺自动全新认证。
