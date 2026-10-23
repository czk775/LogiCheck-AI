/* ============================================================
   测试基建：构造「真实」的最小 PDF（含对象表 / xref / 字体 / 内容流），
   用于验证 PDF 文本提取器走的是真实解析路径，而非预设结果。
   ============================================================ */

import { deflateSync } from 'node:zlib'

export interface PdfLine {
  text: string
  /** 12 或 14 等字号；缺省 12 */
  size?: number
}

/** 生成单页 PDF；lines 自上而下排列 */
export function buildSimplePdf(lines: PdfLine[], opts: { compress?: boolean; title?: string } = {}): Buffer {
  const { compress = false, title = 'Test Document' } = opts
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

  const contentLines = lines.map((l, i) => {
    const size = l.size ?? 12
    const prefix = i === 0 ? 'BT /F1 ' + size + ' Tf 72 720 Td ' : '0 -' + (size + 4) + ' Td '
    return prefix + `(${escape(l.text)}) Tj`
  })
  const content = `BT\n${contentLines.join('\n')}\nET\n`
  const contentBytes = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null as unknown as string, // 占位：内容流对象单独组装
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  const filter = compress ? ' /Filter /FlateDecode' : ''
  objects[3] = `<< /Length ${contentBytes.length}${filter} >>\nstream\n${contentBytes.toString('latin1')}\nendstream`

  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'
  const offsets: number[] = []
  objects.forEach((body, idx) => {
    offsets.push(pdf.length)
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length + 1} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  // 附加 Info 对象（标题），保持真实感
  const infoObj = `${objects.length + 1} 0 obj\n<< /Title (${title}) /Producer (logicheck-test) >>\nendobj\n`
  return Buffer.concat([Buffer.from(pdf, 'latin1'), Buffer.from(infoObj, 'latin1')])
}

/** 无文本层的「扫描件」PDF（内容流只有一个矩形，无文本算子） */
export function buildImageOnlyPdf(): Buffer {
  const content = 'q 0.9 0.9 0.9 rg 100 100 400 500 re f Q\n'
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, idx) => {
    offsets.push(pdf.length)
    pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}
