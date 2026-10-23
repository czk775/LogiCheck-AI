/* ============================================================
   AI 提取 Provider（接入点占位 —— 第五阶段配置真实 API Key 后启用）

   诚实边界：未配置时 isConfigured() = false，extract() 抛出
   ai_not_connected。绝不用预设字段冒充大模型识别结果。
   ============================================================ */

import { ProviderError, type ExtractionInput, type ExtractionOutput, type ExtractionProvider } from './types.ts'

export interface AiProviderConfig {
  /** 第五阶段填入：例如 dashscope / openai / 其它 */
  vendor?: string
  apiKey?: string
  model?: string
  baseUrl?: string
}

export class AiExtractionProvider implements ExtractionProvider {
  readonly id = 'ai'
  readonly kind = 'ai' as const
  readonly label = '大模型提取（待第五阶段配置 API Key）'

  constructor(private readonly config: AiProviderConfig) {}

  isConfigured(): boolean {
    return !!this.config.apiKey && !!this.config.vendor
  }

  async extract(_input: ExtractionInput): Promise<ExtractionOutput> {
    throw new ProviderError(
      'ai_not_connected',
      `AI 提取服务未配置${this.config.vendor ? `（vendor=${this.config.vendor} 缺少 API Key）` : '（未选择 vendor，未提供 API Key）'}，当前无法进行非结构化材料理解；请使用确定性提取或等待第五阶段接入`,
    )
  }
}
