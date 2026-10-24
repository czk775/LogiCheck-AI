/* ============================================================
   AI 提取 Provider（第五阶段 · 真实大模型接入）

   流程：
     1. 把单证页面文本（带页码标记）交给大模型
     2. 要求模型输出 JSON：{ docType, fields: [{ key, value, quote, page }] }
     3. 解析并做结构化校验（字段键白名单、类型、长度）
     4. 逐字段核验原文引用（见 verify.ts）——决定真实页码/位置/置信度
     5. 未通过核验的字段不进入已提取字段集（避免编造值污染核验引擎）

   诚实边界：
     - 模型没给的字段 → missing（不猜）
     - 模型给了但引用对不上 → unavailable（不采信）
     - 页码/位置/置信度全部由核验计算（不信模型自报）
   ============================================================ */

import { ProviderError, type ExtractionInput, type ExtractionOutput, type ExtractionProvider } from '../types.ts'
import { DOC_TYPE_FIELDS } from '../types.ts'
import { FIELD_KEYS, type ExtractedFieldData, type FieldKey, type FieldStatus, type PdfPage } from '../../schema.ts'
import { normalizeAmount, normalizeDate, normalizeHsCode, normalizeIncoterm, normalizeQuantity, normalizeWeight } from '../../schema.ts'
import { extractJsonPayload, LlmError, type LlmClient, type LlmMessage } from '../llm/client.ts'
import { verifyFieldQuote, type AiFieldClaim } from './verify.ts'

/** 允许的单证类型 */
const DOC_TYPES = new Set(['invoice', 'packing', 'bol', 'transport_order', 'unknown'])

/** 单个字段的标准分值函数（沿用阶段三的确定性标准化） */
const NORMALIZERS: Partial<Record<FieldKey, (raw: string) => string | null>> = {
  quantity: (raw) => normalizeQuantity(raw),
  unit_price: (raw) => normalizeAmount(raw)?.amount ?? null,
  total_amount: (raw) => normalizeAmount(raw)?.amount ?? null,
  currency: (raw) => normalizeAmount(raw)?.currency ?? null,
  invoice_date: (raw) => normalizeDate(raw),
  ship_date: (raw) => normalizeDate(raw),
  incoterms: (raw) => normalizeIncoterm(raw),
  hs: (raw) => normalizeHsCode(raw),
  gross: (raw) => {
    const w = normalizeWeight(raw)
    return w ? `${w.value} ${w.unit}` : null
  },
  net_weight: (raw) => {
    const w = normalizeWeight(raw)
    return w ? `${w.value} ${w.unit}` : null
  },
}

export interface AiExtractionProviderOptions {
  /** 已配置好的 LLM 客户端；null = 未配置（明确失败，不伪造结果） */
  client: LlmClient | null
  /** 单次最多送入模型的页数（超出截断，避免额度失控） */
  maxPages?: number
}

/** 构造提示词：把页面文本加上页码标记，并要求模型给出原文引用 */
export function buildExtractionPrompt(pages: PdfPage[]): string {
  const body = pages.map((p) => `[第${p.pageNumber}页]\n${p.text}`).join('\n\n')
  return `你是一个跨境物流单证字段提取器。请从下面的单证文本中提取字段。

要求：
1. 只提取文本中确实出现的信息，不要推测、不要补全、不要编造。
2. 每个字段必须给出 value（值）、quote（value 在原文中的连续片段，必须逐字出现在原文里）、page（该片段所在的页码）。
3. 找不到的字段不要输出。
4. 只输出一个 JSON 对象，不要输出解释文字、不要用 Markdown 代码块包裹。

字段键只能从以下列表中选择：
${FIELD_KEYS.join(', ')}

单证类型 docType 只能从以下选择：invoice（商业发票）, packing（装箱单）, bol（提单）, transport_order（运输单据）, unknown（无法判断）。

输出格式：
{"docType":"invoice","fields":[{"key":"invoice_number","value":"...","quote":"...","page":1}]}

单证文本：
${body}`
}

interface RawAiResponse {
  docType?: unknown
  fields?: unknown
}

/** 结构化校验：把模型输出收敛为可信的字段声明列表 */
export function parseAiResponse(raw: unknown): { docType: string; claims: AiFieldClaim[] } {
  if (!raw || typeof raw !== 'object') {
    throw new ProviderError('ai_invalid_response', 'AI 返回内容不是对象结构，无法解析字段')
  }
  const obj = raw as RawAiResponse
  const docTypeRaw = typeof obj.docType === 'string' ? obj.docType.trim().toLowerCase() : ''
  const docType = DOC_TYPES.has(docTypeRaw) ? docTypeRaw : 'unknown'

  if (!Array.isArray(obj.fields)) {
    throw new ProviderError('ai_invalid_response', 'AI 返回内容缺少 fields 数组，无法解析字段')
  }

  const allowed = new Set<string>(FIELD_KEYS)
  const claims: AiFieldClaim[] = []
  for (const item of obj.fields) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const key = typeof it.key === 'string' ? it.key.trim() : ''
    const value = typeof it.value === 'string' ? it.value.trim() : ''
    const quote = typeof it.quote === 'string' ? it.quote.trim() : ''
    if (!key || !allowed.has(key)) continue // 未知字段键：直接丢弃
    if (!value) continue // 空值：丢弃（等同没提取到）
    if (value.length > 500) continue // 超长值：异常输出，丢弃
    const pageNum = typeof it.page === 'number' && Number.isFinite(it.page) ? Math.round(it.page) : null
    claims.push({ key, value, quote, page: pageNum })
  }
  return { docType, claims }
}

