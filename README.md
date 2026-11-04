# dsh-ima-kb-panel

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的 **ima 知识库**插件：

- **左侧栏一个入口**：随时点开，浏览、全文检索、滚动阅读 ima 笔记，**不消耗模型上下文**
- **对话里三个工具**：`kb_list` / `kb_search` / `kb_read`，让 AI 按需检索、**分页**读取
- **只读**：不写笔记、不上传、不删除

> 为什么要这个插件：ima 的 OpenAPI 里 `get_doc_content` **没有分页参数**，一篇几十万字的笔记会被一次性塞进上下文。这个插件把「检索 + 按字符偏移分页读」补上了，并且把浏览这件事搬到侧边栏，不占上下文。

---

## 1. 前置条件

| 需要 | 说明 |
|---|---|
| DSH | 桌面版或 Web 版都行（插件是 profile 级安装） |
| ima 凭证 | `Client ID` + `API Key`，在 <https://ima.qq.com/agent-interface> 生成 |
| 网络 | 能访问 `https://ima.qq.com` |

## 2. 安装（三种方式，按顺手程度选）

装完后**都要重启 DSH** 才会加载新插件。

### 方式 A：把 release 里的 `.tgz` 交给 DSH 里的 AI（最省事）

1. 从本仓库 **Releases** 下载 `dsh-ima-kb-panel-1.1.0.tgz`，放到任意目录
2. 在 DSH 里新开一个会话，把下面这段贴进去（把路径换成你实际的）：

```
请帮我安装本地插件：C:\Users\你的用户名\Downloads\dsh-ima-kb-panel-1.1.0.tgz
用 plugin_manager 的 install_bundle 安装，装完告诉我是否需要重启。
```

AI 会调 `plugin_manager` 完成安装。装完重启 DSH。

### 方式 B：自己调工具

```
plugin_manager(action="install_bundle", target="<tgz 的绝对路径>")
```

### 方式 C：从源码目录安装（改代码时用）

```
plugin_manager(action="install_bundle", target="<本仓库目录的绝对路径>")
```

> ⚠️ 用目录安装是 **软链接**（`link:`），DSH 会报 `restart-required`；用 `.tgz` 安装是真实拷贝，热应用更顺。**改完代码要重新 `pnpm pack` 再装**。

## 3. 装完怎么确认可用

1. 重启 DSH，左侧图标栏应出现 **书本+放大镜** 图标（在插件 / Skill·MCP / 市场 后面）
2. 点它：能看到笔记列表和搜索框 → 说明面板和本机接口都通了
3. 在对话里问一句：**「查一下我的知识库：仓位管理我是怎么讲的？」** → AI 应调用 `kb_search` 并引用原文

如果面板显示「还没连接 ima 账号」，说明凭证没放好 —— 见下一节。

## 4. 换机器 / 换账号：重新关联知识库

插件对 **ima 账号**没有硬编码：它列出当前凭证能看到的**全部笔记**。所以「换知识库」= 换凭证或加过滤，不用改代码。

### 4.1 凭证放哪（默认）

```
~/.config/ima/client_id     ← Client ID
~/.config/ima/api_key       ← API Key
```

Windows 上就是 `C:\Users\<你>\.config\ima\`。**一行一个，不要引号，不要多余空格。**

面板的「首次运行」界面会直接把这两个绝对路径显示出来，照着建即可。

### 4.2 也可以用环境变量

`IMA_CLIENT_ID` / `IMA_API_KEY`，**优先级高于文件**。

### 4.3 在 DSH 里改配置（不用碰代码）

**设置 → 插件 → ima 知识库面板**，或直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: ima-kb-panel
  name: 'dsh-ima-kb-panel'
  config:
    credentialsDir: 'D:/ima-creds'      # 凭证目录换地方
    titleFilter: '雪球,宏观'             # 只纳入标题含这些词的笔记
    maxNotes: 20
    contentTtlMinutes: 10
```

