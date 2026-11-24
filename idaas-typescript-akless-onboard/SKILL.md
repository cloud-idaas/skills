---
name: idaas-typescript-akless-onboard
description: Migrate Node.js TypeScript or JavaScript Alibaba Cloud clients (OSS, SLS, generic OpenAPI) from long-term AccessKeys to IDaaS PAM short-lived credentials. Use when asked to onboard IDaaS 无 AK, remove static AK/SK, or validate credential refresh for a Node.js workload.
metadata:
  version: "0.1.0"
---

# IDaaS Node.js 无 AK 接入改造

将 Node.js 服务端应用中的长期 AccessKey 改为 IDaaS PAM 短期凭证。支持 JavaScript CommonJS/ESM 和 TypeScript，参考示例使用 Node.js 20、22、24 兼容的 SDK。浏览器和其他云厂商客户端需要各自的接入方案。

## 输入与执行约定

- 业务仓库路径、Node.js 版本、包管理器和待改造的生产入口。按 [构建与验证](references/build.md) 确定 workspace 和受影响的包。
- 运行验收需要平台下发的客户端配置、目标 RAM 角色 ARN、部署身份、地域及已授权的测试资源。优先从 `ALIBABA_CLOUD_ROLE_ARN` 取得角色 ARN。
- 缺少运行输入时，继续扫描、改造或离线检查中可独立完成的部分，并记录运行待补项。
- `<skill-dir>` 指技能安装目录，`<repo>` 指目标业务仓库。用脚本的绝对路径从任意目录执行。

## 执行流程

1. **扫描与配置检查。** 执行 `node "<skill-dir>/scripts/scan.mjs" "<repo>"`。按 [扫描结果](references/scanning.md) 核对完整性和命中项。有平台配置时按 [配置检查](references/verification.md#配置检查) 执行 `--phase code`。试点配置只在用户要求时生成。
2. **确定改造范围。** 逐一确认生产入口与凭证来源。只清理当前调用链独占的旧 AK/SK、手工 AssumeRole、刷新和部署注入。涉及共享凭证、跨云或第三方代码时先核实归属。
3. **按客户端改写。** 按 [代码与配置模板](references/templates.md) 复用进程级 Core 和按角色创建的 provider。OSS 保留刷新回调，SLS 和支持 provider 的旧版 OpenAPI 保留异步 provider，新版 OpenAPI 使用 `Config.credential`。按业务包管理器更新锁文件。
4. **本地验证。** 执行 `node "<skill-dir>/scripts/scan.mjs" "<repo>" --verify --tools "<probe-dir>"`。按 [离线验证](references/verification.md#离线验证) 处理阻断项、复核未解析绑定和告警，运行改造包的构建和测试，再执行离线签名契约。
5. **运行验收。** 资料齐备且获外部只读授权后，先以 `--phase runtime` 检查，再按 [测试环境验证](references/verification.md#测试环境验证) 验证 PAM 取证、业务权限和跨有效期续期。按 [验收清单](references/checklist.md) 记录通过、失败和未执行项。

只报告凭证变量名、命中位置和脱敏错误信息。真实 AccessKey、Secret、Token 或缓存不得出现在源文件、对话、日志或测试产物中。
