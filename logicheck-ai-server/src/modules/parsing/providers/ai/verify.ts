/* ============================================================
   AI 字段引用核验（第五阶段 · 诚实性核心机制）

   问题：大模型会给出一个「看起来合理」的字段值 + 页码 + 置信度。
   但模型可能：
     - 把第 1 页的值说成在第 2 页（页码错）
     - 凭空编一个原文里根本没有的值（幻觉）
     - 自报一个 0.99 的置信度（无依据）

   机制：要求模型为每个字段同时给出「原文引用」（quote）。
   本模块只接受「引用确实出现在该单证某一页文本中」的字段：
     - 页码由引用的真实出现位置决定（不采信模型声称的页码）
     - 位置（offset）由引用的真实下标计算
     - 置信度由核验结果分级给出（不采信模型自报数值）
   核验不通过 → 字段标记为不可用（unavailable），不参与跨单证比对，
   绝不带着编造的页码/位置进入核验引擎。

   匹配策略（由严到宽）：
     1. 精确子串匹配
     2. 空白归一化后匹配（PDF 抽取常见多空格/换行差异）
     3. 大小写不敏感 + 空白归一化匹配
   三者都失败 → 拒绝。
   ============================================================ */

import type { PdfPage } from '../../schema.ts'

/** 模型声称的字段（尚未核验） */
export interface AiFieldClaim {
  /** 字段键 */
  key: string
  /** 模型给出的值 */
  value: string
  /** 模型给出的原文引用（证据） */
  quote: string
  /** 模型声称的页码（仅作参考，不被采信） */
  page?: number | null
}

export interface QuoteVerification {
  /** 是否通过核验 */
  accepted: boolean
  /** 真实页码（核验通过才有值） */
  page: number | null
  /** 真实位置（核验通过才有值），形如 p2@14 */
  position: string | null
  /** 由核验结果决定的置信度（0~1） */
  confidence: number
  /** 未通过的原因（写入 parse_summary，可解释） */
  reason?: string
}

/** 空白归一化：连续空白折叠为单个空格 */
function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 在页面文本中定位引用。
 * 返回该页在 pages 数组中的下标与在页面文本中的下标。
 */
function locateQuote(pages: PdfPage[], quote: string): { page: number; offset: number } | null {
  const raw = quote.trim()
  if (!raw) return null

  // 策略 1：精确子串
  for (const p of pages) {
    const idx = p.text.indexOf(raw)
    if (idx >= 0) return { page: p.pageNumber, offset: idx }
  }

  // 策略 2：空白归一化（按行处理，保留行内结构）
  const normQuote = normalizeSpaces(raw)
  for (const p of pages) {
    const lines = p.text.split('\n')
    let cursor = 0
    for (const line of lines) {
      const normLine = normalizeSpaces(line)
      if (normLine && normQuote && normLine.includes(normQuote)) {
        return { page: p.pageNumber, offset: cursor }
      }
      cursor += line.length + 1
    }
  }

  // 策略 3：大小写不敏感 + 空白归一化
  const lowerQuote = normQuote.toLowerCase()
  if (lowerQuote) {
    for (const p of pages) {
      const lines = p.text.split('\n')
      let cursor = 0
      for (const line of lines) {
        const normLine = normalizeSpaces(line).toLowerCase()
        if (normLine && normLine.includes(lowerQuote)) {
          return { page: p.pageNumber, offset: cursor }
        }
        cursor += line.length + 1
      }
    }
  }

  return null
}

/** 核验一个字段声称：引用是否真实存在 */
export function verifyFieldQuote(claim: AiFieldClaim, pages: PdfPage[]): QuoteVerification {
  const quote = (claim.quote ?? '').trim()
  if (!quote) {
    return {
      accepted: false,
      page: null,
      position: null,
      confidence: 0,
      reason: '模型未提供原文引用，无法核实来源',
    }
  }

  const located = locateQuote(pages, quote)
  if (!located) {
    return {
      accepted: false,
      page: null,
      position: null,
      confidence: 0,
      reason: '原文引用在单证文本中不存在（可能是模型幻觉）',
    }
  }

  // 页码以引用真实位置为准；模型声称页码与真实页码不一致时降低置信度
  const claimed = typeof claim.page === 'number' ? claim.page : null
  const pageMismatch = claimed !== null && claimed !== located.page

  // 置信度分级：由核验结果决定，不采信模型自报值
  const base = 0.9
  const confidence = pageMismatch ? 0.7 : base

  return {
    accepted: true,
    page: located.page,
    position: `p${located.page}@${located.offset}`,
    confidence,
    reason: pageMismatch
      ? `引用实际位于第 ${located.page} 页（模型称第 ${claimed} 页），已按实际位置修正`
      : undefined,
  }
}
