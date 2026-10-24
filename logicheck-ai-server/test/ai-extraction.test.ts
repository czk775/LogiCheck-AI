/* ============================================================
   第五阶段 · AI 提取 Provider 测试（核心诚实性机制）

   核心验证点：
   - 模型必须为每个字段给出原文引用（quote）
   - 只有 quote 真实出现在指定页文本中，该字段才被接受
   - 页码由「引用实际出现在哪一页」决定，而非采信模型声称的页码
   - 位置（offset）由引用在页面文本中的真实下标计算
   - 置信度由核验结果确定，不采信模型自报数值
   - 引用找不到的字段 → 标记为不可用（不进入核验），绝不伪造
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AiExtractionProvider } from '../src/modules/parsing/providers/ai/provider.ts'
import { verifyFieldQuote, type AiFieldClaim } from '../src/modules/parsing/providers/ai/verify.ts'
import type { PdfPage } from '../src/modules/parsing/schema.ts'
import { chatResponse, startFakeAiServer } from './helpers-fake-ai.ts'

const PAGES: PdfPage[] = [
  { pageNumber: 1, text: 'COMMERCIAL INVOICE\nInvoice No: INV-2024-8891\nInvoice Date: 2024-03-15' },
  { pageNumber: 2, text: 'Total Amount: USD 12,500.00\nQuantity: 1000 PCS\nPort of Loading: Shanghai' },
]

/* ---------- 纯函数层：引用核验 ---------- */

test('PH5VER1 quote 真实出现在第 2 页 → 接受，页码=2，位置=真实下标', () => {
  const claim: AiFieldClaim = { key: 'total_amount', value: '12,500.00', quote: 'Total Amount: USD 12,500.00', page: 2 }
  const r = verifyFieldQuote(claim, PAGES)
  assert.equal(r.accepted, true)
  assert.equal(r.page, 2)
  assert.equal(r.position, 'p2@0')
  assert.ok(r.confidence > 0)
})

test('PH5VER2 quote 实际在第 1 页但模型声称第 2 页 → 以真实页码为准', () => {
  const claim: AiFieldClaim = { key: 'invoice_number', value: 'INV-2024-8891', quote: 'INV-2024-8891', page: 2 }
  const r = verifyFieldQuote(claim, PAGES)
  assert.equal(r.accepted, true)
  assert.equal(r.page, 1, '页码必须由引用实际位置决定，不能采信模型声称')
})

test('PH5VER3 quote 在任何页都找不到 → 拒绝接受，不伪造页码与位置', () => {
  const claim: AiFieldClaim = { key: 'shipper', value: 'ACME Corp', quote: 'Shipper: ACME Corp', page: 1 }
  const r = verifyFieldQuote(claim, PAGES)
  assert.equal(r.accepted, false)
  assert.equal(r.page, null, '无法核实的字段不得有页码')
  assert.equal(r.position, null, '无法核实的字段不得有位置')
})

test('PH5VER4 quote 忽略大小写与多余空白后可匹配', () => {
  const pages: PdfPage[] = [{ pageNumber: 1, text: 'INVOICE   NO:  INV-001' }]
  const claim: AiFieldClaim = { key: 'invoice_number', value: 'INV-001', quote: 'Invoice No: INV-001', page: 1 }
  const r = verifyFieldQuote(claim, pages)
  assert.equal(r.accepted, true)
  assert.equal(r.page, 1)
})

test('PH5VER5 引用核验通过时置信度高于未通过时（置信度由核验决定）', () => {
  const good = verifyFieldQuote({ key: 'quantity', value: '1000', quote: 'Quantity: 1000 PCS', page: 2 }, PAGES)
  const bad = verifyFieldQuote({ key: 'quantity', value: '9999', quote: 'Quantity: 9999 PCS', page: 2 }, PAGES)
  assert.ok(good.confidence > bad.confidence)
})

test('PH5VER6 空 quote 一律拒绝（模型没给证据就等于没证据）', () => {
  const r = verifyFieldQuote({ key: 'product', value: 'Widget', quote: '', page: 1 }, PAGES)
  assert.equal(r.accepted, false)
})

/* ---------- Provider 层：端到端（真实 HTTP） ---------- */

