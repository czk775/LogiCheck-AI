import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { api, apiMode } from '../services/api'
import type { AiStatus } from '../services/api/contracts'
import type { RuleKey, Shipment, UserSession } from '../types/domain'
import { useToast } from '../components/Toast'

const REAL = apiMode === 'real'

/* ============================================================
   全局 Store：账号 / 货物数据 / 页面 UI 状态。
   数据唯一来源是 API 服务层（Mock 或真实后端）；每次变更后重新同步。
   ============================================================ */

export type UiModal =
  | { type: 'guide' }
  | { type: 'about' }
  | { type: 'rule-help' }
  | { type: 'recheck-info' }
  | { type: 'forgot-password' }
  | { type: 'delete-shipment'; shipmentId: string }
  | { type: 'delete-document'; documentId: string }
  | { type: 'field-edit'; fieldKey: string; sourceDocumentId?: string }
  | { type: 'review'; findingId: string }
  | { type: 'resolve'; findingId: string }
  | { type: 'reopen'; findingId: string }

export type UiDrawer =
  | { type: 'issue'; findingId: string }
  | { type: 'rule'; ruleKey: RuleKey }
  | { type: 'document'; documentId: string }
  | { type: 'profile' }
  | { type: 'activity' }

export type FileMode = { kind: 'add' } | { kind: 'replace'; documentId: string }

interface AppState {
  account: UserSession | null
  /** Store 是否已完成首次数据水合（刷新深链接前必须为 true 才能做存在性判断） */
  hydrated: boolean
  shipments: Shipment[]
  activeShipmentId: string | null
  search: string
  filter: 'all' | 'draft' | 'needs_review' | 'awaiting' | 'checked'
  openMenuShipmentId: string | null
  modal: UiModal | null
  drawer: UiDrawer | null
  selectedEvidenceId: string | null
  fileMode: FileMode
  /** AI 能力状态（第五阶段）；null = 尚未读到 */
  aiStatus: AiStatus | null
}

type Action =
  | { type: 'session/set'; account: UserSession | null }
  | { type: 'shipments/set'; shipments: Shipment[] }
  | { type: 'ui/hydrated' }
  | { type: 'ui/search'; value: string }
  | { type: 'ui/filter'; value: AppState['filter'] }
  | { type: 'ui/menu'; id: string | null }
  | { type: 'ui/modal'; modal: UiModal | null }
  | { type: 'ui/drawer'; drawer: UiDrawer | null }
  | { type: 'ui/selectedEvidence'; id: string | null }
  | { type: 'ui/fileMode'; mode: FileMode }
  | { type: 'ui/activeShipment'; id: string | null }
  | { type: 'ai/status'; status: AiStatus | null }

const initialState: AppState = {
  account: null,
  hydrated: false,
  shipments: [],
  activeShipmentId: null,
  search: '',
  filter: 'all',
  openMenuShipmentId: null,
  modal: null,
  drawer: null,
  selectedEvidenceId: null,
  fileMode: { kind: 'add' },
  aiStatus: null,
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'session/set':
      return { ...state, account: action.account }
    case 'shipments/set':
      return { ...state, shipments: action.shipments }
    case 'ui/hydrated':
      return { ...state, hydrated: true }
    case 'ui/search':
      return { ...state, search: action.value }
    case 'ui/filter':
      return { ...state, filter: action.value }
    case 'ui/menu':
      return { ...state, openMenuShipmentId: action.id }
    case 'ui/modal':
      return { ...state, modal: action.modal }
    case 'ui/drawer':
      return { ...state, drawer: action.drawer, selectedEvidenceId: null }
    case 'ui/selectedEvidence':
      return { ...state, selectedEvidenceId: action.id }
    case 'ui/fileMode':
      return { ...state, fileMode: action.mode }
    case 'ui/activeShipment':
      return { ...state, activeShipmentId: action.id }
    case 'ai/status':
      return { ...state, aiStatus: action.status }
    default:
      return state
  }
}

