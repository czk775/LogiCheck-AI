/* 服务端配置：环境变量 → 校验后的配置对象。密钥只走环境变量，不落库、不进前端。 */

import { env as loadEnv } from 'node:process'
import { resolve } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_PATH: z.string().default('./data/logicheck.db'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAIL_OUTBOX_DIR: z.string().default('./data/mail-outbox'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /* 提取 Provider：deterministic（默认，无外部 API）/ ai（第五阶段配置 Key 后启用） */
  EXTRACTION_PROVIDER: z.enum(['deterministic', 'ai']).default('deterministic'),
  /* ===== 第五阶段：大模型服务配置（全部走环境变量，密钥不落库不进前端）=====
     - DASHSCOPE_API_KEY：百炼 API Key（也兼容任何 OpenAI 兼容服务商的 Key）
     - AI_MODEL：负责「结构化字段提取」的模型名
     - AI_VISION_MODEL：负责「图像/扫描件 OCR」的模型名；留空则复用 AI_MODEL
     - AI_BASE_URL：OpenAI 兼容端点；留空用百炼默认地址
     密钥与模型名必须同时存在才算「已接通」——只有 Key 没有模型名时
     视为未配置，避免用错模型名在运行期静默失败。 */
  DASHSCOPE_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_VISION_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  AI_MAX_PAGES: z.coerce.number().int().positive().default(8),
  /* 单次响应输出 token 上限：额度护栏。免费额度有限，输出必须封顶 */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(32_000).default(4_096),
  /* 进程内累计用量上限（token）：额度护栏第二道防线，超限后停止调用模型 */
  AI_USAGE_LIMIT_TOKENS: z.coerce.number().int().positive().default(2_000_000),
  /* 可选 SMTP（全部留空 → 本地发件箱模式） */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
})

/** 大模型服务配置（第五阶段）——密钥只存在于此对象的 apiKey 字段内 */
export interface AiConfig {
  /** API Key：仅用于发起 HTTP 请求，不写日志、不落库、不进前端 */
  apiKey: string
  /** OpenAI 兼容端点（不含 /chat/completions） */
  baseUrl: string
  /** 结构化字段提取模型 */
  model: string
  /** 视觉/OCR 模型；null 表示复用 model */
  visionModel: string | null
  /** 单次请求超时（毫秒） */
  timeoutMs: number
  /** 失败重试次数（不含首次） */
  maxRetries: number
  /** 单份单证最多送入模型的页数（超出部分截断，避免额度失控） */
  maxPages: number
  /** 单次响应输出 token 上限（额度护栏） */
  maxOutputTokens: number
  /** 进程内累计用量上限（token）；超限后停止调用模型 */
  usageLimitTokens: number
  /** 对外可安全展示的描述（不含密钥） */
  describe(): { baseUrl: string; model: string; visionModel: string | null; configured: true }
}

export interface AppConfig {
  port: number
  databasePath: string
  uploadDir: string
  mailOutboxDir: string
  sessionTtlDays: number
  corsOrigin: string
  extractionProvider: 'deterministic' | 'ai'
  /** 大模型配置；null = 未接通（此时 AI Provider 明确失败，不伪造结果） */
  ai: AiConfig | null
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
    from: string
  } | null
}

/**
 * 构造 AI 配置对象。
 *
 * 密钥安全设计：apiKey 定义为「不可枚举」属性——
 *  - JSON.stringify(config) / console.log(config) 都不会带出密钥明文
 *  - 但 c.ai.apiKey 仍可正常读取用于发起请求
 * 这是「密钥只存在于后端进程内、不进日志、不进前端」的技术保证。
 */
function buildAiConfig(input: {
  apiKey: string
  baseUrl: string
  model: string
  visionModel: string | null
  timeoutMs: number
  maxRetries: number
  maxPages: number
  maxOutputTokens: number
  usageLimitTokens: number
}): AiConfig {
  const config: AiConfig = {
    baseUrl: input.baseUrl,
    model: input.model,
    visionModel: input.visionModel,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    maxPages: input.maxPages,
    maxOutputTokens: input.maxOutputTokens,
    usageLimitTokens: input.usageLimitTokens,
    describe(): { baseUrl: string; model: string; visionModel: string | null; configured: true } {
      return {
        baseUrl: config.baseUrl,
        model: config.model,
        visionModel: config.visionModel,
        configured: true as const,
      }
    },
  } as AiConfig
  Object.defineProperty(config, 'apiKey', {
    value: input.apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return config
}

export function loadConfig(env: NodeJS.ProcessEnv = loadEnv): AppConfig {
  const parsed = schema.parse(env)
  const smtpReady =
    !!parsed.SMTP_HOST && !!parsed.SMTP_USER && !!parsed.SMTP_PASS && !!parsed.MAIL_FROM

  /* AI 配置：Key 与模型名必须同时存在才算接通（见 schema 注释） */
  const aiKey = parsed.DASHSCOPE_API_KEY?.trim()
  const aiModel = parsed.AI_MODEL?.trim()
  const ai: AiConfig | null =
    aiKey && aiModel
      ? buildAiConfig({
          apiKey: aiKey,
          baseUrl: (parsed.AI_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
          model: aiModel,
          visionModel: parsed.AI_VISION_MODEL?.trim() || null,
          timeoutMs: parsed.AI_TIMEOUT_MS,
          maxRetries: parsed.AI_MAX_RETRIES,
          maxPages: parsed.AI_MAX_PAGES,
          maxOutputTokens: parsed.AI_MAX_OUTPUT_TOKENS,
          usageLimitTokens: parsed.AI_USAGE_LIMIT_TOKENS,
        })
      : null

  return {
    port: parsed.PORT,
    databasePath: resolve(parsed.DATABASE_PATH),
    uploadDir: resolve(parsed.UPLOAD_DIR),
    mailOutboxDir: resolve(parsed.MAIL_OUTBOX_DIR),
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    corsOrigin: parsed.CORS_ORIGIN,
    extractionProvider: parsed.EXTRACTION_PROVIDER,
    ai,
    smtp: smtpReady
      ? {
          host: parsed.SMTP_HOST!,
          port: parsed.SMTP_PORT ?? 465,
          secure: (parsed.SMTP_SECURE ?? 'true') === 'true',
          user: parsed.SMTP_USER!,
          pass: parsed.SMTP_PASS!,
          from: parsed.MAIL_FROM!,
        }
      : null,
  }
}
