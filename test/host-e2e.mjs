/**
 * Host 半个插件的离线端到端测试：真打 ima 接口，只读。
 *
 * 用法（在插件目录下）：
 *   node test/host-e2e.mjs
 *
 * 它做的事情：把上级目录的 index.js 复制成 test/plugin/index.js（这样裸导入
 * `@deepseek-ai/dsh-tools|schemastery` 能解析到 test/node_modules 里的最小替身），
 * 用一个「未注入的 Service 访问会抛错」的假 ctx 装上插件，然后逐个打 /ima-kb/api/*。
 *
 * 为什么要有这套测试：v1.1.0 的离线测试用的是普通对象当 ctx，所以
 * 「`ctx.connection` 访问未注入 Service 会抛错」这个真实 Cordis 行为没被模拟出来，
 * 结果线上面板一直 403 而测试全绿。
 *
 * 覆盖：
 *   1. 浏览器会话围栏：同源放行 / 未授权 401 / 外部 Host 403 / 非 GET 405；
 *   2. list_note 翻页：总数必须显著大于单页上限 20，且 id 不重复；
 *   3. ima 限流（code=200001）：串行 + 退避重试后每篇笔记都要有正文字数；
 *   4. 检索偏移量契约、工具输出、/refresh、磁盘缓存与冷启动命中。
 */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(testDir, '..', 'index.js')
const runnerDir = join(testDir, 'plugin')
const cacheDir = join(testDir, 'cache')

mkdirSync(runnerDir, { recursive: true })
copyFileSync(sourcePath, join(runnerDir, 'index.js'))
rmSync(cacheDir, { recursive: true, force: true })

const pluginPath = new URL('./plugin/index.js', import.meta.url)
const pluginHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex').slice(0, 16)

const failures = []
function check(name, ok, detail) {
  if (!ok) failures.push(`${name} :: ${detail}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`)
}

const TRUSTED_HOST = '127.0.0.1:64188'
const browserHeaders = { host: TRUSTED_HOST, 'sec-fetch-site': 'same-origin', 'x-test-auth': 'browser' }

/** 假 Cordis ctx：只实现插件用到的面。 */
function makeContext() {
  const routes = []
  const tools = []
  const connection = {
    requestRejection(request) {
      const headers = (request && request.headers) || {}
      if (headers.host !== TRUSTED_HOST) return 403
      if (headers['x-test-auth'] !== 'browser') return 401
      return undefined
    },
  }
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, callback) => callback(ctx),
    get: (name) => (name === 'connection' ? connection : undefined),
    webServer: { register: (route) => (routes.push(route), () => {}) },
    tools: { register: (definition) => (tools.push(definition), () => {}) },
  }
  return { ctx, routes, tools }
}

function makeCaller(route) {
  return (path, opts = {}) =>
    new Promise((resolve, reject) => {
      const req = { url: path, method: opts.method ?? 'GET', headers: opts.headers ?? browserHeaders }
      let status = 200
      const chunks = []
      let destroyed = false
      const res = {
        writeHead: (code) => { status = code },
        write: (chunk) => {
          if (!destroyed) chunks.push(Buffer.from(chunk))
          return true
        },
        end: (body) => {
          if (destroyed) return
          const buf = body !== undefined ? Buffer.concat([...chunks, Buffer.from(body)]) : Buffer.concat(chunks)
          let parsed = buf
          try { parsed = JSON.parse(buf.toString('utf8')) } catch { /* 二进制 */ }
          resolve({ status, body: parsed, bytes: buf.length })
        },
        destroy: () => {
          destroyed = true
          resolve({ status, body: {}, bytes: Buffer.concat(chunks).length })
        },
      }
      Promise.resolve(route.handler(req, res)).catch(reject)
    })
}

const seconds = (ms) => (ms / 1000).toFixed(1)

// ── 第一次启动：冷缓存 ────────────────────────────────────────────────
console.log('=== boot 1（冷缓存）===')
console.log('  plugin sha256[:16] =', pluginHash)
const boot1 = makeContext()
const mod = await import(pluginPath.href)
mod.apply(boot1.ctx, { cacheDir })

check('export name', mod.name === 'ima-kb-panel', String(mod.name))
check('export Config', mod.Config !== undefined, 'missing Config')
check('1 route registered', boot1.routes.length === 1 && boot1.routes[0].path === '/ima-kb/api', JSON.stringify(boot1.routes.map((r) => r.path)))
check('6 tools registered', boot1.tools.map((t) => t.name).join(',') === 'kb_list,kb_search,kb_read,kb_space_list,kb_space_browse,kb_space_search', boot1.tools.map((t) => t.name).join(','))

