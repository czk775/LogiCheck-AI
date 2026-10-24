/* ============================================================
 * AI 能力状态与解析失败的文案映射（纯函数，可独立测试）
 * ------------------------------------------------------------
 * 为什么不直接把后端 error 丢给 UI：
 *   后端 error 是给排查者看的（如 "ai_auth_failed: 鉴权失败…"），
 *   用户需要的是「发生了什么 + 我该怎么办」。
 *   这里做一层映射，把机器可读的错误码翻译成用户能懂、能行动的话。
 *
 * 诚实边界：
 *   - 只描述已知错误类别，未知错误原样透出（不编造原因）
 *   - 限流配额与免费额度余额严格区分，前端永不显示「剩余额度」
 * ============================================================ */

import type { AiStatus } from '../api/contracts'

export type AiTone = 'good' | 'warn' | 'danger' | 'neutral'

export interface AiStatusView {
  /** 主文案：AI 已连接 / AI 不可用 */
  label: string
  tone: AiTone
  /** 点击展开后的详情行 */
  details: Array<{ label: string; value: string }>
  /** 不可用时的处理建议 */
  hint?: string
}

/**
 * 由 AI 状态生成展示视图。
 * @param mode 前端运行模式：real 走真实后端，mock 为纯前端演示
 */
export function toAiStatusView(status: AiStatus | null, mode: 'real' | 'mock'): AiStatusView {
  if (!status) {
    return {
      label: 'AI 状态未知',
      tone: 'neutral',
      details: [],
      hint: '暂时无法读取 AI 服务状态，请稍后重试',
    }
  }

  if (mode === 'mock') {
    return {
      label: '演示模式',
      tone: 'neutral',
      details: [
        { label: '运行模式', value: '前端演示（无真实大模型）' },
        { label: '提取方式', value: '预置演示数据' },
        { label: '图片识别', value: '未启用' },
      ],
      hint: '演示结果来自预置数据，不经过真实大模型解析',
    }
  }

  if (!status.configured) {
    return {
      label: 'AI 不可用',
      tone: 'warn',
      details: [
        { label: '运行模式', value: '真实后端' },
        { label: '提取方式', value: status.extraction === 'deterministic' ? '确定性规则提取' : status.extraction },
        { label: '图片识别', value: status.ocr === 'ocr' ? '已就绪' : '未启用' },
      ],
      hint: status.reason ?? '未配置 AI 服务，当前使用确定性规则提取',
    }
  }

  const details: Array<{ label: string; value: string }> = [
    { label: '运行模式', value: '真实后端' },
    { label: '提取模型', value: status.model ?? '未指定' },
    { label: '图片识别', value: status.visionModel ? status.visionModel : '未启用' },
  ]

  return {
    label: 'AI 已连接',
    tone: 'good',
    details,
    hint: '提取结果需通过原文引用核验才会被采信',
  }
}

/* ---------- 字段来源说明 ---------- */

/**
 * 单证字段来源说明（按后端 extraction_provider 如实描述）。
 *
 * 诚实边界：AI 接通后不能继续写「确定性解析」——
 * 那会让用户以为字段来自规则匹配，而非大模型理解。
 */
export function describeExtractionSource(
  provider: string | undefined,
  model?: string | undefined,
): string {
  const modelSuffix = model ? `（模型 ${model}）` : ''
  switch (provider) {
    case 'ai':
      return `字段由大模型从单证原文中提取${modelSuffix}，每条结果均经原文引用核验后才被采信。`
    case 'ocr+ai':
      return `扫描件/图片先经视觉识别，再由大模型提取字段${modelSuffix}，每条结果均经原文引用核验后才被采信。`
    case 'deterministic':
      return '字段由服务端确定性规则提取（PDF 文本层 / EDIFACT 段映射），全程可追溯。'
    case 'manual':
      return '字段由人工修正并留痕，原始单证内容不变。'
    default:
      return '字段来自服务端解析结果；缺失项不以默认值填充。'
  }
}

/* ---------- 解析失败原因映射 ---------- */

/**
 * 底层模型调用错误（对应后端 LlmErrorCode）。
 * 后端会加 `ai_` / `ocr_` 前缀落库，这里按前缀去掉后复用同一套文案。
 */
const LLM_ERROR_META: Record<string, { title: string; advice: string }> = {
  auth_failed: {
    title: 'API Key 无效',
    advice: '检查 Key 是否复制完整、是否属于当前接入地址所在地域',
  },
  rate_limited: {
    title: '调用过于频繁，已被限流',
    advice: '稍等片刻后点击重新解析',
  },
  quota_exceeded: {
    title: 'AI 额度不足或账户欠费',
    advice: '请在百炼控制台确认额度与账单，或切换其他模型',
  },
  timeout: {
    title: '模型响应超时',
    advice: '单证页数较多时可能超时，可点击重新解析重试',
  },
  service_unavailable: {
    title: '模型服务返回异常',
    advice: '这是服务端临时故障，稍后点击重新解析',
  },
  network_error: {
    title: '网络异常，未能连接模型服务',
    advice: '检查网络连通性后点击重新解析',
  },
  invalid_json: {
    title: '模型输出格式无法解析',
    advice: '可点击重新解析；若持续失败请更换模型',
  },
  invalid_response: {
    title: '模型返回内容不符合预期结构',
    advice: '可点击重新解析；若持续失败请更换模型',
  },
  invalid_request: {
    title: '模型服务拒绝了本次请求',
    advice: '该单证可能不满足模型要求（图片过小、格式不支持等），请更换或处理后重试',
  },
  not_configured: {
    title: 'AI 服务未配置',
    advice: '请在服务端 .env 配置 API Key 与模型名后重试',
  },
}

