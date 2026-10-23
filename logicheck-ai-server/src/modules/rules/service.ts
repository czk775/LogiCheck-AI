/* ============================================================
   合规规则服务：规则参考数据（PRD §7.1 Rule Contract）。
   规则为全局参考数据，无 owner；规则预检引擎属后续阶段。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import type { ComplianceRule, RuleKey } from '../../types.ts'

interface RuleRow {
  rule_id: string
  key: string
  title: string
  category: string
  jurisdiction: string
  product_scope: string
  actor_scope: string
  effective_from: string
  effective_to: string | null
  trigger: string
  required_evidence: string
  check_logic: string
  severity: 'danger' | 'warn'
  source_title: string
  source_url: string
  source_version: string
  accessed_at: string
  rule_version: string
  detail: string
  recommend: string
}

export class RuleService {
  constructor(private readonly db: Db) {}

  list(): ComplianceRule[] {
    return this.db.all<RuleRow>('SELECT * FROM compliance_rules ORDER BY sort_order ASC').map((r) => {
      const rule: ComplianceRule = {
        ruleId: r.rule_id,
        key: r.key as RuleKey,
        title: r.title,
        category: r.category,
        jurisdiction: r.jurisdiction,
        productScope: r.product_scope,
        actorScope: r.actor_scope,
        effectiveFrom: r.effective_from,
        trigger: r.trigger,
        requiredEvidence: safeJsonArray(r.required_evidence),
        checkLogic: r.check_logic,
        severity: r.severity,
        sourceTitle: r.source_title,
        sourceURL: r.source_url,
        sourceVersion: r.source_version,
        accessedAt: r.accessed_at,
        ruleVersion: r.rule_version,
        detail: r.detail,
        recommend: r.recommend,
      }
      if (r.effective_to) rule.effectiveTo = r.effective_to
      return rule
    })
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
