# dsh-ima-kb-panel

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的 **ima 知识库**插件：

- **左侧栏一个入口，两个页签**：
  - **笔记**：按分类（课程原文 / 学员总结 / 盘中记录 / 公众号文章…）折叠浏览、全文检索、滚动阅读，**不消耗模型上下文**
  - **知识库**：浏览个人知识库的文件夹/文件（Word/PDF），按文件名检索，**下载原始文件**
- **对话里六个工具**：`kb_list` / `kb_search` / `kb_read`（笔记）+ `kb_space_list` / `kb_space_browse` / `kb_space_search`（知识库），全部按需、有界
- **只读**：不写笔记、不上传、不删除（本机正文缓存文件除外）

> 为什么要这个插件：ima 的 OpenAPI 里 `get_doc_content` **没有分页参数**，一篇几十万字的笔记会被一次性塞进上下文。这个插件把「检索 + 按字符偏移分页读」补上了，并且把浏览这件事搬到侧边栏，不占上下文。

## 1.5.0 性能（取知识太慢的解法）

| 场景 | 1.4.0 | 1.5.0 |
|---|---|---|
| 冷启动预热 70 篇 | ~105s | **~50s**（2 实例并发 + 700ms 节拍，实测零限流） |
| DSH 重启后 | 全量重取 70 篇 | **只补 modify_time 变过的笔记**（通常几篇，秒级） |
| 面板打开 | 走 4 次列表接口 | 磁盘列表直接渲染（5 分钟内不再打接口） |

- **按 `modify_time` 增量预热**：缓存里记住每篇的 `modify_time`，没变过就不重取。
- 实测数据：`get_doc_content` 单篇 0.86s；串行 800ms 节拍 = 1.5s/篇；
  「2 个在飞 + 起步间隔 700ms」= 0.74s/篇，24 次并发零 `code=200001`。
- `contentTtlMinutes` 语义改为「磁盘正文最长保留期」（默认 7 天），是否重取看 `modify_time`。

## 1.4.0 新功能

- **`kb_find(query, start?)`**：ima 官方 `search_note` 分词召回——**换一种说法也能找到**。
  与 `kb_search`（本地字面匹配、带 offset）互补：不确定原文措辞先用 `kb_find` 找候选篇。
- 面板字面检索无命中时自动补一轮模糊检索，结果直接可点开。

## 1.3.0 新功能

- 面板分「笔记 / 知识库」两个页签；笔记列表自动按标题分类（篇数 + 字数徽标、可折叠）
- 知识库页：选知识库 → 面包屑 + 文件夹树 + 文件名检索 → 文件详情 → 「下载原文」（Host 代理带签名的 Word/PDF）
- 新工具：`kb_space_list` / `kb_space_browse` / `kb_space_search`

## 1.2.0 修了什么

| 问题 | 原因 | 现状 |
|---|---|---|
| 面板永远显示「没有权限访问本机知识库接口」 | 鉴权围栏用 `ctx.connection` 访问未注入的 Service，Cordis 抛错被 catch 吞成 403 | 改用 `ctx.get('connection')`，浏览器同源请求正常通过 |
| 只显示前 20 篇笔记 | `list_note` 单页上限 20，插件没翻页 | 自动翻页到 `is_end`，`maxNotes` 默认 200 |
| 很多笔记取不到正文、检索范围缩水 | ima 限流 `code=200001`（HTTP 403），v1.1.0 并发 4 直接撞限流 | 串行 + 最小间隔 800ms + 指数退避重试，实测全部命中 |
| 每次启动都要重新预热 2 分钟 | 正文只缓存在内存，10 分钟过期 | 正文落盘 `~/.dsh/cache/ima-kb-panel/`，TTL 6 小时 |
| 打开就干等 | 无预热进度 | `/warm-status` 进度 + 进度条；启动 3 秒后自动后台预热 |
| 出错只知道「没有权限」 | 401/403 都被映射成同一句文案 | 显示真实 HTTP 状态与服务端消息，可重试 |

