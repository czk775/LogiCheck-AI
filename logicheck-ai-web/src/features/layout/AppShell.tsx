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
  const { state, activeShipment, logout, uploadFiles, openShipment } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { push } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingMode = useRef<FileMode>({ kind: 'add' })

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
  const inAiOverview = location.pathname.startsWith('/ai-overview')
  const crumb = inWorkspace ? '货物工作台' : inAiOverview ? 'AI 运行概览' : '货物管理'

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
          <button
            type="button"
            className={`nav-link ${inAiOverview ? 'active' : ''}`}
            onClick={() => navigate('/ai-overview')}
          >
            <Icon name="activity" />
            <span>AI 运行概览</span>
          </button>
          <div className="sidebar-bottom">
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
              <ThemeToggle />
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
