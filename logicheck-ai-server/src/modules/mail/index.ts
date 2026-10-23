/* ============================================================
   邮件服务（找回密码用）—— 可插拔传输层：
   - DevMailService：本地发件箱，邮件落盘为 .eml（开发/测试默认，零配置）
   - SmtpMailService：真实 SMTP 发信（配置 SMTP_* 环境变量后启用）
   正式发信前不需要任何密钥；配置说明见 .env.example。
   ============================================================ */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTransport, type Transporter } from 'nodemailer'
import type { AppConfig } from '../../config.ts'
import { newId, nowIso } from '../../core/ids.ts'

export interface OutboundMail {
  to: string
  subject: string
  text: string
  html?: string
}

export interface MailService {
  readonly mode: 'dev-outbox' | 'smtp'
  send(mail: OutboundMail): Promise<void>
}

/** 开发模式：写入本地发件箱目录（.eml + 元数据 JSON），测试可读取验证 */
export class DevMailService implements MailService {
  readonly mode = 'dev-outbox' as const

  constructor(private readonly outboxDir: string) {
    mkdirSync(outboxDir, { recursive: true })
  }

  async send(mail: OutboundMail): Promise<void> {
    const id = newId('mail')
    const file = join(this.outboxDir, `${id}.eml`)
    const body = [
      `To: ${mail.to}`,
      `Subject: ${mail.subject}`,
      `Date: ${nowIso()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      mail.text,
    ].join('\n')
    writeFileSync(file, body, 'utf8')
    writeFileSync(
      join(this.outboxDir, `${id}.json`),
      JSON.stringify({ id, to: mail.to, subject: mail.subject, text: mail.text, at: nowIso() }, null, 2),
      'utf8',
    )
  }
}

/** 生产模式：SMTP 真实发信 */
export class SmtpMailService implements MailService {
  readonly mode = 'smtp' as const
  private readonly transport: Transporter
  private readonly from: string

  constructor(smtp: NonNullable<AppConfig['smtp']>) {
    this.from = smtp.from
    this.transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    })
  }

  async send(mail: OutboundMail): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...mail })
  }
}

export function createMailService(config: AppConfig): MailService {
  return config.smtp ? new SmtpMailService(config.smtp) : new DevMailService(config.mailOutboxDir)
}
