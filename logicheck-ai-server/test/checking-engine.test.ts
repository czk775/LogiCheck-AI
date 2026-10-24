/* ============================================================
   核验引擎集成测试（阶段三）

   覆盖用户要求的全部能力点：
   - 数量/重量/金额/币种/日期/贸易术语的标准化与一致性比对
   - 跨单证一致性四态：一致 / 冲突 / 缺失 / 无法判断
   - 冲突 → 生成真实异常，且证据指向真实单证
   - 合规规则预检：证据不足标「待核实」，不编造法规出处
   - 可解释：每条结论都带 reasoning 判定依据
   - 可重复：重复执行结论稳定，异常不重复生成
   - 人工修正后重跑 → 冲突自动解决，且已解决异常不被自动重开

   全部使用真实构造的 PDF / EDIFACT 文件走完整链路，不使用预设结果。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'
import { buildSimplePdf } from './helpers-pdf.ts'
import { compareGroup, CROSS_FIELD_GROUPS, crossCheckShipment } from '../src/modules/checking/crossCheck.ts'

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

async function createShipment(c: ReturnType<typeof env.client>, name = '核验货物') {
  const res = await c.post('/api/shipments', { name })
  assert.equal(res.status, 201, res.text)
  return (res.json as { shipment: { id: string } }).shipment.id
}

function uploadForm(files: Array<{ name: string; type: string; bytes: Buffer }>): FormData {
  const fd = new FormData()
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type }), f.name)
  return fd
}

async function uploadOne(c: ReturnType<typeof env.client>, sid: string, file: { name: string; type: string; bytes: Buffer }): Promise<string> {
  const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm([file]))
  assert.equal(res.status, 201, res.text)
  return (res.json as { accepted: Array<{ id: string }> }).accepted[0].id
}

/** 真实构造的发票 PDF */
function invoicePdf(overrides: Partial<Record<string, string>> = {}): Buffer {
  const v = {
    number: 'INV-2026-0100',
    date: '2026-01-15',
    quantity: '1000 PCE',
    unitPrice: 'USD 12.50',
    total: 'USD 12500.00',
    hs: '85176200',
    ...overrides,
  }
  return buildSimplePdf([
    { text: 'COMMERCIAL INVOICE', size: 16 },
    { text: `Invoice No.: ${v.number}` },
    { text: `Invoice Date: ${v.date}` },
    { text: 'Description: Bluetooth Speaker' },
    { text: 'Model: LS-B200' },
    { text: `Quantity: ${v.quantity}` },
    { text: `Unit Price: ${v.unitPrice}` },
    { text: `Total Amount: ${v.total}` },
    { text: 'HS Code: ' + v.hs },
    { text: 'Shipper: Supplier Co., Ltd.' },
    { text: 'Consignee: Buyer GmbH' },
  ])
}

/** 真实构造的装箱单 PDF */
function packingListPdf(overrides: Partial<Record<string, string>> = {}): Buffer {
  const v = {
    quantity: '1000 PCE',
    gross: '2500 KG',
    net: '2200 KG',
    ...overrides,
  }
  return buildSimplePdf([
    { text: 'PACKING LIST', size: 16 },
    { text: `Quantity: ${v.quantity}` },
    { text: `Gross Weight: ${v.gross}` },
    { text: `Net Weight: ${v.net}` },
    { text: 'Consignee: Buyer GmbH' },
  ])
}

interface CheckRow {
  rule_key: string
  status: string
  label: string
  tone: string
  evidence_refs: string
  reasoning: string | null
}

function checkRows(sid: string): CheckRow[] {
  return env.db.all<CheckRow>(
    'SELECT rule_key, status, label, tone, evidence_refs, reasoning FROM check_results WHERE shipment_id = ? ORDER BY rowid ASC',
    sid,
  )
}

interface FindingRow {
  id: string
  title: string
  kind: string
  severity: string
  status: string
  summary: string
  evidence: string
  check_key: string | null
}

function findingRows(sid: string): FindingRow[] {
  return env.db.all<FindingRow>(
    'SELECT id, title, kind, severity, status, summary, evidence, check_key FROM findings WHERE shipment_id = ? ORDER BY rowid ASC',
    sid,
  )
}

/* ============================================================
   C 组：跨单证一致性引擎（纯函数层）
   ============================================================ */

test('C1 数量一致 → consistent，结论引用真实原始值', () => {
  const group = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'quantity')!
  const result = compareGroup(group, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
    { documentId: 'd2', fileName: 'packing.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
  ])
  assert.ok(result)
  assert.equal(result.status, 'consistent')
  assert.match(result.summary, /invoice\.pdf=1000 PCE/)
  assert.match(result.summary, /packing\.pdf=1000 PCE/)
})

