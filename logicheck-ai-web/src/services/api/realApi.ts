/* ============================================================
   RealApi —— 真实后端 HTTP 客户端（第一阶段：认证 / 货物 / 单证 / 演示数据）。

   对接约定：
   - 会话走 httpOnly Cookie（logicheck_session），credentials: 'include'，
     令牌不落 localStorage，避免 XSS 窃取。
   - 所有请求经 Vite dev server 代理 /api → http://127.0.0.1:4000（同源，无 CORS 问题）。
   - 非 2xx 响应统一转成 Error(message)，页面 toast 直接展示。
   - subscribe 为 no-op：后端无推送通道（后续可换 SSE/WebSocket）；
     每次业务操作后 Store 已主动重新同步。
   ============================================================ */

import type {
  ActivityEvent,
  ComplianceRule,
  FieldCandidate,
  Finding,
  ProcessingRun,
  RuleKey,
  Shipment,
  ShipmentDocument,
  UserSession,
} from '../../types/domain'
import type {
  CheckResultLite,
  CreateShipmentRequest,
  LoginRequest,
  LogiCheckApi,
  RecordDecisionRequest,
  RecheckReport,
  RegisterRequest,
  ResolveFindingRequest,
  UpdateFieldRequest,
  UploadDocumentsRequest,
  UploadResult,
} from './contracts'

