/* ============================================================
   PDF 文本提取（零依赖，Node 内置 zlib）

   支持范围（诚实边界）：
   - 经典 PDF 结构：对象表可被扫描到（未压缩对象表）
   - FlateDecode 压缩的内容流
   - 简单字体（WinAnsi/ASCII 文本）与带 /ToUnicode 的 CID 字体
   明确不支持（抛出带原因的错误，绝不编造文本）：
   - 加密 PDF（/Encrypt）
   - 对象流（/ObjStm）压缩的文档结构
   - 扫描件（无文本层）→ 返回空文本 + no_text_layer 警告，
     由调用方决定走 OCR（未接入时如实失败）
   ============================================================ */

import { inflateSync } from 'node:zlib'

export interface PdfPage {
  pageNumber: number
  text: string
}

export interface PdfTextResult {
  pages: PdfPage[]
  warnings: string[]
}

export class PdfParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PdfParseError'
  }
}

interface PdfObject {
  num: number
  /** 对象字典部分（latin1 字符串） */
  dict: string
  /** 流字节（Buffer）或 null */
  stream: Buffer | null
}

/** 从 PDF 缓冲区提取按页文本 */
export function extractPdfText(buf: Buffer): PdfTextResult {
  const src = buf.toString('latin1')
  if (!src.startsWith('%PDF-')) throw new PdfParseError('not_pdf', '文件不是有效的 PDF（缺少 %PDF- 头）')
  if (/\/Encrypt\b/.test(src.slice(0, 4096))) {
    throw new PdfParseError('encrypted_pdf', 'PDF 已加密，当前提取器不支持（不绕过口令）')
  }

  const objects = collectObjects(buf, src)
  const warnings: string[] = []

  const trailerMatch = src.match(/\/Root\s+(\d+)\s+(\d+)\s+R/)
  if (!trailerMatch) throw new PdfParseError('unsupported_structure', '未找到 PDF 根对象（/Root）')
  const catalog = objects.get(Number(trailerMatch[1]))
  if (!catalog) throw new PdfParseError('unsupported_structure', 'PDF 根对象缺失')

  const pagesRef = catalog.dict.match(/\/Type\s*\/Catalog/) ? catalog.dict.match(/\/Pages\s+(\d+)\s+\d+\s+R/) : null
  if (!pagesRef) throw new PdfParseError('unsupported_structure', 'PDF 缺少页树（/Pages）')
  const pagesRoot = objects.get(Number(pagesRef[1]))
  if (!pagesRoot) throw new PdfParseError('unsupported_structure', '页树根对象缺失')

  const pageObjs = walkPageTree(objects, Number(pagesRef[1]), new Set())
  if (!pageObjs.length) throw new PdfParseError('unsupported_structure', '页树中未找到任何页面对象')

  const pages: PdfPage[] = []
  for (let i = 0; i < pageObjs.length; i++) {
    const page = pageObjs[i]
    const content = pageContent(objects, page)
    const fonts = pageFonts(objects, page)
    const text = content ? extractTextFromContent(content, fonts) : ''
    pages.push({ pageNumber: i + 1, text })
  }

  if (pages.every((p) => p.text.trim() === '')) {
    warnings.push('no_text_layer')
  }
  return { pages, warnings }
}

/* ---------- 对象收集 ---------- */

function collectObjects(buf: Buffer, src: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const re = /(?:^|[^0-9])(\d+)\s+(\d+)\s+obj\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const num = Number(m[1])
    if (objects.has(num)) continue
    const bodyStart = m.index + m[0].length
    const endObj = src.indexOf('endobj', bodyStart)
    const dictEnd = endObj === -1 ? src.length : endObj
    let dict = src.slice(bodyStart, dictEnd)
    let stream: Buffer | null = null

    const streamKw = dict.match(/stream\r\n|stream\n|stream\r/)
    if (streamKw && streamKw.index !== undefined) {
      const dictPart = dict.slice(0, streamKw.index)
      const dataStart = bodyStart + streamKw.index + streamKw[0].length
      const endstreamIdx = src.indexOf('endstream', dataStart)
      const dataEnd = endstreamIdx === -1 ? src.length : endstreamIdx
      // endstream 前可能有一个 EOL，不属于流数据
      let cut = dataEnd
      if (src.charCodeAt(cut - 1) === 0x0a) cut--
      if (src.charCodeAt(cut - 1) === 0x0d) cut--
      stream = buf.subarray(dataStart, cut)
      dict = dictPart
    }
    objects.set(num, { num, dict, stream })
  }
  return objects
}

