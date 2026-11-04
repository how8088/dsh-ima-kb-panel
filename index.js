/**
 * ima 知识库面板 — Host 半个插件。
 *
 * 两件事：
 *  1. 只读 HTTP 接口（/ima-kb/api/*），供页面里的侧边栏面板使用：
 *     连接诊断、列出笔记、按关键词检索、分页读取。
 *  2. 三个模型工具（kb_list / kb_search / kb_read），供对话里按需读取：
 *     笔记单篇最长约 60 万字符，所以检索与读取都必须有界。
 *
 * 只读：不写笔记、不传文件、不删任何东西。
 *
 * 换机器 / 换账号：凭证默认读 ~/.config/ima/{client_id,api_key}，
 * 也可用 Config 的 credentialsDir 或 IMA_CLIENT_ID / IMA_API_KEY 环境变量覆盖。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'ima-kb-panel'
/** 不阻塞激活：两个服务都在 apply 里按需注入。 */
export const inject = []

export const Config = Schema.object({
  credentialsDir: Schema.string()
    .default('')
    .description('存放 ima 凭证 client_id / api_key 的目录；留空用 ~/.config/ima'),
  baseUrl: Schema.string()
    .default('https://ima.qq.com')
    .description('ima OpenAPI 根地址，一般不用改'),
  clientIdEnv: Schema.string()
    .default('IMA_CLIENT_ID')
    .description('client_id 读哪个环境变量（优先于凭证目录里的文件）'),
  apiKeyEnv: Schema.string()
    .default('IMA_API_KEY')
    .description('api_key 读哪个环境变量（优先于凭证目录里的文件）'),
  maxNotes: Schema.number()
    .step(1)
    .min(1)
    .max(20)
    .default(20)
    .description('最多列出多少篇笔记（ima 的 list_note 单页上限 20）'),
  contentTtlMinutes: Schema.number()
    .step(1)
    .min(1)
    .max(1440)
    .default(10)
    .description('笔记正文在进程内缓存多少分钟；笔记是静态的，重取很贵'),
  titleFilter: Schema.string()
    .default('')
    .description('只纳入标题包含这些词的笔记，多个用逗号分隔；留空表示全部'),
})

const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.config', 'ima')
const DEFAULT_BASE_URL = 'https://ima.qq.com'
const ROUTE_PREFIX = '/ima-kb/api'
const SKILL_VERSION = '1.1.10'
/** 列表缓存多久。 */
const LIST_TTL_MS = 60 * 1000
/** 取正文的并发上限。 */
const FETCH_CONCURRENCY = 3

const SNIPPET_RADIUS = 320
const SNIPPET_GAP = 80
/** 单个片段最多扩到多少字符（按行扩过头时回退到这个上限之内）。 */
const MAX_WINDOW_CHARS = 760
/** 片段正文最多回多少字符，超出显式标省略号。 */
const SNIPPET_CHARS = 600
const MAX_WINDOWS_PER_NOTE = 6
const WINDOW_LIMIT_MIN = 1
const WINDOW_LIMIT_MAX = 40
const READ_LIMIT_DEFAULT = 6000
const READ_LIMIT_MAX = 30000

