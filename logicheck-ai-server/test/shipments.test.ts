/* ============================================================
   货物管理测试（TDD RED → GREEN）：真实 HTTP + 真实 SQLite。
   覆盖：未登录 401 / 新建 / 列表 / 详情聚合 / 搜索 /
         删除级联 / 跨账号隔离（不暴露存在性）/ 重启持久化。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

test.beforeEach(async () => {
  env = await createTestEnv()
})

test.afterEach(async () => {
  await env.cleanup()
})

async function registerAndLogin(email: string) {
  const c = env.client()
  const res = await c.post('/api/auth/register', { email, password: 'super-secret-123' })
  assert.equal(res.status, 201, res.text)
  return c
}

test('S1 未登录访问货物接口返回 401', async () => {
  const c = env.client()
  const list = await c.get('/api/shipments')
  assert.equal(list.status, 401)
  const create = await c.post('/api/shipments', {})
  assert.equal(create.status, 401)
  const detail = await c.get('/api/shipments/SHP-2026-001')
  assert.equal(detail.status, 401)
})

test('S2 新建货物：默认名称、自动 ID、列表与详情一致', async () => {
  const c = await registerAndLogin('ship-owner@example.com')
  const res = await c.post('/api/shipments', {})
  assert.equal(res.status, 201, res.text)
  const shipment = (res.json as { shipment: Record<string, unknown> }).shipment
  assert.match(String(shipment.id), /^SHP-2026-\d{3}$/)
  assert.equal(shipment.name, '新建货物 · 待识别')
  assert.equal(shipment.isDemo, false)
  assert.deepEqual(shipment.documents, [])
  assert.deepEqual(shipment.findings, [])
  assert.equal(shipment.origin, '待提取')

  const named = await c.post('/api/shipments', { name: '德国订单 · 音箱' })
  assert.equal((named.json as { shipment: { name: string } }).shipment.name, '德国订单 · 音箱')

  const list = await c.get('/api/shipments')
  const items = (list.json as { shipments: Array<{ id: string }> }).shipments
  assert.equal(items.length, 2)
  assert.ok(items.some((s) => s.id === shipment.id))

  const detail = await c.get(`/api/shipments/${shipment.id}`)
  assert.equal(detail.status, 200)
  assert.equal((detail.json as { shipment: { id: string } }).shipment.id, shipment.id)
})

test('S3 重启后货物数据仍存在（真实持久化）', async () => {
  const c = await registerAndLogin('persist@example.com')
  const created = await c.post('/api/shipments', { name: '持久化验证货物' })
  const id = (created.json as { shipment: { id: string } }).shipment.id

  await env.restart()

  const detail = await c.get(`/api/shipments/${id}`)
  assert.equal(detail.status, 200, detail.text)
  assert.equal((detail.json as { shipment: { name: string } }).shipment.name, '持久化验证货物')
  const list = await c.get('/api/shipments')
  assert.equal((list.json as { shipments: unknown[] }).shipments.length, 1)
})

test('S4 删除货物：204、详情 404、列表移除', async () => {
  const c = await registerAndLogin('deleter@example.com')
  const created = await c.post('/api/shipments', {})
  const id = (created.json as { shipment: { id: string } }).shipment.id

  const del = await c.delete(`/api/shipments/${id}`)
  assert.equal(del.status, 204)
  const detail = await c.get(`/api/shipments/${id}`)
  assert.equal(detail.status, 404)
  const list = await c.get('/api/shipments')
  assert.equal((list.json as { shipments: unknown[] }).shipments.length, 0)
})

test('S5 跨账号隔离：不可见、不可读、不可删（404 不暴露存在性）', async () => {
  const alice = await registerAndLogin('alice@example.com')
  const created = await alice.post('/api/shipments', { name: 'Alice 的私密货物' })
  const id = (created.json as { shipment: { id: string } }).shipment.id

  const bob = await registerAndLogin('bob@example.com')

  const bobList = await bob.get('/api/shipments')
  const bobItems = (bobList.json as { shipments: Array<{ id: string }> }).shipments
  assert.ok(!bobItems.some((s) => s.id === id), 'B 的列表不得包含 A 的货物')

  const bobDetail = await bob.get(`/api/shipments/${id}`)
  assert.equal(bobDetail.status, 404, 'B 读取 A 的货物应 404')
  assert.ok(!bobDetail.text.includes('Alice'), '不得泄露他人货物信息')

  const bobDelete = await bob.delete(`/api/shipments/${id}`)
  assert.equal(bobDelete.status, 404)

  const aliceDetail = await alice.get(`/api/shipments/${id}`)
  assert.equal(aliceDetail.status, 200, 'A 自己的货物不受影响')
})

test('S6 搜索：按名称匹配（SQL 层）', async () => {
  const c = await registerAndLogin('searcher@example.com')
  await c.post('/api/shipments', { name: '蓝牙音箱第一批' })
  await c.post('/api/shipments', { name: '手机配件' })

  const hit = await c.get('/api/shipments?search=' + encodeURIComponent('蓝牙'))
  const hitItems = (hit.json as { shipments: Array<{ name: string }> }).shipments
  assert.equal(hitItems.length, 1)
  assert.match(hitItems[0].name, /蓝牙/)

  const miss = await c.get('/api/shipments?search=' + encodeURIComponent('不存在的关键词'))
  assert.equal((miss.json as { shipments: unknown[] }).shipments.length, 0)
})

test('S7 删除货物级联清理单证记录与磁盘文件', async () => {
  const c = await registerAndLogin('cascade@example.com')
  const created = await c.post('/api/shipments', {})
  const id = (created.json as { shipment: { id: string } }).shipment.id

  // 直接插入一条带磁盘文件的单证记录（模拟上传结果）
  const storageKey = `${id}/doc-test123/invoice.pdf`
  const abs = join(env.uploadsDir, storageKey)
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, 'fake pdf bytes')

  env.db.run(
    `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, error, is_demo, created_at, updated_at)
     VALUES ('doc-test123', ?, (SELECT id FROM users LIMIT 1), 'invoice.pdf', '待 AI 识别', 'pdf', 'uploaded', 14, ?, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    id,
    storageKey,
  )

  const del = await c.delete(`/api/shipments/${id}`)
  assert.equal(del.status, 204)
  assert.equal(existsSync(abs), false, '磁盘文件应被删除')
  const rows = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ?', id)!.n
  assert.equal(rows, 0, '单证记录应级联删除')
})
