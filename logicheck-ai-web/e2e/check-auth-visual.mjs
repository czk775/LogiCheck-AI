/* ============================================================
 * LogiCheck AI · 登录页视觉与动效断言（CDP 无头 Chrome，零依赖）
 * ------------------------------------------------------------
 * 覆盖本次改动的可验证契约：
 *   V1  场景层存在（地球 / 航线 / 货轮港口 / 粒子）
 *   V2  悬浮单证卡片已移除（含连接线 / 扫描动效）
 *   V3  动效真的在跑（地球旋转、航线流动、粒子漂移）
 *   V4  半成品说明性文字已移除（演示账号入口 / 体验指南 / 环境标注等）
 *   V5  旧的「一键体验演示案例」按钮已移除
 *   V6  卡片底部身份说明提示框已移除
 *   V7  prefers-reduced-motion: reduce 时所有动效关闭
 *   V8  登录表单功能未被破坏（字段 / 提交 / 主题切换）
 *   V9  登录卡片液态玻璃
 *
 * 运行：node e2e/check-auth-visual.mjs
 *   默认对接已在运行的前端（http://127.0.0.1:5173）。
 *   BASE_URL 可覆盖；未启动时先跑 `npm run dev`。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173'
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
let passed = 0
let failed = 0
function check(name, ok, extra) {
  if (ok) {
    passed += 1
    console.log('  ✓ ' + name)
  } else {
    failed += 1
    console.error('  ✗ ' + name + (extra ? '  →  ' + extra : ''))
  }
}

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
  async eval(expr, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: !!awaitPromise,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面内报错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }
}

async function waitHttp(url, timeout) {
  const start = Date.now()
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* 未就绪 */
    }
    if (Date.now() - start > timeout) return false
    await sleep(300)
  }
}

