# 上线验收清单

## 本地改造与验证

- [ ] 目标业务文件与云客户端逐项核对；疑似第三方/跨云/共享凭证变更已按授权范围处理。
- [ ] 本地验证不依赖部署 Secret；配置、角色 ARN 或外部授权不足时已列出运行待补项。
- [ ] 构建方式与多模块检查范围按 `build.md` 记录。

## 运行前置校验

- [ ] 平台下发的配置文件以 `--phase runtime` 校验通过，关键字段无占位符（路径以 `--config` / `CLOUD_IDAAS_CONFIG_PATH` / SDK 默认路径为准，文件名不限），`scope` 为无 AK 固定值。
- [ ] 业务进程与校验器使用同一配置路径，真实角色 ARN 已注入。
- [ ] `CLIENT_SECRET_*` / `PRIVATE_KEY_JWT` 场景中，相应 Secret/私钥字段指定的环境变量已由部署环境非空注入。
- [ ] 校验日志只包含环境变量名，不包含 Secret 值。

## 编译与构建

- [ ] 按 `build.md` 使用项目 wrapper/构建入口，Maven 或 Gradle 编译与测试通过。
- [ ] 已记录聚合根与受影响模块；无法执行的任务单独列为未验证。

## 语法与离线契约

- [ ] analyze_auth.py 的 syntax_complete 为真；逐客户端处理 static_auth / unresolved，缺少工具或解析失败不可视为无问题。
- [ ] run_probe.py --mode contract 通过；已记录探针固定 SDK 版本，明确只验证参考桥接方案，不冒充业务项目或真实续期验证。

## 功能与安全验收

- [ ] `IDaaSCredentialProviderFactory.init()` 成功初始化 Core SDK；PAM provider 成功换取 StsToken。
- [ ] 获批资源访问成功，未获批 Bucket 或前缀返回 403。
- [ ] 扫描无源文件/配置读取错误、目录遍历错误或超限配置；扫描完整性标志为真。
- [ ] `verify_akless.py` 输出 `ok=true` 且 `violations=[]`；`warnings` 全部逐条人工确认并记录结论。
- [ ] 代码、配置、镜像与 CI 中没有长期 AK/SK 或 Client Secret（含 scan/verify 的非代码配置文件普查 `config_hits` 中 blocking 项清零；`k8s_env_credential_suspect` warning 已逐项复核，记录真实凭据、测试值、模板或引用的判断与处理结论，重点关注 application.yml/properties）。

## 稳定性与回退

- [ ] 长跑超过 StsToken 有效期仍能自动续期。
- [ ] 停用旧 AK/SK 前完成观察期；异常时回滚应用发布物，不回滚权限基线。

## 交付状态

- [ ] 分别记录本地验证与运行验收：通过 / 失败 / 未执行；配置结构通过不等于云端认证通过。
- [ ] 外部只读调用、未授权资源拒绝与跨有效期续期均有实际结果；未执行项不能勾为通过。
