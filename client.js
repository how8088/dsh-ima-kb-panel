/**
 * ima 知识库面板 — Client 半个插件。
 *
 * 在左侧栏 Global panel icons 里增加一个入口（id = ima-kb），并在主区分栏注册
 * 同名分栏。面板里分两个页签：
 *
 *   笔记    左侧是按「分类 → 分组」折叠树（学员总结 / 课程原文 / 盘中记录 / 公众号文章…
 *           自动按标题归类），顶部全文检索，右侧正文阅读器（滚动续读）。
 *   知识库  左侧选知识库 → 面包屑 + 文件夹/文件树 + 文件名检索，右侧文件详情 +
 *           「下载原文」（经 Host 代理，拿到带签名的原始 Word/PDF）。
 *
 * 数据全部来自本包 Host 半个插件的只读接口 /ima-kb/api/*。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ima-kb-panel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/ima-kb/api'
    const SNIPPET_LIMIT = 30
    const WINDOW_CHARS = 30000
    const JUMP_LEAD = 1200
    const TAB_KEY = 'dsh-ima-kb-panel:tab'
    const COLLAPSED_KEY = 'dsh-ima-kb-panel:collapsed'
    const KB_KEY = 'dsh-ima-kb-panel:kb'
    const RECENT_KEY = 'dsh-ima-kb-panel:recent'
    /** 「最近阅读」最多记几篇。 */
    const RECENT_MAX = 6

    /** 行级别的键盘可达性：Enter / 空格 等价于点击。 */
    function rowKey(action) {
      return (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          action()
        }
      }
    }

    /** 分类的展示顺序；不在表里的按拼音排到最后。 */
    const GROUP_ORDER = [
      '课程原文', '学员总结', '盘中记录', '公众号文章', '雪球文章',
      '宏观研究', '未分类', '全量文章索引', '整理版使用说明', 'ima笔记使用指南', '其他',
    ]

    const STRINGS = {
      zh: {
        title: 'ima 知识库',
        subtitle: '笔记 · 全文检索',
        tabNotes: (count) => (count ? `笔记 (${count})` : '笔记'),
        tabKb: (count) => (count ? `知识库 (${count})` : '知识库'),
        searchPlaceholder: '检索全部笔记（多个关键词用空格分隔）',
        kbSearchPlaceholder: '按文件名检索当前知识库',
        refresh: '刷新',
        notesHeading: '笔记',
        emptyNotes: '这个知识库还没有笔记。',
        pickNote: '从左侧选一篇笔记开始阅读，或直接在上方检索。',
        noResult: '没有找到匹配内容。换个原词试试。',
        resultsHeading: (count) => `命中 ${count} 处`,
        loadMore: '继续向下读取',
        backToStart: '回到开头',
        counting: '正在统计字数…',
        loading: '加载中…',
        searching: '检索中…',
        warming: (done, total) => `载入正文 ${done}/${total}`,
        warmingShort: (done, total) => `载入正文 ${done}/${total}`,
        searchWarnging: (done, total) => `检索需要先载入正文（${done}/${total}）…`,
        charUnit: '字',
        totalNotes: (count, chars) => (chars ? `${count} 篇 · ${chars} 字` : `${count} 篇`),
        kbSubtitle: (count) => `${count} 个知识库`,
        truncated: (max) => `已收录 ${max} 篇上限，可能还有更多笔记未纳入。`,
        retry: '重试',
        permission: '浏览器会话未获授权，无法访问本机知识库接口。',
        unauthorized: '浏览器会话已失效（HTTP 401）。刷新一下页面再试。',
        forbidden: '本机接口拒绝了这次请求（HTTP 403）。',
        missing: '未配置 ima 凭证：把 Client ID / API Key 写入 ~/.config/ima/ 后点刷新。',
        setupTitle: '还没连接 ima 账号',
        setupIntro: '把 Client ID 和 API Key 分别写进下面两个文件（各一行，不要引号），然后点「重新检查」。',
        setupDir: (dir) => `凭证目录：${dir}（不存在就新建）。`,
        setupEnv: (a, b) => `也可以改用环境变量 ${a} / ${b}（优先级更高）。`,
        setupWhere: '凭证在 ima 官方开放平台生成：ima.qq.com/agent-interface',
        recheck: '重新检查',
        filterHint: (f) => `仅标题含「${f}」`,
        skipped: (n) => `${n} 篇取正文失败，已跳过`,
        partial: (done, total) => `正文还在载入（${done}/${total}），结果可能不全；载完后会自动重新检索。`,
        findHeading: (n) => `模糊命中 ${n} 篇（换个说法也能找到）`,
        findFailed: '官方模糊检索没成功：',
        // 知识库页签
        kbIntro: '选择左侧文件夹，或直接检索文件名。',
        kbEmpty: '这个知识库里没有内容。',
        kbPickKb: '先选一个知识库。',
        kbFolders: (n) => `文件夹 ${n} 个`,
        kbFiles: (n) => `文件 ${n} 个`,
        kbRoot: '根目录',
        kbLoadMore: '加载更多',
        kbBack: '返回上一级',
        // 个人知识库本地缓存
        kbCacheTitle: '本地缓存',
        kbCacheNone: '还没缓存到本地。缓存后断网也能翻目录和看正文。',
        kbCacheStats: (files, texts, size) => `${files} 个文件${texts > 0 ? ` · ${texts} 篇正文` : ''} · ${size}`,
        kbCacheAt: (when) => `快照 ${when}`,
        kbCacheWarm: '缓存到本地',
        kbCacheUpdate: '更新快照',
        kbCacheClear: '清空',
        kbCacheWarming: (stage, done, total) => stage === 'text' ? `正在缓存正文 ${done}/${total}` : '正在缓存目录…',
        kbCacheDone: (files, texts, failed) => `已缓存 ${files} 个文件${texts > 0 ? `、${texts} 篇正文` : ''}${failed > 0 ? `，${failed} 篇失败` : ''}`,
        kbCacheShared: '订阅 / 加入的知识库不做本地缓存，按需在线读取。',
        kbDownload: '下载原文',
        kbDownloading: '正在准备下载…',
        kbNoDownload: '这个文件没有可下载的原文。',
        kbFileType: '类型',
        kbFileId: 'media_id',
        kbInFolder: '所在位置',
        kbSearchNoResult: '没有文件名含这个词的内容（此检索只匹配文件名，不搜正文）。',
        kbSearchHeading: (count) => `文件名命中 ${count} 条`,
        kbOverviewFiles: (count) => `${count} 个文件`,
        kbOverviewRole: (role) => role,
        kbCopyId: '复制',
        kbCopied: '已复制',
        kbTypes: { 99: '文件夹', 1: 'PDF', 3: 'Word' },
        fileReading: '正在读取正文…',
        fileReadFailed: '读取失败：',
        fileNotReadable: '这种格式面板里看不了，点「下载原文」用本地软件打开。',
        fileTruncated: (chars) => `正文较长，这里只显示开头部分（共 ${chars} 字）；完整内容请点「下载原文」。`,
        toc: '目录',
        tocEmpty: '这篇没有二级标题',
        openInKb: '知识库原文',
        openNoteOfFile: '打开对应笔记',
        kbLinkNoFile: '知识库里没找到同标题的文件',
        linkNoNote: '笔记里没有同标题的一篇',
        recentHeading: '最近阅读',
        recentCollapse: '折叠最近阅读',
        recentExpand: '展开最近阅读',
        allNotes: '全部笔记',
        recentClear: '清空',
        hitPrev: '上一处',
        hitNext: '下一处',
        hitNav: (index, total) => `第 ${index}/${total} 处`,
        shortcutFocus: 'Ctrl+K 聚焦搜索',
        shortcutTabs: 'Alt+1 笔记 / Alt+2 知识库',
      },
      en: {
        title: 'ima Knowledge Base',
        subtitle: 'Notes · full-text search',
        tabNotes: (count) => (count ? `Notes (${count})` : 'Notes'),
        tabKb: (count) => (count ? `Spaces (${count})` : 'Spaces'),
        searchPlaceholder: 'Search all notes (space-separate multiple terms)',
        kbSearchPlaceholder: 'Search file names in this space',
        refresh: 'Refresh',
        notesHeading: 'Notes',
        emptyNotes: 'This knowledge base has no notes yet.',
        pickNote: 'Pick a note on the left, or search above.',
        noResult: 'No match. Try a wording that appears in your material.',
        resultsHeading: (count) => `${count} matches`,
        loadMore: 'Load more',
        backToStart: 'Back to start',
        counting: 'Counting characters…',
        loading: 'Loading…',
        searching: 'Searching…',
        warming: (done, total) => `Loading text ${done}/${total}`,
        warmingShort: (done, total) => `Loading text ${done}/${total}`,
        searchWarnging: (done, total) => `Search needs the text loaded first (${done}/${total})…`,
        charUnit: 'chars',
        totalNotes: (count, chars) => (chars ? `${count} notes · ${chars} chars` : `${count} notes`),
        kbSubtitle: (count) => `${count} spaces`,
        truncated: (max) => `Capped at ${max} notes; more may exist.`,
        retry: 'Retry',
        permission: 'No permission to reach the local knowledge-base API.',
        unauthorized: 'Browser session expired (HTTP 401). Reload the page and retry.',
        forbidden: 'The local API rejected this request (HTTP 403).',
        missing: 'ima credentials missing: write Client ID / API Key into ~/.config/ima/ then refresh.',
        setupTitle: 'Not connected to ima yet',
        setupIntro: 'Put your Client ID and API Key into the two files below (one line each, no quotes), then press Recheck.',
        setupDir: (dir) => `Credential directory: ${dir} (create it if missing).`,
        setupEnv: (a, b) => `You can also use the ${a} / ${b} environment variables instead (they win).`,
        setupWhere: 'Create credentials at ima.qq.com/agent-interface',
        recheck: 'Recheck',
        filterHint: (f) => `title contains “${f}” only`,
        skipped: (n) => `${n} notes failed to load and were skipped`,
        partial: (done, total) => `Text still loading (${done}/${total}); results may be incomplete and will be refreshed automatically.`,
        findHeading: (n) => `${n} fuzzy matches (different wording can still hit)`,
        findFailed: 'Server fuzzy search failed: ',
        kbIntro: 'Pick a folder on the left, or search file names.',
        kbEmpty: 'This space has no content.',
        kbPickKb: 'Pick a space first.',
        kbFolders: (n) => `${n} folders`,
        kbFiles: (n) => `${n} files`,
        kbRoot: 'Root',
        kbLoadMore: 'Load more',
        kbBack: 'Up one level',
        kbCacheTitle: 'Local cache',
        kbCacheNone: 'Not cached yet. Cached spaces stay browsable offline.',
        kbCacheStats: (files, texts, size) => `${files} files${texts > 0 ? ` · ${texts} texts` : ''} · ${size}`,
        kbCacheAt: (when) => `snapshot ${when}`,
        kbCacheWarm: 'Cache locally',
        kbCacheUpdate: 'Refresh snapshot',
        kbCacheClear: 'Clear',
        kbCacheWarming: (stage, done, total) => stage === 'text' ? `Caching texts ${done}/${total}` : 'Caching folders…',
        kbCacheDone: (files, texts, failed) => `Cached ${files} files${texts > 0 ? `, ${texts} texts` : ''}${failed > 0 ? `, ${failed} failed` : ''}`,
        kbCacheShared: 'Subscribed / joined spaces are not cached locally; they stay online-only.',
        kbDownload: 'Download original',
        kbDownloading: 'Preparing download…',
        kbNoDownload: 'This file has no downloadable original.',
        kbFileType: 'Type',
        kbFileId: 'media_id',
        kbInFolder: 'Location',
        kbSearchNoResult: 'No file name matches (this search only matches names, not content).',
        kbSearchHeading: (count) => `${count} name matches`,
        kbOverviewFiles: (count) => `${count} files`,
        kbOverviewRole: (role) => role,
        kbCopyId: 'Copy',
        kbCopied: 'Copied',
        kbTypes: { 99: 'Folder', 1: 'PDF', 3: 'Word' },
        fileReading: 'Loading file…',
        fileReadFailed: 'Failed to read file: ',
        fileNotReadable: 'This format cannot be previewed here — use Download original.',
        fileTruncated: (chars) => `Showing the beginning of the file (${chars} chars total); download it for the rest.`,
        toc: 'Contents',
        tocEmpty: 'No section headings',
        openInKb: 'KB original',
        openNoteOfFile: 'Open note',
        kbLinkNoFile: 'No file with the same title in the knowledge base',
        linkNoNote: 'No note with the same title',
        recentHeading: 'Recent',
        recentCollapse: 'Collapse recent',
        recentExpand: 'Expand recent',
        allNotes: 'All notes',
        recentClear: 'Clear',
        hitPrev: 'Prev',
        hitNext: 'Next',
        hitNav: (index, total) => `Match ${index}/${total}`,
        shortcutFocus: 'Ctrl+K to focus search',
        shortcutTabs: 'Alt+1 notes / Alt+2 spaces',
      },
    }

    let localeService
    function activeLocale() {
      try {
        const snapshot = localeService && localeService.getSnapshot ? localeService.getSnapshot() : undefined
        const code = String((snapshot && snapshot.active) || 'zh').toLowerCase()
        return code.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }
    function text() {
      return STRINGS[activeLocale()]
    }

    function useLocaleTick() {
      const [, setTick] = React.useState(0)
      React.useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined
        return localeService.subscribe(() => setTick((value) => value + 1))
      }, [])
    }

    function readLocal(key, fallback) {
      try {
        if (typeof localStorage === 'undefined') return fallback
        const value = localStorage.getItem(key)
        return value === null ? fallback : value
      } catch {
        return fallback
      }
    }

    function writeLocal(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
      } catch {
        // 隐私模式：记不住就算了。
      }
    }

    function escapeRegExp(value) {
      return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    function splitTerms(query) {
      return String(query || '')
        .trim()
        .split(/\s+/)
        .filter((term) => term !== '')
        .slice(0, 6)
    }

    function highlight(textValue, terms) {
      if (!terms || terms.length === 0) return textValue
      const pattern = terms.map(escapeRegExp).join('|')
      if (pattern === '') return textValue
      let regex
      try {
        regex = new RegExp('(' + pattern + ')', 'gi')
      } catch {
        return textValue
      }
      return textValue.split(regex).map((chunk, index) =>
        index % 2 === 1 ? h('mark', { key: 'mark-' + index, className: 'ima-kb-mark' }, chunk) : chunk,
      )
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return null
      return Number(value).toLocaleString('en-US')
    }

    /** 缓存占用：1 位小数就够，别在面板里堆数字。 */
    function formatBytes(value) {
      const bytes = Number(value) || 0
      if (bytes <= 0) return '0 B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** 本地快照时间：月-日 时:分。 */
    function formatSnapshot(at) {
      const stamp = Number(at) || 0
      if (stamp <= 0) return ''
      try {
        return new Date(stamp).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /**
     * 阅读区正文渲染：把行首的 Markdown 标题（`# ` ~ `#### `）渲染成带样式的标题行，
     * 其余行原样保留（外层 pre-wrap 负责换行），同时保留搜索高亮。
     */
    function renderReaderBody(content, terms) {
      const lines = String(content || '').split('\n')
      return lines.map((line, index) => {
        const heading = /^(#{1,4}) +(.+)$/.exec(line)
        if (heading !== null) {
          const level = heading[1].length
          return h(
            'div',
            { key: 'rh-' + index, className: 'ima-kb-rh ima-kb-rh' + level },
            highlight(heading[2], terms),
          )
        }
        return h('span', { key: 'rl-' + index }, highlight(line, terms), '\n')
      })
    }

    /** 标题 → 分类。`2021Q2 · 雪球文章（95篇）` 归到「雪球文章 / 2021Q2」，
     *  `学员总结 · xxx` 归到「学员总结」，`未分类 · xxx` 归到「未分类」。 */
    function categorizeNote(title) {
      const raw = String(title || '')
      const parts = raw.split('·').map((s) => s.trim()).filter((s) => s !== '')
      if (parts.length === 0) return { group: '其他', subgroup: '' }
      if (parts.length === 1) return { group: parts[0], subgroup: '' }
      const head = parts[0]
      if (/^\d{4}/.test(head)) {
        const sub = String(parts[1] || '').replace(/（[^）]*）$/, '').trim()
        return { group: sub !== '' ? sub : String(parts[1] || ''), subgroup: head }
      }
      return { group: head, subgroup: '' }
    }

    function groupOrderIndex(name) {
      const index = GROUP_ORDER.indexOf(name)
      return index === -1 ? GROUP_ORDER.length : index
    }

    /** 把笔记列表折成「分类 → 分组」两层树。 */
    function buildGroups(notes) {
      if (!Array.isArray(notes)) return null
      const map = new Map()
      const groupOf = (name) => {
        if (!map.has(name)) map.set(name, { name, count: 0, chars: 0, subgroups: new Map() })
        return map.get(name)
      }
      for (const note of notes) {
        if (note === null || typeof note !== 'object') continue
        const { group, subgroup } = categorizeNote(note.title)
        const g = groupOf(group)
        g.count += 1
        if (typeof note.chars === 'number') g.chars += note.chars
        const key = subgroup === '' ? '__top__' : subgroup
        if (!g.subgroups.has(key)) g.subgroups.set(key, { name: subgroup, count: 0, chars: 0, notes: [] })
        const sg = g.subgroups.get(key)
        sg.count += 1
        if (typeof note.chars === 'number') sg.chars += note.chars
        sg.notes.push(note)
      }
      const list = Array.from(map.values())
      list.sort((left, right) =>
        groupOrderIndex(left.name) - groupOrderIndex(right.name) || left.name.localeCompare(right.name, 'zh'))
      for (const g of list) {
        for (const sg of g.subgroups.values()) {
          sg.notes.sort((left, right) => (right.modified || 0) - (left.modified || 0))
        }
        g.subgroupList = Array.from(g.subgroups.values()).sort((left, right) => {
          if (left.name === '' && right.name !== '') return -1
          if (right.name === '' && left.name !== '') return 1
          return String(right.name).localeCompare(String(left.name), 'zh')
        })
      }
      return list
    }

    /** 把接口失败拆成可读的原因：状态码 + 服务端消息，而不是一律「没有权限」。 */
    async function getJson(path) {
      let response
      try {
        response = await fetch(path, { headers: { accept: 'application/json' } })
      } catch (error) {
        const failure = new Error(String((error && error.message) || error))
        failure.kind = 'network'
        throw failure
      }
      let payload = null
      let rawText = ''
      try {
        rawText = await response.text()
        payload = rawText === '' ? null : JSON.parse(rawText)
      } catch {
        payload = null
      }
      if (response.status === 401 || response.status === 403) {
        const failure = new Error((payload && payload.error) || 'HTTP ' + response.status)
        failure.kind = response.status === 401 ? 'unauthorized' : 'forbidden'
        failure.status = response.status
        throw failure
      }
      if (!response.ok) {
        const failure = new Error(
          (payload && payload.error) || rawText.slice(0, 300) || 'HTTP ' + response.status,
        )
        failure.kind = 'server'
        failure.status = response.status
        throw failure
      }
      return payload
    }

    function describeError(error, t) {
      if (!error) return ''
      if (error.kind === 'unauthorized') return t.unauthorized
      if (error.kind === 'forbidden') return t.forbidden
      const status = error.status ? `HTTP ${error.status} · ` : ''
      return status + String(error.message || error)
    }

    // ── 侧边栏入口图标 ────────────────────────────────────────────────
    function SidebarIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      const active = Boolean(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('path', {
          d: 'M4.6 4.2h5.1c1 0 1.7.3 2.3.9.6-.6 1.3-.9 2.3-.9h5.1v13.6h-5.1c-1 0-1.7.3-2.3.9-.6-.6-1.3-.9-2.3-.9H4.6z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 5.1v13.6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.85 }),
        h('circle', { cx: 15.9, cy: 11.4, r: 2.9, stroke: 'currentColor', strokeWidth: 1.5 }),
        h('path', { d: 'M18 13.6l1.7 1.7', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    /** 渲染「分类 → 分组」折叠树（从 Panel 抽出来，避免一层套一层的括号地狱）。 */
    function noteGroupList({ groups, collapsed, onToggle, onOpen, selected, t }) {
      return groups.map((group) => {
        const isCollapsed = Boolean(collapsed[group.name])
        const head = h(
          'div',
          {
            className: 'ima-kb-cat-head',
            role: 'button',
            tabIndex: 0,
            onClick: () => onToggle(group.name),
            onKeyDown: rowKey(() => onToggle(group.name)),
          },
          h('span', { className: 'ima-kb-cat-chevron' }, isCollapsed ? '▸' : '▾'),
          h('span', { className: 'ima-kb-cat-name' }, group.name),
          h('span', { className: 'ima-kb-cat-count' }, formatNumber(group.count)),
          group.chars > 0
            ? h('span', { className: 'ima-kb-cat-chars' }, formatNumber(group.chars) + t.charUnit)
            : null,
        )
        const body = isCollapsed
          ? null
          : group.subgroupList.map((subgroup) =>
              h(
                'div',
                { className: 'ima-kb-sub', key: subgroup.name === '' ? 'top' : subgroup.name },
                subgroup.name !== ''
                  ? h(
                      'div',
                      { className: 'ima-kb-sub-head' },
                      subgroup.name + ' · ' + formatNumber(subgroup.count),
                    )
                  : null,
                subgroup.notes.map((note) =>
                  h(
                    'div',
                    {
                      key: note.id,
                      className: 'ima-kb-row',
                      role: 'button',
                      tabIndex: 0,
                      'data-active': selected === note.id ? 'true' : 'false',
                      onClick: () => onOpen(note.id),
                      onKeyDown: rowKey(() => onOpen(note.id)),
                    },
                    h('div', { className: 'ima-kb-row-title' }, note.title),
                    h(
                      'div',
                      { className: 'ima-kb-row-meta' },
                      typeof note.chars === 'number'
                        ? formatNumber(note.chars) + ' ' + t.charUnit
                        : '…',
                    ),
                  ),
                ),
              ),
            )
        return h('div', { className: 'ima-kb-cat', key: group.name }, head, body)
      })
    }

    /**
     * 面板被切走时 DSH 会「卸载再挂载」组件（不是隐藏），state 全丢 —— 这就是
     * "点出去再点回来，阅读位置/检索词全没了"的原因。客户端模块在整个页面生命周期里
     * 只加载一次，所以这里放一个模块级快照：切走时存，切回来时直接复原，零请求。
     */
    let panelSnapshot = null

    // ── 面板 ──────────────────────────────────────────────────────────
    function Panel() {
      useLocaleTick()
      const t = text()
      const snap = panelSnapshot

      // 页签与折叠状态（跨会话记住）。
      const [tab, setTab] = React.useState(() => {
        if (snap !== null && (snap.tab === 'kb' || snap.tab === 'notes')) return snap.tab
        const saved = readLocal(TAB_KEY, 'notes')
        return saved === 'kb' ? 'kb' : 'notes'
      })
      const [collapsed, setCollapsed] = React.useState(() => {
        try {
          return JSON.parse(readLocal(COLLAPSED_KEY, '{}')) || {}
        } catch {
          return {}
        }
      })

      // ── 笔记侧 ──
      const [notes, setNotes] = React.useState(snap === null ? null : snap.notes)
      const [truncated, setTruncated] = React.useState(false)
      const [maxNotes, setMaxNotes] = React.useState(null)
      const [notesError, setNotesError] = React.useState(null)
      const [loadingNotes, setLoadingNotes] = React.useState(false)
      const [warm, setWarm] = React.useState(snap === null ? null : snap.warm)
      const [warming, setWarming] = React.useState(false)
      const [selected, setSelected] = React.useState(snap === null ? null : snap.selected)
      const [conn, setConn] = React.useState(null)
      const [doc, setDoc] = React.useState(snap === null ? null : snap.doc)
      const [docError, setDocError] = React.useState(null)
      const [loadingDoc, setLoadingDoc] = React.useState(false)
      /** 最近阅读（跨会话）；进入面板时恢复上次那篇。 */
      const [recent, setRecent] = React.useState(() => {
        try {
          const parsed = JSON.parse(readLocal(RECENT_KEY, '[]'))
          return Array.isArray(parsed) ? parsed.filter((item) => item !== null && typeof item.id === 'string').slice(0, RECENT_MAX) : []
        } catch {
          return []
        }
      })
      const [recentOpen, setRecentOpen] = React.useState(true)
      const restoredRef = React.useRef(false)
      const searchInputRef = React.useRef(null)
      const kbSearchInputRef = React.useRef(null)
      /** 阅读器内「上一处/下一处」命中导航的当前位置。 */
      const [hitIndex, setHitIndex] = React.useState(0)
      /** 阅读器：本篇章节目录开关、跨笔记的滚动位置记忆、笔记→知识库文件跳转状态。 */
      const [tocOpen, setTocOpen] = React.useState(false)
      const scrollMemoRef = React.useRef(
        snap !== null && snap.doc !== null && snap.doc !== undefined && typeof snap.scrollTop === 'number'
          ? { [snap.doc.id]: snap.scrollTop }
          : {},
      )
      /** 当前阅读器滚动位置（卸载时不需要读 DOM，直接取这个）。 */
      const liveScrollRef = React.useRef(snap === null ? 0 : snap.scrollTop || 0)
      const [linkError, setLinkError] = React.useState(null)
      const [query, setQuery] = React.useState(snap === null || typeof snap.query !== 'string' ? '' : snap.query)
      const [results, setResults] = React.useState(snap === null ? null : snap.results)
      const [searching, setSearching] = React.useState(false)
      const [searchError, setSearchError] = React.useState(null)
      const [searchPartial, setSearchPartial] = React.useState(false)
      const rerunRef = React.useRef(false)
      /** 字面检索没命中时，自动用官方分词检索补一轮（kb_find）。 */
      const [findResults, setFindResults] = React.useState(snap === null ? null : snap.findResults)
      const [findError, setFindError] = React.useState(null)
      const findQRef = React.useRef('')

      // ── 知识库侧 ──
      const [kbs, setKbs] = React.useState(snap === null ? null : snap.kbs)
      const [kbError, setKbError] = React.useState(null)
      const [selectedKb, setSelectedKb] = React.useState(() => (snap !== null && typeof snap.selectedKb === 'string' && snap.selectedKb !== '' ? snap.selectedKb : readLocal(KB_KEY, '')))
      const [dirItems, setDirItems] = React.useState(snap === null ? null : snap.dirItems)
      const [dirPath, setDirPath] = React.useState(snap === null || !Array.isArray(snap.dirPath) ? [] : snap.dirPath)
      const [dirNext, setDirNext] = React.useState(snap === null || typeof snap.dirNext !== 'string' ? '' : snap.dirNext)
      const [dirIsEnd, setDirIsEnd] = React.useState(snap === null ? true : snap.dirIsEnd !== false)
      const [dirLoading, setDirLoading] = React.useState(false)
      const [dirLoadingMore, setDirLoadingMore] = React.useState(false)
      const [dirError, setDirError] = React.useState(null)
      const [kbCache, setKbCache] = React.useState(null)
      const [kbCacheBusy, setKbCacheBusy] = React.useState(false)
      const [kbCacheMsg, setKbCacheMsg] = React.useState(null)
      const [kbQ, setKbQ] = React.useState(snap === null || typeof snap.kbQ !== 'string' ? '' : snap.kbQ)
      const [kbResults, setKbResults] = React.useState(snap === null ? null : snap.kbResults)
      const [kbSearching, setKbSearching] = React.useState(false)
      const [kbSearchError, setKbSearchError] = React.useState(null)
      const [fileSel, setFileSel] = React.useState(snap === null ? null : snap.fileSel)
      const [fileInfo, setFileInfo] = React.useState(snap === null ? null : snap.fileInfo)
      const [fileText, setFileText] = React.useState(null)
      const [fileTextLoading, setFileTextLoading] = React.useState(false)
      const [fileFolderLabel, setFileFolderLabel] = React.useState(snap === null || typeof snap.fileFolderLabel !== 'string' ? '' : snap.fileFolderLabel)
      const [copied, setCopied] = React.useState(false)

      const readerRef = React.useRef(null)
      const selectedRef = React.useRef(null)
      const docRef = React.useRef(null)
      /** 打开笔记的请求序号：连点两篇时，只认最后一次的响应，避免旧响应覆盖新正文。 */
      const openSeqRef = React.useRef(0)
      selectedRef.current = selected
      docRef.current = doc

      const switchTab = React.useCallback((next) => {
        setTab(next)
        writeLocal(TAB_KEY, next)
      }, [])

      const toggleGroup = React.useCallback((name) => {
        setCollapsed((current) => {
          const next = { ...current, [name]: !current[name] }
          try {
            writeLocal(COLLAPSED_KEY, JSON.stringify(next))
          } catch {
            // 记不住不影响折叠。
          }
          return next
        })
      }, [])

      // ── 笔记：预热 ──
      const startWarm = React.useCallback(async () => {
        setWarming(true)
        try {
          const payload = await getJson(API + '/warm')
          if (payload && Array.isArray(payload.notes)) setNotes(payload.notes)
          if (payload && payload.warm) setWarm(payload.warm)
        } catch {
          // 预热失败不影响列表：正文会在点开某一篇时按需取。
        } finally {
          setWarming(false)
        }
      }, [])

      const loadNotes = React.useCallback(async () => {
        setNotesError(null)
        setLoadingNotes(true)
        try {
          const payload = await getJson(API + '/notes')
          const rows = Array.isArray(payload && payload.notes) ? payload.notes : []
          setNotes(rows)
          setTruncated(Boolean(payload && payload.truncated))
          setMaxNotes(payload && typeof payload.maxNotes === 'number' ? payload.maxNotes : null)
          setWarm(payload && payload.warm ? payload.warm : null)
          const needWarm = rows.some((note) => note === null || typeof note.chars !== 'number')
          if (needWarm) startWarm()
        } catch (error) {
          setNotes([])
          setNotesError(error)
        } finally {
          setLoadingNotes(false)
        }
      }, [startWarm])

      const bootstrap = React.useCallback(async () => {
        setNotesError(null)
        let state = null
        try {
          state = await getJson(API + '/state')
        } catch (error) {
          state = null
          setConn(null)
          setNotesError(error)
          setNotes([])
          return
        }
        setConn(state)
        if (state !== null && state.configured === false) {
          setNotes([])
          return
        }
        loadNotes()
      }, [loadNotes])

      React.useEffect(() => {
        bootstrap()
      }, [bootstrap])

      React.useEffect(() => {
        if (!warming && !searching) return undefined
        let alive = true
        const poll = async () => {
          try {
            const snapshot = await getJson(API + '/warm-status')
            if (alive && snapshot) setWarm(snapshot)
          } catch {
            // 进度只是装饰，取不到就下次再试。
          }
        }
        poll()
        const timer = setInterval(poll, 1500)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [warming, searching])

      const openNote = React.useCallback(async (noteId, start, anchor) => {
        const from = Math.max(0, start)
        const seq = openSeqRef.current + 1
        openSeqRef.current = seq
        setSelected(noteId)
        setDocError(null)
        setTocOpen(false)
        setLoadingDoc(true)
        try {
          const payload = await getJson(
            API + '/note?id=' + encodeURIComponent(noteId) + '&start=' + from + '&length=' + WINDOW_CHARS,
          )
          if (openSeqRef.current !== seq) return
          setDoc({
            id: payload.id,
            title: payload.title,
            chars: payload.chars,
            content: payload.content,
            start: from,
            end: payload.end,
            anchor: typeof anchor === 'number' ? anchor : null,
          })
          setRecent((current) => {
            const entry = { id: payload.id, title: payload.title, at: Date.now() }
            const next = [entry, ...current.filter((item) => item.id !== payload.id)].slice(0, RECENT_MAX)
            try {
              writeLocal(RECENT_KEY, JSON.stringify(next))
            } catch {
              // 记不住「最近阅读」不影响阅读。
            }
            return next
          })
        } catch (error) {
          if (openSeqRef.current !== seq) return
          setDoc(null)
          setDocError(describeError(error, t))
        } finally {
          if (openSeqRef.current === seq) setLoadingDoc(false)
        }
      }, [])

      const loadMore = React.useCallback(async () => {
        const current = docRef.current
        if (!current || loadingDoc || current.end >= current.chars) return
        setLoadingDoc(true)
        try {
          const payload = await getJson(
            API + '/note?id=' + encodeURIComponent(current.id) + '&start=' + current.end + '&length=' + WINDOW_CHARS,
          )
          setDoc({
            id: current.id,
            title: current.title,
            chars: current.chars,
            content: current.content + payload.content,
            start: current.start,
            end: payload.end,
            anchor: current.anchor,
          })
        } catch (error) {
          setDocError(describeError(error, t))
        } finally {
          setLoadingDoc(false)
        }
      }, [loadingDoc])

      const backToStart = React.useCallback(() => {
        const current = docRef.current
        if (!current) return
        openNote(current.id, 0, null)
      }, [openNote])

      /** 官方分词检索（kb_find）：字面没命中时自动补一轮。 */
      const runFind = React.useCallback(async (value) => {
        const q = String(value || '').trim()
        if (q === '') return
        findQRef.current = q
        setFindError(null)
        try {
          const payload = await getJson(API + '/find?q=' + encodeURIComponent(q))
          if (findQRef.current !== q) return
          if (payload && payload.error) {
            setFindResults(null)
            setFindError(payload.error)
          } else {
            setFindResults(payload)
          }
        } catch (error) {
          if (findQRef.current !== q) return
          setFindResults(null)
          setFindError(describeError(error, t))
        }
      }, [])

      const runSearch = React.useCallback(async (value) => {
        const terms = splitTerms(value)
        if (terms.length === 0) {
          setResults(null)
          setSearchError(null)
          return
        }
        setSearching(true)
        setSearchError(null)
        try {
          const payload = await getJson(API + '/search?q=' + encodeURIComponent(terms.join(' ')) + '&limit=' + SNIPPET_LIMIT)
          setResults(payload)
          setSearchPartial(Boolean(payload && payload.warming))
          if (payload && payload.warm) setWarm(payload.warm)
          const matches = payload && Array.isArray(payload.matches) ? payload.matches : []
          if (matches.length === 0 && !(payload && payload.warming)) {
            // 字面没命中且正文已就绪：换官方分词检索再找一次。
            runFind(value)
          } else {
            setFindResults(null)
            setFindError(null)
          }
        } catch (error) {
          setResults(null)
          setSearchPartial(false)
          setSearchError(describeError(error, t))
        } finally {
          setSearching(false)
        }
      }, [runFind])

      React.useEffect(() => {
        if (String(query || '').trim() === '') {
          setResults(null)
          setSearchError(null)
          setFindResults(null)
          setFindError(null)
          findQRef.current = ''
          return undefined
        }
        const timer = setTimeout(() => {
          runSearch(query)
        }, 320)
        return () => clearTimeout(timer)
      }, [query, runSearch])

      React.useEffect(() => {
        if (!searchPartial) {
          rerunRef.current = false
          return
        }
        const busy = Boolean(warm && warm.running)
        if (busy || searching || warming || rerunRef.current) return
        if (String(query || '').trim() === '') return
        rerunRef.current = true
        runSearch(query)
      }, [searchPartial, warm, searching, warming, query, runSearch])

      const onReaderScroll = React.useCallback(
        (event) => {
          const node = event.currentTarget
          const current = docRef.current
          liveScrollRef.current = node.scrollTop
          if (current !== null) scrollMemoRef.current[current.id] = node.scrollTop
          if (node.scrollHeight - node.scrollTop - node.clientHeight < 320) loadMore()
        },
        [loadMore],
      )

      /**
       * 打开 / 续读一篇笔记后恢复滚动位置：
       *  - 搜索点进来的（带 anchor）：按「命中字符在窗口里的比例」估算位置，直接落到位；
       *  - 之前读过这篇：回到上次的位置；
       *  - 其余从头开始。
       * 依赖只用 id/start/anchor，避免「加载更多」追加内容时把滚动位置重置。
       */
      React.useEffect(() => {
        if (doc === null) return undefined
        const node = readerRef.current
        if (node === null) return undefined
        const frame = requestAnimationFrame(() => {
          const saved = scrollMemoRef.current[doc.id]
          if (typeof saved === 'number') {
            node.scrollTop = saved
            return
          }
          if (typeof doc.anchor === 'number' && doc.content.length > 0) {
            const offsetInWindow = Math.max(0, doc.anchor - (doc.start || 0))
            const ratio = Math.min(1, offsetInWindow / doc.content.length)
            node.scrollTop = Math.max(0, ratio * (node.scrollHeight - node.clientHeight) - 140)
            return
          }
          node.scrollTop = 0
        })
        return () => cancelAnimationFrame(frame)
      }, [doc === null ? null : doc.id, doc === null ? null : doc.start, doc === null ? null : doc.anchor])

      /** 本篇章节目录：正文里的二级标题。 */
      const tocItems = React.useMemo(() => {
        if (doc === null) return []
        const items = []
        const pattern = /^## +(.+)$/gm
        let match = pattern.exec(doc.content)
        while (match !== null && items.length < 300) {
          items.push({ title: match[1].trim(), index: match.index })
          match = pattern.exec(doc.content)
        }
        return items
      }, [doc])

      const jumpToTocItem = React.useCallback((item) => {
        const node = readerRef.current
        const current = docRef.current
        if (node === null || current === null) return
        const ratio = Math.min(1, item.index / Math.max(1, current.content.length))
        node.scrollTop = Math.max(0, ratio * (node.scrollHeight - node.clientHeight))
        setTocOpen(false)
      }, [])

      // ── 快捷键：Ctrl/Cmd+K 聚焦搜索，Alt+1 / Alt+2 切页签 ──
      React.useEffect(() => {
        const onKeyDown = (event) => {
          const mod = event.ctrlKey || event.metaKey
          if (mod && !event.shiftKey && !event.altKey && String(event.key || '').toLowerCase() === 'k') {
            const target = tab === 'kb' ? kbSearchInputRef.current : searchInputRef.current
            if (target !== null) {
              event.preventDefault()
              target.focus()
              target.select()
            }
            return
          }
          if (event.altKey && !mod && (event.key === '1' || event.key === '2')) {
            event.preventDefault()
            switchTab(event.key === '1' ? 'notes' : 'kb')
          }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [tab, switchTab])

      /** 进面板时恢复上次读的那篇（跨会话），只恢复一次。 */
      React.useEffect(() => {
        if (restoredRef.current) return
        if (doc !== null) {
          restoredRef.current = true
          return
        }
        if (!Array.isArray(notes) || notes.length === 0) return
        restoredRef.current = true
        const last = recent[0]
        if (!last || !notes.some((note) => note && note.id === last.id)) return
        openNote(last.id, 0, null)
      }, [doc, notes, recent, openNote])

      const onRefresh = React.useCallback(async () => {
        setResults(null)
        setSearchError(null)
        try {
          await getJson(API + '/refresh')
        } catch {
          // 清缓存失败就照常重取。
        }
        await loadNotes()
        if (selectedRef.current) openNote(selectedRef.current, 0, null)
        loadKbsRef.current()
      }, [loadNotes, openNote])

      // ── 知识库：列表 / 目录 / 检索 ──
      const loadKbs = React.useCallback(async () => {
        setKbError(null)
        try {
          const payload = await getJson(API + '/kb')
          const items = Array.isArray(payload && payload.items) ? payload.items : []
          setKbs(items)
          setSelectedKb((current) => {
            const keep = current !== '' && items.some((item) => item.id === current) ? current : ''
            const next = keep !== '' ? keep : items.length > 0 ? items[0].id : ''
            writeLocal(KB_KEY, next)
            return next
          })
        } catch (error) {
          setKbs([])
          setKbError(error)
        }
      }, [])

      const loadKbsRef = React.useRef(loadKbs)
      loadKbsRef.current = loadKbs

      const loadDir = React.useCallback(async (kbId, folderId, cursor, append) => {
        const busy = append ? setDirLoadingMore : setDirLoading
        busy(true)
        setDirError(null)
        try {
          const params = '/kb-files?kb=' + encodeURIComponent(kbId)
            + '&folder=' + encodeURIComponent(folderId || '')
            + '&cursor=' + encodeURIComponent(cursor || '')
          const payload = await getJson(API + params)
          const items = Array.isArray(payload.items) ? payload.items : []
          if (append) {
            setDirItems((current) => (current || []).concat(items))
          } else {
            setDirItems(items)
            setFileSel(null)
            setFileInfo(null)
          }
          setDirPath(Array.isArray(payload.path) ? payload.path : [])
          setDirIsEnd(Boolean(payload.isEnd))
          setDirNext(payload.nextCursor || '')
        } catch (error) {
          if (!append) setDirItems([])
          setDirError(error)
        } finally {
          busy(false)
        }
      }, [])

      const dirFolderId = React.useMemo(() => {
        return dirPath.length > 0 ? dirPath[dirPath.length - 1].id : ''
      }, [dirPath])

      const loadMoreDir = React.useCallback(() => {
        if (selectedKb === '' || dirIsEnd || dirLoadingMore) return
        loadDir(selectedKb, dirFolderId, dirNext, true)
      }, [selectedKb, dirIsEnd, dirLoadingMore, dirNext, dirFolderId, loadDir])

      const enterFolder = React.useCallback((item) => {
        setKbQ('') // 从检索结果进文件夹后，回到目录树视图。
        loadDir(selectedKb, item.mediaId, '', false)
      }, [selectedKb, loadDir])

      const crumbTo = React.useCallback((node) => {
        loadDir(selectedKb, node.id, '', false)
      }, [selectedKb, loadDir])

      const goUp = React.useCallback(() => {
        const path = dirPath
        if (path.length <= 1) return
        const parent = path[path.length - 2]
        loadDir(selectedKb, parent.id, '', false)
      }, [selectedKb, dirPath, loadDir])

      const selectKb = React.useCallback((kbId) => {
        setSelectedKb(kbId)
        writeLocal(KB_KEY, kbId)
        setKbResults(null)
        setKbQ('')
        setFileSel(null)
        setFileInfo(null)
        setKbCacheMsg(null)
        loadDir(kbId, '', '', false)
      }, [loadDir])

      // ── 个人知识库的本地缓存 ──
      const loadKbCache = React.useCallback(async () => {
        try {
          setKbCache(await getJson(API + '/kb-cache'))
        } catch {
          setKbCache(null)
        }
      }, [])

      const runKbCache = React.useCallback(async () => {
        if (selectedKb === '') return
        setKbCacheBusy(true)
        setKbCacheMsg(null)
        const timer = setInterval(() => { loadKbCache() }, 2000)
        try {
          const result = await getJson(API + '/kb-warm?kb=' + encodeURIComponent(selectedKb))
          if (result && typeof result.error === 'string') setKbCacheMsg(result.error)
          else if (result && typeof result.files === 'number') {
            setKbCacheMsg(t.kbCacheDone(result.files, result.texts || 0, result.failed || 0))
          }
        } catch (error) {
          setKbCacheMsg(describeError(error, t))
        } finally {
          clearInterval(timer)
          setKbCacheBusy(false)
          loadKbCache()
        }
      }, [selectedKb, loadKbCache, t])

      const dropKbCache = React.useCallback(async () => {
        try {
          await getJson(API + '/kb-cache?clear=1')
        } catch {
          // 清不掉就下次再说。
        }
        setKbCacheMsg(null)
        await loadKbCache()
        if (selectedKb !== '') loadDir(selectedKb, dirFolderId, '', false)
      }, [loadKbCache, loadDir, selectedKb, dirFolderId])

      const selectFile = React.useCallback(async (item, folderLabel) => {
        setFileSel(item)
        setFileInfo(null)
        setFileText(null)
        setFileTextLoading(true)
        setFileFolderLabel(folderLabel || '')
        setCopied(false)
        try {
          const payload = await getJson(
            API + '/kb-file?media_id=' + encodeURIComponent(item.mediaId) + '&title=' + encodeURIComponent(item.title || ''),
          )
          setFileInfo({
            type: payload.type,
            typeLabel: payload.typeLabel,
            kind: payload.kind,
            readable: Boolean(payload.readable),
            downloadable: Boolean(payload.downloadable),
          })
        } catch {
          setFileInfo({ type: item.type, typeLabel: item.typeLabel, downloadable: false })
        }
        // 正文另取：md/docx 由 Host 解成文本，PDF 给它内嵌查看地址。
        try {
          const textPayload = await getJson(
            API + '/kb-text?media_id=' + encodeURIComponent(item.mediaId) + '&title=' + encodeURIComponent(item.title || ''),
          )
          setFileText(textPayload)
        } catch (error) {
          setFileText({ kind: 'error', text: '', chars: 0, truncated: false, inlineUrl: '', error: String((error && error.message) || error) })
        } finally {
          setFileTextLoading(false)
        }
      }, [])

      /**
       * 从模块快照恢复「上次看的知识库文件」时只有文件信息、没有正文，
       * 这里补取一次正文（正常点文件时 selectFile 已经取过，不会走到这里）。
       */
      React.useEffect(() => {
        if (fileSel === null || fileText !== null || fileTextLoading) return undefined
        let alive = true
        setFileTextLoading(true)
        getJson(
          API + '/kb-text?media_id=' + encodeURIComponent(fileSel.mediaId) + '&title=' + encodeURIComponent(fileSel.title || ''),
        )
          .then((payload) => {
            if (alive) setFileText(payload)
          })
          .catch((error) => {
            if (alive) {
              setFileText({
                kind: 'error', text: '', chars: 0, truncated: false, inlineUrl: '',
                error: String((error && error.message) || error),
              })
            }
          })
          .finally(() => {
            if (alive) setFileTextLoading(false)
          })
        return () => {
          alive = false
        }
      }, [fileSel, fileText, fileTextLoading])

      /** 笔记 → 知识库原文：同标题在「我的知识库」里找对应文件并切过去。 */
      const openKbForDoc = React.useCallback(async () => {
        const current = docRef.current
        if (current === null) return
        setLinkError(null)
        try {
          const payload = await getJson(API + '/kb-link?title=' + encodeURIComponent(current.title))
          if (!payload || payload.found !== true || !payload.item) {
            setLinkError(t.kbLinkNoFile)
            setTimeout(() => setLinkError(null), 4000)
            return
          }
          setTab('kb')
          writeLocal(TAB_KEY, 'kb')
          setSelectedKb(payload.kbId)
          writeLocal(KB_KEY, payload.kbId)
          setKbResults(null)
          setKbQ('')
          setFileFolderLabel('')
          loadDir(payload.kbId, payload.item.parentFolderId || '', '', false)
          selectFile(payload.item, '')
        } catch (error) {
          setLinkError(describeError(error, t))
          setTimeout(() => setLinkError(null), 4000)
        }
      }, [loadDir, selectFile])

      /** 知识库文件 → 对应笔记：标题归一化后在笔记列表里找。 */
      const openNoteForFile = React.useCallback(() => {
        if (fileSel === null) return
        const clean = (value) => String(value || '')
          .replace(/\.(md|markdown|docx|pdf|txt)$/i, '')
          .replace(/\s+/g, '')
          .trim()
        const target = clean(fileSel.title)
        const found = (notes || []).find((note) => clean(note.title) === target)
        if (found === undefined) {
          setLinkError(t.linkNoNote)
          setTimeout(() => setLinkError(null), 4000)
          return
        }
        setTab('notes')
        writeLocal(TAB_KEY, 'notes')
        openNote(found.id, 0, null)
      }, [fileSel, notes, openNote])

      React.useEffect(() => {
        if (tab !== 'kb' || kbs !== null) return
        if (conn !== null && conn.configured === false) return
        loadKbs()
      }, [tab, conn, kbs, loadKbs])

      /**
       * 首次进入知识库页（或恢复了上次选中的库）时，自动加载它的根目录。
       * v1.5.0 之前这里漏了：只有「手动切换下拉框 / 点文件夹」才会发请求，
       * 于是面板一进来就永远停在「加载中…」——就是用户截图里那个状态。
       */
      React.useEffect(() => {
        if (tab !== 'kb') return
        if (kbs === null || selectedKb === '') return
        if (dirItems !== null || dirLoading || dirError !== null) return
        loadDir(selectedKb, '', '', false)
      }, [tab, kbs, selectedKb, dirItems, dirLoading, dirError, loadDir])

      /** 缓存状态：只在知识库页签需要，切库时重新读一次。 */
      React.useEffect(() => {
        if (tab !== 'kb' || selectedKb === '') return
        loadKbCache()
      }, [tab, selectedKb, loadKbCache])

      const runKbSearch = React.useCallback(async (value) => {
        const q = String(value || '').trim()
        if (q === '' || selectedKb === '') {
          setKbResults(null)
          setKbSearchError(null)
          return
        }
        setKbSearching(true)
        setKbSearchError(null)
        try {
          const payload = await getJson(API + '/kb-search?kb=' + encodeURIComponent(selectedKb) + '&q=' + encodeURIComponent(q))
          setKbResults(Array.isArray(payload && payload.items) ? payload.items : [])
        } catch (error) {
          setKbResults(null)
          setKbSearchError(describeError(error, t))
        } finally {
          setKbSearching(false)
        }
      }, [selectedKb])

      React.useEffect(() => {
        if (String(kbQ || '').trim() === '') {
          setKbResults(null)
          setKbSearchError(null)
          return undefined
        }
        const timer = setTimeout(() => {
          runKbSearch(kbQ)
        }, 320)
        return () => clearTimeout(timer)
      }, [kbQ, runKbSearch])

      const copyMediaId = React.useCallback((value) => {
        try {
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }
        } catch {
          // 剪贴板不可用就算了。
        }
      }, [])

      // 每次渲染记录一份最新状态；面板被卸载时写进模块级快照，切回来直接复原。
      const snapshotRef = React.useRef({})
      snapshotRef.current = {
        tab, notes, warm, selected, doc, query, results, findResults,
        kbs, selectedKb, dirItems, dirPath, dirNext, dirIsEnd,
        fileSel, fileInfo, fileFolderLabel, kbQ, kbResults,
      }
      React.useEffect(() => () => {
        panelSnapshot = { ...snapshotRef.current, scrollTop: liveScrollRef.current }
      }, [])

      const currentKb = Array.isArray(kbs) ? kbs.find((item) => item.id === selectedKb) : undefined
      const personalKb = currentKb !== undefined
        && (currentKb.baseType === '个人知识库' || String(currentKb.role || '').includes('创建者'))
      const cacheEntry = kbCache !== null && Array.isArray(kbCache.kbs)
        ? kbCache.kbs.find((item) => item.id === selectedKb)
        : undefined
      const cacheStrip = tab === 'kb' && selectedKb !== ''
        ? (personalKb
            ? h(
                'div',
                { className: 'ima-kb-kbcache' },
                h(
                  'div',
                  { className: 'ima-kb-kbcache-row' },
                  h('span', { className: 'ima-kb-kbcache-label' }, t.kbCacheTitle),
                  h(
                    'span',
                    { className: 'ima-kb-kbcache-text' },
                    kbCacheBusy
                      ? t.kbCacheWarming(
                          kbCache !== null && kbCache.warm !== null && typeof kbCache.warm === 'object' ? kbCache.warm.stage : 'list',
                          kbCache !== null && kbCache.warm !== null && typeof kbCache.warm === 'object' ? kbCache.warm.done : 0,
                          kbCache !== null && kbCache.warm !== null && typeof kbCache.warm === 'object' ? kbCache.warm.total : 0,
                        )
                      : cacheEntry !== undefined && cacheEntry.snapshotAt > 0
                        ? t.kbCacheAt(formatSnapshot(cacheEntry.snapshotAt))
                          + ' · '
                          + t.kbCacheStats(cacheEntry.files, cacheEntry.texts, formatBytes(kbCache === null ? 0 : kbCache.bytes))
                        : t.kbCacheNone,
                  ),
                  h(
                    'button',
                    {
                      className: 'ima-kb-button ima-kb-kbcache-btn',
                      type: 'button',
                      disabled: kbCacheBusy,
                      onClick: runKbCache,
                    },
                    cacheEntry !== undefined && cacheEntry.snapshotAt > 0 ? t.kbCacheUpdate : t.kbCacheWarm,
                  ),
                  h(
                    'button',
                    {
                      className: 'ima-kb-button ima-kb-kbcache-btn',
                      type: 'button',
                      disabled: kbCacheBusy || cacheEntry === undefined || cacheEntry.dirs === 0,
                      onClick: dropKbCache,
                    },
                    t.kbCacheClear,
                  ),
                ),
                kbCacheMsg !== null ? h('div', { className: 'ima-kb-hint' }, kbCacheMsg) : null,
              )
            : h(
                'div',
                { className: 'ima-kb-kbcache ima-kb-kbcache-shared' },
                h('span', { className: 'ima-kb-kbcache-text' }, t.kbCacheShared),
              ))
        : null

      const groups = React.useMemo(() => buildGroups(notes), [notes])
      const totalChars = React.useMemo(() => {
        if (!Array.isArray(notes)) return null
        let sum = 0
        let known = 0
        for (const note of notes) {
          if (note !== null && typeof note.chars === 'number') {
            sum += note.chars
            known += 1
          }
        }
        return known === 0 ? null : sum
      }, [notes])

      const terms = splitTerms(query)
      const searchingMode = terms.length > 0
      const rows = searchingMode && results && Array.isArray(results.matches) ? results.matches : null

      /** 阅读器里当前搜索词的命中位置（用于「上一处 / 下一处」）。 */
      const docHits = React.useMemo(() => {
        if (doc === null || terms.length === 0) return []
        const lower = doc.content.toLowerCase()
        const found = []
        for (const term of terms) {
          const needle = term.toLowerCase()
          if (needle === '') continue
          let at = lower.indexOf(needle)
          while (at !== -1 && found.length < 500) {
            found.push(at)
            at = lower.indexOf(needle, at + needle.length)
          }
        }
        found.sort((left, right) => left - right)
        return found
      }, [doc, query])

      React.useEffect(() => {
        setHitIndex(0)
      }, [doc === null ? null : doc.id, query])

      const jumpToHit = React.useCallback((delta) => {
        const node = readerRef.current
        const current = docRef.current
        if (node === null || current === null || docHits.length === 0) return
        const next = ((hitIndex + delta) % docHits.length + docHits.length) % docHits.length
        setHitIndex(next)
        const ratio = Math.min(1, docHits[next] / Math.max(1, current.content.length))
        node.scrollTop = Math.max(0, ratio * (node.scrollHeight - node.clientHeight) - 140)
        scrollMemoRef.current[current.id] = node.scrollTop
      }, [docHits, hitIndex])

      const kbSearchingMode = String(kbQ || '').trim() !== ''
      const kbOverview = selectedKb !== ''
        ? (kbs || []).find((item) => item.id === selectedKb) || null
        : null

      const filterText =
        conn !== null && Array.isArray(conn.titleFilter) && conn.titleFilter.length > 0
          ? t.filterHint(conn.titleFilter.join('、'))
          : ''

      const warmRunning = Boolean(warm && warm.running)
      const warmDone = warm && typeof warm.done === 'number' ? warm.done : 0
      const warmTotal = warm && typeof warm.total === 'number' ? warm.total : 0
      const warmPercent = warmTotal > 0 ? Math.min(100, Math.round((warmDone / warmTotal) * 100)) : 0
      const warmCached = warm && typeof warm.cached === 'number' ? warm.cached : 0
      const warmListed = warm && typeof warm.listed === 'number' ? warm.listed : 0
      const cacheNote = warmRunning
        ? ''
        : (warmListed > 0 && warmCached < warmListed ? ' · 已缓存 ' + warmCached + '/' + warmListed : '')

      const subtitle = tab === 'kb'
        ? (kbs !== null ? t.kbSubtitle(kbs.length) : t.loading)
        : (Array.isArray(notes) && notes.length > 0
            ? t.totalNotes(notes.length, formatNumber(totalChars)) + (filterText !== '' ? ' · ' + filterText : '') + cacheNote
            : t.subtitle)

      // ── 首次运行：凭证引导 ──
      if (conn !== null && conn.configured === false) {
        const files = [
          conn.clientIdFile ? { label: 'Client ID', path: conn.clientIdFile } : null,
          conn.apiKeyFile ? { label: 'API Key', path: conn.apiKeyFile } : null,
        ].filter(Boolean)
        return h(
          'div',
          { className: 'ima-kb-root' },
          h('style', null, IM_STYLE),
          h(
            'div',
            { className: 'ima-kb-setup' },
            h('div', { className: 'ima-kb-setup-title' }, t.setupTitle),
            h('div', { className: 'ima-kb-setup-intro' }, t.setupIntro),
            h(
              'div',
              { className: 'ima-kb-setup-list' },
              files.map((file, index) =>
                h(
                  'div',
                  { className: 'ima-kb-setup-row', key: 'setup-' + index },
                  h('span', { className: 'ima-kb-setup-tag' }, file.label),
                  h('code', { className: 'ima-kb-setup-path' }, file.path),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ima-kb-setup-note' },
              conn.credentialsDir ? t.setupDir(conn.credentialsDir) : '',
            ),
            h(
              'div',
              { className: 'ima-kb-setup-note' },
              t.setupEnv(conn.clientIdEnv || 'IMA_CLIENT_ID', conn.apiKeyEnv || 'IMA_API_KEY'),
            ),
            h('div', { className: 'ima-kb-setup-note' }, t.setupWhere),
            h(
              'button',
              { className: 'ima-kb-button ima-kb-setup-action', type: 'button', onClick: bootstrap },
              t.recheck,
            ),
          ),
        )
      }

      // ── 左侧：笔记列表（分类树 / 检索结果） ──
      const noteSide = h(
        'div',
        { className: 'ima-kb-side' },
        h(
          'div',
          { className: 'ima-kb-search' },
          h('input', {
            className: 'ima-kb-input',
            type: 'search',
            value: query,
            ref: searchInputRef,
            title: t.shortcutFocus,
            placeholder: t.searchPlaceholder,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                setQuery('')
                setResults(null)
                setFindResults(null)
              }
            },
          }),
        ),
        notesError !== null
          ? h(
              'div',
              null,
              h('div', { className: 'ima-kb-hint' }, describeError(notesError, t)),
              h('button', { className: 'ima-kb-button ima-kb-retry', type: 'button', onClick: bootstrap }, t.retry),
            )
          : searchingMode
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'ima-kb-group' },
                  searching
                    ? warmRunning
                      ? t.searchWarnging(warmDone, warmTotal)
                      : t.searching
                    : t.resultsHeading(results && results.matches ? results.matches.length : 0),
                ),
                searchError !== null ? h('div', { className: 'ima-kb-hint' }, searchError) : null,
                searchPartial && !searching
                  ? h('div', { className: 'ima-kb-hint' }, t.partial(warmDone, warmTotal))
                  : null,
                rows === null
                  ? null
                  : rows.length === 0
                    ? h(
                        React.Fragment,
                        null,
                        h('div', { className: 'ima-kb-hint' }, t.noResult),
                        findError !== null
                          ? h('div', { className: 'ima-kb-hint' }, t.findFailed + findError)
                          : null,
                        findResults !== null && Array.isArray(findResults.items) && findResults.items.length > 0
                          ? h(
                              'div',
                              { className: 'ima-kb-find' },
                              h('div', { className: 'ima-kb-group' }, t.findHeading(findResults.total)),
                              findResults.items.map((item, index) =>
                                h(
                                  'div',
                                  {
                                    key: 'find-' + index,
                                    className: 'ima-kb-row',
                                    role: 'button',
                                    tabIndex: 0,
                                    onClick: () => openNote(item.noteId, 0, null),
                                  },
                                  h('div', { className: 'ima-kb-row-title' }, item.title),
                                  h('div', { className: 'ima-kb-row-meta' }, 'note_id ' + item.noteId),
                                  item.preview !== ''
                                    ? h('div', { className: 'ima-kb-snippet' }, item.preview)
                                    : null,
                                ),
                              ),
                            )
                          : null,
                      )
                    : rows.map((match, index) =>
                        h(
                          'div',
                          {
                            key: 'hit-' + index,
                            className: 'ima-kb-row',
                            role: 'button',
                            tabIndex: 0,
                            onClick: () => openNote(match.noteId, Math.max(0, match.offset - JUMP_LEAD), match.anchor),
                            onKeyDown: rowKey(() => openNote(match.noteId, Math.max(0, match.offset - JUMP_LEAD), match.anchor)),
                          },
                          h('div', { className: 'ima-kb-row-title' }, match.title),
                          h('div', { className: 'ima-kb-row-meta' }, 'offset ' + formatNumber(match.offset)),
                          h('div', { className: 'ima-kb-snippet' }, highlight(match.snippet, terms)),
                        ),
                      ),
              )
                            : h(
                                'div',
                                null,
                                truncated && maxNotes !== null
                                  ? h('div', { className: 'ima-kb-hint' }, t.truncated(maxNotes))
                                  : null,
                                recent.length > 0
                                  ? h(
                                      'div',
                                      { className: 'ima-kb-recent' },
                                      h(
                                        'div',
                                        { className: 'ima-kb-recent-head' },
                                        h('span', { className: 'ima-kb-recent-title' }, t.recentHeading),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'ima-kb-iconbtn',
                                            title: recentOpen ? t.recentCollapse : t.recentExpand,
                                            onClick: () => setRecentOpen((value) => !value),
                                          },
                                          recentOpen ? '▾' : '▸',
                                        ),
                                        h(
                                          'button',
                                          {
                                            type: 'button',
                                            className: 'ima-kb-linkbtn',
                                            onClick: () => {
                                              setRecent([])
                                              try {
                                                writeLocal(RECENT_KEY, '[]')
                                              } catch {
                                                // 忽略
                                              }
                                            },
                                          },
                                          t.recentClear,
                                        ),
                                      ),
                                      recentOpen
                                        ? recent.map((item) =>
                                            h(
                                              'div',
                                              {
                                                key: 'recent-' + item.id,
                                                className: 'ima-kb-recent-row',
                                                role: 'button',
                                                tabIndex: 0,
                                                'data-active': selected === item.id ? 'true' : 'false',
                                                onClick: () => openNote(item.id, 0, null),
                                                onKeyDown: rowKey(() => openNote(item.id, 0, null)),
                                              },
                                              h('div', { className: 'ima-kb-recent-name' }, item.title || item.id),
                                            ),
                                          )
                                        : null,
                                    )
                                  : null,
                                h(
                                  'div',
                                  { className: 'ima-kb-section-head' },
                                  h('span', null, t.allNotes),
                                  notes !== null ? h('span', null, formatNumber(notes.length)) : null,
                                ),
                                groups === null
                                  ? h('div', { className: 'ima-kb-group' }, t.loading)
                                  : groups.length === 0
                                    ? h('div', { className: 'ima-kb-hint' }, t.emptyNotes)
                                    : noteGroupList({ groups, collapsed, onToggle: toggleGroup, onOpen: (id) => openNote(id, 0, null), selected, t }),
                              ),
      )

      // ── 左侧：知识库（选择器 + 面包屑 + 文件树 / 检索结果） ──
      const kbSide = h(
        'div',
        { className: 'ima-kb-side' },
        kbError !== null
          ? h(
              'div',
              null,
              h('div', { className: 'ima-kb-hint' }, describeError(kbError, t)),
              h('button', { className: 'ima-kb-button ima-kb-retry', type: 'button', onClick: loadKbs }, t.retry),
            )
          : kbs === null
            ? h('div', { className: 'ima-kb-group' }, t.loading)
            : kbs.length === 0
              ? h('div', { className: 'ima-kb-hint' }, t.kbEmpty)
              : h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'ima-kb-search' },
                    h('select', {
                      className: 'ima-kb-input ima-kb-select',
                      value: selectedKb,
                      onChange: (event) => selectKb(event.target.value),
                    },
                    kbs.map((item) =>
                      h(
                        'option',
                        { key: item.id, value: item.id },
                        `${item.name}（${formatNumber(item.count)}）`,
                      ),
                    )),
                  ),
                  h(
                    'div',
                    { className: 'ima-kb-search' },
                    h('input', {
                      className: 'ima-kb-input',
                      type: 'search',
                      value: kbQ,
                      ref: kbSearchInputRef,
                      title: t.shortcutFocus,
                      placeholder: t.kbSearchPlaceholder,
                      onChange: (event) => setKbQ(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Escape') {
                          setKbQ('')
                          setKbResults(null)
                        }
                      },
                    }),
                  ),
                  kbSearchingMode
                    ? h(
                        'div',
                        null,
                        h(
                          'div',
                          { className: 'ima-kb-group' },
                          kbSearching ? t.searching : t.kbSearchHeading((kbResults || []).length),
                        ),
                        kbSearchError !== null
                          ? h('div', { className: 'ima-kb-hint' }, kbSearchError)
                          : null,
                        kbResults === null
                          ? null
                          : kbResults.length === 0
                            ? h('div', { className: 'ima-kb-hint' }, t.kbSearchNoResult)
                            : kbResults.map((item, index) =>
                                h(
                                  'div',
                                  {
                                    key: 'kbs-' + index,
                                    className: 'ima-kb-row',
                                    role: 'button',
                                    tabIndex: 0,
                                    'data-active': fileSel && fileSel.mediaId === item.mediaId ? 'true' : 'false',
                                    onClick: () => {
                                      if (item.folder) enterFolder(item)
                                      else selectFile(item, '')
                                    },
                                    onKeyDown: rowKey(() => {
                                      if (item.folder) enterFolder(item)
                                      else selectFile(item, '')
                                    }),
                                  },
                                  h('div', { className: 'ima-kb-row-title' }, item.title),
                                  h(
                                    'div',
                                    { className: 'ima-kb-row-meta' },
                                    h('span', { className: 'ima-kb-badge' }, item.typeLabel),
                                    item.snippet !== '' ? ' · ' + item.snippet.slice(0, 40) : '',
                                  ),
                                ),
                              ),
                      )
                    : h(
                        'div',
                        null,
                        dirError !== null
                          ? h(
                              'div',
                              null,
                              h('div', { className: 'ima-kb-hint' }, describeError(dirError, t)),
                              h(
                                'button',
                                {
                                  className: 'ima-kb-button ima-kb-retry',
                                  type: 'button',
                                  onClick: () => loadDir(selectedKb, dirFolderId, '', false),
                                },
                                t.retry,
                              ),
                            )
                          : null,
                        cacheStrip,
                        dirItems === null
                          ? h(
                              'div',
                              { className: 'ima-kb-group' },
                              dirLoading || selectedKb !== '' ? t.loading : t.kbPickKb,
                            )
                          : h(
                              'div',
                              null,
                              dirPath.length > 1
                                ? h(
                                    'div',
                                    { className: 'ima-kb-crumb' },
                                    h(
                                      'button',
                                      { className: 'ima-kb-crumb-link', type: 'button', onClick: goUp },
                                      '← ' + t.kbBack,
                                    ),
                                    dirPath.slice(1).map((node, index) =>
                                      h(
                                        'span',
                                        { key: node.id, className: 'ima-kb-crumb-item' },
                                        index > 0 ? ' / ' : '',
                                        h(
                                          'button',
                                          {
                                            className: 'ima-kb-crumb-link',
                                            type: 'button',
                                            onClick: () => crumbTo(node),
                                            disabled: index === dirPath.length - 2,
                                          },
                                          node.name,
                                        ),
                                      ),
                                    ),
                                  )
                                : null,
                              h(
                                'div',
                                { className: 'ima-kb-group' },
                                t.kbFolders(dirItems.filter((item) => item.folder).length)
                                  + ' · '
                                  + t.kbFiles(dirItems.filter((item) => !item.folder).length),
                              ),
                              dirItems.length === 0
                                ? h('div', { className: 'ima-kb-hint' }, t.kbEmpty)
                                : dirItems.map((item) =>
                                    h(
                                      'div',
                                      {
                                        key: item.mediaId,
                                        className: 'ima-kb-row' + (item.folder ? ' ima-kb-row-folder' : ''),
                                        role: 'button',
                                        tabIndex: 0,
                                        'data-active': fileSel && fileSel.mediaId === item.mediaId ? 'true' : 'false',
                                        onClick: () => {
                                          if (item.folder) enterFolder(item)
                                          else selectFile(item, dirPath.length > 0 ? dirPath[dirPath.length - 1].name : '')
                                        },
                                      },
                                      h(
                                        'div',
                                        { className: 'ima-kb-row-title' },
                                        item.folder ? '▸ ' + item.title : item.title,
                                      ),
                                      h(
                                        'div',
                                        { className: 'ima-kb-row-meta' },
                                        h('span', { className: 'ima-kb-badge' }, item.typeLabel),
                                      ),
                                    ),
                                  ),
                              !dirIsEnd
                                ? h(
                                    'button',
                                    {
                                      className: 'ima-kb-button ima-kb-loadmore',
                                      type: 'button',
                                      onClick: loadMoreDir,
                                      disabled: dirLoadingMore,
                                    },
                                    dirLoadingMore ? t.loading : t.kbLoadMore,
                                  )
                                : null,
                            ),
                      ),
                ),
      )

      // ── 右侧：知识库文件详情 / 概览 ──
      const kbReader = fileTextLoading
        ? h('div', { className: 'ima-kb-reader-loading' }, t.fileReading)
        : fileText === null
          ? null
          : fileText.error
            ? h('div', { className: 'ima-kb-hint ima-kb-reader-pad' }, t.fileReadFailed + fileText.error)
            : fileText.kind === 'pdf' && fileText.inlineUrl !== ''
              ? h('iframe', {
                  className: 'ima-kb-fileframe',
                  src: fileText.inlineUrl,
                  title: fileSel === null ? 'pdf' : fileSel.title,
                })
              : fileText.kind === 'markdown' || fileText.kind === 'docx' || fileText.kind === 'text'
                ? h(
                    'div',
                    { className: 'ima-kb-fileread' },
                    h('div', { className: 'ima-kb-fileread-inner' }, renderReaderBody(fileText.text, [])),
                    fileText.truncated
                      ? h('div', { className: 'ima-kb-hint' }, t.fileTruncated(formatNumber(fileText.chars)))
                      : null,
                  )
                : h('div', { className: 'ima-kb-hint ima-kb-reader-pad' }, t.fileNotReadable)

      const kbMain = fileSel !== null
        ? h(
            'div',
            { className: 'ima-kb-filedetail' },
            h(
              'div',
              { className: 'ima-kb-filehead' },
              h('div', { className: 'ima-kb-filetitle' }, fileSel.title),
              h(
                'div',
                { className: 'ima-kb-fileheadrow' },
                h('span', { className: 'ima-kb-badge' }, (fileInfo && fileInfo.typeLabel) || fileSel.typeLabel),
                fileFolderLabel !== ''
                  ? h('span', null, t.kbInFolder + '：' + fileFolderLabel)
                  : null,
                fileText !== null && fileText.chars > 0
                  ? h('span', null, formatNumber(fileText.chars) + ' ' + t.charUnit)
                  : null,
                fileInfo !== null && fileInfo.downloadable
                  ? h(
                      'a',
                      {
                        className: 'ima-kb-button ima-kb-download',
                        href: API + '/kb-raw?media_id=' + encodeURIComponent(fileSel.mediaId)
                          + '&title=' + encodeURIComponent(fileSel.title),
                        download: '',
                      },
                      t.kbDownload,
                    )
                  : fileInfo === null
                    ? h('span', null, t.kbDownloading)
                    : h('span', null, t.kbNoDownload),
                h(
                  'button',
                  {
                    className: 'ima-kb-button ima-kb-copy',
                    type: 'button',
                    onClick: () => copyMediaId(fileSel.mediaId),
                  },
                  copied ? t.kbCopied : t.kbCopyId,
                ),
                h('button', { className: 'ima-kb-button', type: 'button', onClick: openNoteForFile }, t.openNoteOfFile),
              ),
              linkError !== null ? h('div', { className: 'ima-kb-hint' }, linkError) : null,
            ),
            h('div', { className: 'ima-kb-filereadwrap' }, kbReader),
          )
        : h(
            'div',
            { className: 'ima-kb-empty' },
            kbOverview !== null
              ? h(
                  'div',
                  { className: 'ima-kb-overview' },
                  h('div', { className: 'ima-kb-overview-name' }, kbOverview.name),
                  h(
                    'div',
                    { className: 'ima-kb-overview-meta' },
                    t.kbOverviewFiles(formatNumber(kbOverview.count))
                      + (kbOverview.role !== '' ? ' · ' + t.kbOverviewRole(kbOverview.role) : ''),
                  ),
                  kbOverview.description !== ''
                    ? h('div', { className: 'ima-kb-overview-desc' }, kbOverview.description)
                    : null,
                  h('div', { className: 'ima-kb-hint' }, t.kbIntro),
                )
              : h('div', null, t.kbPickKb),
          )

      return h(
        'div',
        { className: 'ima-kb-root' },
        h('style', null, IM_STYLE),
        h(
          'div',
          { className: 'ima-kb-header' },
          h(
            'div',
            { className: 'ima-kb-headmain' },
            h('div', { className: 'ima-kb-title' }, t.title),
            h('div', { className: 'ima-kb-sub' }, subtitle),
          ),
          h(
            'div',
            { className: 'ima-kb-tabs', role: 'tablist' },
            h(
              'button',
              {
                type: 'button',
                className: 'ima-kb-tab',
                'data-active': tab === 'notes' ? 'true' : 'false',
                onClick: () => switchTab('notes'),
              },
              t.tabNotes(Array.isArray(notes) ? notes.length : null),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ima-kb-tab',
                'data-active': tab === 'kb' ? 'true' : 'false',
                onClick: () => switchTab('kb'),
              },
              t.tabKb(kbs !== null ? kbs.length : null),
            ),
          ),
          h(
            'button',
            {
              className: 'ima-kb-button',
              type: 'button',
              title: t.refresh,
              onClick: onRefresh,
              disabled: loadingNotes,
            },
            t.refresh,
          ),
        ),
        tab === 'notes' && warmRunning
          ? h(
              'div',
              { className: 'ima-kb-progress' },
              h('div', { className: 'ima-kb-progress-bar', style: { width: warmPercent + '%' } }),
            )
          : null,
        h(
          'div',
          { className: 'ima-kb-body' },
          tab === 'kb' ? kbSide : noteSide,
          h(
            'div',
            { className: 'ima-kb-main' },
            tab === 'kb'
              ? kbMain
              : doc === null
                ? h(
                    'div',
                    { className: 'ima-kb-empty' },
                    h('div', null, t.pickNote),
                    docError !== null ? h('div', { className: 'ima-kb-hint' }, docError) : null,
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      'div',
                      { className: 'ima-kb-toolbar' },
                      h('div', { className: 'ima-kb-doctitle' }, doc.title),
                      h(
                        'div',
                        { className: 'ima-kb-docmeta' },
                        formatNumber(doc.chars) + ' ' + t.charUnit + ' · 0–' + formatNumber(doc.end),
                      ),
                      tocItems.length > 0
                        ? h(
                            'button',
                            {
                              className: 'ima-kb-button',
                              type: 'button',
                              'data-active': tocOpen ? 'true' : 'false',
                              onClick: () => setTocOpen((value) => !value),
                            },
                            t.toc,
                          )
                        : null,
                      h('button', { className: 'ima-kb-button', type: 'button', onClick: openKbForDoc }, t.openInKb),
                      docHits.length > 0
                        ? h(
                            'span',
                            { className: 'ima-kb-hitnav' },
                            h(
                              'button',
                              {
                                className: 'ima-kb-button ima-kb-hitbtn',
                                type: 'button',
                                title: t.hitPrev,
                                onClick: () => jumpToHit(-1),
                              },
                              '↑',
                            ),
                            h('span', { className: 'ima-kb-hitlabel' }, t.hitNav(hitIndex + 1, docHits.length)),
                            h(
                              'button',
                              {
                                className: 'ima-kb-button ima-kb-hitbtn',
                                type: 'button',
                                title: t.hitNext,
                                onClick: () => jumpToHit(1),
                              },
                              '↓',
                            ),
                          )
                        : null,
                      doc.end < doc.chars
                        ? h(
                            'button',
                            { className: 'ima-kb-button', type: 'button', onClick: loadMore, disabled: loadingDoc },
                            t.loadMore,
                          )
                        : null,
                      doc.end > WINDOW_CHARS
                        ? h('button', { className: 'ima-kb-button', type: 'button', onClick: backToStart }, t.backToStart)
                        : null,
                    ),
                    linkError !== null ? h('div', { className: 'ima-kb-hint' }, linkError) : null,
                    tocOpen && tocItems.length > 0
                      ? h(
                          'div',
                          { className: 'ima-kb-toc' },
                          tocItems.map((item, index) =>
                            h(
                              'button',
                              {
                                key: 'toc-' + index,
                                type: 'button',
                                className: 'ima-kb-toc-item',
                                onClick: () => jumpToTocItem(item),
                              },
                              item.title,
                            ),
                          ),
                        )
                      : tocOpen
                        ? h('div', { className: 'ima-kb-hint' }, t.tocEmpty)
                        : null,
                    h(
                      'div',
                      { className: 'ima-kb-reader', onScroll: onReaderScroll, ref: readerRef },
                      h('div', { className: 'ima-kb-reader-inner' }, renderReaderBody(doc.content, terms)),
                      loadingDoc ? h('div', { className: 'ima-kb-hint' }, t.counting) : null,
                    ),
                  ),
          ),
        ),
      )
    }

    const IM_STYLE = [
      '.ima-kb-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.ima-kb-header{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.ima-kb-headmain{flex:0 0 auto;min-width:110px}',
      '.ima-kb-title{font-size:14px;font-weight:600;line-height:1.3}',
      '.ima-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ima-kb-tabs{display:flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);flex:0 0 auto}',
      '.ima-kb-tab{height:26px;padding:0 12px;font-size:12px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.ima-kb-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}',
      '.ima-kb-tab:hover{color:var(--dsw-alias-label-primary)}',
      '.ima-kb-kbcache{margin:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.ima-kb-kbcache-shared{color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.ima-kb-kbcache-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ima-kb-kbcache-label{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-kbcache-text{flex:1 1 auto;min-width:120px;font-size:11px;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-kbcache-btn{height:24px;padding:0 8px;font-size:11px}',
      '.ima-kb-search{flex:1 1 auto;min-width:0;padding:8px;box-sizing:border-box}',
      '.ima-kb-input{width:100%;height:30px;padding:0 10px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.ima-kb-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ima-kb-select{cursor:pointer;appearance:auto}',
      '.ima-kb-button{flex:0 0 auto;height:30px;padding:0 12px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;box-sizing:border-box}',
      '.ima-kb-button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-button:disabled{opacity:.55;cursor:default}',
      '.ima-kb-retry{margin:2px 10px 8px}',
      '.ima-kb-loadmore{margin:6px 10px 10px;width:calc(100% - 20px);justify-content:center}',
      '.ima-kb-progress{height:2px;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.ima-kb-progress-bar{height:100%;background:var(--dsw-alias-brand-primary);transition:width .25s ease}',
      '.ima-kb-body{flex:1 1 auto;display:flex;min-height:0}',
      '.ima-kb-side{width:322px;flex:0 0 322px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding-bottom:12px;box-sizing:border-box}',
      '.ima-kb-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}',
      '.ima-kb-group{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 10px 8px;letter-spacing:.02em}',
      '.ima-kb-cat{margin:0 4px}',
      '.ima-kb-cat-head{display:flex;align-items:center;gap:6px;padding:7px 10px;border-radius:8px;cursor:pointer;user-select:none}',
      '.ima-kb-cat-head:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-cat-chevron{flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:10px}',
      '.ima-kb-cat-name{flex:1 1 auto;min-width:0;font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ima-kb-cat-count{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);padding:1px 7px;border-radius:999px}',
      '.ima-kb-cat-chars{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-sub{padding-left:14px}',
      '.ima-kb-sub-head{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 10px 2px;letter-spacing:.02em}',
      '.ima-kb-row{padding:8px 10px;border-radius:8px;cursor:pointer;outline:none}',
      '.ima-kb-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.ima-kb-row-folder{font-weight:500}',
      '.ima-kb-row-title{font-size:12.5px;font-weight:500;line-height:1.4;word-break:break-word}',
      '.ima-kb-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ima-kb-badge{display:inline-block;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);margin-right:6px}',
      '.ima-kb-snippet{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.55;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.ima-kb-find{border-top:1px dashed var(--dsw-alias-border-l1);margin:4px 6px;padding-top:2px}',
      '.ima-kb-crumb{display:flex;align-items:center;flex-wrap:wrap;gap:2px;padding:6px 10px 2px;font-size:11.5px}',
      '.ima-kb-crumb-item{color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:2px;white-space:nowrap}',
      '.ima-kb-crumb-link{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:none;border:none;padding:2px 3px;border-radius:5px;cursor:pointer}',
      '.ima-kb-crumb-link:hover{color:var(--dsw-alias-brand-primary)}',
      '.ima-kb-crumb-link:disabled{color:var(--dsw-alias-label-primary);font-weight:600;cursor:default}',
      '.ima-kb-toolbar{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.ima-kb-doctitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}',
      '.ima-kb-docmeta{font-size:11px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.ima-kb-reader{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.78}',
      '.ima-kb-reader-inner{max-width:860px;margin:0 auto}',
      '.ima-kb-fileread-inner{max-width:900px;margin:0 auto}',
      '.ima-kb-rh{margin:16px 0 8px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-rh1{font-size:16.5px}',
      '.ima-kb-rh2{font-size:15px}',
      '.ima-kb-rh3{font-size:14px}',
      '.ima-kb-rh4{font-size:13.5px}',
      '.ima-kb-toc{flex:0 0 auto;max-height:38%;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:6px 10px}',
      '.ima-kb-toc-item{display:block;width:100%;text-align:left;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:none;border:none;border-radius:6px;padding:5px 8px;cursor:pointer}',
      '.ima-kb-toc-item:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ima-kb-button[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.ima-kb-hitnav{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto}',
      '.ima-kb-hitbtn{height:26px;padding:0 8px;font-size:12px;line-height:1}',
      '.ima-kb-hitlabel{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:64px;text-align:center}',
      '.ima-kb-recent{margin:8px 8px 10px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}',
      '.ima-kb-recent-head{display:flex;align-items:center;gap:6px;padding:0 2px 6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-recent-title{flex:1 1 auto;min-width:0;font-weight:600;letter-spacing:.04em}',
      '.ima-kb-recent-row{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;outline:none}',
      '.ima-kb-recent-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-recent-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-recent-row:before{content:"·";flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1}',
      '.ima-kb-recent-name{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ima-kb-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:2px 10px 2px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}',
      '.ima-kb-iconbtn{font:inherit;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary);background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px}',
      '.ima-kb-iconbtn:hover{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-linkbtn{font:inherit;font-size:10.5px;color:var(--dsw-alias-label-secondary);background:none;border:none;cursor:pointer;padding:0 2px;border-radius:4px}',
      '.ima-kb-linkbtn:hover{color:var(--dsw-alias-brand-primary)}',
      '.ima-kb-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:24px;text-align:center}',
      '.ima-kb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 10px;line-height:1.6;word-break:break-word}',
      '.ima-kb-mark{background:transparent;color:var(--dsw-alias-brand-primary);font-weight:600;border-bottom:2px solid var(--dsw-alias-brand-primary)}',
      '.ima-kb-detail{flex:1 1 auto;min-height:0;overflow:auto;padding:28px 32px;display:flex;flex-direction:column;gap:12px;max-width:860px}',
      '.ima-kb-detail-title{font-size:17px;font-weight:600;line-height:1.45;word-break:break-word}',
      '.ima-kb-detail-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-detail-row{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ima-kb-detail-id{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.ima-kb-copy{height:24px;padding:0 8px;font-size:11px}',
      '.ima-kb-download{height:26px;padding:0 10px;font-size:12px}',
      '.ima-kb-filedetail{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}',
      '.ima-kb-filehead{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding:16px 22px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.ima-kb-filetitle{font-size:16px;font-weight:600;line-height:1.4;word-break:break-word}',
      '.ima-kb-fileheadrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-filereadwrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}',
      '.ima-kb-fileread{flex:1 1 auto;min-height:0;overflow:auto;padding:20px 24px;white-space:pre-wrap;word-break:break-word;font-size:13.5px;line-height:1.85;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-fileframe{flex:1 1 auto;width:100%;min-height:0;border:0;background:var(--dsw-alias-bg-layer-1)}',
      '.ima-kb-reader-loading{flex:1 1 auto;display:flex;align-items:flex-start;justify-content:center;padding-top:28px;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.ima-kb-reader-pad{margin-top:10px}',
      '.ima-kb-overview{max-width:680px;display:flex;flex-direction:column;gap:8px;text-align:left;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:20px 22px}',
      '.ima-kb-overview-name{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-overview-meta{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-overview-desc{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-setup{flex:1 1 auto;min-height:0;overflow:auto;padding:32px 28px;display:flex;flex-direction:column;gap:10px;max-width:780px}',
      '.ima-kb-setup-title{font-size:16px;font-weight:600}',
      '.ima-kb-setup-intro{font-size:13px;line-height:1.75;color:var(--dsw-alias-label-primary)}',
      '.ima-kb-setup-list{display:flex;flex-direction:column;gap:8px;margin:6px 0}',
      '.ima-kb-setup-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ima-kb-setup-tag{flex:0 0 auto;font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-setup-path{font-size:12px;padding:4px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.ima-kb-setup-note{font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary)}',
      '.ima-kb-setup-action{align-self:flex-start;margin-top:8px}',
    ].join('\n')

    return {
      inject: ['slots'],
      apply(ctx) {
        let candidate
        try {
          candidate = ctx.get('locale')
        } catch {
          candidate = undefined
        }
        if (candidate && typeof candidate === 'object') localeService = candidate

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'ima-kb',
              order: 3,
              label: () => STRINGS[activeLocale()].title,
            },
            SidebarIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'ima-kb',
            },
            Panel,
          ),
        )
      },
    }
  },
})