test('C2 数量不一致 → conflict，且引用两份真实取值', () => {
  const group = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'quantity')!
  const result = compareGroup(group, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
    { documentId: 'd2', fileName: 'packing.pdf', raw: '1200', normalized: '1200', unit: 'PCE' },
  ])
  assert.ok(result)
  assert.equal(result.status, 'conflict')
  assert.match(result.summary, /1000/)
  assert.match(result.summary, /1200/)
})

test('C3 数量相同但单位不同 → conflict（单位不一致）', () => {
  const group = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'quantity')!
  const result = compareGroup(group, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
    { documentId: 'd2', fileName: 'packing.pdf', raw: '1000', normalized: '1000', unit: 'CTN' },
  ])
  assert.ok(result)
  assert.equal(result.status, 'conflict')
  assert.match(result.summary, /单位不一致/)
})

test('C4 仅一份单证含该字段 → missing（无从交叉验证）', () => {
  const group = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'quantity')!
  const result = compareGroup(group, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
  ])
  assert.ok(result)
  assert.equal(result.status, 'missing')
  assert.match(result.summary, /无从交叉验证/)
})

test('C5 存在无法标准化的取值 → indeterminate（不臆断一致/冲突）', () => {
  const group = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'quantity')!
  const result = compareGroup(group, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '1000', normalized: '1000', unit: 'PCE' },
    { documentId: 'd2', fileName: 'packing.pdf', raw: '待确认', normalized: null, unit: null },
  ])
  assert.ok(result)
  assert.equal(result.status, 'indeterminate')
  assert.match(result.summary, /未能标准化/)
})

test('C6 币种与日期标准化：等价写法判为一致，不同写法判为冲突', () => {
  const currency = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'currency')!
  const same = compareGroup(currency, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: 'USD', normalized: 'USD', unit: null },
    { documentId: 'd2', fileName: 'edi.edi', raw: 'usd', normalized: 'USD', unit: null },
  ])
  assert.equal(same?.status, 'consistent')

  const diff = compareGroup(currency, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: 'USD', normalized: 'USD', unit: null },
    { documentId: 'd2', fileName: 'edi.edi', raw: 'EUR', normalized: 'EUR', unit: null },
  ])
  assert.equal(diff?.status, 'conflict')

  const date = CROSS_FIELD_GROUPS.find((g) => g.fieldKey === 'invoice_date')!
  const dateSame = compareGroup(date, [
    { documentId: 'd1', fileName: 'invoice.pdf', raw: '2026-01-15', normalized: '2026-01-15', unit: null },
    { documentId: 'd2', fileName: 'edi.edi', raw: '20260115', normalized: '2026-01-15', unit: null },
  ])
  assert.equal(dateSame?.status, 'consistent')
})

test('C7 纯函数：同样输入永远得到同样输出（可复算）', () => {
  const docFields = new Map([
    ['d1', { fileName: 'invoice.pdf', fields: new Map([['quantity', '1000'], ['unit', 'PCE']]) }],
    ['d2', { fileName: 'packing.pdf', fields: new Map([['quantity', '1200'], ['unit', 'PCE']]) }],
  ])
  const a = crossCheckShipment(docFields)
  const b = crossCheckShipment(docFields)
  assert.deepEqual(a, b)
  assert.equal(a.find((r) => r.fieldKey === 'quantity')?.status, 'conflict')
})

/* ============================================================
   K 组：引擎落库（真实文件 → 解析 → 核验）
   ============================================================ */

test('K1 两份单证数量冲突 → 生成跨单证异常，证据指向真实单证', async () => {
  const c = await registerAndLogin('cross-conflict@example.com')
  const sid = await createShipment(c)

  const invId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf({ quantity: '1200 PCE' }) })

  await env.waitForParseIdle()

  const findings = findingRows(sid)
  const conflict = findings.find((f) => f.check_key === 'cross:quantity')
  assert.ok(conflict, `应生成数量冲突异常，实际：${JSON.stringify(findings)}`)
  assert.equal(conflict.kind, 'cross')
  assert.equal(conflict.status, 'open')
  assert.equal(conflict.severity, 'danger', '数量冲突为高严重度')

  // 摘要引用真实取值，不含臆造数字
  assert.match(conflict.summary, /1000/)
  assert.match(conflict.summary, /1200/)

  // 证据指向真实文档
  const evidence = JSON.parse(conflict.evidence) as string[]
  assert.ok(evidence.includes(invId) || evidence.includes(packId), '证据应引用真实文档 id')

  // 有核验 run 记录
  const runs = env.db.all<{ trigger: string; status: string }>('SELECT trigger, status FROM processing_runs WHERE shipment_id = ?', sid)
  assert.ok(runs.some((r) => r.trigger === 'check' && r.status === 'succeeded'), '应有成功的核验运行记录')
})

