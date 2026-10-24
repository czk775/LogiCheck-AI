/* ============================================================
   确定性提取 Provider（默认，无外部 API）

   PDF：在真实提取出的文本层上做「标签驱动」的正则匹配——
        命中标签 → 高置信；仅裸模式命中 → 中置信；标签命中但标准化
        失败 → 低置信。没匹配到的字段记 missing，不补默认值。
   EDI：按消息类型的段限定符映射（INVOIC / DESADV / IFTMIN），
        值直接取自报文元素，不做推断。

   本文件所有匹配模式都是公开可见的确定性规则，可复算、可审计。
   ============================================================ */

import { findSegments, type EdiMessage, type EdiSegment } from '../edi/parse.ts'
import type { PdfPage } from '../pdf/text.ts'
import {
  normalizeAmount, normalizeDate, normalizeHsCode, normalizeIncoterm, normalizeQuantity, normalizeWeight,
  type ExtractedFieldData, type FieldKey, type FieldStatus,
} from '../schema.ts'
import { DOC_TYPE_FIELDS, ProviderError, type ExtractionInput, type ExtractionOutput, type ExtractionProvider } from './types.ts'

interface FieldRule {
  key: FieldKey
  /** 标签模式（命中 → 高置信） */
  label?: RegExp
  /** 裸模式（无标签也能识别 → 中置信） */
  bare?: RegExp
  /** 值标准化；返回 null 表示标准化失败（记低置信） */
  normalize?: (raw: string) => string | null
  /** 裸模式的取值分组 */
  bareGroup?: number
  /** 标签命中后的取值组（按序拼接，跳过空组）；缺省取第一组 */
  valueGroups?: number[]
}

const CURRENCY_RE = /\b(USD|EUR|CNY|RMB|GBP|JPY)\b/i

