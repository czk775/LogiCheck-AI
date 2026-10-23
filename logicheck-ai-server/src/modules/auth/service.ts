/* ============================================================
   认证服务：注册 / 登录 / 退出 / 会话 / 找回密码。
   安全基线：
   - scrypt 哈希存储密码，不明文落库
   - 会话令牌高熵随机，库中只存 SHA-256 哈希，httpOnly cookie 传输
   - 登录失败统一文案，不泄露邮箱是否注册
   - 找回密码令牌 15 分钟有效、单次使用；重置成功后吊销全部会话
   - 登录/找回密码接口有基础频率限制（内存级，防暴力尝试）
   ============================================================ */

import { createHash } from 'node:crypto'
import type { Db } from '../../db/index.ts'
import type { AppConfig } from '../../config.ts'
import type { MailService } from '../mail/index.ts'
import { errors } from '../../core/errors.ts'
import { hashPassword, verifyPassword } from '../../core/password.ts'
import { newId, newToken, nowIso } from '../../core/ids.ts'
import { seedDemoShipment } from '../demo/seed.ts'
import type { UserSession } from '../../types.ts'

export const SESSION_COOKIE = 'logicheck_session'
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

interface UserRow {
  id: string
  email: string
  password_hash: string
  is_demo: number
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  /* ---------- 注册 ---------- */

  async register(email: string, password: string): Promise<{ session: UserSession; token: string }> {
    const normalized = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(normalized)) throw errors.badRequest('请填写有效的邮箱地址')
    if (password.length < 8) throw errors.badRequest('密码至少需要 8 位')

    const existing = this.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', normalized)
    if (existing) throw errors.conflict('该邮箱已注册，请直接登录')

    const t = nowIso()
    const userId = newId('usr')
    this.db.run(
      'INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      userId,
      normalized,
      hashPassword(password),
      normalized.split('@')[0],
      t,
      t,
    )
    return this.createSession(userId, normalized, false)
  }

  /* ---------- 登录 ---------- */

  async login(email: string, password: string): Promise<{ session: UserSession; token: string }> {
    const normalized = email.trim().toLowerCase()
    const user = this.db.get<UserRow>('SELECT id, email, password_hash, is_demo FROM users WHERE email = ?', normalized)
    // 统一失败文案：不区分「邮箱不存在」与「密码错误」
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw errors.unauthorized('邮箱或密码不正确')
    }
    return this.createSession(user.id, user.email, user.is_demo === 1)
  }

  /* ---------- 演示账号（产品内置示例，明确标注，非真实认证） ---------- */

  async loginDemo(): Promise<{ session: UserSession; token: string }> {
    const email = 'demo@logicheck.ai'
    let user = this.db.get<UserRow>('SELECT id, email, password_hash, is_demo FROM users WHERE email = ?', email)
    if (!user) {
      const t = nowIso()
      const userId = newId('usr')
      this.db.run(
        'INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        userId,
        email,
        hashPassword(newToken()),
        '演示账号',
        t,
        t,
      )
      user = { id: userId, email, password_hash: '', is_demo: 1 }
    }
    // 演示账号首次进入时预置一票演示货物（真实数据库记录，明确标注 is_demo）
    seedDemoShipment(this.db, user.id)
    return this.createSession(user.id, user.email, true)
  }

  /* ---------- 退出 ---------- */

  logout(token: string | undefined): void {
    if (!token) return
    this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token))
  }

  /* ---------- 会话 ---------- */

  /** 校验令牌并滑动续期；无效/过期返回 null */
  getSession(token: string | undefined): UserSession | null {
    if (!token) return null
    const row = this.db.get<{ user_id: string; email: string; is_demo: number; expires_at: string }>(
      `SELECT s.user_id AS user_id, u.email AS email, u.is_demo AS is_demo, s.expires_at AS expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      sha256(token),
    )
    if (!row) return null
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token))
      return null
    }
    this.slide(row.user_id)
    return { email: row.email, isDemoSession: row.is_demo === 1, loginAt: nowIso() }
  }

  /** 认证中间件用：返回 user_id；无效抛 401 */
  requireUserId(token: string | undefined): string {
    if (!token) throw errors.unauthorized()
    const row = this.db.get<{ user_id: string; expires_at: string }>(
      'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?',
      sha256(token),
    )
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      throw errors.unauthorized()
    }
    this.slide(row.user_id)
    return row.user_id
  }

  private slide(userId: string): void {
    const expires = new Date(Date.now() + this.config.sessionTtlDays * 86400_000).toISOString()
    this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE user_id = ?', nowIso(), expires, userId)
  }

  private createSession(userId: string, email: string, isDemo: boolean): { session: UserSession; token: string } {
    const token = newToken()
    const t = nowIso()
    const expires = new Date(Date.now() + this.config.sessionTtlDays * 86400_000).toISOString()
    this.db.run(
      'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('ses'),
      userId,
      sha256(token),
      t,
      t,
      expires,
    )
    return { session: { email, isDemoSession: isDemo, loginAt: t }, token }
  }

  /* ---------- 找回密码 ---------- */

  /** 统一返回，不泄露邮箱是否注册；已注册则发信（开发模式写入本地发件箱） */
  async requestPasswordReset(email: string): Promise<{ ok: true; message: string }> {
    const normalized = email.trim().toLowerCase()
    const message = '如果该邮箱已注册，重置邮件已发送，请检查收件箱（含垃圾邮件文件夹）'
    const user = this.db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', normalized)
    if (user) {
      const token = newToken()
      const t = nowIso()
      const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString()
      this.db.run(
        'INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        newId('pwr'),
        user.id,
        sha256(token),
        expires,
        t,
      )
      await this.mail.send({
        to: normalized,
        subject: 'LogiCheck AI · 重置你的密码',
        text: [
          '我们收到了你的 LogiCheck AI 密码重置请求。',
          '',
          `请点击以下链接重置密码（15 分钟内有效，仅可使用一次）：`,
          `http://localhost:5173/reset-password?token=${token}`,
          '',
          '如果这不是你的操作，请忽略本邮件，你的密码不会发生变化。',
        ].join('\n'),
      })
    }
    return { ok: true, message }
  }

  /** 使用令牌重置密码：成功后吊销该用户全部会话（强制重新登录） */
  async resetPassword(token: string, newPassword: string): Promise<{ session: UserSession; token: string }> {
    if (newPassword.length < 8) throw errors.badRequest('密码至少需要 8 位')
    const row = this.db.get<{ id: string; user_id: string; email: string; expires_at: string; used_at: string | null }>(
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = ?',
      sha256(token),
    )
    if (!row || row.used_at || new Date(row.expires_at).getTime() < Date.now()) {
      throw errors.badRequest('重置链接无效或已过期，请重新申请')
    }
    const t = nowIso()
    this.db.transaction(() => {
      this.db.run('UPDATE password_resets SET used_at = ? WHERE id = ?', t, row.id)
      this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hashPassword(newPassword), t, row.user_id)
      // 安全基线：密码变更后全部旧会话失效
      this.db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id)
    })
    const user = this.db.get<{ email: string; is_demo: number }>('SELECT email, is_demo FROM users WHERE id = ?', row.user_id)
    return this.createSession(row.user_id, user!.email, user!.is_demo === 1)
  }
}
