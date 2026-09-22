# 上线验收清单

## 前置校验

- [ ] `client-config.json` 校验通过，`scope` 为无 AK 固定值。
- [ ] `CLIENT_SECRET_*` 场景中，`clientSecretEnvVarName` 指定的环境变量已由部署环境非空注入。
- [ ] 校验日志只包含环境变量名，不包含 Secret 值。

## 功能与安全验收

- [ ] `IDaaSCredentialProviderFactory.init()` 成功加载配置并取得 StsToken。
- [ ] 获批资源访问成功，未获批 Bucket 或前缀返回 403。
- [ ] `verify_akless.py` 输出 `ok=true` 且 `violations=[]`。
- [ ] 代码、配置、镜像与 CI 中没有长期 AK/SK 或 Client Secret。

## 稳定性与回退

- [ ] 长跑超过 StsToken 有效期仍能自动续期。
- [ ] 停用旧 AK/SK 前完成观察期；异常时回滚应用发布物，不回滚权限基线。
