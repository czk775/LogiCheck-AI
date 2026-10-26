/* ============================================================
   ⚠️ MOCK SERVICE —— 前端演示专用，不是产品后端。

   边界声明（PRD §十二 / 用户要求）：
   - 本实现用 localStorage + IndexedDB 模拟服务端行为，
     仅用于前端 UI 隔离测试与演示路径走通。
   - 不伪造 AI 识别成功：真实上传的文件只保存 + 预览，
     不会生成提取字段、核验结论或合规结果。
   - 演示账号不是真实安全认证；不索取、不存储任何真实 AI API Key。
   - 后端就绪后：新增 RealApi implements LogiCheckApi，
     在 services/api/index.ts 切换导出即可，页面零改动。
   ============================================================ */

import type {
  ActivityEvent,
  ComplianceRule,
  FieldCandidate,
  Finding,
  ProcessingRun,
  Shipment,
  ShipmentDocument,
  UserSession,
} from '../../types/domain'
import type {
  AiStatus,
  CheckResultLite,
  CreateShipmentRequest,
  EvalReport,
  LogiCheckApi,
  LoginRequest,
  RecordDecisionRequest,
  RecheckReport,
  RegisterRequest,
  ResolveFindingRequest,
  UpdateFieldRequest,
  UploadDocumentsRequest,
  UploadRejection,
  UploadResult,
} from '../api/contracts'
import { safeLocalGet, safeLocalSet, safeSessionGet, safeSessionRemove, safeSessionSet } from '../storage/safeStorage'
import { idbDelete, idbGet, idbPut } from '../storage/idb'
import { DEMO_RULES, DEMO_SHIPMENT_ID, RULE_NAMES, createDemoShipment } from './demoData'

const DB_KEY_PREFIX = 'logicheck_hifi_v1_'
const SESSION_KEY = 'logicheck_account'
const DEMO_ACCOUNT = 'demo@logicheck.ai'
const MAX_FILE_SIZE = 15 * 1024 * 1024

