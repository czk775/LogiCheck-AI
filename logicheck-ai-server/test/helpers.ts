/* ============================================================
   测试基建：真实 HTTP + 真实 SQLite 文件 + 真实上传目录。
   每个用例独立临时数据目录；restart() 模拟服务重启验证持久化。
   ============================================================ */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, type Db } from '../src/db/index.ts'
import { buildApp } from '../src/app.ts'
import type { AppConfig } from '../src/config.ts'

export interface OutboxMail {
  id: string
  to: string
  subject: string
  text: string
  at: string
}

export class TestClient {
  cookie = ''

  constructor(private readonly getBaseUrl: () => string) {}

  private async raw(method: string, path: string, init: { body?: unknown; form?: FormData } = {}) {
    const headers: Record<string, string> = {}
    if (this.cookie) headers.Cookie = this.cookie
    let body: FormData | string | undefined
    if (init.form) {
      body = init.form
    } else if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    const res = await fetch(this.getBaseUrl() + path, { method, headers, body, redirect: 'manual' })
    const setCookie = res.headers.get('set-cookie')
    if (setCookie) {
      this.cookie = setCookie.split(';')[0]
    }
    // clone 后再读文本，保留原始 Response 供二进制断言
    const cloned = res.clone()
    const text = await cloned.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text, headers: res.headers, raw: res }
  }

  get(path: string) {
    return this.raw('GET', path)
  }
  post(path: string, body?: unknown) {
    return this.raw('POST', path, { body })
  }
  patch(path: string, body?: unknown) {
    return this.raw('PATCH', path, { body })
  }
  delete(path: string) {
    return this.raw('DELETE', path)
  }
  postForm(path: string, form: FormData) {
    return this.raw('POST', path, { form })
  }
}

export interface TestEnv {
  baseUrl: string
  config: AppConfig
  db: Db
  outboxDir: string
  uploadsDir: string
  client: () => TestClient
  readOutbox: () => OutboxMail[]
  /** 等待解析队列排空（上传后断言终态前调用） */
  waitForParseIdle: () => Promise<void>
  /** 模拟服务重启：关闭应用与连接，用同一数据库文件重新装配 */
  restart: () => Promise<string>
  cleanup: () => Promise<void>
}

export async function createTestEnv(overrides: Partial<AppConfig> = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-test-'))
  const config: AppConfig = {
    port: 0,
    databasePath: join(dir, 'test.db'),
    uploadDir: join(dir, 'uploads'),
    mailOutboxDir: join(dir, 'outbox'),
    sessionTtlDays: 7,
    corsOrigin: 'http://localhost:5173',
    extractionProvider: 'deterministic',
    ai: null,
    smtp: null,
    webDistDir: '',
    aiDailyParseLimit: 0,
    demoPassword: '',
    uploadRatePerMin: 10,
    apiRatePerMin: 600,
    ...overrides,
  }

  let db = openDatabase(config.databasePath)
  let built = buildApp({ config, db })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  let baseUrl = await resolveUrl(built.app)

  const client = () => new TestClient(() => baseUrl)

  const readOutbox = (): OutboxMail[] =>
    readdirSync(config.mailOutboxDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(config.mailOutboxDir, f), 'utf8')) as OutboxMail)
      .sort((a, b) => a.at.localeCompare(b.at))

  const waitForParseIdle = async (): Promise<void> => {
    await built.parseQueue.onIdle()
  }

  const restart = async (): Promise<string> => {
    await built.parseQueue.onIdle() // 等解析排空再重启，避免半成品状态
    await built.app.close()
    db.close()
    db = openDatabase(config.databasePath)
    built = buildApp({ config, db })
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    baseUrl = await resolveUrl(built.app)
    return baseUrl
  }

  const cleanup = async () => {
    try {
      await built.parseQueue.onIdle()
      await built.app.close()
      db.close()
    } catch {
      /* 已关闭 */
    }
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    get baseUrl() { return baseUrl },
    config,
    get db() { return db }, // restart 后指向新连接（旧连接已关闭）
    outboxDir: config.mailOutboxDir,
    uploadsDir: config.uploadDir,
    client,
    readOutbox,
    waitForParseIdle,
    restart,
    cleanup,
  }
}

async function resolveUrl(app: { server: { address: () => unknown } }): Promise<string> {
  const addr = app.server.address()
  if (addr && typeof addr === 'object' && 'port' in addr) {
    return `http://127.0.0.1:${(addr as { port: number }).port}`
  }
  throw new Error('无法解析测试服务器地址')
}