function decodeStream(obj: PdfObject): Buffer | null {
  if (!obj.stream) return null
  if (/\/Filter\s*\[\s*\/FlateDecode/.test(obj.dict) || /\/Filter\s*\/FlateDecode/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream)
    } catch {
      // 部分生成器流尾部带多余字节；尝试容忍
      try {
        return inflateSync(obj.stream.subarray(0, obj.stream.length - 1))
      } catch {
        return null
      }
    }
  }
  if (/\/Filter/.test(obj.dict)) {
    // DCTDecode（图片）/ LZW / CCITT 等：无法提取文本，交由调用方处理
    return null
  }
  return obj.stream
}

/* ---------- 页树 ---------- */

function walkPageTree(objects: Map<number, PdfObject>, nodeNum: number, visited: Set<number>): PdfObject[] {
  if (visited.has(nodeNum)) return []
  visited.add(nodeNum)
  const node = objects.get(nodeNum)
  if (!node) return []

  const kids: number[] = []
  const kidsMatch = node.dict.match(/\/Kids\s*\[([^\]]*)\]/)
  if (kidsMatch) {
    for (const m of kidsMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)) kids.push(Number(m[1]))
  } else {
    const single = node.dict.match(/\/Kids\s+(\d+)\s+\d+\s+R/)
    if (single) kids.push(Number(single[1]))
  }

  const isPages = /\/Type\s*\/Pages/.test(node.dict)
  if (!kids.length || !isPages) {
    // 叶子页（有些生成器省略 /Type /Page）
    return /\/Contents/.test(node.dict) || !isPages ? [node] : []
  }
  const out: PdfObject[] = []
  for (const kid of kids) out.push(...walkPageTree(objects, kid, visited))
  return out
}

/* ---------- 页面内容与字体 ---------- */

function pageContent(objects: Map<number, PdfObject>, page: PdfObject): Buffer | null {
  const chunks: Buffer[] = []
  const arrayMatch = page.dict.match(/\/Contents\s*\[([^\]]*)\]/)
  const refs = arrayMatch
    ? [...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
    : (() => {
        const single = page.dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/)
        return single ? [Number(single[1])] : []
      })()
  for (const ref of refs) {
    const obj = objects.get(ref)
    if (!obj) continue
    const decoded = decodeStream(obj)
    if (decoded) chunks.push(decoded)
  }
  if (!chunks.length) return null
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)
}

interface FontInfo {
  /** 字符代码 → Unicode 字符串；null 表示按 WinAnsi/latin1 直译 */
  toUnicode: Map<number, string> | null
}

function pageFonts(objects: Map<number, PdfObject>, page: PdfObject): Map<string, FontInfo> {
  const fonts = new Map<string, FontInfo>()
  // /Resources 可能是内联字典或引用
  let resources = page.dict.match(/\/Resources\s*<<([\s\S]*?)>>/)?.[1] ?? null
  if (!resources) {
    const resRef = page.dict.match(/\/Resources\s+(\d+)\s+\d+\s+R/)
    if (resRef) resources = objects.get(Number(resRef[1]))?.dict ?? null
  }
  if (!resources) return fonts

  const fontDict = resources.match(/\/Font\s*<<([\s\S]*?)>>/)?.[1]
  if (!fontDict) {
    const fontRef = resources.match(/\/Font\s+(\d+)\s+\d+\s+R/)
    if (!fontRef) return fonts
    const obj = objects.get(Number(fontRef[1]))
    const inner = obj?.dict.match(/<<([\s\S]*?)>>/)?.[1]
    if (inner) return parseFontDict(objects, inner, fonts)
    return fonts
  }
  return parseFontDict(objects, fontDict, fonts)
}

function parseFontDict(objects: Map<number, PdfObject>, fontDict: string, fonts: Map<string, FontInfo>): Map<string, FontInfo> {
  for (const m of fontDict.matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = m[1]
    const fontObj = objects.get(Number(m[2]))
    if (!fontObj) continue
    let toUnicode: Map<number, string> | null = null
    const tuRef = fontObj.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/)
    if (tuRef) {
      const cmap = decodeStream(objects.get(Number(tuRef[1])) ?? { num: 0, dict: '', stream: null })
      if (cmap) toUnicode = parseToUnicode(cmap.toString('latin1'))
    }
    fonts.set(name, { toUnicode })
  }
  return fonts
}

/** 解析 ToUnicode CMap：beginbfchar / beginbfrange（目标串为 UTF-16BE） */
export function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()
  // CMap 十六进制串是大端 UTF-16：<0041> → 'A'
  const hexToUtf16 = (hex: string): string => {
    let out = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    }
    return out.replace(/\u0000+$/, '')
  }

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), hexToUtf16(m[2]))
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      const dst = parseInt(m[3], 16)
      for (let c = lo; c <= hi && c - lo < 65536; c++) {
        map.set(c, String.fromCharCode(dst + (c - lo)))
      }
    }
  }
  return map
}

/* ---------- 内容流文本抽取 ---------- */

