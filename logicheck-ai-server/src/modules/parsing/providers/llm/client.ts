/* ============================================================
   OpenAI 兼容 LLM 客户端（第五阶段）

   职责边界：
   - 只负责「把消息发出去、把结果拿回来、把失败分类清楚」
   - 不做字段抽取、不做业务判断（那些在 ai/ 层）

   设计要点：
   1. 零依赖：用 Node 内置 fetch，不引入 SDK（避免供应链与版本漂移）
   2. 错误分类明确：鉴权失败 / 限流 / 额度不足 / 超时 / 服务异常 / 网络错误
      —— 每一类都映射到稳定错误码，前端据此给出不同恢复建议
   3. 可重试性由错误类型决定：限流/超时/5xx 重试；鉴权失败/额度不足立即失败
   4. 密钥安全：Authorization 头只在请求时使用，绝不写入错误消息或日志
   ============================================================ */

export type LlmErrorCode =
  | 'auth_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'timeout'
  | 'service_unavailable'
  | 'network_error'
  | 'invalid_json'
  | 'invalid_response'
  | 'invalid_request'
  | 'not_configured'

/** 面向用户的失败原因说明（不含任何密钥） */
const USER_MESSAGE: Record<LlmErrorCode, string> = {
  auth_failed: 'AI 服务鉴权失败：API Key 无效，或与当前接入地址不属于同一地域。请检查服务端 .env 中的 Key 与 AI_BASE_URL 是否匹配。',
  rate_limited: 'AI 服务限流：请求过于频繁。系统已自动重试，可稍后手动重试该单证。',
  quota_exceeded: 'AI 服务额度不足或账户欠费：请前往服务商控制台充值或检查账单后重试。',
  timeout: 'AI 服务响应超时：可稍后重试；若单证页数较多，建议先裁剪后再试。',
  service_unavailable: 'AI 服务暂时不可用：服务商过载或内部错误，已自动重试；可稍后重试。',
  network_error: '无法连接 AI 服务：请检查网络连通性、服务商地址是否正确，以及是否需要配置代理。',
  invalid_json: 'AI 返回内容不是合法 JSON：模型输出被截断或格式不符，可重试一次。',
  invalid_response: 'AI 返回内容不符合预期结构：可重试一次。',
  invalid_request: 'AI 服务拒绝了本次请求：请求内容不符合模型要求（常见原因：图片尺寸过小、文件格式不支持、页数超限）。请更换或处理该单证后重试。',
  not_configured: 'AI 服务未配置：请在服务端 .env 中填入 API Key 与模型名后重启服务。',
}

/** 是否值得重试（额度与鉴权问题重试无意义） */
const RETRYABLE: Record<LlmErrorCode, boolean> = {
  auth_failed: false,
  rate_limited: true,
  quota_exceeded: false,
  timeout: true,
  service_unavailable: true,
  network_error: true,
  invalid_json: false,
  invalid_response: false,
  invalid_request: false,
  not_configured: false,
}

/**
 * 单次 AI 调用记录（可观测性）。
 *
 * 边界：只记录「什么时候、哪个模型、什么任务、多久、成没成、多少 token」，
 * 不记录提示词与响应内容，不涉及任何密钥。
 */
export interface AiCallRecord {
  /** 调用完成时间（ISO 8601） */
  at: string
  /** 实际使用的模型名 */
  model: string
  /** 任务类型：extraction（字段提取）/ ocr（视觉识别）/ eval（评估） */
  task: string
  /** 耗时（毫秒，含内部重试） */
  durationMs: number
  /** 调用结果 */
  status: 'ok' | 'error'
  /** 失败时的稳定错误码（成功时无） */
  errorCode?: string
  promptTokens: number
  completionTokens: number
}

/** 进程内用量累计器（额度护栏的第二道防线）。
 *
 * 第一道是单次 `max_tokens` 封顶（防单次失控）；
 * 这一道管总量：连续跑批 / 误循环时，累计用量触顶后直接拒绝继续调用，
 * 而不是等服务商返回 429 或账单超支才发现。
 *
 * 同时承担轻量可观测性：按调用顺序保留最近若干条记录（环形缓冲），
 * 供「AI 运行概览」页展示真实调用情况——不引入外部监控框架。
 */
export class UsageMeter {
  private promptTokens = 0
  private completionTokens = 0
  private calls = 0
  private successCalls = 0
  private failedCalls = 0
  private totalDurationMs = 0
  private recent: AiCallRecord[] = []

  /** 最多保留多少条最近调用记录 */
  private static readonly RECENT_CAP = 30

  constructor(private readonly limitTokens: number) {}

  /** 累计一次调用的用量；返回是否仍在限额内 */
  record(usage: LlmResponse['usage']): boolean {
    this.calls += 1
    this.promptTokens += usage?.promptTokens ?? 0
    this.completionTokens += usage?.completionTokens ?? 0
    return this.totalTokens() < this.limitTokens
  }

