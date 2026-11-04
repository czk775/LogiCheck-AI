/* ============================================================
   前端 ↔ 后端 API Contract（PRD v2.0 §9.2）

   本文件只定义「前端需要什么」，不包含任何实现。
   当前由 Mock 服务实现（见 services/mock/mockApi.ts），
   后端就绪后仅需新增一个实现类并在 services/api/index.ts 中切换，
   页面与业务逻辑零改动。

   标注说明：
   - [P0]  上线必需，Mock 已模拟行为
   - [P0*] 上线必需，但依赖真实 AI/后端，Mock 明确不伪造结果
   ============================================================ */

import type {
  ActivityEvent,
  CheckItemStatus,
  ComplianceRule,
  FieldCandidate,
  Finding,
  ProcessingRun,
  Shipment,
  ShipmentDocument,
  UserSession,
} from '../../types/domain'

/* ---------- 请求 / 响应 DTO ---------- */

export interface LoginRequest {
  email: string
  password: string
}

export interface RegisterRequest {
  email: string
  password: string
}

/** [P0*] 演示一键入口：创建/进入明确标注的演示账号（非真实认证） */
export interface DemoLoginResult {
  session: UserSession
}

export interface CreateShipmentRequest {
  name?: string
}

export interface UploadDocumentsRequest {
  shipmentId: string
  files: File[]
  /** 替换模式：替换指定单证（保留审计，旧版失效） */
  replaceDocumentId?: string
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

export interface UpdateFieldRequest {
  shipmentId: string
  documentId: string
  fieldKey: string
  value: string
}

export interface RecordDecisionRequest {
  shipmentId: string
  findingId: string
  note: string
}

/** 人工解决 / 重新打开异常（阶段四闭环） */
export interface ResolveFindingRequest {
  shipmentId: string
  findingId: string
  note: string
}

export interface RecheckReport {
  shipmentId: string
  ran: boolean
  /** false 时的原因（如后端未接入 / 无已解析单证） */
  reason?: 'ai_not_connected' | 'no_documents' | 'no_change'
  run?: ProcessingRun
  summary: string
}

export interface ApiErrorShape {
  code: string
  message: string
}

/* ---------- AI 能力状态（第五阶段）---------- */

/**
 * 单次 AI 调用记录（可观测性；不含提示词 / 响应内容 / 密钥）
 */
export interface AiCallRecord {
  /** 调用完成时间（ISO 8601） */
  at: string
  /** 实际使用的模型名 */
  model: string
  /** 任务类型：extraction（字段提取）/ ocr（视觉识别）/ eval（评估） */
  task: string
  /** 耗时（毫秒，含内部重试） */
  durationMs: number
  status: 'ok' | 'error'
  /** 失败时的稳定错误码 */
  errorCode?: string
  promptTokens: number
  completionTokens: number
}

/**
 * AI 能力状态。
 *
 * 诚实边界：
 * - 只描述「当前 AI 能力是否可用、用的哪个模型」，不含任何密钥
 * - 不含限流配额（限流 ≠ 免费额度余额，两者不可混称）
 */
export interface AiStatus {
  /** 是否已接通真实 AI（Key + 模型名齐备） */
  configured: boolean
  /** 提取来源标识：ai / deterministic */
  extraction: string
  /** OCR 来源标识：ocr / none */
  ocr: string
  /** 接入地址（不含任何凭据） */
  baseUrl?: string
  /** 文本提取模型名 */
  model?: string
  /** 视觉/OCR 模型名 */
  visionModel?: string | null
  /** 未接通时的原因说明 */
  reason?: string
  /**
   * 本进程累计用量（额度护栏 + 可观测性观测口）。
   * 注意：这是「已用掉多少」，不是「还剩多少」——剩余额度需看服务商控制台。
   */
  usage?: AiUsageSnapshot
}

/** 进程内 AI 用量快照（真实计量，非估算） */
export interface AiUsageSnapshot {
  calls: number
  successCalls: number
  failedCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  limitTokens: number
  exhausted: boolean
  /** 平均耗时（毫秒） */
  avgDurationMs: number
  /** 最近调用记录（按时间倒序，最多 20 条） */
  recent: AiCallRecord[]
}

/* ---------- AI 评估（Eval）---------- */

export interface EvalFieldItem {
  file: string
  field: string
  expected: string
  actual: string
  ok: boolean
}

export interface EvalConflictCase {
  name: string
  files: string[]
  expected: 'consistent' | 'conflict'
  actual: string
  ok: boolean
  summary: string
}

export interface EvalEvidenceItem {
  file: string
  field: string
  quote: string
  page: number | null
  ok: boolean
}

export interface EvalReport {
  status: 'running' | 'done' | 'error'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  error?: string
  /** 参与评估的样本总数（字段项 + 冲突用例 + 证据项） */
  samples: number
  extraction: { total: number; matched: number; accuracy: number; items: EvalFieldItem[] }
  conflict: { total: number; passed: number; cases: EvalConflictCase[] }
  evidence: { total: number; valid: number; rate: number; items: EvalEvidenceItem[] }
}

/* ---------- 服务接口 ---------- */

export interface LogiCheckApi {
  /* 账号（AUTH-01）—— Mock 为本地演示身份，非真实安全认证 */
  login(req: LoginRequest): Promise<UserSession>
  register(req: RegisterRequest): Promise<UserSession>
  /** [P0*] 演示账号一键进入 */
  loginDemo(): Promise<UserSession>
  logout(): Promise<void>
  /** 当前会话（Mock 同步读本地；RealApi 走 HTTP 异步） */
  getSession(): Promise<UserSession | null>
  /** 找回密码（可选能力：仅真实后端实现；Mock 模式下找回密码弹窗展示诚实说明） */
  requestPasswordReset?(email: string): Promise<{ ok: true; message: string }>
  resetPassword?(token: string, newPassword: string): Promise<UserSession>