const now = () => new Date().toISOString()
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`

function fileFormat(file: File): ShipmentDocument['format'] | null {
  const name = file.name.toLowerCase()
  if (/\.pdf$/.test(name)) return 'pdf'
  if (/\.(png|jpg|jpeg|webp)$/.test(name)) return 'image'
  if (/\.(edi|edifact|txt)$/.test(name)) return 'edi'
  return null
}

export class MockLogiCheckApi implements LogiCheckApi {
  private listeners = new Set<() => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  /** 上传状态机的演示推进延迟（与原型 1.1~2.0s 一致） */
  private processingDelay = () => 1100 + Math.random() * 900

  /* ---------- 订阅 ---------- */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private emit(): void {
    this.listeners.forEach((l) => l())
  }

  /* ---------- 账号（MOCK：本地演示身份） ---------- */

  private persistSession(session: UserSession): void {
    safeSessionSet(SESSION_KEY, JSON.stringify(session))
  }

  async login(req: LoginRequest): Promise<UserSession> {
    const email = req.email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('请填写有效的邮箱地址')
    if (req.password.length < 4) throw new Error('密码至少需要 4 位（演示环境，请勿使用真实密码）')
    const session: UserSession = { email, isDemoSession: false, loginAt: now() }
    this.persistSession(session)
    this.ensureSeeded(email)
    return session
  }

  async register(req: RegisterRequest): Promise<UserSession> {
    // MOCK：注册即登录；真实系统需邮件验证与服务端账号
    return this.login({ email: req.email, password: req.password })
  }

  async loginDemo(): Promise<UserSession> {
    const session: UserSession = { email: DEMO_ACCOUNT, isDemoSession: true, loginAt: now() }
    this.persistSession(session)
    this.ensureSeeded(DEMO_ACCOUNT)
    return session
  }

  async logout(): Promise<void> {
    safeSessionRemove(SESSION_KEY)
    this.timers.forEach(clearTimeout)
    this.timers.clear()
  }

  /** 内部同步读取（Mock 本地存储无网络延迟） */
  private getSessionSync(): UserSession | null {
    const raw = safeSessionGet(SESSION_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as UserSession
      if (!parsed?.email) return null
      return parsed
    } catch {
      return null
    }
  }

  async getSession(): Promise<UserSession | null> {
    return this.getSessionSync()
  }

  /* ---------- 持久化（按账号隔离） ---------- */

  private loadRaw(email: string): Shipment[] | null {
    const raw = safeLocalGet(DB_KEY_PREFIX + email)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Shipment[]
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private persist(email: string, shipments: Shipment[]): void {
    safeLocalSet(DB_KEY_PREFIX + email, JSON.stringify(shipments))
  }

  /** 与原型一致：账号首次进入时预置一票明确标注的演示货物 */
  private ensureSeeded(email: string): void {
    if (!this.loadRaw(email)) {
      this.persist(email, [createDemoShipment()])
    }
  }

  private requireAccount(): string {
    const session = this.getSessionSync()
    if (!session) throw new Error('登录状态已失效，请重新登录')
    return session.email
  }

  private mutate<T>(fn: (shipments: Shipment[]) => T): T {
    const email = this.requireAccount()
    const shipments = this.loadRaw(email) ?? []
    const result = fn(shipments)
    this.persist(email, shipments)
    this.emit()
    return result
  }

  private findShipment(shipments: Shipment[], id: string): Shipment {
    const s = shipments.find((x) => x.id === id)
    if (!s) throw new Error('货物不存在或已被删除')
    return s
  }

  /* ---------- 货物 ---------- */

  async listShipments(): Promise<Shipment[]> {
    const email = this.requireAccount()
    return this.loadRaw(email) ?? []
  }

  async getShipment(shipmentId: string): Promise<Shipment | null> {
    const email = this.requireAccount()
    return this.loadRaw(email)?.find((s) => s.id === shipmentId) ?? null
  }

  async createShipment(req: CreateShipmentRequest = {}): Promise<Shipment> {
    const name = req.name?.trim() || '新建货物 · 待识别'
    return this.mutate((shipments) => {
      const seq = Math.max(0, ...shipments.map((s) => Number((s.id.match(/\d+$/) || ['0'])[0])))
      let n = seq + 1
      let id = `SHP-2026-${String(n).padStart(3, '0')}`
      while (shipments.some((s) => s.id === id)) {
        n += 1
        id = `SHP-2026-${String(n).padStart(3, '0')}`
      }
      const t = now()
      const shipment: Shipment = {
        id,
        name,
        isDemo: false,
        origin: '待提取',
        destination: '待提取',
        createdAt: t,
        updatedAt: t,
        dirty: false,
        documents: [],
        profile: {},
        findings: [],
        activities: [{ text: '创建货物草稿', at: t }],
        runs: [],
      }
      shipments.unshift(shipment)
      return shipment
    })
  }

  async deleteShipment(shipmentId: string): Promise<void> {
    this.mutate((shipments) => {
      const ix = shipments.findIndex((s) => s.id === shipmentId)
      if (ix < 0) return
      const s = shipments[ix]
      s.documents.forEach((d) => {
        if (!d.isDemo) void idbDelete(d.id)
      })
      shipments.splice(ix, 1)
    })
  }

  /* ---------- 单证上传（DOC-01：真实文件保存 + 预览，不伪造解析） ---------- */

  async uploadDocuments(req: UploadDocumentsRequest): Promise<UploadResult> {
    const { shipmentId, files, replaceDocumentId } = req
    const accepted: ShipmentDocument[] = []
    const rejected: UploadRejection[] = []

    for (const file of files) {
      const format = fileFormat(file)
      if (!format) {
        rejected.push({ fileName: file.name, reason: 'unsupported_format', message: '不支持的文件类型' })
        continue
      }
      if (file.size > MAX_FILE_SIZE) {
        rejected.push({ fileName: file.name, reason: 'too_large', message: '超过 15MB 的单文件限制' })
        continue
      }
      if (!file.size) {
        rejected.push({ fileName: file.name, reason: 'empty_file', message: '空文件，请检查后重试' })
        continue
      }

      const t = now()
      const doc: ShipmentDocument = {
        id: uid('doc'),
        shipmentId,
        fileName: file.name,
        docType: '待 AI 识别',
        format,
        status: 'uploading',
        size: file.size,
        createdAt: t,
        updatedAt: t,
        isDemo: false,
        fields: {},
      }

      let saved = true
      try {
        await idbPut(doc.id, file)
      } catch {
        saved = false
        doc.status = 'failed'
        doc.error = '本地文件保存失败'
        rejected.push({ fileName: file.name, reason: 'save_failed', message: '本地文件保存失败' })
      }

      this.mutate((shipments) => {
        const s = this.findShipment(shipments, shipmentId)
        const old = replaceDocumentId ? s.documents.find((d) => d.id === replaceDocumentId) : null
        if (old) {
          const ix = s.documents.indexOf(old)
          s.documents.splice(ix, 1, doc)
          if (!old.isDemo) void idbDelete(old.id)
          s.activities.unshift({
            text: `替换单证 ${old.fileName} → ${file.name}；原提取字段已失效`,
            at: now(),
          })
          // 证据被替换：相关 resolved 异常重新打开（PRD RES-01：旧版保留审计）
          s.findings.forEach((f) => {
            if (f.evidence.includes(old.id)) {
              f.evidence = f.evidence.filter((i) => i !== old.id)
              f.status = 'open'
            }
          })
        } else {
          s.documents.push(doc)
          s.activities.unshift({ text: `上传单证 ${file.name}`, at: now() })
        }
        s.updatedAt = now()
        if (s.isDemo) s.dirty = true
      })

      accepted.push(doc)

      // 上传状态机演示推进：uploading → uploaded（待真实 AI 解析）。
      // 刻意不进入 parsed：没有真实 AI 就不产生提取结果（PRD 非目标）。
      if (saved) {
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          this.mutate((shipments) => {
            const s = shipments.find((x) => x.id === shipmentId)
            const current = s?.documents.find((d) => d.id === doc.id)
            if (current && current.status === 'uploading') {
              current.status = 'uploaded'
              current.updatedAt = now()
              s!.activities.unshift({
                text: `${doc.fileName} 已存入本地；真实 AI 提取尚未接入`,
                at: now(),
              })
              s!.updatedAt = now()
            }
          })
        }, this.processingDelay())
        this.timers.add(timer)
      }
    }

    return { accepted, rejected }
  }

  async deleteDocument(shipmentId: string, documentId: string): Promise<void> {
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, shipmentId)
      const ix = s.documents.findIndex((d) => d.id === documentId)
      if (ix < 0) return
      const d = s.documents[ix]
      if (!d.isDemo) void idbDelete(documentId)
      s.documents.splice(ix, 1)
      s.dirty = true
      s.findings
        .filter((f) => f.evidence.includes(documentId) && f.status === 'resolved')
        .forEach((f) => {
          f.status = 'open'
        })
      s.activities.unshift({ text: `移除单证 ${d.fileName}；相关检查等待重新执行`, at: now() })
      s.updatedAt = now()
    })
  }

  async retryDocument(shipmentId: string, documentId: string): Promise<ShipmentDocument> {
    return this.mutate((shipments) => {
      const s = this.findShipment(shipments, shipmentId)
      const d = s.documents.find((x) => x.id === documentId)
      if (!d) throw new Error('单证不存在')
      d.status = 'uploaded'
      d.error = undefined
      d.updatedAt = now()
      s.activities.unshift({ text: `重试 ${d.fileName}：已保留文件，等待真实解析服务接入`, at: now() })
      s.updatedAt = now()
      return d
    })
  }

  async getDocumentBlob(documentId: string): Promise<Blob | null> {
    try {
      return (await idbGet(documentId)) ?? null
    } catch {
      return null
    }
  }

  async getDocumentText(documentId: string): Promise<string | null> {
    const blob = await this.getDocumentBlob(documentId)
    if (!blob) return null
    try {
      return (await blob.text()).slice(0, 75000)
    } catch {
      return null
    }
  }

  /* ---------- 字段与证据 ---------- */

  async getFieldCandidates(shipmentId: string, fieldKey: string): Promise<FieldCandidate[]> {
    const s = await this.getShipment(shipmentId)
    if (!s) return []
    return s.documents
      .filter((d) => Object.hasOwn(d.fields, fieldKey))
      .map((d) => ({
        key: fieldKey,
        value: d.fields[fieldKey],
        sourceDocumentId: d.id,
        sourceFileName: d.fileName,
        confidence: d.isDemo ? undefined : undefined,
      }))
  }

  async updateExtractedField(req: UpdateFieldRequest): Promise<Shipment> {
    const { shipmentId, documentId, fieldKey, value } = req
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, shipmentId)
      const d = s.documents.find((x) => x.id === documentId)
      if (!d) throw new Error('找不到来源单证')
      const prev = d.fields[fieldKey]
      d.fields[fieldKey] = value
      d.originalFields = { ...(d.originalFields ?? d.fields), [fieldKey]: prev ?? '' }
      d.updatedAt = now()
      s.dirty = true
      if (fieldKey === 'quantity') {
        const a = s.documents.find((x) => x.id === 'doc-invoice')
        const b = s.documents.find((x) => x.id === 'doc-packing')
        s.profile.quantity =
          a?.fields.quantity && b?.fields.quantity
            ? Number(a.fields.quantity) === Number(b.fields.quantity)
              ? `${a.fields.quantity} ${a.fields.unit || 'PCS'}（待重新检查）`
              : '待确认（存在冲突）'
            : '证据不足'
      } else {
        s.profile[fieldKey] = value
      }
      s.activities.unshift({
        text: `人工修正提取值：${d.fileName} / ${fieldKey}：${prev ?? '未填写'} → ${value}`,
        at: now(),
      })
      s.updatedAt = now()
    })
    return (await this.getShipment(shipmentId))!
  }

  /* ---------- 人工复核 ---------- */

  async recordHumanDecision(req: RecordDecisionRequest): Promise<Finding> {
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, req.shipmentId)
      const f = s.findings.find((x) => x.id === req.findingId)
      if (!f) throw new Error('异常不存在')
      f.notes.unshift({ id: uid('note'), text: req.note, at: now(), kind: 'review' })
      f.status = 'reviewed'
      s.activities.unshift({ text: `人工复核「${f.title}」：${req.note}`, at: now() })
      s.updatedAt = now()
    })
    return (await this.getShipment(req.shipmentId))!.findings.find((f) => f.id === req.findingId)!
  }

  async resolveFinding(req: ResolveFindingRequest): Promise<Finding> {
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, req.shipmentId)
      const f = s.findings.find((x) => x.id === req.findingId)
      if (!f) throw new Error('异常不存在')
      if (f.status !== 'resolved') {
        f.status = 'resolved'
        s.activities.unshift({ text: `人工解决「${f.title}」：${req.note}`, at: now() })
      }
      // 已解决也允许补充说明（留痕追加，不重复改状态）
      f.notes.unshift({ id: uid('note'), text: req.note, at: now(), kind: 'resolve' })
      s.updatedAt = now()
    })
    return (await this.getShipment(req.shipmentId))!.findings.find((f) => f.id === req.findingId)!
  }

  async reopenFinding(req: ResolveFindingRequest): Promise<Finding> {
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, req.shipmentId)
      const f = s.findings.find((x) => x.id === req.findingId)
      if (!f) throw new Error('异常不存在')
      f.status = 'open'
      f.notes.unshift({ id: uid('note'), text: req.note, at: now(), kind: 'reopen' })
      s.activities.unshift({ text: `重新打开「${f.title}」：${req.note}`, at: now() })
      s.updatedAt = now()
    })
    return (await this.getShipment(req.shipmentId))!.findings.find((f) => f.id === req.findingId)!
  }

  async createRuleFollowUp(shipmentId: string, ruleKey: string): Promise<Finding> {
    this.mutate((shipments) => {
      const s = this.findShipment(shipments, shipmentId)
      const existing = s.findings.find((f) => f.ruleKey === ruleKey && f.status !== 'resolved')
      if (existing) return
      const t = now()
      s.findings.push({
        id: uid('f'),
        shipmentId,
        title: `${RULE_NAMES[ruleKey] ?? ruleKey} · 人工跟进`,
        kind: 'rule',
        ruleKey: ruleKey as Finding['ruleKey'],
        severity: 'warn',
        status: 'open',
        summary: '材料或规则适用性待进一步确认',
        evidence: [],
        notes: [],
        createdAt: t,
      })
      s.activities.unshift({ text: `记录人工跟进：${RULE_NAMES[ruleKey] ?? ruleKey}`, at: t })
      s.updatedAt = t
    })
    const s = (await this.getShipment(shipmentId))!
    return s.findings.find((f) => f.ruleKey === ruleKey && f.status !== 'resolved') ?? s.findings[s.findings.length - 1]
  }

  /* ---------- 重新检查 ---------- */

  async recheck(shipmentId: string): Promise<RecheckReport> {
    const s = await this.getShipment(shipmentId)
    if (!s) throw new Error('货物不存在')

    const run: ProcessingRun = {
      id: uid('run'),
      shipmentId,
      trigger: 'recheck',
      status: 'running',
      startedAt: now(),
      summary: '手动请求重新检查',
      ruleVersion: 'Demo v0.1',
    }

    // 非演示货物：没有真实 AI 与规则引擎，明确不生成结果（PRD：不把失败写成通过）
    if (!s.isDemo) {
      this.mutate((shipments) => {
        const target = this.findShipment(shipments, shipmentId)
        target.activities.unshift({ text: '手动请求重新检查', at: now() })
        target.updatedAt = now()
        target.runs.unshift({
          ...run,
          status: 'failed',
          finishedAt: now(),
          error: 'ai_not_connected',
          summary: '真实文件的 AI 解析和预检尚未接入，未生成检查结果',
        })
      })
      return {
        shipmentId,
        ran: false,
        reason: 'ai_not_connected',
        run: { ...run, status: 'failed', finishedAt: now() },
        summary: '真实文件的 AI 解析和预检尚未接入。已保留资料，未生成虚假检查结果。',
      }
    }

    // 演示货物：执行确定性的数量一致性核验（与原型一致）

    let summary = ''
    let succeeded = true

    this.mutate((shipments) => {
      const target = this.findShipment(shipments, shipmentId)
      const inv = target.documents.find((d) => d.id === 'doc-invoice')
      const pl = target.documents.find((d) => d.id === 'doc-packing')
      const finding = target.findings.find((x) => x.id === 'f-qty')

      if (finding && inv && pl && inv.fields.quantity && pl.fields.quantity) {
        if (Number(inv.fields.quantity) === Number(pl.fields.quantity) && inv.fields.unit === pl.fields.unit) {
          finding.status = 'resolved'
          finding.summary = `两份来源单证现均为 ${inv.fields.quantity} ${inv.fields.unit || 'PCS'}（演示数据）`
          target.profile.quantity = `${inv.fields.quantity} ${inv.fields.unit || 'PCS'}`
          target.activities.unshift({
            text: '重新检查通过：发票与装箱单数量一致，数量冲突已解决',
            at: now(),
          })
          summary = '重新检查通过：数量异常已解决（演示核验）'
        } else {
          finding.status = 'open'
          finding.summary = `Invoice：${inv.fields.quantity} ${inv.fields.unit || 'PCS'} · Packing List：${pl.fields.quantity} ${pl.fields.unit || 'PCS'}`
          target.profile.quantity = '待确认（存在冲突）'
          target.activities.unshift({ text: '重新检查：数量冲突仍存在', at: now() })
          summary = '重新检查完成：数量冲突仍存在'
        }
      } else if (finding) {
        finding.status = 'open'
        finding.summary = '缺少足够的已解析来源，暂无法执行数量一致性核验'
        target.profile.quantity = '证据不足'
        target.activities.unshift({ text: '重新检查：缺少数量比较的有效证据', at: now() })
        summary = '证据不足，不能判定数量一致'
        succeeded = false
      } else {
        summary = '没有需要重新检查的数量冲突项'
      }

      target.dirty = false
      target.updatedAt = now()
      target.runs.unshift({
        ...run,
        status: succeeded ? 'succeeded' : 'partially_succeeded',
        finishedAt: now(),
        summary,
      })
    })

    return { shipmentId, ran: true, summary }
  }

  /* ---------- 合规规则 ---------- */

  async getRules(): Promise<ComplianceRule[]> {
    return DEMO_RULES
  }

  /** 演示货物的规则预检概况（与原型 ruleList 一致；非演示货物无结果） */
  async getCheckResults(shipmentId: string): Promise<CheckResultLite[]> {
    const s = await this.getShipment(shipmentId)
    if (!s || !s.isDemo) return []
    const rohsDocs = s.documents.filter((d) => d.fileName.toLowerCase().includes('rohs')).map((d) => d.id)
    return [
      {
        ruleKey: 'red',
        status: 'insufficient_evidence',
        label: '待补充证据',
        tone: 'danger',
        evidenceRefs: [],
      },
      {
        ruleKey: 'rohs',
        status: 'warning',
        label: '材料已提供',
        tone: 'good',
        evidenceRefs: rohsDocs,
      },
      { ruleKey: 'battery', status: 'insufficient_evidence', label: '证据不足', tone: 'warn', evidenceRefs: [] },
      { ruleKey: 'weee', status: 'not_applicable', label: '适用性待确认', tone: 'neutral', evidenceRefs: [] },
      { ruleKey: 'hs', status: 'warning', label: '需人工核查', tone: 'warn', evidenceRefs: [] },
    ]
  }

  /* ---------- AI 能力状态（第五阶段）---------- */

  /**
   * Mock 模式如实返回「未接通」。
   * 演示模式全部使用预置数据，不经过任何大模型 —— 绝不能在这里
   * 伪造一个「AI 已连接」让用户以为演示结果来自真实模型。
   */
  async getAiStatus(): Promise<AiStatus> {
    return {
      configured: false,
      extraction: 'deterministic',
      ocr: 'none',
      reason: '当前为前端演示模式，未连接真实大模型；演示结果来自预置数据',
    }
  }

  /* ---------- AI 评估（Eval）---------- */

  /**
   * Mock 模式如实返回「无评估结果」：
   * 评估必须走真实大模型，演示模式不伪造任何准确率。
   */
  async getAiEval(): Promise<EvalReport | null> {
    return null
  }

  /** Mock 模式明确拒绝运行评估（不伪造结果） */
  async runAiEval(): Promise<EvalReport> {
    throw new Error('当前为前端演示模式（Mock）：未连接真实大模型，无法运行真实评估')
  }

  /* ---------- 处理记录 ---------- */

  async getRuns(shipmentId: string): Promise<ProcessingRun[]> {
    const s = await this.getShipment(shipmentId)
    return s?.runs ?? []
  }

  async getActivities(shipmentId: string): Promise<ActivityEvent[]> {
    const s = await this.getShipment(shipmentId)
    return s?.activities ?? []
  }
}

/** 规则中文名（规则抽屉 / 记录用） */
export function ruleName(key: string): string {
  return RULE_NAMES[key] ?? key
}

export const DEMO_ACCOUNT_EMAIL = DEMO_ACCOUNT
export { DEMO_SHIPMENT_ID }
