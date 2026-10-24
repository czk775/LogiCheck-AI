/* ============================================================
   异常处理完整闭环集成测试（阶段四）

   覆盖用户要求：
   - 异常列表 / 详情（真实数据可读）
   - 人工修正字段（留痕 + profile 推导 + 不依赖硬编码演示文档）
   - 替换文件（原证据失效 → 相关异常重开 → 重新解析 → 重新核验）
   - 人工审核备注（reviewed ≠ resolved）
   - 人工解决异常（resolved + 不可删除的留痕）
   - 重跑核验（状态机正确维护）
   - 仅重检成功才自动解决（冲突仍存在则异常保留）
   - 审计保留（处理记录 / 运行记录 / 人工决定均可追溯）
   - 前后端集成不破坏 UI（此处验证 API 契约稳定，前端由 E2E 覆盖）

   全部使用真实构造的 PDF 文件走完整链路。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'
import { buildSimplePdf } from './helpers-pdf.ts'

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

async function createShipment(c: ReturnType<typeof env.client>, name = '闭环货物') {
  const res = await c.post('/api/shipments', { name })
  assert.equal(res.status, 201, res.text)
  return (res.json as { shipment: { id: string } }).shipment.id
}

function uploadForm(files: Array<{ name: string; type: string; bytes: Buffer }>, replaceId?: string): FormData {
  const fd = new FormData()
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type }), f.name)
  if (replaceId) fd.append('replaceDocumentId', replaceId)
  return fd
}

function invoicePdf(quantity = '1000'): Buffer {
  return buildSimplePdf([
    { text: 'COMMERCIAL INVOICE', size: 16 },
    { text: 'Invoice No.: INV-2026-0200' },
    { text: 'Invoice Date: 2026-02-01' },
    { text: 'Model: LS-B300' },
    { text: `Quantity: ${quantity} PCE` },
    { text: 'Unit Price: USD 10.00' },
    { text: 'Total Amount: USD 10000.00' },
    { text: 'Consignee: Buyer GmbH' },
  ])
}

function packingListPdf(quantity: string): Buffer {
  return buildSimplePdf([
    { text: 'PACKING LIST', size: 16 },
    { text: `Quantity: ${quantity} PCE` },
    { text: 'Gross Weight: 800 KG' },
    { text: 'Consignee: Buyer GmbH' },
  ])
}

async function uploadOne(
  c: ReturnType<typeof env.client>,
  sid: string,
  file: { name: string; type: string; bytes: Buffer },
  replaceId?: string,
): Promise<string> {
  const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm([file], replaceId))
  assert.equal(res.status, 201, res.text)
  return (res.json as { accepted: Array<{ id: string }> }).accepted[0].id
}

interface FindingRow {
  id: string
  title: string
  kind: string
  status: string
  summary: string
  evidence: string
  check_key: string | null
}

function findingRows(sid: string): FindingRow[] {
  return env.db.all<FindingRow>(
    'SELECT id, title, kind, status, summary, evidence, check_key FROM findings WHERE shipment_id = ? ORDER BY rowid ASC',
    sid,
  )
}

/* ============================================================
   X 组：闭环能力
   ============================================================ */

test('X1 异常列表与详情：真实货物的冲突异常可读且证据指向真实单证', async () => {
  const c = await registerAndLogin('x1@example.com')
  const sid = await createShipment(c)

  const invId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  // 列表接口
  const detail = await c.get(`/api/shipments/${sid}`)
  assert.equal(detail.status, 200, detail.text)
  const shipment = (detail.json as {
    shipment: { findings: Array<{ id: string; kind: string; status: string; evidence: string[] }> }
  }).shipment
  const conflict = shipment.findings.find((f) => f.kind === 'cross')
  assert.ok(conflict, '应能读到跨单证冲突异常')
  assert.ok(conflict.evidence.includes(invId) || conflict.evidence.includes(packId))

  // 详情接口
  const one = await c.get(`/api/findings/${conflict.id}`)
  assert.equal(one.status, 200, one.text)
  const finding = (one.json as { finding: { id: string; summary: string; notes: unknown[] } }).finding
  assert.equal(finding.id, conflict.id)
  assert.ok(finding.summary.length > 0)
  assert.deepEqual(finding.notes, [])
})

