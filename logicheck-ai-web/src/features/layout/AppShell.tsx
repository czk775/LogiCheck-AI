import { createContext, useCallback, useContext, useRef, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { ThemeToggle } from '../../components/ThemeToggle'
import { useStore, type FileMode } from '../../store/AppStore'
import { ACCEPTED_FILE_TYPES } from '../../constants'
import { useToast } from '../../components/Toast'
import { apiMode } from '../../services/api'

const REAL = apiMode === 'real'

/* ---------- 全局文件选择器（支持「补充上传」与「替换单证」两种模式） ---------- */

interface FileChooserValue {
  open: (mode: FileMode) => void
}

const FileChooserContext = createContext<FileChooserValue | null>(null)

export function useFileChooser(): FileChooserValue {
  const ctx = useContext(FileChooserContext)
  if (!ctx) throw new Error('useFileChooser 必须在 AppShell 内使用')
  return ctx
}

export function AppShell({ children }: { children: ReactNode }) {
  const { state, activeShipment, logout, openModal, uploadFiles, openShipment } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { push } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingMode = useRef<FileMode>({ kind: 'add' })

  /* 侧栏能力说明必须与真实运行状态一致，不能硬写「尚未接入」 */
  const aiConnected = state.aiStatus?.configured === true
  const capabilityText = !REAL
    ? '所有 AI 提取结果为明确标注的演示数据。上传真实文件仅做本地预览，不连接后端。'
    : aiConnected
      ? '身份、货物与单证保存在本机服务器；AI 解析已接通，提取字段可溯源到原文。'
      : '身份、货物与单证保存在本机服务器；AI 解析尚未接通，当前使用确定性提取。'

  const openChooser = useCallback((mode: FileMode) => {
    pendingMode.current = mode
    if (inputRef.current) {
      inputRef.current.value = ''
      inputRef.current.click()
    }
  }, [])

  const onFiles = useCallback(
    (files: FileList | null) => {
      const list = Array.from(files ?? [])
      if (!list.length) return
      const mode = pendingMode.current
      void uploadFiles(list).catch((err: unknown) => {
        push(err instanceof Error ? err.message : '上传失败，请重试', 'error')
      })
      if (mode.kind === 'replace') {
        // 替换完成后模式已在 store 内重置
      }
    },
    [uploadFiles, push],
  )

  const onWorkspaceNav = () => {
    if (activeShipment) {
      navigate(`/shipments/${activeShipment.id}`)
    } else if (state.shipments.length) {
      const first = state.shipments[0]
      openShipment(first.id)
      navigate(`/shipments/${first.id}`)
    } else {
      push('请先新建货物', 'error')
    }
  }

  const onLogout = () => {
    void logout().then(() => navigate('/login', { replace: true }))
  }

  const inWorkspace = location.pathname.startsWith('/shipments/')
  const crumb = inWorkspace ? '货物工作台' : '货物管理'

  return (
    <FileChooserContext.Provider value={{ open: openChooser }}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">
              <Icon name="package" size="lg" />
            </div>
            <div>
              <div className="brand-word">
                LogiCheck <span style={{ color: '#67dce2' }}>AI</span>
              </div>
              <small>SHIPMENT INTELLIGENCE</small>
            </div>
          </div>
          <div className="nav-label">WORKSPACE</div>
          <button
            type="button"
            className={`nav-link ${location.pathname === '/shipments' ? 'active' : ''}`}
            onClick={() => navigate('/shipments')}
          >
            <Icon name="grid" />
            <span>货物管理</span>
          </button>
          <button
            type="button"
            className={`nav-link ${inWorkspace ? 'active' : ''}`}
            onClick={onWorkspaceNav}
          >
            <Icon name="package" />
            <span>货物工作台</span>
          </button>
          <button type="button" className="nav-link" onClick={() => openModal({ type: 'guide' })}>
            <Icon name="clipboard" />
            <span>体验指南</span>
          </button>
          <div className="sidebar-bottom">
            <div className="sys-card">
              <strong>
                <span className="pulse-dot" />
                {REAL ? '本地服务 · SQLite 数据库' : '演示环境 · MOCK 服务'}
              </strong>
              <p>
                {capabilityText}
              </p>
            </div>
            <button type="button" className="account" onClick={onLogout} title={REAL ? '退出登录' : '退出当前演示账号'}>
              <div className="avatar">{(state.account?.email ?? 'D')[0].toUpperCase()}</div>
              <div className="account-meta">
                <strong>{state.account?.email}</strong>
                <span>
                  {REAL ? (state.account?.isDemoSession ? '演示账号 · 点击退出' : '本地账户 · 点击退出') : '演示账号 · 点击退出'}
                </span>
              </div>
              <Icon name="logout" size="sm" />
            </button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="crumb">
              <span>工作空间</span>
              <span className="sep">/</span>
              <span>{crumb}</span>
            </div>
            <div className="top-right">
              <span className="env-badge">{REAL ? '● REAL API · 本地服务器' : '● DEMO BUILD · MOCK 服务'}</span>
              <ThemeToggle />
              <button
                type="button"
                className="top-action"
                onClick={() => openModal({ type: 'guide' })}
                title="体验指南"
                aria-label="体验指南"
              >
                <Icon name="help" />
              </button>
            </div>
          </header>
          {children}
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES}
        hidden
        data-testid="file-chooser"
        onChange={(e) => onFiles(e.target.files)}
      />
    </FileChooserContext.Provider>
  )
}
