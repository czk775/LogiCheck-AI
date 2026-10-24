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
