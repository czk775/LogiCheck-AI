/* ============================================================
   第五阶段 · 端到端 AI 解析流水线测试

   场景：真实 PDF 文件 → 上传 → 异步解析（真实 HTTP 调用假 AI 服务）
        → 字段落库（带页码/位置/置信度/来源）→ 触发核验引擎

   验证点：
   - extracted_fields.source 记录真实来源（ai / ocr+ai），不再硬编码 deterministic
   - 证据列 evidence_quote 落库，可追溯原文
   - unverified 字段不参与跨单证比对
   - AI 失败时文档状态为 failed，错误原因可读且不含密钥
   - 扫描件 PDF 走 OCR 路径而非直接失败
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/db/index.ts'
import { loadConfig } from '../src/config.ts'
import { chatResponse, startFakeAiServer } from './helpers-fake-ai.ts'
import { buildImageOnlyPdf, buildSimplePdf } from './helpers-pdf.ts'

const INVOICE_PDF = buildSimplePdf([
  { text: 'COMMERCIAL INVOICE' },
  { text: 'Invoice No: INV-2024-8891' },
  { text: 'Invoice Date: 2024-03-15' },
  { text: 'Total Amount: USD 12,500.00' },
  { text: 'Quantity: 1000 PCS' },
])

const PACKING_PDF = buildSimplePdf([
  { text: 'PACKING LIST' },
  { text: 'Quantity: 1000 PCS' },
  { text: 'Gross Weight: 420 KGS' },
  { text: 'Shipper: ACME Trading Co' },
  { text: 'Consignee: Global Buyer Ltd' },
])

interface Harness {
  baseUrl: string
  db: ReturnType<typeof openDatabase>
  cookie: string
  shipmentId: string
  cleanup: () => Promise<void>
}

async function setupHarness(aiBaseUrl: string, aiModel = 'qwen-plus'): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-p5-'))
  const config = loadConfig({
    /* 本文件用「全库 LIMIT 1」定位被测单证，关闭演示种子避免干扰 */
    SEED_SHOWCASE: 'false',
    DATABASE_PATH: join(dir, 'test.db'),
    UPLOAD_DIR: join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: join(dir, 'outbox'),
    CORS_ORIGIN: 'http://localhost:5173',
    EXTRACTION_PROVIDER: 'ai',
    DASHSCOPE_API_KEY: 'sk-test-key-abcdef123456',
    AI_MODEL: aiModel,
    AI_BASE_URL: aiBaseUrl,
    AI_TIMEOUT_MS: '5000',
    AI_MAX_RETRIES: '0',
  } as NodeJS.ProcessEnv)

  const db = openDatabase(config.databasePath)
  const built = buildApp({ config, db })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = built.app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  // 注册并登录
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `p5-${Date.now()}@test.local`, password: 'Passw0rd!test' }),
  })
  assert.equal(reg.status, 201)
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]

  const ship = await fetch(`${baseUrl}/api/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'AI 阶段测试货物' }),
  })
  const shipBody = (await ship.json()) as { shipment: { id: string } }

  return {
    baseUrl,
    db,
    cookie,
    shipmentId: shipBody.shipment.id,
    cleanup: async () => {
      await built.app.close()
      db.close()
    },
  }
}

async function upload(h: Harness, fileName: string, buffer: Buffer, contentType: string): Promise<void> {
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(buffer)], { type: contentType }), fileName)
  const res = await fetch(`${h.baseUrl}/api/shipments/${h.shipmentId}/documents`, {
    method: 'POST',
    headers: { cookie: h.cookie },
    body: form,
  })
  assert.equal(res.status, 201, `上传失败：${res.status}`)
}

/**
 * 组合式夹具：假 AI 服务 + 应用实例绑定在一起，
 * 任何一步抛错都不会泄漏端口/连接（避免整个测试文件超时）。
 */
async function withHarness(
  responder: Parameters<typeof startFakeAiServer>[0]['responder'],
  body: (h: Harness) => Promise<void>,
  aiModel = 'qwen-plus',
): Promise<void> {
  const server = await startFakeAiServer({ responder })
  let h: Harness | null = null
  try {
    h = await setupHarness(server.baseUrl, aiModel)
    await body(h)
  } finally {
    if (h) await h.cleanup()
    await server.close()
  }
}

test('PH5E2E1 上传真实 PDF → AI 提取 → 字段带真实页码与证据落库', async () => {
  await withHarness(
    () => ({
      body: chatResponse(
        JSON.stringify({
          docType: 'invoice',
          fields: [
            { key: 'invoice_number', value: 'INV-2024-8891', quote: 'Invoice No: INV-2024-8891', page: 1 },
            { key: 'total_amount', value: 'USD 12,500.00', quote: 'Total Amount: USD 12,500.00', page: 1 },
            { key: 'quantity', value: '1000', quote: 'Quantity: 1000 PCS', page: 1 },
          ],
        }),
      ),
    }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF, 'application/pdf')

      // 等待解析队列排空
      const deadline = Date.now() + 15_000
      type FieldRow = {
        field_key: string
        value: string
        page: number | null
        source: string
        evidence_quote: string | null
        status: string
      }
      let rows: FieldRow[] = []
      while (Date.now() < deadline) {
        rows = h.db.all<FieldRow>(
          'SELECT field_key, value, page, source, evidence_quote, status FROM extracted_fields ORDER BY rowid ASC',
        )
        if (rows.length > 0) break
        await new Promise((r) => setTimeout(r, 150))
      }

      assert.ok(rows.length > 0, '应落库提取字段')
      const num = rows.find((r) => r.field_key === 'invoice_number')!
      assert.equal(num.value, 'INV-2024-8891')
      assert.equal(num.page, 1)
      assert.equal(num.source, 'ai', '来源应记录为 ai，而非硬编码 deterministic')
      assert.equal(num.evidence_quote, 'Invoice No: INV-2024-8891', '原文证据应落库可追溯')

      // 文档状态应为 parsed
      const doc = h.db.get<{ status: string; parse_summary: string | null }>(
        'SELECT status, parse_summary FROM documents LIMIT 1',
      )
      assert.equal(doc!.status, 'parsed')
      assert.ok(doc!.parse_summary && doc!.parse_summary.includes('invoice'), '解析摘要应说明单证类型')
    },
  )
})

test('PH5E2E2 跨单证比对：AI 提取的数量冲突应被核验引擎发现', async () => {
  await withHarness(
    (req) => {
      const body = JSON.stringify(req.body.messages)
      const isPacking = body.includes('PACKING LIST')
      return {
        body: chatResponse(
          JSON.stringify({
            docType: isPacking ? 'packing' : 'invoice',
            fields: [
              { key: 'quantity', value: isPacking ? '900' : '1000', quote: 'Quantity: 1000 PCS', page: 1 },
            ],
          }),
        ),
      }
    },
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF, 'application/pdf')
      await upload(h, 'packing.pdf', PACKING_PDF, 'application/pdf')

      const deadline = Date.now() + 15_000
      let findings: Array<{ title: string; summary: string; status: string; kind: string }> = []
      while (Date.now() < deadline) {
        findings = h.db.all('SELECT title, summary, status, kind FROM findings')
        if (findings.length > 0) break
        await new Promise((r) => setTimeout(r, 150))
      }

      const cross = findings.find((f) => f.kind === 'cross')
      assert.ok(cross, '跨单证数量冲突应生成异常')
      assert.match(cross!.title, /数量/)
      assert.match(cross!.summary, /1000/)
      assert.match(cross!.summary, /900/)
    },
  )
})

test('PH5E2E3 unverified 字段不参与跨单证比对（不产生假冲突）', async () => {
  await withHarness(
    (req) => {
      const body = JSON.stringify(req.body.messages)
      const isPacking = body.includes('PACKING LIST')
      return {
        body: chatResponse(
          JSON.stringify({
            docType: isPacking ? 'packing' : 'invoice',
            fields: [
              // 装箱单的引用在原文中不存在 → 无法核实
              { key: 'quantity', value: isPacking ? '999' : '1000', quote: 'Quantity: 999 PCS', page: 1 },
            ],
          }),
        ),
      }
    },
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF, 'application/pdf')
      await upload(h, 'packing.pdf', PACKING_PDF, 'application/pdf')

      const deadline = Date.now() + 15_000
      let findings: Array<{ kind: string }> = []
      while (Date.now() < deadline) {
        const n = h.db.all<{ kind: string }>('SELECT kind FROM findings')
        if (n.length > 0 || Date.now() > deadline - 12_000) {
          findings = n
          break
        }
        await new Promise((r) => setTimeout(r, 150))
      }
      // 无论是否已核验完成，都不应出现「跨单证数量冲突」
      const cross = findings.find((f) => f.kind === 'cross')
      assert.equal(cross, undefined, '无法核实的字段不得制造跨单证冲突')

      // 且该字段确实落库为 unverified
      const rows = h.db.all<{ field_key: string; status: string }>(
        "SELECT field_key, status FROM extracted_fields WHERE field_key = 'quantity'",
      )
      assert.ok(rows.some((r) => r.status === 'unverified'), '无法核实的字段应标记 unverified')
    },
  )
})

test('PH5E2E4 AI 服务失败 → 文档 failed，错误原因可读且不含密钥', async () => {
  await withHarness(
    () => ({ status: 401, body: { error: { message: 'Invalid API-key provided.' } } }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF, 'application/pdf')

      const deadline = Date.now() + 15_000
      let doc: { status: string; error: string | null } | undefined
      while (Date.now() < deadline) {
        doc = h.db.get<{ status: string; error: string | null }>('SELECT status, error FROM documents LIMIT 1')
        if (doc?.status === 'failed') break
        await new Promise((r) => setTimeout(r, 150))
      }
      assert.equal(doc!.status, 'failed')
      assert.ok(doc!.error, '应记录失败原因')
      assert.ok(/鉴权|API Key/i.test(doc!.error!), `错误原因应可读：${doc!.error}`)
      assert.ok(!doc!.error!.includes('sk-test-key-abcdef123456'), '错误原因不得包含密钥')
    },
  )
})

test('PH5E2E5 扫描件 PDF（无文本层）→ 走 OCR 路径，不再直接失败', async () => {
  await withHarness(
    (req) => {
      const body = JSON.stringify(req.body.messages)
      // OCR 请求带图片；提取请求带页文本
      if (body.includes('image_url')) {
        return { body: chatResponse('SCANNED INVOICE\nInvoice No: INV-SCAN-001') }
      }
      return {
        body: chatResponse(
          JSON.stringify({
            docType: 'invoice',
            fields: [
              { key: 'invoice_number', value: 'INV-SCAN-001', quote: 'Invoice No: INV-SCAN-001', page: 1 },
            ],
          }),
        ),
      }
    },
    async (h) => {
      await upload(h, 'scan.pdf', buildImageOnlyPdf(), 'application/pdf')

      const deadline = Date.now() + 25_000
      let doc: { status: string; error: string | null } | undefined
      while (Date.now() < deadline) {
        doc = h.db.get<{ status: string; error: string | null }>('SELECT status, error FROM documents LIMIT 1')
        if (doc?.status === 'parsed' || doc?.status === 'failed') break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert.equal(doc!.status, 'parsed', `扫描件应解析成功，实际错误：${doc!.error}`)
      const row = h.db.get<{ source: string; evidence_quote: string | null }>(
        "SELECT source, evidence_quote FROM extracted_fields WHERE field_key = 'invoice_number'",
      )
      assert.ok(row, '应提取到发票号')
      assert.equal(row!.source, 'ocr+ai', '扫描件来源应标记为 ocr+ai')
      assert.equal(row!.evidence_quote, 'Invoice No: INV-SCAN-001')
    },
  )
})

test('PH5E2E6 未配置 AI 时保持诚实：AI 模式但无 Key → 明确失败而非假装成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-p5-nokey-'))
  const config = loadConfig({
    /* 本文件用「全库 LIMIT 1」定位被测单证，关闭演示种子避免干扰 */
    SEED_SHOWCASE: 'false',
    DATABASE_PATH: join(dir, 'test.db'),
    UPLOAD_DIR: join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: join(dir, 'outbox'),
    EXTRACTION_PROVIDER: 'ai',
    // 故意不提供 Key
  } as NodeJS.ProcessEnv)
  assert.equal(config.ai, null, '无 Key 时不应算作已配置')

  const db = openDatabase(config.databasePath)
  const built = buildApp({ config, db })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  try {
    const addr = built.app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const baseUrl = `http://127.0.0.1:${port}`
    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `p5nokey-${Date.now()}@test.local`, password: 'Passw0rd!test' }),
    })
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
    const ship = await fetch(`${baseUrl}/api/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '无 Key 货物' }),
    })
    const shipBody = (await ship.json()) as { shipment: { id: string } }
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array(INVOICE_PDF)], { type: 'application/pdf' }), 'invoice.pdf')
    await fetch(`${baseUrl}/api/shipments/${shipBody.shipment.id}/documents`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    const deadline = Date.now() + 10_000
    let doc: { status: string; error: string | null } | undefined
    while (Date.now() < deadline) {
      doc = db.get<{ status: string; error: string | null }>('SELECT status, error FROM documents LIMIT 1')
      if (doc?.status === 'failed') break
      await new Promise((r) => setTimeout(r, 150))
    }
    assert.equal(doc!.status, 'failed', '未配置 AI 时必须明确失败，不能假装解析成功')
    assert.ok(/未配置|API Key/i.test(doc!.error!), `错误原因应说明未配置：${doc!.error}`)
  } finally {
    await built.app.close()
    db.close()
  }
})
