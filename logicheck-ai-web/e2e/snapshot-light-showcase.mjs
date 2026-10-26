/* ============================================================
   浅色主题作品集截图（CDP 无头 Chrome，零依赖）
   截：货物列表 / SHP-2026-003 工作台 / SHP-2026-004 异常抽屉
   用法：node e2e/snapshot-light-showcase.mjs
   环境变量：SNAP_EMAIL / SNAP_PASSWORD
   ============================================================ */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173'
const OUT = process.argv[2] || path.resolve(process.cwd(), '../screenshots')
const EMAIL = process.env.SNAP_EMAIL
const PASSWORD = process.env.SNAP_PASSWORD
if (!EMAIL || !PASSWORD) {
  console.error('✗ 需要 SNAP_EMAIL / SNAP_PASSWORD 环境变量')
  process.exit(2)
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
  console.error('✗ 未找到 Chrome / Edge')
  process.exit(2)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      ws.onerror = () => rej(new Error('ws 连接失败'))
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }
}

const userDataDir = path.join(tmpdir(), 'logicheck-snaplight-' + Date.now())
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=9415',
    '--user-data-dir=' + userDataDir,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
const cleanup = () => {
  try {
    chrome.kill()
  } catch {
    /* 已退出 */
  }
}
process.on('exit', cleanup)

async function waitFor(cdp, expr, timeout, label) {
  const start = Date.now()
  for (;;) {
    if (await cdp.eval(`!!(${expr})`)) return
    if (Date.now() - start > timeout) throw new Error('等待超时: ' + label)
    await sleep(300)
  }
}

try {
  mkdirSync(OUT, { recursive: true })
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9415/json/list')).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('Chrome 调试端口未就绪')
  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  /* 视口 1440x900（与登录页浅色截图一致） */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url })
    await sleep(1200)
  }
  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, name)
    writeFileSync(file, Buffer.from(data, 'base64'))
    console.log('✓', file)
  }

  /* 1. 登录页：先把主题固定为浅色再刷新，保证全程浅色 */
  await goto(`${BASE}/login`)
  await waitFor(cdp, `document.querySelector('#authForm')`, 15000, 'auth form')
  await cdp.eval(`(() => {
    localStorage.setItem('logicheck_theme_v2', 'light')
    document.documentElement.dataset.theme = 'light'
  })()`)
  await goto(`${BASE}/login`)
  await waitFor(cdp, `document.documentElement.dataset.theme === 'light' && document.querySelector('#authForm')`, 15000, 'light auth form')

  /* 2. UI 登录（真实账号） */
  await cdp.eval(`(() => {
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    setVal(document.querySelector('#email'), ${JSON.stringify(EMAIL)})
    setVal(document.querySelector('#password'), ${JSON.stringify(PASSWORD)})
  })()`)
  await cdp.eval(`document.querySelector('#authForm button[type="submit"]').click()`)
  await waitFor(cdp, `location.pathname === '/shipments'`, 15000, 'redirect to /shipments')
  await waitFor(cdp, `document.querySelectorAll('[data-testid="shipment-row"]').length >= 3`, 15000, 'shipment rows')

  /* 3. 货物列表（浅色），等登录提示浮层消失再截 */
  await waitFor(cdp, `document.documentElement.dataset.theme === 'light'`, 5000, 'list light theme')
  try {
    await waitFor(cdp, `!document.body.textContent.includes('已登录，货物数据已从服务器同步')`, 12000, 'login toast gone')
  } catch {
    /* 浮层未出现也无妨 */
  }
  await sleep(600)
  await shot('ship-list.png')

  /* 4. SHP-2026-003 工作台（浅色） */
  await goto(`${BASE}/shipments/SHP-2026-003`)
  await waitFor(cdp, `document.querySelector('.workspace-title')`, 15000, 'workspace 003')
  await waitFor(cdp, `document.documentElement.dataset.theme === 'light'`, 5000, 'ws light theme')
  await sleep(800)
  await shot('ship-003-workspace.png')

  /* 5. SHP-2026-004 工作台 + 异常抽屉（浅色） */
  await goto(`${BASE}/shipments/SHP-2026-004`)
  await waitFor(cdp, `document.querySelector('[data-testid="issue-item"]')`, 15000, 'issue items')
  await cdp.eval(`document.querySelectorAll('[data-testid="issue-item"]')[0].click()`)
  await waitFor(cdp, `document.querySelector('[data-testid="issue-drawer"]')`, 8000, 'issue drawer')
  await sleep(800)
  await shot('ship-004-issue-drawer.png')

  console.log('\n全部完成（浅色主题 3 张）')
} catch (err) {
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
} finally {
  cleanup()
}
