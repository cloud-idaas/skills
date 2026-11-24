# 扫描结果与边界

- 初始扫描输出 `complete`、`errors`、文件数和命中位置。跳过依赖、构建目录、`vendor/`、`testdata/`、锁文件和符号链接。保留 `bin/` 下的 Node.js 源码，因为 npm 命令入口可能位于该目录。目录或文件读取失败、配置超过 2 MiB 时结果不完整。
- `cloud_sdk` 标出 SDK 引用，`credential_field`、`credential_env` 和 `access_key_literal` 供核对凭证来源，`manual_sts` 标出手工换票，`idaas_provider` 标出潜在接入点。输出只含位置和类型。
- `--verify` 阻断固定认证绑定、明文凭证字段、已知静态凭证环境变量读取和明文配置。源码检查直接读取、可确定的常量键、环境对象别名和解构，包括测试源码。点分隔和驼峰前缀的凭证配置键以及明文 Shell 默认值同样检查。
- YAML 块式 `env` 条目中的 `name` 和 `value` 可以任意排序。凭证型名称搭配内联明文值会标为 `k8s_env_credential_suspect`。显式变量引用和 `valueFrom` 需追踪实际注入。模板、运行时拼接和复杂 YAML/Helm 表达式仍需人工核对。
- 测试源码仍参与明文凭证普查，但 `*.test.*`、`*.spec.*`、测试/fixtures 目录和声明文件不用于证明生产凭证绑定。生产入口的结果优先，逐项记录告警是否属于动态引用、测试数据或残留静态凭证。
- 语法检查和退出码见 [离线验证](verification.md#离线验证)。多包、跨文件、依赖注入和旧版自定义签名路径按实际入口人工复核。
