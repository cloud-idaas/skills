# CLI 安装引导（未安装时使用）

A0 检测到用户需要但尚未安装的 CLI 时，按本文件对应小节引导安装。安装验证通过后回到 A0 继续（**不阻塞**其他已安装 CLI 的 onboard 流程）。

## aliyun-cli

根据操作系统自动选择安装方式：

**macOS**：
```shell
# 方式一：Homebrew（推荐，若已装 brew）
brew install aliyun-cli

# 方式二：官方脚本
/bin/bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/install.sh)"
```

**Linux**：
```shell
# AMD64 示例，ARM64 将 amd64 改为 arm64
curl https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz -o aliyun-cli.tgz
tar xzvf aliyun-cli.tgz && sudo mv ./aliyun /usr/local/bin/
```

**Windows**：执行本 skill 自带的安装脚本（需将 `<skill-path>` 替换为本 skill 的实际绝对路径）；下载可能较慢，运行该命令时，将工具超时设为其允许的最长时长，避免下载中途终止。
```powershell
powershell -ExecutionPolicy Bypass -File <skill-path>/scripts/Install-AliYunCLI-Windows.ps1
```

**验证**：`aliyun version`（成功输出版本号即安装完成）。PATH 仅对新开终端生效，当前会话用完整路径：`& "$env:LOCALAPPDATA\AliyunCLI\aliyun.exe" version`。
> 文档参考：https://help.aliyun.com/zh/cli/install-update-alibaba-cloud-cli

## aws-cli

根据操作系统自动选择安装方式：

**macOS**：
```shell
# 方式一：Homebrew（若已装 brew）
brew install awscli

# 方式二：官方 pkg
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /
```

**Linux**：
```shell
# AMD64
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# ARM64
curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install
```

**Windows**：执行本 skill 自带的安装脚本（需将 `<skill-path>` 替换为本 skill 的实际绝对路径）；下载可能较慢，运行该命令时，将工具超时设为其允许的最长时长，避免下载中途终止。
```powershell
powershell -ExecutionPolicy Bypass -File <skill-path>/scripts/Install-AWSCLI-Windows.ps1
```

**验证**：`aws --version`（成功输出版本号即安装完成）。PATH 仅对新开终端生效，当前会话用完整路径：`& "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe" --version`。
> 文档参考：https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

## TCCLI

TCCLI 依赖 Python 和 pip。先检测 Python 版本（Mac/Linux: `python3 --version`；Windows: `python --version`）以及对应的 pip，未检测到 Python 或 pip 时：不默认安装，向用户报告缺失并跳过 TCCLI 安装（不阻塞其他 CLI 接入）。

**macOS**：
```shell
# 方式一：Homebrew
brew tap tencentcloud/tccli
brew install tccli

# 方式二：pip
sudo pip install tccli
```

**Linux**：
```shell
sudo pip install tccli
```

**Windows**：
```shell
pip install tccli
```

**升级（仅 pip 方式）**：从 3.0.252.3 以下版本升级时，需先卸载 tccli 与 jmespath 再重装：（Mac/Linux: `sudo pip uninstall tccli jmespath && sudo pip install tccli`；Windows: `pip uninstall tccli jmespath && pip install tccli`）。

**验证**：`tccli --version`（退出码为 0 且输出版本号即安装完成）。

> 文档参考：https://cloud.tencent.com/document/product/440/34011 （操作指南 → 安装 TCCLI）
