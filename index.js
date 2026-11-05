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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import zlib from 'node:zlib'

/**
 * 解析 DSH 自带的内部包（@deepseek-ai/dsh-tools、@deepseek-ai/schemastery）。
 *
 * 不能只写静态 import：桌面版的 kernel 包只存在于 app.asar 里，
 * ~/.dsh/profiles/<profile>/node_modules 没有 fallback 副本，裸包名会
 * ERR_MODULE_NOT_FOUND（换台机器装完 tgz 直接加载失败）。
 *
 * 所以先按裸包名试（CLI 版、测试桩都走这条）；失败再按 process.execPath
 * 反推本机安装目录，从 app.asar 里读真实入口——用 execPath 推导而不是写死
 * 绝对路径，换安装目录 / 换机器都不用改代码。
 */
async function importDshPackage(specifier) {
  try {
    return await import(specifier)
  } catch {
    // 落到下面的 asar 解析。
  }
  const dir = join(dirname(process.execPath), 'resources', 'app.asar', 'dsh', 'node_modules', specifier)
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`找不到 DSH 内部包 ${specifier}（裸包名和 app.asar 都没解析到）：${error instanceof Error ? error.message : String(error)}`)
  }
  const dot = manifest.exports !== null && typeof manifest.exports === 'object' ? manifest.exports['.'] : undefined
  const entry = typeof manifest.exports === 'string'
    ? manifest.exports
    : typeof dot === 'string'
      ? dot
      : dot !== null && typeof dot === 'object'
        ? dot.import || dot.default || dot.require
        : manifest.module || manifest.main
  if (typeof entry !== 'string' || entry === '') {
    throw new Error(`DSH 内部包 ${specifier} 没有可用的入口字段`)
  }
  return await import(pathToFileURL(join(dir, entry)).href)
}

const dshTools = await importDshPackage('@deepseek-ai/dsh-tools')
const defineTool = dshTools.defineTool
const schemastery = await importDshPackage('@deepseek-ai/schemastery')
const Schema = schemastery.default ?? schemastery

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
    .default(10080)
    .description('磁盘正文缓存最长保留多久（分钟）。是否重取由笔记的 modify_time 决定，不靠这个值'),
  cacheDir: Schema.string()
    .default('')
    .description('正文缓存目录；留空用 ~/.dsh/cache/ima-kb-panel，填 - 表示不落盘'),
  titleFilter: Schema.string()
    .default('')
    .description('只纳入标题包含这些词的笔记，多个用逗号分隔；留空表示全部'),
  skillsDir: Schema.string()
    .default('')
    .description('把随包的两个技能（market-research / ima-kb）安装到哪个目录；留空用 ~/.dsh/skills'),
  autoInstallSkills: Schema.string()
    .default('on')
    .description("插件启动时把随包的技能装到 skillsDir；已存在就不覆盖。填 off 关闭"),
  kbCacheTtlMinutes: Schema.number()
    .step(1)
    .min(1)
    .max(525600)
    .default(10080)
    .description('个人知识库本地缓存保留多久（分钟）。只对「我的知识库」生效，订阅/加入的库不写磁盘'),
  kbCacheText: Schema.string()
    .default('on')
    .description("预热个人知识库时是否连正文一起缓存（md/docx/txt）；填 off 只缓存目录，正文仍按需在线取"),
  kbCacheMaxFiles: Schema.number()
    .step(1)
    .min(1)
    .max(50000)
    .default(2000)
    .description('单个个人知识库最多缓存多少个文件正文；超过就只缓存目录'),
})

const DEFAULT_CREDENTIALS_DIR = join(homedir(), '.config', 'ima')
const DEFAULT_BASE_URL = 'https://ima.qq.com'
const DEFAULT_CACHE_DIR = join(homedir(), '.dsh', 'cache', 'ima-kb-panel')
const ROUTE_PREFIX = '/ima-kb/api'
/** 发给 ima 的版本标记：跟着 package.json 走，别再手改（以前写死成 1.1.10）。 */
let SKILL_VERSION = 'unknown'
try {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
  if (typeof manifest.version === 'string' && manifest.version !== '') SKILL_VERSION = manifest.version
} catch {
  // 测试把 index.js 复制到别处时没有 package.json，忽略即可。
}

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
 * `code=200001 请求频率超限`（HTTP 403）。实测（24 篇一组）：
 *  - 串行「返回后再隔 800ms」= 每篇 1.5s；
 *  - 2 个在飞 + 起步间隔 700ms = 0.74s；
 *  - **3 个在飞 + 600ms = 0.58s，零限流**（当前采用）；
 *  - 3 个 + 450ms：服务端降速到 1.24s，不划算；
 *  - 4 个 + 400ms：直接触发 200001。
 */
const MIN_REQUEST_INTERVAL_MS = 600
/** 同时在飞的 ima 请求上限（实测 3 安全、4 会限流）。 */
const MAX_IN_FLIGHT = 3
/** 预热时的并发 worker 数（配合闸门 ≈ 1.7 请求/秒）。 */
const WARM_CONCURRENCY = 3
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

/** 磁盘缓存格式版本（v3 起正文是结构化格式转出的带换行文本）。 */
const DISK_CACHE_VERSION = 3

/** 运行时设置；apply 时由 Loader 解析后的 Config 覆盖。 */
const settings = {
  credentialsDir: DEFAULT_CREDENTIALS_DIR,
  baseUrl: DEFAULT_BASE_URL,
  clientIdEnv: 'IMA_CLIENT_ID',
  apiKeyEnv: 'IMA_API_KEY',
  maxNotes: 500,
  contentTtlMs: 10080 * 60 * 1000,
  cacheDir: DEFAULT_CACHE_DIR,
  titleFilter: [],
  skillsDir: '',
  autoInstallSkills: 'on',
  kbCacheTtlMs: 10080 * 60 * 1000,
  kbCacheText: 'on',
  kbCacheMaxFiles: 2000,
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
  settings.contentTtlMs = clamp(config.contentTtlMinutes ?? 10080, 1, 10080) * 60 * 1000
  const rawCacheDir = nonEmptyString(config.cacheDir)
  settings.cacheDir = rawCacheDir === '-' ? '' : rawCacheDir || DEFAULT_CACHE_DIR
  settings.skillsDir = nonEmptyString(config.skillsDir)
  settings.autoInstallSkills = config.autoInstallSkills === 'off' ? 'off' : 'on'
  settings.kbCacheTtlMs = clamp(config.kbCacheTtlMinutes ?? 10080, 1, 525600) * 60 * 1000
  settings.kbCacheText = config.kbCacheText === 'off' ? 'off' : 'on'
  settings.kbCacheMaxFiles = clamp(config.kbCacheMaxFiles ?? 2000, 1, 50000)
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
  resetKbDisk()
}

/** 随包技能：安装时复制到 skillsDir，已存在则不覆盖（用户可能改过）。 */
const BUNDLED_SKILLS = [
  { name: 'market-research', file: 'skills/market-research/SKILL.md' },
  { name: 'ima-kb', file: 'skills/ima-kb/SKILL.md' },
]

/**
 * 把随包的技能装到本机 skills 目录（默认 ~/.dsh/skills）。
 * 只在目标文件不存在时写入 —— 用户自己改过的技能不会被插件覆盖。
 * @returns {{installed: string[], skipped: string[], target: string}}
 */
