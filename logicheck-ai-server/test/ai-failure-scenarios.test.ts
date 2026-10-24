/* ============================================================
 * 第五阶段 · 失败场景自动化测试
 *
 * 目的：把「模型会出什么问题」全部固化成可回归的用例，
 *      而不是等真实使用中才暴露。
 *
 * 覆盖场景：
 *   - 鉴权失败（401）           → ai_auth_failed，不重试，错误可读
 *   - 额度不足 / 欠费（429）    → ai_quota_exceeded，不重试
 *   - 限流（429）               → ai_rate_limited，可重试
 *   - 服务端异常（500）         → ai_server_error
 *   - 超时（服务端不响应）      → ai_timeout
 *   - 模型返回非 JSON           → ai_unknown/invalid，明确失败
 *   - 模型返回 JSON 结构不符     → 字段为空，不伪造
 *   - 恢复路径：失败后重试成功   → 文档状态回到 parsed，字段落库
 *   - 失败信息绝不含密钥
 * ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildApp } from '../src/app.ts'
import { openDatabase } from '../src/db/index.ts'
import { loadConfig } from '../src/config.ts'
import { chatResponse, errorResponse, startFakeAiServer } from './helpers-fake-ai.ts'
import { buildSimplePdf } from './helpers-pdf.ts'

const SECRET = 'sk-test-key-abcdef123456'
const INVOICE_PDF = buildSimplePdf([
  { text: 'COMMERCIAL INVOICE' },
  { text: 'Invoice No: INV-2024-8891' },
  { text: 'Total Amount: USD 12,500.00' },
])

interface Harness {
  baseUrl: string
  db: ReturnType<typeof openDatabase>
  cookie: string
  shipmentId: string
  cleanup: () => Promise<void>
}

async function setupHarness(aiBaseUrl: string, opts: { timeoutMs?: string; maxRetries?: string } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-p5f-'))
  const config = loadConfig({
    DATABASE_PATH: join(dir, 'test.db'),
    UPLOAD_DIR: join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: join(dir, 'outbox'),
    CORS_ORIGIN: 'http://localhost:5173',
    EXTRACTION_PROVIDER: 'ai',
    DASHSCOPE_API_KEY: SECRET,
    AI_MODEL: 'qwen3.8-flash',
    AI_BASE_URL: aiBaseUrl,
    AI_TIMEOUT_MS: opts.timeoutMs ?? '5000',
    AI_MAX_RETRIES: opts.maxRetries ?? '0',
  } as NodeJS.ProcessEnv)

  const db = openDatabase(config.databasePath)
  const built = buildApp({ config, db })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = built.app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `p5f-${Date.now()}@test.local`, password: 'Passw0rd!test' }),
  })
  assert.equal(reg.status, 201)
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]

  const ship = await fetch(`${baseUrl}/api/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '失败场景测试货物' }),
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

async function upload(h: Harness, fileName: string, buffer: Buffer): Promise<void> {
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(buffer)], { type: 'application/pdf' }), fileName)
  const res = await fetch(`${h.baseUrl}/api/shipments/${h.shipmentId}/documents`, {
    method: 'POST',
    headers: { cookie: h.cookie },
    body: form,
  })
  assert.equal(res.status, 201, `上传失败：${res.status}`)
}

/** 等待文档进入终态（parsed / failed） */
async function waitForTerminal(
  h: Harness,
  timeoutMs = 15_000,
): Promise<{ status: string; error: string | null }> {
  const deadline = Date.now() + timeoutMs
  let last: { status: string; error: string | null } = { status: 'pending', error: null }
  while (Date.now() < deadline) {
    const row = h.db.get<{ status: string; error: string | null }>(
      'SELECT status, error FROM documents LIMIT 1',
    )
    if (row) {
      last = row
      if (row.status === 'parsed' || row.status === 'failed') return last
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return last
}

async function withHarness(
  responder: Parameters<typeof startFakeAiServer>[0]['responder'],
  body: (h: Harness, server: Awaited<ReturnType<typeof startFakeAiServer>>) => Promise<void>,
  opts: { timeoutMs?: string; maxRetries?: string } = {},
): Promise<void> {
  const server = await startFakeAiServer({ responder })
  let h: Harness | null = null
  try {
    h = await setupHarness(server.baseUrl, opts)
    await body(h, server)
  } finally {
    if (h) await h.cleanup()
    await server.close()
  }
}

/* ---------- 各失败场景 ---------- */

test('PH5F1 鉴权失败 → 文档 failed，错误可读且不含密钥，不重试', async () => {
  await withHarness(
    () => ({ status: 401, body: errorResponse(401, 'Invalid API-key provided.') }),
    async (h, server) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.ok(doc.error, '应记录失败原因')
      assert.match(doc.error!, /鉴权|API Key/i, `错误原因应可读：${doc.error}`)
      assert.ok(!doc.error!.includes(SECRET), '错误原因绝不能包含密钥')
      assert.equal(server.requests.length, 1, '鉴权失败不应重试')
    },
  )
})

test('PH5F2 额度不足（429 + quota 关键词）→ 明确区分于限流，不重试', async () => {
  await withHarness(
    () => ({ status: 429, body: errorResponse(429, 'Your current quota is exceeded, please check your billing.') }),
    async (h, server) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /额度|欠费|余额/)
      assert.ok(!/限流|过于频繁/.test(doc.error!), '额度不足不得被误报为限流')
      assert.equal(server.requests.length, 1, '额度不足不应重试')
    },
  )
})