export class AiExtractionProvider implements ExtractionProvider {
  readonly id = 'ai'
  readonly kind = 'ai' as const
  readonly label = '大模型单证理解（真实 AI 提取 + 原文引用核验）'

  constructor(private readonly options: AiExtractionProviderOptions) {}

  isConfigured(): boolean {
    return !!this.options.client
  }

  async extract(input: ExtractionInput): Promise<ExtractionOutput> {
    if (!this.options.client) {
      throw new ProviderError(
        'ai_not_configured',
        'AI 提取服务未配置：请在服务端 .env 中填入 DASHSCOPE_API_KEY 与 AI_MODEL 后重启服务（密钥不会进入前端或 Git）',
      )
    }
    const pages = input.pages ?? []
    if (!pages.length) {
      throw new ProviderError('ai_no_text', '没有可送入模型的单证文本，无法进行大模型提取')
    }

    const maxPages = this.options.maxPages ?? 8
    const used = pages.slice(0, maxPages)
    const truncated = pages.length > used.length

    const messages: LlmMessage[] = [
      { role: 'system', content: '你是单证字段提取器，只输出 JSON。' },
      { role: 'user', content: buildExtractionPrompt(used) },
    ]

    let content: string
    let usedModel = this.options.client ? 'ai' : 'ai'
    try {
      const res = await this.options.client.chat(messages)
      content = res.content
      usedModel = res.model || usedModel
    } catch (err) {
      if (err instanceof LlmError) {
        throw new ProviderError(`ai_${err.code}`, err.userMessage)
      }
      throw new ProviderError('ai_unknown_error', '调用大模型失败：未知错误')
    }

    let raw: unknown
    try {
      raw = extractJsonPayload(content)
    } catch {
      throw new ProviderError(
        'ai_invalid_json',
        'AI 返回内容不是合法 JSON（模型输出被截断或格式不符），请重试一次或更换模型',
      )
    }

    const { docType, claims } = parseAiResponse(raw)

    const notes: string[] = []
    const fields: ExtractedFieldData[] = []
    const found = new Set<FieldKey>()
    const unverifiable = new Map<FieldKey, string>()
    let rejected = 0

    for (const claim of claims) {
      const key = claim.key as FieldKey
      const verification = verifyFieldQuote(claim, used)
      if (!verification.accepted) {
        rejected++
        // 保留该字段的存在性事实，但标记为「无法核实」：值不采信、不进核验
        if (!unverifiable.has(key)) {
          unverifiable.set(key, verification.reason ?? '原文引用无法核实')
        }
        continue
      }
      if (found.has(key)) continue // 同字段多次出现取首个已核验的

      const raw = claim.value
      const normalizer = NORMALIZERS[key]
      let normalized = raw
      let status: FieldStatus = 'extracted'
      let confidence = verification.confidence
      if (normalizer) {
        const n = normalizer(raw)
        if (n === null || n === '') {
          status = 'low_confidence'
          confidence = Math.min(confidence, 0.5)
        } else {
          normalized = n
        }
      }
      if (verification.reason) notes.push(verification.reason)

      found.add(key)
      fields.push({
        fieldKey: key,
        value: raw,
        normalized,
        page: verification.page,
        position: verification.position,
        confidence,
        status,
        evidenceQuote: claim.quote,
      })
    }

    if (rejected > 0) {
      notes.push(`${rejected} 个字段因无法在原文中核实而未采信（不进入核验）`)
    }
    if (truncated) {
      notes.push(`单证共 ${pages.length} 页，仅送入前 ${used.length} 页参与提取（超出部分未处理）`)
    }

    // 无法核实的字段：保留存在性，标记 unverified（值不采信、页码位置为空、不进核验）
    for (const [key, reason] of unverifiable) {
      notes.push(`字段 ${key} 未采信：${reason}`)
      fields.push({
        fieldKey: key,
        value: '',
        normalized: '',
        page: null,
        position: null,
        confidence: 0,
        status: 'unverified',
      })
    }

    // 适用但未提取 → missing；不适用 → unavailable
    const applicable = new Set<FieldKey>(DOC_TYPE_FIELDS[docType] ?? DOC_TYPE_FIELDS.unknown)
    for (const key of applicable) {
      if (!found.has(key) && !unverifiable.has(key)) {
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

    return { fields, docType, notes, model: usedModel }
  }
}
