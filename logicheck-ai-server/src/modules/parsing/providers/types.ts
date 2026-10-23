/* ============================================================
   提取 Provider 接口（阶段二 · 可替换设计）

   - DeterministicExtractionProvider：默认。基于 PDF 文本层与 EDI 结构
     做确定性抽取（标签匹配 / 段限定符映射），不依赖外部 API。
   - AiExtractionProvider：真实大模型接入点（第五阶段配置 API Key 后启用）。
     未配置时明确失败（ai_not_connected），绝不用预设结果冒充识别。

   两个 Provider 实现同一接口，可通过配置切换；流水线不关心背后是谁。
   ============================================================ */

import type { EdiMessage } from '../edi/parse.ts'
import type { PdfPage } from '../pdf/text.ts'
import type { ExtractedFieldData, FieldKey } from '../schema.ts'

export interface ExtractionInput {
  format: 'pdf' | 'edi' | 'image' | 'txt'
  fileName: string
  /** PDF / OCR 产出的文本层 */
  pages?: PdfPage[]
  /** EDI 解析出的报文结构 */
  message?: EdiMessage
}

export interface ExtractionOutput {
  fields: ExtractedFieldData[]
  /** 识别出的单证类型（invoice / packing / bol / transport_order / 未识别） */
  docType: string | null
  /** 人类可读的处理说明（写入 parse_summary，可解释） */
  notes: string[]
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ExtractionProvider {
  readonly id: string
  readonly kind: 'deterministic' | 'ai'
  readonly label: string
  /** 是否已配置可用（AI Provider 未配置时为 false） */
  isConfigured(): boolean
  extract(input: ExtractionInput): Promise<ExtractionOutput>
}

/* ---------- OCR / 视觉模型接入点 ---------- */

export interface OcrResult {
  /** 识别出的文本页（与 PDF 文本层同构，便于复用抽取逻辑） */
  pages: PdfPage[]
  notes: string[]
}

export interface OcrProvider {
  readonly id: string
  readonly label: string
  isConfigured(): boolean
  recognize(bytes: Buffer, mime: string, fileName: string): Promise<OcrResult>
}

/** 默认 OCR Provider：未接入（等待第五阶段配置真实视觉模型） */
export class UnavailableOcrProvider implements OcrProvider {
  readonly id = 'none'
  readonly label = 'OCR 未接入（等待第五阶段配置）'
  isConfigured(): boolean {
    return false
  }
  async recognize(): Promise<OcrResult> {
    throw new ProviderError('ocr_not_configured', 'OCR / 视觉模型尚未接入（第一阶段未提供 API Key），图片单证暂无法提取字段')
  }
}

/* ---------- 单证类型适用字段表（决定 missing / unavailable） ---------- */

export const DOC_TYPE_FIELDS: Record<string, FieldKey[]> = {
  invoice: [
    'invoice_number', 'invoice_date', 'po_number', 'product', 'model',
    'quantity', 'unit', 'unit_price', 'total_amount', 'currency', 'incoterms',
    'hs', 'shipper', 'consignee',
  ],
  packing: ['product', 'model', 'quantity', 'unit', 'cartons', 'gross', 'net_weight', 'shipper', 'consignee'],
  bol: [
    'product', 'quantity', 'cartons', 'gross', 'vessel_voyage',
    'port_of_loading', 'port_of_discharge', 'ship_date', 'shipper', 'consignee', 'notify_party',
  ],
  transport_order: ['document_number', 'quantity', 'gross', 'vessel_voyage', 'port_of_loading', 'port_of_discharge', 'ship_date', 'shipper', 'consignee'],
  unknown: ['product', 'quantity', 'gross', 'shipper', 'consignee'],
}