test('PH5F3 限流（429 + rate limit 关键词）→ 提示限流，可重试', async () => {
  await withHarness(
    () => ({ status: 429, body: errorResponse(429, 'Rate limit reached for requests per minute.') }),
    async (h, server) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /限流|过于频繁/)
      assert.equal(server.requests.length, 1, '本次配置重试次数为 0，故只调 1 次')
    },
  )
})

test('PH5F4 服务端异常（500）→ 提示服务异常，可重试', async () => {
  await withHarness(
    () => ({ status: 500, body: errorResponse(500, 'Internal server error.') }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /服务|暂时不可用|异常/)
    },
  )
})

test('PH5F5 超时（服务端延迟超过超时阈值）→ 提示超时', async () => {
  await withHarness(
    () => ({ status: 200, body: chatResponse('{}'), delayMs: 3000 }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h, 20_000)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /超时/)
    },
    { timeoutMs: '800' },
  )
})

test('PH5F6 模型返回非 JSON → 明确失败，不落库任何字段', async () => {
  await withHarness(
    () => ({ body: chatResponse('抱歉，我无法处理这个请求。') }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /JSON|格式|解析/i)
      const fields = h.db.all('SELECT * FROM extracted_fields')
      assert.equal(fields.length, 0, '失败时不得落库任何提取字段')
    },
  )
})

test('PH5F7 模型返回 JSON 但字段结构不符 → 字段为空且标记缺失，不伪造', async () => {
  await withHarness(
    () => ({ body: chatResponse(JSON.stringify({ unexpected: 'shape', fields: 'not-an-array' })) }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      // 结构不符时要么明确失败，要么解析出「适用但缺失」，两者都不得出现伪造值
      if (doc.status === 'failed') {
        assert.ok(doc.error)
      } else {
        const rows = h.db.all<{ value: string; status: string }>(
          'SELECT value, status FROM extracted_fields',
        )
        for (const r of rows) {
          if (r.status === 'extracted') {
            assert.ok(r.value.length > 0, '标为 extracted 的字段必须有真实值')
          }
        }
      }
    },
  )
})

test('PH5F8 失败后可重新解析成功（恢复路径）', async () => {
  await withHarness(
    (_req, idx) => {
      // 第一次 401，之后成功
      if (idx === 0) return { status: 401, body: errorResponse(401, 'Invalid API-key provided.') }
      return {
        body: chatResponse(
          JSON.stringify({
            docType: 'invoice',
            fields: [{ key: 'invoice_number', value: 'INV-2024-8891', quote: 'Invoice No: INV-2024-8891', page: 1 }],
          }),
        ),
      }
    },
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const first = await waitForTerminal(h)
      assert.equal(first.status, 'failed', '首次应失败')

      // 触发重新解析
      const docId = h.db.get<{ id: string }>('SELECT id FROM documents LIMIT 1')!.id
      const retry = await fetch(`${h.baseUrl}/api/documents/${docId}/retry`, {
        method: 'POST',
        headers: { cookie: h.cookie },
      })
      assert.ok(retry.status === 200 || retry.status === 201, `重试接口应成功：${retry.status}`)

      const second = await waitForTerminal(h)
      assert.equal(second.status, 'parsed', '重试后应解析成功')
      assert.equal(second.error, null, '成功后应清空错误')

      const row = h.db.get<{ value: string; source: string }>(
        "SELECT value, source FROM extracted_fields WHERE field_key = 'invoice_number'",
      )
      assert.equal(row?.value, 'INV-2024-8891')
      assert.equal(row?.source, 'ai')
    },
  )
})

test('PH5F9 失败原因不含密钥明文（多场景覆盖）', async () => {
  const scenarios: Array<{ status: number; message: string }> = [
    { status: 401, message: 'Invalid API-key provided.' },
    { status: 429, message: 'Rate limit reached.' },
    { status: 500, message: 'Internal error.' },
    { status: 403, message: 'Access denied.' },
  ]
  for (const sc of scenarios) {
    await withHarness(
      () => ({ status: sc.status, body: errorResponse(sc.status, sc.message) }),
      async (h) => {
        await upload(h, 'invoice.pdf', INVOICE_PDF)
        const doc = await waitForTerminal(h)
        assert.equal(doc.status, 'failed')
        assert.ok(!doc.error!.includes(SECRET), `HTTP ${sc.status} 的错误信息不得含密钥`)
        assert.ok(!/Bearer\s+sk-/i.test(doc.error!), `HTTP ${sc.status} 的错误信息不得含鉴权头`)
      },
    )
  }
})