test('PH5AI2 Provider 从假服务拿到 JSON，输出字段带核验后的页码位置', async () => {
  const server = await startFakeAiServer({
    responder: () => ({
      body: chatResponse(
        JSON.stringify({
          docType: 'invoice',
          fields: [
            { key: 'invoice_number', value: 'INV-2024-8891', quote: 'Invoice No: INV-2024-8891', page: 1 },
            { key: 'total_amount', value: '12,500.00', quote: 'Total Amount: USD 12,500.00', page: 2 },
            { key: 'shipper', value: 'ACME', quote: 'Shipper: ACME', page: 1 },
          ],
        }),
      ),
    }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new AiExtractionProvider({
      client: new LlmClient({
        apiKey: 'sk-test',
        baseUrl: server.baseUrl,
        model: 'qwen-plus',
        timeoutMs: 5_000,
        maxRetries: 0,
      }),
    })
    const out = await provider.extract({ format: 'pdf', fileName: 'invoice.pdf', pages: PAGES })

    assert.equal(out.docType, 'invoice')
    const num = out.fields.find((f) => f.fieldKey === 'invoice_number')!
    assert.equal(num.value, 'INV-2024-8891')
    assert.equal(num.page, 1)
    assert.equal(num.status, 'extracted')
    assert.ok(num.confidence > 0)

    const amount = out.fields.find((f) => f.fieldKey === 'total_amount')!
    assert.equal(amount.page, 2)

    // 无法核实的字段不得出现在已提取字段里
    const shipper = out.fields.find((f) => f.fieldKey === 'shipper')!
    assert.equal(shipper.status, 'unverified', '引用无法核实的字段必须标为无法核实')
    assert.equal(shipper.value, '', '未核实字段不得保留模型给出的值')
    assert.equal(shipper.page, null)
    assert.equal(shipper.position, null)

    // 适用但未提取的字段 → missing
    const missing = out.fields.filter((f) => f.status === 'missing')
    assert.ok(missing.length > 0, '适用但未提取的字段应标 missing')
  } finally {
    await server.close()
  }
})

test('PH5AI3 模型返回非法 JSON → 明确失败，不返回空结果冒充成功', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('这不是 JSON') }) })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new AiExtractionProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'm', timeoutMs: 5_000, maxRetries: 0 }),
    })
    await assert.rejects(
      () => provider.extract({ format: 'pdf', fileName: 'x.pdf', pages: PAGES }),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.ok(/JSON|格式|结构/i.test(err.message), `错误信息应说明 JSON/结构问题，实际：${err.message}`)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('PH5AI4 模型返回未知字段 key → 丢弃该字段（不写入未知键）', async () => {
  const server = await startFakeAiServer({
    responder: () => ({
      body: chatResponse(
        JSON.stringify({
          docType: 'invoice',
          fields: [
            { key: 'invoice_number', value: 'INV-2024-8891', quote: 'Invoice No: INV-2024-8891', page: 1 },
            { key: 'totally_unknown_field', value: 'x', quote: 'INV-2024-8891', page: 1 },
          ],
        }),
      ),
    }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new AiExtractionProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'm', timeoutMs: 5_000, maxRetries: 0 }),
    })
    const out = await provider.extract({ format: 'pdf', fileName: 'x.pdf', pages: PAGES })
    const unknown = out.fields.find((f) => String(f.fieldKey) === 'totally_unknown_field')
    assert.equal(unknown, undefined, '未知字段键不得出现在输出里')
  } finally {
    await server.close()
  }
})

test('PH5AI5 模型声称的单证类型不在允许集合 → 记为 unknown 而非臆断', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ body: chatResponse(JSON.stringify({ docType: '合同', fields: [] })) }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new AiExtractionProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'm', timeoutMs: 5_000, maxRetries: 0 }),
    })
    const out = await provider.extract({ format: 'pdf', fileName: 'x.pdf', pages: PAGES })
    assert.equal(out.docType, 'unknown')
  } finally {
    await server.close()
  }
})

test('PH5AI6 提示词中包含页面标记，模型才知道每个值对应哪一页', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ body: chatResponse(JSON.stringify({ docType: 'invoice', fields: [] })) }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new AiExtractionProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'm', timeoutMs: 5_000, maxRetries: 0 }),
    })
    await provider.extract({ format: 'pdf', fileName: 'x.pdf', pages: PAGES })
    const sent = JSON.stringify(server.requests[0].body)
    assert.ok(sent.includes('第1页') || sent.includes('[P1]') || sent.includes('page 1'), '提示词需带页码标记')
  } finally {
    await server.close()
  }
})