const PDF_RULES: FieldRule[] = [
  { key: 'invoice_number', label: /Invoice\s*(?:No\.?|Number|#|N°|Ref)\s*[.:\s]*([A-Z0-9][A-Z0-9\-\/]{3,})/i },
  { key: 'invoice_date', label: /(?:Invoice\s*Date|Date\s*of\s*Invoice)\s*[.:\s]*([0-9]{1,4}[\-\/.][0-9A-Za-z]{1,4}[\-\/.][0-9]{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i, normalize: normalizeDate },
  { key: 'po_number', label: /(?:P\.?O\.?\s*(?:No\.?|Number|#)|Purchase\s*Order)\s*[.:\s]*([A-Z0-9][A-Z0-9\-\/]{2,})/i },
  { key: 'product', label: /(?:Description\s*of\s*(?:Goods|Products)|Product|Commodity|Description)\s*[.:\s]*(.+)/i },
  { key: 'model', label: /(?:Model(?:\s*No\.?)?|Type)\s*[.:\s]*([A-Za-z0-9][A-Za-z0-9\-\/ ]{1,30})/i },
  { key: 'quantity', label: /(?:Total\s*Quantity|Quantity|Qty)\s*[.:\s]*([\d.,]+)\s*([A-Za-z]+)?/i, normalize: (raw) => normalizeQuantity(raw) },
  {
    // 计量单位：从数量标签行捕获（如「Quantity: 1000 PCE」→「PCE」）
    key: 'unit',
    label: /(?:Total\s*Quantity|Quantity|Qty)\s*[.:\s]*[\d.,]+\s*([A-Za-z]{1,12})\b/i,
    normalize: (raw) => raw.trim().toUpperCase(),
  },
  { key: 'unit_price', label: /(?:Unit\s*Price|Price)\s*[.:\s]*(?:([A-Z]{3})\s*)?([\d.,]+)/i, valueGroups: [1, 2], normalize: (raw) => {
      const a = normalizeAmount(raw)
      return a ? a.amount : null
    } },
  { key: 'total_amount', label: /(?:Total\s*Amount|Grand\s*Total|Amount\s*Due|Total)\s*(?:Amount)?\s*[.:\s]*(?:([A-Z]{3})\s*)?([\d.,]+\.\d{2})/i, valueGroups: [1, 2], normalize: (raw) => {
      const a = normalizeAmount(raw)
      return a ? a.amount : null
    } },
  { key: 'currency', bare: CURRENCY_RE, normalize: (raw) => normalizeAmount(raw)?.currency ?? null },
  { key: 'incoterms', bare: /\b(EXW|FCA|FAS|FOB|CFR|CIF|CPT|CIP|DAP|DPU|DDP)\b/i, normalize: normalizeIncoterm },
  { key: 'gross', label: /(?:G\.?W\.?|Gross\s*Weight)\s*[.:\s]*([\d.,]+\s*[A-Za-z]+)/i, normalize: (raw) => {
      const w = normalizeWeight(raw)
      return w ? `${w.value} ${w.unit}` : null
    } },
  { key: 'net_weight', label: /(?:N\.?W\.?|Net\s*Weight)\s*[.:\s]*([\d.,]+\s*[A-Za-z]+)/i, normalize: (raw) => {
      const w = normalizeWeight(raw)
      return w ? `${w.value} ${w.unit}` : null
    } },
  { key: 'hs', label: /HS\s*(?:Code)?\s*[.:\s]*(\d{4}\.?\d{2}\.?\d{0,4})/i, bare: /\b(\d{4}\.\d{2}\.\d{2,4})\b/, normalize: normalizeHsCode },
  { key: 'shipper', label: /(?:Shipper|Consignor|Sender)\s*[.:\s]*(.+)/i },
  { key: 'consignee', label: /(?:Consignee|Receiver|Buyer)\s*[.:\s]*(.+)/i },
  { key: 'notify_party', label: /Notify\s*(?:Party)?\s*[.:\s]*(.+)/i },
  { key: 'vessel_voyage', label: /(?:Vessel(?:\s*\/?\s*Voyage)?|Ocean\s*Vessel)\s*[.:\s]*(.+)/i },
  { key: 'port_of_loading', label: /Port\s*of\s*Loading\s*[.:\s]*(.+)/i },
  { key: 'port_of_discharge', label: /Port\s*of\s*(?:Discharge|Unloading)\s*[.:\s]*(.+)/i },
  { key: 'ship_date', label: /(?:Ship\s*Date|Shipped\s*on\s*Board|Date\s*of\s*Shipment|ETD)\s*[.:\s]*([0-9]{1,4}[\-\/.][0-9A-Za-z]{1,4}[\-\/.][0-9]{1,4}|\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/i, normalize: normalizeDate },
  { key: 'cartons', label: /(?:Cartons?|Packages?|No\.?\s*of\s*Packages|CTNS?)\s*[.:\s]*(\d+)/i },
  { key: 'origin', label: /(?:Country\s*of\s*Origin|Origin)\s*[.:\s]*(.+)/i },
  { key: 'destination', label: /(?:Country\s*of\s*Destination|Final\s*Destination|Destination)\s*[.:\s]*(.+)/i },
]

/**
 * 从标签正则命中结果取「原始值」：
 * - valueGroups 指定时按组序拼接（如币种组+金额组 → "USD 12500.00"）
 * - 缺省取第一捕获组
 */
function pickRaw(rule: FieldRule, m: RegExpMatchArray): string {
  if (rule.valueGroups) {
    return rule.valueGroups
      .map((g) => m[g] ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return (m[1] ?? m[2] ?? '').trim()
}

/** 单证类型识别（基于标题关键词；不确定返回 null → unknown） */
export function guessPdfDocType(pages: PdfPage[]): string | null {
  const head = pages.map((p) => p.text.slice(0, 400)).join('\n').toUpperCase()
  if (/BILL\s*OF\s*LADING|\bB\/L\b/.test(head)) return 'bol'
  if (/PACKING\s*(LIST|SLIP)/.test(head)) return 'packing'
  if (/COMMERCIAL\s*INVVOICE|COMMERCIAL\s*INVOICE|INVVOICE|INVOICE/.test(head)) return 'invoice'
  return null
}

export class DeterministicExtractionProvider implements ExtractionProvider {
  readonly id = 'deterministic'
  readonly kind = 'deterministic' as const
  readonly label = '确定性提取（标签匹配 / EDI 段映射，无外部 API）'
  isConfigured(): boolean {
    return true
  }

  async extract(input: ExtractionInput): Promise<ExtractionOutput> {
    if (input.format === 'edi' && input.message) {
      return this.extractEdi(input.message)
    }
    if (input.format === 'pdf' && input.pages) {
      return this.extractPdf(input.pages)
    }
    throw new ProviderError('unsupported_input', `确定性 Provider 不支持的输入格式：${input.format}`)
  }

  /* ---------- PDF 文本层抽取 ---------- */

  private extractPdf(pages: PdfPage[]): ExtractionOutput {
    const docType = guessPdfDocType(pages) ?? 'unknown'
    const found = new Map<FieldKey, ExtractedFieldData>()
    const notes: string[] = []

    for (const rule of PDF_RULES) {
      for (const page of pages) {
        let raw: string | null = null
        let confidence = 0
        let position: string | null = null

        if (rule.label) {
          const m = page.text.match(rule.label)
          if (m) {
            raw = pickRaw(rule, m)
            confidence = 0.9
            position = `p${page.pageNumber}@${m.index ?? 0}`
          }
        }
        if (raw === null && rule.bare) {
          const m = page.text.match(rule.bare)
          if (m) {
            raw = (m[rule.bareGroup ?? 1] ?? m[0]).trim()
            confidence = 0.65
            position = `p${page.pageNumber}@${m.index ?? 0}`
          }
        }
        if (raw === null || raw === '') continue

        let normalized = raw
        let status: FieldStatus = 'extracted'
        if (rule.normalize) {
          const n = rule.normalize(raw)
          if (n === null || n === '') {
            status = 'low_confidence'
            confidence = Math.min(confidence, 0.5)
          } else {
            normalized = n
          }
        }
        if (confidence < 0.6) status = 'low_confidence'
        found.set(rule.key, {
          fieldKey: rule.key,
          value: raw,
          normalized,
          page: page.pageNumber,
          position,
          confidence,
          status,
        })
        break // 同字段取第一个命中的页
      }
    }

    // 未命中的适用字段 → missing；不适用的 → unavailable
    const applicable = new Set(DOC_TYPE_FIELDS[docType] ?? DOC_TYPE_FIELDS.unknown)
    const fields = [...found.values()]
    for (const key of applicable) {
      if (!found.has(key)) {
        fields.push({
          fieldKey: key,
          value: '',
          normalized: '',
          page: null,
          position: null,
          confidence: 0,
          status: 'missing',
        })
      }
    }
    if (!found.size) notes.push('未从文本层匹配到任何字段（可能是版式非常规的单证）')
    return { fields, docType, notes }
  }

  /* ---------- EDI 结构抽取 ---------- */

  private extractEdi(msg: EdiMessage): ExtractionOutput {
    const docType = msg.messageType === 'INVOIC' ? 'invoice' : msg.messageType === 'DESADV' ? 'packing' : 'transport_order'
    const fields: ExtractedFieldData[] = []
    const notes: string[] = []
    const push = (key: FieldKey, value: string, normalized: string, position: string, confidence = 0.9) => {
      if (!value) return
      fields.push({ fieldKey: key, value, normalized, page: null, position, confidence, status: 'extracted' })
    }
    const first = (tag: string): EdiSegment | undefined => findSegments(msg, tag)[0]

    // BGM：单证编号
    const bgm = first('BGM')
    if (bgm) {
      const num = bgm.elements[1]?.[0] ?? ''
      if (msg.messageType === 'INVOIC') push('invoice_number', num, num, `BGM#${bgm.index}`)
      else push('document_number', num, num, `BGM#${bgm.index}`)
    }

    // DTM：日期（137 单证日期 / 11 发运日期）
    for (const dtm of findSegments(msg, 'DTM')) {
      const q = dtm.elements[0]?.[0]
      const value = dtm.elements[0]?.[1] ?? ''
      if (q === '137') push('invoice_date', value, normalizeDate(value) ?? value, `DTM#${dtm.index}`)
      if (q === '11' || q === '17') push('ship_date', value, normalizeDate(value) ?? value, `DTM#${dtm.index}`)
    }

    // RFF：订单号（ON）/ 发票号（IV）
    for (const rff of findSegments(msg, 'RFF')) {
      const q = rff.elements[0]?.[0]
      const value = rff.elements[0]?.[1] ?? ''
      if (q === 'ON') push('po_number', value, value, `RFF#${rff.index}`)
      if (q === 'IV' && !fields.some((f) => f.fieldKey === 'invoice_number')) push('invoice_number', value, value, `RFF#${rff.index}`)
    }

    // NAD：当事方（CZ 收货人 / SU 发货人 / DP 交货方）
    for (const nad of findSegments(msg, 'NAD')) {
      const q = nad.elements[0]?.[0]
      const name = nad.elements[1]?.[0] ?? ''
      if ((q === 'CZ' || q === 'BY') && !fields.some((f) => f.fieldKey === 'consignee')) push('consignee', name, name, `NAD#${nad.index}`)
      if (q === 'SU') push('shipper', name, name, `NAD#${nad.index}`)
      if (q === 'DP' && !fields.some((f) => f.fieldKey === 'notify_party')) push('notify_party', name, name, `NAD#${nad.index}`)
    }

    // CUX：币种（元素 2）
    const cux = first('CUX')
    if (cux) push('currency', cux.elements[0]?.[1] ?? '', (cux.elements[0]?.[1] ?? '').toUpperCase(), `CUX#${cux.index}`, 0.95)

    // TOD：贸易术语
    const tod = first('TOD')
    if (tod) {
      const code = tod.elements[1]?.[0] ?? tod.elements[0]?.[0] ?? ''
      const norm = normalizeIncoterm(code)
      if (norm) push('incoterms', code, norm, `TOD#${tod.index}`, 0.85)
    }

    // LIN：型号 + 行项目
    const lins = findSegments(msg, 'LIN')
    const lin = lins[0]
    if (lin) {
      const model = lin.elements[2]?.[0] ?? lin.elements[1]?.[0] ?? ''
      if (model) push('model', model, model, `LIN#${lin.index}`, 0.8)
      if (lins.length > 1) notes.push(`报文含 ${lins.length} 个行项目：型号取第一行，数量/金额为合计`)
    }

    // QTY：数量（12 发运 / 47 开票）——多行项目合计（确定性算术，非推断）
    const qtyTags = msg.messageType === 'INVOIC' ? ['47'] : ['12', '59', '21']
    let qtySum = 0
    let qtyCount = 0
    let qtyUnit = ''
    let qtyPos = ''
    for (const qty of findSegments(msg, 'QTY')) {
      const q = qty.elements[0]?.[0]
      if (!qtyTags.includes(q)) continue
      const n = normalizeQuantity(qty.elements[0]?.[1] ?? '')
      if (n === null) continue
      qtySum += Number(n)
      qtyCount++
      qtyUnit = qty.elements[0]?.[2] ?? qtyUnit
      qtyPos = `QTY#${qty.index}`
    }
    if (qtyCount) push('quantity', String(qtySum), String(qtySum), qtyPos)
    if (qtyUnit) push('unit', qtyUnit, qtyUnit, qtyPos, 0.95)

    // PRI：单价（AAA 净价，取第一行）
    const pri = findSegments(msg, 'PRI').find((p) => p.elements[0]?.[0] === 'AAA')
    if (pri) {
      const a = normalizeAmount(pri.elements[0]?.[1] ?? '')
      if (a) push('unit_price', pri.elements[0][1], a.amount, `PRI#${pri.index}`)
    }

    // MOA：金额（203 行项目金额）——多行合计
    let moaSum = 0
    let moaCount = 0
    let moaPos = ''
    for (const moa of findSegments(msg, 'MOA')) {
      if (moa.elements[0]?.[0] !== '203') continue
      const a = normalizeAmount(moa.elements[0]?.[1] ?? '')
      if (!a) continue
      moaSum += Number(a.amount)
      moaCount++
      moaPos = `MOA#${moa.index}`
    }
    if (moaCount) push('total_amount', moaSum.toFixed(2), moaSum.toFixed(2), moaPos)

    // MEA：重量（AAE 毛重 / AAP 净重）
    for (const mea of findSegments(msg, 'MEA')) {
      if (mea.elements[0]?.[0] !== 'AAE' && mea.elements[0]?.[0] !== 'AAP') continue
      const value = mea.elements[2]?.[1] ?? ''
      const unit = mea.elements[2]?.[0] ?? 'KGM'
      if (!value) continue
      const norm = normalizeWeight(`${value} ${unit}`)
      if (mea.elements[0][0] === 'AAE') push('gross', `${value} ${unit}`, norm ? `${norm.value} ${norm.unit}` : value, `MEA#${mea.index}`)
      else push('net_weight', `${value} ${unit}`, norm ? `${norm.value} ${norm.unit}` : value, `MEA#${mea.index}`)
    }

    // 未映射的适用字段 → missing
    const applicable = new Set(DOC_TYPE_FIELDS[docType] ?? DOC_TYPE_FIELDS.unknown)
    for (const key of applicable) {
      if (!fields.some((f) => f.fieldKey === key)) {
        fields.push({ fieldKey: key, value: '', normalized: '', page: null, position: null, confidence: 0, status: 'missing' })
      }
    }

    return { fields, docType, notes }
  }
}
