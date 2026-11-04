/**
 * ima 知识库面板 — Client 半个插件。
 *
 * 在左侧栏 Global panel icons 里增加一个入口（id = ima-kb），
 * 并在主区分栏注册同名分栏：左侧笔记列表 + 右侧正文阅读器 + 顶部全文检索。
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

    const STRINGS = {
      zh: {
        title: 'ima 知识库',
        subtitle: '全文检索 · 分页阅读',
        searchPlaceholder: '检索全部笔记（多个关键词用空格分隔）',
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
        charUnit: '字',
        totalNotes: (count, chars) => (chars ? `${count} 篇 · ${chars} 字` : `${count} 篇`),
        retry: '重试',
        permission: '没有权限访问本机知识库接口。',
        missing: '未配置 ima 凭证：把 Client ID / API Key 写入 ~/.config/ima/ 后点刷新。',
        setupTitle: '还没连接 ima 账号',
        setupIntro: '把 Client ID 和 API Key 分别写进下面两个文件（各一行，不要引号），然后点「重新检查」。',
        setupDir: (dir) => `凭证目录：${dir}（不存在就新建）。`,
        setupEnv: (a, b) => `也可以改用环境变量 ${a} / ${b}（优先级更高）。`,
        setupWhere: '凭证在 ima 官方开放平台生成：ima.qq.com/agent-interface',
        recheck: '重新检查',
        filterHint: (f) => `仅标题含「${f}」`,
      },
      en: {
        title: 'ima Knowledge Base',
        subtitle: 'Full-text search · paged reading',
        searchPlaceholder: 'Search all notes (space-separate multiple terms)',
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
        charUnit: 'chars',
        totalNotes: (count, chars) => (chars ? `${count} notes · ${chars} chars` : `${count} notes`),
        retry: 'Retry',
        permission: 'No permission to reach the local knowledge-base API.',
        missing: 'ima credentials missing: write Client ID / API Key into ~/.config/ima/ then refresh.',
        setupTitle: 'Not connected to ima yet',
        setupIntro: 'Put your Client ID and API Key into the two files below (one line each, no quotes), then press Recheck.',
        setupDir: (dir) => `Credential directory: ${dir} (create it if missing).`,
        setupEnv: (a, b) => `You can also use the ${a} / ${b} environment variables instead (they win).`,
        setupWhere: 'Create credentials at ima.qq.com/agent-interface',
        recheck: 'Recheck',
        filterHint: (f) => `title contains “${f}” only`,
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

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (response.status === 401 || response.status === 403) {
        const error = new Error('forbidden')
        error.kind = 'forbidden'
        throw error
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error('HTTP ' + response.status)
      }
      if (!response.ok) {
        throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      }
      return payload
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
        h('path', {
          d: 'M12 5.1v13.6',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          opacity: 0.85,
        }),
        h('circle', {
          cx: 15.9,
          cy: 11.4,
          r: 2.9,
          stroke: 'currentColor',
          strokeWidth: 1.5,
        }),
        h('path', {
          d: 'M18 13.6l1.7 1.7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    // ── 面板 ──────────────────────────────────────────────────────────
    function Panel() {
      useLocaleTick()
      const t = text()

      const [notes, setNotes] = React.useState(null)
      const [notesError, setNotesError] = React.useState(null)
      const [counting, setCounting] = React.useState(false)
      const [selected, setSelected] = React.useState(null)
      /** 主机侧连接状态：没配凭证时先渲染引导，而不是报一个 500。 */
      const [conn, setConn] = React.useState(null)

      const [doc, setDoc] = React.useState(null)
      const [docError, setDocError] = React.useState(null)
      const [loadingDoc, setLoadingDoc] = React.useState(false)

      const [query, setQuery] = React.useState('')
      const [results, setResults] = React.useState(null)
      const [searching, setSearching] = React.useState(false)
      const [searchError, setSearchError] = React.useState(null)

      const readerRef = React.useRef(null)
      const selectedRef = React.useRef(null)
      const docRef = React.useRef(null)
      selectedRef.current = selected
      docRef.current = doc

      const loadNotes = React.useCallback(async () => {
        setNotesError(null)
        try {
          const payload = await getJson(API + '/notes')
          setNotes(payload.notes || [])
          setCounting(true)
          getJson(API + '/warm')
            .then((warm) => {
              if (warm && Array.isArray(warm.notes)) setNotes(warm.notes)
            })
            .catch(() => {})
            .finally(() => setCounting(false))
        } catch (error) {
          setNotes([])
          setNotesError(error && error.kind === 'forbidden' ? t.permission : String((error && error.message) || error))
          setCounting(false)
        }
      }, [])

      const bootstrap = React.useCallback(async () => {
        setNotesError(null)
        let state = null
        try {
          state = await getJson(API + '/state')
        } catch {
          state = null
        }
        setConn(state)
        if (state !== null && state.configured === false) {
          setNotes([])
          setCounting(false)
          return
        }
        loadNotes()
      }, [loadNotes])

      React.useEffect(() => {
        bootstrap()
      }, [bootstrap])

      const openNote = React.useCallback(async (noteId, start, anchor) => {
        setSelected(noteId)
        setDocError(null)
        setLoadingDoc(true)
        try {
          const payload = await getJson(
            API + '/note?id=' + encodeURIComponent(noteId) + '&start=' + Math.max(0, start) + '&length=' + WINDOW_CHARS,
          )
          setDoc({
            id: payload.id,
            title: payload.title,
            chars: payload.chars,
            content: payload.content,
            end: payload.end,
            anchor: typeof anchor === 'number' ? anchor : null,
          })
          if (readerRef.current) readerRef.current.scrollTop = 0
        } catch (error) {
          setDoc(null)
          setDocError(String((error && error.message) || error))
        } finally {
          setLoadingDoc(false)
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
            end: payload.end,
            anchor: current.anchor,
          })
        } catch (error) {
          setDocError(String((error && error.message) || error))
        } finally {
          setLoadingDoc(false)
        }
      }, [loadingDoc])

      const backToStart = React.useCallback(() => {
        const current = docRef.current
        if (!current) return
        openNote(current.id, 0, null)
      }, [openNote])

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
          setResults(await getJson(API + '/search?q=' + encodeURIComponent(terms.join(' ')) + '&limit=' + SNIPPET_LIMIT))
        } catch (error) {
          setResults(null)
          setSearchError(String((error && error.message) || error))
        } finally {
          setSearching(false)
        }
      }, [])

      React.useEffect(() => {
        if (String(query || '').trim() === '') {
          setResults(null)
          setSearchError(null)
          return undefined
        }
        const timer = setTimeout(() => {
          runSearch(query)
        }, 320)
        return () => clearTimeout(timer)
      }, [query, runSearch])

      const onReaderScroll = React.useCallback(
        (event) => {
          const node = event.currentTarget
          if (node.scrollHeight - node.scrollTop - node.clientHeight < 320) loadMore()
        },
        [loadMore],
      )

      const totalChars = React.useMemo(() => {
        if (!Array.isArray(notes)) return null
        let sum = 0
        let known = 0
        for (const note of notes) {
          if (typeof note.chars === 'number') {
            sum += note.chars
            known += 1
          }
        }
        return known === 0 ? null : sum
      }, [notes])

      const terms = splitTerms(query)
      const searchingMode = terms.length > 0

      const rows = searchingMode && results && Array.isArray(results.matches) ? results.matches : null

      const filterText =
        conn !== null && Array.isArray(conn.titleFilter) && conn.titleFilter.length > 0
          ? t.filterHint(conn.titleFilter.join('、'))
          : ''

      // 首次运行 / 换机器：凭证还没有，直接给出「放哪两个文件」的指引。
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
            h(
              'div',
              { className: 'ima-kb-sub' },
              Array.isArray(notes) && notes.length > 0
                ? t.totalNotes(notes.length, formatNumber(totalChars)) +
                  (filterText !== '' ? ' · ' + filterText : '')
                : t.subtitle,
            ),
          ),
          h(
            'div',
            { className: 'ima-kb-search' },
            h('input', {
              className: 'ima-kb-input',
              type: 'search',
              value: query,
              placeholder: t.searchPlaceholder,
              onChange: (event) => setQuery(event.target.value),
            }),
          ),
          h(
            'button',
            {
              className: 'ima-kb-button',
              type: 'button',
              title: t.refresh,
              onClick: () => {
                setResults(null)
                loadNotes()
                if (selectedRef.current) openNote(selectedRef.current, 0, null)
              },
            },
            t.refresh,
          ),
        ),
        h(
          'div',
          { className: 'ima-kb-body' },
          h(
            'div',
            { className: 'ima-kb-side' },
            notesError !== null
              ? h('div', { className: 'ima-kb-hint' }, notesError)
              : searchingMode
                ? h(
                    'div',
                    null,
                    h(
                      'div',
                      { className: 'ima-kb-group' },
                      searching ? t.searching : t.resultsHeading(results && results.matches ? results.matches.length : 0),
                    ),
                    searchError !== null ? h('div', { className: 'ima-kb-hint' }, searchError) : null,
                    rows === null
                      ? null
                      : rows.length === 0
                        ? h('div', { className: 'ima-kb-hint' }, t.noResult)
                        : rows.map((match, index) =>
                            h(
                              'div',
                              {
                                key: 'hit-' + index,
                                className: 'ima-kb-row',
                                role: 'button',
                                tabIndex: 0,
                                onClick: () => openNote(match.noteId, Math.max(0, match.offset - JUMP_LEAD), match.anchor),
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
                    h(
                      'div',
                      { className: 'ima-kb-group' },
                      notes === null ? t.loading : t.notesHeading + (counting ? ' · ' + t.counting : ''),
                    ),
                    notes !== null && notes.length === 0 && notesError === null
                      ? h('div', { className: 'ima-kb-hint' }, t.emptyNotes)
                      : null,
                    (notes || []).map((note) =>
                      h(
                        'div',
                        {
                          key: note.id,
                          className: 'ima-kb-row',
                          role: 'button',
                          tabIndex: 0,
                          'data-active': selected === note.id ? 'true' : 'false',
                          onClick: () => openNote(note.id, 0, null),
                        },
                        h('div', { className: 'ima-kb-row-title' }, note.title),
                        h(
                          'div',
                          { className: 'ima-kb-row-meta' },
                          typeof note.chars === 'number'
                            ? formatNumber(note.chars) + ' ' + t.charUnit
                            : '…',
                        ),
                        note.preview
                          ? h('div', { className: 'ima-kb-snippet' }, note.preview)
                          : null,
                      ),
                    ),
                  ),
          ),
          h(
            'div',
            { className: 'ima-kb-main' },
            doc === null
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
                  h(
                    'div',
                    { className: 'ima-kb-reader', onScroll: onReaderScroll, ref: readerRef },
                    highlight(doc.content, terms),
                    loadingDoc ? h('div', { className: 'ima-kb-hint' }, t.counting) : null,
                  ),
                ),
          ),
        ),
      )
    }

    const IM_STYLE = [
      '.ima-kb-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}',
      '.ima-kb-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.ima-kb-headmain{flex:0 0 auto;min-width:120px}',
      '.ima-kb-title{font-size:14px;font-weight:600;line-height:1.3}',
      '.ima-kb-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ima-kb-search{flex:1 1 auto;min-width:160px}',
      '.ima-kb-input{width:100%;height:30px;padding:0 10px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);outline:none;box-sizing:border-box}',
      '.ima-kb-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.ima-kb-button{flex:0 0 auto;height:30px;padding:0 12px;font-size:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.ima-kb-button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-button:disabled{opacity:.55;cursor:default}',
      '.ima-kb-body{flex:1 1 auto;display:flex;min-height:0}',
      '.ima-kb-side{width:302px;flex:0 0 302px;overflow:auto;border-right:1px solid var(--dsw-alias-border-l1);padding:8px;box-sizing:border-box}',
      '.ima-kb-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;min-height:0}',
      '.ima-kb-group{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 10px 8px;letter-spacing:.02em}',
      '.ima-kb-row{padding:8px 10px;border-radius:8px;cursor:pointer;outline:none}',
      '.ima-kb-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-row[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}',
      '.ima-kb-row:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary)}',
      '.ima-kb-row-title{font-size:12.5px;font-weight:500;line-height:1.4}',
      '.ima-kb-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}',
      '.ima-kb-snippet{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:4px;line-height:1.55;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.ima-kb-toolbar{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}',
      '.ima-kb-doctitle{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}',
      '.ima-kb-docmeta{font-size:11px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.ima-kb-reader{flex:1 1 auto;min-height:0;overflow:auto;padding:16px 20px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.78}',
      '.ima-kb-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:24px;text-align:center}',
      '.ima-kb-hint{color:var(--dsw-alias-label-secondary);font-size:12px;padding:6px 10px;line-height:1.6}',
      '.ima-kb-mark{background:transparent;color:var(--dsw-alias-brand-primary);font-weight:600;border-bottom:2px solid var(--dsw-alias-brand-primary)}',
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
        const candidate = ctx.get('locale')
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