  /** 记录一次完整调用（用量 + 可观测性字段） */
  recordCall(rec: Omit<AiCallRecord, 'at'> & { at?: string }): void {
    this.calls += 1
    this.totalDurationMs += rec.durationMs
    if (rec.status === 'ok') {
      this.successCalls += 1
      this.promptTokens += rec.promptTokens
      this.completionTokens += rec.completionTokens
    } else {
      this.failedCalls += 1
    }
    this.recent.push({ ...rec, at: rec.at ?? new Date().toISOString() })
    if (this.recent.length > UsageMeter.RECENT_CAP) this.recent.shift()
  }

  totalTokens(): number {
    return this.promptTokens + this.completionTokens
  }

  snapshot(): {
    calls: number
    successCalls: number
    failedCalls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    limitTokens: number
    exhausted: boolean
    avgDurationMs: number
    recent: AiCallRecord[]
  } {
    return {
      calls: this.calls,
      successCalls: this.successCalls,
      failedCalls: this.failedCalls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens(),
      limitTokens: this.limitTokens,
      exhausted: this.totalTokens() >= this.limitTokens,
      avgDurationMs: this.calls > 0 ? Math.round(this.totalDurationMs / this.calls) : 0,
      recent: [...this.recent].reverse(),
    }
  }
}

export class LlmError extends Error {
  constructor(
    public readonly code: LlmErrorCode,
    /** 面向用户的说明（已脱敏） */
    public readonly userMessage: string,
    /** 是否可重试 */
    public readonly retryable: boolean,
    /** HTTP 状态码（网络错误无状态码时为 0） */
    public readonly statusCode: number = 0,
  ) {
    super(userMessage)
    this.name = 'LlmError'
  }
}

export interface LlmConfig {
  /** API Key（仅用于构造 Authorization 头） */
  apiKey: string
  /** OpenAI 兼容端点，不含 /chat/completions */
  baseUrl: string
  /** 模型名 */
  model: string
  /** 单次请求超时（毫秒） */
  timeoutMs: number
  /** 失败重试次数（不含首次） */
  maxRetries: number
  /**
   * 单次响应输出的 token 上限。
   * 不设限会让模型自由输出，最坏情况一次调用烧掉大量额度，
   * 因此即使调用方不配置也必须有安全默认值。
   */
  maxOutputTokens?: number
  /**
   * 进程内累计用量上限（token）。
   * 超过后本进程不再发起调用，避免跑批 / 误循环把额度烧穿。
   */
  usageLimitTokens?: number
  /** 任务类型标签（可观测性）：extraction / ocr / eval */
  task?: string
}

/** 输出上限默认值：提取任务真实需要仅数百 token，此值留足余量 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmContentPart[]
}

export interface LlmResponse {
  /** 模型返回的文本内容 */
  content: string
  /** 消耗的 token（若服务商返回） */
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | null
  /** 实际使用的模型名 */
  model: string
}

interface ChatRequestBody {
  model: string
  messages: LlmMessage[]
  temperature?: number
  max_tokens?: number
  stream?: false
}

/** 从服务商错误体中提取可读消息（不泄漏请求中的密钥） */
function extractErrorMessage(body: unknown): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error
    if (err && typeof err === 'object') {
      const msg = (err as { message?: unknown }).message
      if (typeof msg === 'string' && msg) return msg
    }
    const msg2 = (body as { message?: unknown }).message
    if (typeof msg2 === 'string' && msg2) return msg2
  }
  return ''
}

/**
 * 依据 HTTP 状态码与错误消息判定错误类型。
 * 关键区分：同为 429，「Rate limit」是限流（可重试），
 * 「exceeded your current quota / billing」是额度不足（不可重试）。
 */
