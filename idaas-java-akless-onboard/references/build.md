# Java 构建与验证

先读取目标模块最近的构建文件、项目 CI 和工具链配置，保留原有 JDK、依赖约束与构建方式。Java 8 是 skill 的基础门槛，实际 SDK/项目要求更高时以构建声明为准。

| 项目 | 依赖位置 | 本地验证示例（在相应构建根目录执行） |
| --- | --- | --- |
| Maven | 模块 `pom.xml`；版本由项目既有 dependencyManagement 管理时沿用 | 有 `mvnw` 用 `./mvnw compile test`，否则 `mvn compile test` |
| Gradle Groovy | `build.gradle` 的 `dependencies` | 有 `gradlew` 用 `./gradlew classes test`，否则 `gradle classes test` |
| Gradle Kotlin | `build.gradle.kts` 的 `dependencies` | 同上 |

- 先看 wrapper 和 CI，双构建文件项目沿用实际入口，不运行两套构建、不擅自升级 wrapper/JDK。
- Maven reactor 子模块从聚合根执行 `./mvnw -pl <module-path> -am compile test`（无 wrapper 时替换为 `mvn`）。Gradle 从 settings 所在根执行 `./gradlew :<module>:classes :<module>:test`，按实际项目路径选择所有受影响模块。
- 给实际引用 adapter 的模块添加依赖；继承/版本集中管理保持原布局，不向所有模块机械添加依赖。
- 只有父 POM/BOM、无源码模块或缺少 test 任务的自定义项目，使用 CI 已定义的等价任务并说明覆盖范围；无法确认时记录未验证，不能冒称通过。
- 本地阶段不要求部署 Secret；构建中的云端集成测试单独运行。采用项目明确提供的本地测试 profile/任务，不临时关闭所有测试来获得通过结果。
- 记录构建根、模块、命令、退出结果及跳过项；依赖解析需网络时在报告中与云端认证区分。