export interface AppStoreValue {
  state: AppState
  activeShipment: Shipment | null
  /* 账号 */
  login: (email: string, password: string) => Promise<boolean>
  register: (email: string, password: string) => Promise<boolean>
  loginDemo: () => Promise<void>
  logout: () => Promise<void>
  /* 货物 */
  createShipment: () => Promise<Shipment | null>
  deleteShipment: (id: string) => Promise<void>
  openShipment: (id: string) => void
  /* 单证 */
  uploadFiles: (files: File[]) => Promise<void>
  deleteDocument: (documentId: string) => Promise<void>
  retryDocument: (documentId: string) => Promise<void>
  /* 异常 / 字段 / 复核 / 重检 */
  updateField: (fieldKey: string, sourceDocumentId: string, value: string) => Promise<void>
  recordReview: (findingId: string, note: string) => Promise<void>
  /** 人工解决异常（必须附处理说明） */
  resolveFinding: (findingId: string, note: string) => Promise<void>
  /** 重新打开异常 */
  reopenFinding: (findingId: string, note: string) => Promise<void>
  followUpRule: (ruleKey: RuleKey) => Promise<void>
  recheck: () => Promise<void>
  /* UI */
  setSearch: (value: string) => void
  setFilter: (value: AppState['filter']) => void
  toggleMenu: (id: string) => void
  openModal: (modal: UiModal) => void
  closeModal: () => void
  openDrawer: (drawer: UiDrawer) => void
  closeDrawer: () => void
  selectEvidence: (id: string) => void
  setFileMode: (mode: FileMode) => void
  refresh: () => Promise<void>
  /** 重新读取 AI 能力状态（配置变更后或手动刷新用） */
  refreshAiStatus: () => Promise<void>
}

