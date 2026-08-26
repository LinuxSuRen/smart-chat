# AGENTS.md

本仓库的开发代理约定。任何代理（AI 或人类协作者）在本仓库工作前必须先读完本文件。

## 强制：提交前敏感信息检查

**每次 `git commit` 之前**（包括新提交、amend、rebase 产生的提交），必须执行敏感信息检查，未通过检查不得提交。

### 检查方式

优先使用工具自动扫描（gitleaks / trufflehog 等），仓库未配置工具时至少执行以下手动检查：

```sh
# 第一段：对将要提交的全部内容扫描通用敏感模式（暂存区）
git diff --cached --diff-filter=ACMR -U0 | grep -nEi \
  'password|passwd|secret|api[_-]?key|private[_-]?key|BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY' \
  && echo 'SUSPECT: review matches above before committing'

# 第二段：项目特定敏感值扫描——真实凭据赋值（占位值除外）与真实内网地址
git diff --cached --diff-filter=ACMR -U0 | grep -nEi \
  '(password|passwd|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_./+-]{12,}' \
  && echo 'SUSPECT: review credential-shaped values above'
```

两条命令都无输出才算通过。命中的无害情形（允许提交，但提交说明里不需提及）：

- 纯字段名 / 配置键名，如 `bridge.token`、`toolCallTimeoutMs`、`Authorization: Bearer` 协议字样；
- 明确的占位值：`https://api.example.com`、`secret`、`demo-placeholder-token`、`DEMO_API_PASSWORD: secret`；
- 本地回环测试地址 `http://localhost:8090/mcp`（联调用 MCP server，不含凭据）。

### 必查的敏感类别

- 密码、口令、passphrase（含测试 fixture、示例代码中的真实值）
- API key、token、Bearer 凭据、cookie
- 私钥（PEM/OpenSSH/PFX）、证书
- 内网/生产 IP 地址、内部域名
- 内部系统路径、主机名、用户名
- 数据库连接串（含密码部分的 DSN）

### 历史泄漏处理约定

- 一旦发现敏感值已进入任何提交（无论本地还是已推送），**立即视为已泄漏**：先轮换凭据，再清理历史
- 测试数据一律使用 `demo`/`example` 风格占位值（如 `https://api.example.com`、`DEMO_API_PASSWORD: secret`），绝不使用真实环境的任何值
- 敏感值出现在 commit message 中同样算泄漏，commit message 也要过一遍上述检查

### 防护性约定

- `.env`、`*.pem`、`*credentials*` 等文件一律不入库（`.gitignore` 已覆盖）
- 示例/文档中的配置一律用占位值，与真实环境相关的路径、IP、账号即使“看起来无害”也不写
- 引入新的依赖或脚本时，检查其是否携带硬编码凭据

## 提交约定

- 提交信息用祈使句、一行主题 + 可选正文
- 每次提交前运行 `npm test`，测试不通过不得提交
- 涉及 host/client 行为变更时同步更新 `README.md`
