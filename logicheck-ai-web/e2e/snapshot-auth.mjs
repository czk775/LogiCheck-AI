/* ============================================================
   登录页视觉快照（CDP 无头 Chrome，零依赖）
   用法：node e2e/snapshot-auth.mjs [outDir]
   ============================================================ */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173'
const OUT = process.argv[2] || path.join(process.cwd(), 'e2e', 'snapshots')
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
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }
}

const userDataDir = path.join(tmpdir(), 'logicheck-snap-' + Date.now())
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--remote-debugging-port=9413',
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

try {
  mkdirSync(OUT, { recursive: true })
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9413/json/list')).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(250)
  }
  const cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const shot = async (name, { width, height, mobile = false, theme = null }) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    })
    await cdp.send('Page.navigate', { url: `${BASE}/login` })
    await sleep(1400)
    if (theme) {
      await cdp.eval(
        `(() => { localStorage.setItem('logicheck_theme_v2', '${theme}'); document.documentElement.dataset.theme = '${theme}'; })()`,
      )
      await sleep(400)
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, name + '.png')
    const fs = await import('node:fs')
    fs.writeFileSync(file, Buffer.from(data, 'base64'))
    console.log('✓', file)
  }

  await shot('auth-light-1440', { width: 1440, height: 900, theme: 'light' })
  await shot('auth-dark-1440', { width: 1440, height: 900, theme: 'dark' })
  await shot('auth-light-1920', { width: 1920, height: 1080, theme: 'light' })
  await shot('auth-mobile-390', { width: 390, height: 844, mobile: true, theme: 'light' })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  console.log('\n完成')
} catch (err) {
  console.error('✗ ' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
} finally {
  cleanup()
}
