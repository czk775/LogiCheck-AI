/* ============================================================
   服务端领域类型 —— 与前端 src/types/domain.ts 严格对应。
   前端 RealApi 直接消费这些结构的 JSON，字段零转换。
   ============================================================ */

export type DocumentFormat = 'pdf' | 'image' | 'edi' | 'txt' | 'unknown'

/** PRD 4.3：uploading / uploaded / parsing / parsed / failed / replaced */
export type DocumentStatus = 'uploading' | 'uploaded' | 'parsing' | 'parsed' | 'failed' | 'replaced'

export interface ShipmentDocument {
  id: string
  shipmentId: string
  fileName: string
  docType: string
  format: DocumentFormat
  status: DocumentStatus
  size: number
  createdAt: string
  updatedAt: string
  isDemo: boolean
  error?: string
  fields: Record<string, string>
  originalFields?: Record<string, string>
  /** 阶段二：字段元数据（置信度 / 状态 / 来源位置），按 fieldKey 索引 */
  fieldMeta?: Record<string, FieldMeta>
  /** 阶段二：解析产物摘要（可解释） */
  parseSummary?: string
}

/** 提取字段的溯源元数据（阶段二 Schema） */
export interface FieldMeta {
  /** extracted / low_confidence / missing / unavailable */
  status: 'extracted' | 'low_confidence' | 'missing' | 'unavailable'
  confidence: number
  normalized: string
  page: number | null
  position: string | null
  /** 提取来源：deterministic / ai / manual / demo */
  source: string
}

export interface HumanDecision {
  id: string
  text: string
  at: string
  kind: 'review' | 'accept_risk' | 'resolve'
}

export type FindingKind = 'cross' | 'rule' | 'extraction'
export type FindingStatus = 'open' | 'reviewed' | 'resolved'
export type Severity = 'danger' | 'warn'

export interface Finding {
  id: string
  shipmentId: string
  title: string
  kind: FindingKind
  ruleKey?: string
  severity: Severity
  status: FindingStatus
  summary: string
  evidence: string[]
  notes: HumanDecision[]
  createdAt: string
}

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed'

export interface ProcessingRun {
  id: string
  shipmentId: string
  trigger: 'upload' | 'parse' | 'check' | 'recheck' | 'field_update' | 'manual'
  status: RunStatus
  startedAt: string
  finishedAt?: string
  summary: string
  ruleVersion?: string
  error?: string
}

export interface ActivityEvent {
  text: string
  at: string
}

export interface Shipment {
  id: string
  name: string
  isDemo: boolean
  origin: string
  destination: string
  createdAt: string
  updatedAt: string
  dirty: boolean
  documents: ShipmentDocument[]
  profile: Record<string, string>
  findings: Finding[]
  activities: ActivityEvent[]
  runs: ProcessingRun[]
}

export interface UserSession {
  email: string
  isDemoSession: boolean
  loginAt: string
}

/* ---------- 合规规则（PRD 7.1 Rule Contract，与前端一致） ---------- */

export type RuleKey = 'red' | 'rohs' | 'battery' | 'weee' | 'hs'

export type CheckItemStatus =
  | 'passed'
  | 'issue'
  | 'warning'
  | 'insufficient_evidence'
  | 'not_applicable'
  | 'error'

export interface ComplianceRule {
  ruleId: string
  key: RuleKey
  title: string
  category: string
  jurisdiction: string
  productScope: string
  actorScope: string
  effectiveFrom: string
  effectiveTo?: string
  trigger: string
  requiredEvidence: string[]
  checkLogic: string
  severity: Severity
  sourceTitle: string
  sourceURL: string
  sourceVersion: string
  accessedAt: string
  ruleVersion: string
  detail: string
  recommend: string
}

export interface CheckResultLite {
  ruleKey: string
  status: CheckItemStatus
  label: string
  tone: 'danger' | 'warn' | 'good' | 'info' | 'neutral'
  evidenceRefs: string[]
  /** 判定依据（阶段三：核验引擎写入；演示货物为空） */
  reasoning?: string
}

export interface FieldCandidate {
  key: string
  value: string
  sourceDocumentId: string
  sourceFileName: string
  confidence?: number
}

export interface UploadRejection {
  fileName: string
  reason: 'unsupported_format' | 'too_large' | 'empty_file' | 'save_failed'
  message: string
}

export interface UploadResult {
  accepted: ShipmentDocument[]
  rejected: UploadRejection[]
}

export interface RecheckReport {
  shipmentId: string
  ran: boolean
  /** 未执行的原因：AI 未接入 / 无已解析单证 / 无变化 */
  reason?: 'ai_not_connected' | 'no_documents' | 'no_change'
  run?: ProcessingRun
  summary: string
}
