/** 调试3：上传后状态机是否推进到「待真实 AI 解析」 */
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
const userDataDir = mkdtempSync(path.join(tmpdir(), 'lc-debug3-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=9336', `--user-data-dir=${userDataDir}`, 'about:blank'],
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
      const list = await (await fetch('http://127.0.0.1:9336/json/list')).json()
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

  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/login' })
  await sleep(1200)
  await cdp.eval(`(() => { const b = Array.from(document.querySelectorAll('.btn')).find(e => e.textContent.includes('一键体验演示案例')); b.click(); return true })()`)
  await sleep(1500)
  await cdp.eval(`document.querySelector('[data-testid="new-shipment"]').click()`)
  await sleep(1200)
  console.log('workspace:', await cdp.eval(`!!document.querySelector('[data-testid="upload-zone"]')`))
  await setFileInput(cdp, [path.join(FIXTURES, 'test-invoice.png'), path.join(FIXTURES, 'test-bol.edi')])
  for (let i = 0; i < 14; i++) {
    await sleep(500)
    const info = await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="doc-row"]'))
      const toasts = Array.from(document.querySelectorAll('[data-testid="toast"]')).map(t => t.textContent.trim())
      return JSON.stringify({
        rows: rows.map(r => r.querySelector('.doc-info strong')?.textContent + ' | ' + (r.querySelector('.chip')?.textContent || '')),
        toasts,
      })
    })()`)
    console.log(`t=${((i + 1) * 0.5).toFixed(1)}s`, info)
    if (info.includes('待真实 AI 解析')) break
  }
  console.log('localStorage docs:', await cdp.eval(`(() => {
    const key = Object.keys(localStorage).find(k => k.startsWith('logicheck_hifi_v1_'))
    const data = JSON.parse(localStorage.getItem(key))
    const s = data.find(x => !x.isDemo)
    return JSON.stringify(s.documents.map(d => ({ f: d.fileName, s: d.status })))
  })()`))
  console.log('errors:', JSON.stringify(errs, null, 2))
} finally {
  if (cdp) cdp.ws.close()
  chrome.kill()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