  /* 货物（SHIP-01） */
  listShipments(): Promise<Shipment[]>
  getShipment(shipmentId: string): Promise<Shipment | null>
  createShipment(req?: CreateShipmentRequest): Promise<Shipment>
  deleteShipment(shipmentId: string): Promise<void>

  /* 单证（DOC-01/02） */
  uploadDocuments(req: UploadDocumentsRequest): Promise<UploadResult>
  deleteDocument(shipmentId: string, documentId: string): Promise<void>
  retryDocument(shipmentId: string, documentId: string): Promise<ShipmentDocument>
  /** 读取原始文件（预览用；后端就绪后为鉴权下载） */
  getDocumentBlob(documentId: string): Promise<Blob | null>
  getDocumentText(documentId: string): Promise<string | null>

  /* 字段与证据（AI-02 / EV-01） */
  getFieldCandidates(shipmentId: string, fieldKey: string): Promise<FieldCandidate[]>
  updateExtractedField(req: UpdateFieldRequest): Promise<Shipment>

  /* 异常与人工复核（EXC-01 / RES-01） */
  recordHumanDecision(req: RecordDecisionRequest): Promise<Finding>
  /** 人工解决异常：必须附处理说明，留痕不可删除 */
  resolveFinding(req: ResolveFindingRequest): Promise<Finding>
  /** 重新打开异常（人工发现此前解决有误） */
  reopenFinding(req: ResolveFindingRequest): Promise<Finding>
  /** 规则抽屉中「记录人工意见」：无对应异常时创建人工跟进项（仅演示货物有检查结果） */
  createRuleFollowUp(shipmentId: string, ruleKey: string): Promise<Finding>

  /* 重新检查（RES-01） */
  recheck(shipmentId: string): Promise<RecheckReport>

  /* 合规规则（CMP-01） */
  getRules(): Promise<ComplianceRule[]>
  getCheckResults(shipmentId: string): Promise<CheckResultLite[]>

  /* AI 能力状态（第五阶段）：不含密钥、不含限流配额 */
  getAiStatus(): Promise<AiStatus>

  /* AI 评估（Eval）：读取最近一次结果；触发一次真实评估 */
  getAiEval(): Promise<EvalReport | null>
  runAiEval(): Promise<EvalReport>

  /* 处理记录（STORE-01） */
  getRuns(shipmentId: string): Promise<ProcessingRun[]>
  getActivities(shipmentId: string): Promise<ActivityEvent[]>

  /* 数据变更订阅（Mock 用于推进上传状态机；后端可改为 WebSocket/SSE） */
  subscribe(listener: () => void): () => void
}

export interface CheckResultLite {
  ruleKey: string
  status: CheckItemStatus
  /** 工作台规则列表展示文案 */
  label: string
  /** 徽章色调 */
  tone: 'danger' | 'warn' | 'good' | 'info' | 'neutral'
  evidenceRefs: string[]
  /** 判定依据（真实模式由核验引擎返回；演示模式无） */
  reasoning?: string
}
