/**
 * ima 知识库面板 — Host 半个插件。
 *
 * 三件事：
 *  1. 只读 HTTP 接口（/ima-kb/api/*），供页面里的侧边栏面板使用：
 *     连接诊断、列出全部笔记、按关键词检索、分页读取；
 *     浏览个人知识库（文件夹/文件）、按文件名检索、代理下载原文。
 *  2. 模型工具：笔记侧 kb_list / kb_search / kb_read，
 *     知识库侧 kb_space_list / kb_space_browse / kb_space_search，
 *     全部有界、按需使用。
 *  3. 只读：不写笔记、不传文件、不删任何东西（本机正文缓存文件除外，见 cacheDir）。
 *
 * 换机器 / 换账号：凭证默认读 ~/.config/ima/{client_id,api_key}，
 * 也可用 Config 的 credentialsDir 或 IMA_CLIENT_ID / IMA_API_KEY 环境变量覆盖。
 *
 * v1.2.0 修的三个问题：
 *  1. 本机接口的鉴权围栏以前用 `ctx.connection` 访问未注入的 Service，Cordis 会抛错，
 *     被 catch 吞成 403，于是浏览器里的面板永远拿到「没有权限」。改用 `ctx.get('connection')`
 *     可选访问，浏览器同源请求现在能正常通过。
 *  2. ima 的 list_note 单页上限 20，且 cursor 是「已经取过的条数」的字符串偏移。
 *     以前只取第一页，笔记多于此数时会静默丢笔记；现在自动翻页到 is_end。
 *  3. ima 对 get_doc_content 有频率限制（code=200001「请求频率超限」，HTTP 403）。
 *     以前并发 4 直接撞限流，大部分笔记取不到正文、检索范围悄悄缩水。现在所有请求
 *     串行排队 + 最小间隔 + 撞限流指数退避重试，交互请求优先于后台预热。
 *
 * v1.3.0 新增：个人知识库（wiki 侧）。
 *  - search_knowledge_base → 列出知识库；
 *  - get_knowledge_list → 浏览文件夹/文件（99=文件夹，1=PDF，3=Word）；
 *  - search_knowledge → 按文件名/文件夹名检索（ima 该接口只搜标题，不搜正文）；
 *  - get_media_info → 拿到带签名的原文地址，由 /ima-kb/api/kb-raw 代理下载。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'ima-kb-panel'
/** 不阻塞激活：服务都在 apply 里按需注入。 */
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
    .max(500)
    .default(500)
    .description('最多收录多少篇笔记；ima 单页上限 20，插件会自动翻页，留大一点免得漏笔记'),
  contentTtlMinutes: Schema.number()
    .step(1)
    .min(1)
    .max(10080)
    .default(360)
    .description('笔记正文缓存多少分钟（内存 + 磁盘）；笔记是静态的，重取很贵'),
  cacheDir: Schema.string()
    .default('')
    .description('正文缓存目录；留空用 ~/.dsh/cache/ima-kb-panel，填 - 表示不落盘'),
  titleFilter: Schema.string()
    .default('')
    .description('只纳入标题包含这些词的笔记，多个用逗号分隔；留空表示全部'),
})

const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.config', 'ima')
const DEFAULT_BASE_URL = 'https://ima.qq.com'
const DEFAULT_CACHE_DIR = join(homedir(), '.dsh', 'cache', 'ima-kb-panel')
const ROUTE_PREFIX = '/ima-kb/api'
const SKILL_VERSION = '1.1.10'

/** ima list_note 单页上限（服务端硬限制）。 */
const PAGE_SIZE = 20
/** 翻页硬上限，防止服务端 is_end 异常时无限拉取。 */
const MAX_LIST_PAGES = 60

/** 列表缓存多久（列表本身几乎不变，翻页要 4 次接口，缓存长一点面板重开才快）。 */
const LIST_TTL_MS = 5 * 60 * 1000

/**
 * 检索最多等多久让后台预热追上（毫秒）。
 * 工具调用等太久会被上层的 Tool 超时掐掉，而面板里用户看得到进度条，可以多等。
 */
const SEARCH_WARM_BUDGET_TOOL_MS = 45000
const SEARCH_WARM_BUDGET_HTTP_MS = 150000

/**
 * ima 的调用频率限制：实测连续快速请求约 10 次后开始返回
 * `code=200001 请求频率超限`（HTTP 403），间隔 700ms 的串行请求 15/15 全部成功。
 * 这里取 800ms 留余量；所有 ima 请求共用一个串行闸门，交互请求优先于后台预热。
 */
const MIN_REQUEST_INTERVAL_MS = 800
const RATE_LIMIT_CODE = 200001
const RETRY_LIMIT = 4
const RETRY_BASE_MS = 900

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

const DISK_CACHE_VERSION = 1

