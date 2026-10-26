/** 调试4：K 步骤 —— 注入失败状态 + 刷新工作台 URL */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
      ws.onerror = () => rej(new Error('ws fail'))
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
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
}

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const FIXTURES = path.resolve('e2e/fixtures')
const userDataDir = mkdtempSync(path.join(tmpdir(), 'lc-debug4-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=9337', `--user-data-dir=${userDataDir}`, 'about:blank'],
  { stdio: 'ignore' },
)

async function setFileInput(cdp, files) {
  await cdp.send('DOM.enable')
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="file-chooser"]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files })
}

let cdp = null
try {
  let wsUrl = null
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9337/json/list')).json()
      const page = list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)
      if (page) {
        wsUrl = page.webSocketDebuggerUrl
        break
      }
    } catch {}
    await sleep(250)
  }
  cdp = await CDP.connect(wsUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  const errs = []
  cdp.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  })

  // 登录 → 新建货物 → 上传（演示账号经后端 API 建立会话，UI 入口已按产品化要求移除）
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/login' })
  await sleep(1200)
  await cdp.eval(`(async () => { const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' }); return r.ok })()`, true)
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/shipments' })
  await sleep(1200)
  await cdp.eval(`document.querySelector('[data-testid="new-shipment"]').click()`)
  await sleep(1200)
  await setFileInput(cdp, [path.join(FIXTURES, 'test-invoice.png'), path.join(FIXTURES, 'test-bol.edi')])
  await sleep(2500)
  console.log('rows before patch:', await cdp.eval(`Array.from(document.querySelectorAll('[data-testid="doc-row"]')).map(r => r.getAttribute('data-file-name') + ':' + r.querySelector('.chip')?.textContent).join(' | ')`))

  // 注入失败状态
  const patched = await cdp.eval(`(() => {
    const key = 'logicheck_hifi_v1_demo@logicheck.ai'
    const data = JSON.parse(localStorage.getItem(key))
    const s = data.find(x => !x.isDemo)
    if (!s) return 'NO_NON_DEMO'
    const d = s.documents.find(x => x.fileName === 'test-bol.edi')
    if (!d) return 'NO_DOC'
    d.status = 'failed'; d.error = '本地文件保存失败'
    localStorage.setItem(key, JSON.stringify(data))
    return 'OK:' + s.id
  })()`)
  console.log('patch result:', patched)

  const targetId = patched.split(':')[1]
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/shipments/' + targetId })
  // 导航后立即探测存储状态（此时 app 可能尚未水合完成）
  await sleep(300)
  console.log('storage probe:', await cdp.eval(`JSON.stringify({
    lsKey: (localStorage.getItem('logicheck_hifi_v1_demo@logicheck.ai') || '').slice(0, 80),
    lsLen: (localStorage.getItem('logicheck_hifi_v1_demo@logicheck.ai') || '').length,
    lsParsed: (() => { try { return JSON.parse(localStorage.getItem('logicheck_hifi_v1_demo@logicheck.ai')).map(x => x.id).join(',') } catch (e) { return 'PARSE_FAIL:' + e.message } })(),
    session: sessionStorage.getItem('logicheck_account'),
  })`))
  for (let i = 0; i < 10; i++) {
    await sleep(500)
    const state = await cdp.eval(`JSON.stringify({
      path: location.pathname,
      rows: document.querySelectorAll('[data-testid="doc-row"]').length,
      listRows: document.querySelectorAll('[data-testid="shipment-row"]').length,
      hasBOL: !!document.querySelector('[data-file-name="test-bol.edi"]'),
      workspace: !!document.querySelector('.workspace-title'),
      sidebarAccount: (document.querySelector('.sys-card')?.textContent || document.body.textContent).replace(/\\s+/g, ' ').slice(0, 100),
      bodyHead: document.body.textContent.replace(/\\s+/g, ' ').slice(0, 120),
    })`)
    console.log(`t=${((i + 1) * 0.5).toFixed(1)}s`, state)
    if (state.includes('"hasBOL":true')) break
  }
  console.log('errors:', JSON.stringify(errs, null, 2))
} finally {
  if (cdp) cdp.ws.close()
  chrome.kill()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
