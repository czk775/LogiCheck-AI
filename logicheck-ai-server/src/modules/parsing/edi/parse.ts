/* ============================================================
   EDIFACT 报文解析（零依赖）

   支持范围（诚实边界）：
   - UNA 服务串建议（缺省按 EDIFACT 标准分隔符：元素 + / 成分 : / 释放 ? / 段终止 '）
   - 释放字符转义（?+ 表示字面 +）
   - UNB/UNZ 信封、UNH/UNT 消息头
   - 支持的消息类型：INVOIC（商业发票）/ DESADV（发运通知/装箱单）/
     IFTMIN（运输订单/订舱）
   - 不支持的消息类型：抛出 unsupported_message_type（明确报错，不猜内容）

   段 → 字段映射只采用 UN/ECE 限定符中语义明确的项；
   语义不确定的段（如 LOC 港口限定符在不同指南中有分歧）不映射，
   对应字段记 missing —— 宁可缺失，不可编造。
   ============================================================ */

export interface EdiSegment {
  tag: string
  elements: string[][]
  /** 原始段文本（含终止符） */
  raw: string
  /** 段序号（1 起，含 UNB） */
  index: number
}

export interface EdiMessage {
  messageType: string
  messageVersion: string
  sender: string
  recipient: string
  segments: EdiSegment[]
}

export class EdiParseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'EdiParseError'
  }
}

export const SUPPORTED_MESSAGE_TYPES = ['INVOIC', 'DESADV', 'IFTMIN'] as const
export type SupportedMessageType = (typeof SUPPORTED_MESSAGE_TYPES)[number]

/** 解析 EDIFACT 报文文本 */
export function parseEdifact(input: string): EdiMessage {
  const text = input.replace(/\r\n/g, '\n').trim()
  if (!text) throw new EdiParseError('empty_message', 'EDI 报文为空')

  let componentSep = ':'
  let elementSep = '+'
  let releaseChar = '?'
  let segmentTerminator = "'"

  // UNA 服务串建议（可选）
  if (text.startsWith('UNA')) {
    const una = text.slice(3, 9)
    if (una.length >= 6) {
      componentSep = una[0]
      elementSep = una[1]
      // una[2] 小数分隔符；una[3] 释放字符；una[4] 保留；una[5] 段终止符
      releaseChar = una[3]
      segmentTerminator = una[5]
    }
  }

  const rawSegments = splitSegments(text, segmentTerminator, releaseChar)
  if (!rawSegments.length) throw new EdiParseError('no_segments', 'EDI 报文中没有完整段')

  const segments: EdiSegment[] = []
  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i]
    const parsed = parseSegment(raw, componentSep, elementSep, releaseChar)
    if (parsed) segments.push({ ...parsed, raw: raw + segmentTerminator, index: i + 1 })
  }

  const unb = segments.find((s) => s.tag === 'UNB')
  const unh = segments.find((s) => s.tag === 'UNH')
  if (!unh) throw new EdiParseError('missing_unh', 'EDI 报文缺少 UNH 消息头，无法识别消息类型')

  // UNH+0062(消息引用)+S009(消息标识: 类型/版本/发布/机构)
  const s009 = unh.elements[1] ?? []
  const messageType = s009[0] ?? ''
  const messageVersion = s009[1] ?? ''

  return {
    messageType,
    messageVersion,
    sender: unb?.elements[1]?.[0] ?? '',
    recipient: unb?.elements[2]?.[0] ?? '',
    segments,
  }
}

/** 按段终止符切分（释放字符开头的终止符是字面量） */
function splitSegments(text: string, terminator: string, release: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === release && i + 1 < text.length) {
      current += c + text[i + 1]
      i++
      continue
    }
    if (c === terminator) {
      const seg = current.trim()
      if (seg) out.push(seg)
      current = ''
      continue
    }
    if (c === '\n' && current.length === 0) continue
    current += c
  }
  const last = current.trim()
  if (last) out.push(last)
  return out
}

function parseSegment(raw: string, componentSep: string, elementSep: string, release: string): EdiSegment | null {
  const tag = raw.slice(0, raw.search(/[+:]/))
  if (!tag || !/^[A-Z]{2,3}$/.test(tag)) return null
  let body = raw.slice(tag.length)
  // 标签后紧跟的分隔符不属于数据（UNH+M001+... 的首数据元素是 M001）
  if (body.startsWith(elementSep)) body = body.slice(elementSep.length)
  const elements: string[][] = []
  for (const el of splitUnescaped(body, elementSep, release)) {
    elements.push(splitUnescaped(el, componentSep, release))
  }
  return { tag, elements, raw, index: 0 }
}

/** 按分隔符切分，释放字符后的分隔符为字面量（释放字符本身不出现在值中） */
function splitUnescaped(s: string, sep: string, release: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === release && i + 1 < s.length) {
      // EDIFACT 语义：释放字符是转义标记，不出现在数据值里
      current += s[i + 1]
      i++
      continue
    }
    if (c === sep) {
      out.push(current)
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  return out
}

/** 段查询辅助 */
export function findSegments(msg: EdiMessage, tag: string): EdiSegment[] {
  return msg.segments.filter((s) => s.tag === tag)
}

/** 取指定限定符的元素值：qualifier 为元素首成分 */
export function elementByQualifier(seg: EdiSegment, qualifier: string, elementIndex: number): string | null {
  const el = seg.elements[elementIndex]
  if (!el) return null
  return el[0] === qualifier ? el.slice(1).join(':') || null : null
}

/** 校验消息类型是否支持；不支持时抛出明确错误 */
export function assertSupportedType(msg: EdiMessage): SupportedMessageType {
  if ((SUPPORTED_MESSAGE_TYPES as readonly string[]).includes(msg.messageType)) {
    return msg.messageType as SupportedMessageType
  }
  throw new EdiParseError(
    'unsupported_message_type',
    `不支持的 EDIFACT 消息类型：${msg.messageType || '（未识别）'}（当前支持：${SUPPORTED_MESSAGE_TYPES.join(' / ')}）`,
  )
}