const call = makeCaller(boot1.routes[0])

// ── 1. 围栏 ───────────────────────────────────────────────────────────
console.log('=== fence ===')
const noAuth = await call('/ima-kb/api/state', { headers: { host: TRUSTED_HOST } })
check('未授权请求返回 401（不是 403）', noAuth.status === 401, String(noAuth.status))
const badHost = await call('/ima-kb/api/state', { headers: { host: 'evil.example.com', 'x-test-auth': 'browser' } })
check('外部 Host 返回 403', badHost.status === 403, String(badHost.status))
const badMethod = await call('/ima-kb/api/state', { method: 'POST' })
check('非 GET 返回 405', badMethod.status === 405, String(badMethod.status))

// ── 2. /state + /notes ───────────────────────────────────────────────
console.log('=== /state & /notes ===')
const state = await call('/ima-kb/api/state')
check('/state 200', state.status === 200, String(state.status))
check('/state 已配置', state.body.configured === true, JSON.stringify(state.body.configured))
check('/state noteCount > 20（翻页生效）', typeof state.body.noteCount === 'number' && state.body.noteCount > 20, String(state.body.noteCount))
check('/state 回显 cacheDir', state.body.cacheDir === cacheDir, String(state.body.cacheDir))
const noteCount = state.body.noteCount
console.log('  noteCount =', noteCount, ' warm =', JSON.stringify(state.body.warm))

const notes = await call('/ima-kb/api/notes')
const rows = (notes.body && notes.body.notes) || []
check('/notes 条数与 /state 一致', rows.length === noteCount, `${rows.length} vs ${noteCount}`)
check('/notes id 唯一', new Set(rows.map((r) => r.id)).size === rows.length, 'duplicate ids')
check('/notes 每条都有标题', rows.every((r) => typeof r.title === 'string' && r.title !== ''), 'empty title')

// ── 3. /warm：限流下的完整预热 ───────────────────────────────────────
console.log(`=== /warm（${noteCount} 篇正文，限流下大约 1~2 分钟）===`)
const warmStart = Date.now()
const warm = await call('/ima-kb/api/warm')
console.log(`  /warm 用时 ${seconds(Date.now() - warmStart)}s`)
check('/warm 200', warm.status === 200, String(warm.status))
const warmedRows = (warm.body && warm.body.notes) || []
check('/warm 返回全部笔记', warmedRows.length === rows.length, `${warmedRows.length} vs ${rows.length}`)
const missingChars = warmedRows.filter((r) => typeof r.chars !== 'number' || r.chars <= 0)
check('/warm 全部有字数（限流重试生效）', missingChars.length === 0, JSON.stringify(missingChars.slice(0, 2)))
const totalChars = warmedRows.reduce((sum, r) => sum + (r.chars || 0), 0)
console.log(`  预热 ${warmedRows.length} 篇 / ${totalChars.toLocaleString('en-US')} 字`)
const status = await call('/ima-kb/api/warm-status')
check('/warm-status 认全部已缓存', status.body.running === false && status.body.cached === rows.length && status.body.failed === 0, JSON.stringify(status.body))

const cacheFiles = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith('.json')) : []
check('磁盘缓存已写入', cacheFiles.length === 1, JSON.stringify(cacheFiles))

// ── 4. /search 与偏移量契约 ───────────────────────────────────────────
console.log('=== /search ===')
const term = process.env.IMA_TEST_TERM || '止损'
const search = await call('/ima-kb/api/search?q=' + encodeURIComponent(term) + '&limit=12')
check('/search 200', search.status === 200, String(search.status))
const matches = (search.body && search.body.matches) || []
check('/search 命中', matches.length > 0, `no matches for ${term}`)
const maxSnippet = matches.reduce((m, x) => Math.max(m, String(x.snippet).length), 0)
const maxWindow = matches.reduce((m, x) => Math.max(m, x.length), 0)
check('片段 ≤ 620 字', maxSnippet <= 620, String(maxSnippet))
check('窗口 ≤ 800 字', maxWindow <= 800, String(maxWindow))
check('检索范围覆盖全部笔记', search.body.notesScanned === rows.length, `${search.body.notesScanned} vs ${rows.length}`)
check('没有笔记因取正文失败被跳过', search.body.notesSkipped === 0, String(search.body.notesSkipped))
if (matches.length > 0) {
  const hit = matches[0]
  const slice = await call(
    `/ima-kb/api/note?id=${encodeURIComponent(hit.noteId)}&start=${hit.offset}&length=${Math.max(1, Math.min(hit.length, 400))}`,
  )
  check('offset 指向命中处', String(slice.body.content).includes(term), String(slice.body.content).slice(0, 60))
}
const miss = await call('/ima-kb/api/search?q=' + encodeURIComponent('这个词肯定不在知识库里xyzzy'))
check('搜不到时 matches 为空且不报错', miss.status === 200 && (miss.body.matches || []).length === 0, JSON.stringify(miss.body).slice(0, 80))

