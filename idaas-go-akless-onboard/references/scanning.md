# 扫描结果与边界

运行 scan 后、解释 verify 的告警前读取本页。

## 完整性与报告

- 本语言扫描完整性字段为 `_errors` / `_scan_complete`。源文件或配置读取失败、目录遍历失败、配置超过 2 MiB 都必须处理后重跑；退出码非零或完整性为假不能判为通过。
- 报告仅保留位置与类型，不输出凭证原文。变量字段、setter 或重载构造器的 warning 需结合 SDK、参数类型和来源判断，不凭变量名断言真实长期凭据。
- 静态 SLS 工厂和 OSS 构造器需改为动态 provider；合法的 provider 重载可能产生人工复核提示。

## 配置与 YAML

- Spring 属性引用允许连字符；带非空明文默认值的引用仍需检查。
- `${ENV-fallback}` 等大写环境变量加连字符的表达式可能是 Shell 默认值语法，保留告警并人工确认，不能自动视为安全引用。
- YAML 块式 env 列表中，敏感变量名配合内联值产生 `k8s_env_credential_suspect` warning，仅表示疑似凭据；逐项判断后处理，不自动删除或替换。
- 已识别的敏感 env.value（含块字符串）由结构规则处理，不让通用字段正则重复解释值内表达式；独立 AK 字面量检查仍生效。
- 结构检查不覆盖完整 YAML/Helm 语法，行内 flow mapping 等形式需人工核对。

## 人工核对

scan/verify 保留词法检查作为兜底；另外按 [语法分析与探针](verification.md) 执行语法树和有限数据流检查。两者均不证明运行路径或多模块接入完整。逐个核对业务客户端实际使用的 provider，所有 warning 均记录处理结论。

## 已识别路径与复核边界

- Dockerfile、Dockerfile.* 和 *.Dockerfile 都纳入配置普查；已知字段包括 credentialId/credentialSecret、带前缀的 *_AK/*_SK 和 archive.ak/sk。JVM -D 参数按各自值边界检查，不把后续命令参数误当作凭据默认值。
- Go 的显式旧 SDK AccessKey/STS 构造器与 OSS V2 静态 provider、Java 的 OSS DefaultCredentialProvider 会产生 blocking；这里的静态指客户端固定持有凭据，不能据此断言它必然是长期 AK。
- Go NewCredential(nil)、Java 无参 credentials.Client 产生 default_credential_chain warning，表示链路可能命中环境或挂载文件中的长期 AK，不表示已证明最终来源。HMAC 与 OSS Authorization 组合产生 manual_oss_signer warning，需人工追踪密钥来源。
- manual_sts 检查角色交换调用或 Action；普通 SecurityToken 字段不等于手动 STS。桥接回调中每次读取的局部凭据模型不等于持久缓存，字段/静态/缓存变量赋值仍需复核。
- 自定义环境变量包装函数、参数、base64 恢复、数据库、配置中心、Spring 注入和跨文件 provider 仍需沿业务入口核对来源；无专用命中不能标为安全。不要把 *_AK/*_SK 的已知字段规则外推为能识别任意自定义命名。
- Go JSON 报告的 auth_findings 单独列出新增的 blocking/warning；原 auth_warnings 保留原语义。所有报告只输出位置与类型，不包含凭据文本。