/** 运行时设置；apply 时由 Loader 解析后的 Config 覆盖。 */
const settings = {
  credentialsDir: DEFAULT_CREDENTIALS_DIR,
  baseUrl: DEFAULT_BASE_URL,
  clientIdEnv: 'IMA_CLIENT_ID',
  apiKeyEnv: 'IMA_API_KEY',
  maxNotes: 500,
  contentTtlMs: 360 * 60 * 1000,
  cacheDir: DEFAULT_CACHE_DIR,
  titleFilter: [],
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function clamp(value, low, high) {
  const number = Number(value)
  if (!Number.isFinite(number)) return low
  return Math.min(high, Math.max(low, Math.trunc(number)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveSettings(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  settings.credentialsDir = nonEmptyString(config.credentialsDir) || DEFAULT_CREDENTIALS_DIR
  settings.baseUrl = (nonEmptyString(config.baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, '')
  settings.clientIdEnv = nonEmptyString(config.clientIdEnv) || 'IMA_CLIENT_ID'
  settings.apiKeyEnv = nonEmptyString(config.apiKeyEnv) || 'IMA_API_KEY'
  settings.maxNotes = clamp(config.maxNotes ?? 500, 1, 500)
  settings.contentTtlMs = clamp(config.contentTtlMinutes ?? 360, 1, 10080) * 60 * 1000
  const rawCacheDir = nonEmptyString(config.cacheDir)
  settings.cacheDir = rawCacheDir === '-' ? '' : rawCacheDir || DEFAULT_CACHE_DIR
  settings.titleFilter = String(config.titleFilter ?? '')
    .split(/[,，]/)
    .map((term) => term.trim())
    .filter((term) => term !== '')
  // 配置可能换掉了凭证来源或缓存策略：已解析的派生状态全部作废。
  credentialCache = undefined
  notesCache = undefined
  contentCache.clear()
  diskLoaded = false
  resetWarmState()
  invalidateKbCaches()
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

// ── ima 请求闸门：串行 + 最小间隔 + 限流退避重试 ─────────────────────────
/**
 * 所有 ima 请求排一条队。priority 小的先发：面板点击（0）永远排在后台预热（1）前面，
 * 否则用户点开一篇笔记要等 69 篇正文预热完。返回的 Promise 由 pump 逐个兑现。
 */
const requestQueue = []
let pumping = false
let lastRequestAt = 0
let requestSeq = 0

function pump() {
  if (pumping) return
  pumping = true
  ;(async () => {
    try {
      while (requestQueue.length > 0) {
        requestQueue.sort((left, right) => left.priority - right.priority || left.seq - right.seq)
        const item = requestQueue.shift()
        const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt)
        if (wait > 0) await sleep(wait)
        try {
          item.resolve(await item.task())
        } catch (error) {
          item.reject(error)
        } finally {
          lastRequestAt = Date.now()
        }
      }
    } finally {
      pumping = false
      if (requestQueue.length > 0) pump()
    }
  })()
}

function enqueueRequest(task, priority) {
  return new Promise((resolve, reject) => {
    requestSeq += 1
    requestQueue.push({ task, priority, seq: requestSeq, resolve, reject })
    pump()
  })
}

/** 单次 ima 调用（不含排队与重试）。 */
async function imaRequest(apiPath, body) {
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
    const failure = new Error(`连不上 ima（${apiPath}）：${error instanceof Error ? error.message : String(error)}`)
    failure.kind = 'network'
    throw failure
  }
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    const failure = new Error(`ima 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 200)}`)
    failure.code = response.status === 429 ? RATE_LIMIT_CODE : undefined
    throw failure
  }
  if (payload === null || typeof payload !== 'object' || payload.code !== 0) {
    const code = payload !== null && typeof payload === 'object' ? payload.code : undefined
    const msg = payload !== null && typeof payload === 'object' ? payload.msg : text.slice(0, 200)
    const failure = new Error(`ima 接口 ${apiPath} 失败（code=${code}）：${msg}`)
    failure.code = code
    throw failure
  }
  return payload.data
}

/**
 * 排队的 ima 调用；撞频率限制时按指数退避重试。
 * @param {string} apiPath - 相对路径，例如 openapi/note/v1/list_note。
 * @param {object} body - 请求体。
 * @param {{priority?: number}} [options] - priority 0 交互（默认），1 后台预热。
 */
async function imaApi(apiPath, body, options) {
  const priority = options !== undefined && options !== null && options.priority === 1 ? 1 : 0
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      return await enqueueRequest(() => imaRequest(apiPath, body), priority)
    } catch (error) {
      const rateLimited = error !== null && error !== undefined && error.code === RATE_LIMIT_CODE
      if (rateLimited && attempt <= RETRY_LIMIT) {
        await sleep(RETRY_BASE_MS * attempt)
        continue
      }
      throw error
    }
  }
}

// ── 正文缓存（内存 + 磁盘） ──────────────────────────────────────────────
const contentCache = new Map()
let diskLoaded = false
let diskSaveTimer
let diskFile

function cacheFile() {
  if (settings.cacheDir === '') return ''
  if (diskFile !== undefined) return diskFile
  let clientId = ''
  try {
    clientId = credentialState().clientId
  } catch {
    clientId = ''
  }
  const key = createHash('sha256').update(`${settings.baseUrl}|${clientId}`).digest('hex').slice(0, 16)
  diskFile = join(settings.cacheDir, `content-${key}.json`)
  return diskFile
}

function freshContent(noteId) {
  const cached = contentCache.get(noteId)
  if (cached === undefined) return undefined
  if (Date.now() - cached.at >= settings.contentTtlMs) return undefined
  return cached
}

/** 首次用到正文时把磁盘缓存读回内存（过期条目直接丢）。 */
function ensureDiskLoaded() {
  if (diskLoaded) return
  diskLoaded = true
  const file = cacheFile()
  if (file === '') return
  let payload
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return
  }
  if (payload === null || typeof payload !== 'object') return
  if (payload.version !== DISK_CACHE_VERSION || payload.baseUrl !== settings.baseUrl) return
  const notes = payload.notes !== null && typeof payload.notes === 'object' ? payload.notes : {}
  for (const [noteId, entry] of Object.entries(notes)) {
    if (entry === null || typeof entry !== 'object' || typeof entry.content !== 'string') continue
    const at = Number(entry.at) || 0
    if (Date.now() - at >= settings.contentTtlMs) continue
    contentCache.set(noteId, { content: entry.content, at })
  }
}

