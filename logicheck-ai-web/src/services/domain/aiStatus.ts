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

/* ---------- 解析失败原因映射 ---------- */

/** 后端错误码 → 用户可读文案与建议动作 */
const DOC_ERROR_META: Record<string, { title: string; advice: string }> = {
  ai_not_connected: {
    title: 'AI 服务未接通',
    advice: '请在服务端 .env 配置 API Key 与模型名后重试',
  },
  ai_not_configured: {
    title: 'AI 服务未配置',
    advice: '请在服务端 .env 配置 API Key 与模型名后重试',
  },
  ai_auth_failed: {
    title: 'API Key 无效',
    advice: '检查 Key 是否复制完整、是否属于当前接入地址所在地域',
  },
  ai_rate_limited: {
    title: '调用过于频繁，已被限流',
    advice: '稍等片刻后点击重新解析',
  },
  ai_quota_exceeded: {
    title: '免费额度已用完',
    advice: '请在百炼控制台确认额度，或切换其他模型',
  },
  ai_timeout: {
    title: '模型响应超时',
    advice: '单证页数较多时可能超时，可点击重新解析重试',
  },
  ai_network_error: {
    title: '网络异常，未能连接模型服务',
    advice: '检查网络连通性后点击重新解析',
  },
  ai_server_error: {
    title: '模型服务返回异常',
    advice: '这是服务端临时故障，稍后点击重新解析',
  },
  ai_invalid_json: {
    title: '模型输出格式无法解析',
    advice: '可点击重新解析；若持续失败请更换模型',
  },
  ocr_not_configured: {
    title: '图片识别未启用',
    advice: '请在服务端 .env 配置视觉模型（AI_VISION_MODEL）',
  },
  no_text_layer: {
    title: 'PDF 无文本层，疑似扫描件',
    advice: '需要配置视觉模型后才能识别扫描件',
  },
  unsupported_message_type: {
    title: '暂不支持该 EDIFACT 消息类型',
    advice: '目前支持 INVOIC / DESADV / IFTMIN',
  },
  file_missing: {
    title: '文件在存储中缺失',
    advice: '请重新上传该单证',
  },
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
 * 把后端解析错误翻译为用户可读文案。
 * 后端错误形如 "ai_auth_failed: 鉴权失败：API Key 无效"，
 * 取冒号前的错误码做映射。
 */
export function toDocErrorView(rawError: string | null | undefined): DocErrorView | null {
  if (!rawError || !rawError.trim()) return null
  const raw = rawError.trim()
  const code = raw.split(':')[0].trim()
  const meta = DOC_ERROR_META[code]
  if (!meta) {
    return { title: '解析失败', advice: '可点击重新解析重试', raw, known: false }
  }
  return { title: meta.title, advice: meta.advice, raw, known: true }
}

/** 从错误码判断是否值得提示「重新解析」（配额/鉴权类问题重试无意义） */
export function isRetryWorthwhile(code: string): boolean {
  return ![
    'ai_auth_failed',
    'ai_quota_exceeded',
    'ai_not_connected',
    'ai_not_configured',
    'ocr_not_configured',
    'unsupported_message_type',
  ].includes(code)
}