const PAGE_HELPERS = `
window.__t = {
  setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el)
    const desc = Object.getOwnPropertyDescriptor(proto, 'value')
    desc.set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
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

const userDataDir = path.join(tmpdir(), 'logicheck-auth-visual-' + Date.now())
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--remote-debugging-port=9411',
  '--user-data-dir=' + userDataDir,
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' })

let cdp
const cleanup = () => {
  try {
    chrome.kill()
  } catch {
    /* 已退出 */
  }
}
process.on('exit', cleanup)

try {
  console.log('\n=== LogiCheck AI · 登录页视觉与动效断言 ===\n')
  console.log('目标：' + BASE + '\n')

  if (!(await waitHttp(BASE, 15000))) {
    console.error('✗ 前端未启动：请先在 logicheck-ai-web 执行 npm run dev')
    process.exit(2)
  }

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9411/json/list')).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('无法连接 Chrome 调试端口')

  cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url })
    await sleep(900)
    await cdp.eval(PAGE_HELPERS)
  }

  /* ===== 登录页视觉 ===== */
  console.log('[V1 场景层]')
  await goto(`${BASE}/login`)
  await sleep(1200)

  check('V1-1 场景层容器存在', await cdp.eval(`!!document.querySelector('.auth-scene')`))
  check('V1-2 数字地球 SVG 存在', await cdp.eval(`!!document.querySelector('.auth-scene .scene-globe')`))
  check(
    'V1-3 国际物流航线存在（至少 3 条）',
    await cdp.eval(`document.querySelectorAll('.auth-scene .scene-route').length >= 3`),
    '实际 ' + (await cdp.eval(`document.querySelectorAll('.auth-scene .scene-route').length`)),
  )
  check('V1-4 货轮与港口剪影存在', await cdp.eval(`!!document.querySelector('.auth-scene .scene-harbor')`))
  check(
    'V1-5 背景粒子存在（至少 8 个）',
    await cdp.eval(`document.querySelectorAll('.auth-scene .scene-particle').length >= 8`),
    '实际 ' + (await cdp.eval(`document.querySelectorAll('.auth-scene .scene-particle').length`)),
  )

  console.log('\n[V2 单证卡片已移除]')
  check(
    'V2-1 场景层中无悬浮单证卡片',
    await cdp.eval(`document.querySelectorAll('.auth-scene .scene-doc-card').length === 0`),
    '实际 ' + (await cdp.eval(`document.querySelectorAll('.auth-scene .scene-doc-card').length`)),
  )
  check(
    'V2-2 场景层中无卡片连接线与扫描动效',
    await cdp.eval(`document.querySelectorAll('.auth-scene .scene-link, .auth-scene .doc-card-scan').length === 0`),
  )
  check(
    'V2-3 登录页文本不再出现 Invoice / Packing List',
    await cdp.eval(`(() => {
      const t = document.body.textContent || ''
      return !/Invoice/i.test(t) && !/Packing List/i.test(t)
    })()`),
  )

  console.log('\n[V3 动效在运行]')
  check(
    'V3-1 地球有旋转动画',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-globe-rotor')
      if (!el) return false
      const a = getComputedStyle(el).animationName
      return a && a !== 'none'
    })()`),
  )
  check(
    'V3-3 航线有流动动画',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-route')
      if (!el) return false
      const a = getComputedStyle(el).animationName
      return a && a !== 'none'
    })()`),
  )
  check(
    'V3-4 粒子有漂移动画',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-particle')
      if (!el) return false
      const a = getComputedStyle(el).animationName
      return a && a !== 'none'
    })()`),
  )

  console.log('\n[V4 半成品说明性文字已移除]')
  check('V4-1 预置演示账号入口已移除', await cdp.eval(`!document.querySelector('[data-testid="demo-account"]')`))
  check(
    'V4-2 登录页不含演示账号相关文案',
    await cdp.eval(`(() => {
      const t = document.body.textContent || ''
      return !t.includes('预置演示账号') && !t.includes('进入示例数据')
    })()`),
  )
  check(
    'V4-3 认证声明 / 副标题 / 环境眉头已移除',
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

  console.log('\n[V5/V6 旧演示元素]')
  check(
    'V5-1 旧的「一键体验演示案例」按钮已移除',
    await cdp.eval(`!document.body.textContent.includes('一键体验演示案例')`),
  )
  check('V6-1 卡片底部身份说明提示框已移除', await cdp.eval(`!document.querySelector('.auth-note')`))

  console.log('\n[V8 登录功能未破坏]')
  check('V8-1 邮箱字段存在', await cdp.eval(`!!document.querySelector('#email')`))
  check('V8-2 密码字段存在', await cdp.eval(`!!document.querySelector('#password')`))
  check('V8-3 提交按钮存在', await cdp.eval(`!!document.querySelector('#authForm button[type="submit"]')`))
  check('V8-4 主题切换按钮存在', await cdp.eval(`!!document.querySelector('[data-testid="theme-toggle"]')`))
  check(
    'V8-5 主题切换可用（浅色 → 深色）',
    await cdp.eval(`(() => {
      const before = document.documentElement.dataset.theme
      document.querySelector('[data-testid="theme-toggle"]').click()
      return before
    })()`).then(async (before) => {
      // React 状态更新异步，等渲染与 useEffect 落盘后再读
      for (let i = 0; i < 20; i++) {
        await sleep(100)
        if ((await cdp.eval(`document.documentElement.dataset.theme`)) !== before) break
      }
      return (await cdp.eval(`document.documentElement.dataset.theme`)) !== before
    }),
  )

  console.log('\n[V9 登录卡片液态玻璃]')
  check(
    'V9-1 登录卡片有背景模糊（backdrop-filter）',
    await cdp.eval(`(() => {
      const s = getComputedStyle(document.querySelector('.auth-card'))
      return /blur/.test(s.backdropFilter || s.webkitBackdropFilter || '')
    })()`),
  )
  check(
    'V9-2 登录卡片背景为半透明',
    await cdp.eval(`(() => {
      const bg = getComputedStyle(document.querySelector('.auth-card')).backgroundImage || ''
      return bg.includes('rgba(') && (bg.includes(', 0.') || bg.includes(',0.'))
    })()`),
  )
  check(
    'V9-3 输入框文字仍清晰可辨（字段有自己的背景）',
    await cdp.eval(`(() => {
      const f = document.querySelector('#email')
      return !!f && getComputedStyle(f).backgroundColor !== 'rgba(0, 0, 0, 0)'
    })()`),
  )

  /* ===== V7 prefers-reduced-motion ===== */
  console.log('\n[V7 减少动画偏好]')
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  })
  await goto(`${BASE}/login`)
  await sleep(900)
  check(
    'V7-1 减少动画下地球旋转关闭',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-globe-rotor')
      if (!el) return true
      const a = getComputedStyle(el).animationName
      return !a || a === 'none'
    })()`),
  )
  check(
    'V7-2 减少动画下航线流动关闭',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-route')
      if (!el) return true
      const a = getComputedStyle(el).animationName
      return !a || a === 'none'
    })()`),
  )
  check(
    'V7-3 减少动画下粒子漂移关闭',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-particle')
      if (!el) return true
      const a = getComputedStyle(el).animationName
      return !a || a === 'none'
    })()`),
  )
  check(
    'V7-4 减少动画下地球漂浮关闭',
    await cdp.eval(`(() => {
      const el = document.querySelector('.auth-scene .scene-globe')
      if (!el) return true
      const a = getComputedStyle(el).animationName
      return !a || a === 'none'
    })()`),
  )
  await cdp.send('Emulation.setEmulatedMedia', { features: [] })

  console.log('\n=== 结果 ===')
  console.log(`通过 ${passed} / ${passed + failed}`)
  if (failed > 0) {
    console.error(`失败 ${failed} 项`)
    process.exitCode = 1
  }
} catch (err) {
  console.error('\n✗ 脚本异常：' + (err instanceof Error ? err.message : String(err)))
  process.exitCode = 1
} finally {
  cleanup()
}
