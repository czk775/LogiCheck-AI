/** 调试2：复刻完整套件的前置步骤，定位 B1 超时原因 */
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
const userDataDir = mkdtempSync(path.join(tmpdir(), 'lc-debug2-'))
const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=9335', `--user-data-dir=${userDataDir}`, 'about:blank'],
  { stdio: 'ignore' },
)

let cdp = null
try {
  let wsUrl = null
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9335/json/list')).json()
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
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      errs.push('console.' + m.params.type + ': ' + (m.params.args?.[0]?.value || m.params.args?.[0]?.description || ''))
    }
  })

  const helpers = `
  window.__t = {
    clickByText(selector, text) {
      const el = Array.from(document.querySelectorAll(selector)).find((e) => (e.textContent || '').includes(text))
      if (!el) return false
      el.click()
      return true
    },
  }`
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:5173/login' })
  await sleep(1200)
  await cdp.eval(helpers)

  console.log('step1 open forgot:', await cdp.eval(`window.__t.clickByText('.text-btn','忘记密码')`))
  await sleep(400)
  console.log('step2 modal:', await cdp.eval(`!!document.querySelector('[data-testid="forgot-password-modal"]')`))
  console.log('step3 close:', await cdp.eval(`(() => { const b = document.querySelector('[data-testid="forgot-password-modal"] .close'); b.click(); return true })()`))
  await sleep(400)
  console.log('step4 modal gone:', await cdp.eval(`!document.querySelector('[data-testid="forgot-password-modal"]')`))
  console.log('step5 toggle1:', await cdp.eval(`(() => { document.querySelector('[data-testid="theme-toggle"]').click(); return true })()`))
  await sleep(300)
  console.log('step6 theme:', await cdp.eval(`document.documentElement.dataset.theme`))
  console.log('step7 toggle2:', await cdp.eval(`(() => { document.querySelector('[data-testid="theme-toggle"]').click(); return true })()`))
  await sleep(300)
  console.log('step8 theme:', await cdp.eval(`document.documentElement.dataset.theme`))
  console.log('step9 demo click:', await cdp.eval(`window.__t.clickByText('.btn','一键体验演示案例')`))
  await sleep(2500)
  console.log('step10 pathname:', await cdp.eval(`location.pathname`))
  console.log('step11 rows:', await cdp.eval(`document.querySelectorAll('[data-testid="shipment-row"]').length`))
  console.log('step12 demo btn still there:', await cdp.eval(`!!Array.from(document.querySelectorAll('.btn')).find(e => e.textContent.includes('一键体验演示案例'))`))
  console.log('step13 body head:', (await cdp.eval(`document.body.textContent.slice(0, 200)`))?.replace(/\s+/g, ' '))
  console.log('errors:', JSON.stringify(errs, null, 2))
} finally {
  if (cdp) cdp.ws.close()
  chrome.kill()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