function writeDiskCache() {
  const file = cacheFile()
  if (file === '') return
  const notes = {}
  for (const [noteId, entry] of contentCache) {
    if (Date.now() - entry.at >= settings.contentTtlMs) continue
    notes[noteId] = { content: entry.content, at: entry.at }
  }
  const payload = JSON.stringify({ version: DISK_CACHE_VERSION, baseUrl: settings.baseUrl, savedAt: Date.now(), notes })
  try {
    mkdirSync(settings.cacheDir, { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, file)
  } catch {
    try {
      rmSync(`${file}.tmp-${process.pid}`, { force: true })
    } catch {
      // 写缓存失败不影响功能。
    }
  }
}

/** 预热期间不反复落盘：最后 flushDiskSave 一次写完就够了。 */
let saveSuppressed = 0

function scheduleDiskSave() {
  if (settings.cacheDir === '') return
  if (saveSuppressed > 0) return
  if (diskSaveTimer !== undefined) return
  diskSaveTimer = setTimeout(() => {
    diskSaveTimer = undefined
    writeDiskCache()
  }, 8000)
  if (typeof diskSaveTimer.unref === 'function') diskSaveTimer.unref()
}

function flushDiskSave() {
  if (diskSaveTimer !== undefined) {
    clearTimeout(diskSaveTimer)
    diskSaveTimer = undefined
  }
  writeDiskCache()
}

function removeDiskCache() {
  const file = cacheFile()
  if (file === '') return
  try {
    rmSync(file, { force: true })
  } catch {
    // 删不掉就算了，内存缓存已经清空。
  }
}

function cachedChars(noteId) {
  const entry = freshContent(noteId)
  return entry === undefined ? null : entry.content.length
}

// ── 笔记列表 ────────────────────────────────────────────────────────────
let notesCache

/** 预热进度：面板用它显示「正在载入 N/M 篇正文」。 */
const warmState = { running: false, total: 0, done: 0, failed: 0, startedAt: 0, finishedAt: 0 }
let warmPromise

function resetWarmState() {
  warmPromise = undefined
  warmState.running = false
  warmState.total = 0
  warmState.done = 0
  warmState.failed = 0
  warmState.startedAt = 0
  warmState.finishedAt = 0
}

function invalidateAll() {
  notesCache = undefined
  contentCache.clear()
  diskLoaded = true
  removeDiskCache()
  resetWarmState()
}

function matchesTitleFilter(title) {
  if (settings.titleFilter.length === 0) return true
  const lower = String(title).toLowerCase()
  return settings.titleFilter.some((term) => lower.includes(term.toLowerCase()))
}

/**
 * 列出（标题过滤后的）全部笔记。
 *
 * ima 的 list_note 单页上限 20，`cursor` 是「已经取过的条数」的十进制字符串，
 * 响应里用 `is_end` 标记是否到底。只取第一页会静默丢掉后面的笔记，所以这里翻页。
 */
async function listNotes() {
  if (notesCache !== undefined && Date.now() - notesCache.at < LIST_TTL_MS) return notesCache.notes
  const notes = []
  let cursor = ''
  let fetched = 0
  let reachedEnd = false
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const data = await imaApi('openapi/note/v1/list_note', {
      cursor,
      limit: PAGE_SIZE,
      sort_type: 0,
    })
    const rows = Array.isArray(data?.note_book_list) ? data.note_book_list : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !row.note_id) continue
      const note = {
        id: String(row.note_id),
        title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.note_id),
        modified: Number(row.modify_time) || 0,
        /** list_note 的 summary 其实是正文开头一段，用来做列表预览。 */
        preview: typeof row.summary === 'string' ? row.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
      }
      if (matchesTitleFilter(note.title)) notes.push(note)
    }
    fetched += rows.length
    if (data?.is_end === true || rows.length < PAGE_SIZE) {
      reachedEnd = true
      break
    }
    if (notes.length >= settings.maxNotes) break
    cursor = String(fetched)
  }
  const truncated = reachedEnd === false && notes.length >= settings.maxNotes
  const capped = notes.slice(0, settings.maxNotes)
  notesCache = { at: Date.now(), notes: capped, truncated }
  return capped
}

