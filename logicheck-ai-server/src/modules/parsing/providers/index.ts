/* ============================================================
   Provider 注册表（第五阶段）

   按配置装配真实 Provider：
   - EXTRACTION_PROVIDER=deterministic（默认）：零外部依赖，纯规则提取
   - EXTRACTION_PROVIDER=ai 且已配置 Key+模型：真实大模型提取（引用可核验）
   - EXTRACTION_PROVIDER=ai 但未配置：AI Provider 明确失败（ai_not_configured），
     绝不回落成"假装成功"，也不静默改用确定性提取冒充 AI 结果

   OCR Provider 独立于提取 Provider：
   - 图片与扫描件 PDF 需要视觉模型 → VisionOcrProvider
   - 视觉模型缺省复用 AI_MODEL（用户可单独用 AI_VISION_MODEL 覆盖）
   ============================================================ */

import type { AppConfig } from '../../../config.ts'
import { LlmClient, type AiCallRecord } from './llm/client.ts'
import { AiExtractionProvider } from './ai/provider.ts'
import { DeterministicExtractionProvider } from './deterministic.ts'
import { VisionOcrProvider } from './ocr/vision.ts'
import { UnavailableOcrProvider, type ExtractionProvider, type OcrProvider } from './types.ts'

/** 合并后的进程用量快照（可观测性观测口，不含任何密钥） */
export interface AiUsageSnapshot {
  calls: number
  successCalls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  limitTokens: number
  exhausted: boolean
  avgDurationMs: number
  /** 最近调用记录（两条链路合并，按时间倒序，最多 20 条） */
  recent: AiCallRecord[]
}

export interface ProviderRegistry {
  extraction: ExtractionProvider
  ocr: OcrProvider
  /** 提取链路客户端（可观测性 / 评估复用；未配置或非 AI 模式为 null） */
  extractionClient: LlmClient | null
  /** 当前提取来源标识，落库到 extracted_fields.source（可追溯） */
  extractionSource: string
  /** 当前 OCR 来源标识 */
  ocrSource: string
  /**
   * 本进程累计用量快照（额度护栏 + 可观测性观测口，不含任何密钥）。
   * 未配置 AI 时为 null。
   */
  usage(): AiUsageSnapshot | null
}

export function buildProviders(config: AppConfig): ProviderRegistry {
  const ai = config.ai

  /* 提取 Provider */
  let extraction: ExtractionProvider
  let extractionSource: string
  let extractionClient: LlmClient | null = null
  if (config.extractionProvider === 'ai') {
    if (ai) {
      extractionClient = new LlmClient({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl,
        model: ai.model,
        timeoutMs: ai.timeoutMs,
        maxRetries: ai.maxRetries,
        maxOutputTokens: ai.maxOutputTokens,
        usageLimitTokens: ai.usageLimitTokens,
        task: 'extraction',
      })
      extraction = new AiExtractionProvider({
        client: extractionClient,
        maxPages: ai.maxPages,
      })
      extractionSource = 'ai'
    } else {
      // 未配置 Key：使用「明确失败」的 AI Provider（不回落、不伪造）
      extraction = new AiExtractionProvider({
        client: null,
      })
      extractionSource = 'ai'
    }
  } else {
    extraction = new DeterministicExtractionProvider()
    extractionSource = 'deterministic'
  }

  /* OCR Provider（视觉模型） */
  let ocr: OcrProvider
  let ocrSource: string
  let ocrClient: LlmClient | null = null
  if (ai) {
    const visionModel = ai.visionModel ?? ai.model
    ocrClient = new LlmClient({
      apiKey: ai.apiKey,
      baseUrl: ai.baseUrl,
      model: visionModel,
      timeoutMs: ai.timeoutMs,
      maxRetries: ai.maxRetries,
      maxOutputTokens: ai.maxOutputTokens,
      usageLimitTokens: ai.usageLimitTokens,
      task: 'ocr',
    })
    ocr = new VisionOcrProvider({
      client: ocrClient,
      maxPages: ai.maxPages,
    })
    ocrSource = 'ocr'
  } else {
    ocr = new UnavailableOcrProvider()
    ocrSource = 'none'
  }

  return {
    extraction,
    ocr,
    extractionClient,
    extractionSource,
    ocrSource,
    /** 两条链路的用量合并统计（额度护栏 + 可观测性观测口） */
    usage() {
      if (!extractionClient && !ocrClient) return null
      const a = extractionClient?.usage.snapshot()
      const b = ocrClient?.usage.snapshot()
      const calls = (a?.calls ?? 0) + (b?.calls ?? 0)
      const successCalls = (a?.successCalls ?? 0) + (b?.successCalls ?? 0)
      const failedCalls = (a?.failedCalls ?? 0) + (b?.failedCalls ?? 0)
      const promptTokens = (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0)
      const completionTokens = (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0)
      const totalTokens = promptTokens + completionTokens
      const totalDurationMs =
        (a?.avgDurationMs ?? 0) * (a?.calls ?? 0) + (b?.avgDurationMs ?? 0) * (b?.calls ?? 0)
      const limitTokens = Math.min(
        ...[a?.limitTokens, b?.limitTokens].filter((v): v is number => typeof v === 'number'),
      )
      const recent = [...(a?.recent ?? []), ...(b?.recent ?? [])]
        .sort((x, y) => (x.at < y.at ? 1 : -1))
        .slice(0, 20)
      return {
        calls,
        successCalls,
        failedCalls,
        promptTokens,
        completionTokens,
        totalTokens,
        limitTokens,
        exhausted: totalTokens >= limitTokens,
        avgDurationMs: calls > 0 ? Math.round(totalDurationMs / calls) : 0,
        recent,
      }
    },
  }
}

export type { AiProviderConfig } from './ai.ts'
