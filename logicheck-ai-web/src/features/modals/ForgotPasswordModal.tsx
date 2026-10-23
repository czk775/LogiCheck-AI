import { useState } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'
import { useToast } from '../../components/Toast'
import { api } from '../../services/api'

/**
 * 找回密码弹窗。
 * - 真实后端（默认）：完整流程 —— 申请重置 → 邮箱收信 → 令牌 + 新密码 → 重置成功。
 *   开发模式下邮件写入服务端本地发件箱（server/data/mail-outbox），可从文件或服务端日志获取令牌。
 * - Mock 模式（VITE_API_MODE=mock）：诚实说明不会发送邮件。
 */
export function ForgotPasswordModal() {
  const { closeModal } = useStore()
  const { push } = useToast()
  const canReset = typeof api.requestPasswordReset === 'function' && typeof api.resetPassword === 'function'

  const [step, setStep] = useState<'request' | 'sent' | 'reset'>('request')
  const [email, setEmail] = useState('')
  const [token, setToken] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  if (!canReset) {
    return (
      <Modal title="找回密码" onClose={closeModal} testId="forgot-password-modal">
        <p>正式版本将向已验证的邮箱发送重置邮件。当前是前端演示（Mock 服务），不会发送邮件，也没有真实账户认证。</p>
        <div className="form-row">
          <label htmlFor="reset-email">邮箱地址</label>
          <input className="field" id="reset-email" type="email" disabled placeholder="需要后端邮件服务" />
        </div>
        <Button variant="primary" icon="left" onClick={closeModal}>
          返回登录
        </Button>
      </Modal>
    )
  }

  const onRequest = async () => {
    setBusy(true)
    try {
      const res = await api.requestPasswordReset!(email)
      setMessage(res.message)
      setStep('sent')
    } catch (err) {
      push(err instanceof Error ? err.message : '请求失败，请重试', 'error')
    } finally {
      setBusy(false)
    }
  }

  const onReset = async () => {
    setBusy(true)
    try {
      await api.resetPassword!(token.trim(), newPassword)
      push('密码已重置，请使用新密码登录')
      closeModal()
    } catch (err) {
      push(err instanceof Error ? err.message : '重置失败，请检查令牌', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="找回密码" onClose={closeModal} testId="forgot-password-modal">
      {step === 'request' && (
        <>
          <p>输入注册邮箱，我们将发送密码重置链接。出于安全考虑，无论邮箱是否注册，都会返回相同提示。</p>
          <div className="form-row">
            <label htmlFor="reset-email">邮箱地址</label>
            <input
              className="field"
              id="reset-email"
              type="email"
              required
              autoComplete="email"
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <Button variant="primary" disabled={busy || !email} onClick={() => void onRequest()}>
            {busy ? '发送中…' : '发送重置链接'}
          </Button>
        </>
      )}

      {step === 'sent' && (
        <>
          <p>{message}</p>
          <p style={{ fontSize: 12, color: 'var(--mute)' }}>
            开发模式提示：重置邮件当前写入服务端本地发件箱（server/data/mail-outbox 目录），邮件正文中包含重置链接与令牌。配置 SMTP 后将真实发送到邮箱。
          </p>
          <Button variant="primary" onClick={() => setStep('reset')}>
            我已获取重置令牌，继续
          </Button>
        </>
      )}

      {step === 'reset' && (
        <>
          <div className="form-row">
            <label htmlFor="reset-token">重置令牌</label>
            <input
              className="field"
              id="reset-token"
              required
              placeholder="粘贴邮件中的 token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label htmlFor="reset-new-password">新密码（至少 8 位）</label>
            <input
              className="field"
              id="reset-new-password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <Button variant="primary" disabled={busy || !token.trim() || newPassword.length < 8} onClick={() => void onReset()}>
            {busy ? '重置中…' : '重置密码'}
          </Button>
        </>
      )}
    </Modal>
  )
}
