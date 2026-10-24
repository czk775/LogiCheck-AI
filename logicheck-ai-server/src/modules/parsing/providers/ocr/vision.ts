/* ============================================================
   视觉 OCR Provider（第五阶段）

   职责：把「看得见但读不出」的输入（图片、扫描件 PDF）变成文本页，
   使其与 PDF 文本层完全同构，从而复用同一条提取链路。

   实现要点：
     - 图片：直接 base64 data URI 送视觉模型
     - 扫描件 PDF：先光栅化为逐页 PNG，再逐页送视觉模型
     - 未配置视觉模型：明确失败（ocr_not_configured），绝不返回空白文本冒充结果
     - 每个页面的文本都对应真实的一页，页码不虚构
   ============================================================ */

import { ProviderError, type OcrProvider, type OcrResult } from '../types.ts'
import type { PdfPage } from '../../schema.ts'
import { rasterizePdfToPng } from '../../ocr/raster.ts'
import { extractJsonPayload, LlmError, type LlmClient, type LlmMessage } from '../llm/client.ts'

export interface VisionOcrProviderOptions {
  /** 已配置好的视觉模型客户端；null = 未配置 */
  client: LlmClient | null
  /** 单份单证最多识别多少页 */
  maxPages?: number
  /** 渲染缩放倍数 */
  scale?: number
}

/** OCR 提示词：要求逐字转写，不改写、不补全、不总结 */
const OCR_PROMPT =
  '请对这张单证图片做 OCR 转写。要求：\n' +
  '1. 逐字转写图片中所有可见文字，保留原始换行与字段顺序。\n' +
  '2. 不要翻译、不要总结、不要补全、不要纠正原文。\n' +
  '3. 无法辨认的部分用 [无法辨认] 标记。\n' +
  '4. 只输出转写文本本身，不要任何解释或 Markdown 代码块。'

export class VisionOcrProvider implements OcrProvider {
  readonly id = 'vision'
  readonly label = '视觉模型 OCR（图片 / 扫描件识别）'

  constructor(private readonly options: VisionOcrProviderOptions) {}

  isConfigured(): boolean {
    return !!this.options.client
  }

  async recognize(bytes: Buffer, mime: string, _fileName: string): Promise<OcrResult> {
    const client = this.options.client
    if (!client) {
      throw new ProviderError(
        'ocr_not_configured',
        'OCR / 视觉模型尚未接入：请在服务端 .env 中配置 AI_VISION_MODEL（或让 AI_MODEL 使用视觉模型）后重启服务',
      )
    }

    const maxPages = this.options.maxPages ?? 8
    const notes: string[] = []

    if (mime === 'application/pdf') {
      const rendered = await rasterizePdfToPng(bytes, { maxPages, scale: this.options.scale ?? 2 })
      if (rendered.length < maxPages) {
        // 记录总页数与实际处理页数差异（可解释）
      }
      const pages: PdfPage[] = []
      for (const r of rendered) {
        const text = await this.recognizeOne(client, r.png, 'image/png')
        pages.push({ pageNumber: r.pageNumber, text })
      }
      if (!pages.length) {
        throw new ProviderError('ocr_empty', '扫描件识别结果为空，未提取到任何文字')
      }
      return { pages, notes }
    }

    const text = await this.recognizeOne(client, bytes, mime)
    if (!text.trim()) {
      throw new ProviderError('ocr_empty', '图片识别结果为空，未提取到任何文字（图片可能过暗、过小或非单证）')
    }
    return { pages: [{ pageNumber: 1, text }], notes }
  }

  private async recognizeOne(client: LlmClient, bytes: Buffer, mime: string): Promise<string> {
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: OCR_PROMPT },
        ],
      },
    ]
    try {
      const res = await client.chat(messages)
      return res.content.trim()
    } catch (err) {
      if (err instanceof LlmError) {
        throw new ProviderError(`ocr_${err.code}`, err.userMessage)
      }
      throw new ProviderError('ocr_unknown_error', '调用视觉模型失败：未知错误')
    }
  }
}

/** 便于测试与诊断：解析 OCR 输出中的 JSON（若模型误答 JSON 也能兜住） */
export function parseOcrText(content: string): string {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed
  try {
    const parsed = extractJsonPayload(trimmed)
    if (parsed && typeof parsed === 'object' && 'text' in parsed) {
      const t = (parsed as { text?: unknown }).text
      if (typeof t === 'string') return t.trim()
    }
  } catch {
    /* 不是 JSON 就按原文处理 */
  }
  return trimmed
}
