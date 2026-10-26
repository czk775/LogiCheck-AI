/* ============================================================
   公网防滥用保护测试（TDD RED → GREEN）
   ------------------------------------------------------------
   背景：项目要发布到公网，任何人都能访问。AI 调用按量计费，
   必须有三层保护，且保护不能打断正常演示流程：
   1. 单账号每日 AI 解析份数配额（超限 → 单证标记失败 + 友好原因，不崩不静默）
   2. 上传频率限制（每账号每分钟 N 次，超限 429）
   3. 全局 API 频率限制（每 IP 每分钟 N 次，健康检查豁免）
   deterministic 模式不消耗配额；配额按天重置；账号间互不影响。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../src/db/index.ts'
import { migrate } from '../src/db/migrate.ts'
import { AiQuota } from '../src/core/aiQuota.ts'
import { createTestEnv, type TestEnv } from './helpers.ts'

/* ---------- 单元：AiQuota 纯配额逻辑 ---------- */

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-quota-'))
  const db = openDatabase(join(dir, 'q.db'))
  migrate(db) // 配额表由迁移创建（与生产启动路径一致）
  return { db, dir }
}

test('ABUSE1 配额用尽后拒绝：limit=2 时第 3 次返回 false', () => {
  const { db, dir } = tempDb()
  try {
    const q = new AiQuota(db, { limit: 2, today: () => '2026-10-26' })
    assert.equal(q.consume('usr-a'), true)
    assert.equal(q.consume('usr-a'), true)
    assert.equal(q.consume('usr-a'), false)
    assert.equal(q.remaining('usr-a'), 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ABUSE2 配额按天重置：同账号第二天恢复', () => {
  const { db, dir } = tempDb()
  try {
    let day = '2026-10-26'
    const q = new AiQuota(db, { limit: 1, today: () => day })
    assert.equal(q.consume('usr-a'), true)
    assert.equal(q.consume('usr-a'), false)
    day = '2026-10-27'
    assert.equal(q.consume('usr-a'), true, '跨天后应恢复配额')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ABUSE3 不同账号配额互不影响', () => {
  const { db, dir } = tempDb()
  try {
    const q = new AiQuota(db, { limit: 1, today: () => '2026-10-26' })
    assert.equal(q.consume('usr-a'), true)
    assert.equal(q.consume('usr-a'), false)
    assert.equal(q.consume('usr-b'), true, '其他账号不受影响')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ABUSE4 limit=0 表示不限制（永远放行）', () => {
  const { db, dir } = tempDb()
  try {
    const q = new AiQuota(db, { limit: 0, today: () => '2026-10-26' })
    for (let i = 0; i < 100; i++) assert.equal(q.consume('usr-a'), true)
    assert.equal(q.remaining('usr-a'), Number.POSITIVE_INFINITY)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- 集成：上传链路配额防护 ---------- */

function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
}

function uploadForm(name: string): FormData {
  const fd = new FormData()
  fd.append('files', new Blob([pngBytes()], { type: 'image/png' }), name)
  return fd
}

async function registerAndLogin(env: TestEnv, email: string) {
  const c = env.client()
  const res = await c.post('/api/auth/register', { email, password: 'super-secret-123' })
  assert.equal(res.status, 201, res.text)
  return c
}

async function createShipment(env: TestEnv, c: ReturnType<typeof env.client>) {
  const res = await c.post('/api/shipments', { name: '防滥用测试货物' })
  assert.equal(res.status, 201, res.text)
  return (res.json as { shipment: { id: string } }).shipment.id
}

test('ABUSE5 AI 配额耗尽：第 3 份上传成功落库但标记失败 + 友好原因', async () => {
  const env = await createTestEnv({ extractionProvider: 'ai', ai: null, aiDailyParseLimit: 2 })
  try {
    const c = await registerAndLogin(env, 'quota@example.com')
    const sid = await createShipment(env, c)
    // 前两份正常入队（无 Key → 明确失败，与配额无关）
    for (let i = 1; i <= 2; i++) {
      const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm(`ok-${i}.png`))
      assert.equal(res.status, 201, res.text)
    }
    // 第三份：上传接口照常成功（文件落盘保留），但文档标记失败 + 配额原因
    const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm('blocked.png'))
    assert.equal(res.status, 201, res.text)
    const doc = (res.json as { accepted: Array<{ status: string; error?: string }> }).accepted[0]
    assert.equal(doc.status, 'failed')
    assert.match(doc.error ?? '', /今日 AI 解析次数已用完/)
    assert.match(doc.error ?? '', /文件已保留|重新解析|明天/)
    await env.waitForParseIdle()
  } finally {
    await env.cleanup()
  }
})

test('ABUSE6 deterministic 模式不受 AI 配额限制（连传 3 份全部正常解析）', async () => {
  const env = await createTestEnv({ extractionProvider: 'deterministic', aiDailyParseLimit: 1 })
  try {
    const c = await registerAndLogin(env, 'det@example.com')
    const sid = await createShipment(env, c)
    for (let i = 1; i <= 3; i++) {
      const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm(`det-${i}.png`))
      assert.equal(res.status, 201, res.text)
    }
    await env.waitForParseIdle()
    const docs = await c.get(`/api/shipments/${sid}`)
    const list = (docs.json as { shipment: { documents: Array<{ status: string; error?: string }> } }).shipment.documents
    assert.equal(list.length, 3)
    // PNG 无文本层，确定性链路同样无法提取 → failed，但原因绝不是配额
    for (const d of list) {
      assert.ok(!/配额/.test(d.status + (d.error ?? '')), `不应出现配额拦截：${d.status} ${d.error ?? ''}`)
    }
  } finally {
    await env.cleanup()
  }
})

/* ---------- 集成：频率限制 ---------- */

test('ABUSE7 上传频率限制：同账号 1 分钟内第 11 次返回 429', async () => {
  const env = await createTestEnv({ uploadRatePerMin: 10 })
  try {
    const c = await registerAndLogin(env, 'flood@example.com')
    const sid = await createShipment(env, c)
    for (let i = 1; i <= 10; i++) {
      const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm(`f-${i}.png`))
      assert.equal(res.status, 201, `第 ${i} 次应放行：${res.text}`)
    }
    const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm('f-11.png'))
    assert.equal(res.status, 429)
    assert.match(res.text, /频繁/)
  } finally {
    await env.cleanup()
  }
})

test('ABUSE8 上传限流按账号隔离：其他账号不受影响', async () => {
  const env = await createTestEnv({ uploadRatePerMin: 2 })
  try {
    const a = await registerAndLogin(env, 'user-a@example.com')
    const b = await registerAndLogin(env, 'user-b@example.com')
    const sidA = await createShipment(env, a)
    const sidB = await createShipment(env, b)
    assert.equal((await a.postForm(`/api/shipments/${sidA}/documents`, uploadForm('a1.png'))).status, 201)
    assert.equal((await a.postForm(`/api/shipments/${sidA}/documents`, uploadForm('a2.png'))).status, 201)
    assert.equal((await a.postForm(`/api/shipments/${sidA}/documents`, uploadForm('a3.png'))).status, 429)
    // B 账号第 1 次就应放行
    assert.equal((await b.postForm(`/api/shipments/${sidB}/documents`, uploadForm('b1.png'))).status, 201)
  } finally {
    await env.cleanup()
  }
})

test('ABUSE9 全局 API 限流：超限 429，健康检查豁免', async () => {
  const env = await createTestEnv({ apiRatePerMin: 3 })
  try {
    const c = env.client()
    // 前 3 个计费请求放行；healthz 豁免不计数
    assert.equal((await c.get('/api/healthz')).status, 200, 'healthz 豁免不计数')
    const reg = await c.post('/api/auth/register', { email: 'api-flood@example.com', password: 'super-secret-123' })
    assert.equal(reg.status, 201)
    assert.equal((await c.get('/api/shipments')).status, 200, '第 2 个计费请求放行')
    assert.equal((await c.get('/api/shipments')).status, 200, '第 3 个计费请求放行（max=3）')
    // 第 4 个计费请求 → 429
    const blocked = await c.get('/api/shipments')
    assert.equal(blocked.status, 429)
    assert.match(blocked.text, /频繁/)
    // 健康检查永远放行（部署探活需要）
    assert.equal((await c.get('/api/healthz')).status, 200)
  } finally {
    await env.cleanup()
  }
})