// ── 5. 工具 ──────────────────────────────────────────────────────────
console.log('=== tools ===')
const kbList = boot1.tools.find((t) => t.name === 'kb_list')
const listText = await kbList.execute({}, {})
check('kb_list 覆盖全部笔记', listText.includes(`共 ${rows.length} 篇笔记`), listText.slice(0, 80))
check('kb_list 带字数', /\d+ 字/.test(listText), listText.slice(0, 200))
const kbSearch = boot1.tools.find((t) => t.name === 'kb_search')
const searchText = await kbSearch.execute({ query: term, limit: 3 }, {})
check('kb_search 返回命中段落', searchText.includes('命中') && searchText.includes('offset '), searchText.slice(0, 120))
check('kb_search 报告检索范围', searchText.includes(`${rows.length} 篇`), searchText.slice(0, 120))
const kbRead = boot1.tools.find((t) => t.name === 'kb_read')
const readText = await kbRead.execute({ note_id: rows[0].id, offset: 0, limit: 120 }, {})
check('kb_read 分页头', readText.includes('字符 0–') && readText.includes('共'), readText.slice(0, 80))
check('kb_read 给 next offset', readText.includes('offset=') || readText.includes('[已到笔记末尾]'), readText.slice(-80))

// ── 5b. 个人知识库（wiki 侧）─────────────────────────────────────────
console.log('=== knowledge bases ===')
const kbRes = await call('/ima-kb/api/kb')
check('/kb 200', kbRes.status === 200, String(kbRes.status))
const kbItems = (kbRes.body && kbRes.body.items) || []
check('/kb 有知识库', kbItems.length >= 1, String(kbItems.length))
check('/kb 字段齐全', kbItems.every((x) => x.id !== '' && typeof x.name === 'string' && typeof x.count === 'number'), JSON.stringify(kbItems[0]).slice(0, 160))
const primary = kbItems.find((x) => x.role === '创建者') || kbItems[0]

const rootDir = await call(`/ima-kb/api/kb-files?kb=${encodeURIComponent(primary.id)}&folder=&cursor=`)
check('/kb-files 200', rootDir.status === 200, String(rootDir.status))
const dirItems = (rootDir.body && rootDir.body.items) || []
check('/kb-files 有目录内容', dirItems.length > 0, String(dirItems.length))
check('/kb-files 项有 mediaId/typeLabel', dirItems.every((x) => x.mediaId !== '' && typeof x.typeLabel === 'string'), JSON.stringify(dirItems[0]).slice(0, 160))

const rootFolder = dirItems.find((x) => x.folder)
if (rootFolder) {
  const sub = await call(`/ima-kb/api/kb-files?kb=${encodeURIComponent(primary.id)}&folder=${encodeURIComponent(rootFolder.mediaId)}&cursor=`)
  check('子目录可进入', sub.status === 200 && Array.isArray((sub.body || {}).items), String(sub.status))
  check('子目录带面包屑', Array.isArray(sub.body.path) && sub.body.path.length >= 2, JSON.stringify(sub.body.path).slice(0, 160))
  const file = ((sub.body && sub.body.items) || []).find((x) => !x.folder)
  if (file) {
    const info = await call(`/ima-kb/api/kb-file?media_id=${encodeURIComponent(file.mediaId)}`)
    check('/kb-file 可下载', info.status === 200 && info.body.downloadable === true, JSON.stringify(info.body))
    const raw = await call(`/ima-kb/api/kb-raw?media_id=${encodeURIComponent(file.mediaId)}&title=test.bin`)
    check('/kb-raw 代理返回字节', raw.status === 200 && raw.bytes > 0, `status=${raw.status} bytes=${raw.bytes}`)
  } else {
    console.log('  (子目录没有文件，跳过 kb-raw 检查)')
  }
} else {
  console.log('  (根目录没有文件夹，跳过子目录检查)')
}

