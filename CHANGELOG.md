# Changelog

## 1.1.0 — 2026-11-04

为「换机器 / 换账号」做的可移植性改造：

- **新增 `Config` 设置项**，可在 **设置 → 插件 → ima 知识库面板** 里改，不用碰代码：
  `credentialsDir` / `baseUrl` / `clientIdEnv` / `apiKeyEnv` / `maxNotes` / `contentTtlMinutes` / `titleFilter`
- **新增 `GET /ima-kb/api/state`** 连接诊断接口：是否配置、凭证来源（文件/环境变量）、文件绝对路径、过滤词、笔记数
- **面板新增首次运行引导**：没配凭证时直接列出两个凭证文件的绝对路径和「重新检查」，不再只报一个错误
- **`titleFilter` 标题过滤**：接入别的 ima 账号后，可以只纳入需要的笔记，避免串台
- `kb_list` 的描述改为「只在用户明确要求时使用」，与全局约定保持一致

## 1.0.0 — 2026-11-04

首个版本：

- 侧边栏入口（`sidebar.panellist`）+ 主面板：浏览 / 全文检索 / 滚动阅读，不消耗模型上下文
- 三个有界读取工具：`kb_list` / `kb_search` / `kb_read`
- 只读 HTTP 接口，带浏览器同源校验（未授权返回 401/403）
- 中文 / 英文界面文案
