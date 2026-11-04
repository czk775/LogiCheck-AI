/**
 * LogiCheck AI 前端 E2E 验证脚本（CDP 无头 Chrome，零依赖）
 * 覆盖：登录/主题 → 列表/搜索/筛选 → 工作台 → 异常抽屉/证据链 →
 *       字段修正/重检/人工复核 → 规则抽屉 → 真实文件上传/预览/删除/重试 →
 *       上传拒绝 → 删除货物 → 刷新/重登恢复 → 响应式 → 双主题 → 无 JS 异常
 *
 * 运行方式：
 *   node e2e/run-tests.mjs
 *     → 默认自建独立栈：临时数据库 + 服务端 4011 + 前端 5188，可重复回归；
 *       真实模式（RealApi）全流程；后端每次都是干净数据。
 *   E2E_SPAWN=0 node e2e/run-tests.mjs
 *     → 对接已在运行的服务（前端 5173 / 后端 4000）；
 *       自动探测后端是否在线：在线 → 真实模式，不在线 → Mock 模式。
 *       注意：真实模式下后端数据库是持久化的，演示货物状态会被上一轮修改污染。
 *   E2E_API_PORT / E2E_WEB_PORT 可覆盖自建栈端口。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.resolve(HERE, '..')
const SERVER_DIR = path.resolve(WEB_DIR, '..', 'logicheck-ai-server')
const FIXTURES = path.join(HERE, 'fixtures')
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))

const SPAWN = process.env.E2E_SPAWN !== '0'
const API_PORT = Number(process.env.E2E_API_PORT || (SPAWN ? 4011 : 4000))
const WEB_PORT = Number(process.env.E2E_WEB_PORT || (SPAWN ? 5188 : 5173))
const API_BASE = `http://127.0.0.1:${API_PORT}`
const BASE = `http://127.0.0.1:${WEB_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从服务端 .env 读取某个变量（只读，不打印值） */
function readEnvValue(key) {
  try {
    const p = path.join(SERVER_DIR, '.env')
    if (!existsSync(p)) return ''
    const raw = readFileSync(p, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      if (t.slice(0, eq).trim() !== key) continue
      let v = t.slice(eq + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      return v
    }
  } catch {
    /* 读不到按未配置处理 */
  }
  return ''
}

/* ---------- CDP 客户端 ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
  }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('WebSocket 连接失败'))
    })
    const cdp = new CDP(ws)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id)
        cdp.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    }
    return cdp
  }
  send(method, params) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面内报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }
}

/* ---------- 断言收集 ---------- */
const results = []
let cdpRef = null
function check(name, cond, extra = '') {
  const pass = !!cond
  results.push({ name, pass, extra })
  console.log(`${pass ? '✅' : '❌'} ${name}${pass || !extra ? '' : '  → ' + extra}`)
  if (!pass && cdpRef) void dumpFailureContext(name)
}

/** 断言失败时 dump 页面与服务端状态，定位竞态 / 数据问题 */
async function dumpFailureContext(failedName) {
  try {
    const snap = await cdpRef.eval(`(async () => {
      const out = {
        url: location.pathname,
        issues: document.querySelectorAll('[data-testid="issue-item"]').length,
        issueTitles: Array.from(document.querySelectorAll('[data-testid="issue-item"]')).map(e => (e.textContent || '').slice(0, 40)),
        ruleRows: document.querySelectorAll('[data-testid="rule-row"]').length,
        docRows: document.querySelectorAll('[data-testid="doc-row"]').length,
        drawers: Array.from(document.querySelectorAll('[data-testid$="-drawer"]')).map(e => e.getAttribute('data-testid')),
        docErrors: Array.from(document.querySelectorAll('[data-testid="doc-error"]')).map(e => (e.textContent || '').replace(/\s+/g, ' ').slice(0, 120)),
        docTexts: Array.from(document.querySelectorAll('[data-testid="doc-row"]')).map(e => (e.textContent || '').replace(/\s+/g, ' ').slice(0, 80)),
        aiStatusPanel: (document.querySelector('[data-testid="ai-status-panel"]')?.textContent || '').replace(/\s+/g, ' ').slice(0, 200),
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300),
      }
      try {
        const list = await (await fetch('/api/shipments', { credentials: 'include' })).json()
        const shipments = list.shipments || []
        const demo = shipments.find(s => s.isDemo)
        if (demo) {
          out.demoFindings = (demo.findings || []).map(f => f.status + '|' + f.title.slice(0, 24))
          out.demoDocCount = (demo.documents || []).length
          const res = await fetch('/api/shipments/' + demo.id + '/check-results', { credentials: 'include' })
          out.checkResults = (await res.json()).results?.map(r => r.ruleKey) ?? null
        }
        // 非演示货物的单证真实状态（解析失败原因在这里）
        const own = shipments.filter(s => !s.isDemo)
        out.ownShipments = own.map(s => ({
          id: s.id,
          name: s.name,
          docs: (s.documents || []).map(d => ({
            file: d.fileName,
            status: d.status,
            error: (d.error || '').slice(0, 120),
            provider: d.extractionProvider,
            summary: (d.parseSummary || '').slice(0, 100),
          })),
        }))
      } catch (e) { out.apiError = String(e).slice(0, 120) }
      return out
    })()`, true)
    console.log(`🔍 失败现场（${failedName}）：`)
    console.log(JSON.stringify(snap, null, 1).slice(0, 1600))
  } catch (err) {
    console.log('🔍 失败现场获取失败：', String(err).slice(0, 200))
  }
}

async function waitFor(cdp, expr, timeout = 8000, label = '') {
  // returnByValue 下 DOM 节点不可序列化，必须强制转布尔再轮询
  const wrapped = `(() => { try { return !!(${expr}) } catch { return false } })()`
  const start = Date.now()
  for (;;) {
    try {
      const v = await cdp.eval(wrapped)
      if (v) return v
    } catch {
      /* 页面切换瞬间可能取不到，继续轮询 */
    }
    if (Date.now() - start > timeout) {
      // 超时时打印现场（单证真实状态 / 错误原因），否则只能靠猜
      console.log(`⏱ waitFor 超时：${label || expr}`)
      if (cdpRef) await dumpFailureContext(`waitFor:${label || expr}`)
      throw new Error(`waitFor 超时: ${label || expr}`)
    }
    await sleep(150)
  }
}

/* ---------- 页面内工具函数 ---------- */
const PAGE_HELPERS = `
window.__t = {
  q: (s) => document.querySelector(s),
  qa: (s) => Array.from(document.querySelectorAll(s)),
  text: (s) => (document.querySelector(s)?.textContent || '').trim(),
  setNativeValue(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    desc.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  setNativeSelect(el, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
    desc.set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  },
  clickByText(selector, text) {
    const el = Array.from(document.querySelectorAll(selector)).find((e) => (e.textContent || '').includes(text))
    if (!el) return false
    el.click()
    return true
  },
}
`

/* ---------- 自建独立栈（默认） ---------- */
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    /* 进程可能已退出 */
  }
}

