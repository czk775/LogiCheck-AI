/* ============================================================
   跨单证一致性核验（阶段三 · 确定性）

   对同一字段在多份单证中的取值做标准化后比对：
   - consistent   一致
   - conflict     冲突（取值不同，或单位不一致）
   - missing      只有一份单证包含该字段，无从交叉验证
   - indeterminate 无法判断（存在无法标准化的取值）

   设计原则：
   - 只比对「可标准化」的字段（数量/重量/金额/币种/日期/贸易术语），
     型号等自由文本不做严格比对（避免同义表述噪音）——其存在性供规则评估使用
   - 结论必须引用真实原始值（哪份单证、什么值），不臆造中间值
   - 纯函数：同样输入永远得到同样输出（可复算）
   ============================================================ */

import { normalizeAmount, normalizeDate, normalizeIncoterm, normalizeQuantity, normalizeWeight } from '../parsing/schema.ts'

export type CrossStatus = 'consistent' | 'conflict' | 'missing' | 'indeterminate'

/** 某份单证对某字段的一次观测 */
export interface FieldObservation {
  documentId: string
  fileName: string
  /** 文档中的原始值（未经加工） */
  raw: string
  /** 标准化后的比较键；null 表示无法标准化 */
  normalized: string | null
  /** 附带单位（数量等）；无则 null */
  unit: string | null
}

export interface CrossCheckResult {
  fieldKey: string
  /** 检查项名称（人类可读） */
  title: string
  status: CrossStatus
  observations: FieldObservation[]
  /** 结论摘要（引用真实原始值） */
  summary: string
}

/** 参与跨单证比对的字段组定义 */
interface FieldGroup {
  fieldKey: string
  title: string
  /** 附带单位字段（如数量附带 unit） */
  unitKey?: string
  /** 标准化为比较键；null = 无法标准化 */
  normalize: (raw: string) => string | null
  /** 冲突严重度：数量/重量/金额类为 danger，其余为 warn */
  severity: 'danger' | 'warn'
}

export const CROSS_FIELD_GROUPS: FieldGroup[] = [
  {
    fieldKey: 'quantity',
    title: '数量',
    unitKey: 'unit',
    normalize: (raw) => normalizeQuantity(raw),
    severity: 'danger',
  },
  {
    fieldKey: 'gross',
    title: '毛重',
    normalize: (raw) => {
      const w = normalizeWeight(raw)
      return w ? `${w.value}|${w.unit}` : null
    },
    severity: 'danger',
  },
  {
    fieldKey: 'net_weight',
    title: '净重',
    normalize: (raw) => {
      const w = normalizeWeight(raw)
      return w ? `${w.value}|${w.unit}` : null
    },
    severity: 'warn',
  },
  {
    fieldKey: 'total_amount',
    title: '总金额',
    normalize: (raw) => normalizeAmount(raw)?.amount ?? null,
    severity: 'danger',
  },
  {
    fieldKey: 'unit_price',
    title: '单价',
    normalize: (raw) => normalizeAmount(raw)?.amount ?? null,
    severity: 'warn',
  },
  {
    fieldKey: 'currency',
    title: '币种',
    normalize: (raw) => {
      const m = raw.trim().toUpperCase().match(/^([A-Z]{3})$/)
      return m ? m[1] : (normalizeAmount(raw)?.currency ?? null)
    },
    severity: 'danger',
  },
  {
    fieldKey: 'invoice_date',
    title: '发票日期',
    normalize: (raw) => normalizeDate(raw),
    severity: 'warn',
  },
  {
    fieldKey: 'ship_date',
    title: '发运日期',
    normalize: (raw) => normalizeDate(raw),
    severity: 'warn',
  },
  {
    fieldKey: 'incoterms',
    title: '贸易术语',
    normalize: (raw) => normalizeIncoterm(raw),
    severity: 'warn',
  },
]

export function crossGroupSeverity(fieldKey: string): 'danger' | 'warn' {
  return CROSS_FIELD_GROUPS.find((g) => g.fieldKey === fieldKey)?.severity ?? 'warn'
}

/** 观测值的人类可读形式（原始值 + 单位） */
function display(obs: FieldObservation): string {
  return obs.unit ? `${obs.raw} ${obs.unit}` : obs.raw
}

function listValues(observations: FieldObservation[]): string {
  return observations.map((o) => `${o.fileName}=${display(o)}`).join(' · ')
}

/**
 * 对单个字段组执行跨单证比对。
 * observations 已按文档聚合（同文档同字段只取最新值）。
 */
export function compareGroup(group: FieldGroup, observations: FieldObservation[]): CrossCheckResult | null {
  if (observations.length === 0) return null

  const base = { fieldKey: group.fieldKey, title: group.title, observations }

  if (observations.length === 1) {
    return {
      ...base,
      status: 'missing',
      summary: `仅 1 份单证包含${group.title}（${listValues(observations)}），无从交叉验证`,
    }
  }

  const unnormalizable = observations.filter((o) => o.normalized === null)
  if (unnormalizable.length) {
    return {
      ...base,
      status: 'indeterminate',
      summary: `无法判断：以下取值未能标准化——${listValues(unnormalizable)}`,
    }
  }

  // 比较键：标准化值（数量类附带单位）
  const keys = observations.map((o) => (group.unitKey && o.unit ? `${o.normalized}|${o.unit.trim().toUpperCase()}` : o.normalized!))
  const first = keys[0]
  if (keys.every((k) => k === first)) {
    return {
      ...base,
      status: 'consistent',
      summary: `${observations.length} 份单证的${group.title}一致（${listValues(observations)}）`,
    }
  }

  // 数量/金额相同但单位不同 → 冲突（单位不一致）
  const bareKeys = observations.map((o) => o.normalized!)
  const unitMismatch = group.unitKey !== undefined && bareKeys.every((k) => k === bareKeys[0]) && new Set(keys).size > 1
  return {
    ...base,
    status: 'conflict',
    summary: unitMismatch
      ? `${group.title}单位不一致：${listValues(observations)}`
      : `${group.title}不一致：${listValues(observations)}`,
  }
}

/**  docFields：documentId → (fieldKey → 最新观测值原始串) */
export function crossCheckShipment(
  docFields: Map<string, { fileName: string; fields: Map<string, string> }>,
): CrossCheckResult[] {
  const results: CrossCheckResult[] = []
  for (const group of CROSS_FIELD_GROUPS) {
    const observations: FieldObservation[] = []
    for (const [documentId, doc] of docFields) {
      const raw = doc.fields.get(group.fieldKey)
      if (raw === undefined || raw.trim() === '') continue
      const unit = group.unitKey ? (doc.fields.get(group.unitKey) ?? null) : null
      observations.push({
        documentId,
        fileName: doc.fileName,
        raw: raw.trim(),
        normalized: group.normalize(raw),
        unit: unit?.trim() ?? null,
      })
    }
    const result = compareGroup(group, observations)
    if (result) results.push(result)
  }
  return results
}