export function classifyHttpFailure(status: number, body: unknown): LlmErrorCode {
  const message = extractErrorMessage(body).toLowerCase()

  if (status === 401 || status === 403) return 'auth_failed'
  if (status === 429) {
    if (
      message.includes('quota') ||
      message.includes('billing') ||
      message.includes('balance') ||
      message.includes('欠费') ||
      message.includes('额度') ||
      message.includes('余额')
    ) {
      return 'quota_exceeded'
    }
    return 'rate_limited'
  }
  if (status === 408) return 'timeout'
  if (status >= 500) return 'service_unavailable'
  // 4xx：请求本身被服务商拒绝（参数不合法 / 图片过小 / 格式不支持），
  // 与「响应结构不对」是两回事，重试同样输入也不会变好。
  if (status === 400 || status === 422) return 'invalid_request'
  if (status === 404) return 'invalid_response'
  return 'invalid_response'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class LlmClient {
  /** 进程内累计用量（额度护栏第二道防线） */
  readonly usage: UsageMeter

  constructor(private readonly config: LlmConfig) {
    this.usage = new UsageMeter(config.usageLimitTokens ?? Number.POSITIVE_INFINITY)
  }

  /** 发起一次 chat/completions 调用（内部含重试） */
  async chat(messages: LlmMessage[], task: string = this.config.task ?? 'unknown'): Promise<LlmResponse> {
    // 累计用量已触顶 → 直接拒绝，不再发起调用（额度护栏）
    if (this.usage.snapshot().exhausted) {
      throw new LlmError(
        'quota_exceeded',
        `本进程累计用量已达上限（${this.config.usageLimitTokens} token），已停止继续调用模型。请重启服务或调高 AI_USAGE_LIMIT_TOKENS。`,
        false,
      )
    }
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const body: ChatRequestBody = {
      model: this.config.model,
      messages,
      stream: false,
      // 额度护栏：限制单次输出长度，避免一次失控调用烧穿免费额度
      max_tokens: this.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      // 提取任务要求同输入同输出，固定温度以保证可复现
      temperature: 0,
    }

    const startedAt = Date.now()
    let lastError: LlmError | null = null
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const res = await this.attempt(endpoint, body)
        // 记录本次调用（用量 + 可观测性：耗时 / 模型 / 任务 / token）
        this.usage.recordCall({
          model: res.model,
          task,
          durationMs: Date.now() - startedAt,
          status: 'ok',
          promptTokens: res.usage?.promptTokens ?? 0,
          completionTokens: res.usage?.completionTokens ?? 0,
        })
        return res
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('network_error', USER_MESSAGE.network_error, true)
        lastError = e
        if (!e.retryable || attempt >= this.config.maxRetries) break
        // 指数退避：1s → 2s → 4s（上限 8s），避免放大限流
        await sleep(Math.min(8_000, 1_000 * 2 ** attempt))
      }
    }
    const failure = lastError ?? new LlmError('invalid_response', USER_MESSAGE.invalid_response, false)
    // 失败也记账：成功率与最近记录需要真实反映失败调用
    this.usage.recordCall({
      model: this.config.model,
      task,
      durationMs: Date.now() - startedAt,
      status: 'error',
      errorCode: failure.code,
      promptTokens: 0,
      completionTokens: 0,
    })
    throw failure
  }

  private async attempt(endpoint: string, body: ChatRequestBody): Promise<LlmResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const text = await res.text()
      let parsed: unknown = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }

      if (!res.ok) {
        const code = classifyHttpFailure(res.status, parsed)
        // 注意：这里不把原始错误消息拼进异常，避免服务商回显的密钥片段泄漏
        throw new LlmError(code, USER_MESSAGE[code], RETRYABLE[code], res.status)
      }

      if (!parsed || typeof parsed !== 'object') {
        throw new LlmError('invalid_response', USER_MESSAGE.invalid_response, false, res.status)
      }
      const choices = (parsed as { choices?: unknown }).choices
      const content = Array.isArray(choices) && choices.length > 0
        ? (choices[0] as { message?: { content?: unknown } })?.message?.content
        : undefined
      if (typeof content !== 'string') {
        throw new LlmError('invalid_response', USER_MESSAGE.invalid_response, false, res.status)
      }
      const usageRaw = (parsed as { usage?: Record<string, unknown> }).usage
      const usage = usageRaw
        ? {
            promptTokens: typeof usageRaw.prompt_tokens === 'number' ? usageRaw.prompt_tokens : undefined,
            completionTokens: typeof usageRaw.completion_tokens === 'number' ? usageRaw.completion_tokens : undefined,
            totalTokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
          }
        : null
      const model = (parsed as { model?: unknown }).model
      return { content, usage, model: typeof model === 'string' ? model : this.config.model }
    } catch (err) {
      if (err instanceof LlmError) throw err
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw new LlmError('timeout', USER_MESSAGE.timeout, true)
      }
      throw new LlmError('network_error', USER_MESSAGE.network_error, true)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 从模型输出中稳健提取 JSON 对象：
 * - 剥离 ```json ... ``` 代码块
 * - 从前后废话中截取第一个括号配平的 JSON 对象
 * - 值内的转义引号与花括号不影响配平判断
 */
export function extractJsonPayload(raw: string): unknown {
  const text = raw.trim()

  // 1. 代码块
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fence?.[1]) candidates.push(fence[1].trim())
  candidates.push(text)

  for (const candidate of candidates) {
    const obj = findFirstBalancedObject(candidate)
    if (obj) {
      try {
        return JSON.parse(obj)
      } catch {
        /* 换下一个候选 */
      }
    }
  }

  throw new LlmError('invalid_json', USER_MESSAGE.invalid_json, false)
}

/** 找出第一个括号配平的 JSON 对象文本（正确处理字符串内的括号） */
function findFirstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