async function waitHttp(url, timeout, label) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - start > timeout) throw new Error(`等待 ${label} 超时：${url}`)
    await sleep(300)
  }
}

async function setupStack() {
  if (!SPAWN) {
    let mode = 'mock'
    try {
      const res = await fetch(`${API_BASE}/api/healthz`)
      if (res.ok) mode = 'real'
    } catch {
      /* 后端不在线 → Mock */
    }
    if (mode === 'real') {
      console.log('⚠️ 正在对接已运行的后端（持久化数据库）：演示货物状态可能被历史运行污染')
    }
    return { apiMode: mode, serverLogPath: null, teardown: () => {} }
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'logicheck-e2e-stack-'))
  const children = []
  const logs = []
  const serverLogPath = path.join(dir, 'server.log')

  // AI 模式：E2E_AI=1 时加载服务端 .env（真实 Key / 模型），走真实大模型链路。
  // 默认关闭 —— 回归测试不应每次都消耗额度。
  const useRealAi = process.env.E2E_AI === '1'
  const serverEnv = {
    ...process.env,
    PORT: String(API_PORT),
    DATABASE_PATH: path.join(dir, 'logicheck.db'),
    UPLOAD_DIR: path.join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: path.join(dir, 'mail-outbox'),
    // 回归栈只需要「1 票内置演示货物」的干净库；公网演示用的多账号历史货物
    // 会改变列表首项，导致用例定位到别的货物，故此处关闭
    SEED_SHOWCASE: 'false',
  }
  if (useRealAi) {
    serverEnv.EXTRACTION_PROVIDER = 'ai'
    serverEnv.DASHSCOPE_API_KEY = readEnvValue('DASHSCOPE_API_KEY')
    serverEnv.AI_MODEL = readEnvValue('AI_MODEL') || 'qwen3.8-flash'
    serverEnv.AI_VISION_MODEL = readEnvValue('AI_VISION_MODEL') || 'qwen3.8-omni-flash'
    serverEnv.AI_BASE_URL = readEnvValue('AI_BASE_URL') || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    if (!serverEnv.DASHSCOPE_API_KEY) {
      console.error('✗ E2E_AI=1 但服务端 .env 中没有 DASHSCOPE_API_KEY')
      process.exit(2)
    }
    console.log('⚡ AI 模式：使用真实大模型（会消耗少量额度）')
  } else {
    // 回归模式强制走确定性提取（不消耗额度、耗时可预期）。
    // 服务端启动时会自行读取 logicheck-ai-server/.env，若本机配了真实 AI，
    // 必须在此显式覆盖，否则回归用例会意外走真实模型并被超时阈值判失败。
    serverEnv.EXTRACTION_PROVIDER = 'deterministic'
    serverEnv.DASHSCOPE_API_KEY = ''
    serverEnv.AI_MODEL = ''
    serverEnv.AI_VISION_MODEL = ''
  }

  const server = spawn(
    'node',
    [
      '--experimental-sqlite',
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx/esm',
      'src/index.ts',
    ],
    {
      cwd: SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: serverEnv,
    },
  )
  children.push(server)
  const serverLog = createWriteStream(serverLogPath)
  server.stderr.on('data', (d) => {
    logs.push(`[server] ${d}`)
    serverLog.write(d)
  })
  server.stdout.on('data', (d) => {
    logs.push(`[server] ${d}`)
    serverLog.write(d)
  })

  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: WEB_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    env: { ...process.env, VITE_API_PROXY_TARGET: API_BASE },
  })
  children.push(vite)
  vite.stderr.on('data', (d) => logs.push(`[vite] ${d}`))
  vite.stdout.on('data', (d) => logs.push(`[vite] ${d}`))

  try {
    await waitHttp(`${API_BASE}/api/healthz`, 60000, '后端服务')
    await waitHttp(BASE, 60000, '前端 dev server')
  } catch (err) {
    console.error(logs.slice(-20).join(''))
    throw err
  }
  console.log(`自建独立栈已就绪：后端 ${API_BASE}（临时数据库）· 前端 ${BASE}`)

  return {
    apiMode: 'real',
    serverLogPath,
    teardown: () => {
      serverLog.end()
      children.forEach(killTree)
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败可忽略（SQLite WAL 可能仍被占用） */
      }
    },
  }
}

