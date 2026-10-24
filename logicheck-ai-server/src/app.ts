/* ============================================================
   应用装配：buildApp() 组装插件 + 路由（测试与生产共用）。
   ============================================================ */

import Fastify from 'fastify'
import type { FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import type { Db } from './db/index.ts'
import { migrate } from './db/migrate.ts'
import { loadConfig, type AppConfig } from './config.ts'
import { ApiError } from './core/errors.ts'
import { RateLimiter } from './core/rateLimit.ts'
import { createMailService, type MailService } from './modules/mail/index.ts'
import { AuthService } from './modules/auth/service.ts'
import { registerAuthRoutes } from './modules/auth/routes.ts'
import { seedRules } from './modules/demo/seed.ts'
import { registerShipmentRoutes } from './modules/shipments/routes.ts'
import { ShipmentService } from './modules/shipments/service.ts'
import { registerDocumentRoutes } from './modules/documents/routes.ts'
import { DocumentService } from './modules/documents/service.ts'
import { FileStorage } from './modules/documents/storage.ts'
import { registerFindingRoutes } from './modules/findings/routes.ts'
import { FindingService } from './modules/findings/service.ts'
import { registerRuleRoutes } from './modules/rules/routes.ts'
import { RuleService } from './modules/rules/service.ts'
import { buildProviders } from './modules/parsing/providers/index.ts'
import { ParsePipeline, ParseQueue } from './modules/parsing/pipeline.ts'
import { CheckEngine } from './modules/checking/engine.ts'

export interface BuiltApp {
  app: ReturnType<typeof Fastify>
  config: AppConfig
  db: Db
  mail: MailService
  auth: AuthService
  shipments: ShipmentService
  documents: DocumentService
  findings: FindingService
  rules: RuleService
  parseQueue: ParseQueue
  checkEngine: CheckEngine
}

export function buildApp(options: { config?: AppConfig; db?: Db; mail?: MailService } = {}): BuiltApp {
  const config = options.config ?? loadConfig()
  const db = options.db
  if (!db) throw new Error('buildApp 需要显式传入 db（测试用临时库，生产用配置库）')
  migrate(db)
  seedRules(db) // 合规规则参考数据（幂等）
  const mail = options.mail ?? createMailService(config)

  const app = Fastify({
    logger: { level: 'info', transport: undefined },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
  })

  /* CORS：仅允许配置的前端来源携带凭证（Vite dev server） */
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', config.corsOrigin)
    reply.header('Access-Control-Allow-Credentials', 'true')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      reply.status(204)
      return reply.send()
    }
  })

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ApiError) {
      req.log.warn({ code: err.code, path: req.url }, err.message)
      return reply.status(err.statusCode).send({ code: err.code, message: err.message })
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ code: 'too_many_requests', message: '操作过于频繁，请稍后再试' })
    }
    req.log.error({ err, path: req.url }, '未处理的服务端错误')
    return reply.status(500).send({ code: 'internal_error', message: '服务端内部错误，请稍后重试' })
  })

  void app.register(cookie)
  // 插件上限 20MB 仅防内存失控；业务校验（15MB）在 DocumentService 内做友好拒绝
  void app.register(multipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 20, fields: 10 },
  })

  const limiter = new RateLimiter({
    login: { windowMs: 60_000, max: 10 },
    register: { windowMs: 3_600_000, max: 5 },
    forgot: { windowMs: 3_600_000, max: 5 },
  })

  const auth = new AuthService(db, config, mail)
  const shipments = new ShipmentService(db, config)

  /* 单证解析流水线：进程内串行队列 + 可恢复状态机 */
  const providers = buildProviders(config)
  /* 核验引擎（阶段三）：跨单证一致性 + 合规规则预检，解析成功后自动运行 */
  const checkEngine = new CheckEngine(db)
  /** 安全地跑一次核验：引擎异常不得影响解析/上传主流程 */
  const runCheck = (shipmentId: string, trigger: 'check' | 'recheck' = 'check'): void => {
    try {
      checkEngine.run(shipmentId, trigger)
    } catch (err) {
      console.error(`[check-engine] 货物 ${shipmentId} 核验失败：`, err)
    }
  }
  const pipeline = new ParsePipeline(db, new FileStorage(config), providers.extraction, providers.ocr, (shipmentId) => {
    runCheck(shipmentId, 'check')
  })
  const parseQueue = new ParseQueue((documentId) => pipeline.run(documentId))
  // 启动恢复：上次服务中断时留在 parsing 的文档 → uploaded 重新入队
  const recovered = pipeline.recoverInterrupted()
  const documents = new DocumentService(
    db,
    config,
    shipments,
    (documentId) => parseQueue.enqueue(documentId),
    // 单证被移除 → 现有核验结论已过时，立即重跑
    (shipmentId) => runCheck(shipmentId, 'recheck'),
  )
  for (const id of recovered) parseQueue.enqueue(id)
  for (const id of pipeline.pendingDocumentIds()) parseQueue.enqueue(id)

  const findings = new FindingService(db, shipments, checkEngine)
  const rules = new RuleService(db)

  registerAuthRoutes(app, auth, config, limiter)
  registerShipmentRoutes(app, auth, shipments)
  registerDocumentRoutes(app, auth, documents)
  registerFindingRoutes(app, auth, findings)
  registerRuleRoutes(app, rules)

  app.get('/api/healthz', async () => ({
    ok: true,
    db: 'sqlite',
    mode: mail.mode,
    extraction: providers.extraction.id,
    ocr: providers.ocr.id,
  }))

  /* AI 能力状态（不返回任何密钥，仅返回是否接通与模型名，供前端展示） */
  app.get('/api/system/ai-status', async () => {
    const usage = providers.usage()
    if (!config.ai) {
      return {
        configured: false,
        extraction: providers.extractionSource,
        ocr: providers.ocrSource,
        reason: '未配置 AI 服务（缺少 API Key 或模型名），当前使用确定性提取',
        usage,
      }
    }
    const d = config.ai.describe()
    return {
      configured: true,
      extraction: providers.extractionSource,
      ocr: providers.ocrSource,
      baseUrl: d.baseUrl,
      model: d.model,
      visionModel: d.visionModel ?? d.model,
      usage,
    }
  })

  return { app, config, db, mail, auth, shipments, documents, findings, rules, parseQueue, checkEngine }
}
