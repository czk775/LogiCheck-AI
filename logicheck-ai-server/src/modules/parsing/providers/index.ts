/* ============================================================
   Provider 注册表：按配置选择提取 Provider。
   默认 deterministic（零外部依赖）；EXTRACTION_PROVIDER=ai 时切换
   到 AI Provider（未配置 Key 会明确失败）。
   ============================================================ */

import type { AppConfig } from '../../../config.ts'
import { AiExtractionProvider, type AiProviderConfig } from './ai.ts'
import { DeterministicExtractionProvider } from './deterministic.ts'
import { UnavailableOcrProvider, type ExtractionProvider, type OcrProvider } from './types.ts'

export interface ProviderRegistry {
  extraction: ExtractionProvider
  ocr: OcrProvider
}

export function buildProviders(config: AppConfig): ProviderRegistry {
  const extraction =
    config.extractionProvider === 'ai'
      ? new AiExtractionProvider({ vendor: 'unset', apiKey: undefined, model: undefined, baseUrl: undefined })
      : new DeterministicExtractionProvider()
  return { extraction, ocr: new UnavailableOcrProvider() }
}

export type { AiProviderConfig }
