# IDaaS Customer Skills

[English](README.md)

面向 IDaaS 使用者的 Agent Skills：接入本机云 CLI，以及将业务代码从长期 AccessKey 改为 IDaaS 短期凭证。

## 选择 Skill

| Skill | 使用场景 | 主要输入 |
|---|---|---|
| [idaas-cred-init](idaas-cred-init/SKILL.md) | 本机接入 aliyun-cli、aws-cli、tccli，查询角色、刷新登录或登出 | 实例域名、目标 CLI、可选的客户端应用 |
| [idaas-java-akless-onboard](idaas-java-akless-onboard/SKILL.md) | 改造 Java OSS、SLS、通用 OpenAPI 的静态 AccessKey 认证 | 业务仓库、平台配置、角色 ARN；运行验证另需部署身份 |
| [idaas-go-akless-onboard](idaas-go-akless-onboard/SKILL.md) | 改造 Go OSS、SLS、通用 OpenAPI 的静态 AccessKey 认证 | 业务仓库、平台配置、角色 ARN；运行验证另需部署身份 |
| [idaas-python-akless-onboard](idaas-python-akless-onboard/SKILL.md) | 改造 Python OSS、SLS、通用 OpenAPI 的静态 AccessKey 认证 | Python 3.9+、业务仓库、平台配置、角色 ARN |

开发者本机交互接入使用 `idaas-cred-init`。如需改造业务代码，准备好相应平台配置和身份后，再使用对应语言 Skill。

## 通用前置条件

- Agent 支持加载 Skill，并能运行所选 Skill 需要的工具。
- 明确目标 IDaaS 实例和环境，网络可访问所需服务。
- 具备目标操作所需权限。平台配置权限、应用访问权限与云资源权限是不同层次，应按具体 Skill 核对。
- 准备所需本地 CLI、运行时、业务源码或工作负载环境；各 Skill 并不共用一套固定依赖。

每个 Skill 的 `SKILL.md` 是执行入口，具体输入、工具依赖、授权边界与验证步骤以该文件为准。安装 Skill 本身不会安装外部工具、授予权限或建立云侧信任关系。

## 安装与使用

将所选 Skill 的完整目录复制到 Agent 支持的技能目录，保留其配套资源。例如，从仓库根目录安装，且目标目录尚不存在时：

```sh
mkdir -p /path/to/agent/skills
cp -R idaas-cred-init /path/to/agent/skills/
```

将 `/path/to/agent/skills` 替换为实际技能目录。按需安装单个 Skill，不要将仓库根目录作为一个 Skill 安装。已有同名安装时先备份再替换，随后按 Agent 要求重新加载技能或新开会话。

示例请求：

- “使用 idaas-cred-init，把本机阿里云 CLI 接入我的 IDaaS 实例。”
- “使用 idaas-cred-init，查看我在这个实例能使用的云角色。”
- “使用 idaas-java-akless-onboard，把这个 Java 项目的静态 AccessKey 认证改成 IDaaS 短期凭证。”

提供目标环境和资源标识，并说明希望执行哪些变更。交互登录和 MFA 由用户本人完成，不要将密码或凭证明文粘贴到对话中。

## 工具依赖与配置

本仓库维护 Skill 指令和配套资源。外部 CLI、SDK 与 IDaaS 服务有各自的版本和能力，更新 Skill 不会自动升级这些依赖。

工具版本、配置位置和兼容性要求见所选 Skill 及其 references。源码构建的工具在来源和所需能力经过核验后可以使用，应明确提供可执行文件路径。执行前核对配置变更范围，除非明确需要替换，否则保留已有 profile 和默认配置。

## 验证与安全

分别记录文档校验、离线检查、测试环境联调，以及真实凭证或云 API 验证结果。配置文件生成成功不代表认证或资源访问一定成功；未执行项应明确标注，结论前核对目标账号、实例和角色。

不要将密码、AccessKey Secret、客户端密钥、Token、STS 凭证或凭证缓存放入仓库、日志、截图或测试产物。工具可能自行维护本地凭证存储，按对应 Skill 的规则处理。平台及云侧权限应限定在任务所需范围。

记录测试中新建的资源，在获授权后清理，并核对清理范围：删除平台配置不一定会删除对应云资源，登出也不一定会删除 profile。

## 目录结构与维护

每个 Skill 独立维护：

- `SKILL.md`：发现元信息与执行流程。
- `references/`：按需读取的详细说明。
- `scripts/`：按需提供的可执行辅助工具。
- `assets/`：按需提供的模板等资源。

全局 README 聚焦 Skill 目录和通用使用指引。依赖工具的具体能力、API 契约、兼容性细节与排障说明，放入对应 Skill 或依赖工具文档。

修改 Skill 时，同步核对引用文件、命令和示例。脚本变更执行适当检查，区分本地验证与外部联调结果。全局 README 默认使用英文，中文对应文件为 `README_zh.md`，两者保持内容范围与含义一致。