test('PH5F10 AI 未配置时上传 → 明确失败，不回落成确定性提取冒充 AI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-p5n-'))
  const config = loadConfig({
    DATABASE_PATH: join(dir, 'test.db'),
    UPLOAD_DIR: join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: join(dir, 'outbox'),
    CORS_ORIGIN: 'http://localhost:5173',
    EXTRACTION_PROVIDER: 'ai',
    // 不提供 API Key 与模型名
  } as NodeJS.ProcessEnv)
  const db = openDatabase(config.databasePath)
  const built = buildApp({ config, db })
  try {
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = built.app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const baseUrl = `http://127.0.0.1:${port}`

    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `p5n-${Date.now()}@test.local`, password: 'Passw0rd!test' }),
    })
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
    const ship = await fetch(`${baseUrl}/api/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: '未配置 AI' }),
    })
    const shipBody = (await ship.json()) as { shipment: { id: string } }

    // AI 状态端点应如实报告未接通
    const statusRes = await fetch(`${baseUrl}/api/system/ai-status`)
    const status = (await statusRes.json()) as { configured: boolean; reason?: string }
    assert.equal(status.configured, false)
    assert.ok(status.reason, '未接通时应给出原因')

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
      if (doc && (doc.status === 'parsed' || doc.status === 'failed')) break
      await new Promise((r) => setTimeout(r, 120))
    }
    assert.equal(doc!.status, 'failed', '未配置 AI 时必须明确失败，不得静默回落')
    const fields = db.all('SELECT * FROM extracted_fields')
    assert.equal(fields.length, 0, '不得用确定性提取冒充 AI 结果落库')
  } finally {
    await built.app.close()
    db.close()
  }
})

test('PH5F11 失败时 documents.error 带错误码前缀（前端据此做精确映射）', async () => {
  await withHarness(
    () => ({ status: 401, body: errorResponse(401, 'Invalid API-key provided.') }),
    async (h) => {
      await upload(h, 'invoice.pdf', INVOICE_PDF)
      const doc = await waitForTerminal(h)
      assert.equal(doc.status, 'failed')
      assert.match(doc.error!, /^\[ai_auth_failed\]/, `错误应带码前缀：${doc.error}`)
      assert.ok(/鉴权|API Key/i.test(doc.error!), '错误原因仍应可读')
    },
  )
})

test('PH5F12 OCR 未配置时错误码为 ocr_not_configured（图片单证）', async () => {
  // 不配置视觉模型：AI_VISION_MODEL 留空且 AI_MODEL 也不可用
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-p5o-'))
  const config = loadConfig({
    DATABASE_PATH: join(dir, 'test.db'),
    UPLOAD_DIR: join(dir, 'uploads'),
    MAIL_OUTBOX_DIR: join(dir, 'outbox'),
    CORS_ORIGIN: 'http://localhost:5173',
    EXTRACTION_PROVIDER: 'ai',
    // 故意不提供任何 Key / 模型 → OCR 与提取都不可用
  } as NodeJS.ProcessEnv)
  const db = openDatabase(config.databasePath)
  const built = buildApp({ config, db })
  try {
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = built.app.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const baseUrl = `http://127.0.0.1:${port}`

    const reg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `p5o-${Date.now()}@test.local`, password: 'Passw0rd!test' }),
    })
    const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
    const ship = await fetch(`${baseUrl}/api/shipments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'OCR 未配置' }),
    })
    const shipBody = (await ship.json()) as { shipment: { id: string } }

    // 上传 PNG → 走 OCR 路径 → OCR 未配置 → 明确失败
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001' +
        '5c1d7c0000000049454e44ae426082',
      'hex',
    )
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'scan.png')
    await fetch(`${baseUrl}/api/shipments/${shipBody.shipment.id}/documents`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })

    const deadline = Date.now() + 10_000
    let doc: { status: string; error: string | null } | undefined
    while (Date.now() < deadline) {
      doc = db.get<{ status: string; error: string | null }>('SELECT status, error FROM documents LIMIT 1')
      if (doc && (doc.status === 'parsed' || doc.status === 'failed')) break
      await new Promise((r) => setTimeout(r, 120))
    }
    assert.equal(doc!.status, 'failed', 'OCR 未配置时图片必须明确失败')
    assert.match(doc!.error!, /^\[(ocr_not_configured|ai_not_configured|ai_not_connected)\]/, `错误应带码：${doc!.error}`)
  } finally {
    await built.app.close()
    db.close()
  }
})