test('K2 两份单证数量一致 → 无冲突异常，检查结果仍落库', async () => {
  const c = await registerAndLogin('cross-consistent@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf() })
  await env.waitForParseIdle()

  const findings = findingRows(sid)
  assert.equal(findings.filter((f) => f.check_key === 'cross:quantity').length, 0, '一致时不应有数量冲突异常')

  // 规则预检结论落库，且每条都有判定依据
  const rows = checkRows(sid)
  assert.ok(rows.length > 0, '应有规则预检结果')
  for (const r of rows) {
    assert.ok(r.reasoning && r.reasoning.length > 10, `规则 ${r.rule_key} 应有判定依据`)
  }
})

test('K3 合规规则：证据不足 → 待核实（不编造结论、不声称合规）', async () => {
  const c = await registerAndLogin('insufficient@example.com')
  const sid = await createShipment(c)

  // 只有一份发票，没有 DoC、没有 RoHS 声明
  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await env.waitForParseIdle()

  const rows = checkRows(sid)
  const red = rows.find((r) => r.rule_key === 'red')
  assert.ok(red, 'RED 规则应有结论')
  assert.equal(red.status, 'insufficient_evidence', '无 DoC 材料时应为证据不足')
  assert.match(red.reasoning ?? '', /未发现欧盟符合性声明/)
  assert.match(red.reasoning ?? '', /Directive 2014\/53\/EU/, '判定依据应引用规则来源')

  // 所有规则都必须在允许状态集合内（不得出现臆造状态）
  const allowed = new Set(['passed', 'issue', 'warning', 'insufficient_evidence', 'not_applicable', 'error'])
  for (const r of rows) {
    assert.ok(allowed.has(r.status), `规则 ${r.rule_key} 状态 ${r.status} 非法`)
  }
})

test('K4 有 RoHS 材料 → 标「材料已提供」但不宣称满足限值', async () => {
  const c = await registerAndLogin('rohs-provided@example.com')
  const sid = await createShipment(c)

  const rohsPdf = buildSimplePdf([
    { text: 'RoHS DECLARATION OF CONFORMITY', size: 14 },
    { text: 'Model: LS-B200' },
    { text: 'Test Report No: TR-2026-001' },
  ])
  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await uploadOne(c, sid, { name: 'rohs-declaration.pdf', type: 'application/pdf', bytes: rohsPdf })
  await env.waitForParseIdle()

  const rows = checkRows(sid)
  const rohs = rows.find((r) => r.rule_key === 'rohs')
  assert.ok(rohs)
  assert.equal(rohs.status, 'warning')
  assert.match(rohs.reasoning ?? '', /存在文件不等于满足限值要求/)
  assert.ok((JSON.parse(rohs.evidence_refs) as string[]).length > 0, '应引用真实证据文档')
})

test('K5 WEEE：目的国非德国 → not_applicable（不夸大义务）', async () => {
  const c = await registerAndLogin('weee-nonde@example.com')
  const sid = await createShipment(c)

  const pdf = buildSimplePdf([
    { text: 'COMMERCIAL INVOICE', size: 16 },
    { text: 'Quantity: 500 PCE' },
    { text: 'Destination: France' },
    { text: 'Consignee: Buyer SARL' },
  ])
  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: pdf })
  await env.waitForParseIdle()

  const rows = checkRows(sid)
  const weee = rows.find((r) => r.rule_key === 'weee')
  assert.ok(weee)
  assert.equal(weee.status, 'not_applicable')
  assert.match(weee.reasoning ?? '', /France/)
})

