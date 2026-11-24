# Node.js 构建与验证

1. 从每个改动文件向上找到最近的 `package.json`，核对 `engines.node`、模块格式、`tsconfig` 和仓库的 Node.js 版本声明。以项目 CI 与实际 SDK 依赖的要求为准。
2. 从根 manifest 的 `packageManager`、锁文件和 CI 命令确定包管理器。沿用已有入口。如果存在多个锁文件且目标归属不明，先核实 CI 实际使用的锁文件。
3. 单包项目在所属包目录安装和验证。多包项目读取 npm/yarn 的 `workspaces` 或 `pnpm-workspace.yaml`，列出改造包、被修改的共享包和直接受影响的消费者。由相应 workspace 更新 manifest 和根锁文件。根目录构建只有在覆盖这些包时可以充当验证。
4. 优先运行 CI 实际使用的构建、lint、类型检查和测试。没有仓库封装时可在工作区根按实际脚本名使用 `npm run build --workspace <package>`、`pnpm --filter <package> run build` 或 `yarn workspace <package> build`；类型检查和测试同理。按 CI 要求运行代码生成、构建前置流程和指定运行时版本。
5. 记录每包的路径、实际命令、退出码、解析后的 Core/adapter/服务客户端版本和未执行项。使用项目已有的离线或本地测试入口，云环境测试另记。构建失败保持未通过。