const StoreContext = createContext<AppStoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { push } = useToast()
  const stateRef = useRef(state)
  stateRef.current = state

  const syncShipments = useCallback(async () => {
    const session = await api.getSession()
    if (!session) {
      dispatch({ type: 'session/set', account: null })
      dispatch({ type: 'shipments/set', shipments: [] })
      return
    }
    dispatch({ type: 'session/set', account: session })
    const shipments = await api.listShipments()
    dispatch({ type: 'shipments/set', shipments })
  }, [])

  /* 读取 AI 能力状态（第五阶段）；读不到时保持 null，UI 显示「状态未知」 */
  const syncAiStatus = useCallback(async () => {
    try {
      const status = await api.getAiStatus()
      dispatch({ type: 'ai/status', status })
    } catch {
      dispatch({ type: 'ai/status', status: null })
    }
  }, [])

  /* 启动时恢复会话 + 订阅 Mock 数据变更（上传状态机推进等） */
  useEffect(() => {
    let alive = true
    void syncShipments().finally(() => {
      if (alive) dispatch({ type: 'ui/hydrated' })
    })
    void syncAiStatus()
    const unsubscribe = api.subscribe(() => {
      void syncShipments()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [syncShipments, syncAiStatus])

  const activeShipment = useMemo(
    () => state.shipments.find((s) => s.id === state.activeShipmentId) ?? null,
    [state.shipments, state.activeShipmentId],
  )

  /**
   * 解析进行中 → 轮询刷新。
   *
   * 真实 AI 解析要跑几秒到几十秒（大模型 + 视觉 OCR），
   * 而后端是异步队列，前端不主动轮询就会一直停在「解析中」。
   * 一旦所有单证都到达终态（parsed / failed），自动停止轮询。
   */
  const parsing = useMemo(
    () =>
      state.shipments.some((s) =>
        s.documents.some(
          (d) => d.status === 'uploading' || d.status === 'uploaded' || d.status === 'parsing',
        ),
      ),
    [state.shipments],
  )

  useEffect(() => {
    if (!REAL || !parsing) return
    const timer = window.setInterval(() => {
      void syncShipments()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [parsing, syncShipments])

  /* 解析刚结束：同步一次 AI 状态（AI 未配置时状态条要如实更新） */
  const prevParsing = useRef(parsing)
  useEffect(() => {
    if (prevParsing.current && !parsing) void syncAiStatus()
    prevParsing.current = parsing
  }, [parsing, syncAiStatus])

  const value = useMemo<AppStoreValue>(() => {
    const requireActive = (): Shipment => {
      const s = stateRef.current.shipments.find((x) => x.id === stateRef.current.activeShipmentId)
      if (!s) throw new Error('请先进入一票货物')
      return s
    }

    return {
      state,
      activeShipment,

      login: async (email, password) => {
        try {
          const session = await api.login({ email, password })
          dispatch({ type: 'session/set', account: session })
          const shipments = await api.listShipments()
          dispatch({ type: 'shipments/set', shipments })
          push(REAL ? '已登录，货物数据已从服务器同步' : '已进入本地演示身份。请勿用于真实业务身份验证。')
          return true
        } catch (err) {
          push(err instanceof Error ? err.message : '登录失败，请重试', 'error')
          return false
        }
      },

      register: async (email, password) => {
        try {
          const session = await api.register({ email, password })
          dispatch({ type: 'session/set', account: session })
          const shipments = await api.listShipments()
          dispatch({ type: 'shipments/set', shipments })
          push(REAL ? `账户已创建：${session.email}。货物数据按账号隔离保存。` : '已创建本地演示身份。请勿用于真实业务身份验证。')
          return true
        } catch (err) {
          push(err instanceof Error ? err.message : '注册失败，请重试', 'error')
          return false
        }
      },

      loginDemo: async () => {
        const session = await api.loginDemo()
        dispatch({ type: 'session/set', account: session })
        const shipments = await api.listShipments()
        dispatch({ type: 'shipments/set', shipments })
        push('已进入演示体验账号')
      },

      logout: async () => {
        await api.logout()
        dispatch({ type: 'session/set', account: null })
        dispatch({ type: 'shipments/set', shipments: [] })
        dispatch({ type: 'ui/activeShipment', id: null })
        dispatch({ type: 'ui/drawer', drawer: null })
        dispatch({ type: 'ui/modal', modal: null })
      },

      createShipment: async () => {
        const shipment = await api.createShipment()
        await syncShipments()
        dispatch({ type: 'ui/activeShipment', id: shipment.id })
        dispatch({ type: 'ui/search', value: '' })
        dispatch({ type: 'ui/filter', value: 'all' })
        push(`草稿已创建：${shipment.id}。请上传第一份单证。`)
        return shipment
      },

      deleteShipment: async (id) => {
        await api.deleteShipment(id)
        dispatch({ type: 'ui/modal', modal: null })
        dispatch({ type: 'ui/menu', id: null })
        if (stateRef.current.activeShipmentId === id) {
          dispatch({ type: 'ui/activeShipment', id: null })
        }
        await syncShipments()
        push(REAL ? `已删除：${id} 及其单证文件已从服务器移除` : `${id} 已从本地演示数据中删除`)
      },

      openShipment: (id) => {
        dispatch({ type: 'ui/activeShipment', id })
        dispatch({ type: 'ui/search', value: '' })
        dispatch({ type: 'ui/filter', value: 'all' })
        dispatch({ type: 'ui/menu', id: null })
      },

      uploadFiles: async (files) => {
        const shipment = requireActive()
        const mode = stateRef.current.fileMode
        const replaceDocumentId = mode.kind === 'replace' ? mode.documentId : undefined
        const result = await api.uploadDocuments({
          shipmentId: shipment.id,
          files,
          replaceDocumentId,
        })
        dispatch({ type: 'ui/fileMode', mode: { kind: 'add' } })

        result.rejected.forEach((r) => {
          push(`${r.fileName}：${r.message}`, 'error')
        })

        if (result.accepted.length) {
          const names = result.accepted.map((d) => d.fileName).join('、')
          if (replaceDocumentId) {
            push(`已替换单证：${names}。原提取证据失效，请重新检查。`)
          } else if (shipment.isDemo) {
            push(`文件已添加至演示货物：${names}。新文件不会被假装解析成功。`)
          } else {
            push(`${result.accepted.length} 份文件正在接收。完成后可查看原件。`)
          }
        }
        await syncShipments()
      },

      deleteDocument: async (documentId) => {
        const shipment = requireActive()
        await api.deleteDocument(shipment.id, documentId)
        dispatch({ type: 'ui/modal', modal: null })
        dispatch({ type: 'ui/drawer', drawer: null })
        await syncShipments()
        push('单证已移除，请重新检查相关字段')
      },

      retryDocument: async (documentId) => {
        const shipment = requireActive()
        try {
          await api.retryDocument(shipment.id, documentId)
          await syncShipments()
          await syncAiStatus()
          push('已重新提交解析，完成后会自动刷新结果。')
        } catch (err) {
          push(err instanceof Error ? err.message : '重新解析失败，请稍后再试', 'error')
        }
      },

      updateField: async (fieldKey, sourceDocumentId, val) => {
        const shipment = requireActive()
        const value = val.trim()
        if (!value) {
          push('请输入修正后的值', 'error')
          return
        }
        await api.updateExtractedField({
          shipmentId: shipment.id,
          documentId: sourceDocumentId,
          fieldKey,
          value,
        })
        dispatch({ type: 'ui/modal', modal: null })
        await syncShipments()
        push('字段修改已保存。请点击「重新检查」更新状态。')
      },

      recordReview: async (findingId, note) => {
        const shipment = requireActive()
        const text = note.trim()
        if (text.length < 3) {
          push('请填写具体的复核意见', 'error')
          return
        }
        await api.recordHumanDecision({ shipmentId: shipment.id, findingId, note: text })
        dispatch({ type: 'ui/modal', modal: null })
        await syncShipments()
        push('人工复核意见已保存；异常风险继续保留。')
      },

      followUpRule: async (ruleKey) => {
        const shipment = requireActive()
        if (!shipment.isDemo) {
          push('当前货物没有该规则的真实检查结果，无法记录人工意见', 'error')
          return
        }
        const finding = await api.createRuleFollowUp(shipment.id, ruleKey)
        dispatch({ type: 'ui/drawer', drawer: null })
        dispatch({ type: 'ui/modal', modal: { type: 'review', findingId: finding.id } })
        await syncShipments()
      },

      resolveFinding: async (findingId, note) => {
        const shipment = requireActive()
        const text = note.trim()
        if (text.length < 3) {
          push('请填写处理说明，说明是如何处理的', 'error')
          return
        }
        await api.resolveFinding({ shipmentId: shipment.id, findingId, note: text })
        dispatch({ type: 'ui/modal', modal: null })
        await syncShipments()
        push('已标记为人工处理完毕。处理说明已留档，可随时重新打开。')
      },

      reopenFinding: async (findingId, note) => {
        const shipment = requireActive()
        const text = note.trim()
        if (text.length < 3) {
          push('请填写重新打开的原因', 'error')
          return
        }
        await api.reopenFinding({ shipmentId: shipment.id, findingId, note: text })
        dispatch({ type: 'ui/modal', modal: null })
        await syncShipments()
        push('异常已重新打开。')
      },

      recheck: async () => {
        const shipment = requireActive()
        const report = await api.recheck(shipment.id)
        await syncShipments()
        if (report.ran) {
          const conflict = report.summary.includes('仍存在') || report.summary.includes('证据不足')
          push(report.summary, conflict ? 'error' : 'success')
        } else {
          push(report.summary, 'error')
          dispatch({ type: 'ui/modal', modal: { type: 'recheck-info' } })
        }
      },

      setSearch: (value) => dispatch({ type: 'ui/search', value }),
      setFilter: (value) => dispatch({ type: 'ui/filter', value }),
      toggleMenu: (id) =>
        dispatch({ type: 'ui/menu', id: stateRef.current.openMenuShipmentId === id ? null : id }),
      openModal: (modal) => dispatch({ type: 'ui/modal', modal }),
      closeModal: () => dispatch({ type: 'ui/modal', modal: null }),
      openDrawer: (drawer) => dispatch({ type: 'ui/drawer', drawer }),
      closeDrawer: () => dispatch({ type: 'ui/drawer', drawer: null }),
      selectEvidence: (id) => dispatch({ type: 'ui/selectedEvidence', id }),
      setFileMode: (mode) => dispatch({ type: 'ui/fileMode', mode }),
      refresh: syncShipments,
      refreshAiStatus: syncAiStatus,
    }
  }, [state, activeShipment, push, syncShipments, syncAiStatus])

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): AppStoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用')
  return ctx
}