function installBundledSkills() {
  const result = { installed: [], skipped: [], target: '' }
  if (settings.autoInstallSkills !== 'on') return result
  const baseDir = settings.skillsDir
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'skills')
  result.target = baseDir
  for (const skill of BUNDLED_SKILLS) {
    const targetDir = join(baseDir, skill.name)
    const targetFile = join(targetDir, 'SKILL.md')
    try {
      if (existsSync(targetFile)) {
        result.skipped.push(skill.name)
        continue
      }
      const source = fileURLToPath(new URL(`./${skill.file}`, import.meta.url))
      const content = readFileSync(source, 'utf8')
      mkdirSync(targetDir, { recursive: true })
      writeFileSync(targetFile, content, 'utf8')
      result.installed.push(skill.name)
    } catch {
      // 技能安装失败不影响插件本身：静默跳过。
    }
  }
  return result
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

// ── ima 请求闸门：最多 2 个在飞 + 700ms 起步间隔 + 限流退避重试 ───────────
/**
 * 实测：串行「等上一个请求返回后再隔 800ms」每篇要 1.5s；改成「最多 2 个请求在飞、
 * 相邻请求起步间隔 700ms」后每篇 0.74s，24 次并发请求零限流（code=200001）——
 * 预热速度直接翻倍。priority 小的先发：面板点击（0）排在后台预热（1）前面，
 * 用户点开一篇笔记不用等全部预热完。
 */
const requestQueue = []
let pumping = false
let lastStartAt = 0
let inFlight = 0
let requestSeq = 0

/** 队列里挑优先级最高（同优先级按先进先出）的一件。 */
function takeNextRequest() {
  let best = 0
  for (let i = 1; i < requestQueue.length; i += 1) {
    const current = requestQueue[i]
    const top = requestQueue[best]
    if (current.priority < top.priority || (current.priority === top.priority && current.seq < top.seq)) best = i
  }
  return requestQueue.splice(best, 1)[0]
}

function pump() {
  if (pumping) return
  pumping = true
  ;(async () => {
    try {
      for (;;) {
        if (requestQueue.length === 0) break
        if (inFlight >= MAX_IN_FLIGHT) {
          await sleep(30)
          continue
        }
        const item = takeNextRequest()
        const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastStartAt)
        if (wait > 0) await sleep(wait)
        lastStartAt = Date.now()
        inFlight += 1
        Promise.resolve()
          .then(() => item.task())
          .then(
            (value) => item.resolve(value),
            (error) => item.reject(error),
          )
          .finally(() => {
            inFlight -= 1
            pump()
          })
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
/** noteId → 正在进行的取正文 Promise（避免同一篇重复请求）。 */
const noteInflight = new Map()
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
  // 正文是静态的：是否过期由「列表里的 modify_time 变了没有」决定，
  // 不再靠时间 TTL 一刀切（旧做法 6 小时后把 70 篇全部重取，就是慢的主因）。
  return contentCache.get(noteId)
}

/** 首次用到正文时把磁盘缓存读回内存（过期条目直接丢，笔记列表也一起恢复）。 */
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
    contentCache.set(noteId, {
      content: entry.content,
      at,
      modified: typeof entry.modified === 'number' ? entry.modified : undefined,
    })
  }
  // 列表也落盘：重启后面板立即可用，预热只需补「变过的笔记」。
  const list = payload.list !== null && typeof payload.list === 'object' ? payload.list : null
  if (list !== null && Array.isArray(list.notes) && list.notes.length > 0) {
    const at = Number(list.at) || 0
    if (Date.now() - at < LIST_TTL_MS * 12) {
      notesCache = { at, notes: list.notes, truncated: Boolean(list.truncated) }
    }
  }
}

function writeDiskCache() {
  const file = cacheFile()
  if (file === '') return
  const notes = {}
  for (const [noteId, entry] of contentCache) {
    if (Date.now() - entry.at >= settings.contentTtlMs) continue
    notes[noteId] = {
      content: entry.content,
      at: entry.at,
      ...(typeof entry.modified === 'number' ? { modified: entry.modified } : {}),
    }
  }
  const list = notesCache === undefined
    ? null
    : { at: notesCache.at, truncated: notesCache.truncated === true, notes: notesCache.notes }
  const payload = JSON.stringify({
    version: DISK_CACHE_VERSION,
    baseUrl: settings.baseUrl,
    savedAt: Date.now(),
    notes,
    list,
  })
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
 * 从 ima 翻页取回完整的笔记列表并写缓存（不做「先用旧列表」的短路）。
 * ima 的 list_note 单页上限 20，`cursor` 是「已经取过的条数」的十进制字符串，
 * 响应里用 `is_end` 标记是否到底。只取第一页会静默丢掉后面的笔记，所以这里翻页。
 */
async function fetchAllNotes(priority = 0) {
  const notes = []
  let cursor = ''
  let fetched = 0
  let reachedEnd = false
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const data = await imaApi('openapi/note/v1/list_note', {
      cursor,
      limit: PAGE_SIZE,
      sort_type: 0,
    }, { priority })
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
  openNoteList = undefined
  return capped
}

/** 旧列表最长还能用多久（先用旧的、后台刷新，最多容忍一天）。 */
const LIST_STALE_SERVE_MS = 24 * 60 * 60 * 1000
/** 后台刷新进行中（避免同一时间刷多次）。 */
let refreshingNotes
/** 正在进行的「首次列表拉取」，让并发调用共用一次请求链。 */
let openNoteList

/**
 * 列出（标题过滤后的）全部笔记。
 *
 * 新鲜（5 分钟内）直接用；超过 5 分钟但不到一天：**先返回旧列表**，同时后台刷新 ——
 * 面板首屏不用再等 4 次列表请求（约 3 秒），新笔记会在后台刷新完成后出现。
 */
async function listNotes() {
  ensureDiskLoaded()
  const now = Date.now()
  if (notesCache !== undefined && now - notesCache.at < LIST_TTL_MS) return notesCache.notes
  if (notesCache !== undefined && now - notesCache.at < LIST_STALE_SERVE_MS) {
    if (refreshingNotes === undefined) {
      refreshingNotes = fetchAllNotes(1).catch(() => {}).finally(() => { refreshingNotes = undefined })
    }
    return notesCache.notes
  }
  if (openNoteList === undefined) {
    openNoteList = fetchAllNotes().finally(() => { openNoteList = undefined })
  }
  return openNoteList
}

// ── 笔记正文：取结构化格式再转成可读文本 ────────────────────────────────
/**
 * ima 的 `target_content_format: 0`（纯文本）会把段落边界压平 ——
 * 实测一篇 1708 字的「盘中记录」只剩 2 个换行，阅读器里全挤成一坨。
 * `format: 2` 返回的是结构化块（h1/h2/p/列表…），所以这里换用 2，
 * 再自己把块转成带换行的纯文本。
 * @param {string} raw - ima 返回的 content 字段（JSON 字符串）
 * @returns {string} 带段落换行的正文；解析失败返回空串
 */
function documentJsonToText(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return ''
  }
  const blocks = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.blocks)
      ? parsed.blocks
      : Array.isArray(parsed?.children)
        ? parsed.children
        : []
  if (blocks.length === 0) return ''

  /** 收集一个块或行内的全部文字（含嵌套 children）。 */
  const inlineText = (node) => {
    if (node === null || node === undefined) return ''
    if (typeof node === 'string') return node
    if (typeof node !== 'object') return ''
    let text = typeof node.text === 'string' ? node.text : ''
    if (Array.isArray(node.children)) text += node.children.map(inlineText).join('')
    return text
  }

  const out = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const type = String(block.type || '').toLowerCase()
    const text = inlineText(block).replace(/[ \t]+$/g, '')
    const headingMatch = /^h([1-6])$/.exec(type)
    if (headingMatch !== null) {
      out.push(`${'#'.repeat(Number(headingMatch[1]))} ${text.trim()}\n\n`)
      continue
    }
    if (type === 'p' || type === 'paragraph' || type === 'li' || type === 'list-item') {
      const bullet = typeof block.listStyleType === 'string' && block.listStyleType !== '' ? '- ' : ''
      out.push(`${bullet}${text}\n`)
      continue
    }
    if (type === 'img' || type === 'image' || type === 'imageblock' || type === 'video') {
      out.push('［图片］\n')
      continue
    }
    if (type === 'table') {
      // 表格没有统一结构：把行里的单元格文字用 | 串起来，至少能读。
      const rows = Array.isArray(block.children) ? block.children : []
      for (const row of rows) {
        const cells = Array.isArray(row?.children) ? row.children.map((cell) => inlineText(cell).trim()) : []
        if (cells.length > 0) out.push(`| ${cells.join(' | ')} |\n`)
      }
      continue
    }
    if (text !== '') out.push(`${text}\n`)
  }
  return out.join('').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 兜底重排：万一拿到的是「几乎没有换行」的正文（老格式或异常笔记），
 * 在日期 / 时间 / 发言人 / Markdown 标题前补换行，至少能分行阅读。
 */