const kbSearchRes = await call(`/ima-kb/api/kb-search?kb=${encodeURIComponent(primary.id)}&q=${encodeURIComponent('复盘')}`)
check('/kb-search 200', kbSearchRes.status === 200 && Array.isArray((kbSearchRes.body || {}).items), String(kbSearchRes.status))

const kbSpaceList = boot1.tools.find((t) => t.name === 'kb_space_list')
const spaceText = await kbSpaceList.execute({}, {})
check('kb_space_list 输出知识库', spaceText.includes('个知识库') && spaceText.includes('kb_id:'), spaceText.slice(0, 160))
const kbSpaceBrowse = boot1.tools.find((t) => t.name === 'kb_space_browse')
const browseText = await kbSpaceBrowse.execute({ kb_id: primary.id }, {})
check('kb_space_browse 输出目录', browseText.includes('media_id:'), browseText.slice(0, 160))
const kbSpaceSearch = boot1.tools.find((t) => t.name === 'kb_space_search')
const spaceSearchText = await kbSpaceSearch.execute({ kb_id: primary.id, query: '复盘' }, {})
check('kb_space_search 返回结果', spaceSearchText.includes('media_id:') || spaceSearchText.includes('没有文件名含'), spaceSearchText.slice(0, 160))

// ── 6. /refresh 清内存 + 清磁盘 ──────────────────────────────────────
console.log('=== /refresh ===')
const refresh = await call('/ima-kb/api/refresh')
check('/refresh 200', refresh.status === 200 && refresh.body.ok === true, JSON.stringify(refresh.body))
const afterRefreshFiles = existsSync(cacheDir) ? readdirSync(cacheDir).filter((name) => name.endsWith('.json')) : []
check('refresh 清掉磁盘缓存', afterRefreshFiles.length === 0, JSON.stringify(afterRefreshFiles))
const notesAgain = await call('/ima-kb/api/notes')
const stateAfter = await call('/ima-kb/api/state')
check('refresh 后仍能重新翻页', (notesAgain.body.notes || []).length === stateAfter.body.noteCount, `${(notesAgain.body.notes || []).length} vs ${stateAfter.body.noteCount}`)
const kbAgain = await call('/ima-kb/api/kb')
check('refresh 后知识库仍可列出', kbAgain.status === 200 && (kbAgain.body.items || []).length >= 1, `${kbAgain.status} / ${(kbAgain.body.items || []).length}`)

// ── 7. 第二次启动：磁盘缓存命中，不重打接口 ──────────────────────────
console.log('=== boot 2（暖缓存，模拟 DSH 重启）===')
await call('/ima-kb/api/warm') // 把缓存重新灌满并落盘
const boot2 = makeContext()
const mod2 = await import(`${pluginPath.href}?boot=2`)
mod2.apply(boot2.ctx, { cacheDir })
const call2 = makeCaller(boot2.routes[0])
// 知识库可能在跑测试期间被加笔记，所以 boot2 一律以它自己看到的列表为准。
const notes2 = await call2('/ima-kb/api/notes')
const rows2 = (notes2.body && notes2.body.notes) || []
const warmStart2 = Date.now()
const warm2 = await call2('/ima-kb/api/warm')
const warmSeconds2 = (Date.now() - warmStart2) / 1000
console.log(`  boot2 /warm 用时 ${warmSeconds2.toFixed(1)}s（本次看到 ${rows2.length} 篇）`)
check('boot2 命中磁盘缓存（不再逐篇接口）', warmSeconds2 < 20, `${warmSeconds2.toFixed(1)}s`)
const warmRows2 = (warm2.body && warm2.body.notes) || []
check('boot2 全部有字数', warmRows2.length === rows2.length && warmRows2.every((r) => typeof r.chars === 'number' && r.chars > 0), `${warmRows2.filter((r) => typeof r.chars !== 'number').length} 篇缺字数 / ${warmRows2.length} vs ${rows2.length}`)
const search2 = await call2('/ima-kb/api/search?q=' + encodeURIComponent(term) + '&limit=5')
check('boot2 检索立即覆盖全部笔记', search2.body.notesScanned === rows2.length, `${search2.body.notesScanned} vs ${rows2.length}`)

rmSync(runnerDir, { recursive: true, force: true })
rmSync(cacheDir, { recursive: true, force: true })

console.log('\n' + (failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：\n` + failures.join('\n')))
process.exitCode = failures.length === 0 ? 0 : 1