async function noteContent(noteId, priority) {
  ensureDiskLoaded()
  const cached = freshContent(noteId)
  if (cached !== undefined) return cached
  const data = await imaApi('openapi/note/v1/get_doc_content', {
    note_id: noteId,
    target_content_format: 0,
  }, { priority: priority ?? 0 })
  const content = typeof data?.content === 'string' ? data.content : ''
  const entry = { content, at: Date.now() }
  contentCache.set(noteId, entry)
  scheduleDiskSave()
  return entry
}

async function noteMeta(noteId) {
  const notes = await listNotes()
  const found = notes.find((note) => note.id === noteId)
  if (found !== undefined) return found
  return { id: noteId, title: noteId, modified: 0, preview: '' }
}

function notesWithChars(notes) {
  return notes.map((note) => ({ ...note, chars: cachedChars(note.id) }))
}

/**
 * 把缺正文的笔记逐篇取回（串行、低优先级，避免打断用户点击）。
 * 同一时刻只允许一个预热在跑，重复调用复用同一个 Promise。
 */
function warmAll() {
  if (warmPromise !== undefined) return warmPromise
  const run = (async () => {
    ensureDiskLoaded()
    const notes = await listNotes()
    const queue = notes.filter((note) => freshContent(note.id) === undefined)
    warmState.running = true
    warmState.total = queue.length
    warmState.done = 0
    warmState.failed = 0
    warmState.startedAt = Date.now()
    warmState.finishedAt = 0
    saveSuppressed += 1
    const failedIds = []
    try {
      for (const note of queue) {
        try {
          await noteContent(note.id, 1)
        } catch {
          // 单篇失败不拖垮整体：搜索时跳过它即可，进度里记失败数。
          warmState.failed += 1
          failedIds.push(note.id)
        }
        warmState.done += 1
      }
      // 一轮结束后把失败的再补一次：撞限流退避之后常常能成功。
      let recovered = 0
      for (const noteId of failedIds) {
        try {
          await noteContent(noteId, 1)
          recovered += 1
        } catch {
          // 两次都失败就放弃，检索时按「跳过 N 篇」处理。
        }
      }
      if (recovered > 0) warmState.failed = Math.max(0, warmState.failed - recovered)
    } finally {
      saveSuppressed -= 1
      warmState.running = false
      warmState.finishedAt = Date.now()
      flushDiskSave()
    }
    return notesWithChars(notes)
  })()
  warmPromise = run
  run.then(
    () => { if (warmPromise === run) warmPromise = undefined },
    () => { if (warmPromise === run) warmPromise = undefined },
  )
  return run
}

function warmSnapshot() {
  const listed = notesCache === undefined ? null : notesCache.notes.length
  let cached = 0
  if (notesCache !== undefined) {
    for (const note of notesCache.notes) {
      if (cachedChars(note.id) !== null) cached += 1
    }
  }
  return {
    running: warmState.running,
    total: warmState.total,
    done: warmState.done,
    failed: warmState.failed,
    cached,
    listed,
    truncated: notesCache === undefined ? false : notesCache.truncated,
  }
}

// ── 检索 ────────────────────────────────────────────────────────────────
/**
 * 等后台预热追上，最多等 budgetMs。
 * @returns {Promise<boolean>} 是否已把全部笔记正文取到本地。
 */
async function waitForWarm(budgetMs) {
  ensureDiskLoaded()
  const notes = await listNotes()
  if (notes.every((note) => freshContent(note.id) !== undefined)) return true
  if (budgetMs <= 0) return false
  warmAll()
  const startedAt = Date.now()
  for (;;) {
    const snapshot = warmSnapshot()
    if (snapshot.listed !== null && snapshot.cached >= snapshot.listed) return true
    if (warmPromise === undefined) return false
    if (Date.now() - startedAt >= budgetMs) return false
    await sleep(400)
  }
}

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

/**
 * 在缓存里的笔记中做子串检索。多个词以空格分隔时，每个词各取命中，
 * 窗口按位置合并，所以「仓位 止损」能一次拿到两词相邻的段落。
 */
