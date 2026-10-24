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
import { LlmClient } from './llm/client.ts'
import { AiExtractionProvider } from './ai/provider.ts'
import { DeterministicExtractionProvider } from './deterministic.ts'
import { VisionOcrProvider } from './ocr/vision.ts'
import { UnavailableOcrProvider, type ExtractionProvider, type OcrProvider } from './types.ts'

export interface ProviderRegistry {
  extraction: ExtractionProvider
  ocr: OcrProvider
  /** 当前提取来源标识，落库到 extracted_fields.source（可追溯） */
  extractionSource: string
  /** 当前 OCR 来源标识 */
  ocrSource: string
}

export function buildProviders(config: AppConfig): ProviderRegistry {
  const ai = config.ai

  /* 提取 Provider */
  let extraction: ExtractionProvider
  let extractionSource: string
  if (config.extractionProvider === 'ai') {
    if (ai) {
      extraction = new AiExtractionProvider({
        client: new LlmClient({
          apiKey: ai.apiKey,
          baseUrl: ai.baseUrl,
          model: ai.model,
          timeoutMs: ai.timeoutMs,
          maxRetries: ai.maxRetries,
        }),
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
  if (ai) {
    const visionModel = ai.visionModel ?? ai.model
    ocr = new VisionOcrProvider({
      client: new LlmClient({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl,
        model: visionModel,
        timeoutMs: ai.timeoutMs,
        maxRetries: ai.maxRetries,
      }),
      maxPages: ai.maxPages,
    })
    ocrSource = 'ocr'
  } else {
    ocr = new UnavailableOcrProvider()
    ocrSource = 'none'
  }

  return { extraction, ocr, extractionSource, ocrSource }
}

export type { AiProviderConfig } from './ai.ts'
