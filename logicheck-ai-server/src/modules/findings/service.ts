/* ============================================================
   字段 / 异常 / 复核 / 重检服务。

   边界说明：
   - 字段候选、人工修正留痕、人工复核、规则跟进均为「确定性演示逻辑」，
     与前端 Mock 行为一致，全部落真实数据库。
   - 阶段三起：非演示货物的重检走确定性核验引擎（跨单证一致性 + 合规预检），
     检查结果与异常均由引擎生成并引用真实证据；无已解析单证时明确不跑。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import { errors } from '../../core/errors.ts'
import { newId, nowIso } from '../../core/ids.ts'
import type { ShipmentService } from '../shipments/service.ts'
import type { CheckEngine } from '../checking/engine.ts'
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
    /** 核验引擎（阶段三；未注入时非演示货物重检保持诚实降级） */
    private readonly checkEngine?: CheckEngine,
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

  /**
   * 与 Mock 一致的 profile 推导：
   * - quantity：跨单证比对（不再依赖硬编码的演示文档 ID）
   * - 其余字段：直接采用人工修正值
   */
  private recomputeProfile(shipmentId: string, fieldKey: string, value: string): void {
    if (fieldKey === 'quantity') {
      const derived = this.deriveQuantityProfile(shipmentId)
      this.upsertProfile(shipmentId, 'quantity', derived)
    } else {
      this.upsertProfile(shipmentId, fieldKey, value)
    }
  }

  /**
   * 数量字段的跨单证推导：
   * - 只有一份单证提供 → 标注证据不足
   * - 多份单证取值一致 → 显示一致值 + 单位（待重新检查）
   * - 取值不一致 → 待确认（存在冲突）
   * 演示货物沿用原型固定的两份单证（发票 / 装箱单），真实货物按实际单证集合比对。
   */
  private deriveQuantityProfile(shipmentId: string): string {
    const rows = this.db.all<{ document_id: string; file_name: string; value: string }>(
      `SELECT f.document_id AS document_id, d.file_name AS file_name, f.value AS value
         FROM extracted_fields f JOIN documents d ON d.id = f.document_id
        WHERE f.shipment_id = ? AND f.field_key = 'quantity'
        ORDER BY f.rowid ASC`,
      shipmentId,
    )
    // 同文档取最后一次写入（人工修正后以修正值为准）
    const latest = new Map<string, { fileName: string; value: string }>()
    for (const r of rows) latest.set(r.document_id, { fileName: r.file_name, value: r.value })

    const values = [...latest.values()].filter((v) => v.value.trim() !== '')
    if (!values.length) return '证据不足'

    const unitRow = this.db.get<{ value: string }>(
      `SELECT f.value AS value FROM extracted_fields f JOIN documents d ON d.id = f.document_id
        WHERE f.shipment_id = ? AND f.field_key = 'unit' ORDER BY f.rowid DESC LIMIT 1`,
      shipmentId,
    )
    const unit = unitRow?.value?.trim() ?? ''

    if (values.length === 1) {
      // 单份单证 → 无从交叉验证
      return `${values[0].value}${unit ? ` ${unit}` : ''}（仅 1 份单证，待交叉验证）`
    }

    const normalized = values.map((v) => Number(String(v.value).replace(/[^\d.]/g, '')))
    const allSame = normalized.every((n) => Number.isFinite(n) && n === normalized[0])
    if (!allSame) return '待确认（存在冲突）'

    return `${values[0].value}${unit ? ` ${unit}` : ''}（待重新检查）`
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

  /* ---------- 人工解决异常（阶段四闭环） ---------- */

  /**
   * 人工判定异常已解决：必须附带处理说明（留痕不可删除）。
   * 与「人工复核（reviewed）」的区别：reviewed 保留风险，resolved 表示人已确认处理完毕。
   * 注意：resolved 不代表系统判定通过 —— 后续重跑若仍存在冲突，引擎不会自动重开
   * （尊重人工结论），但会在处理记录中留下「冲突仍存在」的运行摘要。
   */
  resolveFinding(userId: string, findingId: string, note: string): Finding {
    const row = this.requireFindingOfUser(userId, findingId)
    if (row.status === 'resolved') {
      // 已解决：仍允许补充说明（追加留痕），不重复改状态
      this.appendDecision(row.shipment_id, findingId, note, 'resolve')
      return this.getFinding(findingId)!
    }
    const t = nowIso()
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO human_decisions (id, finding_id, shipment_id, text, kind, at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('dec'),
        findingId,
        row.shipment_id,
        note,
        'resolve',
        t,
      )
      this.db.run('UPDATE findings SET status = ? WHERE id = ?', 'resolved', findingId)
      this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, row.shipment_id)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.shipment_id,
        `人工解决「${row.title}」：${note}`,
        t,
      )
    })
    return this.getFinding(findingId)!
  }

  /** 重新打开异常（人工发现此前解决有误） */
  reopenFinding(userId: string, findingId: string, note: string): Finding {
    const row = this.requireFindingOfUser(userId, findingId)
    const t = nowIso()
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO human_decisions (id, finding_id, shipment_id, text, kind, at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('dec'),
        findingId,
        row.shipment_id,
        note,
        'reopen',
        t,
      )
      this.db.run('UPDATE findings SET status = ? WHERE id = ?', 'open', findingId)
      this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, row.shipment_id)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.shipment_id,
        `重新打开「${row.title}」：${note}`,
        t,
      )
    })
    return this.getFinding(findingId)!
  }

  /** 追加一条人工决定（不改状态） */
  private appendDecision(shipmentId: string, findingId: string, note: string, kind: string): void {
    const t = nowIso()
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO human_decisions (id, finding_id, shipment_id, text, kind, at) VALUES (?, ?, ?, ?, ?, ?)',
        newId('dec'),
        findingId,
        shipmentId,
        note,
        kind,
        t,
      )
      this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, shipmentId)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        shipmentId,
        `补充处理说明：${note}`,
        t,
      )
    })
  }

  /* ---------- 规则人工跟进 ---------- */

  createRuleFollowUp(userId: string, shipmentId: string, ruleKey: string): Finding {
    const shipment = this.requireShipment(userId, shipmentId)
    // 演示货物： curated 检查结果始终存在；真实货物：需引擎已生成该规则的检查结果
    if (!shipment.isDemo) {
      const hasResult = this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM check_results WHERE shipment_id = ? AND rule_key = ?',
        shipmentId,
        ruleKey,
      )?.n
      if (!hasResult) {
        throw errors.badRequest('当前货物没有该规则的真实检查结果，无法记录人工意见')
      }
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

    // 非演示货物：走确定性核验引擎（阶段三）。无已解析单证 → 明确不跑
    if (!shipment.isDemo) {
      const parsed = this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ? AND is_demo = 0 AND status = 'parsed'",
        shipmentId,
      )?.n ?? 0
      if (!this.checkEngine || parsed === 0) {
        const reason: 'no_documents' | 'ai_not_connected' = this.checkEngine ? 'no_documents' : 'ai_not_connected'
        const message =
          reason === 'no_documents'
            ? '尚无已解析的单证，无法执行核验；请先上传并成功解析单证'
            : '真实文件的解析与预检尚未接入，未生成检查结果'
        this.db.transaction(() => {
          this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', t, shipmentId)
          this.db.run('INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)', newId('act'), shipmentId, '手动请求重新检查', t)
          this.db.run(
            `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
             VALUES (?, ?, 'recheck', 'failed', ?, ?, '手动请求重新检查', NULL, ?)`,
            runId,
            shipmentId,
            t,
            t,
            reason,
          )
        })
        const run: ProcessingRun = {
          ...base,
          status: 'failed',
          finishedAt: t,
          summary: '手动请求重新检查',
          error: reason,
        }
        return {
          shipmentId,
          ran: false,
          reason,
          run,
          summary: message,
        }
      }

      const report = this.checkEngine.run(shipmentId, 'recheck')
      return { shipmentId, ran: true, run: report.run, summary: report.summary }
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

  /** 规则预检概况：演示货物读 seed 的 curated 结果；真实货物读引擎写入的结果 */
  getCheckResults(userId: string, shipmentId: string): CheckResultLite[] {
    this.requireShipment(userId, shipmentId)
    return this.db
      .all<{ rule_key: string; status: CheckResultLite['status']; label: string; tone: CheckResultLite['tone']; evidence_refs: string; reasoning: string | null }>(
        // 必须按插入顺序（rowid）返回：id 为随机串，ORDER BY id 会打乱与前端约定的一致顺序
        'SELECT rule_key, status, label, tone, evidence_refs, reasoning FROM check_results WHERE shipment_id = ? ORDER BY rowid ASC',
        shipmentId,
      )
      .map((r) => ({
        ruleKey: r.rule_key,
        status: r.status,
        label: r.label,
        tone: r.tone,
        evidenceRefs: safeJsonArray(r.evidence_refs),
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
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

  /** 异常详情（公开接口，带归属校验：他人异常一律 404） */
  getFindingForUser(userId: string, findingId: string): Finding {
    this.requireFindingOfUser(userId, findingId)
    const finding = this.getFinding(findingId)
    if (!finding) throw errors.notFound('异常不存在')
    return finding
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
