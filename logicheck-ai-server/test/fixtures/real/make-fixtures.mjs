/**
 * 生成「真实感」的单证测试文件（供人工验收与真实 AI 联调使用）
 * 产出：
 *   real-invoice.pdf    —— 两页商业发票（文本层，AI 可直接提取）
 *   real-packing.pdf    —— 装箱单（与发票数量故意不一致，用于验证跨单证冲突检测）
 *   real-scan.pdf       —— 无文本层的扫描件（需走 OCR 路径）
 *   real-invoice.png    —— 图片版发票（需走视觉 OCR 路径）
 */
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'

const esc = (s) => s.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')

function buildPdf(pages, { compress = true } = {}) {
  const objects = []
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  pages.forEach((lines, i) => {
    const contentLines = lines.map((l, j) =>
      (j === 0 ? `BT /F1 12 Tf 72 720 Td ` : '0 -18 Td ') + `(${esc(l)}) Tj`
    )
    const content = 'BT\n' + contentLines.join('\n') + '\nET\n'
    const bytes = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`)
    objects.push(`<< /Length ${bytes.length} /Filter /FlateDecode >>\nstream\n${bytes.toString('latin1')}\nendstream`)
  })
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets = []
  objects.forEach((body, idx) => { offsets.push(pdf.length); pdf += `${idx + 1} 0 obj\n${body}\nendobj\n` })
  const xs = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

const invoice = [
  'COMMERCIAL INVOICE',
  'Seller: ACME Trading Co., Ltd.',
  'Buyer: Global Buyer GmbH',
  'Invoice No: INV-2024-8891',
  'Invoice Date: 2024-03-15',
  'PO Number: PO-2024-3312',
  'Payment Terms: 30 days after shipment',
  'Incoterms: FOB',
  'Description of Goods: Wireless Bluetooth Headset',
  'Model: WH-2000-BK',
  'Total Quantity: 1000 PCS',
  'Unit Price: USD 12.50',
  'Total Amount: USD 12,500.00',
  'HS Code: 8518.30.20',
  'Country of Origin: CN',
]
const invoiceP2 = [
  'Shipping Information',
  'Port of Loading: Shanghai',
  'Port of Discharge: Hamburg',
  'Ship Date: 2024-03-20',
  'Gross Weight: 420 KGS',
  'Net Weight: 380 KGS',
  'Number of Cartons: 20',
  'Vessel: EVER GIVEN V.128E',
]
const packing = [
  'PACKING LIST',
  'Shipper: ACME Trading Co., Ltd.',
  'Consignee: Global Buyer GmbH',
  'Total Quantity: 900 PCS',          // ← 与发票 1000 故意不一致
  'Number of Cartons: 20',
  'Gross Weight: 420 KGS',
  'Net Weight: 380 KGS',
  'Model: WH-2000-BK',
]

writeFileSync('test/fixtures/real/real-invoice.pdf', buildPdf([invoice, invoiceP2]))
writeFileSync('test/fixtures/real/real-packing.pdf', buildPdf([packing]))

// 扫描件 PDF：无文本层（内容流只有矩形）
{
  const content = 'q 0.95 0.95 0.95 rg 60 60 492 672 re f Q\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((b, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${b}\nendobj\n` })
  const xs = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xs}\n%%EOF`
  writeFileSync('test/fixtures/real/real-scan.pdf', Buffer.from(pdf, 'latin1'))
}

// 图片版发票（真实渲染的 PNG）
{
  const W = 1240, H = 1754
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#111111'
  ctx.font = 'bold 44px Helvetica'
  ctx.fillText('COMMERCIAL INVOICE', 90, 150)
  ctx.font = '30px Helvetica'
  const lines = [
    'Seller: ACME Trading Co., Ltd.',
    'Buyer: Global Buyer GmbH',
    'Invoice No: INV-2024-8891',
    'Invoice Date: 2024-03-15',
    'Total Quantity: 1000 PCS',
    'Total Amount: USD 12,500.00',
    'HS Code: 8518.30.20',
  ]
  lines.forEach((l, i) => ctx.fillText(l, 90, 240 + i * 52))
  writeFileSync('test/fixtures/real/real-invoice.png', canvas.toBuffer('image/png'))
}

console.log('fixtures written:')
for (const f of ['real-invoice.pdf','real-packing.pdf','real-scan.pdf','real-invoice.png']) {
  console.log(' -', f)
}
