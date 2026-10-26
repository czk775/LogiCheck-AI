/* ============================================================
 * LogiCheck AI · AI 运行概览页断言（CDP 无头 Chrome，零依赖）
 * ------------------------------------------------------------
 * 覆盖本次新增的可验证契约（Observability + Eval）：
 *   A1  侧边栏「AI 运行概览」入口可进入页面
 *   A2  页面渲染（标题 / 副标题 / 运行指标区）
 *   A3  四项运行指标卡存在（调用 / 成功率 / 耗时 / Token）
 *   A4  「运行评估」按钮存在（真实模式可点）
 *   A5  最近调用记录区（有记录 → 表格；无记录 → 空态）
 *   A6  能力评估区状态正确（空态 / 运行中 / 结果 / 失败 四态之一）
 *   A7  真实模式不显示 Mock 说明横幅
 *   A8  已有评估结果时：三项卡片齐全，准确率与后端 API 返回值
 *       逐字一致（证明不是写死），样本数与耗时真实展示
 *   A9  浅色主题下正常渲染
 *
 * 运行：node e2e/check-ai-overview.mjs
 *   默认对接已在运行的前端（http://127.0.0.1:5173）+ 后端（4000）。
 *   通过页面内 fetch('/api/auth/demo') 建立演示会话（UI 入口已移除）。
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

const userDataDir = path.join(tmpdir(), 'logicheck-ai-overview-' + Date.now())
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--remote-debugging-port=9412',
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
  console.log('\n=== LogiCheck AI · AI 运行概览页断言 ===\n')
  console.log('目标：' + BASE + '\n')

  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9412/json/list')).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(250)
  }
  if (!target) throw new Error('无法连接 Chrome 调试端口（前端是否已启动？）')

  cdp = await CDP.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  const goto = async (url) => {
    await cdp.send('Page.navigate', { url })
    await sleep(1000)
  }

  /* 建立演示会话（与 run-tests.mjs 一致：UI chip 已移除，走 API；需先导航到站点内页面） */
  await goto(`${BASE}/login`)
  const sessionOk = await cdp.eval(`(async () => {
    const r = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' })
    return r.ok
  })()`, true)
  check('A0 演示会话建立成功', sessionOk === true)

  console.log('\n[A1 入口与路由]')
  await goto(`${BASE}/ai-overview`)
  await sleep(600)
  check(
    'A1-1 侧边栏存在「AI 运行概览」入口',
    await cdp.eval(`Array.from(document.querySelectorAll('.nav-link')).some((e) => (e.textContent || '').includes('AI 运行概览'))`),
  )
  check('A1-2 入口处于激活态', await cdp.eval(`Array.from(document.querySelectorAll('.nav-link')).some((e) => (e.textContent || '').includes('AI 运行概览') && e.classList.contains('active'))`))
  check('A1-3 路由直达 /ai-overview', await cdp.eval(`location.pathname === '/ai-overview'`))

  console.log('\n[A2 页面渲染]')
  check('A2-1 页面标题为「AI 运行概览」', await cdp.eval(`document.querySelector('.ai-page h1')?.textContent === 'AI 运行概览'`))
  check('A2-2 运行指标区存在', await cdp.eval(`!!document.querySelector('.ai-metrics')`))

  console.log('\n[A3 运行指标卡]')
  for (const [id, label] of [
    ['ai-metric-calls', 'AI 调用次数'],
    ['ai-metric-success', '调用成功率'],
    ['ai-metric-latency', '平均响应耗时'],
    ['ai-metric-tokens', 'Token 消耗量'],
  ]) {
    check(
      `A3 指标卡「${label}」存在且标签正确`,
      await cdp.eval(`(() => { const el = document.querySelector('[data-testid="${id}"]'); return !!el && (el.textContent || '').includes('${label}') })()`),
    )
  }

  console.log('\n[A4 运行评估按钮]')
  check(
    'A4-1 「运行评估」按钮存在',
    await cdp.eval(`!!document.querySelector('[data-testid="run-ai-eval"]')`),
  )
  check(
    'A4-2 真实模式下按钮可点击（未禁用）',
    await cdp.eval(`!document.querySelector('[data-testid="run-ai-eval"]')?.disabled`),
  )

  console.log('\n[A5 最近调用记录]')
  check(
    'A5-1 有调用记录时展示表格，无记录时展示空态',
    await cdp.eval(`!!(document.querySelector('.ai-calls-table') || document.querySelector('[data-testid="ai-calls-empty"]'))`),
  )
  const hasCallRows = await cdp.eval(`document.querySelectorAll('.ai-calls-table tbody tr').length`)
  if (hasCallRows > 0) {
    check(`A5-2 调用记录表格有数据行（${hasCallRows} 行）`, true)
    check(
      'A5-3 表格含时间/模型/任务/耗时/状态列',
      await cdp.eval(`(() => { const ths = Array.from(document.querySelectorAll('.ai-calls-table thead th')).map((e) => e.textContent); return ['时间','模型','任务类型','耗时','状态'].every((c) => ths.includes(c)) })()`),
    )
  } else {
    console.log('  … 本进程暂无调用记录，跳过表格行断言（未触发过 AI 调用）')
  }

  console.log('\n[A6 能力评估区]')
  check(
    'A6-1 评估区处于合法状态（空态/运行中/结果/失败 之一）',
    await cdp.eval(`!!(document.querySelector('[data-testid="ai-eval-empty"]') || document.querySelector('[data-testid="ai-eval-error"]') || document.querySelector('[data-testid="ai-eval-extraction"]') || document.body.textContent.includes('评估运行中'))`),
  )
  check('A6-2 真实模式无 Mock 说明横幅', await cdp.eval(`!document.querySelector('[data-testid="ai-overview-mock"]')`))

  /* A8：若已有评估结果，逐字核对「不是写死的」 */
  const evalState = await cdp.eval(`(async () => {
    const r = await fetch('/api/system/ai-eval', { credentials: 'include' })
    if (!r.ok) return { httpError: r.status }
    const d = await r.json()
    const rep = d.report
    if (!rep || rep.status !== 'done') return { status: rep ? rep.status : 'none' }
    return {
      status: 'done',
      accuracy: rep.extraction.accuracy,
      samples: rep.samples,
      durationMs: rep.durationMs,
      conflictTotal: rep.conflict.total,
      evidenceTotal: rep.evidence.total,
    }
  })()`, true)

  if (evalState && evalState.status === 'done') {
    console.log('\n[A8 真实评估结果展示]')
    const step = async (name, fn) => { console.log('  … ' + name); return fn() }
    check(
      'A8-1 三项评估卡片齐全（提取 / 冲突 / 证据）',
      await step('A8-1', () => cdp.eval(`!!(document.querySelector('[data-testid="ai-eval-extraction"]') && document.querySelector('[data-testid="ai-eval-conflict"]') && document.querySelector('[data-testid="ai-eval-evidence"]'))`)),
    )
    const expectedPct = `${Math.round(evalState.accuracy * 100)}%`
    check(
      `A8-2 页面准确率（${expectedPct}）与后端 API 返回值逐字一致`,
      await step('A8-2', () => cdp.eval(`(document.querySelector('[data-testid="ai-eval-extraction"] .ai-eval-score')?.textContent || '') === '${expectedPct}'`)),
      '页面显示 ' + (await cdp.eval(`document.querySelector('[data-testid="ai-eval-extraction"] .ai-eval-score')?.textContent`)),
    )
    check(
      `A8-3 展示真实样本数（${evalState.samples} 项）`,
      await step('A8-3', () => cdp.eval(`document.body.textContent.includes('样本 ${evalState.samples} 项') || document.body.textContent.includes('样本 ${evalState.samples.toLocaleString('zh-CN')} 项')`)),
    )
    check(
      'A8-4 展示评估耗时',
      await step('A8-4', () => cdp.eval(`Array.from(document.querySelectorAll('.section-hint')).some((e) => /耗时/.test(e.textContent || ''))`)),
    )
    check(
      `A8-5 冲突用例 ${evalState.conflictTotal} 条全部展示`,
      await step('A8-5', () => cdp.eval(`document.querySelectorAll('[data-testid="ai-eval-conflict"] .ai-case-list li').length === ${evalState.conflictTotal}`)),
      '实际 ' + (await cdp.eval(`document.querySelectorAll('[data-testid="ai-eval-conflict"] .ai-case-list li').length`)),
    )
  } else if (evalState && evalState.status === 'running') {
    console.log('\n[A8 评估运行中] 页面展示运行中状态，跳过结果断言')
    check('A8-0 运行中状态有展示', await cdp.eval(`document.body.textContent.includes('评估运行中') || document.querySelector('[data-testid="run-ai-eval"]')?.textContent?.includes('评估运行中')`))
  } else {
    console.log('\n[A8 尚无评估结果] 后端未运行过评估（status=' + (evalState && evalState.status) + '），跳过结果断言')
  }

  console.log('\n[A9 浅色主题]')
  await cdp.eval(`(() => { document.documentElement.dataset.theme = 'light'; return true })()`)
  await sleep(400)
  check(
    'A9-1 浅色主题下指标卡为浅色渐变背景',
    await cdp.eval(`(() => { const s = getComputedStyle(document.querySelector('.ai-metric')); const bg = s.backgroundImage || ''; const m = bg.match(/rgb\\((\\d+), (\\d+), (\\d+)\\)/); return !!m && (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 > 230 })()`),
    '实际 ' + (await cdp.eval(`getComputedStyle(document.querySelector('.ai-metric')).backgroundImage`)),
  )
  check(
    'A9-2 浅色主题下标题文字可读（非纯白）',
    await cdp.eval(`(() => { const c = getComputedStyle(document.querySelector('.ai-page h1')).color; const m = c.match(/\\d+/g); return !!m && (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 150 })()`),
    '实际 ' + (await cdp.eval(`getComputedStyle(document.querySelector('.ai-page h1')).color`)),
  )

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