const BASE = '/api'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // 注意：无 body 的请求不能带 Content-Type: application/json，
  // 否则 Fastify 的 JSON 解析器会以「空 body」为由拒绝（400）。
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  let res: Response
  try {
    res = await fetch(BASE + path, {
      ...init,
      credentials: 'include',
      headers,
    })
  } catch {
    throw new Error('网络异常：无法连接后端服务，请确认服务端已启动')
  }
  if (!res.ok) {
    let message = `请求失败（${res.status}）`
    try {
      const body = (await res.json()) as { message?: string }
      if (body.message) message = body.message
    } catch {
      /* 保留默认文案 */
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export class RealApi implements LogiCheckApi {
  /* ---------- 账号 ---------- */

  async login(req: LoginRequest): Promise<UserSession> {
    const data = await request<{ session: UserSession }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(req),
    })
    return data.session
  }

  async register(req: RegisterRequest): Promise<UserSession> {
    const data = await request<{ session: UserSession }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(req),
    })
    return data.session
  }

  async loginDemo(): Promise<UserSession> {
    const data = await request<{ session: UserSession }>('/auth/demo', { method: 'POST' })
    return data.session
  }

  async logout(): Promise<void> {
    await request<void>('/auth/logout', { method: 'POST' })
  }

  async getSession(): Promise<UserSession | null> {
    const data = await request<{ session: UserSession | null }>('/auth/session')
    return data.session
  }

  /** 找回密码：申请重置（邮件写入服务端本地发件箱 / 配置 SMTP 后真实发送） */
  async requestPasswordReset(email: string): Promise<{ ok: true; message: string }> {
    return request('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) })
  }

  /** 找回密码：使用令牌设置新密码 */
  async resetPassword(token: string, newPassword: string): Promise<UserSession> {
    const data = await request<{ session: UserSession }>('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    })
    return data.session
  }

  /* ---------- 货物 ---------- */

  async listShipments(): Promise<Shipment[]> {
    const data = await request<{ shipments: Shipment[] }>('/shipments')
    return data.shipments
  }

  async getShipment(shipmentId: string): Promise<Shipment | null> {
    try {
      const data = await request<{ shipment: Shipment }>(`/shipments/${encodeURIComponent(shipmentId)}`)
      return data.shipment
    } catch {
      return null
    }
  }

  async createShipment(req: CreateShipmentRequest = {}): Promise<Shipment> {
    const data = await request<{ shipment: Shipment }>('/shipments', {
      method: 'POST',
      body: JSON.stringify(req),
    })
    return data.shipment
  }

  async deleteShipment(shipmentId: string): Promise<void> {
    await request<void>(`/shipments/${encodeURIComponent(shipmentId)}`, { method: 'DELETE' })
  }

  /* ---------- 单证 ---------- */

  async uploadDocuments(req: UploadDocumentsRequest): Promise<UploadResult> {
    const form = new FormData()
    for (const file of req.files) form.append('files', file)
    if (req.replaceDocumentId) form.append('replaceDocumentId', req.replaceDocumentId)
    return request<UploadResult>(`/shipments/${encodeURIComponent(req.shipmentId)}/documents`, {
      method: 'POST',
      body: form,
    })
  }

  async deleteDocument(_shipmentId: string, documentId: string): Promise<void> {
    await request<void>(`/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
  }

  async retryDocument(_shipmentId: string, documentId: string): Promise<ShipmentDocument> {
    const data = await request<{ document: ShipmentDocument }>(
      `/documents/${encodeURIComponent(documentId)}/retry`,
      { method: 'POST' },
    )
    return data.document
  }

  async getDocumentBlob(documentId: string): Promise<Blob | null> {
    try {
      const res = await fetch(`${BASE}/documents/${encodeURIComponent(documentId)}/content`, {
        credentials: 'include',
      })
      if (!res.ok) return null
      return await res.blob()
    } catch {
      return null
    }
  }

  async getDocumentText(documentId: string): Promise<string | null> {
    try {
      const res = await fetch(`${BASE}/documents/${encodeURIComponent(documentId)}/content`, {
        credentials: 'include',
      })
      if (!res.ok) return null
      return (await res.text()).slice(0, 75000)
    } catch {
      return null
    }
  }

  /* ---------- 字段与证据 ---------- */

  async getFieldCandidates(shipmentId: string, fieldKey: string): Promise<FieldCandidate[]> {
    const data = await request<{ candidates: FieldCandidate[] }>(
      `/shipments/${encodeURIComponent(shipmentId)}/fields/${encodeURIComponent(fieldKey)}/candidates`,
    )
    return data.candidates
  }

  async updateExtractedField(req: UpdateFieldRequest): Promise<Shipment> {
    const data = await request<{ shipment: Shipment }>(
      `/shipments/${encodeURIComponent(req.shipmentId)}/fields`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          documentId: req.documentId,
          fieldKey: req.fieldKey,
          value: req.value,
        }),
      },
    )
    return data.shipment
  }

  /* ---------- 异常与人工复核 ---------- */

  async recordHumanDecision(req: RecordDecisionRequest): Promise<Finding> {
    const data = await request<{ finding: Finding }>(`/findings/${encodeURIComponent(req.findingId)}/decisions`, {
      method: 'POST',
      body: JSON.stringify({ note: req.note }),
    })
    return data.finding
  }

  async resolveFinding(req: ResolveFindingRequest): Promise<Finding> {
    const data = await request<{ finding: Finding }>(`/findings/${encodeURIComponent(req.findingId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note: req.note }),
    })
    return data.finding
  }

  async reopenFinding(req: ResolveFindingRequest): Promise<Finding> {
    const data = await request<{ finding: Finding }>(`/findings/${encodeURIComponent(req.findingId)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ note: req.note }),
    })
    return data.finding
  }

  async createRuleFollowUp(shipmentId: string, ruleKey: RuleKey): Promise<Finding> {
    const data = await request<{ finding: Finding }>(
      `/shipments/${encodeURIComponent(shipmentId)}/rules/${encodeURIComponent(ruleKey)}/follow-up`,
      { method: 'POST' },
    )
    return data.finding
  }

  /* ---------- 重新检查 ---------- */

  async recheck(shipmentId: string): Promise<RecheckReport> {
    const data = await request<{ report: RecheckReport }>(`/shipments/${encodeURIComponent(shipmentId)}/recheck`, {
      method: 'POST',
    })
    return data.report
  }

  /* ---------- 合规规则 ---------- */

  async getRules(): Promise<ComplianceRule[]> {
    const data = await request<{ rules: ComplianceRule[] }>('/rules')
    return data.rules
  }

  async getCheckResults(shipmentId: string): Promise<CheckResultLite[]> {
    const data = await request<{ results: CheckResultLite[] }>(
      `/shipments/${encodeURIComponent(shipmentId)}/check-results`,
    )
    return data.results
  }

  /* ---------- 处理记录 ---------- */

  async getRuns(shipmentId: string): Promise<ProcessingRun[]> {
    const data = await request<{ runs: ProcessingRun[] }>(`/shipments/${encodeURIComponent(shipmentId)}/runs`)
    return data.runs
  }

  async getActivities(shipmentId: string): Promise<ActivityEvent[]> {
    const data = await request<{ activities: ActivityEvent[] }>(
      `/shipments/${encodeURIComponent(shipmentId)}/activities`,
    )
    return data.activities
  }

  /* ---------- 订阅（后端无推送，no-op） ---------- */

  subscribe(_listener: () => void): () => void {
    return () => {}
  }
}

/** 供找回密码 UI 使用（不在 LogiCheckApi 契约内，前端直连） */
export type PasswordResetResult = { ok: true; message: string }
