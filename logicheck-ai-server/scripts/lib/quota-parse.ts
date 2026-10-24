/* ============================================================
   免费额度响应解析（纯函数，无副作用，可独立测试）
   ------------------------------------------------------------
   设计要点：
   1. 服务商返回结构可能调整 → 宽松匹配多组候选字段名
   2. 「解析不到」必须返回空数组，绝不能编造一条额度记录
   3. 只有同时具备「模型名 + 数值」才认定为额度行
   4. 同一模型重复出现时保留首次记录
   ============================================================ */

export interface QuotaRow {
  model: string
  remaining: number | null
  total: number | null
  expiresAt: string | null
  raw: Record<string, unknown>
}

const NAME_KEYS = ['model', 'model_name', 'modelName', 'name', 'code', 'model_code']
const REMAINING_KEYS = [
  'remaining', 'remain', 'remaining_tokens', 'remainingTokens',
  'free_remaining', 'freeRemaining', 'available', 'balance', 'quota', 'left',
]
const TOTAL_KEYS = [
  'total', 'total_tokens', 'totalTokens', 'quota_total', 'quotaTotal',
  'free_quota', 'freeQuota', 'limit', 'initial', 'granted',
]
const EXPIRY_KEYS = [
  'expire_time', 'expireTime', 'expires_at', 'expiresAt',
  'valid_until', 'validUntil', 'end_time', 'endTime', 'deadline',
]

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function pickName(o: Record<string, unknown>): string | null {
  for (const k of NAME_KEYS) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function pickRemaining(o: Record<string, unknown>): number | null {
  for (const k of REMAINING_KEYS) {
    const v = asNumber(o[k])
    if (v !== null) return v
  }
  return null
}

function pickTotal(o: Record<string, unknown>): number | null {
  for (const k of TOTAL_KEYS) {
    const v = asNumber(o[k])
    if (v !== null) return v
  }
  return null
}

function pickExpiry(o: Record<string, unknown>): string | null {
  for (const k of EXPIRY_KEYS) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) {
      const ms = v > 1e12 ? v : v * 1000
      const d = new Date(ms)
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10)
    }
  }
  return null
}

/** 从任意层级的 JSON 中提取额度行 */
export function parseQuotaRows(payload: unknown): QuotaRow[] {
  const rows: QuotaRow[] = []
  const seen = new Set<unknown>()

  const walk = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }

    const obj = node as Record<string, unknown>
    const name = pickName(obj)
    const remaining = pickRemaining(obj)
    if (name && remaining !== null) {
      rows.push({
        model: name,
        remaining,
        total: pickTotal(obj),
        expiresAt: pickExpiry(obj),
        raw: obj,
      })
    }

    for (const v of Object.values(obj)) walk(v, depth + 1)
  }

  walk(payload, 0)

  const byModel = new Map<string, QuotaRow>()
  for (const r of rows) if (!byModel.has(r.model)) byModel.set(r.model, r)
  return [...byModel.values()]
}

/** 判断某个模型是否有可用额度（remaining > 0） */
export function hasUsableQuota(rows: QuotaRow[], model: string): boolean {
  const hit = rows.find((r) => r.model === model || r.model.startsWith(model))
  if (!hit) return false
  const remain = hit.remaining
  return remain !== null && remain > 0
}

/* ============================================================
 * 候选模型筛选
 * ------------------------------------------------------------
 * 背景：百炼的免费额度是「按模型逐个发放」的，实测账号里可能有 80+ 个
 *      模型（qwen3.8-*、kimi-k3、deepseek-v4-* 等），而 .env 里配的
 *      偏好模型未必在其中；命名也已迭代到新版本。
 *      因此必须能：从真实额度列表里筛出「可用候选」并区分是否具备
 *      视觉能力（OCR 路径的唯一前提），而不是靠猜。
 * ============================================================ */

/** 判断模型名是否具备视觉 / OCR 能力（按百炼命名约定） */
export function isVisionModel(model: string): boolean {
  const m = model.toLowerCase()
  // vl / ocr / omni 作为独立片段出现时才算视觉模型（避免误伤普通文本模型）
  return /(^|[-_.])(vl|ocr|omni)([-_.]|$)/.test(m)
}

/** 计算距离到期的天数：未来为正、已过期为负；无到期信息返回 null */
export function daysUntil(expiresAt: string | null, now: Date = new Date()): number | null {
  if (!expiresAt) return null
  const ts = Date.parse(expiresAt)
  if (Number.isNaN(ts)) return null
  const end = new Date(ts)
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const endUtc = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate())
  return Math.round((endUtc - base) / 86_400_000)
}

export type MatchType = 'exact' | 'snapshot' | 'none'

export interface CandidateResolution {
  /** 命中的额度记录；matchType=none 时为 null（绝不编造） */
  row: QuotaRow | null
  matchType: MatchType
}

/**
 * 在额度列表中定位偏好模型：
 *   exact   —— 模型名完全一致
 *   snapshot—— 仅命中带日期后缀的快照版本（如 qwen3-vl-plus-2025-11-20）
 *   none    —— 列表中不存在该模型（调用方应改用 findUsableModels 找替代）
 */
export function resolveCandidate(rows: QuotaRow[], preferred: string): CandidateResolution {
  const exact = rows.find((r) => r.model === preferred)
  if (exact) return { row: exact, matchType: 'exact' }
  const snapshot = rows.find((r) => r.model.startsWith(preferred + '-'))
  if (snapshot) return { row: snapshot, matchType: 'snapshot' }
  return { row: null, matchType: 'none' }
}

export interface UsableModels {
  /** 具备视觉 / OCR 能力的可用模型 */
  vision: QuotaRow[]
  /** 纯文本可用模型 */
  text: QuotaRow[]
}

/**
 * 从额度列表中筛出「真正可用」的候选（remaining > 0），
 * 并按视觉 / 文本分开，组内按剩余额度降序。
 */
export function findUsableModels(rows: QuotaRow[]): UsableModels {
  const usable = rows.filter((r) => r.remaining !== null && r.remaining > 0)
  const byRemaining = (a: QuotaRow, b: QuotaRow): number => (b.remaining ?? 0) - (a.remaining ?? 0)
  const vision = usable.filter((r) => isVisionModel(r.model)).sort(byRemaining)
  const text = usable.filter((r) => !isVisionModel(r.model)).sort(byRemaining)
  return { vision, text }
}

/* ============================================================
 * 可用模型清单（GET /models）
 * ------------------------------------------------------------
 * 用途：控制台免费额度页只有 10 条/页、需翻 9 页，且搜索框只认英文
 *      model code；用户常常「找不到某个模型」。这里直接从开放接口
 *      拉取当前 Key 可调用的完整模型列表，一次列全。
 * ============================================================ */

/** 从 /models 响应中提取模型 code 列表（兼容 OpenAI 兼容的 data 数组） */
export function parseModelList(payload: unknown): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const obj = node as Record<string, unknown>
    for (const key of ['id', 'model', 'model_name', 'modelName', 'name', 'code']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() && !seen.has(v.trim())) {
        seen.add(v.trim())
        out.push(v.trim())
        break
      }
    }
    for (const v of Object.values(obj)) walk(v, depth + 1)
  }

  walk(payload, 0)
  return out
}
