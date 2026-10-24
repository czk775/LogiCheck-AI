/* ============================================================
   核验引擎（阶段三）：跨单证一致性 + 合规规则预检

   - 输入：货物已解析单证的提取字段（含人工修正后的最新值）
   - 输出：check_results（规则预检，含判定依据）+ findings（跨单证冲突）
     + processing_runs + activities，全程可解释、可追溯、可重复执行
   - 重复执行安全：check_results 全量替换；引擎管理的异常按自然键
     （cross:<字段>）定位更新，不重复造异常；已由人工解决的异常不被自动重开
   - 演示货物不走本引擎（演示数据由 seed 提供 curated 结果）
   ============================================================ */

import type { Db } from '../../db/index.ts'
import { newId, nowIso } from '../../core/ids.ts'
import type { CheckResultLite, ProcessingRun } from '../../types.ts'
import { crossCheckShipment, crossGroupSeverity, type CrossCheckResult } from './crossCheck.ts'
import { evaluatorFor, type RuleContext, type RuleFieldValue } from './rules.ts'

export interface CheckReport {
  shipmentId: string
  cross: CrossCheckResult[]
  rules: Array<CheckResultLite & { reasoning: string }>
  run: ProcessingRun
  summary: string
}

interface RuleRow {
  key: string
  rule_version: string
  sort_order: number
}

interface DocRow {
  id: string
  file_name: string
  doc_type: string
  is_demo: number
}

interface FieldRow {
  document_id: string
  field_key: string
  value: string
  status: string | null
}

export class CheckEngine {
  constructor(private readonly db: Db) {}

