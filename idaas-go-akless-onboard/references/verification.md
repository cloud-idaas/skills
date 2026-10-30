# 语法分析与探针

## 语法树与有限数据流

在词法 verify 之后运行：

```bash
python3 <skill-dir>/scripts/analyze_auth.py --repo <repo> --json
```

使用本机 Go 工具链或完整 JDK（javac/java），不安装第三方解析库，不编译或执行目标业务代码。Go 使用 go/parser；Java 使用 JavacTask.parse，并关闭注解处理。工具类在临时目录构建，业务仓库不写入产物。

报告按客户端/凭证绑定位置输出文件、行、作用域、family 和 status：

- `idaas_provider`：在支持的同文件表达式范围内追踪到 IDaaS provider。
- `static_auth`：发现明确的静态凭证表达式，必须处理。
- `unresolved`：存在外部来源、参数、分支、循环、重赋值、递归或未支持形式，需人工复核，不能判为完成。

支持同文件变量别名、唯一无参工厂方法返回值、Java builder 变量，以及部分 Go 配置对象字段。仅支持显式 import；通配 import、跨文件/模块、重载类型解析、依赖注入、接口动态分派、setter 对象状态及复杂控制流不作证明。Go 条件表达式内的绑定与 Java 条件分支绑定保守处理。报告中的 provider 关联不证明初始化顺序、方法被实际调用或运行鉴权成功。

Go 旧 SDK 的 AccessKey/STS 静态构造器和 OSS V2 静态 provider 单独列为 static_auth；静态表示固定凭据绑定，不等于已确认长期 AK。OSS V2 配置表达式中的已知 region/endpoint/path-style/retry 选项可保留已有 provider 关联；后续重新设置 provider 时，以最后一次绑定为准，未知选项不作安全推断。

`syntax_complete=false` 表示工具不可用、解析错误或文件读取不完整。`ok=true` 仅表示已识别的绑定均可关联；不是所有业务客户端已覆盖的证明。只有绑定 setter 而未识别客户端、无生产源码、任一 unresolved 时 `review_required=true`、退出码为 1。保持词法扫描与人工客户端清单核对，不能用语法检查替代它们。

## 离线签名契约

```bash
python3 <skill-dir>/scripts/run_probe.py --mode contract
# 依赖已经缓存时，可以强制依赖解析离线
python3 <skill-dir>/scripts/run_probe.py --mode contract --offline-deps
```

探针使用 assets/probe 中固定版本的真实旧版 OpenAPI SDK 和参考桥接 provider：验证首次签名、模拟凭证轮换后的再次签名、缓存启动快照的反例，以及凭证来源失败时不能成功访问。Go 使用内存 HTTP transport；Java 只监听 127.0.0.1 的随机端口并在结束时关闭。测试不访问云端，不需要部署 Secret。

构建在隔离临时目录内进行；依赖首次解析可能需要网络。Go 使用 Go 工具链；Java 使用完整 JDK 和 Maven。探针的固定版本和业务项目实际依赖分别记录。成功仅证明参考桥接路径的签名契约，不证明 IDaaS SDK 内部缓存刷新、OSS/SLS 所有实现或业务项目调用链。项目有自定义桥接逻辑时，还要在项目中执行等价契约测试。

## 获授权后的只读冒烟

先按入口说明准备真实配置、角色与认证环境；由安全通道注入 Secret。然后在获授权的部署环境执行：

```bash
python3 <skill-dir>/scripts/run_probe.py --mode smoke --allow-cloud-read \
  --config /path/to/client-config.json --region cn-hangzhou
```

角色 ARN 从 ALIBABA_CLOUD_ROLE_ARN 读取，也可通过 --role-arn 显式提供。实际 SDK 与校验器使用同一 CLOUD_IDAAS_CONFIG_PATH。只调用固定 ECS DescribeRegions，不提供任意 Action、脚本或自定义目标地址入口；不改写业务仓库和权限策略。测试角色必须事先获准调用此 API，否则可能出现凭证取得成功、读调用失败。

报告含阶段、结果、耗时、credential_acquired、cloud_called；SDK 原始输出和异常文本不转发，避免凭证或响应泄漏。探针不重试权限错误、不回退长期 AK。失败时在授权环境自行对照对应阶段排查；不要把原始 SDK 日志粘贴到交付报告。

`cloud_called` 表示已启动真实模式（可能在访问业务 API 之前的认证阶段失败），不证明请求完成。`refresh_expiry_verified` 始终为 false，smoke 的 resource_denial_verified 也为 false；获批/未获批业务资源及跨有效期长跑仍必须另外实测。未执行真实模式时，交付必须标注未执行。

解析器依据：[Go parser](https://pkg.go.dev/go/parser)、[JDK Compiler Tree API](https://docs.oracle.com/javase/8/docs/jdk/api/javac/tree/com/sun/source/util/JavacTask.html)。