| 配置项 | 默认 | 作用 |
|---|---|---|
| `credentialsDir` | 空（= `~/.config/ima`） | 凭证目录 |
| `baseUrl` | `https://ima.qq.com` | 接口根地址，一般不用改 |
| `clientIdEnv` | `IMA_CLIENT_ID` | client_id 读哪个环境变量 |
| `apiKeyEnv` | `IMA_API_KEY` | api_key 读哪个环境变量 |
| `maxNotes` | 20 | 最多列出多少篇（ima 单页上限 20） |
| `contentTtlMinutes` | 10 | 正文缓存分钟数 |
| `titleFilter` | 空 | 只看标题含这些词的笔记，逗号分隔 |

### 4.4 换了一台电脑，最短路径

1. 装插件（第 2 节）
2. 建 `~\.config\ima\client_id` 和 `api_key` 两个文件，粘贴凭证
3. 重启 DSH → 点图标 → 能看到笔记就成

## 5. 工具说明（给 AI 看）

| 工具 | 用途 | 有界 |
|---|---|---|
| `kb_list()` | 列出笔记：标题、`note_id`、字数、开头预览 | ✅ |
| `kb_search(query, note_id?, limit?)` | 全库**子串**检索，一篇可回多段，带字符偏移量 | ✅ 片段 ≤ 600 字，默认 8 段 |
| `kb_read(note_id, offset?, limit?)` | 按偏移分页读正文 | ✅ 默认 6000 字，上限 3 万字 |

> ⚠️ **不要**用 `mcp__ima-kb__get_note_content` 读大笔记：无分页，一次返回整篇（最长 54.8 万字符）。
>
> 检索是**字面匹配**，不是语义检索：搜「止损」能找到，搜「亏了怎么办」不一定能找到「止损」。

## 6. 本机 HTTP 接口

面板用，均需浏览器同源会话（未授权返回 401/403）：

| 接口 | 返回 |
|---|---|
| `GET /ima-kb/api/state` | 连接诊断：是否配置、凭证来源、路径、过滤词、笔记数 |
| `GET /ima-kb/api/notes` | 笔记列表 |
| `GET /ima-kb/api/warm` | 预热全部正文，返回字数 |
| `GET /ima-kb/api/note?id=&start=&length=` | 正文切片 |
| `GET /ima-kb/api/search?q=&limit=` | 检索结果 |
| `GET /ima-kb/api/refresh` | 清缓存 |

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 侧边栏没图标 | 还没重启 DSH；或安装失败 —— 用 `plugin_manager` 看 `application` 字段 |
| 面板显示「还没连接 ima 账号」 | 凭证文件没建 / 路径不对 / 内容带引号。看面板上显示的路径 |
| 面板显示「没有权限访问本机知识库接口」 | 浏览器会话失效，刷新页面重开 |
| `kb_search` 搜不到 | 字面匹配。换材料里可能出现的**原词**；或用 `kb_list` 确认笔记在不在 |
| 搜索结果少了 | 设了 `titleFilter`，只有标题命中的笔记会被检索 |
| 接口报 `code=20004` | ima 凭证无效或过期，重新生成 |
| 接口报 `code=210005` | 不是笔记作者（别人的笔记读不了） |

## 8. 安全与隐私

- **只读**：没有任何写入 / 上传 / 删除接口
- **凭证只在本地**：从文件或环境变量读取，不发往除 `ima.qq.com` 以外的任何地址
- 插件只连 `baseUrl`（默认 `https://ima.qq.com`），不收集遥测

## 9. 开发

```
index.js          Host 半个：HTTP 接口 + 三个工具 + Config
client.js         Client 半个：侧边栏图标 + 主面板（React，无构建步骤）
cordis.patch.yml  bundle patch：插入一行 ima-kb-panel
locale/           插件管理器里显示的名字与说明
icon.svg          插件图标
```

本地改完：

```bash
pnpm pack --pack-destination <输出目录>    # 产物是 npm 风格的 .tgz
```

然后把 `.tgz` 用 `install_bundle` 装一次（DSH 会热应用），重启 DSH 生效。

## 10. License

MIT，见 [LICENSE](./LICENSE)。
