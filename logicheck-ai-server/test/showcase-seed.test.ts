/* ============================================================
   演示账号展示数据种子测试（公网演示环境）
   ------------------------------------------------------------
   验收点：
   - 5 个独立演示账号，配置密码都能登录（无需注册）
   - 每个账号 3–5 票历史货物，且每票都有单证 / 字段 / 异常 /
     处理记录 / 活动流水 / 规则预检结果
   - 原件真实落盘：/api/documents/:id/content 能取回，且 MIME 正确
   - 幂等：重启后不重复插入，账号数量与货物数量不变
   - 数据隔离：各账号只能看到自己的货物
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'
import { SHOWCASE_ACCOUNTS } from '../src/modules/demo/showcase.ts'
import { resolve } from 'node:path'

const DEMO_PASS = 'judge-pass-2026'
let env: TestEnv
/** 账号 → 已登录客户端（登录有每 IP 限流，全文件只登录一轮） */
const clients = new Map<string, ReturnType<TestEnv['client']>>()

test.before(async () => {
  env = await createTestEnv({
    demoPassword: DEMO_PASS,
    seedShowcase: true,
    fixtureDirs: [resolve(process.cwd(), '..'), process.cwd()],
  })
  for (const account of SHOWCASE_ACCOUNTS) {
    const c = env.client()
    const res = await c.post('/api/auth/login', { email: account.email, password: DEMO_PASS })
    assert.equal(res.status, 200, `${account.email} 登录失败：${res.text}`)
    clients.set(account.email, c)
  }
})

test.after(async () => {
  await env.cleanup()
})

test('SHOWCASE1 5 个演示账号都能用配置密码登录', async () => {
  for (const account of SHOWCASE_ACCOUNTS) {
    const c = clients.get(account.email)
    assert.ok(c, `${account.email} 未取得登录会话`)
    const me = await c.get('/api/auth/session')
    assert.equal(me.status, 200, `${account.email} 会话无效`)
    assert.equal((me.json as { session: { email: string } }).session.email, account.email)
  }
})

test('SHOWCASE2 每个账号 3–5 票历史货物，且各账号只看到自己的', async () => {
  for (const account of SHOWCASE_ACCOUNTS) {
    const c = clients.get(account.email)!
    const res = await c.get('/api/shipments')
    assert.equal(res.status, 200)
    const list = (res.json as { shipments: Array<{ id: string }> }).shipments
    const own = list.filter((s) => s.id.startsWith('SHP-DEMO-'))
    assert.ok(own.length >= 3 && own.length <= 5, `${account.email} 历史货物数量 ${own.length}（应为 3–5）`)
    // 数据隔离：不含其他账号的演示货物
    const foreign = own.filter((s) => !account.shipments.some((x) => x.id === s.id))
    assert.deepEqual(foreign, [], `${account.email} 看到了不属于自己的货物`)
  }
})

test('SHOWCASE3 每票货物都有单证 / 字段 / 异常 / 预检 / 处理记录 / 活动', async () => {
  const c = clients.get('demo@logicheck.ai')!
  for (const spec of SHOWCASE_ACCOUNTS[0].shipments) {
    const detail = await c.get(`/api/shipments/${spec.id}`)
    assert.equal(detail.status, 200, `${spec.id} 详情读取失败`)
    const s = (
      detail.json as {
        shipment: {
          documents: Array<{ id: string; fields: Record<string, string>; status: string }>
          profile: Record<string, string>
          findings: Array<{ id: string; notes: unknown[] }>
          runs: unknown[]
          activities: unknown[]
        }
      }
    ).shipment
    assert.ok(s.documents.length >= 2, `${spec.id} 单证不足`)
    assert.ok(s.documents.every((d) => d.status === 'parsed'), `${spec.id} 存在未解析单证`)
    assert.ok(Object.keys(s.profile).length > 0, `${spec.id} 缺货物档案`)
    assert.ok(s.findings.length >= 1, `${spec.id} 缺异常记录`)
    assert.ok(s.runs.length >= 1, `${spec.id} 缺处理记录`)
    assert.ok(s.activities.length >= 2, `${spec.id} 缺活动流水`)

    const checks = await c.get(`/api/shipments/${spec.id}/check-results`)
    assert.equal(checks.status, 200)
    const results = (checks.json as { results: Array<{ ruleKey: string }> }).results
    assert.equal(results.length, 5, `${spec.id} 规则预检应为 5 条，实际 ${results.length}`)
  }
})

test('SHOWCASE4 原件真实落盘，可取回且 MIME 正确', async () => {
  const c = clients.get('demo@logicheck.ai')!
  const detail = await c.get('/api/shipments/SHP-DEMO-101')
  const docs = (detail.json as { shipment: { documents: Array<{ id: string; format: string }> } }).shipment.documents
  assert.ok(docs.length >= 2)
  for (const doc of docs) {
    const res = await c.get(`/api/documents/${doc.id}/content`)
    assert.equal(res.status, 200, `${doc.id} 原件取回失败`)
    assert.ok(res.raw.headers.get('content-type'), `${doc.id} 缺 Content-Type`)
    const expect = doc.format === 'edi' ? 'text/plain' : 'application/pdf'
    assert.ok(
      (res.raw.headers.get('content-type') ?? '').includes(expect),
      `${doc.id} MIME 应为 ${expect}，实际 ${res.raw.headers.get('content-type')}`,
    )
    assert.ok(res.text.length > 100, `${doc.id} 内容为空`)
  }
})

test('SHOWCASE5 重启幂等：账号与货物不重复', async () => {
  await env.restart()
  for (const account of SHOWCASE_ACCOUNTS) {
    const users = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?', account.email)
    assert.equal(users?.n ?? 0, 1, `${account.email} 应只有一条账号记录`)
  }
  const demoCount = env.db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM shipments WHERE id LIKE 'SHP-DEMO-%' AND user_id = (SELECT id FROM users WHERE email = 'demo@logicheck.ai')",
  )
  assert.equal(demoCount?.n ?? 0, SHOWCASE_ACCOUNTS[0].shipments.length, '重启后演示货物不应重复插入')
  const total = env.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM shipments WHERE id LIKE 'SHP-DEMO-%'")
  const expected = SHOWCASE_ACCOUNTS.reduce((acc, a) => acc + a.shipments.length, 0)
  assert.equal(total?.n ?? 0, expected, `演示货物总数应为 ${expected}`)
})
