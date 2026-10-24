/* ============================================================
   统一结构化字段 Schema（阶段二）

   设计原则：
   - 字段 key 全局唯一、跨单证类型复用（发票/装箱单/运输单共用一套 key）
   - 词汇表与前端 domain 层保持一致（product/model/quantity/hs/gross…），
     并扩展发票 / 运输单据所需键（invoice_number / incoterms / ports…）
   - 每个字段实例必须携带来源可追溯信息：文档、页码/位置、置信度、状态
   - 状态区分：extracted（已提取）/ low_confidence（低置信）/ missing（缺失）/
     unavailable（该单证类型不适用此字段）—— 绝不把「没提取到」写成「没有异常」
   - 标准化值只做确定性格式转换（大小写、千分位、单位、日期格式），
     不做任何推断补全
   ============================================================ */

export const FIELD_KEYS = [
  /* 货物基础信息（与前端 domain 层共用） */
  'product',
  'model',
  'quantity',
  'unit',
  'cartons',
  'origin',
  'destination',
  'hs',
  'gross',
  'net_weight',
  'battery',
  /* 商业单证 */
  'invoice_number',
  'document_number',
  'invoice_date',
  'po_number',
  'unit_price',
  'total_amount',
  'currency',
  'incoterms',
  /* 运输信息 */
  'shipper',
  'consignee',
  'notify_party',
  'vessel_voyage',
  'port_of_loading',
  'port_of_discharge',
  'ship_date',
  'declaration_reference',
] as const

export type FieldKey = (typeof FIELD_KEYS)[number]

/** 字段提取状态 */
export type FieldStatus =
  | 'extracted' // 已提取且来源可核实
  | 'low_confidence' // 已提取但标准化失败 / 证据强度不足
  | 'missing' // 适用但未提取到
  | 'unavailable' // 该单证类型不适用此字段
  | 'unverified' // 模型给出了取值，但无法在原文中核实来源（不采信，不进入核验）

/** 单条提取字段（含完整溯源信息） */
export interface ExtractedFieldData {
  fieldKey: FieldKey
  /** 文档中的原始文本（未加工） */
  value: string
  /** 标准化值（确定性转换；无法标准化时等于原始值） */
  normalized: string
  /** PDF 页码（1 起）；EDI 为 null */
  page: number | null
  /** 文档内位置：PDF 为页内字符偏移，EDI 为段引用（如 "LIN+1"） */
  position: string | null
  /** 0~1；label 精确命中为高置信，模式匹配为中，其他为低 */
  confidence: number
  status: FieldStatus
  /** 原文证据片段（AI 提取时给出，且已被核验确实存在于该页文本中） */
  evidenceQuote?: string | null
}

/** 中间产物：PDF 文本层（按页） */
export interface PdfPage {
  pageNumber: number
  text: string
}

/** 中间产物：EDI 报文结构 */
export interface EdiSegment {
  tag: string
  elements: string[][]
  /** 原始行文本（用于溯源） */
  raw: string
  /** 段在报文中的序号（1 起，含 UNB） */
  index: number
}

export interface EdiMessage {
  messageType: string
  messageVersion: string
  sender: string
  recipient: string
  segments: EdiSegment[]
}

/* ---------- 确定性标准化 ---------- */

const INCOTERMS = new Set(['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'])

/** 数量："1,000" → "1000"；无法解析返回 null */
export function normalizeQuantity(raw: string): string | null {
  const m = raw.match(/-?[\d.,]+/)
  if (!m) return null
  const cleaned = m[0].replace(/,/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? String(n) : null
}

/** 金额："12,345.60 USD" → { amount: "12345.60", currency: "USD" } */
export function normalizeAmount(raw: string): { amount: string; currency: string | null } | null {
  const cur = raw.match(/\b(USD|EUR|CNY|RMB|GBP|JPY|HKD)\b/i)
  const num = raw.match(/-?[\d.,]+\.\d{2}/) ?? raw.match(/-?[\d.,]+/)
  if (!num) return null
  const amount = Number(num[0].replace(/,/g, ''))
  if (!Number.isFinite(amount)) return null
  return { amount: amount.toFixed(2), currency: cur ? cur[1].toUpperCase().replace('RMB', 'CNY') : null }
}

const WEIGHT_UNITS: Record<string, string> = { kg: 'KGM', kgs: 'KGM', kilogram: 'KGM', kilograms: 'KGM', k: 'KGM', lb: 'LBR', lbs: 'LBR', pound: 'LBR', pounds: 'LBR', t: 'TNE', tonne: 'TNE', ton: 'TNE' }

/** 重量："420 KGS" → { value: "420", unit: "KGM" }（UN/ECE Rec 20 单位代码） */
export function normalizeWeight(raw: string): { value: string; unit: string } | null {
  const num = raw.match(/-?[\d.,]+/)
  if (!num) return null
  const value = Number(num[0].replace(/,/g, ''))
  if (!Number.isFinite(value)) return null
  const unitWord = raw.replace(num[0], '').match(/[A-Za-z]+/)?.[0]?.toLowerCase() ?? ''
  return { value: String(value), unit: WEIGHT_UNITS[unitWord] ?? (unitWord ? unitWord.toUpperCase() : 'KGM') }
}

/** 日期：常见格式 → ISO 8601（YYYY-MM-DD）；无法识别返回 null */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim()
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  if (m) {
    // 日/月/年 或 月/日/年：无法唯一确定时按 月/日/年（北美发票常见）——标注低置信由调用方处理
    return `${m[3]}-${pad(m[1])}-${pad(m[2])}`
  }
  const months: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/)
  if (m && months[m[2].toLowerCase()]) return `${m[3]}-${months[m[2].toLowerCase()]}-${pad(m[1])}`
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m && months[m[1].toLowerCase()]) return `${m[3]}-${months[m[1].toLowerCase()]}-${pad(m[2])}`
  return null
}

/** 贸易术语：统一大写；非 Incoterms 2020 集合返回 null */
export function normalizeIncoterm(raw: string): string | null {
  const m = raw.trim().toUpperCase().match(/\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/)
  return m && INCOTERMS.has(m[1]) ? m[1] : null
}

/** HS 编码："8518.30.20" / "85183020" → "8518.30.20"；位数不足 6 位返回 null */
export function normalizeHsCode(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 10) return null
  const head = digits.slice(0, 6)
  const rest = digits.slice(6)
  return rest ? `${head.slice(0, 4)}.${head.slice(4)}.${rest}` : `${head.slice(0, 4)}.${head.slice(4)}`
}

function pad(s: string): string {
  return s.padStart(2, '0')
}

/** 该字段在当前上下文中的默认状态（未提取到时使用） */
export function defaultStatusFor(_fieldKey: FieldKey, applicable: boolean): FieldStatus {
  return applicable ? 'missing' : 'unavailable'
}
