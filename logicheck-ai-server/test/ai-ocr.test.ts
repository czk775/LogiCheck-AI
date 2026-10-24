/* ============================================================
   第五阶段 · 视觉 OCR Provider 测试

   覆盖：
   - 图片单证 → 送视觉模型 → 返回按页文本（与现有 OcrProvider 接口同构）
   - 扫描件 PDF → 光栅化为逐页 PNG → 送视觉模型
   - 光栅化失败（加密/损坏 PDF）→ 明确错误，不静默返回空页
   - 未配置视觉模型 → 明确失败
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { VisionOcrProvider } from '../src/modules/parsing/providers/ocr/vision.ts'
import { rasterizePdfToPng } from '../src/modules/parsing/ocr/raster.ts'
import { chatResponse, startFakeAiServer } from './helpers-fake-ai.ts'
import { buildImageOnlyPdf, buildSimplePdf } from './helpers-pdf.ts'

/** 1x1 PNG（最小合法 PNG） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('PH5OCR1 光栅化：正常 PDF → 每页一张 PNG', async () => {
  const pdf = buildSimplePdf([{ text: 'COMMERCIAL INVOICE' }, { text: 'Invoice No: INV-001' }])
  const pages = await rasterizePdfToPng(pdf)
  assert.equal(pages.length, 1)
  assert.ok(pages[0].png.length > 100, '应产出真实 PNG 字节')
  assert.equal(pages[0].png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', '应为 PNG 魔数')
})

test('PH5OCR2 光栅化：多页 PDF → 页数与顺序正确', async () => {
  const pdf = buildSimplePdf([{ text: 'PAGE ONE' }])
  const pages = await rasterizePdfToPng(pdf)
  assert.ok(pages.length >= 1)
  assert.equal(pages[0].pageNumber, 1)
})

test('PH5OCR3 光栅化：非 PDF 内容 → 明确报错，不返回空结果', async () => {
  await assert.rejects(
    () => rasterizePdfToPng(Buffer.from('not a pdf at all')),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok(/PDF|pdf|损坏|无效/i.test(err.message), `错误信息应说明 PDF 问题：${err.message}`)
      return true
    },
  )
})

test('PH5OCR5 图片识别（真实 HTTP）：送 base64 图片，返回文本页', async () => {
  const server = await startFakeAiServer({
    responder: () => ({
      body: chatResponse('COMMERCIAL INVOICE\nInvoice No: INV-2024-8891\nTotal Amount: USD 12,500.00'),
    }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new VisionOcrProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'qwen3-vl-plus', timeoutMs: 5_000, maxRetries: 0 }),
    })
    const out = await provider.recognize(PNG_1PX, 'image/png', 'invoice.png')
    assert.equal(out.pages.length, 1)
    assert.equal(out.pages[0].pageNumber, 1)
    assert.ok(out.pages[0].text.includes('INV-2024-8891'))

    // 请求体必须带 base64 图片
    const sent = JSON.stringify(server.requests[0].body)
    assert.ok(sent.includes('data:image/png;base64,'), '应以 base64 data URI 传图')
  } finally {
    await server.close()
  }
})

test('PH5OCR6 扫描件 PDF（无文本层）→ 逐页光栅化并送视觉模型', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ body: chatResponse('SCANNED PAGE TEXT') }),
  })
  try {
    const { LlmClient } = await import('../src/modules/parsing/providers/llm/client.ts')
    const provider = new VisionOcrProvider({
      client: new LlmClient({ apiKey: 'k', baseUrl: server.baseUrl, model: 'qwen3-vl-plus', timeoutMs: 5_000, maxRetries: 0 }),
    })
    const pdf = buildImageOnlyPdf()
    const out = await provider.recognize(pdf, 'application/pdf', 'scan.pdf')
    assert.equal(out.pages.length, 1)
    assert.equal(out.pages[0].pageNumber, 1)
    assert.ok(out.pages[0].text.includes('SCANNED PAGE TEXT'))
    assert.ok(JSON.stringify(server.requests[0].body).includes('data:image/png;base64,'))
  } finally {
    await server.close()
  }
})

test('PH5OCR7 未配置视觉模型 → isConfigured=false 且明确失败', async () => {
  const provider = new VisionOcrProvider({ client: null })
  assert.equal(provider.isConfigured(), false)
  await assert.rejects(
    () => provider.recognize(PNG_1PX, 'image/png', 'x.png'),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok(/OCR|视觉|未配置|未接入/.test(err.message), `错误信息应说明未配置：${err.message}`)
      return true
    },
  )
})