/** 运行时设置；apply 时由 Loader 解析后的 Config 覆盖。 */
const settings = {
  credentialsDir: DEFAULT_CREDENTIALS_DIR,
  baseUrl: DEFAULT_BASE_URL,
  clientIdEnv: 'IMA_CLIENT_ID',
  apiKeyEnv: 'IMA_API_KEY',
  maxNotes: 20,
  contentTtlMs: 10 * 60 * 1000,
  titleFilter: [],
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function resolveSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  settings.credentialsDir = nonEmptyString(config.credentialsDir) || DEFAULT_CREDENTIALS_DIR
  settings.baseUrl = (nonEmptyString(config.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '')
  settings.clientIdEnv = nonEmptyString(config.clientIdEnv) || 'IMA_CLIENT_ID'
  settings.apiKeyEnv = nonEmptyString(config.apiKeyEnv) || 'IMA_API_KEY'
  settings.maxNotes = clamp(config.maxNotes ?? 20, 1, 20)
  settings.contentTtlMs = clamp(config.contentTtlMinutes ?? 10, 1, 1440) * 60 * 1000
  settings.titleFilter = String(config.titleFilter ?? '')
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter((term) => term !== '')
  // 配置可能换掉了凭证来源或正文缓存策略：已解析的派生状态全部作废。
  credentialCache = undefined
  notesCache = undefined
  contentCache.clear()
}

function readTrim(filePath) {
  try {
    return readFileSync(filePath, 'utf8').trim()
  } catch {
    return ''
  }
}

let credentialCache
/**
 * 解析凭证来源，不抛错：面板的「首次运行」引导需要区分「没配」和「配错」。
 * @returns {{clientId: string, apiKey: string, source: 'env'|'file'|'none', files: {clientId: string, apiKey: string}}}
 */
function credentialState() {
  if (credentialCache !== undefined) return credentialCache
  const files = {
    clientId: join(settings.credentialsDir, 'client_id'),
    apiKey: join(settings.credentialsDir, 'api_key'),
  }
  const envClientId = nonEmptyString(process.env[settings.clientIdEnv])
  const envApiKey = nonEmptyString(process.env[settings.apiKeyEnv])
  const clientId = envClientId || readTrim(files.clientId)
  const apiKey = envApiKey || readTrim(files.apiKey)
  let source = 'none'
  if (clientId !== '' && apiKey !== '') source = envClientId !== '' && envApiKey !== '' ? 'env' : 'file'
  credentialCache = { clientId, apiKey, source, files }
  return credentialCache
}

function missingCredentialsMessage() {
  const files = credentialState().files
  return `未找到 ima 凭证。请把 Client ID 和 API Key 分别写入 ${files.clientId} 与 ${files.apiKey}`
    + `（目录不存在就新建），或设置 ${settings.clientIdEnv} / ${settings.apiKeyEnv} 环境变量。`
}

function credentials() {
  const state = credentialState()
  if (state.source === 'none') throw new Error(missingCredentialsMessage())
  return state
}

async function imaApi(apiPath, body) {
  const { clientId, apiKey } = credentials()
  let response
  try {
    response = await fetch(`${settings.baseUrl}/${apiPath}`, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': clientId,
        'ima-openapi-apikey': apiKey,
        'ima-openapi-ctx': `skill_version=${SKILL_VERSION}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  } catch (error) {
    throw new Error(`连不上 ima（${apiPath}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`ima 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  if (payload === null || typeof payload !== 'object' || payload.code !== 0) {
    const code = payload !== null && typeof payload === 'object' ? payload.code : '?'
    const msg = payload !== null && typeof payload === 'object' ? payload.msg : text.slice(0, 200)
    throw new Error(`ima 接口 ${apiPath} 失败（code=${code}）：${msg}`)
  }
  return payload.data
}

// ── 缓存 ────────────────────────────────────────────────────────────────
let notesCache
const contentCache = new Map()

function invalidateAll() {
  notesCache = undefined
  contentCache.clear()
}

function matchesTitleFilter(title) {
  if (settings.titleFilter.length === 0) return true
  const lower = String(title).toLowerCase()
  return settings.titleFilter.some((term) => lower.includes(term.toLowerCase()))
}

async function listNotes() {
  if (notesCache !== undefined && Date.now() - notesCache.at < LIST_TTL_MS) return notesCache.notes
  const data = await imaApi('openapi/note/v1/list_note', {
    cursor: '',
    limit: settings.maxNotes,
    sort_type: 0,
  })
  const rows = Array.isArray(data?.note_book_list) ? data.note_book_list : []
  const notes = rows
    .filter((row) => row?.note_id)
    .map((row) => ({
      id: String(row.note_id),
      title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.note_id),
      modified: Number(row.modify_time) || 0,
      /** list_note 的 summary 其实是正文开头一段，用来做列表预览。 */
      preview: typeof row.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    }))
    .filter((note) => matchesTitleFilter(note.title))
  notesCache = { at: Date.now(), notes }
  return notes
}

async function noteContent(noteId) {
  const cached = contentCache.get(noteId)
  if (cached !== undefined && Date.now() - cached.at < settings.contentTtlMs) return cached
  const data = await imaApi('openapi/note/v1/get_doc_content', {
    note_id: noteId,
    target_content_format: 0,
  })
  const content = typeof data?.content === 'string' ? data.content : ''
  const entry = { content, at: Date.now() }
  contentCache.set(noteId, entry)
  return entry
}

async function noteMeta(noteId) {
  const notes = await listNotes()
  const found = notes.find((note) => note.id === noteId)
  if (found !== undefined) return found
  return { id: noteId, title: noteId, modified: 0, preview: '' }
}

/** 并发受限地把所有笔记正文载入缓存；已缓存的跳过。 */
async function warmAll() {
  const notes = await listNotes()
  const queue = notes.filter((note) => {
    const cached = contentCache.get(note.id)
    return cached === undefined || Date.now() - cached.at >= settings.contentTtlMs
  })
  let cursor = 0
  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= queue.length) return
      try {
        await noteContent(queue[index].id)
      } catch {
        // 单篇失败不拖垮整体：搜索时跳过它即可。
      }
    }
  })
  await Promise.all(workers)
  return notes.map((note) => ({ ...note, chars: contentCache.get(note.id)?.content.length ?? null }))
}

// ── 检索 ────────────────────────────────────────────────────────────────
function tokenize(query) {
  return String(query ?? '')
    .trim()
    .split(/\s+/)
    .filter((term) => term !== '')
    .slice(0, 6)
}

function occurrences(haystackLower, needleLower, cap) {
  const positions = []
  if (needleLower === '') return positions
  let index = haystackLower.indexOf(needleLower)
  while (index !== -1 && positions.length < cap) {
    positions.push(index)
    index = haystackLower.indexOf(needleLower, index + needleLower.length)
  }
  return positions
}

/** 把命中点扩成上下文窗口，合并重叠，返回偏移量稳定可复用的片段。 */
function buildWindows(content, hits, radius) {
  if (hits.length === 0) return []
  const spans = hits
    .map((hit) => ({
      start: Math.max(0, hit.at - radius),
      end: Math.min(content.length, hit.at + hit.term.length + radius),
      at: hit.at,
      term: hit.term,
    }))
    .sort((left, right) => left.start - right.start)
  const merged = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    // 相邻命中合并成一段，但合并后的段不能超过上限：否则少数命中会撑成一个
    // 巨大的「片段」，既浪费上下文，又挤掉其它位置的命中。
    const joins = last !== undefined
      && span.start <= last.end + SNIPPET_GAP
      && span.end - last.start <= MAX_WINDOW_CHARS
    if (joins) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ ...span })
  }
  return merged.map((span) => {
    const desiredStart = Math.max(0, span.start)
    const desiredEnd = Math.min(content.length, span.end)
    let start = alignToLineStart(content, desiredStart)
    let end = alignToLineEnd(content, desiredEnd)
    // 有些笔记（例如聊天记录）整篇几乎没有换行，按行扩展会吞掉整篇正文；
    // 那样一个「片段」就是几十万字，正好是这套工具要避免的情况。超限就退回按字符截取。
    if (end - start > MAX_WINDOW_CHARS) {
      start = desiredStart
      end = desiredEnd
    }
    let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
    if (snippet.length > SNIPPET_CHARS) snippet = `${snippet.slice(0, SNIPPET_CHARS)}…`
    return {
      offset: start,
      length: end - start,
      anchor: span.at,
      snippet,
    }
  })
}

function alignToLineStart(content, index) {
  if (index <= 0) return 0
  const found = content.lastIndexOf('\n', index)
  return found === -1 ? 0 : found + 1
}

function alignToLineEnd(content, index) {
  if (index >= content.length) return content.length
  const found = content.indexOf('\n', index)
  return found === -1 ? content.length : found
}

/**
 * 在缓存里的笔记中做子串检索。多个词以空格分隔时，每个词各取命中，
 * 窗口按位置合并，所以「仓位 止损」能一次拿到两词相邻的段落。
 */
async function searchNotes(terms, options) {
  const limit = clamp(options?.limit ?? 8, WINDOW_LIMIT_MIN, WINDOW_LIMIT_MAX)
  const onlyNote = options?.noteId
  const notes = await listNotes()
  const targets = onlyNote === undefined || onlyNote === '' ? notes : notes.filter((note) => note.id === onlyNote)
  if (terms.length === 0) return { terms, notesScanned: 0, charsScanned: 0, matches: [], truncated: false }
  if (targets.length === 0) {
    throw new Error(`知识库里没有 note_id=${onlyNote} 这篇笔记。先用 kb_list 看可用的 id。`)
  }
  await warmAll()

  let charsScanned = 0
  const perNote = []
  for (const note of targets) {
    const cached = contentCache.get(note.id)
    if (cached === undefined) continue
    const content = cached.content
    charsScanned += content.length
    const lower = content.toLowerCase()
    const hits = []
    for (const term of terms) {
      for (const at of occurrences(lower, term.toLowerCase(), MAX_WINDOWS_PER_NOTE * 4)) {
        hits.push({ at, term })
      }
    }
    if (hits.length === 0) continue
    hits.sort((left, right) => left.at - right.at)
    const windows = buildWindows(content, hits, SNIPPET_RADIUS).slice(0, MAX_WINDOWS_PER_NOTE)
    perNote.push({ note, windows, hitCount: hits.length })
  }

  // 各笔记轮流取窗口，避免一篇大笔记吃掉全部配额。
  const matches = []
  let round = 0
  let added = true
  while (added && matches.length < limit) {
    added = false
    for (const bucket of perNote) {
      if (matches.length >= limit) break
      const window = bucket.windows[round]
      if (window === undefined) continue
      added = true
      matches.push({
        noteId: bucket.note.id,
        title: bucket.note.title,
        offset: window.offset,
        length: window.length,
        anchor: window.anchor,
        snippet: window.snippet,
      })
    }
    round += 1
  }

  const totalWindows = perNote.reduce((sum, bucket) => sum + bucket.windows.length, 0)
  return {
    terms,
    notesScanned: targets.length,
    charsScanned,
    totalWindows,
    truncated: totalWindows > matches.length,
    matches,
  }
}

function clamp(value, low, high) {
  const number = Number(value)
  if (!Number.isFinite(number)) return low
  return Math.min(high, Math.max(low, Math.trunc(number)))
}

function formatCount(number) {
  return typeof number === 'number' ? number.toLocaleString('en-US') : '未知'
}

// ── 工具 ────────────────────────────────────────────────────────────────
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function registerTool(ctx, definition) {
  try {
    ctx.effect(() => ctx.tools.register(defineTool(definition)))
  } catch (error) {
    console.error(`[ima-kb-panel] 工具 ${definition.name} 注册失败：`, error)
  }
}

function registerTools(ctx) {
  registerTool(ctx, {
    name: 'kb_list',
    description:
      '列出用户私有 ima 知识库里的笔记（标题、note_id、字符数、开头预览）。'
      + '只在用户明确要求查看或检索自己的知识库时使用；用户没有要求时不要主动调用。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const notes = await listNotes()
      if (notes.length === 0) {
        return settings.titleFilter.length > 0
          ? `没有标题命中过滤词「${settings.titleFilter.join('、')}」的笔记。`
          : '这个 ima 账号里还没有笔记。'
      }
      const lines = [`共 ${notes.length} 篇笔记：`, '']
      for (const note of notes) {
        const cached = contentCache.get(note.id)
        const size = cached === undefined ? '' : ` · ${formatCount(cached.content.length)} 字`
        lines.push(`- ${note.title}${size}`)
        lines.push(`  note_id: ${note.id}`)
        if (note.preview !== '') lines.push(`  开头：${note.preview}`)
      }
      lines.push('', '用 kb_search 在全部笔记里检索，用 kb_read 按偏移量读取正文。')
      return lines.join('\n')
    },
  })

  registerTool(ctx, {
    name: 'kb_search',
    description:
      '在用户私有 ima 知识库的全部笔记正文里做精确子串检索，返回命中的上下文片段及其字符偏移量。'
      + '多个关键词用空格分隔时分别检索，片段里若相邻出现会合并成同一段。'
      + '检索是字面匹配，不是语义检索：换一种说法就搜不到，所以先想用户材料里可能出现的原词。'
      + '拿到片段后用 kb_read(note_id, offset) 读更大范围的上下文。',
    parameters: {
      query: { type: 'string', required: true, description: '要检索的关键词或短语；多个词用空格分隔。' },
      note_id: { type: 'string', description: '只在这一篇笔记里检索。省略则检索全部笔记。' },
      limit: {
        type: 'number',
        description: `最多返回多少个片段，1~${WINDOW_LIMIT_MAX}，默认 8。`,
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const terms = tokenize(args?.query)
      if (terms.length === 0) return 'query 不能为空。'
      const result = await searchNotes(terms, { limit: args?.limit, noteId: args?.note_id })
      if (result.matches.length === 0) {
        return `在 ${result.notesScanned} 篇笔记（${formatCount(result.charsScanned)} 字）里没有找到 ${terms.map((term) => `「${term}」`).join('')}。\n`
          + '检索是字面匹配：换用户材料里可能出现的原词试试，或用 kb_list 看有哪些笔记。'
      }
      const grouped = new Map()
      for (const match of result.matches) {
        const list = grouped.get(match.noteId) ?? []
        list.push(match)
        grouped.set(match.noteId, list)
      }
      const lines = [
        `命中 ${result.matches.length} 段${result.truncated ? `（共 ${result.totalWindows} 段，已截断）` : ''}，`
          + `检索范围 ${result.notesScanned} 篇 / ${formatCount(result.charsScanned)} 字。`,
        '',
      ]
      for (const [, matches] of grouped) {
        lines.push(`## ${matches[0].title}  (note_id ${matches[0].noteId})`)
        for (const match of matches) {
          lines.push(`- offset ${match.offset}：${match.snippet}`)
        }
        lines.push('')
      }
      lines.push('读取更大上下文：kb_read(note_id=<上面的 id>, offset=<该片段的 offset>)。')
      return lines.join('\n')
    },
  })

  registerTool(ctx, {
    name: 'kb_read',
    description:
      '按字符偏移量读取一篇 ima 笔记的正文片段。单篇笔记最长约 60 万字符，所以必须分页读，'
      + '一次不要超过 3 万字符。偏移量取自 kb_search 返回的 offset，或上一次 kb_read 的 next_offset。',
    parameters: {
      note_id: { type: 'string', required: true, description: 'kb_list 或 kb_search 返回的 note_id。' },
      offset: { type: 'number', description: '起始字符偏移量，从 0 开始。默认 0（笔记开头）。' },
      limit: {
        type: 'number',
        description: `本次最多返回多少字符，1~${READ_LIMIT_MAX}，默认 ${READ_LIMIT_DEFAULT}。`,
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const noteId = typeof args?.note_id === 'string' ? args.note_id.trim() : ''
      if (noteId === '') return 'note_id 不能为空。先用 kb_list 看可用的笔记。'
      const limit = clamp(args?.limit ?? READ_LIMIT_DEFAULT, 1, READ_LIMIT_MAX)
      const cached = await noteContent(noteId)
      const content = cached.content
      if (content === '') return `笔记 ${noteId} 是空的。`
      const total = content.length
      const offset = clamp(args?.offset ?? 0, 0, total)
      if (offset >= total) {
        return `offset=${offset} 已超出笔记长度（共 ${formatCount(total)} 字）。从 0 开始或用 kb_search 定位。`
      }
      const end = Math.min(total, offset + limit)
      const meta = await noteMeta(noteId)
      const header = `[${meta.title} · 字符 ${formatCount(offset)}–${formatCount(end)} / 共 ${formatCount(total)}]`
      const footer =
        end >= total
          ? '[已到笔记末尾]'
          : `[还有 ${formatCount(total - end)} 字未读，下一段 offset=${end}]`
      return `${header}\n\n${content.slice(offset, end)}\n\n${footer}`
    },
  })
}