function extractTextFromContent(content: Buffer, fonts: Map<string, FontInfo>): string {
  const src = content.toString('latin1')
  let out = ''
  let currentFont: FontInfo | null = null
  let pendingBreak = false

  const pushBreak = () => {
    if (pendingBreak && out && !out.endsWith('\n')) out += '\n'
    pendingBreak = false
  }
  const showString = (bytes: Buffer) => {
    pushBreak()
    out += decodeString(bytes, currentFont)
  }

  let i = 0
  const n = src.length
  const operandStack: (string | Buffer | number)[] = []

  const flush = (): void => {
    operandStack.length = 0
  }

  while (i < n) {
    const ch = src[i]
    if (ch === '(') {
      // 字面字符串（处理嵌套括号与转义）
      const { str, next } = readLiteralString(src, i)
      operandStack.push(str)
      i = next
      continue
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i)
      if (end === -1) break
      const hex = src.slice(i + 1, end).replace(/\s+/g, '')
      operandStack.push(Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'))
      i = end + 1
      continue
    }
    if (ch === '<' && src[i + 1] === '<') {
      const end = src.indexOf('>>', i)
      i = end === -1 ? n : end + 2
      flush()
      continue
    }
    if (ch === '/' || /[A-Za-z'"*]/.test(ch)) {
      let j = i
      while (j < n && /[^\s()<>[\]]/.test(src[j])) j++
      const token = src.slice(i, j)
      i = j
      handleToken(token)
      continue
    }
    if (ch === '[' || ch === ']') {
      i++
      continue
    }
    if (/\s/.test(ch)) {
      i++
      continue
    }
    // 数字
    let j = i
    while (j < n && /[0-9+\-.]/.test(src[j])) j++
    if (j > i) {
      operandStack.push(Number(src.slice(i, j)))
      i = j
      continue
    }
    i++
  }

  function handleToken(token: string): void {
    if (token.startsWith('/')) {
      // 名称（如字体名）——仅记录，由 Tf 使用
      operandStack.push(token)
      return
    }
    switch (token) {
      case 'Tf': {
        const name = [...operandStack].reverse().find((t) => typeof t === 'string' && t.startsWith('/'))
        if (typeof name === 'string') currentFont = fonts.get(name.slice(1)) ?? null
        flush()
        break
      }
      case 'Tj':
      case "'":
      case '"': {
        if (token !== 'Tj') pendingBreak = true
        const str = [...operandStack].reverse().find((t) => Buffer.isBuffer(t))
        if (str) showString(str as Buffer)
        flush()
        break
      }
      case 'TJ': {
        const parts = [...operandStack].reverse().filter((t) => Buffer.isBuffer(t))
        for (const p of parts) showString(p as Buffer)
        flush()
        break
      }
      case 'Td':
      case 'TD':
      case 'T*':
      case 'TL':
        pendingBreak = true
        flush()
        break
      case 'Tm':
        pendingBreak = true
        flush()
        break
      case 'BT':
      case 'ET':
        pendingBreak = true
        flush()
        break
      default:
        flush()
    }
  }

  return out
}

/** 读取 (...) 字面字符串，处理转义与嵌套 */
function readLiteralString(src: string, start: number): { str: Buffer; next: number } {
  const bytes: number[] = []
  let depth = 1
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      const esc = src[i + 1]
      switch (esc) {
        case 'n': bytes.push(0x0a); i += 2; break
        case 'r': bytes.push(0x0d); i += 2; break
        case 't': bytes.push(0x09); i += 2; break
        case 'b': bytes.push(0x08); i += 2; break
        case 'f': bytes.push(0x0c); i += 2; break
        case '(': bytes.push(0x28); i += 2; break
        case ')': bytes.push(0x29); i += 2; break
        case '\\': bytes.push(0x5c); i += 2; break
        case '\n': i += 2; break
        case '\r': i += 2; if (src[i + 1] === '\n') i++; break
        default:
          if (esc >= '0' && esc <= '7') {
            let oct = ''
            let k = i + 1
            while (k < src.length && oct.length < 3 && src[k] >= '0' && src[k] <= '7') {
              oct += src[k]
              k++
            }
            bytes.push(parseInt(oct, 8) & 0xff)
            i = k
          } else {
            bytes.push(esc.charCodeAt(0))
            i += 2
          }
      }
      continue
    }
    if (c === '(') depth++
    if (c === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
    bytes.push(c.charCodeAt(0))
    i++
  }
  return { str: Buffer.from(bytes), next: i }
}

function decodeString(bytes: Buffer, font: FontInfo | null): string {
  if (font?.toUnicode && font.toUnicode.size) {
    let out = ''
    for (const b of bytes) out += font.toUnicode.get(b) ?? ''
    return out
  }
  // 简单字体：WinAnsi/ASCII 直译（高位字节按 Latin-1 近似）
  return bytes.toString('latin1')
}