  /**
   * 执行一次完整核验并落库。
   * trigger：check = 解析完成后自动运行；recheck = 用户手动重检。
   */
  run(shipmentId: string, trigger: 'check' | 'recheck' = 'check'): CheckReport {
    const docs = this.db
      .all<DocRow>('SELECT id, file_name, doc_type, is_demo FROM documents WHERE shipment_id = ? ORDER BY created_at ASC', shipmentId)
      .filter((d) => d.is_demo !== 1)

    /* 每个（文档 × 字段）取最后一次写入的值：人工修正后以修正值为准 */
    const fieldRows = this.db.all<FieldRow & { rowid: number }>(
      `SELECT f.document_id, f.field_key, f.value, f.status, f.rowid
         FROM extracted_fields f JOIN documents d ON d.id = f.document_id
        WHERE f.shipment_id = ? AND d.is_demo = 0
        ORDER BY f.rowid ASC`,
      shipmentId,
    )
    const latest = new Map<string, { value: string; status: string }>()
    for (const r of fieldRows) {
      latest.set(`${r.document_id}\u0000${r.field_key}`, { value: r.value, status: r.status ?? 'extracted' })
    }

    const docFields = new Map<string, { fileName: string; fields: Map<string, string> }>()
    const ruleFieldValues = new Map<string, RuleFieldValue[]>()
    for (const doc of docs) {
      const fields = new Map<string, string>()
      for (const [compound, cell] of latest) {
        const [documentId, fieldKey] = compound.split('\u0000')
        if (documentId !== doc.id) continue
        // missing / unavailable 不进入核验（值可能为空串）
        if (cell.status === 'missing' || cell.status === 'unavailable') continue
        if (cell.value.trim() === '') continue
        fields.set(fieldKey, cell.value.trim())
        const arr = ruleFieldValues.get(fieldKey) ?? []
        arr.push({ documentId: doc.id, fileName: doc.file_name, value: cell.value.trim() })
        ruleFieldValues.set(fieldKey, arr)
      }
      docFields.set(doc.id, { fileName: doc.file_name, fields })
    }

    /* 1. 跨单证一致性 */
    const cross = crossCheckShipment(docFields)

    /* 2. 合规规则预检（规则元数据来自 compliance_rules 表） */
    const ruleRows = this.db.all<RuleRow>('SELECT key, rule_version, sort_order FROM compliance_rules ORDER BY sort_order ASC')
    const ruleVersions = [...new Set(ruleRows.map((r) => r.rule_version))].join(' / ') || 'unknown'
    const ctx: RuleContext = {
      fieldValues: ruleFieldValues,
      documents: docs.map((d) => ({ id: d.id, fileName: d.file_name, docType: d.doc_type })),
    }
    const rules: Array<CheckResultLite & { reasoning: string }> = []
    for (const row of ruleRows) {
      const evaluator = evaluatorFor(row.key)
      if (!evaluator) {
        rules.push({
          ruleKey: row.key,
          status: 'error',
          label: '检查暂未实现',
          tone: 'warn',
          evidenceRefs: [],
          reasoning: `规则 ${row.key} 尚无确定性评估器；未生成结论，也不做臆测。`,
        })
        continue
      }
      const evaluation = evaluator(ctx)
      rules.push({ ruleKey: row.key, ...evaluation })
    }

    /* 3. 落库（事务：检查结果 + 异常 + 运行记录 + 活动） */
    const t = nowIso()
    const runId = newId('run')
    const conflicts = cross.filter((c) => c.status === 'conflict')
    const indeterminate = cross.filter((c) => c.status === 'indeterminate')
    const insufficient = rules.filter((r) => r.status === 'insufficient_evidence').length
    const manualReview = rules.filter((r) => r.status === 'warning').length
    const summary =
      `跨单证核验 ${cross.length} 项（冲突 ${conflicts.length} · 无法判断 ${indeterminate.length}）；` +
      `合规预检 ${rules.length} 项规则（待补充证据 ${insufficient} · 需人工关注 ${manualReview}）`

    this.db.transaction(() => {
      // 检查结果全量替换（旧结论失效，历史保留在 runs/activities）
      this.db.run('DELETE FROM check_results WHERE shipment_id = ?', shipmentId)
      for (const r of rules) {
        this.db.run(
          'INSERT INTO check_results (id, shipment_id, rule_key, status, label, tone, evidence_refs, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          newId('chk'),
          shipmentId,
          r.ruleKey,
          r.status,
          r.label,
          r.tone,
          JSON.stringify(r.evidenceRefs),
          r.reasoning,
        )
      }

      // 跨单证冲突 → 异常（按自然键定位；已解决的不自动重开）
      for (const c of cross) {
        const checkKey = `cross:${c.fieldKey}`
        const existing = this.db.get<{ id: string; status: string }>(
          'SELECT id, status FROM findings WHERE shipment_id = ? AND check_key = ?',
          shipmentId,
          checkKey,
        )
        const evidence = JSON.stringify(c.observations.map((o) => o.documentId))
        if (c.status === 'conflict') {
          if (!existing) {
            this.db.run(
              `INSERT INTO findings (id, shipment_id, title, kind, rule_key, severity, status, summary, evidence, check_key, created_at)
               VALUES (?, ?, ?, 'cross', NULL, ?, 'open', ?, ?, ?, ?)`,
              newId('f'),
              shipmentId,
              `跨单证${c.title}不一致`,
              crossGroupSeverity(c.fieldKey),
              c.summary,
              evidence,
              checkKey,
              t,
            )
          } else if (existing.status !== 'resolved') {
            this.db.run('UPDATE findings SET summary = ?, evidence = ?, severity = ? WHERE id = ?', c.summary, evidence, crossGroupSeverity(c.fieldKey), existing.id)
          }
          // 已解决（人工处理过）的异常保持 resolved，不自动重开；冲突事实记录在本次 run 摘要中
        } else if (c.status === 'consistent' && existing && existing.status === 'open') {
          // 仅「仍开放」的冲突在重检一致后自动解决；reviewed/resolved 不动
          this.db.run(
            'UPDATE findings SET status = ?, summary = ? WHERE id = ?',
            'resolved',
            `重检通过：${c.summary}`,
            existing.id,
          )
        }
      }

      this.db.run(
        `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
         VALUES (?, ?, ?, 'succeeded', ?, ?, ?, ?, NULL)`,
        runId,
        shipmentId,
        trigger,
        t,
        t,
        summary,
        ruleVersions,
      )
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        shipmentId,
        `核验完成：${summary}`,
        t,
      )
    })

    const run: ProcessingRun = {
      id: runId,
      shipmentId,
      trigger,
      status: 'succeeded',
      startedAt: t,
      finishedAt: t,
      summary,
      ruleVersion: ruleVersions,
    }
    return { shipmentId, cross, rules, run, summary }
  }
}
