/* ============================================================
   单证解析流水线集成测试（阶段二）

   全部使用「真实文件」走完整链路：HTTP 上传 → 落库入队 →
   ParsePipeline 解析 → extracted_fields 溯源信息 → 状态机终态。
   诚实边界：OCR 未接入 → 明确失败；不支持的 EDI 类型 → 明确报错；
   扫描件（无文本层）→ 明确失败。绝不允许预设结果冒充解析。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'
import { buildImageOnlyPdf, buildSimplePdf } from './helpers-pdf.ts'

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

async function createShipment(c: ReturnType<typeof env.client>, name = '解析流水线货物') {
  const res = await c.post('/api/shipments', { name })
  assert.equal(res.status, 201, res.text)
  return (res.json as { shipment: { id: string } }).shipment.id
}

function uploadForm(files: Array<{ name: string; type: string; bytes: Buffer }>): FormData {
  const fd = new FormData()
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type }), f.name)
  return fd
}

/** 真实构造的发票 PDF（文本层含标准标签） */
function invoicePdf(): Buffer {
  return buildSimplePdf([
    { text: 'COMMERCIAL INVOICE', size: 16 },
    { text: 'Invoice No.: INV-2026-0100' },
    { text: 'Invoice Date: 2026-01-15' },
    { text: 'Description: Bluetooth Speaker' },
    { text: 'Model: LS-B200' },
    { text: 'Quantity: 1000 PCE' },
    { text: 'Unit Price: USD 12.50' },
    { text: 'Total Amount: USD 12500.00' },
    { text: 'Shipper: Supplier Co., Ltd.' },
    { text: 'Consignee: Buyer GmbH' },
  ])
}

/** 真实 EDIFACT INVOIC 报文 */
const INVOIC_EDI = `UNB+UNOC:3+SENDERGLN+RECIPGLN+260101:1200+INVREF001++EANCOM'
UNH+M001+INVOIC:D:96A:UN:EAN008'
BGM+380+INV-2026-0042+9'
DTM+137:20260105:102'
NAD+BY+Buyer GmbH++Main St 1+Berlin++10115+DE'
NAD+SU+Supplier Co., Ltd.++Nanjing Rd 88+Shanghai++200001+CN'
CUX+2:USD:4'
LIN+1++PRODUCT-A:SA'
QTY+47:1000:PCE'
PRI+AAA:12.50:::EA'
MOA+203:12500.00'
UNT+9+M001'
UNZ+1+INVREF001'`

/** 不支持的 EDIFACT 消息类型（真实结构的 ORDERS 报文） */
const ORDERS_EDI = `UNB+UNOC:3+SENDERGLN+RECIPGLN+260101:1200+ORDREF001++EANCOM'
UNH+M001+ORDERS:D:96A:UN:EAN008'
BGM+220+PO-2026-0031+9'
DTM+137:20260105:102'
UNT+5+M001'
UNZ+1+ORDREF001'`

interface DocRow {
  id: string
  status: string
  error: string | null
  doc_type: string
  parse_summary: string | null
}

async function docRow(docId: string): Promise<DocRow> {
  const row = env.db.get<DocRow>('SELECT id, status, error, doc_type, parse_summary FROM documents WHERE id = ?', docId)
  assert.ok(row, `文档 ${docId} 应存在`)
  return row
}

async function uploadOne(c: ReturnType<typeof env.client>, sid: string, file: { name: string; type: string; bytes: Buffer }): Promise<string> {
  const res = await c.postForm(`/api/shipments/${sid}/documents`, uploadForm([file]))
  assert.equal(res.status, 201, res.text)
  return (res.json as { accepted: Array<{ id: string }> }).accepted[0].id
}