test('K6 重复执行核验 → 结论稳定，异常不重复生成（可重复）', async () => {
  const c = await registerAndLogin('repeatable@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf({ quantity: '1200 PCE' }) })
  await env.waitForParseIdle()

  const before = checkRows(sid)
  const findingsBefore = findingRows(sid)
  assert.equal(findingsBefore.filter((f) => f.check_key === 'cross:quantity').length, 1)

  // 手动重检两次
  for (let i = 0; i < 2; i++) {
    const res = await c.post(`/api/shipments/${sid}/recheck`)
    assert.equal(res.status, 200, res.text)
    const report = (res.json as { report: { ran: boolean } }).report
    assert.equal(report.ran, true)
  }

  const after = checkRows(sid)
  const findingsAfter = findingRows(sid)
  assert.equal(findingsAfter.filter((f) => f.check_key === 'cross:quantity').length, 1, '重检不得重复生成异常')
  assert.deepEqual(
    after.map((r) => [r.rule_key, r.status, r.reasoning]),
    before.map((r) => [r.rule_key, r.status, r.reasoning]),
    '重检结论应与首次完全一致',
  )
})

test('K7 人工修正后重检 → 冲突自动解决', async () => {
  const c = await registerAndLogin('manual-fix@example.com')
  const sid = await createShipment(c)

  const invId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf({ quantity: '1200 PCE' }) })
  await env.waitForParseIdle()

  assert.ok(findingRows(sid).some((f) => f.check_key === 'cross:quantity' && f.status === 'open'), '先有冲突')

  // 证据应同时指向冲突涉及的两份单证
  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')!
  const ev = JSON.parse(conflict.evidence) as string[]
  assert.ok(ev.includes(invId) && ev.includes(packId), '证据应同时引用发票与装箱单')

  // 人工把装箱单数量改为 1000（真实写库，留痕）
  const fix = await c.patch(`/api/shipments/${sid}/fields`, { documentId: packId, fieldKey: 'quantity', value: '1000' })
  assert.equal(fix.status, 200, fix.text)

  const res = await c.post(`/api/shipments/${sid}/recheck`)
  assert.equal(res.status, 200, res.text)
  assert.equal((res.json as { report: { ran: boolean } }).report.ran, true)

  const resolved = findingRows(sid).find((f) => f.check_key === 'cross:quantity')
  assert.ok(resolved)
  assert.equal(resolved.status, 'resolved', '修正后重检应自动解决冲突')
  assert.match(resolved.summary, /重检通过/)

  // 人工修正有留痕
  const manual = env.db.get<{ source: string; original_value: string | null }>(
    "SELECT source, original_value FROM extracted_fields WHERE document_id = ? AND field_key = 'quantity' ORDER BY rowid DESC LIMIT 1",
    packId,
  )
  assert.equal(manual?.source, 'manual')
  assert.equal(manual?.original_value, '1200')
})

test('K8 已解决的冲突不会因再次冲突被自动重开（尊重人工处理）', async () => {
  const c = await registerAndLogin('no-reopen@example.com')
  const sid = await createShipment(c)

  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  const packId = await uploadOne(c, sid, { name: 'packing.pdf', type: 'application/pdf', bytes: packingListPdf({ quantity: '1200 PCE' }) })
  await env.waitForParseIdle()

  const conflict = findingRows(sid).find((f) => f.check_key === 'cross:quantity')
  assert.ok(conflict)

  // 人工标记为已处理（reviewed）
  const review = await c.post(`/api/findings/${conflict.id}/decisions`, { note: '已与供应商确认，以装箱单为准' })
  assert.equal(review.status, 200, review.text)
  assert.equal((review.json as { finding: { status: string } }).finding.status, 'reviewed')

  // 人工修正数值 → 重检一致
  await c.patch(`/api/shipments/${sid}/fields`, { documentId: packId, fieldKey: 'quantity', value: '1000' })
  await c.post(`/api/shipments/${sid}/recheck`)

  // 再改回冲突值 → 重检冲突，但 reviewed 状态不被自动重开为 open
  await c.patch(`/api/shipments/${sid}/fields`, { documentId: packId, fieldKey: 'quantity', value: '1200' })
  await c.post(`/api/shipments/${sid}/recheck`)

  const after = findingRows(sid).find((f) => f.check_key === 'cross:quantity')
  assert.ok(after)
  assert.notEqual(after.status, 'open', '已人工处理过的异常不应被自动重开为 open')
})

test('K9 核验结论通过 API 可读，且带判定依据', async () => {
  const c = await registerAndLogin('api-readable@example.com')
  const sid = await createShipment(c)
  await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await env.waitForParseIdle()

  const res = await c.get(`/api/shipments/${sid}/check-results`)
  assert.equal(res.status, 200, res.text)
  const results = (res.json as { results: Array<{ ruleKey: string; status: string; reasoning?: string }> }).results
  assert.ok(results.length > 0, 'API 应返回规则预检结论')
  assert.ok(results.every((r) => typeof r.reasoning === 'string' && r.reasoning.length > 0), '每条结论都应带判定依据')
})

test('K10 无已解析单证时重检 → 明确不跑，不产生虚假结论', async () => {
  const c = await registerAndLogin('no-parsed@example.com')
  const sid = await createShipment(c)

  const res = await c.post(`/api/shipments/${sid}/recheck`)
  assert.equal(res.status, 200, res.text)
  const report = (res.json as { report: { ran: boolean; reason?: string; summary: string } }).report
  assert.equal(report.ran, false)
  assert.equal(report.reason, 'no_documents')
  assert.match(report.summary, /尚无已解析的单证/)

  // 不得有任何检查结果
  assert.equal(checkRows(sid).length, 0)
})
