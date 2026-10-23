import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { ThemeToggle } from '../../components/ThemeToggle'
import { useStore } from '../../store/AppStore'
import { ModalHost } from '../modals/ModalHost'
import { apiMode } from '../../services/api'

const REAL = apiMode === 'real'

/** 登录 / 注册 / 找回密码 —— 与已确认原型一致；演示身份，非真实认证 */
export function AuthPage() {
  const { state, login, register, loginDemo, openModal } = useStore()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // 已登录访问 /login → 回工作区
  useEffect(() => {
    if (state.account) navigate('/shipments', { replace: true })
  }, [state.account, navigate])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    const ok = mode === 'register' ? await register(email, password) : await login(email, password)
    setSubmitting(false)
    if (ok) navigate('/shipments', { replace: true })
  }

  const onDemo = async () => {
    await loginDemo()
    navigate('/shipments', { replace: true })
  }

  return (
    <main className="auth-screen">
      <div className="auth-story">
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
        <div className="eyebrow" style={{ marginBottom: 17 }}>
          THE NEW STANDARD IN DOCUMENT OPERATIONS
        </div>
        <h1>
          让每一票货物
          <br />
          <em>清晰可控。</em>
        </h1>
        <p>从单证理解、跨文件核验到目的国合规预检，把繁杂的物流单证工作组织成值得信赖的异常处理流程。</p>
        <div className="auth-features">
          <span>◈ 一票货物，全局掌控</span>
          <span>◈ 证据驱动的核验</span>
          <span>◈ 异常处理闭环</span>
        </div>
      </div>

      <section className="auth-card">
        <div className="auth-theme-row">
          <ThemeToggle />
        </div>
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          {REAL ? 'SECURE WORKSPACE · 本地服务' : 'SECURE WORKSPACE · DEMO'}
        </div>
        <h2>{mode === 'register' ? (REAL ? '创建账户' : '创建体验账号') : '欢迎回来'}</h2>
        <p className="intro">
          {mode === 'register'
            ? REAL
              ? '使用邮箱注册一个本地账户，货物与单证保存在本机服务器。'
              : '创建一个仅用于本机体验的演示身份。'
            : '登录并继续处理你的货物和单证。'}
        </p>
        <form id="authForm" onSubmit={onSubmit}>
          <div className="form-row">
            <label htmlFor="email">邮箱地址</label>
            <input
              className="field"
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="password">密码</label>
            <input
              className="field"
              id="password"
              type="password"
              required
              minLength={8}
              placeholder={REAL ? '至少 8 位，密码加密保存' : '演示环境，不要输入真实密码'}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              margin: '6px 0 23px',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 11, color: 'var(--mute)' }}>
              {REAL ? '真实账户认证 · 数据保存在本机服务器' : '仅界面演示 · 不进行真实身份认证'}
            </span>
            <button type="button" className="text-btn" onClick={() => openModal({ type: 'forgot-password' })}>
              忘记密码？
            </button>
          </div>
          <Button variant="primary" type="submit" style={{ width: '100%' }} disabled={submitting}>
            {mode === 'register' ? (REAL ? '注册账户' : '创建体验身份') : '进入工作空间'} <Icon name="arrow" />
          </Button>
        </form>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '23px 0' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          <span style={{ color: 'var(--mute)', fontSize: 10 }}>或</span>
          <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
        </div>
        <Button style={{ width: '100%' }} icon="sparkle" onClick={onDemo}>
          一键体验演示案例
        </Button>
        <div style={{ textAlign: 'center', marginTop: 25, fontSize: 12, color: 'var(--mute)' }}>
          {mode === 'register' ? (REAL ? '已有账户？' : '已有体验身份？') : REAL ? '还没有账户？' : '还没有体验身份？'}{' '}
          <button type="button" className="text-btn" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
            {mode === 'register' ? '返回登录' : REAL ? '注册账户' : '注册体验账号'}
          </button>
        </div>
        <div className="auth-note">
          <Icon name="info" size="sm" />
          {REAL
            ? '身份与数据保存在本机服务器（SQLite + 本地文件存储）。密码经 scrypt 加密，会话通过 httpOnly Cookie 保持；请勿使用与其他网站相同的密码。'
            : '此为 LogiCheck AI 前端演示版本（Mock 服务）。身份与权限未接入服务器，请勿输入真实密码或敏感商业文件。'}
        </div>
      </section>
      <ModalHost />
    </main>
  )
}
