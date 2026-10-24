/* ============================================================
   PDF 文本提取器测试（真实构造的 PDF 文件，零 mock）
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { extractPdfText, PdfParseError, parseToUnicode } from '../src/modules/parsing/pdf/text.ts'
import { buildSimplePdf, buildImageOnlyPdf } from './helpers-pdf.ts'

test('P1 提取未压缩 PDF 的多行文本', () => {
  const pdf = buildSimplePdf([
    { text: 'COMMERCIAL INVVOICE' },
    { text: 'Invoice No: INV-2026-0042' },
    { text: 'Total: USD 12,345.60' },
  ])
  const result = extractPdfText(pdf)
  assert.equal(result.pages.length, 1)
  const text = result.pages[0].text
  assert.ok(text.includes('COMMERCIAL INVVOICE'), text)
  assert.ok(text.includes('Invoice No: INV-2026-0042'), text)
  assert.ok(text.includes('Total: USD 12,345.60'), text)
  assert.equal(result.pages[0].pageNumber, 1)
  assert.deepEqual(result.warnings, [])
})

test('P2 提取 FlateDecode 压缩内容流', () => {
  const pdf = buildSimplePdf([{ text: 'PACKING LIST' }, { text: 'Quantity: 980 PCS' }], { compress: true })
  const result = extractPdfText(pdf)
  assert.ok(result.pages[0].text.includes('PACKING LIST'))
  assert.ok(result.pages[0].text.includes('Quantity: 980 PCS'))
})

test('P3 转义字符与括号文本', () => {
  const pdf = buildSimplePdf([{ text: 'Price (net): 100 \\ each' }])
  const text = extractPdfText(pdf).pages[0].text
  assert.ok(text.includes('Price (net): 100 \\ each'), text)
})

test('P4 扫描件（无文本层）→ 空文本 + no_text_layer 警告', () => {
  const result = extractPdfText(buildImageOnlyPdf())
  assert.equal(result.pages.length, 1)
  assert.equal(result.pages[0].text.trim(), '')
  assert.deepEqual(result.warnings, ['no_text_layer'])
})

test('P5 非 PDF 文件 → not_pdf 错误', () => {
  assert.throws(
    () => extractPdfText(Buffer.from('hello world, not a pdf')),
    (err: unknown) => err instanceof PdfParseError && err.code === 'not_pdf',
  )
})

test('P6 ToUnicode CMap 解析（UTF-16BE 目标）', () => {
  const cmap = `/CIDInit /ProcSet findresource begin
2 beginbfchar
<20> <0041>
<21> <0042>
endbfchar
1 beginbfrange
<30> <32> <0043>
endbfrange`
  const map = parseToUnicode(cmap)
  assert.equal(map.get(0x20), 'A')
  assert.equal(map.get(0x21), 'B')
  assert.equal(map.get(0x30), 'C')
  assert.equal(map.get(0x32), 'E')
})

/* ---------- ASCII85 过滤链（真实世界 PDF 极常见） ---------- */

test('P7 提取 ASCII85 + FlateDecode 组合过滤链的文本', () => {
  // ReportLab 默认生成 /Filter [ /ASCII85Decode /FlateDecode ]
  const pdf = buildSimplePdf(
    [{ text: 'COMMERCIAL INVOICE' }, { text: 'Invoice No: INV-LCAI-2026-001' }],
    { compress: true, ascii85: true },
  )
  const result = extractPdfText(pdf)
  const text = result.pages[0].text
  assert.ok(text.includes('COMMERCIAL INVOICE'), text)
  assert.ok(text.includes('Invoice No: INV-LCAI-2026-001'), text)
  assert.deepEqual(result.warnings, [], '有文本层时不应报 no_text_layer')
})

test('P8 提取单独 ASCII85Decode（不压缩）的文本', () => {
  const pdf = buildSimplePdf([{ text: 'PACKING LIST' }, { text: 'Quantity: 900 PCS' }], { ascii85: true })
  const text = extractPdfText(pdf).pages[0].text
  assert.ok(text.includes('PACKING LIST'), text)
  assert.ok(text.includes('Quantity: 900 PCS'), text)
})

test('P9 ASCII85 过滤链的扫描件仍如实判为无文本层', () => {
  // 组合过滤链不应掩盖「本来就没有文本」这一事实（不能把扫描件伪装成已解析）
  const pdf = buildSimplePdf([], { compress: true, ascii85: true })
  const result = extractPdfText(pdf)
  assert.equal(result.pages[0].text.trim(), '')
})
