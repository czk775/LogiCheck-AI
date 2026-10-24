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

/**
 * ASCII85 编码（ReportLab 等生成器的默认过滤链：[/ASCII85Decode /FlateDecode]）。
 * 这是真实世界 PDF 极常见的组合，提取器必须支持。
 *
 * 编码规则：每 4 字节 → 5 个字符（值域 33..117，即 '!'..'u'），
 * 与 PDF 规范（Section 7.4.3）一致，是解码器的严格逆运算。
 */
export function ascii85Encode(data: Buffer): Buffer {
  const out: number[] = []
  let i = 0
  for (; i + 4 <= data.length; i += 4) {
    const value =
      ((data[i] << 24) >>> 0) + (data[i + 1] << 16) + (data[i + 2] << 8) + data[i + 3]
    let v = value >>> 0
    const chunk = [0, 0, 0, 0, 0]
    for (let k = 4; k >= 0; k--) {
      chunk[k] = (v % 85) + 33
      v = Math.floor(v / 85)
    }
    out.push(...chunk)
  }
  // 末组：不足 4 字节，补零后取 count+1 个字符
  const rest = data.length - i
  if (rest > 0) {
    const value = data[i] << 24 | (rest > 1 ? data[i + 1] << 16 : 0) | (rest > 2 ? data[i + 2] << 8 : 0)
    let v = value >>> 0
    const chunk: number[] = []
    for (let k = 0; k < 5; k++) {
      chunk.unshift((v % 85) + 33)
      v = Math.floor(v / 85)
    }
    out.push(...chunk.slice(0, rest + 1))
  }
  return Buffer.from(out)
}

/** 生成单页 PDF；lines 自上而下排列 */
export function buildSimplePdf(
  lines: PdfLine[],
  opts: { compress?: boolean; title?: string; ascii85?: boolean } = {},
): Buffer {
  const { compress = false, title = 'Test Document', ascii85 = false } = opts
  const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

  const contentLines = lines.map((l, i) => {
    const size = l.size ?? 12
    const prefix = i === 0 ? 'BT /F1 ' + size + ' Tf 72 720 Td ' : '0 -' + (size + 4) + ' Td '
    return prefix + `(${escape(l.text)}) Tj`
  })
  const content = `BT\n${contentLines.join('\n')}\nET\n`
  let contentBytes = compress ? deflateSync(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1')
  let filter = compress ? ' /Filter /FlateDecode' : ''
  if (ascii85) {
    // 组合过滤链：[/ASCII85Decode /FlateDecode]（ReportLab 默认）
    contentBytes = ascii85Encode(contentBytes)
    filter = compress ? ' /Filter [ /ASCII85Decode /FlateDecode ]' : ' /Filter /ASCII85Decode'
  }

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null as unknown as string, // 占位：内容流对象单独组装
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  const filter2 = filter
  objects[3] = `<< /Length ${contentBytes.length}${filter2} >>\nstream\n${contentBytes.toString('latin1')}\nendstream`

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