function reflowFlatText(text) {
  if (text.length < 1200) return text
  const newlines = (text.match(/\n/g) || []).length
  if (newlines * 400 >= text.length) return text
  return text
    .replace(/(?<!^|\n)(?=(?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}|\d{1,2}:\d{2}|发言人\d|#{1,4} ))/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/**
 * 取一篇笔记的正文。
 * @param {string} noteId - 笔记 id。
 * @param {number} priority - 0 交互 / 1 后台预热。
 * @param {number} [modified] - 列表里的 modify_time；与缓存记录一致就不重取。
 */
async function noteContent(noteId, priority, modified) {
  ensureDiskLoaded()
  const cached = contentCache.get(noteId)
  if (cached !== undefined) {
    const unchanged = typeof modified === 'number' && cached.modified === modified
    const noStamp = typeof cached.modified !== 'number' && typeof modified !== 'number'
    if (unchanged || noStamp) return cached
  }
  // 同一篇正在取时复用那次请求：后台预热和用户点开同一篇不再打两次接口
  // （ima 有限流，重复请求会白占闸门额度）。
  const pending = noteInflight.get(noteId)
  if (pending !== undefined) return pending
  const task = fetchNoteContent(noteId, priority, modified)
  noteInflight.set(noteId, task)
  try {
    return await task
  } finally {
    if (noteInflight.get(noteId) === task) noteInflight.delete(noteId)
  }
}

/** 真正去 ima 取正文（含结构化失败时退回纯文本）。 */
async function fetchNoteContent(noteId, priority, modified) {
  const data = await imaApi('openapi/note/v1/get_doc_content', {
    note_id: noteId,
    target_content_format: 2,
  }, { priority: priority ?? 0 })
  const raw = typeof data?.content === 'string' ? data.content : ''
  let content = documentJsonToText(raw)
  if (content === '') {
    // 结构化解析失败（老笔记 / 返回形态变了）：退回纯文本，并做分行兜底。
    const plain = await imaApi('openapi/note/v1/get_doc_content', {
      note_id: noteId,
      target_content_format: 0,
    }, { priority: priority ?? 0 })
    content = typeof plain?.content === 'string' ? plain.content : ''
  }
  content = reflowFlatText(content.replace(/\r\n?/g, '\n'))
  const entry = {
    content,
    at: Date.now(),
    ...(typeof modified === 'number' ? { modified } : {}),
  }
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
 * 只把「缺正文或 modify_time 变过」的笔记取回（2 并发、低优先级，避免打断用户点击）。
 * 同一时刻只允许一个预热在跑，重复调用复用同一个 Promise。
 */
function warmAll() {
  if (warmPromise !== undefined) return warmPromise
  const run = (async () => {
    ensureDiskLoaded()
    const notes = await listNotes()
    const queue = notes.filter((note) => {
      const cached = contentCache.get(note.id)
      if (cached === undefined) return true
      const unchanged = typeof note.modified === 'number' && cached.modified === note.modified
      return unchanged === false
    })
    warmState.running = true
    warmState.total = queue.length
    warmState.done = 0
    warmState.failed = 0
    warmState.startedAt = Date.now()
    warmState.finishedAt = 0
    saveSuppressed += 1
    const failedIds = []
    try {
      let cursor = 0
      const worker = async () => {
        for (;;) {
          const index = cursor
          cursor += 1
          if (index >= queue.length) return
          const note = queue[index]
          try {
            await noteContent(note.id, 1, note.modified)
          } catch {
            // 单篇失败不拖垮整体：搜索时跳过它即可，进度里记失败数。
            warmState.failed += 1
            failedIds.push(note.id)
          }
          warmState.done += 1
        }
      }
      await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker))
      // 一轮结束后把失败的再补一次：撞限流退避之后常常能成功。
      let recovered = 0
      for (const noteId of failedIds) {
        const meta = notes.find((note) => note.id === noteId)
        try {
          await noteContent(noteId, 1, meta === undefined ? undefined : meta.modified)
          recovered += 1
        } catch {
          // 两次都失败就放弃，检索时按「跳过 N 篇」处理。
        }
      }
      if (recovered > 0) warmState.failed = Math.max(0, warmState.failed - recovered)
      // 顺手清掉「已经不在列表里」的笔记缓存（用户删了笔记 / 重建换了 id），
      // 否则磁盘缓存会一直带着这些孤儿条目。
      const liveIds = new Set(notes.map((note) => note.id))
      for (const noteId of Array.from(contentCache.keys())) {
        if (!liveIds.has(noteId)) contentCache.delete(noteId)
      }
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

/** 文件类型徽标：优先用 ima 的 media_type，其次按扩展名猜（Markdown 版知识库就是 .md）。 */
const KIND_LABELS = { markdown: 'Markdown', docx: 'Word', pdf: 'PDF', text: '文本', other: '文件' }

function fileTypeLabel(title, mediaType) {
  const known = MEDIA_TYPE_LABELS[mediaType]
  if (known !== undefined) return known
  return KIND_LABELS[inferFileKind(title, mediaType)] ?? '文件'
}

function normalizeKbItem(row) {
  if (row === null || typeof row !== 'object' || !row.media_id) return null
  const mediaType = Number(row.media_type) || 0
  const title = typeof row.title === 'string' && row.title !== '' ? row.title : String(row.media_id)
  return {
    mediaId: String(row.media_id),
    title,
    type: mediaType,
    typeLabel: fileTypeLabel(title, mediaType),
    folder: mediaType === 99,
    parentFolderId: typeof row.parent_folder_id === 'string' ? row.parent_folder_id : '',
    tags: Array.isArray(row.tags) ? row.tags : [],
  }
}

/** 列出当前凭证能看到的全部知识库（自动翻页）。 */
async function listKnowledgeBases() {
  if (kbListCache !== undefined && Date.now() - kbListCache.at < KB_LIST_TTL_MS) return kbListCache.items
  const fromDisk = diskKbList()
  if (fromDisk !== undefined) {
    const entry = kbDisk.list
    kbListCache = { at: Number(entry.at) || Date.now(), items: fromDisk }
    return fromDisk
  }
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
  saveKbList(items)
  return items
}

/** 这个 kb_id 是不是个人知识库（列表没缓存时先拉一次列表）。 */
async function isPersonalKbId(kbId) {
  const ids = personalKbIdSet()
  if (ids.size > 0) return ids.has(kbId)
  try {
    const kbs = await listKnowledgeBases()
    return kbs.some((kb) => kb.id === kbId && isPersonalKb(kb))
  } catch {
    return false
  }
}

/** 列出一个知识库的某个目录（folderId 空 = 根目录）。 */
async function listKbDirectory(kbId, folderId, cursor) {
  const dirKey = `${kbId}|${folderId}|${cursor}`
  const cached = kbDirCache.get(dirKey)
  if (cached !== undefined && Date.now() - cached.at < KB_DIR_TTL_MS) return cached.value
  // 个人知识库：命中本地快照就直接用，不再打接口（订阅/加入的库没有落盘，走不到这里）。
  const fromDisk = diskKbDir(kbId, folderId, cursor)
  if (fromDisk !== undefined) {
    kbDirCache.set(dirKey, { at: Date.now(), value: fromDisk })
    return fromDisk
  }
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
  if (await isPersonalKbId(kbId)) saveKbDir(kbId, folderId, cursor, value)
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
  kbTextCache.clear()
}

// ── 知识库文件阅读：把 md / docx 变成可读文本，PDF 交给浏览器内嵌查看 ──────
const KB_TEXT_TTL_MS = 10 * 60 * 1000
/** 单文件取回上限，避免把几百 MB 的东西拉进内存。 */
const KB_TEXT_MAX_BYTES = 24 * 1024 * 1024
/** 返回给面板的文本上限（阅读器只显示开头这一段，其余提示下载）。 */
const KB_TEXT_MAX_CHARS = 600000
const kbTextCache = new Map()

/** 按扩展名判断文件类型；扩展名认不出来时退回 ima 的 media_type。 */
function inferFileKind(title, mediaType) {
  const lower = String(title || '').toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.txt')) return 'text'
  if (mediaType === 1) return 'pdf'
  if (mediaType === 3) return 'docx'
  return 'other'
}

/** 解 XML 实体（docx 正文里常见）。 */
function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * 从 zip 里读出一个条目（docx 本质是 zip）。
 *
 * 走中央目录而不是顺序扫本地文件头：流式写入的 zip（通用位标记 bit 3）在本地头里
 * 把压缩大小写成 0，顺序扫会把 word/document.xml 读成空且不报错——面板里就是一篇
 * 空白 Word。中央目录里的长度永远是准的；找不到中央目录（截断包）时才退回顺序扫。
 * 只支持 store(0) / deflate(8) 两种压缩方式，够读 docx。
 * @returns {Buffer|undefined} 解压后的内容
 */
function readZipEntry(buffer, wantedName) {
  const { inflateRawSync } = zlib
  const inflate = (method, data) => {
    if (method === 0) return data
    if (method === 8) return inflateRawSync(data)
    return undefined
  }
  // End of Central Directory 签名 0x06054b50，注释最长 65535 字节。
  const eocdMin = 22
  const scanFrom = Math.max(0, buffer.length - eocdMin - 65535)
  let eocd = -1
  for (let offset = buffer.length - eocdMin; offset >= scanFrom; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd !== -1) {
    const count = buffer.readUInt16LE(eocd + 10)
    let offset = buffer.readUInt32LE(eocd + 16)
    for (let index = 0; index < count; index += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
      const flags = buffer.readUInt16LE(offset + 8)
      const method = buffer.readUInt16LE(offset + 10)
      const compressedSize = buffer.readUInt32LE(offset + 20)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const localOffset = buffer.readUInt32LE(offset + 42)
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
      if (name === wantedName) {
        if ((flags & 0x1) !== 0) return undefined // 加密条目读不了
        if (localOffset + 30 > buffer.length) return undefined
        const localNameLength = buffer.readUInt16LE(localOffset + 26)
        const localExtraLength = buffer.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLength + localExtraLength
        const dataEnd = dataStart + compressedSize
        if (dataEnd > buffer.length) return undefined
        return inflate(method, buffer.subarray(dataStart, dataEnd))
      }
      offset += 46 + nameLength + extraLength + commentLength
    }
  }
  // 兜底：没有中央目录（例如写到一半的包），顺序扫本地文件头。
  let offset = 0
  while (offset + 30 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== 0x04034b50) return undefined
    const method = buffer.readUInt16LE(offset + 8)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const nameStart = offset + 30
    const name = buffer.toString('utf8', nameStart, nameStart + nameLength)
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) return undefined
    if (name === wantedName) return inflate(method, buffer.subarray(dataStart, dataEnd))
    if (compressedSize === 0) return undefined // 本地头没写长度，顺序扫不下去了
    offset = dataEnd
  }
  return undefined
}

/** docx → 纯文本：段落换行、制表符保留，图片与样式丢弃。 */
function extractDocxText(buffer) {
  const xml = readZipEntry(buffer, 'word/document.xml')
  if (xml === undefined) return ''
  return decodeXmlEntities(
    xml
      .toString('utf8')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 取一个知识库文件的正文，供面板阅读器显示。
 * @returns {{kind: string, text: string, chars: number, truncated: boolean, inlineUrl: string}}
 */
async function kbFileText(mediaId, title) {
  const cached = kbTextCache.get(mediaId)
  if (cached !== undefined && Date.now() - cached.at < KB_TEXT_TTL_MS) return cached.value
  const fromDisk = diskKbText(mediaId)
  if (fromDisk !== undefined) {
    kbTextCache.set(mediaId, { at: Date.now(), value: fromDisk })
    return fromDisk
  }
  const info = await mediaInfo(mediaId)
  const kind = inferFileKind(title, info.mediaType)
  if (kind === 'pdf') {
    // PDF 不在这里解，浏览器自带查看器更靠谱：交给 inline 代理地址用 iframe 显示。
    const value = { kind, text: '', chars: 0, truncated: false, inlineUrl: `/ima-kb/api/kb-raw?media_id=${encodeURIComponent(mediaId)}&inline=1` }
    kbTextCache.set(mediaId, { at: Date.now(), value })
    return value
  }
  if (kind === 'other') {
    const value = { kind, text: '', chars: 0, truncated: false, inlineUrl: '' }
    kbTextCache.set(mediaId, { at: Date.now(), value })
    return value
  }
  if (info.url === '') throw new Error('这个文件没有可下载的原文')
  let response
  try {
    response = await fetch(info.url, { headers: info.headers, signal: AbortSignal.timeout(60000) })
  } catch (error) {
    throw new Error(`取文件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new Error(`取文件失败：HTTP ${response.status}`)
  // 先看响应头：几百 MB 的文件不该「先整个拉进内存再判断超限」。
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > KB_TEXT_MAX_BYTES) {
    throw new Error(`文件太大（${Math.round(declared / 1048576)} MB），请点「下载原文」`)
  }
  // 流式累计，超限立刻中断——服务端不给 content-length 时也守得住上限。
  const chunks = []
  let received = 0
  if (response.body !== null) {
    for await (const chunk of response.body) {
      received += chunk.length
      if (received > KB_TEXT_MAX_BYTES) {
        throw new Error(`文件太大（超过 ${Math.round(KB_TEXT_MAX_BYTES / 1048576)} MB），请点「下载原文」`)
      }
      chunks.push(Buffer.from(chunk))
    }
  } else {
    chunks.push(Buffer.from(await response.arrayBuffer()))
  }
  const buffer = Buffer.concat(chunks)
  let text = kind === 'docx' ? extractDocxText(buffer) : buffer.toString('utf8')
  if (kind === 'markdown') {
    // Markdown 里的图片在面板里显示不了，换成占位符，避免一串 ![](...) 干扰阅读。
    text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt) => (alt ? `［图片：${alt}］` : '［图片］'))
  }
  const truncated = text.length > KB_TEXT_MAX_CHARS
  const value = {
    kind,
    text: truncated ? text.slice(0, KB_TEXT_MAX_CHARS) : text,
    chars: text.length,
    truncated,
    inlineUrl: '',
  }
  kbTextCache.set(mediaId, { at: Date.now(), value })
  // 只有个人知识库的正文落盘；PDF / 未知类型不缓存（离线看重定向代理没有意义）。
  if (mediaInPersonalKb(mediaId)) saveKbText(mediaId, value)
  return value
}

// ── 个人知识库本地缓存（只缓存「我的知识库」） ──────────────────────────
/**
 * 落盘范围只有两类：**笔记正文**（上面的 content-*.json）和**个人知识库**
 * （base_type = 个人知识库）。订阅 / 加入的共享知识库（base_type = 我加入的订阅知识库）
 * 一律不写磁盘——那种库动辄几十万上百万文件，抓一遍要几小时，而且随时在变。
 *
 * 注意 ima 的 get_knowledge_list 不返回 modify_time，所以这里没有「增量」可言：
 * 是否过期只看 TTL（默认 7 天），过期后靠手动「更新」或重新预热再拉一遍。
 */
const KB_DISK_VERSION = 1

let kbDisk = null
let kbDiskLoaded = false
let kbDiskTimer
let kbSaveSuppressed = 0

/** 是不是「我的知识库」：ima 用 base_type 区分，role_type 兜底。 */
function isPersonalKb(item) {
  if (item === null || typeof item !== 'object') return false
  if (item.baseType === '个人知识库') return true
  const role = typeof item.role === 'string' ? item.role : ''
  return role.includes('创建者') || role.toLowerCase().includes('owner')
}

function kbCacheFile() {
  if (settings.cacheDir === '') return ''
  let clientId = ''
  try {
    clientId = credentialState().clientId
  } catch {
    clientId = ''
  }
  const key = createHash('sha256').update(settings.baseUrl + '|' + clientId).digest('hex').slice(0, 16)
  return join(settings.cacheDir, 'kb-' + key + '.json')
}

function emptyKbDisk() {
  return { version: KB_DISK_VERSION, baseUrl: settings.baseUrl, savedAt: 0, list: undefined, dirs: {}, texts: {}, snaps: {} }
}

function ensureKbDiskLoaded() {
  if (kbDiskLoaded) return
  kbDiskLoaded = true
  kbDisk = emptyKbDisk()
  const file = kbCacheFile()
  if (file === '') return
  let payload
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return
  }
  if (payload === null || typeof payload !== 'object') return
  if (payload.version !== KB_DISK_VERSION || payload.baseUrl !== settings.baseUrl) return
  kbDisk.savedAt = Number(payload.savedAt) || 0
  if (payload.list !== null && typeof payload.list === 'object') kbDisk.list = payload.list
  if (payload.dirs !== null && typeof payload.dirs === 'object') kbDisk.dirs = payload.dirs
  if (payload.texts !== null && typeof payload.texts === 'object') kbDisk.texts = payload.texts
  if (payload.snaps !== null && typeof payload.snaps === 'object') kbDisk.snaps = payload.snaps
}

function kbFresh(entry) {
  if (entry === null || typeof entry !== 'object') return false
  const at = Number(entry.at) || 0
  return at > 0 && Date.now() - at < settings.kbCacheTtlMs
}

function writeKbDisk() {
  const file = kbCacheFile()
  if (file === '') return
  const disk = kbDisk === null ? emptyKbDisk() : kbDisk
  const texts = {}
  for (const [mediaId, entry] of Object.entries(disk.texts ?? {})) {
    if (kbFresh(entry)) texts[mediaId] = entry
  }
  const dirs = {}
  for (const [kbId, folders] of Object.entries(disk.dirs ?? {})) {
    const kept = {}
    for (const [key, entry] of Object.entries(folders ?? {})) {
      if (kbFresh(entry)) kept[key] = entry
    }
    if (Object.keys(kept).length > 0) dirs[kbId] = kept
  }
  const payload = JSON.stringify({
    version: KB_DISK_VERSION,
    baseUrl: settings.baseUrl,
    savedAt: Date.now(),
    list: disk.list,
    dirs,
    texts,
    snaps: disk.snaps ?? {},
  })
  try {
    mkdirSync(settings.cacheDir, { recursive: true })
    const temp = file + '.tmp-' + process.pid
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, file)
    if (kbDisk !== null) {
      kbDisk.dirs = dirs
      kbDisk.texts = texts
      kbDisk.savedAt = Date.now()
    }
  } catch {
    try {
      rmSync(file + '.tmp-' + process.pid, { force: true })
    } catch {
      // 写缓存失败不影响在线读取。
    }
  }
}

function scheduleKbSave() {
  if (settings.cacheDir === '') return
  if (kbSaveSuppressed > 0) return
  if (kbDiskTimer !== undefined) return
  kbDiskTimer = setTimeout(() => {
    kbDiskTimer = undefined
    writeKbDisk()
  }, 4000)
  if (typeof kbDiskTimer.unref === 'function') kbDiskTimer.unref()
}

function flushKbSave() {
  if (kbDiskTimer !== undefined) {
    clearTimeout(kbDiskTimer)
    kbDiskTimer = undefined
  }
  writeKbDisk()
}

function resetKbDisk() {
  if (kbDiskTimer !== undefined) {
    clearTimeout(kbDiskTimer)
    kbDiskTimer = undefined
  }
  kbDisk = null
  kbDiskLoaded = false
}

/** 知识库列表也落盘：重启后 /kb 直接有内容，不用先打一次接口。 */
function saveKbList(items) {
  ensureKbDiskLoaded()
  if (kbDisk === null) return
  kbDisk.list = { at: Date.now(), items }
  scheduleKbSave()
}

function diskKbList() {
  ensureKbDiskLoaded()
  const entry = kbDisk === null ? undefined : kbDisk.list
  if (!kbFresh(entry)) return undefined
  return Array.isArray(entry.items) ? entry.items : undefined
}

function kbDirKeyOf(folderId, cursor) {
  return String(cursor ?? '') + '|' + String(folderId ?? '')
}

function saveKbDir(kbId, folderId, cursor, value) {
  ensureKbDiskLoaded()
  if (kbDisk === null) return
  const folders = kbDisk.dirs[kbId] ?? {}
  folders[kbDirKeyOf(folderId, cursor)] = { at: Date.now(), value }
  kbDisk.dirs[kbId] = folders
  scheduleKbSave()
}

function diskKbDir(kbId, folderId, cursor) {
  ensureKbDiskLoaded()
  const folders = kbDisk === null ? undefined : kbDisk.dirs[kbId]
  if (folders === undefined) return undefined
  const entry = folders[kbDirKeyOf(folderId, cursor)]
  if (!kbFresh(entry)) return undefined
  return entry.value
}

function saveKbText(mediaId, value) {
  ensureKbDiskLoaded()
  if (kbDisk === null) return
  kbDisk.texts[mediaId] = { at: Date.now(), value }
  scheduleKbSave()
}

function diskKbText(mediaId) {
  ensureKbDiskLoaded()
  const entry = kbDisk === null ? undefined : kbDisk.texts[mediaId]
  if (!kbFresh(entry)) return undefined
  return entry.value
}

/** 当前能判定为「个人知识库」的 id 集合（内存列表优先，其次磁盘快照）。 */
function personalKbIdSet() {
  const ids = new Set()
  const source = (kbListCache !== undefined && Array.isArray(kbListCache.items) ? kbListCache.items : undefined)
    ?? (kbDisk !== null && kbDisk.list !== null && Array.isArray(kbDisk.list.items) ? kbDisk.list.items : [])
  for (const kb of source) {
    if (isPersonalKb(kb)) ids.add(kb.id)
  }
  return ids
}

/** 这个文件是不是挂在某个个人知识库下（决定正文要不要落盘）。 */
function mediaInPersonalKb(mediaId) {
  ensureKbDiskLoaded()
  const ids = personalKbIdSet()
  if (ids.size === 0) return false
  const has = (items) => Array.isArray(items) && items.some((item) => item.mediaId === mediaId)
  for (const kbId of ids) {
    const folders = kbDisk === null ? undefined : kbDisk.dirs[kbId]
    if (folders === undefined) continue
    for (const entry of Object.values(folders)) {
      const items = entry !== null && typeof entry === 'object' && entry.value !== null && typeof entry.value === 'object' ? entry.value.items : undefined
      if (has(items)) return true
    }
  }
  for (const [dirKey, entry] of kbDirCache) {
    if (!ids.has(dirKey.split('|')[0])) continue
    const items = entry !== null && typeof entry === 'object' && entry.value !== null && typeof entry.value === 'object' ? entry.value.items : undefined
    if (has(items)) return true
  }
  return false
}

/** 预热进度：面板用它显示「正在缓存目录 / 正文」。 */
const kbWarmState = { running: false, kbId: '', kbName: '', stage: '', total: 0, done: 0, failed: 0, folderCount: 0, fileCount: 0, startedAt: 0, finishedAt: 0 }
let kbWarmPromise

function kbWarmSnapshot() {
  return { ...kbWarmState }
}

function resetKbWarmState() {
  Object.assign(kbWarmState, { running: false, kbId: '', kbName: '', stage: '', total: 0, done: 0, failed: 0, folderCount: 0, fileCount: 0, startedAt: 0, finishedAt: 0 })
}

/**
 * 把一个个人知识库整棵缓存下来：先逐层翻页拉目录，再（默认）把 md/docx/txt 的正文取回。
 * 订阅 / 加入的库直接拒绝——它们仍然按原来的方式在线读。
 */
function warmPersonalKb(kbId) {
  if (kbWarmPromise !== undefined) return kbWarmPromise
  const run = (async () => {
    const kbs = await listKnowledgeBases()
    const kb = kbs.find((item) => item.id === kbId)
    if (kb === undefined) throw new Error('没有 kb_id=' + kbId + ' 的知识库，先用 kb_space_list 看 id')
    if (!isPersonalKb(kb)) {
      throw new Error('「' + kb.name + '」不是个人知识库：订阅 / 加入的共享知识库不做本地缓存，仍按原来的方式在线读取。')
    }
    Object.assign(kbWarmState, {
      running: true, kbId, kbName: kb.name, stage: 'list',
      total: 0, done: 0, failed: 0, folderCount: 0, fileCount: 0, startedAt: Date.now(), finishedAt: 0,
    })
    ensureKbDiskLoaded()
    kbSaveSuppressed += 1
    const folderQueue = ['']
    const files = []
    let cachedTexts = 0
    let failed = 0
    try {
      while (folderQueue.length > 0) {
        const folderId = folderQueue.shift()
        let cursor = ''
        for (;;) {
          const dir = await listKbDirectory(kbId, folderId, cursor)
          kbWarmState.folderCount += 1
          for (const item of dir.items) {
            if (item.folder) folderQueue.push(item.mediaId)
            else files.push(item)
          }
          kbWarmState.fileCount = files.length
          if (dir.isEnd === true || dir.nextCursor === '') break
          cursor = dir.nextCursor
        }
      }
      const textTargets = settings.kbCacheText === 'on'
        ? files.filter((item) => {
          const kind = inferFileKind(item.title, item.type)
          return kind === 'markdown' || kind === 'docx' || kind === 'text'
        }).slice(0, settings.kbCacheMaxFiles)
        : []
      kbWarmState.stage = textTargets.length > 0 ? 'text' : 'done'
      kbWarmState.total = textTargets.length
      kbWarmState.done = 0
      for (const item of textTargets) {
        try {
          const value = await kbFileText(item.mediaId, item.title)
          saveKbText(item.mediaId, value)
          cachedTexts += 1
        } catch {
          failed += 1
        }
        kbWarmState.done += 1
      }
      kbWarmState.failed = failed
      if (kbDisk !== null) {
        kbDisk.snaps = kbDisk.snaps ?? {}
        kbDisk.snaps[kbId] = { at: Date.now(), folders: kbWarmState.folderCount, files: files.length, texts: cachedTexts }
      }
      let bytes = 0
      const cachePath = kbCacheFile()
      if (cachePath !== '') {
        try {
          bytes = statSync(cachePath).size
        } catch {
          bytes = 0
        }
      }
      return { kbId, name: kb.name, folders: kbWarmState.folderCount, files: files.length, texts: cachedTexts, failed, bytes }
    } finally {
      kbSaveSuppressed -= 1
      flushKbSave()
      kbWarmState.running = false
      kbWarmState.finishedAt = Date.now()
      kbWarmState.stage = 'done'
    }
  })()
  kbWarmPromise = run
  run.then(
    () => { if (kbWarmPromise === run) kbWarmPromise = undefined },
    () => { if (kbWarmPromise === run) kbWarmPromise = undefined },
  )
  return run
}

/** 缓存状态：给面板和 /kb-cache 用。 */
function kbCacheStatus() {
  ensureKbDiskLoaded()
  const file = kbCacheFile()
  let bytes = 0
  if (file !== '') {
    try {
      bytes = statSync(file).size
    } catch {
      bytes = 0
    }
  }
  const source = (kbListCache !== undefined && Array.isArray(kbListCache.items) ? kbListCache.items : undefined)
    ?? (kbDisk !== null && kbDisk.list !== null && Array.isArray(kbDisk.list.items) ? kbDisk.list.items : [])
  const snaps = kbDisk === null ? {} : (kbDisk.snaps ?? {})
  return {
    enabled: settings.cacheDir !== '',
    ttlMinutes: Math.round(settings.kbCacheTtlMs / 60000),
    textMode: settings.kbCacheText,
    maxFiles: settings.kbCacheMaxFiles,
    file,
    bytes,
    savedAt: kbDisk === null ? 0 : kbDisk.savedAt,
    warm: kbWarmSnapshot(),
    kbs: source.map((kb) => {
      const snap = snaps[kb.id] !== null && typeof snaps[kb.id] === 'object' ? snaps[kb.id] : undefined
      const folders = kbDisk === null ? undefined : kbDisk.dirs[kb.id]
      let dirs = 0
      if (folders !== undefined) {
        for (const entry of Object.values(folders)) {
          if (kbFresh(entry)) dirs += 1
        }
      }
      return {
        id: kb.id,
        name: kb.name,
        personal: isPersonalKb(kb),
        dirs,
        snapshotAt: snap === undefined ? 0 : (Number(snap.at) || 0),
        folders: snap === undefined ? 0 : (Number(snap.folders) || 0),
        files: snap === undefined ? 0 : (Number(snap.files) || 0),
        texts: snap === undefined ? 0 : (Number(snap.texts) || 0),
      }
    }),
  }
}

/** 清空本地缓存：内存 + 磁盘。只作用于缓存文件，不碰 ima 上的任何数据。 */
function clearKbCache() {
  resetKbDisk()
  const file = kbCacheFile()
  if (file !== '') {
    try {
      rmSync(file, { force: true })
    } catch {
      // 删不掉就算了，内存已经清了。
    }
  }
  kbDirCache.clear()
  kbTextCache.clear()
  resetKbWarmState()
}

// ── 笔记官方检索（分词召回，弥补本地字面检索「换一种说法就搜不到」） ──
/** search_note 每页上限。 */
const FIND_PAGE_SIZE = 20
/** 最多翻到第几页（20 条/页）。 */
const FIND_MAX_PAGES = 10

/**
 * 用 ima 官方 search_note 做内容检索：服务端分词召回，不要求原文逐字一致，
 * 所以「亏了怎么办」也可能找到「止损」。每篇只回一段摘要，拿到 note_id 后用
 * kb_read 读正文。短词（如单个双字词）偶尔被服务端拒绝（code!=0），此时原样
 * 抛出错误，由调用方给用户提示。
 */
async function findNotes(query, options) {
  const q = String(query ?? '').trim()
  if (q === '') return { total: 0, items: [], more: false }
  const start = clamp(options?.start ?? 0, 0, FIND_MAX_PAGES * FIND_PAGE_SIZE)
  const end = clamp(options?.end ?? FIND_PAGE_SIZE, start + 1, start + FIND_PAGE_SIZE)
  const data = await imaApi('openapi/note/v1/search_note', {
    search_type: 1,
    query_info: { content: q },
    start,
    end,
  })
  const rows = Array.isArray(data?.search_note_infos) ? data.search_note_infos : []
  const items = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const info = row.note_book_info
    if (info === null || typeof info !== 'object' || !info.note_id) continue
    items.push({
      noteId: String(info.note_id),
      title: typeof info.title === 'string' && info.title !== '' ? info.title : String(info.note_id),
      preview: typeof info.summary === 'string' ? info.summary.replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    })
  }
  const total = Number(data?.total_hit_num) || items.length
  return {
    total,
    items,
    more: data?.is_end === false,
  }
}

/**
 * 笔记 ↔ 知识库文件互跳：拿笔记标题去「我自己的」知识库里按文件名检索。
 * 笔记和知识库文档是同一批材料的两份入口，标题基本一致，所以按标题就能对上。
 * @returns {{kbId: string, kbName: string, item: object}|null}
 */
async function findKbFileForTitle(title) {
  const wanted = String(title ?? '').trim()
  if (wanted === '') return null
  const kbs = await listKnowledgeBases()
  if (kbs.length === 0) return null
  const mine = kbs.filter((kb) => kb.role.includes('创建') || kb.role.toLowerCase().includes('owner'))
  const targets = mine.length > 0 ? mine : kbs.slice(0, 2)
  const query = wanted.replace(/\s+/g, ' ').slice(0, 60)
  for (const kb of targets) {
    try {
      const items = await searchKbFiles(kb.id, query)
      if (items.length === 0) continue
      const clean = (value) => String(value || '').replace(/\.(md|markdown|docx|pdf|txt)$/i, '').replace(/\s+/g, '').trim()
      const best = items.find((item) => !item.folder && clean(item.title) === clean(wanted))
        ?? items.find((item) => !item.folder)
        ?? items[0]
      return { kbId: kb.id, kbName: kb.name, item: best }
    } catch {
      // 这个知识库查不了就换下一个。
    }
  }
  return null
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
      // 全量列表压成「一行一篇」：70 篇的旧格式要 200 多行、白占上下文；
      // 只有按关键词过滤（结果变少）时才附带开头预览。
      const verbose = want !== '' || shown.length <= 12
      const lines = [
        `共 ${shown.length} 篇笔记${want !== '' ? `（标题含「${want}」；全库 ${notes.length} 篇）` : ''}${truncated ? `（已达到 maxNotes=${settings.maxNotes} 上限，可能还有更多）` : ''}：`,
        '',
      ]
      for (const note of shown) {
        const chars = cachedChars(note.id)
        const size = chars === null ? '' : ` · ${formatCount(chars)} 字`
        lines.push(`- ${note.title}${size} · id=${note.id}`)
        if (verbose && note.preview !== '') lines.push(`  开头：${note.preview}`)
      }
      lines.push('', '用 kb_find / kb_search 检索，用 kb_read(note_id, offset) 读正文。')
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
      const meta = await noteMeta(noteId)
      const cached = await noteContent(noteId, 0, meta.modified)
      const content = cached.content
      if (content === '') return `笔记 ${noteId} 是空的。`
      const total = content.length
      const offset = clamp(args?.offset ?? 0, 0, total)
      if (offset >= total) {
        return `offset=${offset} 已超出笔记长度（共 ${formatCount(total)} 字）。从 0 开始或用 kb_search 定位。`
      }
      const end = Math.min(total, offset + limit)
      const header = `[${meta.title} · 字符 ${formatCount(offset)}–${formatCount(end)} / 共 ${formatCount(total)}]`
      const footer =
        end >= total
          ? '[已到笔记末尾]'
          : `[还有 ${formatCount(total - end)} 字未读，下一段 offset=${end}]`
      return `${header}\n\n${content.slice(offset, end)}\n\n${footer}`
    },
  })

  // ── 官方检索：分词召回，换个说法也能找到 ──
  registerTool(ctx, {
    name: 'kb_find',
    description:
      '在用户私有 ima 笔记里做官方全文检索（服务端分词召回，不要求逐字一致，换一种说法也可能找到），'
      + '返回命中的笔记列表（note_id、标题、开头预览、总命中数）。每篇只回一条摘要，'
      + '拿到 note_id 后用 kb_read(note_id, 0) 读该篇正文。'
      + '只在用户明确要求查看或检索自己的知识库时使用；用户没有要求时不要主动调用。'
      + '与 kb_search 的分工：要精确词句与多处命中用 kb_search（本地字面匹配、带偏移量）；'
      + '不确定原文措辞时先用 kb_find 找候选篇。',
    parameters: {
      query: { type: 'string', required: true, description: '要查的话题或问题，用自然语言描述也可以。' },
      start: { type: 'number', description: '从第几条开始（0 起），用于翻页；默认 0。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const q = typeof args?.query === 'string' ? args.query.trim() : ''
      if (q === '') return 'query 不能为空。'
      const start = clamp(args?.start ?? 0, 0, FIND_MAX_PAGES * FIND_PAGE_SIZE)
      let result
      try {
        result = await findNotes(q, { start, end: start + FIND_PAGE_SIZE })
      } catch (error) {
        return `ima 官方检索没成功（${error instanceof Error ? error.message : String(error)}）。\n`
          + '短词常被服务端拒绝：换更完整的关键词，或改用 kb_search 做字面检索。'
      }
      if (result.items.length === 0) {
        return `官方检索没有命中「${q}」。\n`
          + '试试：换别的措辞；或改用 kb_search 精确检索；或 kb_list 看全部笔记标题。'
      }
      const lines = [
        `官方检索「${q}」命中 ${formatCount(result.total)} 篇${result.more ? '（还有更多，用 kb_find(query, start=' + (start + FIND_PAGE_SIZE) + ') 翻页）' : ''}：`,
        '',
      ]
      for (const item of result.items) {
        lines.push(`- ${item.title}`)
        lines.push(`  note_id: ${item.noteId}`)
        if (item.preview !== '') lines.push(`  开头：${item.preview}`)
      }
      lines.push('', '读取某一篇：kb_read(note_id=<上面的 id>, offset=0)。')
      return lines.join('\n')
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
      cursor: { type: 'string', description: '翻页游标：上一页输出里给的 cursor；不填表示第一页。' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const kbId = typeof args?.kb_id === 'string' ? args.kb_id.trim() : ''
      if (kbId === '') return 'kb_id 不能为空。先用 kb_space_list 看有哪些知识库。'
      const folderId = typeof args?.folder_id === 'string' ? args.folder_id.trim() : ''
      const cursor = typeof args?.cursor === 'string' ? args.cursor.trim() : ''
      const limit = clamp(args?.limit ?? 50, 1, 50)
      const dir = await listKbDirectory(kbId, folderId, cursor)
      const shown = dir.items.slice(0, limit)
      const path = dir.path.map((node) => node.name).join(' / ') || '根目录'
      if (shown.length === 0) return `「${path}」是空的。`
      const folders = shown.filter((item) => item.folder)
      const files = shown.filter((item) => !item.folder)
      const page = cursor === '' ? '第 1 页' : '下一页'
      const more = dir.isEnd ? '已到末页' : '还有更多'
      const lines = [`${path} · 本页 ${shown.length} 条（文件夹 ${folders.length} 个，文件 ${files.length} 个；${page}，${more}）`, '']
      for (const item of folders) {
        lines.push(`- [文件夹] ${item.title}`)
        lines.push(`  media_id: ${item.mediaId}`)
      }
      for (const item of files) {
        lines.push(`- [${item.typeLabel}] ${item.title}`)
        lines.push(`  media_id: ${item.mediaId}`)
      }
      lines.push('', '进子文件夹：kb_space_browse(kb_id, folder_id=<文件夹的 media_id>)。')
      if (dir.isEnd === false && dir.nextCursor !== '') {
        lines.push(`列出下一页：kb_space_browse(kb_id, folder_id=${folderId === '' ? '（省略）' : folderId}, cursor="${dir.nextCursor}")`)
      }
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
        const meta = await noteMeta(noteId)
        const cached = await noteContent(noteId, 0, meta.modified)
        const total = cached.content.length
        const start = clamp(url.searchParams.get('start') ?? 0, 0, total)
        const end = Math.min(total, start + limit)
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
      if (route === 'find') {
        const q = (url.searchParams.get('q') ?? '').trim()
        if (q === '') {
          sendJson(res, 200, { total: 0, items: [], more: false })
          return
        }
        const start = clamp(url.searchParams.get('start') ?? 0, 0, FIND_MAX_PAGES * FIND_PAGE_SIZE)
        try {
          sendJson(res, 200, await findNotes(q, { start, end: start + FIND_PAGE_SIZE }))
        } catch (error) {
          sendJson(res, 200, {
            total: 0, items: [], more: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
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
      // 个人知识库本地缓存：状态 / 预热 / 清空
      if (route === 'kb-cache') {
        if (url.searchParams.get('clear') === '1') clearKbCache()
        sendJson(res, 200, kbCacheStatus())
        return
      }
      if (route === 'kb-warm') {
        const kbId = url.searchParams.get('kb') ?? ''
        if (kbId === '') {
          sendJson(res, 400, { error: 'missing kb' })
          return
        }
        try {
          sendJson(res, 200, await warmPersonalKb(kbId))
        } catch (error) {
          sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      if (route === 'kb-warm-status') {
        sendJson(res, 200, kbWarmSnapshot())
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
      if (route === 'kb-link') {
        const title = (url.searchParams.get('title') ?? '').trim()
        if (title === '') {
          sendJson(res, 200, { found: false })
          return
        }
        const match = await findKbFileForTitle(title)
        if (match === null) {
          sendJson(res, 200, { found: false })
          return
        }
        sendJson(res, 200, { found: true, kbId: match.kbId, kbName: match.kbName, item: match.item })
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
        const title = url.searchParams.get('title') ?? ''
        if (mediaId === '') {
          sendJson(res, 400, { error: 'missing media_id' })
          return
        }
        const info = await mediaInfo(mediaId)
        const kind = inferFileKind(title, info.mediaType)
        sendJson(res, 200, {
          mediaId,
          type: info.mediaType,
          typeLabel: fileTypeLabel(title, info.mediaType),
          kind,
          readable: kind === 'markdown' || kind === 'docx' || kind === 'pdf' || kind === 'text',
          downloadable: info.url !== '',
        })
        return
      }
      if (route === 'kb-text') {
        const mediaId = url.searchParams.get('media_id') ?? ''
        const title = url.searchParams.get('title') ?? ''
        if (mediaId === '') {
          sendJson(res, 400, { error: 'missing media_id' })
          return
        }
        try {
          sendJson(res, 200, await kbFileText(mediaId, title))
        } catch (error) {
          sendJson(res, 200, {
            kind: 'error',
            text: '',
            chars: 0,
            truncated: false,
            inlineUrl: '',
            error: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }
      if (route === 'kb-raw') {
        const mediaId = url.searchParams.get('media_id') ?? ''
        const inline = url.searchParams.get('inline') === '1'
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
          // 透传 Range：面板里 PDF 走 iframe，没有它就不能拖进度条 / 跳页。
          const rangeHeader = req.headers.range
          const upstream = await fetch(info.url, {
            headers: rangeHeader === undefined ? info.headers : { ...info.headers, range: rangeHeader },
          })
          if (!upstream.ok || upstream.body === null) {
            sendJson(res, 502, { error: `upstream ${upstream.status}` })
            return
          }
          const title = url.searchParams.get('title') ?? 'file'
          const headers = {
            'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
            'cache-control': 'no-store',
            'accept-ranges': 'bytes',
          }
          const contentRange = upstream.headers.get('content-range')
          if (contentRange !== null) headers['content-range'] = contentRange
          const contentLength = upstream.headers.get('content-length')
          if (contentLength !== null) headers['content-length'] = contentLength
          // inline=1 用于面板里 iframe 直接看 PDF；否则按下载处理。
          if (!inline) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(title)}`
          res.writeHead(upstream.status, headers)
          for await (const chunk of upstream.body) {
            // 尊重写背压：几百 MB 的文件不能一直往内存里堆。
            if (!res.write(chunk)) {
              await new Promise((resolve) => {
                res.once('drain', resolve)
              })
            }
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
  try {
    installBundledSkills()
  } catch {
    // 技能安装是附加功能，失败不影响面板与工具。
  }
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
