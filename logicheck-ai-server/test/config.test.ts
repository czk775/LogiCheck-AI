/* 配置加载回归测试：环境变量必须真实生效（曾因误用 process.config 导致全部失效） */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'

test('CFG1 环境变量真实生效（端口/路径/TTL/SMTP）', () => {
  const c = loadConfig({
    PORT: '4321',
    DATABASE_PATH: './data/x.db',
    UPLOAD_DIR: './data/u',
    MAIL_OUTBOX_DIR: './data/m',
    SESSION_TTL_DAYS: '3',
    CORS_ORIGIN: 'http://example.test',
  } as NodeJS.ProcessEnv)
  assert.equal(c.port, 4321)
  assert.equal(c.sessionTtlDays, 3)
  assert.equal(c.corsOrigin, 'http://example.test')
  assert.match(c.databasePath, /x\.db$/)
  assert.equal(c.smtp, null, '未配置 SMTP 时应为 null')
})

test('CFG2 SMTP 三要素齐全才启用', () => {
  const withoutPass = loadConfig({ SMTP_HOST: 'smtp.test', SMTP_USER: 'u', MAIL_FROM: 'f' } as NodeJS.ProcessEnv)
  assert.equal(withoutPass.smtp, null)
  const full = loadConfig({
    SMTP_HOST: 'smtp.test',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'u',
    SMTP_PASS: 'p',
    MAIL_FROM: 'f@test',
  } as NodeJS.ProcessEnv)
  assert.deepEqual(full.smtp, { host: 'smtp.test', port: 587, secure: false, user: 'u', pass: 'p', from: 'f@test' })
})