async function searchNotes(terms, options) {
  const limit = clamp(options?.limit ?? 8, WINDOW_LIMIT_MIN, WINDOW_LIMIT_MAX)
  const budget = typeof options?.warmBudgetMs === 'number' ? options.warmBudgetMs : SEARCH_WARM_BUDGET_HTTP_MS
  const onlyNote = options?.noteId
  const notes = await listNotes()
  const targets = onlyNote === undefined || onlyNote === '' ? notes : notes.filter((note) => note.id === onlyNote)
  if (terms.length === 0) {
    return { terms, notesScanned: 0, notesSkipped: 0, charsScanned: 0, matches: [], truncated: false, warming: false }
  }
  if (targets.length === 0) {
    throw new Error(`知识库里没有 note_id=${onlyNote} 这篇笔记。先用 kb_list 看可用的 id。`)
  }
  // 正文没取全时先给后台预热一点时间；等不到就带着「结果可能不全」的标记返回，
  // 而不是把工具调用挂到被上层超时掐掉。
  const complete = await waitForWarm(budget)

  let charsScanned = 0
  let notesSkipped = 0
  const perNote = []
  for (const note of targets) {
    const cached = freshContent(note.id)
    if (cached === undefined) {
      notesSkipped += 1
      continue
    }
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
    notesScanned: targets.length - notesSkipped,
    notesSkipped,
    charsScanned,
    totalWindows,
    truncated: totalWindows > matches.length,
    matches,
    warming: complete === false,
    warm: warmSnapshot(),
  }
}

function formatCount(number) {
  return typeof number === 'number' ? number.toLocaleString('en-US') : '未知'
}

// ── 个人知识库（wiki 侧） ────────────────────────────────────────────────
/** 知识库列表缓存多久（列表很少变，5 分钟足够）。 */
const KB_LIST_TTL_MS = 5 * 60 * 1000
/** 目录列表缓存多久。 */
const KB_DIR_TTL_MS = 2 * 60 * 1000
/** get_knowledge_list 单页上限（服务端允许 50）。 */
const KB_PAGE_SIZE = 50
/** 知识库翻页硬上限。 */
const MAX_KB_PAGES = 20

const MEDIA_TYPE_LABELS = {
  99: '文件夹',
  1: 'PDF',
  3: 'Word',
}

let kbListCache
const kbDirCache = new Map()

function normalizeKbItem(row) {
  if (row === null || typeof row !== 'object' || !row.media_id) return null
  const mediaType = Number(row.media_type) || 0
  return {
    mediaId: String(row.media_id),
    title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.media_id),
    type: mediaType,
    typeLabel: MEDIA_TYPE_LABELS[mediaType] ?? '文件',
    folder: mediaType === 99,
    parentFolderId: typeof row.parent_folder_id === 'string' ? row.parent_folder_id : '',
    tags: Array.isArray(row.tags) ? row.tags : [],
  }
}

/** 列出当前凭证能看到的全部知识库（自动翻页）。 */
async function listKnowledgeBases() {
  if (kbListCache !== undefined && Date.now() - kbListCache.at < KB_LIST_TTL_MS) return kbListCache.items
  const items = []
  let cursor = ''
  for (let page = 0; page < MAX_KB_PAGES; page += 1) {
    const data = await imaApi('openapi/wiki/v1/search_knowledge_base', {
      query: '',
      cursor,
      limit: 20,
    })
    const rows = Array.isArray(data?.info_list) ? data.info_list : []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !row.kb_id) continue
      items.push({
        id: String(row.kb_id),
        name: typeof row.kb_name === 'string' ? row.kb_name : String(row.kb_id),
        count: Number(row.content_count) || 0,
        description: typeof row.description === 'string' ? row.description : '',
        role: typeof row.role_type === 'string' ? row.role_type : '',
        baseType: typeof row.base_type === 'string' ? row.base_type : '',
      })
    }
    if (data?.is_end === true || rows.length === 0) break
    cursor = typeof data?.next_cursor === 'string' ? data.next_cursor : ''
    if (cursor === '') break
  }
  kbListCache = { at: Date.now(), items }
  return items
}

/** 列出一个知识库的某个目录（folderId 空 = 根目录）。 */
async function listKbDirectory(kbId, folderId, cursor) {
  const dirKey = `${kbId}|${folderId}|${cursor}`
  const cached = kbDirCache.get(dirKey)
  if (cached !== undefined && Date.now() - cached.at < KB_DIR_TTL_MS) return cached.value
  const body = { knowledge_base_id: kbId, cursor: cursor ?? '', limit: KB_PAGE_SIZE }
  if (folderId !== undefined && folderId !== '') body.folder_id = folderId
  const data = await imaApi('openapi/wiki/v1/get_knowledge_list', body)
  const items = []
  for (const row of Array.isArray(data?.knowledge_list) ? data.knowledge_list : []) {
    const item = normalizeKbItem(row)
    if (item !== null) items.push(item)
  }
  const path = (Array.isArray(data?.current_path) ? data.current_path : [])
    .filter((node) => node !== null && typeof node === 'object' && node.folder_id)
    .map((node) => ({
      id: String(node.folder_id),
      name: typeof node.name === 'string' ? node.name : String(node.folder_id),
    }))
  const value = {
    items,
    path,
    isEnd: data?.is_end === true || items.length === 0,
    nextCursor: typeof data?.next_cursor === 'string' ? data.next_cursor : '',
  }
  kbDirCache.set(dirKey, { at: Date.now(), value })
  return value
}

