/* ============================================================
   演示数据与确定性演示逻辑测试（TDD RED → GREEN）。
   演示逻辑 = 前端 Mock 行为 1:1 移植到真实数据库（非 AI、非规则引擎）。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
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

async function loginDemo() {
  const c = env.client()
  const res = await c.post('/api/auth/demo')
  assert.equal(res.status, 200, res.text)
  return c
}

test('E1 演示登录：预置演示货物（4 单证 / 3 异常 / 9 字段）', async () => {
  const c = await loginDemo()
  const list = await c.get('/api/shipments')
  const items = (list.json as { shipments: Array<{ id: string; isDemo: boolean; name: string }> }).shipments
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'SHP-2026-001')
  assert.equal(items[0].isDemo, true)
  assert.equal(items[0].name, '便携式可充电蓝牙音箱')

  const detail = await c.get('/api/shipments/SHP-2026-001')
  const s = (detail.json as {
    shipment: {
      documents: Array<{ id: string; fields: Record<string, string>; status: string; isDemo: boolean }>
      findings: Array<{ id: string; status: string }>
      profile: Record<string, string>
      runs: unknown[]
      activities: Array<{ text: string }>
    }
  }).shipment
  assert.equal(s.documents.length, 4)
  assert.equal(s.findings.length, 3)
  assert.ok(s.findings.every((f) => f.status === 'open'))
  assert.equal(s.documents.find((d) => d.id === 'doc-invoice')?.fields.quantity, '1000')
  assert.equal(s.documents.find((d) => d.id === 'doc-packing')?.fields.quantity, '980')
  assert.equal(s.profile.quantity, '待确认（存在冲突）')
  assert.equal(s.profile.gross, '420 kg')
  assert.equal(s.runs.length, 1)
  assert.ok(s.activities.some((a) => a.text.includes('演示案例已载入')))
})

test('E2 演示登录重启后数据仍在（真实持久化）', async () => {
  const c = await loginDemo()
  await env.restart()
  const detail = await c.get('/api/shipments/SHP-2026-001')
  assert.equal(detail.status, 200, detail.text)
  const s = (detail.json as { shipment: { documents: unknown[]; findings: unknown[] } }).shipment
  assert.equal(s.documents.length, 4)
  assert.equal(s.findings.length, 3)
})

test('E3 规则清单：5 条且含官方来源', async () => {
  const c = await loginDemo()
  const res = await c.get('/api/rules')
  assert.equal(res.status, 200, res.text)
  const rules = (res.json as { rules: Array<{ key: string; sourceURL: string; ruleId: string; requiredEvidence: string[] }> }).rules
  assert.equal(rules.length, 5)
  assert.deepEqual(
    rules.map((r) => r.key),
    ['red', 'rohs', 'battery', 'weee', 'hs'],
  )
  assert.ok(rules.every((r) => r.sourceURL.startsWith('https://')))
  assert.ok(rules.every((r) => Array.isArray(r.requiredEvidence) && r.requiredEvidence.length > 0))
})

test('E4 演示货物规则预检概况（5 项状态）', async () => {
  const c = await loginDemo()
  const res = await c.get('/api/shipments/SHP-2026-001/check-results')
  assert.equal(res.status, 200, res.text)
  const results = (res.json as { results: Array<{ ruleKey: string; status: string; tone: string }> }).results
  assert.equal(results.length, 5)
  assert.equal(results.find((r) => r.ruleKey === 'red')?.status, 'insufficient_evidence')
  assert.equal(results.find((r) => r.ruleKey === 'rohs')?.status, 'warning')
  // 顺序契约：必须与前端 DEMO_RULES 数组顺序一致（red 在前）——曾因 ORDER BY 随机 id 被打乱
  assert.deepEqual(
    results.map((r) => r.ruleKey),
    ['red', 'rohs', 'battery', 'weee', 'hs'],
  )
})

test('E5 字段候选：quantity 有三个来源（invoice 1000 / packing 980 / BOL 1000）', async () => {
  const c = await loginDemo()
  const res = await c.get('/api/shipments/SHP-2026-001/fields/quantity/candidates')
  assert.equal(res.status, 200, res.text)
  const candidates = (res.json as { candidates: Array<{ value: string; sourceDocumentId: string }> }).candidates
  assert.equal(candidates.length, 3, res.text)
  assert.ok(candidates.some((x) => x.value === '1000' && x.sourceDocumentId === 'doc-invoice'))
  assert.ok(candidates.some((x) => x.value === '980' && x.sourceDocumentId === 'doc-packing'))
  assert.ok(candidates.some((x) => x.value === '1000' && x.sourceDocumentId === 'doc-bol'))
})

test('E6 字段修正：留痕 + profile 推导 + 原值快照', async () => {
  const c = await loginDemo()
  const res = await c.patch('/api/shipments/SHP-2026-001/fields', {
    documentId: 'doc-packing',
    fieldKey: 'quantity',
    value: '1000',
  })
  assert.equal(res.status, 200, res.text)
  const s = (res.json as { shipment: { profile: Record<string, string>; documents: Array<{ id: string; fields: Record<string, string>; originalFields?: Record<string, string> }> } }).shipment
  assert.equal(s.profile.quantity, '1000 PCS（待重新检查）')
  const packing = s.documents.find((d) => d.id === 'doc-packing')!
  assert.equal(packing.fields.quantity, '1000')
  assert.equal(packing.originalFields?.quantity, '980', '原值应留痕')
})

test('E7 重检（演示货物）：数量一致则异常解决并写 Run', async () => {
  const c = await loginDemo()
  await c.patch('/api/shipments/SHP-2026-001/fields', { documentId: 'doc-packing', fieldKey: 'quantity', value: '1000' })
  const res = await c.post('/api/shipments/SHP-2026-001/recheck')
  assert.equal(res.status, 200, res.text)
  const report = (res.json as { report: { ran: boolean; summary: string } }).report
  assert.equal(report.ran, true)
  assert.match(report.summary, /数量异常已解决/)

  const detail = await c.get('/api/shipments/SHP-2026-001')
  const s = (detail.json as { shipment: { findings: Array<{ id: string; status: string }>; runs: Array<{ status: string; trigger: string }>; profile: Record<string, string> } }).shipment
  assert.equal(s.findings.find((f) => f.id === 'f-qty')?.status, 'resolved')
  assert.ok(s.runs.some((r) => r.trigger === 'recheck' && r.status === 'succeeded'))
  assert.equal(s.profile.quantity, '1000 PCS')
})

test('E8 重检（非演示货物）：无已解析单证 → 明确 no_documents，不伪造结果', async () => {
  const c = await registerAndLogin('real-user@example.com')
  const created = await c.post('/api/shipments', { name: '真实货物' })
  const id = (created.json as { shipment: { id: string } }).shipment.id
  const res = await c.post(`/api/shipments/${id}/recheck`)
  assert.equal(res.status, 200, res.text)
  const report = (res.json as { report: { ran: boolean; reason?: string } }).report
  assert.equal(report.ran, false)
  assert.equal(report.reason, 'no_documents')

  const runs = await c.get(`/api/shipments/${id}/runs`)
  const list = (runs.json as { runs: Array<{ status: string; error?: string }> }).runs
  assert.equal(list[0].status, 'failed')
  assert.equal(list[0].error, 'no_documents')
})

test('E9 人工复核：记录留痕、风险保留（reviewed ≠ resolved）', async () => {
  const c = await loginDemo()
  const res = await c.post('/api/findings/f-red/decisions', { note: '已与供应商确认 DoC 正在办理，预计下周提供' })
  assert.equal(res.status, 200, res.text)
  const finding = (res.json as { finding: { status: string; notes: Array<{ text: string; kind: string }> } }).finding
  assert.equal(finding.status, 'reviewed')
  assert.equal(finding.notes.length, 1)
  assert.equal(finding.notes[0].kind, 'review')
})

test('E10 规则跟进：为演示货物创建人工跟进异常', async () => {
  const c = await loginDemo()
  const res = await c.post('/api/shipments/SHP-2026-001/rules/weee/follow-up')
  assert.equal(res.status, 200, res.text)
  const finding = (res.json as { finding: { id: string; ruleKey: string; status: string; kind: string } }).finding
  assert.equal(finding.ruleKey, 'weee')
  assert.equal(finding.kind, 'rule')
  assert.equal(finding.status, 'open')

  // 重复跟进不产生重复异常
  const again = await c.post('/api/shipments/SHP-2026-001/rules/weee/follow-up')
  assert.equal((again.json as { finding: { id: string } }).finding.id, finding.id)
})

test('E11 非演示货物不能记录规则人工意见', async () => {
  const c = await registerAndLogin('no-followup@example.com')
  const created = await c.post('/api/shipments', {})
  const id = (created.json as { shipment: { id: string } }).shipment.id
  const res = await c.post(`/api/shipments/${id}/rules/weee/follow-up`)
  assert.equal(res.status, 400)
})

test('E12 处理记录与操作记录查询', async () => {
  const c = await loginDemo()
  const runs = await c.get('/api/shipments/SHP-2026-001/runs')
  assert.equal((runs.json as { runs: unknown[] }).runs.length, 1)
  const acts = await c.get('/api/shipments/SHP-2026-001/activities')
  assert.ok((acts.json as { activities: Array<{ text: string }> }).activities.some((a) => a.text.includes('演示案例已载入')))
})

test('E13 跨账号隔离：他人不可访问演示货物的字段/异常/记录', async () => {
  await loginDemo()
  const bob = await registerAndLogin('bob-demo@example.com')

  assert.equal((await bob.get('/api/shipments/SHP-2026-001')).status, 404)
  assert.equal((await bob.get('/api/shipments/SHP-2026-001/fields/quantity/candidates')).status, 404)
  assert.equal((await bob.get('/api/shipments/SHP-2026-001/runs')).status, 404)
  assert.equal((await bob.get('/api/shipments/SHP-2026-001/activities')).status, 404)
  assert.equal((await bob.post('/api/shipments/SHP-2026-001/recheck')).status, 404)
  assert.equal((await bob.post('/api/findings/f-qty/decisions', { note: '试试别人的异常' })).status, 404)
  assert.equal((await bob.patch('/api/shipments/SHP-2026-001/fields', { documentId: 'doc-packing', fieldKey: 'quantity', value: '1' })).status, 404)
})

test('E14 真实上传货物的诚实边界：无字段、无检查结果、无异常', async () => {
  const c = await registerAndLogin('honest@example.com')
  const created = await c.post('/api/shipments', { name: '刚上传的货物' })
  const id = (created.json as { shipment: { id: string } }).shipment.id

  const fd = new FormData()
  fd.append('files', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'x.png')
  await c.postForm(`/api/shipments/${id}/documents`, fd)

  // 上传后进入解析队列；等待排空后断言终态
  await env.waitForParseIdle()
  const detail = await c.get(`/api/shipments/${id}`)
  const s = (detail.json as { shipment: { documents: Array<{ fields: Record<string, string>; status: string; error?: string }>; findings: unknown[] } }).shipment
  assert.deepEqual(s.documents[0].fields, {}, '真实上传文件不得有模拟提取字段')
  assert.equal(s.documents[0].status, 'failed', '图片 OCR 未接入时应明确失败，不得伪造字段')
  assert.ok((s.documents[0].error ?? '').includes('OCR'), '失败原因必须说明 OCR 未接入')
  assert.equal(s.findings.length, 0)

  const checkRes = await c.get(`/api/shipments/${id}/check-results`)
  assert.deepEqual((checkRes.json as { results: unknown[] }).results, [])
})

test('E15 演示与真实数据同库共存且互不干扰', async () => {
  const demo = await loginDemo()
  const real = await registerAndLogin('mixed@example.com')
  const created = await real.post('/api/shipments', { name: '真实用户的货物' })
  const realId = (created.json as { shipment: { id: string } }).shipment.id

  // 演示账号列表只有演示货物
  const demoList = (await demo.get('/api/shipments')).json as { shipments: Array<{ id: string }> }
  assert.deepEqual(demoList.shipments.map((s) => s.id), ['SHP-2026-001'])
  // 真实账号列表只有自己的货物
  const realList = (await real.get('/api/shipments')).json as { shipments: Array<{ id: string }> }
  assert.deepEqual(realList.shipments.map((s) => s.id), [realId])
})