test('X2 人工修正字段：留痕 + profile 推导正确（不依赖演示文档 ID）', async () => {
  const c = await registerAndLogin('x2@example.com')
  const sid = await createShipment(c)

  const invId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1000') })
  await env.waitForParseIdle()

  // 修正装箱单数量为 800（与发票 1000 冲突）
  const res = await c.patch(`/api/shipments/${sid}/fields`, { documentId: packId, fieldKey: 'quantity', value: '800' })
  assert.equal(res.status, 200, res.text)

  // 留痕：人工修正记录原值
  const row = env.db.get<{ value: string; original_value: string | null; source: string }>(
    "SELECT value, original_value, source FROM extracted_fields WHERE document_id = ? AND field_key = 'quantity' ORDER BY rowid DESC LIMIT 1",
    packId,
  )
  assert.equal(row?.value, '800')
  assert.equal(row?.source, 'manual')
  assert.equal(row?.original_value, '1000', '原值必须留痕')

  // profile 推导：真实单证集合比对（非硬编码 doc-invoice/doc-packing）
  const profile = env.db.get<{ value: string }>(
    "SELECT value FROM shipment_profiles WHERE shipment_id = ? AND field_key = 'quantity'",
    sid,
  )
  assert.equal(profile?.value, '待确认（存在冲突）', '1000 vs 800 → 冲突')

  // 活动记录
  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('人工修正提取值') && a.text.includes('800')))

  // 修正发票后一致 → profile 显示一致值
  await c.patch(`/api/shipments/${sid}/fields`, { documentId: invId, fieldKey: 'quantity', value: '800' })
  const after = env.db.get<{ value: string }>(
    "SELECT value FROM shipment_profiles WHERE shipment_id = ? AND field_key = 'quantity'",
    sid,
  )
  assert.match(after?.value ?? '', /^800 PCE（待重新检查）$/)
})

test('X3 替换文件：原单证删除 → 相关异常重开 → 新文件重新解析并核验', async () => {
  const c = await registerAndLogin('x3@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  assert.ok(findingRows(sid).some((f) => f.check_key === 'cross:quantity' && f.status === 'open'), '先有冲突')

  // 替换装箱单为数量一致的新文件
  const newId = await uploadOne(
    c,
    sid,
    { name: 'packing-v2.pdf', type: 'application/pdf', bytes: packingListPdf('1000') },
    packId,
  )
  await env.waitForParseIdle()

  // 旧单证已删除，新单证入库
  const old = env.db.get<{ id: string }>('SELECT id FROM documents WHERE id = ?', packId)
  assert.equal(old, undefined, '被替换的单证应已删除')
  const neu = env.db.get<{ id: string; status: string; error: string | null; storage_key: string | null }>(
    'SELECT id, status, error, storage_key FROM documents WHERE id = ?',
    newId,
  )
  assert.equal(neu?.status, 'parsed', `替换后的文件应解析成功，实际错误：${neu?.error ?? '无'}`)

  // 活动记录含替换说明
  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('替换单证') && a.text.includes('packing.pdf')))

  // 替换后重新核验：数量一致 → 冲突自动解决
  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')
  assert.ok(conflict)
  assert.equal(conflict.status, 'resolved', '替换为一致文件后重检应自动解决')
})

test('X4 人工审核备注：reviewed 保留风险，不等于 resolved', async () => {
  const c = await registerAndLogin('x4@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  const res = await c.post(`/api/findings/${conflict.id}/decisions`, { note: '已联系供应商确认中，暂不处理' })
  assert.equal(res.status, 200, res.text)

  const finding = (res.json as { finding: { status: string; notes: Array<{ kind: string; text: string }> } }).finding
  assert.equal(finding.status, 'reviewed')
  assert.equal(finding.notes.length, 1)
  assert.equal(finding.notes[0].kind, 'review')

  // 留痕进入处理记录
  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('人工复核')))
})

test('X5 人工解决异常：resolved + 不可删除的留痕 + 审计活动', async () => {
  const c = await registerAndLogin('x5@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  const res = await c.post(`/api/findings/${conflict.id}/resolve`, { note: '已与供应商达成一致，按装箱单 1200 计' })
  assert.equal(res.status, 200, res.text)

  const finding = (res.json as { finding: { status: string; notes: Array<{ kind: string }> } }).finding
  assert.equal(finding.status, 'resolved')
  assert.equal(finding.notes[0].kind, 'resolve')

  // 处理记录（活动）保留
  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('人工解决') && a.text.includes('1200')))

  // 决定记录不可删除：库中仍在
  const decisions = env.db.all<{ id: string; kind: string }>(
    'SELECT id, kind FROM human_decisions WHERE finding_id = ?',
    conflict.id,
  )
  assert.equal(decisions.length, 1)
  assert.equal(decisions[0].kind, 'resolve')
})