// ── HTTP 接口（面板用） ──────────────────────────────────────────────────
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function queryOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://ima-kb.internal')
  } catch {
    return new URL('http://ima-kb.internal/')
  }
}

function registerRoutes(ctx) {
  const fence = (req) => {
    try {
      return typeof ctx.connection?.requestRejection === 'function'
        ? ctx.connection.requestRejection(req)
        : undefined
    } catch {
      return 403
    }
  }

  const handler = async (req, res) => {
    const rejection = fence(req)
    if (rejection !== undefined) {
      sendJson(res, rejection, { error: 'forbidden' })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' })
      return
    }
    const url = queryOf(req)
    const route = url.pathname.startsWith(`${ROUTE_PREFIX}/`)
      ? url.pathname.slice(ROUTE_PREFIX.length + 1)
      : ''
    try {
      if (route === 'state') {
        const state = credentialState()
        let noteCount = null
        if (state.source !== 'none') {
          try {
            noteCount = (await listNotes()).length
          } catch {
            noteCount = null
          }
        }
        sendJson(res, 200, {
          configured: state.source !== 'none',
          credentialSource: state.source === 'none' ? null : state.source,
          credentialsDir: settings.credentialsDir,
          clientIdFile: state.files.clientId,
          apiKeyFile: state.files.apiKey,
          clientIdEnv: settings.clientIdEnv,
          apiKeyEnv: settings.apiKeyEnv,
          baseUrl: settings.baseUrl,
          maxNotes: settings.maxNotes,
          titleFilter: settings.titleFilter,
          noteCount,
        })
        return
      }
      if (route === 'notes') {
        const notes = await listNotes()
        sendJson(res, 200, {
          notes: notes.map((note) => ({
            id: note.id,
            title: note.title,
            modified: note.modified,
            preview: note.preview,
            chars: contentCache.get(note.id)?.content.length ?? null,
          })),
        })
        return
      }
      if (route === 'warm') {
        sendJson(res, 200, { notes: await warmAll() })
        return
      }
      if (route === 'note') {
        const noteId = url.searchParams.get('id') ?? ''
        if (noteId === '') {
          sendJson(res, 400, { error: 'missing id' })
          return
        }
        const limit = clamp(url.searchParams.get('length') ?? 30000, 1, 60000)
        const cached = await noteContent(noteId)
        const total = cached.content.length
        const start = clamp(url.searchParams.get('start') ?? 0, 0, total)
        const end = Math.min(total, start + limit)
        const meta = await noteMeta(noteId)
        sendJson(res, 200, {
          id: noteId,
          title: meta.title,
          chars: total,
          start,
          end,
          content: cached.content.slice(start, end),
        })
        return
      }
      if (route === 'search') {
        const terms = tokenize(url.searchParams.get('q') ?? '')
        if (terms.length === 0) {
          sendJson(res, 200, { terms: [], matches: [], notesScanned: 0, charsScanned: 0, totalWindows: 0, truncated: false })
          return
        }
        const limit = clamp(url.searchParams.get('limit') ?? 12, WINDOW_LIMIT_MIN, WINDOW_LIMIT_MAX)
        sendJson(res, 200, await searchNotes(terms, { limit }))
        return
      }
      if (route === 'refresh') {
        invalidateAll()
        credentialCache = undefined
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    }),
  )
}

export function apply(ctx, config) {
  resolveSettings(config)
  ctx.inject(['webServer'], (scoped) => {
    registerRoutes(scoped)
  })
  ctx.inject(['tools'], (scoped) => {
    registerTools(scoped)
  })
}