> **第一次装完要等一会儿**：这个库有 70+ 篇、约 200 万字，ima 单篇正文要一次请求，
> **正文默认不自动下载**（v2.5.0 起 `autoWarm=off`）：要点一次「⋯ → 缓存全部正文」才会取，进度显示在面板头部。预热完成后写入磁盘缓存，
> 之后重启 DSH 只补「变过的笔记」。
> 预热完成后会写入磁盘缓存，之后重启 DSH 是秒开。

---

## 2. 前置条件

| 需要 | 说明 |
|---|---|
| DSH | 桌面版或 Web 版都行（插件是 profile 级安装） |
| ima 凭证 | `Client ID` + `API Key`，在 <https://ima.qq.com/agent-interface> 生成 |
| 网络 | 能访问 `https://ima.qq.com` |

## 3. 安装

装完后**都要重启 DSH** 才会加载新插件。

### 方式 A：把 release 里的 `.tgz` 交给 DSH 里的 AI（最省事）

```
请帮我安装本地插件：<路径>\dsh-ima-kb-panel-1.2.0.tgz
用 plugin_manager 的 install_bundle 安装，装完告诉我是否需要重启。
```

### 方式 B：自己调工具

```
plugin_manager(action="install_bundle", target="<tgz 的绝对路径>")
```

### 方式 C：从源码目录安装（改代码时用）

```
plugin_manager(action="install_bundle", target="<本仓库目录的绝对路径>")
```

> ⚠️ 用目录安装是 **软链接**（`link:`），DSH 会报 `restart-required`；用 `.tgz` 安装是真实拷贝，热应用更顺。**改完代码要重新 `pnpm pack` 再装**。

### 方式 D：从 GitHub 更新（换电脑 / 升级，推荐）

只升级**插件本身**可以完全走 GitHub：每个 `v*` tag 会由 Actions 自动打包并发 Release。

1. 打开 Releases：`github.com/how8088/dsh-ima-kb-panel/releases`（公开仓库，不用登录）
2. 下载最新的 `dsh-ima-kb-panel-<版本>.tgz`
3. 在 DSH 里新开会话，把这句话发给 AI（路径换成实际路径）：
   ```
   请用 plugin_manager 安装本地插件：<tgz 完整路径>
   ```
4. 重启 DSH（或刷新页面）

**第一次在新电脑上装完整体系**（这两样不在插件里自动完成，各处理一次）：

| 东西 | 怎么弄 |
|---|---|
| ima 凭证 | 把 `~/.config/ima/client_id` 与 `api_key` 复制到新电脑同路径（**绝不要进仓库**） |
| 两个技能 | **v2.2.0 起插件启动时会自动装到 `~/.dsh/skills/`（已存在不覆盖）**，无需手动；想手动就复制本仓库 `skills/` 过去 |
| AGENTS.md 联动段 | 把 `docs/AGENTS-联动段.md` 的内容追加到 `~/.dsh/AGENTS.md`（v2.3.0 起这份文档随包安装，位在插件目录的 `docs/` 下） |
| 通达信 MCP | 在新电脑的 DSH 里配置（token 只在你自己的机器上，仓库里没有） |

> **技能现在随包自动安装**（v2.2.0 起）：插件启动时把 `market-research` / `ima-kb` 复制到 `~/.dsh/skills/`；目标已存在就跳过，**不会覆盖你改过的版本**。想更新技能就删掉旧目录再重启 DSH。
>
> **桌面版（Electron，kernel 包在 app.asar 里）不用再手工改 import**（v2.3.0 起）：插件启动时会先用裸包名解析 `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`，失败再按 `process.execPath` 反推安装目录从 `app.asar` 里读，换安装路径也不用改代码。以前那套「改 import 路径 + schemastery junction」的补丁可以退役了。

## 4. 装完怎么确认可用

1. 重启 DSH，左侧图标栏应出现 **书本+放大镜** 图标（在插件 / Skill·MCP / 市场 后面）
2. 点它：左侧应列出**全部笔记**（不只是 20 篇），头部显示 `N 篇 · M 字`；正文还在后台载入时显示「载入正文 N/M」和进度条
3. 在对话里问一句：**「查一下我的知识库：仓位管理我是怎么讲的？」** → AI 应调用 `kb_search` 并引用原文

如果面板显示「还没连接 ima 账号」，说明凭证没放好 —— 见下一节。

## 5. 换机器 / 换账号：重新关联知识库