/** 单证/文件层错误码 → 用户可读文案与建议动作 */
const DOC_ERROR_META: Record<string, { title: string; advice: string }> = {
  ai_not_connected: {
    title: 'AI 服务未接通',
    advice: '请在服务端 .env 配置 API Key 与模型名后重试',
  },
  ai_not_configured: {
    title: 'AI 服务未配置',
    advice: '请在服务端 .env 配置 API Key 与模型名后重试',
  },
  ai_no_text: {
    title: '单证没有可送入模型的文本',
    advice: '该文件可能为纯图片，请配置视觉模型或上传含文本层的 PDF',
  },
  ai_unknown_error: {
    title: '调用大模型失败',
    advice: '可点击重新解析重试；若持续失败请查看服务端日志',
  },
  ocr_not_configured: {
    title: '图片识别未启用',
    advice: '请在服务端 .env 配置视觉模型（AI_VISION_MODEL）',
  },
  ocr_empty: {
    title: '图片识别结果为空',
    advice: '图片可能过暗、过小或并非单证，可换用更清晰的原件重试',
  },
  ocr_unknown_error: {
    title: '调用视觉模型失败',
    advice: '可点击重新解析重试；若持续失败请查看服务端日志',
  },
  no_text_layer: {
    title: 'PDF 无文本层，疑似扫描件',
    advice: '需要配置视觉模型后才能识别扫描件',
  },
  unsupported_message_type: {
    title: '暂不支持该 EDIFACT 消息类型',
    advice: '目前支持 INVOIC / DESADV / IFTMIN',
  },
  not_pdf: {
    title: '文件不是有效的 PDF',
    advice: '请重新导出或上传正确的 PDF 文件',
  },
  encrypted_pdf: {
    title: 'PDF 已加密',
    advice: '请提供未加密的 PDF 文件（系统不绕过口令）',
  },
  unsupported_structure: {
    title: 'PDF 结构无法解析',
    advice: '该 PDF 可能已损坏，请重新导出后上传',
  },
  file_missing: {
    title: '文件在存储中缺失',
    advice: '请重新上传该单证',
  },
}

/** 前缀区分：视觉链路（OCR）与文本链路（AI 提取） */
const ERROR_PREFIX_LABEL: Record<string, string> = {
  ai: '',
  ocr: '图片识别 · ',
}

/**
 * 按错误码查文案：
 * 1. 先查具体单证错误码（DOC_ERROR_META）
 * 2. 再按 ai_/ocr_ 前缀归入底层模型错误（LLM_ERROR_META）
 */
function lookupErrorMeta(code: string): { title: string; advice: string } | undefined {
  const direct = DOC_ERROR_META[code]
  if (direct) return direct
  const m = code.match(/^(ai|ocr)_(.+)$/)
  if (!m) return undefined
  const base = LLM_ERROR_META[m[2]]
  if (!base) return undefined
  return { title: `${ERROR_PREFIX_LABEL[m[1]] ?? ''}${base.title}`, advice: base.advice }
}

export interface DocErrorView {
  /** 主文案 */
  title: string
  /** 处理建议 */
  advice: string
  /** 原始错误（折叠显示，便于排查） */
  raw: string
  /** 是否为已知错误类别（未知时前端不编造原因） */
  known: boolean
}

/**
 * 从错误字符串中取出错误码。
 *
 * 后端落库格式为 `[错误码] 消息`（第五阶段起），
 * 但兼容历史的纯消息格式（无码时返回 null）。
 */
export function extractErrorCode(raw: string): string | null {
  const m = raw.match(/^\[([a-z0-9_]+)\]/)
  if (m?.[1]) return m[1]
  // 历史格式：冒号前的词若是已知错误码形态则采用
  const head = raw.split(':')[0].trim()
  if (/^[a-z][a-z0-9_]*$/.test(head) && head.includes('_')) return head
  return null
}

/**
 * 把后端解析错误翻译为用户可读文案。
 * 后端错误形如 "[ai_auth_failed] AI 服务鉴权失败：…"，
 * 取方括号内的错误码做映射。
 */
export function toDocErrorView(rawError: string | null | undefined): DocErrorView | null {
  if (!rawError || !rawError.trim()) return null
  const raw = rawError.trim()
  const code = extractErrorCode(raw)
  const meta = code ? lookupErrorMeta(code) : undefined
  if (!meta) {
    return { title: '解析失败', advice: '可点击重新解析重试', raw, known: false }
  }
  return { title: meta.title, advice: meta.advice, raw, known: true }
}

/**
 * 从错误码判断是否值得提示「重新解析」。
 *
 * 配额不足、鉴权失败、配置缺失、文件本身有问题——重试都不会变好，
 * 这类情况下按钮应禁用，把用户的注意力引到「先改配置 / 重新上传」。
 */
export function isRetryWorthwhile(code: string | null): boolean {
  if (!code) return true
  // 先归一化到底层语义（去掉 ai_ / ocr_ 前缀），保证两条链路判定一致
  const semantic = code.replace(/^(ai|ocr)_/, '')
  if (
    ['auth_failed', 'quota_exceeded', 'not_configured', 'not_connected'].includes(semantic)
  ) {
    return false
  }
  // 请求被服务商拒绝（图片过小 / 格式不支持）：同一份输入重试还是会被拒
  if (semantic === 'invalid_request') return false
  // 文件/报文本身的问题，重试无意义
  if (
    ['unsupported_message_type', 'not_pdf', 'encrypted_pdf', 'unsupported_structure'].includes(code)
  ) {
    return false
  }
  return true
}
