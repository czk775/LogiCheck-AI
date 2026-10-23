/* 服务端配置：环境变量 → 校验后的配置对象。密钥只走环境变量，不落库、不进前端。 */

import { env as loadEnv } from 'node:process'
import { resolve } from 'node:path'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_PATH: z.string().default('./data/logicheck.db'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  MAIL_OUTBOX_DIR: z.string().default('./data/mail-outbox'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(7),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  /* 提取 Provider：deterministic（默认，无外部 API）/ ai（第五阶段配置 Key 后启用） */
  EXTRACTION_PROVIDER: z.enum(['deterministic', 'ai']).default('deterministic'),
  /* 可选 SMTP（全部留空 → 本地发件箱模式） */
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
})

export interface AppConfig {
  port: number
  databasePath: string
  uploadDir: string
  mailOutboxDir: string
  sessionTtlDays: number
  corsOrigin: string
  extractionProvider: 'deterministic' | 'ai'
  smtp: {
    host: string
    port: number
    secure: boolean
    user: string
    pass: string
    from: string
  } | null
}

export function loadConfig(env: NodeJS.ProcessEnv = loadEnv): AppConfig {
  const parsed = schema.parse(env)
  const smtpReady =
    !!parsed.SMTP_HOST && !!parsed.SMTP_USER && !!parsed.SMTP_PASS && !!parsed.MAIL_FROM

  return {
    port: parsed.PORT,
    databasePath: resolve(parsed.DATABASE_PATH),
    uploadDir: resolve(parsed.UPLOAD_DIR),
    mailOutboxDir: resolve(parsed.MAIL_OUTBOX_DIR),
    sessionTtlDays: parsed.SESSION_TTL_DAYS,
    corsOrigin: parsed.CORS_ORIGIN,
    extractionProvider: parsed.EXTRACTION_PROVIDER,
    smtp: smtpReady
      ? {
          host: parsed.SMTP_HOST!,
          port: parsed.SMTP_PORT ?? 465,
          secure: (parsed.SMTP_SECURE ?? 'true') === 'true',
          user: parsed.SMTP_USER!,
          pass: parsed.SMTP_PASS!,
          from: parsed.MAIL_FROM!,
        }
      : null,
  }
}