插件对 **ima 账号**没有硬编码：它列出当前凭证能看到的**全部笔记**。所以「换知识库」= 换凭证或加过滤，不用改代码。

### 5.1 凭证放哪（默认）

```
~/.config/ima/client_id     ← Client ID
~/.config/ima/api_key       ← API Key
```

Windows 上就是 `C:\Users\<你>\.config\ima\`。**一行一个，不要引号，不要多余空格。**

面板的「首次运行」界面会直接把这两个绝对路径显示出来，照着建即可。

### 5.2 也可以用环境变量

`IMA_CLIENT_ID` / `IMA_API_KEY`，**优先级高于文件**。

### 5.3 在 DSH 里改配置（不用碰代码）

**设置 → 插件 → ima 知识库面板**，或直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: ima-kb-panel
  name: 'dsh-ima-kb-panel'
  config:
    credentialsDir: 'D:/ima-creds'      # 凭证目录换地方
    titleFilter: '雪球,宏观'             # 只纳入标题含这些词的笔记
    maxNotes: 200
    contentTtlMinutes: 360
```

| 配置项 | 默认 | 作用 |
|---|---|---|
| `credentialsDir` | 空（= `~/.config/ima`） | 凭证目录 |
| `baseUrl` | `https://ima.qq.com` | 接口根地址，一般不用改 |
| `clientIdEnv` | `IMA_CLIENT_ID` | client_id 读哪个环境变量 |
| `apiKeyEnv` | `IMA_API_KEY` | api_key 读哪个环境变量 |
| `maxNotes` | 500 | 最多收录多少篇（1–500，插件自动翻页） |
| `contentTtlMinutes` | 10080 | 磁盘正文最长保留期（分钟）；是否重取看 modify_time |
| `cacheDir` | 空（= `~/.dsh/cache/ima-kb-panel`） | 正文缓存目录，填 `-` 表示不落盘 |
| `titleFilter` | 空 | 只看标题含这些词的笔记，逗号分隔 |
| `skillsDir` | 空（= `~/.dsh/skills`） | 随包技能安装到哪 |
| `autoInstallSkills` | `on` | 启动时自动装随包技能（已存在跳过）；填 `off` 关闭 |
| `autoWarm` | `off` | 是否自动把全部笔记正文拉到本地。默认 off：**只有你手动点「⋯ → 缓存全部正文」才取**；填 `on` 恢复启动/检索时后台自动预热 |

### 5.4 换了一台电脑，最短路径

1. 装插件
2. 建 `~\.config\ima\client_id` 和 `api_key` 两个文件，粘贴凭证
3. 重启 DSH → 点图标 → 能看到笔记就成

## 6. 工具说明（给 AI 看）

| 工具 | 用途 | 有界 |
|---|---|---|
| `kb_list(query?)` | 列出全部笔记：标题、`note_id`、字数、开头预览；笔记多时可用 `query` 只列标题含该词的 | ✅ |
| `kb_search(query, note_id?, limit?)` | 全库**子串**检索，一篇可回多段，带字符偏移量 | ✅ 片段 ≤ 600 字，默认 8 段 |
| `kb_read(note_id, offset?, limit?)` | 按偏移分页读正文 | ✅ 默认 6000 字，上限 3 万字 |
| `kb_find(query, start?)` | ima **官方分词检索**：换一种说法也能找到，返回命中笔记列表 | ✅ 每页 20 篇 |
| `kb_space_list()` | 列出可见的知识库（`kb_id`、文件数、说明、角色） | ✅ |
| `kb_space_browse(kb_id, folder_id?, limit?)` | 列目录：文件夹 / 文件（`media_id`、类型） | ✅ 单页 ≤ 50 条 |
| `kb_space_search(kb_id, query, limit?)` | 按**文件名/文件夹名**检索（不搜正文） | ✅ ≤ 50 条 |

> ⚠️ **不要**用 `mcp__ima-kb__get_note_content` 读大笔记：无分页，一次返回整篇（最长 54.8 万字符）。
>
> 检索是**字面匹配**，不是语义检索：搜「止损」能找到，搜「亏了怎么办」不一定能找到「止损」。
>
> 首次检索前需要把全部笔记正文取到本机缓存（Host 侧并发 4），所以第一次检索会慢一些；
> 之后 6 小时内都是内存检索。面板头部的进度条就是这个过程。