test('P1 真实发票 PDF：上传 → parsed，字段带完整溯源信息', async () => {
  const c = await registerAndLogin('pdf-parse@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })

  await env.waitForParseIdle()

  const doc = await docRow(docId)
  assert.equal(doc.status, 'parsed', doc.error ?? '')
  assert.equal(doc.doc_type, 'invoice', '应从文本内容识别出单证类型')
  assert.ok((doc.parse_summary ?? '').length > 0, '应写入可解释的解析摘要')

  const fields = env.db.all<{ field_key: string; value: string; normalized_value: string | null; page: number | null; position: string | null; confidence: number | null; status: string; source: string }>(
    'SELECT field_key, value, normalized_value, page, position, confidence, status, source FROM extracted_fields WHERE document_id = ? ORDER BY rowid ASC',
    docId,
  )
  const byKey = new Map(fields.map((f) => [f.field_key, f]))

  // 值必须来自真实文件内容（而非预设）
  assert.equal(byKey.get('invoice_number')?.value, 'INV-2026-0100')
  assert.equal(byKey.get('quantity')?.value, '1000')
  assert.equal(byKey.get('quantity')?.normalized_value, '1000')
  assert.equal(byKey.get('unit_price')?.value, 'USD 12.50')
  assert.equal(byKey.get('unit_price')?.normalized_value, '12.50')
  assert.equal(byKey.get('total_amount')?.normalized_value, '12500.00')
  assert.equal(byKey.get('invoice_date')?.normalized_value, '2026-01-15')
  assert.equal(byKey.get('shipper')?.value, 'Supplier Co., Ltd.')

  // 溯源信息：来源 / 页码 / 位置 / 置信度 / 状态
  const inv = byKey.get('invoice_number')!
  assert.equal(inv.source, 'deterministic')
  assert.equal(inv.page, 1)
  assert.match(inv.position ?? '', /^p1@\d+$/)
  assert.ok((inv.confidence ?? 0) >= 0.9, '标签精确命中应为高置信')
  assert.equal(inv.status, 'extracted')

  // 解析 run 与活动记录（可审计）
  const runs = env.db.all<{ trigger: string; status: string }>('SELECT trigger, status FROM processing_runs WHERE shipment_id = ?', sid)
  assert.ok(runs.some((r) => r.trigger === 'parse' && r.status === 'succeeded'))
  const acts = env.db.all<{ text: string }>('SELECT text FROM activities WHERE shipment_id = ?', sid)
  assert.ok(acts.some((a) => a.text.includes('解析完成')))
})

test('P2 未在文件中出现的适用字段 → missing（不补默认值）', async () => {
  const c = await registerAndLogin('pdf-missing@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await env.waitForParseIdle()

  const po = env.db.get<{ status: string; value: string; confidence: number | null }>(
    "SELECT status, value, confidence FROM extracted_fields WHERE document_id = ? AND field_key = 'po_number'",
    docId,
  )
  assert.ok(po, '发票的适用字段 po_number 应有一条记录')
  assert.equal(po.status, 'missing', '文件中没有采购订单号 → missing，不得编造')
  assert.equal(po.value, '')
  assert.equal(po.confidence, 0)
})

test('P3 PNG 上传：OCR 未接入 → 明确失败（不伪造字段）', async () => {
  const c = await registerAndLogin('png-fail@example.com')
  const sid = await createShipment(c)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  const docId = await uploadOne(c, sid, { name: 'scan.png', type: 'image/png', bytes: png })

  await env.waitForParseIdle()

  const doc = await docRow(docId)
  assert.equal(doc.status, 'failed')
  assert.match(doc.error ?? '', /OCR/, '失败原因必须说明 OCR 未接入')
  const n = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extracted_fields WHERE document_id = ?', docId)!.n
  assert.equal(n, 0, '失败解析不得写入任何字段')
})

test('P4 扫描件 PDF（无文本层）→ 明确失败并提示需要 OCR', async () => {
  const c = await registerAndLogin('scanned-pdf@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'scan.pdf', type: 'application/pdf', bytes: buildImageOnlyPdf() })

  await env.waitForParseIdle()

  const doc = await docRow(docId)
  assert.equal(doc.status, 'failed')
  assert.match(doc.error ?? '', /OCR|文本层/)
})

test('P5 不支持的 EDIFACT 消息类型（ORDERS）→ 明确报错', async () => {
  const c = await registerAndLogin('edi-unsupported@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'order.edi', type: 'text/plain', bytes: Buffer.from(ORDERS_EDI, 'utf8') })

  await env.waitForParseIdle()

  const doc = await docRow(docId)
  assert.equal(doc.status, 'failed')
  assert.match(doc.error ?? '', /ORDERS/, '应指出不被支持的消息类型')
  const n = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extracted_fields WHERE document_id = ?', docId)!.n
  assert.equal(n, 0)
})

test('P6 真实 EDIFACT INVOIC：结构化映射 + 段级溯源', async () => {
  const c = await registerAndLogin('edi-parse@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'invoice.edi', type: 'text/plain', bytes: Buffer.from(INVOIC_EDI, 'utf8') })

  await env.waitForParseIdle()

  const doc = await docRow(docId)
  assert.equal(doc.status, 'parsed', doc.error ?? '')
  assert.equal(doc.doc_type, 'invoice')

  const byKey = new Map(
    env.db.all<{ field_key: string; value: string; normalized_value: string | null; position: string | null; confidence: number | null; status: string }>(
      'SELECT field_key, value, normalized_value, position, confidence, status FROM extracted_fields WHERE document_id = ?',
      docId,
    ).map((f) => [f.field_key, f]),
  )

  assert.equal(byKey.get('invoice_number')?.value, 'INV-2026-0042')
  assert.equal(byKey.get('invoice_date')?.value, '20260105')
  assert.equal(byKey.get('po_number')?.status, 'missing', '报文无 RFF+ON → missing')
  assert.equal(byKey.get('quantity')?.value, '1000')
  assert.equal(byKey.get('unit')?.value, 'PCE')
  assert.equal(byKey.get('currency')?.value, 'USD')
  assert.equal(byKey.get('total_amount')?.normalized_value, '12500.00')
  assert.equal(byKey.get('unit_price')?.normalized_value, '12.50')
  assert.equal(byKey.get('shipper')?.value, 'Supplier Co., Ltd.')
  assert.equal(byKey.get('consignee')?.value, 'Buyer GmbH')

  // 溯源：段引用（如 BGM#3）+ 置信度
  const inv = byKey.get('invoice_number')!
  assert.match(inv.position ?? '', /^BGM#\d+$/)
  assert.ok((inv.confidence ?? 0) > 0)
})

test('P7 重试：failed → 重新入队 → 再次解析（run 记录可数）', async () => {
  const c = await registerAndLogin('retry-parse@example.com')
  const sid = await createShipment(c)
  const docId = await uploadOne(c, sid, { name: 'order.edi', type: 'text/plain', bytes: Buffer.from(ORDERS_EDI, 'utf8') })
  await env.waitForParseIdle()
  assert.equal((await docRow(docId)).status, 'failed')

  const retry = await c.post(`/api/documents/${docId}/retry`)
  assert.equal(retry.status, 200, retry.text)
  assert.equal((retry.json as { document: { status: string } }).document.status, 'uploaded', '重试响应应回到待解析')

  await env.waitForParseIdle()
  assert.equal((await docRow(docId)).status, 'failed', '不支持的类型重试后仍应诚实失败')

  const parseRuns = env.db.all<{ trigger: string }>(
    "SELECT trigger FROM processing_runs WHERE shipment_id = ? AND trigger = 'parse'",
    sid,
  )
  assert.equal(parseRuns.length, 2, '初次解析 + 重试应各产生一条 parse run')
})

test('P8 重启恢复：parsing 中的文档重新排队并完成解析', async () => {
  const c = await registerAndLogin('restart-recover@example.com')
  const sid = await createShipment(c)
  // 先上传一份正常解析完的 PDF
  const first = await uploadOne(c, sid, { name: 'invoice.pdf', type: 'application/pdf', bytes: invoicePdf() })
  await env.waitForParseIdle()
  assert.equal((await docRow(first)).status, 'parsed')

  // 模拟「服务在解析中途崩溃」：同一文件、新文档行、状态卡在 parsing
  const storageKey = env.db.get<{ storage_key: string; user_id: string }>('SELECT storage_key, user_id FROM documents WHERE id = ?', first)!
  const stuckId = 'doc-stuck-restart'
  const now = new Date().toISOString()
  env.db.run(
    `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, error, is_demo, created_at, updated_at)
     VALUES (?, ?, ?, 'invoice.pdf', '待 AI 识别', 'pdf', 'parsing', 1, ?, NULL, 0, ?, ?)`,
    stuckId, sid, storageKey.user_id, storageKey.storage_key, now, now,
  )

  await env.restart()
  await env.waitForParseIdle()

  const recovered = await docRow(stuckId)
  assert.equal(recovered.status, 'parsed', '重启后卡在 parsing 的文档应被恢复并重新解析成功')
  assert.equal(recovered.doc_type, 'invoice')
  const n = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extracted_fields WHERE document_id = ?', stuckId)!.n
  assert.ok(n > 0, '恢复后应真实写入提取字段')

  // 已完成的文档不被重复解析：两份文档各恰好一次 parse run
  const parseRuns = env.db.all<{ n: number }>(
    "SELECT COUNT(*) AS n FROM processing_runs WHERE shipment_id = ? AND trigger = 'parse'",
    sid,
  )
  assert.equal(parseRuns[0].n, 2, '首份文档一次 + 恢复的文档一次，不得重复解析')
})
