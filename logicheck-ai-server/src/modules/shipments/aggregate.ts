/* ============================================================
   货物聚合构建：DB 行 → 前端 Shipment 形状（含 documents /
   findings(+notes) / runs / activities / profile）。
   列表与详情共用；批量加载避免 N+1。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import type {
  ActivityEvent,
  FieldMeta,
  Finding,
  HumanDecision,
  ProcessingRun,
  Shipment,
  ShipmentDocument,
} from '../../types.ts'

interface ShipmentRow {
  id: string
  user_id: string
  name: string
  origin: string
  destination: string
  is_demo: number
  dirty: number
  created_at: string
  updated_at: string
}

interface DocumentRow {
  id: string
  shipment_id: string
  file_name: string
  doc_type: string
  format: ShipmentDocument['format']
  status: ShipmentDocument['status']
  size: number
  storage_key: string | null
  error: string | null
  is_demo: number
  created_at: string
  updated_at: string
  parse_summary: string | null
}

interface FieldRow {
  document_id: string
  field_key: string
  value: string
  original_value: string | null
  source: string
  normalized_value: string | null
  page: number | null
  position: string | null
  confidence: number | null
  status: string | null
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

interface DecisionRow {
  id: string
  finding_id: string
  text: string
  kind: HumanDecision['kind']
  at: string
}

interface RunRow {
  id: string
  shipment_id: string
  trigger: ProcessingRun['trigger']
  status: ProcessingRun['status']
  started_at: string
  finished_at: string | null
  summary: string
  rule_version: string | null
  error: string | null
}

interface ActivityRow {
  shipment_id: string
  text: string
  at: string
}

export function shipmentRowToAggregate(db: Db, row: ShipmentRow): Shipment {
  const docs = db.all<DocumentRow>(
    'SELECT * FROM documents WHERE shipment_id = ? ORDER BY created_at ASC',
    row.id,
  )
  const docIds = docs.map((d) => d.id)
  const fieldsByDoc = new Map<
    string,
    { fields: Record<string, string>; original?: Record<string, string>; meta: Record<string, FieldMeta> }
  >()
  if (docIds.length) {
    const placeholders = docIds.map(() => '?').join(',')
    const fieldRows = db.all<FieldRow & { rowid: number }>(
      `SELECT document_id, field_key, value, original_value, source, normalized_value, page, position, confidence, status, rowid
         FROM extracted_fields WHERE document_id IN (${placeholders}) ORDER BY rowid ASC`,
      ...docIds,
    )
    for (const f of fieldRows) {
      let entry = fieldsByDoc.get(f.document_id)
      if (!entry) {
        entry = { fields: {}, meta: {} }
        fieldsByDoc.set(f.document_id, entry)
      }
      // 同一文档同一字段多次修正：最后写入的值生效；originalFields 取最早一次人工修正前的值
      if (f.source === 'manual' && f.original_value !== null && entry.original?.[f.field_key] === undefined) {
        entry.original = { ...(entry.original ?? {}), [f.field_key]: f.original_value }
      }
      const status = (f.status ?? 'extracted') as FieldMeta['status']
      // missing / unavailable 不进入 fields 值映射（值可能为空串）
      if (status !== 'missing' && status !== 'unavailable') {
        entry.fields[f.field_key] = f.value
      }
      entry.meta[f.field_key] = {
        status,
        confidence: f.confidence ?? 0,
        normalized: f.normalized_value ?? f.value,
        page: f.page ?? null,
        position: f.position ?? null,
        source: f.source,
      }
    }
  }

  const documents: ShipmentDocument[] = docs.map((d) => {
    const f = fieldsByDoc.get(d.id)
    const doc: ShipmentDocument = {
      id: d.id,
      shipmentId: d.shipment_id,
      fileName: d.file_name,
      docType: d.doc_type,
      format: d.format,
      status: d.status,
      size: d.size,
      createdAt: d.created_at,
      updatedAt: d.updated_at,
      isDemo: d.is_demo === 1,
      fields: f ? { ...f.fields } : {},
    }
    if (d.error) doc.error = d.error
    if (f?.original && Object.keys(f.original).length) doc.originalFields = { ...f.original }
    if (f && Object.keys(f.meta).length) doc.fieldMeta = { ...f.meta }
    if (d.parse_summary) doc.parseSummary = d.parse_summary
    return doc
  })

  const findingRows = db.all<FindingRow>(
    'SELECT * FROM findings WHERE shipment_id = ? ORDER BY created_at ASC',
    row.id,
  )
  const decisions = findingRows.length
    ? db.all<DecisionRow>(
        `SELECT * FROM human_decisions WHERE finding_id IN (${findingRows.map(() => '?').join(',')}) ORDER BY at DESC`,
        ...findingRows.map((f) => f.id),
      )
    : []
  const notesByFinding = new Map<string, HumanDecision[]>()
  for (const d of decisions) {
    const arr = notesByFinding.get(d.finding_id) ?? []
    arr.push({ id: d.id, text: d.text, at: d.at, kind: d.kind })
    notesByFinding.set(d.finding_id, arr)
  }

  const findings: Finding[] = findingRows.map((f) => ({
    id: f.id,
    shipmentId: f.shipment_id,
    title: f.title,
    kind: f.kind,
    ruleKey: f.rule_key ?? undefined,
    severity: f.severity,
    status: f.status,
    summary: f.summary,
    evidence: safeJsonArray(f.evidence),
    notes: notesByFinding.get(f.id) ?? [],
    createdAt: f.created_at,
  }))

  const runs: ProcessingRun[] = db
    .all<RunRow>('SELECT * FROM processing_runs WHERE shipment_id = ? ORDER BY started_at DESC', row.id)
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

  const activities: ActivityEvent[] = db
    .all<ActivityRow>('SELECT text, at FROM activities WHERE shipment_id = ? ORDER BY at DESC', row.id)
    .map((a) => ({ text: a.text, at: a.at }))

  const profileRows = db.all<{ field_key: string; value: string }>(
    'SELECT field_key, value FROM shipment_profiles WHERE shipment_id = ?',
    row.id,
  )
  const profile: Record<string, string> = {}
  for (const p of profileRows) profile[p.field_key] = p.value

  return {
    id: row.id,
    name: row.name,
    isDemo: row.is_demo === 1,
    origin: row.origin,
    destination: row.destination,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dirty: row.dirty === 1,
    documents,
    profile,
    findings,
    activities,
    runs,
  }
}

/** extracted_fields.evidence 为 JSON 数组字符串 */
function safeJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