## 7. 本机 HTTP 接口

面板用，均需浏览器同源会话（未授权返回 401/403）：

| 接口 | 返回 |
|---|---|
| `GET /ima-kb/api/state` | 连接诊断：是否配置、凭证来源、路径、过滤词、笔记数、预热进度 |
| `GET /ima-kb/api/notes` | 全部笔记列表（含字数、是否被 maxNotes 截断） |
| `GET /ima-kb/api/warm` | 预热全部正文，**阻塞到取完**，返回字数 |
| `GET /ima-kb/api/warm-status` | 预热进度快照：`running/total/done/failed/cached/listed` |
| `GET /ima-kb/api/note?id=&start=&length=` | 正文切片 |
| `GET /ima-kb/api/search?q=&limit=` | 检索结果 |
| `GET /ima-kb/api/find?q=&start=` | ima 官方分词检索（kb_find 同款） |
| `GET /ima-kb/api/refresh` | 清内存缓存（列表 + 正文 + 凭证 + 知识库目录）；个人知识库的**本地快照**不动，要清用 `kb-cache?clear=1` |
| `GET /ima-kb/api/kb` | 知识库列表（id、名称、文件数、说明、角色） |
| `GET /ima-kb/api/kb-files?kb=&folder=&cursor=` | 目录内容 + 面包屑（文件夹 99 / PDF 1 / Word 3） |
| `GET /ima-kb/api/kb-search?kb=&q=` | 按文件名检索（不搜正文） |
| `GET /ima-kb/api/kb-file?media_id=` | 文件详情与可下载性 |
| `GET /ima-kb/api/kb-raw?media_id=&title=` | 代理下载带签名的原始文件 |
| `GET /ima-kb/api/kb-cache` | 个人知识库缓存状态（占用、每个库的快照时间/文件数/正文数）；`?clear=1` 清空 |
| `GET /ima-kb/api/kb-warm?kb=` | 把一个**个人知识库**整棵缓存到本地，**阻塞到取完** |
| `GET /ima-kb/api/kb-warm-status` | 缓存进度快照：`running/stage/done/total/folderCount/fileCount` |

## 7.5 个人知识库本地缓存（v2.4.0 起）

**只缓存两样东西：笔记，和你自己的「个人知识库」。** 订阅 / 加入的共享知识库（如「宏观研报精选」「深证信公告库」）**不写磁盘**，仍然按原来的方式在线读取——那种库动辄几十万上百万文件，抓一遍要几小时，缓存没有意义。

判定依据是 ima 返回的 `base_type`：

| base_type | 例子 | 是否缓存 |
|---|---|---|
| `个人知识库` | 杰尼龟的知识库（Markdown 版） | ✅ 目录 + 正文 |
| `我加入的订阅知识库` | 宏观研报精选、深证信 | ❌ 在线读取（内存缓存 5/2/10 分钟照旧） |

缓存到 `~/.dsh/cache/ima-kb-panel/kb-<hash>.json`，包含知识库列表、个人库的整棵目录树、以及 md/docx/txt 的正文文本（PDF 不缓存：内嵌查看走签名地址，离线没有意义）。

两个页签各有一条缓存条（都是只读状态 + 一个 `⋯`）：

- **笔记**：列表顶部显示「已缓存 71/71 篇 · 5.5 MB」；没缓存过时是一个「缓存到本地」按钮。
- **知识库**：文件列表顶部显示「快照 11-06 00:20 · 61 个文件 · 6.0 MB」；没缓存过时同样是「缓存到本地」。

`⋯` 菜单里统一只有两项：**更新缓存**、**清空缓存**（清空要点两下：第一下变「确认清空？」，第二下才执行；点面板别处会取消）。缓存完成后，断网也能翻目录、读正文；订阅库断网时仍会报错（这是预期行为）。

配置项：

| 配置 | 默认 | 作用 |
|---|---|---|
| `kbCacheTtlMinutes` | 10080（7 天） | 个人库缓存保留多久 |
| `kbCacheText` | `on` | 预热时是否连正文一起缓存；`off` 只存目录 |
| `kbCacheMaxFiles` | 2000 | 单个个人库最多缓存多少篇正文 |