/* ---------- 主流程 ---------- */
async function main() {
  if (!CHROME) {
    console.error('未找到 Chrome / Edge 可执行文件')
    process.exit(2)
  }

  const stack = await setupStack()
  const API_MODE = stack.apiMode
  console.log(`API 模式：${API_MODE === 'real' ? '真实后端（RealApi + SQLite）' : 'Mock 服务'}`)

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'logicheck-e2e-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=9333',
      `--user-data-dir=${userDataDir}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const pageErrors = []
  let cdp = null
  try {
    // 等待调试端口
    let wsUrl = null
    for (let i = 0; i < 60; i++) {
      try {
        const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
        const page = list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
        if (page) {
          wsUrl = page.webSocketDebuggerUrl
          break
        }
      } catch {
        /* 端口未就绪 */
      }
      await sleep(250)
    }
    if (!wsUrl) throw new Error('无法连接 Chrome 调试端口')
    cdp = await CDP.connect(wsUrl)
    cdpRef = cdp
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    cdp.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
      }
    })

    const goto = async (url) => {
      await cdp.send('Page.navigate', { url })
      await cdp.eval(PAGE_HELPERS)
    }

    /* ===== A. 登录页 + 主题 ===== */
    await goto(`${BASE}/login`)
    await waitFor(cdp, `!!document.querySelector('.auth-card')`, 10000, 'auth-card')
    check('A1 登录页渲染（标题/品牌/表单）', await cdp.eval(`document.querySelector('.auth-story h1')?.textContent.includes('清晰可控') && !!document.querySelector('#authForm')`))
    check(
      'A2 登录页半成品说明性文字已移除（认证声明 / 副标题 / 环境眉头）',
      await cdp.eval(`(() => {
        const t = document.body.textContent || ''
        return !t.includes('真实账户认证 · 数据保存在本机服务器')
          && !t.includes('仅界面演示 · 不进行真实身份认证')
          && !t.includes('登录并继续处理你的货物和单证')
          && !t.includes('SECURE WORKSPACE')
          && !document.querySelector('.auth-mode-hint')
          && !document.querySelector('.auth-card .intro')
      })()`),
    )
    check('A3 忘记密码入口存在', await cdp.eval(`window.__t.clickByText('.text-btn','忘记密码')`))
    await waitFor(cdp, `!!document.querySelector('[data-testid="forgot-password-modal"]')`, 5000, 'forgot modal')
    await cdp.eval(`document.querySelector('[data-testid="forgot-password-modal"] .close').click()`)
    await waitFor(cdp, `!document.querySelector('[data-testid="forgot-password-modal"]')`, 5000, 'forgot modal closed')
    check('A4 找回密码弹窗可打开且可关闭', true)
    // 主题切换
    await cdp.eval(`document.querySelector('[data-testid="theme-toggle"]').click()`)
    await sleep(300)
    check('A5 主题切换到浅色', await cdp.eval(`document.documentElement.dataset.theme === 'light'`))
    check('A6 主题写入 localStorage', await cdp.eval(`localStorage.getItem('logicheck_theme_v2') === 'light'`))
    await cdp.eval(`document.querySelector('[data-testid="theme-toggle"]').click()`)
    await sleep(300)
    check('A7 主题切回深色', await cdp.eval(`document.documentElement.dataset.theme === 'dark'`))

    /* ===== B. 演示登录 → 列表 ===== */
    // 演示账号经后端 API 建立会话（UI 入口已按产品化要求移除）
    await cdp.eval(`(async () => { const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' }); return r.ok })()`, true)
    await goto(`${BASE}/shipments`)
    await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 10000, 'shipment rows')
    check('B1 演示登录进入货物列表', await cdp.eval(`location.pathname === '/shipments'`))
    check('B2 演示货物 SHP-2026-001 在列表', await cdp.eval(`document.body.textContent.includes('SHP-2026-001')`))
    check('B3 演示徽章与状态（待处理异常）', await cdp.eval(`document.body.textContent.includes('· 演示') && document.body.textContent.includes('待处理异常')`))
    check(
      'B4 侧栏环境说明卡片已移除（按模式）',
      API_MODE === 'real'
        ? await cdp.eval(`!document.body.textContent.includes('本地服务 · SQLite 数据库') && !document.querySelector('.sys-card')`)
        : await cdp.eval(`!document.body.textContent.includes('演示环境 · MOCK 服务') && !document.querySelector('.sys-card')`),
    )
    check(
      'B5 顶栏环境徽章已移除（按模式）',
      API_MODE === 'real'
        ? await cdp.eval(`!document.body.textContent.includes('REAL API · 本地服务器') && !document.querySelector('.env-badge')`)
        : await cdp.eval(`!document.body.textContent.includes('DEMO BUILD · MOCK 服务') && !document.querySelector('.env-badge')`),
    )

    /* ===== C. 搜索 / 筛选 / 空态 ===== */
    await cdp.eval(`(() => { const i = document.querySelector('[data-testid="shipment-search"]'); window.__t.setNativeValue(i, '蓝牙'); })()`)
    await sleep(300)
    check('C1 搜索「蓝牙」命中 1 条', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1`))
    await cdp.eval(`(() => { const i = document.querySelector('[data-testid="shipment-search"]'); window.__t.setNativeValue(i, '不存在的货物'); })()`)
    await sleep(300)
    check('C2 搜索无结果 → 空状态文案', await cdp.eval(`document.body.textContent.includes('没有找到匹配的货物')`))
    await cdp.eval(`(() => { const i = document.querySelector('[data-testid="shipment-search"]'); window.__t.setNativeValue(i, ''); })()`)
    await cdp.eval(`(() => { const s = document.querySelector('[data-testid="status-filter"]'); window.__t.setNativeSelect(s, 'needs_review'); })()`)
    await sleep(300)
    check('C3 筛选「待处理异常」命中演示货物', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1`))
    await cdp.eval(`(() => { const s = document.querySelector('[data-testid="status-filter"]'); window.__t.setNativeSelect(s, 'checked'); })()`)
    await sleep(300)
    check('C4 筛选「检查完成」为 0 条且有空态', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 0 && document.body.textContent.includes('没有找到匹配的货物')`))
    await cdp.eval(`(() => { const s = document.querySelector('[data-testid="status-filter"]'); window.__t.setNativeSelect(s, 'all'); })()`)

    /* ===== D. 工作台 ===== */
    await cdp.eval(`window.__t.clickByText('.link-btn','进入工作台')`)
    await waitFor(cdp, `document.querySelector('.workspace-title')`, 8000, 'workspace')
    check('D1 工作台标题/路线', await cdp.eval(`document.querySelector('.workspace-title')?.textContent.includes('蓝牙音箱') && document.body.textContent.includes('中国 → 德国')`))
    check('D2 总状态：发现需要关注的异常', await cdp.eval(`document.querySelector('.status-panel h2')?.textContent.includes('发现需要关注的异常')`))
    check('D3 指标卡数字（04 单证 / 03 异常 / 09 字段 / 05 规则）', await cdp.eval(`(() => { const t = Array.from(document.querySelectorAll('.metric strong')).map(e => e.textContent.trim()); return t.join(',') === '04,03,09,05' })()`))
    check('D4 待处理异常 3 条', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]').length === 3`))
    check('D5 单证 4 份（演示徽章）', await cdp.eval(`document.querySelectorAll('[data-testid="doc-row"]').length === 4 && document.body.textContent.includes('已解析 · 演示')`))
    // 规则区数据经 getCheckResults 异步加载，先等行数齐再断言
    await waitFor(cdp, `document.querySelectorAll('[data-testid="rule-row"]').length === 5`, 8000, 'rule rows loaded')
    check('D6 合规规则 5 条', await cdp.eval(`document.querySelectorAll('[data-testid="rule-row"]').length === 5`))
    check('D7 处理流程 5 步', await cdp.eval(`document.querySelectorAll('.wf-item').length === 5`))
    check('D8 合规免责声明存在', await cdp.eval(`document.body.textContent.includes('不构成法律意见或海关放行结论')`))
    check('D9 货物字段卡 6 项 + 冲突标记', await cdp.eval(`document.querySelectorAll('.profile-item').length === 6 && document.body.textContent.includes('需复核')`))

    /* ===== D10. AI 状态条（第五阶段）===== */
    await waitFor(cdp, `document.querySelector('[data-testid="ai-status-trigger"]')`, 8000, 'ai status bar')
    check('D10 工作台顶部有 AI 状态条', await cdp.eval(`!!document.querySelector('[data-testid="ai-status-trigger"]')`))
    check(
      'D10b 状态条文案为 AI 已连接/不可用/演示模式之一（不泄漏技术细节）',
      await cdp.eval(`(() => {
        const t = document.querySelector('[data-testid="ai-status-trigger"]')?.textContent ?? ''
        return /AI 已连接|AI 不可用|AI 状态未知|演示模式/.test(t)
      })()`),
    )
    check('D10c 状态条不含密钥与限流配额字样', await cdp.eval(`(() => {
        const t = document.querySelector('[data-testid="ai-status-trigger"]')?.textContent ?? ''
        return !/sk-/i.test(t) && !/额度|余额|token/i.test(t)
      })()`))
    // 点击展开详情
    await cdp.eval(`document.querySelector('[data-testid="ai-status-trigger"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="ai-status-panel"]')`, 5000, 'ai status panel')
    check('D10d 点击展开详情浮层', await cdp.eval(`!!document.querySelector('[data-testid="ai-status-panel"]')`))
    check('D10e 详情含运行模式与提取/识别信息', await cdp.eval(`(() => {
        const t = document.querySelector('[data-testid="ai-status-panel"]')?.textContent ?? ''
        return t.includes('运行模式') && (t.includes('提取模型') || t.includes('提取方式')) && t.includes('图片识别')
      })()`))
    check('D10f 详情不含密钥字样', await cdp.eval(`(() => {
        const t = document.querySelector('[data-testid="ai-status-panel"]')?.textContent ?? ''
        return !/sk-[a-z0-9]/i.test(t) && !/API Key\s*[:：]\s*\S/i.test(t)
      })()`))
    // 关闭浮层
    await cdp.eval(`document.querySelector('[data-testid="ai-status-trigger"]').click()`)
    await waitFor(
      cdp,
      `!document.querySelector('[data-testid="ai-status-panel"]')`,
      5000,
      'ai status panel closed',
    )
    check('D10g 再次点击可收起浮层', await cdp.eval(`!document.querySelector('[data-testid="ai-status-panel"]')`))

    /* ===== E. 异常抽屉：证据链 ===== */
    await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]')[0].click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="issue-drawer"]')`, 5000, 'issue drawer')
    check('E1 两值对照（1000 vs 980）', await cdp.eval(`(() => { const c = Array.from(document.querySelectorAll('.compare-cell strong')).map(e => e.textContent.trim()); return c[0] === '1000' && c[1] === '980' })()`))
    check('E2 证据 tab 两个单证', await cdp.eval(`document.querySelectorAll('[data-testid="evidence-tab"]').length === 2`))
    check('E3 默认证据为发票且数量行高亮 1000', await cdp.eval(`(() => { const hl = document.querySelector('.paper-kv.highlight'); return hl && hl.textContent.includes('1000') })()`))
    await cdp.eval(`document.querySelectorAll('[data-testid="evidence-tab"]')[1].click()`)
    await sleep(300)
    check('E4 切换到装箱单证据且高亮 980', await cdp.eval(`(() => { const hl = document.querySelector('.paper-kv.highlight'); return hl && hl.textContent.includes('980') })()`))
    check('E5 抽屉操作按钮齐全（修正/替换/复核/重检）', await cdp.eval(`['fix-extraction','replace-document','add-review','recheck-in-drawer'].every(id => !!document.querySelector('[data-testid="'+id+'"]'))`))
    await cdp.eval(`document.querySelector('[data-testid="issue-drawer"] .close').click()`)
    await sleep(200)
    check('E6 抽屉可关闭', await cdp.eval(`!document.querySelector('[data-testid="issue-drawer"]')`))

    /* ===== F. 修正字段 → 重检 → 异常解决 ===== */
    await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]')[0].click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="fix-extraction"]')`, 5000, 'fix button')
    await cdp.eval(`document.querySelector('[data-testid="fix-extraction"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="field-value-input"]')`, 5000, 'field modal')
    check('F1 修正弹窗默认来源为装箱单', await cdp.eval(`document.querySelector('#source-doc')?.value === 'doc-packing'`))
    await cdp.eval(`(() => { const i = document.querySelector('[data-testid="field-value-input"]'); window.__t.setNativeValue(i, '1000'); })()`)
    await cdp.eval(`document.querySelector('[data-testid="save-field"]').click()`)
    await waitFor(cdp, `document.body.textContent.includes('1000 PCS（待重新检查）')`, 5000, 'profile updated')
    check('F2 字段修正保存 + 操作记录', await cdp.eval(`document.body.textContent.includes('字段修改已保存') || document.body.textContent.includes('1000 PCS（待重新检查）')`))
    await cdp.eval(`document.querySelector('[data-testid="recheck"]').click()`)
    // 字段修正后异常抽屉保持打开（与原型一致），先关闭再断言列表
    await cdp.eval(`document.querySelector('[data-testid="issue-drawer"] .close')?.click()`)
    await waitFor(cdp, `document.querySelectorAll('[data-testid="issue-item"]').length === 2`, 8000, 'recheck done')
    check('F3 重新检查解决数量冲突（RED/HS 异常按设计保留）', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]').length === 2 && !document.body.textContent.includes('商业发票与装箱单数量不一致')`))
    check('F4 重检结果写入处理记录', await cdp.eval(`(() => { const btn = Array.from(document.querySelectorAll('.section-link')).find(b => b.textContent.includes('处理记录')); btn.click(); return true })()`) === true)
    await waitFor(cdp, `document.querySelector('[data-testid="activity-drawer"]')`, 5000, 'activity drawer')
    check('F5 记录含「数量冲突已解决」审计', await cdp.eval(`document.querySelector('[data-testid="activity-drawer"]')?.textContent.includes('数量冲突已解决')`))
    check('F6 记录含人工修正字段操作', await cdp.eval(`document.querySelector('[data-testid="activity-drawer"]')?.textContent.includes('人工修正提取值')`))
    await cdp.eval(`document.querySelector('[data-testid="activity-drawer"] .close').click()`)

    /* ===== G. 人工复核 ===== */
    await cdp.eval(`document.querySelector('[data-testid="issue-item"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="add-review"]')`, 5000, 'review button')
    await cdp.eval(`document.querySelector('[data-testid="add-review"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="review-note"]')`, 5000, 'review modal')
    await cdp.eval(`(() => { const t = document.querySelector('[data-testid="review-note"]'); window.__t.setNativeValue(t, '已联系供应商确认数量，等待最终装箱单'); })()`)
    await cdp.eval(`document.querySelector('[data-testid="save-review"]').click()`)
    await waitFor(cdp, `document.body.textContent.includes('人工复核意见已保存')`, 5000, 'review saved')
    check('G1 人工复核保存且异常仍保留（不等于已解决）', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]').length === 2 && document.body.textContent.includes('人工已复核')`))

    /* 阶段四：人工解决异常 → 重新打开 */
    // 记录当前抽屉对应异常的 id（用于后续精确重新打开）
    await cdp.eval(`window.__gFindingId = document.querySelector('[data-testid="issue-drawer"]')?.getAttribute('data-finding-id') || (() => { const btn = document.querySelector('[data-testid="resolve-finding"]'); return btn ? btn.getAttribute('data-finding-id') : '' })()`)
    await cdp.eval(`document.querySelector('[data-testid="resolve-finding"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="resolve-note"]')`, 5000, 'resolve modal')
    check('G5 解决弹窗要求填写处理说明', await cdp.eval(`(() => { const t = document.querySelector('[data-testid="resolve-modal"]')?.textContent ?? ''; return t.includes('标记为已处理') && t.includes('无法删除') })()`))
    await cdp.eval(`(() => { const t = document.querySelector('[data-testid="resolve-note"]'); window.__t.setNativeValue(t, '已核对原件并与供应商确认，按装箱单为准'); })()`)
    await cdp.eval(`document.querySelector('[data-testid="save-resolve"]').click()`)
    await waitFor(cdp, `document.body.textContent.includes('已标记为人工处理完毕')`, 5000, 'resolve saved')
    check('G6 人工解决后异常从待处理列表消失', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"][data-finding-status]:not([data-finding-status="resolved"])').length === 1 && document.body.textContent.includes('查看已处理')`))

    // 重新打开：展开「已处理」分组，按 id 精确找到刚解决的那一项
    await waitFor(cdp, `document.querySelector('[data-testid="toggle-resolved"]')`, 5000, 'resolved toggle')
    await cdp.eval(`document.querySelector('[data-testid="toggle-resolved"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-finding-status="resolved"]')`, 5000, 'resolved item')
    await cdp.eval(`(() => { const el = document.querySelector('[data-finding-id="' + window.__gFindingId + '"]'); if (el) el.click(); })()`)
    await waitFor(cdp, `document.querySelector('[data-testid="reopen-finding"]')`, 5000, 'reopen button')
    check('G7 已解决异常提供「重新打开」入口', await cdp.eval(`!!document.querySelector('[data-testid="reopen-finding"]')`))
    await cdp.eval(`document.querySelector('[data-testid="reopen-finding"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="reopen-note"]')`, 5000, 'reopen modal')
    await cdp.eval(`(() => { const t = document.querySelector('[data-testid="reopen-note"]'); window.__t.setNativeValue(t, '供应商称装箱单有误，需继续追查'); })()`)
    await cdp.eval(`document.querySelector('[data-testid="save-reopen"]').click()`)
    await waitFor(cdp, `document.body.textContent.includes('异常已重新打开')`, 5000, 'reopen saved')
    check('G8 重新打开后异常回到待处理', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"][data-finding-status]:not([data-finding-status="resolved"])').length === 2`))

    /* ===== H. 规则抽屉 ===== */
    await cdp.eval(`document.querySelectorAll('[data-testid="rule-row"]')[0].click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="rule-drawer"]')`, 5000, 'rule drawer')
    check('H1 规则详情（来源/版本/免责）', await cdp.eval(`(() => { const t = document.querySelector('[data-testid="rule-drawer"]').textContent; return t.includes('Directive 2014/53/EU') && t.includes('规则版本') && t.includes('不是具有法律效力的合规裁决') })()`))
    check('H2 官方资料外链', await cdp.eval(`!!document.querySelector('[data-testid="rule-drawer"] a[target="_blank"]')`))
    await cdp.eval(`document.querySelector('[data-testid="rule-follow-up"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="review-note"]')`, 5000, 'rule follow-up modal')
    check('H3 规则记录人工意见 → 打开复核弹窗', await cdp.eval(`!!document.querySelector('[data-testid="review-modal"]')`))
    await cdp.eval(`document.querySelector('[data-testid="review-modal"] .close').click()`)

    /* ===== I. 新建货物 + 真实文件上传 ===== */
    await cdp.eval(`window.__t.clickByText('.backlink','返回货物列表')`)
    await waitFor(cdp, `document.querySelector('[data-testid="new-shipment"]')`, 5000, 'list page')
    await cdp.eval(`document.querySelector('[data-testid="new-shipment"]').click()`)
    await waitFor(cdp, `document.querySelector('.workspace-title')`, 5000, 'new workspace')
    check('I1 新建货物进入空工作台', await cdp.eval(`document.body.textContent.includes('上传第一份单证，开始预检')`))
    check('I2 空状态显示上传区', await cdp.eval(`!!document.querySelector('[data-testid="upload-zone"]')`))
    check('I3 非演示货物无 AI 字段/规则空态', await cdp.eval(`document.body.textContent.includes(${API_MODE === 'real' ? "'暂无提取字段'" : "'暂无 AI 提取字段'"}) && document.body.textContent.includes(${API_MODE === 'real' ? "'等待核验引擎运行'" : "'等待合规规则执行'"})`))

    // 上传两个真实文件
    await setFileInput(cdp, [path.join(FIXTURES, 'test-invoice.png'), path.join(FIXTURES, 'test-bol.edi')])
    await waitFor(cdp, `document.querySelectorAll('[data-testid="doc-row"]').length === 2`, 8000, 'uploaded docs')
    check('I4 上传后出现 2 份单证', await cdp.eval(`document.querySelectorAll('[data-testid="doc-row"]').length === 2`))
    // I6 上传反馈 toast：必须在上传后立即断言——
    // toast 会自动消失，而真实 AI 模式下等解析完成要几十秒，那时早已过期
    check('I6 上传反馈 toast', await cdp.eval(`Array.from(document.querySelectorAll('[data-testid="toast"]')).some(t => t.textContent.includes('2 份文件正在接收'))`))
    // 等待两份文档都到达终态（mock 状态机每份独立翻转，1.1–2.0s）
    if (API_MODE === 'mock') {
      await waitFor(cdp, `document.querySelectorAll('.chip.warn').length >= 2`, 8000, 'awaiting AI badge')
      check('I5 状态推进为「等待解析」（不伪造解析成功）', await cdp.eval(`document.querySelectorAll('.chip.warn').length >= 2 && !document.body.textContent.includes('已解析')`))
    } else {
      // 真实模式：
      //   - AI 未接通（确定性提取 + OCR 未配置）→ PNG 明确失败，EDI 确定性解析成功
      //   - AI 已接通（E2E_AI=1）→ PNG 走视觉 OCR 成功，EDI 走确定性解析
      const aiOn = process.env.E2E_AI === '1'
      await waitFor(
        cdp,
        aiOn
          ? `document.querySelector('[data-file-name="test-invoice.png"]')?.textContent.includes('已解析') && document.querySelector('[data-file-name="test-bol.edi"]')?.textContent.includes('已解析')`
          : `document.querySelector('[data-file-name="test-invoice.png"]')?.textContent.includes('处理失败') && document.querySelector('[data-file-name="test-bol.edi"]')?.textContent.includes('已解析')`,
        // 真实 AI 模式：PNG 走「视觉 OCR + 大模型提取」两次调用，
        // 单次调用超时上限 60s，总耗时可能超过 1 分钟
        aiOn ? 150_000 : 12_000,
        'real terminal states',
      )
      check(
        aiOn
          ? 'I5r PNG 视觉 OCR 成功 + IFTMIN EDI 确定性解析成功'
          : 'I5r PNG 诚实失败（OCR 未接入）+ IFTMIN EDI 确定性解析成功',
        await cdp.eval(`(() => {
          const png = document.querySelector('[data-file-name="test-invoice.png"]')?.textContent ?? ''
          const edi = document.querySelector('[data-file-name="test-bol.edi"]')?.textContent ?? ''
          return ${aiOn ? `png.includes('已解析')` : `png.includes('处理失败')`} && edi.includes('已解析')
        })()`),
      )
      check('I5r2 工作台货物信息展示真实提取字段（数量 1000，来自 EDI 报文）', await cdp.eval(`document.querySelector('#profile')?.textContent.includes('1000')`))
      if (!aiOn) {
        // 第五阶段：单证卡片上直接展示失败原因（AI 未接通时才有失败态）
        check(
          'I5r3 单证卡片展示解析失败原因与处理建议',
          await cdp.eval(`(() => {
            const row = document.querySelector('[data-file-name="test-invoice.png"]')
            const err = row?.querySelector('[data-testid="doc-error"]')
            if (!err) return false
            const t = err.textContent ?? ''
            return t.includes('图片识别未启用') && t.includes('AI_VISION_MODEL')
          })()`),
        )
        check(
          'I5r4 失败单证提供「重新解析」按钮',
          await cdp.eval(`!!document.querySelector('[data-file-name="test-invoice.png"] [data-testid="retry-doc"]')`),
        )
      } else {
        check(
          'I5r5 AI 已接通：状态条显示「AI 已连接」',
          await cdp.eval(`document.querySelector('[data-testid="ai-status-trigger"]')?.textContent.includes('AI 已连接')`),
        )
        check(
          'I5r6 AI 已接通：详情浮层显示真实模型名',
          await cdp.eval(`(() => {
            document.querySelector('[data-testid="ai-status-trigger"]')?.click()
            return true
          })()`),
        )
        await waitFor(cdp, `document.querySelector('[data-testid="ai-status-panel"]')`, 5000, 'ai panel')
        check(
          'I5r6 AI 已接通：详情浮层显示真实模型名',
          await cdp.eval(`(() => {
            const t = document.querySelector('[data-testid="ai-status-panel"]')?.textContent ?? ''
            return t.includes('qwen') && t.includes('提取模型')
          })()`),
        )
        check(
          'I5r7 AI 已接通：详情浮层不含密钥与额度字样',
          await cdp.eval(`(() => {
            const t = document.querySelector('[data-testid="ai-status-panel"]')?.textContent ?? ''
            return !/sk-[a-z0-9]/i.test(t) && !/剩余额度|免费额度余额/.test(t)
          })()`),
        )
        await cdp.eval(`document.querySelector('[data-testid="ai-status-trigger"]')?.click()`)
      }
    }
    // 预览图片
    await cdp.eval(`(() => { const row = document.querySelector('[data-file-name="test-invoice.png"]'); row.querySelector('.link-btn').click(); })()`)
    await waitFor(cdp, `document.querySelector('[data-testid="doc-drawer"] img.preview-img')`, 8000, 'image preview')
    check('I7 真实图片原件预览（blob URL）', await cdp.eval(`(() => { const img = document.querySelector('[data-testid="doc-drawer"] img.preview-img'); return !!img && img.src.startsWith('blob:') })()`))
    // 预览抽屉的说明文案：
    //   - mock            → 声明「未 AI 解析」
    //   - real + AI 未接通 → 展示真实失败原因（OCR 未接入）
    //   - real + AI 已接通 → 展示真实解析摘要，不再声称失败
    const drawerExpect = API_MODE === 'mock'
      ? {
        name: 'I8 预览抽屉声明未 AI 解析',
        expr: `document.querySelector('[data-testid="doc-drawer"]')?.textContent.includes('原件预览（未 AI 解析）')`,
      }
      : process.env.E2E_AI === '1'
        ? {
          name: 'I8r 预览抽屉展示真实解析摘要（AI 已接通）',
          expr: `(() => { const t = document.querySelector('[data-testid="doc-drawer"]')?.textContent ?? ''; return t.includes('解析摘要') && !t.includes('处理失败原因') })()`,
        }
        : {
          name: 'I8r 预览抽屉展示真实失败原因（OCR 未接入）',
          expr: `(() => { const t = document.querySelector('[data-testid="doc-drawer"]')?.textContent ?? ''; return t.includes('处理失败原因') && t.includes('OCR') })()`,
        }
    check(drawerExpect.name, await cdp.eval(drawerExpect.expr))
    await cdp.eval(`document.querySelector('[data-testid="doc-drawer"] .close').click()`)
    // 预览 EDI 文本
    await cdp.eval(`(() => { const row = document.querySelector('[data-file-name="test-bol.edi"]'); row.querySelector('.link-btn').click(); })()`)
    await waitFor(cdp, `document.querySelector('[data-testid="doc-drawer"] pre.edi-pre')`, 8000, 'edi preview')
    check('I9 EDI 原文预览（UNB 报文）', await cdp.eval(`document.querySelector('[data-testid="doc-drawer"] pre.edi-pre')?.textContent.includes('UNB+UNOC:3')`))
    await cdp.eval(`document.querySelector('[data-testid="doc-drawer"] .close').click()`)

    /* ===== J. 上传拒绝路径 ===== */
    await setFileInput(cdp, [
      path.join(FIXTURES, 'empty.pdf'),
      path.join(FIXTURES, 'notes.xyz'),
      path.join(FIXTURES, 'huge.pdf'),
    ])
    await waitFor(cdp, `document.querySelectorAll('[data-testid="toast"].error').length >= 3`, 8000, 'rejection toasts')
    check('J1 空文件/不支持类型/超限均被拒绝并提示', await cdp.eval(`(() => { const errs = Array.from(document.querySelectorAll('[data-testid="toast"].error')).map(e => e.textContent); return errs.some(e => e.includes('空文件')) && errs.some(e => e.includes('不支持的文件类型')) && errs.some(e => e.includes('超过 15MB')) })()`))
    check('J2 拒绝后不产生虚假单证', await cdp.eval(`document.querySelectorAll('[data-testid="doc-row"]').length === 2`))

    /* ===== K. 失败重试 ===== */
    if (API_MODE === 'mock') {
      await cdp.eval(`(() => {
        const key = 'logicheck_hifi_v1_demo@logicheck.ai'
        const data = JSON.parse(localStorage.getItem(key))
        const s = data.find(x => !x.isDemo)
        const d = s.documents.find(x => x.fileName === 'test-bol.edi')
        d.status = 'failed'; d.error = '本地文件保存失败'
        localStorage.setItem(key, JSON.stringify(data))
        return true
      })()`)
      await goto(`${BASE}/shipments/${await cdp.eval(`(() => { const key='logicheck_hifi_v1_demo@logicheck.ai'; return JSON.parse(localStorage.getItem(key)).find(x=>!x.isDemo).id })()`)}`)
      await waitFor(cdp, `document.querySelector('[data-file-name="test-bol.edi"]')`, 8000, 'workspace after reload')
      check('K1 失败状态可见 + 重试按钮', await cdp.eval(`(() => { const row = document.querySelector('[data-file-name="test-bol.edi"]'); return row.textContent.includes('处理失败') && !!row.querySelector('[data-testid="retry-doc"]') })()`))
      await cdp.eval(`document.querySelector('[data-file-name="test-bol.edi"] [data-testid="retry-doc"]').click()`)
      await waitFor(cdp, `document.querySelector('[data-file-name="test-bol.edi"]')?.textContent.includes('等待解析')`, 5000, 'retry ok')
      check('K2 重试后恢复为待解析状态', true)
    } else {
      // 真实模式：上传链路只到 uploaded（不伪造失败态）。验证点：
      // ① 重试接口经代理 + 会话 Cookie 可调用且幂等（不产生假解析）；
      // ② 刷新后单证与状态从数据库恢复。
      const retryResult = await cdp.eval(`(async () => {
        const list = await (await fetch('/api/shipments', { credentials: 'include' })).json()
        const own = list.shipments.find(s => !s.isDemo)
        if (!own) return { ok: false, why: 'no-own-shipment' }
        const detail = await (await fetch('/api/shipments/' + own.id, { credentials: 'include' })).json()
        const doc = detail.shipment.documents.find(d => d.fileName === 'test-bol.edi')
        if (!doc) return { ok: false, why: 'no-doc' }
        const res = await fetch('/api/documents/' + doc.id + '/retry', { method: 'POST', credentials: 'include' })
        const body = await res.json().catch(() => null)
        return { ok: res.ok, status: body?.document?.status ?? null, error: body?.document?.error ?? null }
      })()`, true)
      check('K1r 重试接口经会话可调用且幂等（不产生假解析）', retryResult && retryResult.ok === true && retryResult.status === 'uploaded' && !retryResult.error, JSON.stringify(retryResult))
      await goto(`${BASE}${await cdp.eval('location.pathname')}`)
      await waitFor(cdp, `document.querySelector('[data-file-name="test-bol.edi"]')`, 8000, 'workspace after reload')
      // 真实模式：重试会真实重新入队解析，等待终态（IFTMIN 支持 → 已解析）
      await waitFor(cdp, `document.querySelector('[data-file-name="test-bol.edi"]')?.textContent.includes('已解析')`, 10000, 'reparse done')
      check('K2r 刷新后单证与状态从服务端恢复（重试后重新解析完成）', await cdp.eval(`(() => { const row = document.querySelector('[data-file-name="test-bol.edi"]'); return !!row && row.textContent.includes('已解析') })()`))
    }

    /* ===== L. 删除单证 + 删除货物 ===== */
    await cdp.eval(`(() => { const row = document.querySelector('[data-file-name="test-invoice.png"]'); row.querySelector('[data-testid="delete-doc"]').click(); })()`)
    await waitFor(cdp, `document.querySelector('[data-testid="delete-doc-modal"]')`, 5000, 'delete doc modal')
    await cdp.eval(`document.querySelector('[data-testid="confirm-delete-doc"]').click()`)
    await waitFor(cdp, `document.querySelectorAll('[data-testid="doc-row"]').length === 1`, 5000, 'doc removed')
    check('L1 移除单证确认后消失', true)
    await cdp.eval(`window.__t.clickByText('.backlink','返回货物列表')`)
    await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 5000, 'list')
    await cdp.eval(`(() => { const row = document.querySelector('[data-shipment-id]:not([data-shipment-id="SHP-2026-001"])'); row.querySelector('[data-testid="row-menu-button"]').click(); })()`)
    await waitFor(cdp, `document.querySelector('[data-testid="row-menu"]')`, 5000, 'row menu')
    await cdp.eval(`document.querySelector('[data-testid="delete-shipment"]').click()`)
    await waitFor(cdp, `document.querySelector('[data-testid="delete-shipment-modal"]')`, 5000, 'delete modal')
    check('L2 删除货物需二次确认', await cdp.eval(`document.querySelector('[data-testid="delete-shipment-modal"]')?.textContent.includes('删除这票货物')`))
    await cdp.eval(`document.querySelector('[data-testid="confirm-delete-shipment"]').click()`)
    await waitFor(cdp, `document.querySelectorAll('[data-testid="shipment-row"]').length === 1`, 5000, 'shipment deleted')
    check(
      'L3 删除后只剩演示货物',
      API_MODE === 'real'
        ? await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1 && document.body.textContent.includes('已删除')`)
        : await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1 && document.body.textContent.includes('已从本地演示数据中删除')`),
    )

    /* ===== M. 刷新恢复 ===== */
    await goto(`${BASE}/shipments/SHP-2026-001`)
    await waitFor(cdp, `document.querySelector('.workspace-title')`, 8000, 'refresh restore')
    check('M1 刷新工作台 URL 直接恢复（会话保持）', await cdp.eval(`document.querySelector('.workspace-title')?.textContent.includes('蓝牙音箱')`))
    check('M2 重检结果持久化（数量冲突保持已解决）', await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]:not([data-finding-status="resolved"])').length === 2 && !document.body.textContent.includes('商业发票与装箱单数量不一致')`))
    check('M3 人工复核记录持久化（处理记录中留有复核意见）', await cdp.eval(`(() => {
      const btn = Array.from(document.querySelectorAll('.section-link')).find(b => b.textContent.includes('处理记录'))
      if (!btn) return false
      btn.click()
      return true
    })()`) === true)
    await waitFor(cdp, `document.querySelector('[data-testid="activity-drawer"]')`, 5000, 'activity drawer')
    check('M3b 处理记录含人工复核意见', await cdp.eval(`document.querySelector('[data-testid="activity-drawer"]')?.textContent.includes('人工复核')`))
    await cdp.eval(`document.querySelector('[data-testid="activity-drawer"] .close').click()`)

    /* ===== N. 退出 → 重登 ===== */
    await cdp.eval(`document.querySelector('.account').click()`)
    await waitFor(cdp, `document.querySelector('.auth-card')`, 5000, 'logout')
    check('N1 退出回到登录页', await cdp.eval(`location.pathname === '/login'`))
    if (API_MODE === 'mock') {
      await cdp.eval(`(() => { const e = document.querySelector('#email'); window.__t.setNativeValue(e, 'demo@logicheck.ai'); const p = document.querySelector('#password'); window.__t.setNativeValue(p, 'demo1234'); })()`)
      await cdp.eval(`document.querySelector('#authForm button[type="submit"]').click()`)
      await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 're-login')
      check('N2 重登后数据仍在（STORE-01）', await cdp.eval(`document.body.textContent.includes('SHP-2026-001')`))
    } else {
      // 真实模式：演示账号密码为随机值，经后端 API 建立演示会话后重登
      await cdp.eval(`(async () => { const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' }); return r.ok })()`, true)
      await goto(`${BASE}/shipments`)
      await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 're-login')
      check('N2 重登后数据仍在（STORE-01）', await cdp.eval(`document.body.textContent.includes('SHP-2026-001')`))

      /* ===== N2R. 真实模式专项：注册 → 隔离 → 创建 → 刷新 → 密码重登 → 清理 ===== */
      const testEmail = `e2e.user.${Date.now()}@test.local`
      const testPassword = 'test123456'
      await cdp.eval(`document.querySelector('.account').click()`)
      await waitFor(cdp, `document.querySelector('.auth-card')`, 5000, 'logout for register')
      await cdp.eval(`window.__t.clickByText('.text-btn','注册账户')`)
      await waitFor(cdp, `document.body.textContent.includes('创建账户')`, 5000, 'register mode')
      await cdp.eval(`(() => { const e = document.querySelector('#email'); window.__t.setNativeValue(e, '${testEmail}'); const p = document.querySelector('#password'); window.__t.setNativeValue(p, '${testPassword}'); })()`)
      await cdp.eval(`document.querySelector('#authForm button[type="submit"]').click()`)
      await waitFor(cdp, `document.querySelector('[data-testid="new-shipment"]')`, 8000, 'registered list')
      check('N2R1 新注册账户看不到演示账号数据（跨账号隔离）', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 0 && document.body.textContent.includes('还没有货物')`))
      await cdp.eval(`document.querySelector('[data-testid="new-shipment"]').click()`)
      await waitFor(cdp, `document.querySelector('.workspace-title')`, 5000, 'own workspace')
      check('N2R2 创建货物进入空工作台', await cdp.eval(`document.body.textContent.includes('上传第一份单证，开始预检')`))
      await goto(`${BASE}${await cdp.eval('location.pathname')}`)
      await waitFor(cdp, `document.body.textContent.includes('上传第一份单证，开始预检')`, 8000, 'own workspace reload')
      check('N2R3 刷新后工作台与货物从服务端恢复（会话保持）', true)
      await cdp.eval(`window.__t.clickByText('.backlink','返回货物列表')`)
      await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 'own list')
      check('N2R4 列表出现自建货物', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1`))
      // 退出 → 邮箱 + 密码重登 → 数据仍在（真实注册登录闭环）
      await cdp.eval(`document.querySelector('.account').click()`)
      await waitFor(cdp, `document.querySelector('.auth-card')`, 5000, 'logout for re-login')
      await cdp.eval(`(() => { const e = document.querySelector('#email'); window.__t.setNativeValue(e, '${testEmail}'); const p = document.querySelector('#password'); window.__t.setNativeValue(p, '${testPassword}'); })()`)
      await cdp.eval(`document.querySelector('#authForm button[type="submit"]').click()`)
      await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 'password re-login')
      check('N2R5 邮箱+密码重登后自建货物仍在（真实注册登录闭环）', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length === 1`))
      // 清理：删除自建货物（持久化数据库下不留测试垃圾）
      await cdp.eval(`(() => { const row = document.querySelector('[data-testid="shipment-row"]'); row.querySelector('[data-testid="row-menu-button"]').click(); })()`)
      await waitFor(cdp, `document.querySelector('[data-testid="row-menu"]')`, 5000, 'row menu for cleanup')
      await cdp.eval(`document.querySelector('[data-testid="delete-shipment"]').click()`)
      await waitFor(cdp, `document.querySelector('[data-testid="delete-shipment-modal"]')`, 5000, 'delete modal for cleanup')
      await cdp.eval(`document.querySelector('[data-testid="confirm-delete-shipment"]').click()`)
      await waitFor(cdp, `document.querySelectorAll('[data-testid="shipment-row"]').length === 0`, 5000, 'cleanup done')
    }
    // N3：注册引导 —— 需未登录状态，先退出再切换注册模式
    await cdp.eval(`document.querySelector('.account').click()`)
    await waitFor(cdp, `document.querySelector('.auth-card')`, 5000, 'logout for register')
    await cdp.eval(`window.__t.clickByText('.text-btn', ${JSON.stringify(API_MODE === 'real' ? '注册账户' : '注册体验账号')})`)
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(API_MODE === 'real' ? '创建账户' : '创建体验账号')})`, 5000, 'register mode')
    check('N3 注册模式可切换（引导创建账号）', true)

    /* ===== O. 响应式（需未登录状态：已登录访问 /login 会被弹回工作区） ===== */
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await goto(`${BASE}/login`)
    await waitFor(cdp, `!!document.querySelector('.auth-card')`, 8000, 'mobile auth')
    check('O1 移动端登录页单列布局', await cdp.eval(`getComputedStyle(document.querySelector('.auth-screen')).gridTemplateColumns.split(' ').length === 1`))
    await cdp.eval(`(async () => { const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' }); return r.ok })()`, true)
    await goto(`${BASE}/shipments`)
    await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 'mobile list')
    check('O2 移动端侧栏折叠为 58px', await cdp.eval(`getComputedStyle(document.querySelector('.sidebar')).width === '58px'`))
    check('O3 移动端品牌文字隐藏（仅图标）', await cdp.eval(`getComputedStyle(document.querySelector('.brand-word')).display === 'none'`))
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    /* ===== P. 双主题视觉（同样需先退出再走登录页） ===== */
    await cdp.eval(`document.querySelector('.account').click()`)
    await waitFor(cdp, `document.querySelector('.auth-card')`, 5000, 'logout for theme')
    await goto(`${BASE}/login`)
    await waitFor(cdp, `!!document.querySelector('.auth-card')`, 8000, 'light auth')
    await cdp.eval(`document.querySelector('[data-testid="theme-toggle"]').click()`)
    await sleep(300)
    check('P1 浅色主题 body 背景为雾白', await cdp.eval(`getComputedStyle(document.body).backgroundColor === 'rgb(243, 247, 251)'`))
    await cdp.eval(`(async () => { const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' }); return r.ok })()`, true)
    await goto(`${BASE}/shipments`)
    await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 'light list')
    check('P2 浅色下列表页正常渲染（表格/徽章）', await cdp.eval(`!!document.querySelector('.ship-table') && document.body.textContent.includes('待处理异常')`))
    await goto(`${BASE}/shipments`)
    await waitFor(cdp, `document.querySelector('[data-testid="shipment-row"]')`, 8000, 'light list reload')
    check('P3 浅色主题刷新后保持', await cdp.eval(`document.documentElement.dataset.theme === 'light'`))
    await cdp.eval(`document.querySelector('[data-testid="theme-toggle"]').click()`)
    await sleep(200)
    check('P4 切回深色主题', await cdp.eval(`document.documentElement.dataset.theme === 'dark'`))

    /* ===== Q. 控制台错误 ===== */
    check('Q1 全流程无阻断性 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))
  } finally {
    if (cdp) cdp.ws.close()
    chrome.kill()
    stack.teardown()
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败可忽略 */
    }
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n========== 结果：${results.length - failed.length}/${results.length} 通过 ==========`)
  if (failed.length) {
    failed.forEach((f) => console.log(`❌ ${f.name}${f.extra ? '  → ' + f.extra : ''}`))
    // 失败时输出服务端日志尾部，便于定位（4xx/5xx、异常堆栈）
    if (stack.serverLogPath && existsSync(stack.serverLogPath)) {
      const lines = readFileSync(stack.serverLogPath, 'utf8').trim().split('\n')
      const interesting = lines.filter((l) => /"level":(40|50)|error|Error/.test(l)).slice(-12)
      if (interesting.length) {
        console.log('\n---------- 服务端日志（错误相关，末尾 12 条） ----------')
        interesting.forEach((l) => console.log(l.slice(0, 400)))
      }
    }
    process.exit(1)
  }
  process.exit(0)
}

/** 通过 CDP 直接给隐藏 file input 塞文件（触发 change → 走上传通道） */
async function setFileInput(cdp, files) {
  await cdp.send('DOM.enable')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-testid="file-chooser"]',
  })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files })
}

main().catch((err) => {
  console.error('E2E 运行失败：', err)
  process.exit(2)
})
