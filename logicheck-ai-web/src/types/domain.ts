/* ============================================================
   LogiCheck AI · 领域模型（对齐 PRD v2.0 第 4.3 节状态机 / 9.1 节实体）

   状态命名说明（PRD 业务状态 ↔ 前端展示状态）：
   - Shipment：PRD draft/processing/needs_review/checked/failed；
     前端额外保留 awaiting（待接入 AI）/ insufficient（证据不足）两个
     「展示态」，由文档与检查结果推导，不落库为独立业务状态。
   - Document：PRD uploading/uploaded/parsing/parsed/failed/replaced；
     前端 UI 文案：上传处理中 / 待真实 AI 解析 / 已解析 / 上传失败。
   - Finding：PRD open/reviewing/resolved/accepted_risk/not_applicable；
     前端 reviewed = 已记录人工决定但风险保留（≠ resolved）。
   ============================================================ */

export type ThemeMode = 'dark' | 'light'

/* ---------- Shipment ---------- */

/** 前端展示用货物状态（含两个 UI 推导态） */
export type ShipmentStatusCode =
  | 'draft' // 待上传
  | 'processing' // 预检进行中
  | 'awaiting' // 待接入 AI（UI 推导态）
  | 'needs_review' // 待处理异常
  | 'insufficient' // 证据不足（UI 推导态）
  | 'checked' // 检查完成（PRD checked）
  | 'failed' // 检查失败

export type ShipmentStatusFilter =
  | 'all'
  | 'draft'
  | 'needs_review'
  | 'awaiting'
  | 'checked'

export interface Shipment {
  id: string
  name: string
  isDemo: boolean
  origin: string
  destination: string
  createdAt: string
  updatedAt: string
  /** 资料已改变、尚未重新检查 */
  dirty: boolean
  documents: ShipmentDocument[]
  /** 统一货物信息（Shipment Profile），key 为字段名 */
  profile: Record<string, string>
  findings: Finding[]
  activities: ActivityEvent[]
  runs: ProcessingRun[]
}

/* ---------- Document ---------- */

export type DocumentFormat = 'pdf' | 'image' | 'edi' | 'txt' | 'unknown'

/** PRD 4.3：uploading / uploaded / parsing / parsed / failed / replaced */
export type DocumentStatus = 'uploading' | 'uploaded' | 'parsing' | 'parsed' | 'failed' | 'replaced'

export interface ShipmentDocument {
  id: string
  shipmentId: string
  fileName: string
  /** 单证类型（AI 识别结果；未接入前为「待 AI 识别」） */
  docType: string
  format: DocumentFormat
  status: DocumentStatus
  size: number
  createdAt: string
  updatedAt: string
  isDemo: boolean
  error?: string
  /** 提取字段（演示货物为模拟值；真实上传文件为空，等待后端 AI） */
  fields: Record<string, string>
  /** 原始提取值快照（人工修正前的值） */
  originalFields?: Record<string, string>
  /** 字段溯源信息（状态/置信度/标准化值/页码/位置/来源；后端聚合提供） */
  fieldMeta?: Record<string, FieldMeta>
  /** 解析摘要（可解释：提取了几个字段、单证类型、处理说明） */
  parseSummary?: string
  /** 字段提取来源：deterministic / ai / ocr+ai */
  extractionProvider?: string
  /** 产出本次字段的模型名（AI 链路才有） */
  extractionModel?: string
}

/** 字段级溯源信息（与后端 extracted_fields 对齐） */
export interface FieldMeta {
  status: 'extracted' | 'low_confidence' | 'missing' | 'unavailable' | 'unverified'
  confidence: number
  normalized: string
  page: number | null
  position: string | null
  source: string
}

/* ---------- 字段与证据 ---------- */

export interface ExtractedField {
  key: string
  value: string
  normalizedValue?: string
  confidence?: number
  flag?: 'low_confidence' | 'missing' | 'conflict'
  sourceDocumentId: string
  pageNo?: number
  bbox?: [number, number, number, number]
  excerpt?: string
  extractorVersion?: string
}

export interface FieldCandidate {
  key: string
  value: string
  sourceDocumentId: string
  sourceFileName: string
  pageNo?: number
  excerpt?: string
  confidence?: number
}

/* ---------- Finding（异常） ---------- */

export type FindingKind = 'cross' | 'rule' | 'extraction'

/** PRD：open / reviewing / resolved / accepted_risk / not_applicable */
export type FindingStatus = 'open' | 'reviewed' | 'resolved'

export type Severity = 'danger' | 'warn'

export interface Finding {
  id: string
  shipmentId: string
  title: string
  kind: FindingKind
  /** 关联合规规则 key */
  ruleKey?: RuleKey
  severity: Severity
  status: FindingStatus
  summary: string
  /** 证据单证 id 列表 */
  evidence: string[]
  notes: HumanDecision[]
  createdAt: string
}

export interface HumanDecision {
  id: string
  text: string
  at: string
  kind: 'review' | 'accept_risk' | 'resolve' | 'reopen'
}

/* ---------- 合规规则（PRD 7.1 Rule Contract） ---------- */

export type RuleKey = 'red' | 'rohs' | 'battery' | 'weee' | 'hs'

/** PRD 4.3 Check Item：passed / issue / warning / insufficient_evidence / not_applicable / error */
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
  /** 演示用途的详细说明与建议（与原型一致） */
  detail: string
  recommend: string
}

export interface CheckResult {
  ruleId: string
  status: CheckItemStatus
  reasoning: string
  evidenceRefs: string[]
  runId?: string
}

/* ---------- Run（处理记录） ---------- */

/** PRD 4.3：queued / running / succeeded / partially_succeeded / failed */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'partially_succeeded' | 'failed'

export interface ProcessingRun {
  id: string
  shipmentId: string
  trigger: 'upload' | 'recheck' | 'field_update' | 'manual'
  status: RunStatus
  startedAt: string
  finishedAt?: string
  summary: string
  ruleVersion?: string
  error?: string
}

/* ---------- 操作记录 ---------- */

export interface ActivityEvent {
  text: string
  at: string
}

/* ---------- 账号 ---------- */

export interface UserSession {
  email: string
  /** 演示身份标记：前端 Mock，非真实安全认证 */
  isDemoSession: boolean
  loginAt: string
}

/* ---------- 字段字典（原型 fieldLabels） ---------- */

export const FIELD_LABELS: Record<string, string> = {
  product: '产品名称',
  model: '产品型号',
  quantity: '货物数量',
  unit: '计量单位',
  cartons: '箱数',
  origin: '起运国',
  destination: '目的国',
  hs: '申报 HS 编码',
  gross: '毛重',
  battery: '电池属性',
}

/** 工作台「货物信息」卡片展示的字段顺序（与原型一致） */
export const PROFILE_DISPLAY_FIELDS = ['product', 'model', 'quantity', 'origin', 'destination', 'hs'] as const
