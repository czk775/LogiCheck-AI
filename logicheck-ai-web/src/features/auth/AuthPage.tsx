import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { ThemeToggle } from '../../components/ThemeToggle'
import { useStore } from '../../store/AppStore'
import { ModalHost } from '../modals/ModalHost'
import { apiMode } from '../../services/api'
import { AuthScene } from './AuthScene'

const REAL = apiMode === 'real'

/** 登录 / 注册 / 找回密码 —— 与已确认原型一致；演示身份，非真实认证 */
export function AuthPage() {
  const { state, login, register, openModal } = useStore()
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

  return (
    <main className="auth-screen">
      {/* 背景场景层：数字地球 / 物流航线 / 单证卡片 / 货轮港口剪影（铺满视口，不占布局流） */}
      <AuthScene />

      <div className="auth-story">
        <div className="auth-story-copy">
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
      </div>

      <section className="auth-card">
        <div className="auth-theme-row">
          <ThemeToggle />
        </div>
        <h2>{mode === 'register' ? (REAL ? '创建账户' : '创建体验账号') : '欢迎回来'}</h2>
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
          <div className="auth-form-meta">
            <button type="button" className="text-btn" onClick={() => openModal({ type: 'forgot-password' })}>
              忘记密码？
            </button>
          </div>
          <Button variant="primary" type="submit" style={{ width: '100%' }} disabled={submitting}>
            {mode === 'register' ? (REAL ? '注册账户' : '创建体验身份') : '进入工作空间'} <Icon name="arrow" />
          </Button>
        </form>

        <div className="auth-switch">
          {mode === 'register' ? (REAL ? '已有账户？' : '已有体验身份？') : REAL ? '还没有账户？' : '还没有体验身份？'}{' '}
          <button type="button" className="text-btn" onClick={() => setMode(mode === 'register' ? 'login' : 'register')}>
            {mode === 'register' ? '返回登录' : REAL ? '注册账户' : '注册体验账号'}
          </button>
        </div>
      </section>
      <ModalHost />
    </main>
  )
}