test('X6 解决后重检：冲突仍存在时不自动重开（尊重人工判断），但运行摘要留痕', async () => {
  const c = await registerAndLogin('x6@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  await c.post(`/api/findings/${conflict.id}/resolve`, { note: '按业务惯例以装箱单为准' })

  // 重检：冲突依然存在
  const res = await c.post(`/api/shipments/${sid}/recheck`)
  assert.equal(res.status, 200, res.text)
  assert.equal((res.json as { report: { ran: boolean } }).report.ran, true)

  const after = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  assert.equal(after.status, 'resolved', '已人工解决的异常不被自动重开')

  // 但冲突事实记录在运行摘要里（可追溯）
  const run = env.db.get<{ summary: string }>(
    "SELECT summary FROM processing_runs WHERE shipment_id = ? AND trigger = 'recheck' ORDER BY rowid DESC LIMIT 1",
    sid,
  )
  assert.match(run?.summary ?? '', /冲突 1/, '运行摘要应说明仍有冲突')
})

test('X7 重新打开异常：回到待处理状态并留痕', async () => {
  const c = await registerAndLogin('x7@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  await c.post(`/api/findings/${conflict.id}/resolve`, { note: '临时按装箱单处理' })

  const res = await c.post(`/api/findings/${conflict.id}/reopen`, { note: '供应商称装箱单有误，需重新核对' })
  assert.equal(res.status, 200, res.text)
  const finding = (res.json as { finding: { status: string; notes: Array<{ kind: string }> } }).finding
  assert.equal(finding.status, 'open')
  assert.ok(finding.notes.some((n) => n.kind === 'reopen'))
})

test('X8 移除单证后：核验结论重跑，不再引用已删除的证据', async () => {
  const c = await registerAndLogin('x8@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  assert.ok(findingRows(sid).some((f) => f.check_key === 'cross:quantity'))

  // 移除装箱单
  const del = await c.delete(`/api/documents/${packId}`)
  assert.equal(del.status, 204, del.text)

  // 证据已删除 → 冲突不再成立（只剩 1 份单证 → missing 而非 conflict）
  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')
  if (conflict) {
    assert.notEqual(conflict.status, 'open', '证据已移除，冲突不应继续开放')
  }

  // 检查结果不得引用已删除的文档
  const refs = env.db.all<{ rule_key: string; evidence_refs: string }>(
    'SELECT rule_key, evidence_refs FROM check_results WHERE shipment_id = ?',
    sid,
  )
  for (const r of refs) {
    const ids = JSON.parse(r.evidence_refs) as string[]
    for (const id of ids) {
      const exists = env.db.get<{ id: string }>('SELECT id FROM documents WHERE id = ?', id)
      assert.ok(exists, `证据 ${id} 已删除，不得再被引用`)
    }
  }
})

test('X9 解决异常必须有处理说明（不少于 3 字）', async () => {
  const c = await registerAndLogin('x9@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  const bad = await c.post(`/api/findings/${conflict.id}/resolve`, { note: '好' })
  assert.equal(bad.status, 400, '过短说明必须被拒绝')
})

test('X10 跨账号隔离：他人无法解决我的异常', async () => {
  const c1 = await registerAndLogin('owner@example.com')
  const sid = await createShipment(c1)
  await uploadOne(c1, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  await uploadOne(c1, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!

  const c2 = await registerAndLogin('intruder@example.com')
  const res = await c2.post(`/api/findings/${conflict.id}/resolve`, { note: '恶意解决他人异常' })
  assert.equal(res.status, 404, '他人不得操作不属于自己的异常')

  // 状态未被改变
  const after = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  assert.equal(after.status, 'open')
})

test('X11 完整闭环：解析 → 冲突 → 人工修正 → 重检解决 → 人工留档 → 审计可查', async () => {
  const c = await registerAndLogin('x11@example.com')
  const sid = await createShipment(c)

  // 1. 上传两份数量冲突的真实单证
  const invId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf('1000') })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf('1200') })
  await env.waitForParseIdle()

  // 2. 冲突异常已生成
  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  assert.ok(conflict)
  assert.equal(conflict.status, 'open')

  // 3. 人工修正 → 4. 重检 → 自动解决
  await c.patch(`/api/shipments/${sid}/fields`, { documentId: packId, fieldKey: 'quantity', value: '1000' })
  await c.post(`/api/shipments/${sid}/recheck`)
  assert.equal(findingRows(sid).find((f) => f.check_key === 'cross:quantity')!.status, 'resolved')

  // 5. 人工复核留档
  await c.post(`/api/findings/${conflict.id}/decisions`, { note: '已核对原件，确认为装箱单笔误' })

  // 6. 审计可查：解析 run + 核验 run + 活动 + 人工决定
  const runs = env.db.all<{ trigger: string; status: string }>('SELECT trigger, status FROM processing_runs WHERE shipment_id = ?', sid)
  assert.ok(runs.some((r) => r.trigger === 'parse' && r.status === 'succeeded'))
  assert.ok(runs.some((r) => r.trigger === 'check' && r.status === 'succeeded'))
  assert.ok(runs.some((r) => r.trigger === 'recheck' && r.status === 'succeeded'))

  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('解析完成')))
  assert.ok(acts.some((a) => a.text.includes('核验完成')))
  assert.ok(acts.some((a) => a.text.includes('人工修正提取值')))
  assert.ok(acts.some((a) => a.text.includes('人工复核')))

  const decisions = env.db.all<{ kind: string }>('SELECT kind FROM human_decisions WHERE finding_id = ?', conflict.id)
  assert.ok(decisions.some((d) => d.kind === 'review'))

  // 7. 修正值确实被核验采用（引擎读的是最新人工值）
  const fields = env.db.all<{ value: string; source: string }>(
    "SELECT value, source FROM extracted_fields WHERE document_id = ? AND field_key = 'quantity' ORDER BY rowid DESC LIMIT 1",
    packId,
  )
  assert.equal(fields[0].value, '1000')
  assert.equal(fields[0].source, 'manual')
  assert.ok(invId !== packId)
})
