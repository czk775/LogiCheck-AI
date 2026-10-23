/* ============================================================
   字段 / 异常 / 复核 / 重检服务（演示确定性逻辑的 1:1 服务端移植）。

   边界说明：
   - 字段候选、人工修正留痕、人工复核、规则跟进、重检均为「确定性演示逻辑」，
     与前端 Mock 行为一致，全部落真实数据库；不调用任何 AI 或规则引擎。
   - 非演示货物的重检明确返回 ai_not_connected，不伪造检查结果。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import { errors } from '../../core/errors.ts'
import { newId, nowIso } from '../../core/ids.ts'
import type { ShipmentService } from '../shipments/service.ts'
import { RULE_NAMES } from '../demo/seed.ts'
import type {
  CheckResultLite,
  FieldCandidate,
  Finding,
  HumanDecision,
  ProcessingRun,
  RecheckReport,
  RuleKey,
  Shipment,
} from '../../types.ts'

interface DocFieldValue {
  document_id: string
  file_name: string
  value: string
}

interface FindingRow {
  id: string
  shipment_id: string
  title: string
  kind: Finding['kind']
  rule_key: string | null
  severity: Finding['severity']
  status: Finding['status']
  summary: string
  evidence: string
  created_at: string
}

export class FindingService {
  constructor(
    private readonly db: Db,
    private readonly shipments: ShipmentService,
  ) {}

  /* ---------- 字段候选 ---------- */

  getCandidates(userId: string, shipmentId: string, fieldKey: string): FieldCandidate[] {
    const shipment = this.requireShipment(userId, shipmentId)
    // 每个文档取该字段最新一次的值（人工修正后的当前值）
    const rows = this.db
      .all<DocFieldValue & { rowid: number }>(
        `SELECT d.id AS document_id, d.file_name AS file_name, f.value AS value, f.rowid AS rowid
         FROM extracted_fields f JOIN documents d ON d.id = f.document_id
         WHERE f.shipment_id = ? AND f.field_key = ?
         ORDER BY f.rowid ASC`,
        shipment.id,
        fieldKey,
      )
    const latest = new Map<string, DocFieldValue>()
    for (const r of rows) latest.set(r.document_id, { document_id: r.document_id, file_name: r.file_name, value: r.value })
    return [...latest.values()].map((r) => ({
      key: fieldKey,
      value: r.value,
      sourceDocumentId: r.document_id,
      sourceFileName: r.file_name,
    }))
  }

  /* ---------- 人工修正提取字段（留痕 + profile 推导） ---------- */

  updateField(userId: string, shipmentId: string, documentId: string, fieldKey: string, value: string): Shipment {
    this.requireShipment(userId, shipmentId)
    const doc = this.db.get<{ id: string; file_name: string }>(
      'SELECT id, file_name FROM documents WHERE id = ? AND shipment_id = ?',
      documentId,
      shipmentId,
    )
    if (!doc) throw errors.notFound('来源单证不存在')
    const prevRow = this.db.get<{ value: string }>(
      'SELECT value FROM extracted_fields WHERE document_id = ? AND field_key = ?',
      documentId,
      fieldKey,
    )
    const prev = prevRow?.value

    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO extracted_fields (id, document_id, shipment_id, field_key, value, original_value, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)`,
        newId('fld'),
        documentId,
        shipmentId,
        fieldKey,
        value,
        prev ?? null,
        nowIso(),
      )
      this.recomputeProfile(shipmentId, fieldKey, value)
      this.db.run('UPDATE shipments SET dirty = 1, updated_at = ? WHERE id = ?', nowIso(), shipmentId)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        shipmentId,
        `人工修正提取值：${doc.file_name} / ${fieldKey}：${prev ?? '未填写'} → ${value}`,
        nowIso(),
      )
    })
    return this.shipments.getForUser(userId, shipmentId)!
  }

  /** 与 Mock 一致的 profile 推导：quantity 走跨单证比对，其余直接采用修正值 */
  private recomputeProfile(shipmentId: string, fieldKey: string, value: string): void {
    if (fieldKey === 'quantity') {
      const inv = this.latestDocField(shipmentId, 'doc-invoice', 'quantity')
      const pl = this.latestDocField(shipmentId, 'doc-packing', 'quantity')
      const unit = this.latestDocField(shipmentId, 'doc-invoice', 'unit')
      const derived =
        inv && pl
          ? Number(inv) === Number(pl)
            ? `${inv} ${unit || 'PCS'}（待重新检查）`
            : '待确认（存在冲突）'
          : '证据不足'
      this.upsertProfile(shipmentId, 'quantity', derived)
    } else {
      this.upsertProfile(shipmentId, fieldKey, value)
    }
  }

  /** 某文档某字段的最新值（人工修正后的当前值；按 rowid 取最后写入） */
  private latestDocField(shipmentId: string, docId: string, fieldKey: string): string | null {
    const row = this.db.get<{ value: string }>(
      `SELECT f.value AS value FROM extracted_fields f
       WHERE f.shipment_id = ? AND f.document_id = ? AND f.field_key = ?
       ORDER BY f.rowid DESC LIMIT 1`,
      shipmentId,
      docId,
      fieldKey,
    )
    return row?.value ?? null
  }

  private upsertProfile(shipmentId: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO shipment_profiles (shipment_id, field_key, value) VALUES (?, ?, ?)
       ON CONFLICT(shipment_id, field_key) DO UPDATE SET value = excluded.value`,
      shipmentId,
      key,
      value,
    )
  }

  /* ---------- 人工复核 ---------- */

  recordDecision(userId: string, findingId: string, note: string): Finding {
    const row = this.requireFindingOfUser(userId, findingId)
    const t = nowIso()
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO human_decisions (id, finding_id, shipment_id, text, kind, at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('dec'),
        findingId,
        row.shipment_id,
        note,
        'review',
        t,
      )
      this.db.run('UPDATE findings SET status = ? WHERE id = ?', 'reviewed', findingId)
      this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, row.shipment_id)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.shipment_id,
        `人工复核「${row.title}」：${note}`,
        t,
      )
    })
    return this.getFinding(findingId)!
  }

  /* ---------- 规则人工跟进 ---------- */

  createRuleFollowUp(userId: string, shipmentId: string, ruleKey: string): Finding {
    const shipment = this.requireShipment(userId, shipmentId)
    if (!shipment.isDemo) {
      throw errors.badRequest('当前货物没有该规则的真实检查结果，无法记录人工意见')
    }
    const existing = this.db.get<{ id: string }>(
      `SELECT id FROM findings WHERE shipment_id = ? AND rule_key = ? AND status != 'resolved'`,
      shipmentId,
      ruleKey,
    )
    if (existing) return this.getFinding(existing.id)!

    const t = nowIso()
    const id = newId('f')
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO findings (id, shipment_id, title, kind, rule_key, severity, status, summary, evidence, created_at)
         VALUES (?, ?, ?, 'rule', ?, 'warn', 'open', '材料或规则适用性待进一步确认', '[]', ?)`,
        id,
        shipmentId,
        `${RULE_NAMES[ruleKey] ?? ruleKey} · 人工跟进`,
        ruleKey,
        t,
      )
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        shipmentId,
        `记录人工跟进：${RULE_NAMES[ruleKey] ?? ruleKey}`,
        t,
      )
    })
    return this.getFinding(id)!
  }

  /* ---------- 重新检查 ---------- */

  recheck(userId: string, shipmentId: string): RecheckReport {
    const shipment = this.requireShipment(userId, shipmentId)
    const t = nowIso()
    const runId = newId('run')
    const base = {
      id: runId,
      shipmentId,
      trigger: 'recheck' as const,
      startedAt: t,
      ruleVersion: 'Demo v0.1',
    }

    // 非演示货物：没有真实 AI 与规则引擎，明确不生成结果
    if (!shipment.isDemo) {
      this.db.transaction(() => {
        this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, shipmentId)
        this.db.run(
          'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
          newId('act'),
          shipmentId,
          '手动请求重新检查',
          t,
        )
        this.db.run(
          `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
           VALUES (?, ?, 'recheck', 'failed', ?, ?, '手动请求重新检查', 'Demo v0.1', 'ai_not_connected')`,
          runId,
          shipmentId,
          t,
          t,
        )
      })
      const run: ProcessingRun = {
        ...base,
        status: 'failed',
        finishedAt: t,
        summary: '真实文件的 AI 解析和预检尚未接入，未生成检查结果',
        error: 'ai_not_connected',
      }
      return {
        shipmentId,
        ran: false,
        reason: 'ai_not_connected',
        run,
        summary: '真实文件的 AI 解析和预检尚未接入。已保留资料，未生成虚假检查结果。',
      }
    }

    // 演示货物：确定性的数量一致性核验（与原型一致）
    let summary = ''
    let succeeded = true
    const finding = shipment.findings.find((x) => x.id === 'f-qty')
    const inv = shipment.documents.find((d) => d.id === 'doc-invoice')
    const pl = shipment.documents.find((d) => d.id === 'doc-packing')

    this.db.transaction(() => {
      if (finding && inv && pl && inv.fields.quantity && pl.fields.quantity) {
        if (Number(inv.fields.quantity) === Number(pl.fields.quantity) && inv.fields.unit === pl.fields.unit) {
          this.db.run('UPDATE findings SET status = ?, summary = ? WHERE id = ?', 'resolved', `两份来源单证现均为 ${inv.fields.quantity} ${inv.fields.unit || 'PCS'}（演示数据）`, finding.id)
          this.upsertProfile(shipmentId, 'quantity', `${inv.fields.quantity} ${inv.fields.unit || 'PCS'}`)
          this.addActivity(shipmentId, '重新检查通过：发票与装箱单数量一致，数量冲突已解决')
          summary = '重新检查通过：数量异常已解决（演示核验）'
        } else {
          this.db.run(
            'UPDATE findings SET status = ?, summary = ? WHERE id = ?',
            'open',
            `Invoice：${inv.fields.quantity} ${inv.fields.unit || 'PCS'} · Packing List：${pl.fields.quantity} ${pl.fields.unit || 'PCS'}`,
            finding.id,
          )
          this.upsertProfile(shipmentId, 'quantity', '待确认（存在冲突）')
          this.addActivity(shipmentId, '重新检查：数量冲突仍存在')
          summary = '重新检查完成：数量冲突仍存在'
        }
      } else if (finding) {
        this.db.run('UPDATE findings SET status = ?, summary = ? WHERE id = ?', 'open', '缺少足够的已解析来源，暂无法执行数量一致性核验', finding.id)
        this.upsertProfile(shipmentId, 'quantity', '证据不足')
        this.addActivity(shipmentId, '重新检查：缺少数量比较的有效证据')
        summary = '证据不足，不能判定数量一致'
        succeeded = false
      } else {
        summary = '没有需要重新检查的数量冲突项'
      }
      this.db.run('UPDATE shipments SET dirty = 0, updated_at = ? WHERE id = ?', t, shipmentId)
      this.db.run(
        `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
         VALUES (?, ?, 'recheck', ?, ?, ?, ?, 'Demo v0.1', NULL)`,
        runId,
        shipmentId,
        succeeded ? 'succeeded' : 'partially_succeeded',
        t,
        t,
        summary,
      )
    })
    return { shipmentId, ran: true, summary }
  }

  /* ---------- 处理记录 / 操作记录 ---------- */

  getRuns(userId: string, shipmentId: string): ProcessingRun[] {
    this.requireShipment(userId, shipmentId)
    return this.db
      .all<{
        id: string
        shipment_id: string
        trigger: ProcessingRun['trigger']
        status: ProcessingRun['status']
        started_at: string
        finished_at: string | null
        summary: string
        rule_version: string | null
        error: string | null
      }>('SELECT * FROM processing_runs WHERE shipment_id = ? ORDER BY started_at DESC', shipmentId)
      .map((r) => {
        const run: ProcessingRun = {
          id: r.id,
          shipmentId: r.shipment_id,
          trigger: r.trigger,
          status: r.status,
          startedAt: r.started_at,
          summary: r.summary,
        }
        if (r.finished_at) run.finishedAt = r.finished_at
        if (r.rule_version) run.ruleVersion = r.rule_version
        if (r.error) run.error = r.error
        return run
      })
  }

  getActivities(userId: string, shipmentId: string): Array<{ text: string; at: string }> {
    this.requireShipment(userId, shipmentId)
    return this.db
      .all<{ text: string; at: string }>('SELECT text, at FROM activities WHERE shipment_id = ? ORDER BY at DESC', shipmentId)
      .map((a) => ({ text: a.text, at: a.at }))
  }

  /** 规则预检概况：演示货物读内置示例结果；非演示货物为空（未接入真实预检） */
  getCheckResults(userId: string, shipmentId: string): CheckResultLite[] {
    const shipment = this.requireShipment(userId, shipmentId)
    if (!shipment.isDemo) return []
    return this.db
      .all<{ rule_key: string; status: CheckResultLite['status']; label: string; tone: CheckResultLite['tone']; evidence_refs: string }>(
        // 必须按插入顺序（rowid）返回：id 为随机串，ORDER BY id 会打乱与前端约定的一致顺序
        'SELECT rule_key, status, label, tone, evidence_refs FROM check_results WHERE shipment_id = ? ORDER BY rowid ASC',
        shipmentId,
      )
      .map((r) => ({
        ruleKey: r.rule_key,
        status: r.status,
        label: r.label,
        tone: r.tone,
        evidenceRefs: safeJsonArray(r.evidence_refs),
      }))
  }

  /* ---------- 内部工具 ---------- */

  private requireShipment(userId: string, shipmentId: string): Shipment {
    const shipment = this.shipments.getForUser(userId, shipmentId)
    if (!shipment) throw errors.notFound('货物不存在或已被删除')
    return shipment
  }

  private requireFindingOfUser(userId: string, findingId: string): FindingRow {
    const row = this.db.get<FindingRow & { user_id: string }>(
      `SELECT f.*, s.user_id AS user_id FROM findings f JOIN shipments s ON s.id = f.shipment_id WHERE f.id = ?`,
      findingId,
    )
    if (!row || row.user_id !== userId) throw errors.notFound('异常不存在或已被删除')
    return row
  }

  private getFinding(findingId: string): Finding | null {
    const row = this.db.get<FindingRow>('SELECT * FROM findings WHERE id = ?', findingId)
    if (!row) return null
    const notes = this.db
      .all<{ id: string; text: string; kind: HumanDecision['kind']; at: string }>(
        'SELECT id, text, kind, at FROM human_decisions WHERE finding_id = ? ORDER BY at DESC',
        findingId,
      )
      .map((n) => ({ id: n.id, text: n.text, at: n.at, kind: n.kind }))
    return {
      id: row.id,
      shipmentId: row.shipment_id,
      title: row.title,
      kind: row.kind,
      ruleKey: (row.rule_key as RuleKey) ?? undefined,
      severity: row.severity,
      status: row.status,
      summary: row.summary,
      evidence: safeJsonArray(row.evidence),
      notes,
      createdAt: row.created_at,
    }
  }

  private addActivity(shipmentId: string, text: string): void {
    this.db.run('INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)', newId('act'), shipmentId, text, nowIso())
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