/** 在知识库里按文件名/文件夹名检索（ima 该接口不搜正文）。 */
async function searchKbFiles(kbId, query) {
  const data = await imaApi('openapi/wiki/v1/search_knowledge', {
    knowledge_base_id: kbId,
    query,
    cursor: '',
  })
  const items = []
  for (const row of Array.isArray(data?.info_list) ? data.info_list : []) {
    const item = normalizeKbItem(row)
    if (item !== null) {
      item.snippet = typeof row.highlight_content === 'string' ? row.highlight_content.slice(0, 300) : ''
      items.push(item)
    }
  }
  return items
}

/** 取文件原文的签名地址（带有效期的签名，不缓存）。 */
async function mediaInfo(mediaId) {
  const data = await imaApi('openapi/wiki/v1/get_media_info', { media_id: mediaId })
  const urlInfo = data !== null && typeof data === 'object' && data.url_info !== null && typeof data.url_info === 'object'
    ? data.url_info
    : null
  return {
    mediaType: Number(data?.media_type) || 0,
    url: typeof urlInfo?.url === 'string' ? urlInfo.url : '',
    headers: urlInfo?.headers !== null && typeof urlInfo?.headers === 'object' ? urlInfo.headers : {},
  }
}

function invalidateKbCaches() {
  kbListCache = undefined
  kbDirCache.clear()
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
      + '笔记多时传 query 只列标题含该词的笔记，避免一次吐几百行。'
      + '只在用户明确要求查看或检索自己的知识库时使用；用户没有要求时不要主动调用。',
    parameters: {
      query: { type: 'string', description: '可选：只列出标题包含这个词的笔记。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const notes = await listNotes()
      if (notes.length === 0) {
        return settings.titleFilter.length > 0
          ? `没有标题命中过滤词「${settings.titleFilter.join('、')}」的笔记。`
          : '这个 ima 账号里还没有笔记。'
      }
      const want = typeof args?.query === 'string' ? args.query.trim() : ''
      const shown = want === '' ? notes : notes.filter((note) => note.title.toLowerCase().includes(want.toLowerCase()))
      if (shown.length === 0) return `没有标题含「${want}」的笔记。`
      const truncated = notesCache !== undefined && notesCache.truncated === true
      const lines = [
        `共 ${shown.length} 篇笔记${want !== '' ? `（标题含「${want}」；全库 ${notes.length} 篇）` : ''}${truncated ? `（已达到 maxNotes=${settings.maxNotes} 上限，可能还有更多）` : ''}：`,
        '',
      ]
      for (const note of shown) {
        const chars = cachedChars(note.id)
        const size = chars === null ? '' : ` · ${formatCount(chars)} 字`
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
      const result = await searchNotes(terms, {
        limit: args?.limit,
        noteId: args?.note_id,
        warmBudgetMs: SEARCH_WARM_BUDGET_TOOL_MS,
      })
      const skipped = result.notesSkipped > 0 ? `，${result.notesSkipped} 篇取正文失败被跳过` : ''
      const warming = result.warming === true
        ? `\n注意：正文还在后台载入（${result.warm.done}/${result.warm.total}），本次结果可能不全，稍等几十秒再检索一次。`
        : ''
      if (result.matches.length === 0) {
        return `在 ${result.notesScanned} 篇笔记（${formatCount(result.charsScanned)} 字${skipped}）里没有找到 ${terms.map((term) => `「${term}」`).join('')}。\n`
          + '检索是字面匹配：换用户材料里可能出现的原词试试，或用 kb_list 看有哪些笔记。'
          + warming
      }
      const grouped = new Map()
      for (const match of result.matches) {
        const list = grouped.get(match.noteId) ?? []
        list.push(match)
        grouped.set(match.noteId, list)
      }
      const lines = [
        `命中 ${result.matches.length} 段${result.truncated ? `（共 ${result.totalWindows} 段，已截断）` : ''}，`
          + `检索范围 ${result.notesScanned} 篇 / ${formatCount(result.charsScanned)} 字${skipped}。`,
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
      return lines.join('\n') + warming
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
      const cached = await noteContent(noteId, 0)
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

  // ── 知识库侧工具：只在用户明确要求查看个人知识库文件时使用 ──
  registerTool(ctx, {
    name: 'kb_space_list',
    description:
      '列出用户 ima 账号里能看到的知识库（kb_id、名称、文件数、说明、角色）。'
      + '只在用户明确要求查看或检索自己的知识库时使用；用户没有要求时不要主动调用。'
      + '拿到 kb_id 后用 kb_space_browse 浏览目录，或用 kb_space_search 按文件名检索。',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const items = await listKnowledgeBases()
      if (items.length === 0) return '这个 ima 账号里没有可见的知识库。'
      const lines = [`共 ${items.length} 个知识库：`, '']
      for (const item of items) {
        lines.push(`- ${item.name} — ${formatCount(item.count)} 个文件${item.role !== '' ? `（${item.role}）` : ''}`)
        lines.push(`  kb_id: ${item.id}`)
        if (item.description !== '') lines.push(`  说明：${item.description}`)
      }
      lines.push('', '用 kb_space_browse(kb_id) 浏览目录，或用 kb_space_search(kb_id, query) 按文件名检索。')
      return lines.join('\n')
    },
  })

  registerTool(ctx, {
    name: 'kb_space_browse',
    description:
      '浏览 ima 个人知识库的目录：列出某知识库根目录或某文件夹下的文件夹与文件（media_id、类型、标题）。'
      + '只在用户明确要求查看自己的知识库文件时使用。文件夹是 media_type=99，PDF 是 1，Word 是 3。'
      + '想读文件内容时，优先在 ima 笔记侧用 kb_search 搜正文（笔记与知识库文件是同一批材料的两份入口）。',
    parameters: {
      kb_id: { type: 'string', required: true, description: '知识库 id，来自 kb_space_list。' },
      folder_id: { type: 'string', description: '要浏览的文件夹 media_id；省略表示根目录。' },
      limit: { type: 'number', description: '最多返回多少条，1~50，默认 50。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const kbId = typeof args?.kb_id === 'string' ? args.kb_id.trim() : ''
      if (kbId === '') return 'kb_id 不能为空。先用 kb_space_list 看有哪些知识库。'
      const folderId = typeof args?.folder_id === 'string' ? args.folder_id.trim() : ''
      const limit = clamp(args?.limit ?? 50, 1, 50)
      const dir = await listKbDirectory(kbId, folderId, '')
      const shown = dir.items.slice(0, limit)
      const path = dir.path.map((node) => node.name).join(' / ') || '根目录'
      if (shown.length === 0) return `「${path}」是空的。`
      const folders = shown.filter((item) => item.folder)
      const files = shown.filter((item) => !item.folder)
      const lines = [`${path} · 文件夹 ${folders.length} 个，文件 ${files.length} 个${dir.items.length > limit ? `（共 ${dir.items.length} 条，已截断）` : ''}：`, '']
      for (const item of folders) {
        lines.push(`- [文件夹] ${item.title}`)
        lines.push(`  media_id: ${item.mediaId}`)
      }
      for (const item of files) {
        lines.push(`- [${item.typeLabel}] ${item.title}`)
        lines.push(`  media_id: ${item.mediaId}`)
      }
      lines.push('', '进子文件夹：kb_space_browse(kb_id, folder_id=<文件夹的 media_id>)。')
      lines.push('下载原文：在侧边栏「ima 知识库」面板的知识库页里点「下载原文」。')
      return lines.join('\n')
    },
  })

  registerTool(ctx, {
    name: 'kb_space_search',
    description:
      '在指定 ima 知识库里按文件名/文件夹名检索（ima 的这个接口只匹配标题，不搜正文）。'
      + '只在用户明确要求检索自己的知识库文件时使用；正文检索请用笔记侧的 kb_search。',
    parameters: {
      kb_id: { type: 'string', required: true, description: '知识库 id，来自 kb_space_list。' },
      query: { type: 'string', required: true, description: '要匹配的文件名关键词。' },
      limit: { type: 'number', description: '最多返回多少条，1~50，默认 20。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const kbId = typeof args?.kb_id === 'string' ? args.kb_id.trim() : ''
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (kbId === '') return 'kb_id 不能为空。先用 kb_space_list 看有哪些知识库。'
      if (query === '') return 'query 不能为空。'
      const items = await searchKbFiles(kbId, query)
      if (items.length === 0) {
        return `知识库 ${kbId} 里没有文件名含「${query}」的内容。\n注意：这个接口只匹配文件名/文件夹名，不搜正文；正文请用 kb_search。`
      }
      const limit = clamp(args?.limit ?? 20, 1, 50)
      const shown = items.slice(0, limit)
      const lines = [`文件名命中 ${shown.length} 条${items.length > limit ? `（共 ${items.length} 条，已截断）` : ''}：`, '']
      for (const item of shown) {
        lines.push(`- [${item.folder ? '文件夹' : item.typeLabel}] ${item.title}`)
        lines.push(`  media_id: ${item.mediaId}`)
        if (item.snippet !== '') lines.push(`  摘要：${item.snippet}`)
      }
      lines.push('', '下载原文：在侧边栏「ima 知识库」面板的知识库页里点「下载原文」。')
      return lines.join('\n')
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

/**
 * 浏览器会话围栏。
 *
 * v1.1.0 直接用 `ctx.connection` 访问未注入的 Service —— Cordis 对未注入的 Service
 * 做属性访问会抛错，被 catch 兜成 403，于是浏览器同源请求也全被拒。
 * `ctx.get('connection')` 才是「可选访问」的正确写法：没有 Connection 的载体
 * （例如纯命令行 / 非 Web）放行，有则照它的 Host/Origin 与浏览器会话校验。
 */
function createFence(ctx) {
  let connection
  try {
    connection = ctx.get('connection')
  } catch {
    connection = undefined
  }
  return (req) => {
    if (connection === undefined || connection === null) return undefined
    if (typeof connection.requestRejection !== 'function') return undefined
    try {
      const rejection = connection.requestRejection(req)
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch {
      return 403
    }
  }
}

function registerRoutes(ctx) {
  const fence = createFence(ctx)

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
        let truncated = false
        if (state.source !== 'none') {
          try {
            noteCount = (await listNotes()).length
            truncated = notesCache !== undefined && notesCache.truncated === true
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
          cacheDir: settings.cacheDir,
          titleFilter: settings.titleFilter,
          noteCount,
          truncated,
          warm: warmSnapshot(),
        })
        return
      }
      if (route === 'notes') {
        const notes = await listNotes()
        sendJson(res, 200, {
          notes: notesWithChars(notes),
          truncated: notesCache !== undefined && notesCache.truncated === true,
          maxNotes: settings.maxNotes,
          warm: warmSnapshot(),
        })
        return
      }
      if (route === 'warm') {
        sendJson(res, 200, { notes: await warmAll(), warm: warmSnapshot() })
        return
      }
      if (route === 'warm-status') {
        sendJson(res, 200, warmSnapshot())
        return
      }
      if (route === 'note') {
        const noteId = url.searchParams.get('id') ?? ''
        if (noteId === '') {
          sendJson(res, 400, { error: 'missing id' })
          return
        }
        const limit = clamp(url.searchParams.get('length') ?? 30000, 1, 60000)
        const cached = await noteContent(noteId, 0)
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
          sendJson(res, 200, {
            terms, matches: [], notesScanned: 0, notesSkipped: 0, charsScanned: 0, totalWindows: 0, truncated: false,
          })
          return
        }
        const limit = clamp(url.searchParams.get('limit') ?? 12, WINDOW_LIMIT_MIN, WINDOW_LIMIT_MAX)
        sendJson(res, 200, { ...(await searchNotes(terms, { limit })), warm: warmSnapshot() })
        return
      }
      if (route === 'refresh') {
        invalidateAll()
        invalidateKbCaches()
        credentialCache = undefined
        sendJson(res, 200, { ok: true })
        return
      }
      // ── 知识库（wiki）──
      if (route === 'kb') {
        sendJson(res, 200, { items: await listKnowledgeBases() })
        return
      }
      if (route === 'kb-files') {
        const kbId = url.searchParams.get('kb') ?? ''
        if (kbId === '') {
          sendJson(res, 400, { error: 'missing kb' })
          return
        }
        const dir = await listKbDirectory(
          kbId,
          url.searchParams.get('folder') ?? '',
          url.searchParams.get('cursor') ?? '',
        )
        sendJson(res, 200, dir)
        return
      }
      if (route === 'kb-search') {
        const kbId = url.searchParams.get('kb') ?? ''
        const query = (url.searchParams.get('q') ?? '').trim()
        if (kbId === '') {
          sendJson(res, 400, { error: 'missing kb' })
          return
        }
        if (query === '') {
          sendJson(res, 200, { items: [] })
          return
        }
        sendJson(res, 200, { items: await searchKbFiles(kbId, query) })
        return
      }
      if (route === 'kb-file') {
        const mediaId = url.searchParams.get('media_id') ?? ''
        if (mediaId === '') {
          sendJson(res, 400, { error: 'missing media_id' })
          return
        }
        const info = await mediaInfo(mediaId)
        sendJson(res, 200, {
          mediaId,
          type: info.mediaType,
          typeLabel: MEDIA_TYPE_LABELS[info.mediaType] ?? '文件',
          downloadable: info.url !== '',
        })
        return
      }
      if (route === 'kb-raw') {
        const mediaId = url.searchParams.get('media_id') ?? ''
        if (mediaId === '') {
          sendJson(res, 400, { error: 'missing media_id' })
          return
        }
        try {
          const info = await mediaInfo(mediaId)
          if (info.url === '') {
            sendJson(res, 404, { error: 'no downloadable url' })
            return
          }
          const upstream = await fetch(info.url, { headers: info.headers })
          if (!upstream.ok || upstream.body === null) {
            sendJson(res, 502, { error: `upstream ${upstream.status}` })
            return
          }
          const title = url.searchParams.get('title') ?? 'file'
          const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream'
          res.writeHead(200, {
            'content-type': contentType,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}`,
            'cache-control': 'no-store',
          })
          for await (const chunk of upstream.body) {
            res.write(chunk)
          }
          res.end()
          return
        } catch (error) {
          try {
            res.destroy()
          } catch {
            // 连接可能已经断开，忽略。
          }
          return
        }
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
  // 启动后主动预热一轮：本次进程里第一次 kb_search / 面板检索就不用干等。
  // 有磁盘缓存时这一步只是 4 次列表请求；插件卸载时计时器会被清掉。
  ctx.effect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      if (credentialState().source === 'none') return
      warmAll().catch(() => {})
    }, 3000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, 'ima-kb-panel: background warm')
  // 插件卸载时把还没落盘的正文缓存写下去，别丢掉刚预热完的几十秒。
  ctx.effect(() => () => {
    try {
      flushDiskSave()
    } catch {
      // 卸载阶段写缓存失败不影响退出。
    }
  })
}