> ⚠️ ima 的 `get_knowledge_list` **没有 modify_time**，所以这里没有「增量」：过期与否只看 TTL，想拿最新版就点「更新快照」。面板显示的快照时间就是这份数据的年龄。

## 8. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 侧边栏没图标 | 还没重启 DSH；或安装失败 —— 用 `plugin_manager` 看 `application` 字段 |
| 面板显示「还没连接 ima 账号」 | 凭证文件没建 / 路径不对 / 内容带引号。看面板上显示的路径 |
| 面板显示「浏览器会话已失效（HTTP 401）」 | 页面会话过期，刷新页面重开 |
| 面板显示「本机接口拒绝了这次请求（HTTP 403）」 | 1.2.0 已修；若仍出现，说明 Host/Origin 校验没过（例如页面不是从 `127.0.0.1` 打开的） |
| 只剩 20 篇笔记 | 1.2.0 之前的版本；升级后应显示全部（或被 `maxNotes` 截断并提示） |
| 头部一直「载入正文 N/M」 | 69+ 篇、限流约 1.2 次/秒，冷启动要 1~2 分钟；`N/M` 会前进，失败篇数会体现在 `kb_search` 的提示里 |
| `kb_search` 说「本地只缓存了 X/Y 篇」 | 现在是纯手动模式：在面板点「⋯ → 缓存全部正文」补齐即可（不会自动在后台拉） |
| 接口报 `code=200001` | ima 频率限制。插件会自动退避重试；如果持续出现，说明同一个 Client ID 还被别的程序在用 |
| `kb_search` 搜不到 | 字面匹配。换材料里可能出现的**原词**；或用 `kb_list` 确认笔记在不在 |
| 搜索结果少了 | 设了 `titleFilter`，只有标题命中的笔记会被检索 |
| 接口报 `code=20004` | ima 凭证无效或过期，重新生成 |
| 接口报 `code=210005` | 不是笔记作者（别人的笔记读不了） |
| 接口报 `code=51` | 参数越界，例如 `limit` 超过 20（`list_note` 的单页上限） |

## 9. 安全与隐私

- **只读**：没有任何写入 / 上传 / 删除接口
- **凭证只在本地**：从文件或环境变量读取，不发往除 `ima.qq.com` 以外的任何地址
- **本机接口带浏览器会话围栏**：复用 DSH Connection 的 Host/Origin 与浏览器 Cookie 校验，
  未授权的本机进程拿不到笔记内容
- 插件只连 `baseUrl`（默认 `https://ima.qq.com`），不收集遥测

## 10. 开发

```
index.js          Host 半个：HTTP 接口 + 三个工具 + Config + 翻页/限流/缓存
client.js         Client 半个：侧边栏图标 + 主面板（React，无构建步骤）
cordis.patch.yml  bundle patch：插入一行 ima-kb-panel
locale/           插件管理器里显示的名字与说明
icon.svg          插件图标
test/host-e2e.mjs Host 半个的端到端测试（真打 ima，只读）
```

本地改完：

```bash
pnpm pack --pack-destination <输出目录>    # 产物是 npm 风格的 .tgz
```

然后把 `.tgz` 用 `install_bundle` 装一次（DSH 会热应用），重启 DSH 生效。

### 离线自测

```bash
node test/host-e2e.mjs        # 需要能访问 ima.qq.com，约 2 分钟（限流下的预热）
```

它用一个「未注入的 Service 访问会抛错」的假 ctx 装上插件，验证：

- 浏览器会话围栏（同源放行 / 未授权 401 / 外部 Host 403）；
- `list_note` 翻页（总数必须远大于单页上限 20 且 id 不重复）；
- ima 限流（`code=200001`）下每篇笔记仍能取到正文；
- 检索偏移量契约、工具输出、`/refresh`、磁盘缓存与冷启动命中。

> v1.1.0 的测试用的是普通对象当 ctx，所以「`ctx.connection` 访问未注入 Service 会抛错」
> 这个真实 Cordis 行为没被模拟出来 —— 线上面板一直 403 而测试全绿。
> 改 Host 半个时请先跑这个测试再装。

## 11. License

MIT，见 [LICENSE](./LICENSE)。
