/* ============================================================
   应用装配：buildApp() 组装插件 + 路由（测试与生产共用）。
   ============================================================ */

import Fastify from 'fastify'
import type { FastifyError } from 'fastify'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import type { Db } from './db/index.ts'
import { migrate } from './db/migrate.ts'
import { loadConfig, type AppConfig } from './config.ts'
import { ApiError } from './core/errors.ts'
import { RateLimiter } from './core/rateLimit.ts'
import { AiQuota } from './core/aiQuota.ts'
import { createMailService, type MailService } from './modules/mail/index.ts'
import { AuthService } from './modules/auth/service.ts'
import { registerAuthRoutes } from './modules/auth/routes.ts'
import { seedRules, seedDemoAccount } from './modules/demo/seed.ts'
import { seedShowcase } from './modules/demo/showcase.ts'
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
import { registerSystemRoutes } from './modules/system/routes.ts'
import { AiEvalRunner } from './modules/system/eval.ts'

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
  seedDemoAccount(db, config.demoPassword) // 演示账号（幂等；体验账号可直接登录）
  /* 演示账号的历史货物与原件（幂等：账号/货物按固定 ID 判断，环境重置后重启即恢复） */
  if (config.seedShowcase) {
    const seeded = seedShowcase(db, config.demoPassword, {
      uploadDir: config.uploadDir,
      fixtureDirs: config.fixtureDirs,
    })
    if (seeded.shipmentsCreated > 0) {
      console.log(
        `[seed] 演示账号 ${seeded.accounts} 个，新增历史货物 ${seeded.shipmentsCreated} 票` +
          (seeded.documentsMissingFile > 0 ? `（${seeded.documentsMissingFile} 份单证缺少原件）` : ''),
      )
    }
  }
  const mail = options.mail ?? createMailService(config)

  const app = Fastify({
    logger: { level: 'info', transport: undefined },
    bodyLimit: 20 * 1024 * 1024,
    trustProxy: true,
  })

  /* 限流规则（内存滑动窗口；单进程部署够用，多实例需换 Redis——见 core/rateLimit.ts） */
  const limiter = new RateLimiter({
    login: { windowMs: 60_000, max: 10 },
    register: { windowMs: 3_600_000, max: 5 },
    forgot: { windowMs: 3_600_000, max: 5 },
    /* 公网防滥用：上传按账号 + 按 IP 双维度（IP 维度放宽到 3 倍，防同 NAT 下误伤） */
    upload: { windowMs: 60_000, max: config.uploadRatePerMin },
    uploadIp: { windowMs: 60_000, max: config.uploadRatePerMin * 3 },
    /* 全局 API 每 IP 每分钟上限（0 = 关闭，由规则缺失自然放行） */
    api: { windowMs: 60_000, max: config.apiRatePerMin },
  })

  /* CORS + 公网防滥用 · 全局 API 限流 */
  app.addHook('onRequest', async (req, reply) => {
    /* 公网防滥用 · 全局 API 限流（每 IP；健康检查豁免，供部署探活） */
    if (
      config.apiRatePerMin > 0 &&
      req.method !== 'OPTIONS' &&
      req.url.startsWith('/api/') &&
      !req.url.startsWith('/api/healthz') &&
      !limiter.check('api', req.ip)
    ) {
      reply.status(429)
      return reply.send({ code: 'too_many_requests', message: '请求过于频繁，请稍后再试' })
    }
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

  /* AI 评估运行器（进程内单次运行；与生产共用同一 LLM 客户端，task='eval'） */
  const evalRunner = new AiEvalRunner({ extractionClient: providers.extractionClient, ocr: providers.ocr })
  /* 评估一次性触发多份提取（约 8 次 LLM 调用）：走同一套单账号每日配额，防止公网刷评估烧额度 */
  const evalQuota =
    config.extractionProvider === 'ai' && config.aiDailyParseLimit > 0
      ? new AiQuota(db, { limit: config.aiDailyParseLimit, today: () => new Date().toISOString().slice(0, 10) })
      : null

  registerAuthRoutes(app, auth, config, limiter)
  registerShipmentRoutes(app, auth, shipments)
  registerDocumentRoutes(app, auth, documents, limiter)
  registerFindingRoutes(app, auth, findings)
  registerRuleRoutes(app, rules)
  registerSystemRoutes(app, auth, evalRunner, evalQuota)

  app.get('/api/healthz', async () => ({
    ok: true,
    db: 'sqlite',
    mode: mail.mode,
    extraction: providers.extraction.id,
    ocr: providers.ocr.id,
    /* 运行时信息：发布后核实沙箱 Node 版本与实际生效的 SQLite 驱动 */
    node: process.version,
    sqlite: db.driver,
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

  /* ---------- 前端产物托管（前后端同端口部署） ----------
     webDistDir 为空或目录不存在 = 纯 API 模式（本地开发，行为与以前完全一致）。
     注册在全部 API 路由之后：API 路径优先，未命中的 GET 才走前端托管。 */
  if (config.webDistDir && existsSync(config.webDistDir)) {
    const distRoot = resolve(config.webDistDir)
    const indexHtml = join(distRoot, 'index.html')
    app.get('/*', async (req, reply) => {
      let pathname = req.url.split('?')[0]
      try {
        pathname = decodeURIComponent(pathname)
      } catch {
        /* 保留原始路径，交由下面的匹配逻辑处理 */
      }
      if (pathname.startsWith('/api/')) {
        return reply.status(404).send({ code: 'not_found', message: '接口不存在' })
      }
      const filePath = safeResolve(distRoot, pathname)
      if (filePath && isFile(filePath)) {
        // Vite 产物带内容 hash → 长缓存；index.html 等不缓存
        const immutable = pathname.includes('/assets/')
        reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600')
        reply.type(mimeOf(filePath))
        return reply.send(readFileSync(filePath))
      }
      // 无扩展名的前端路由 → SPA 回退 index.html；带扩展名 = 资源缺失，给真实 404
      if (!/\.[^./]+$/.test(pathname) && existsSync(indexHtml)) {
        reply.header('Cache-Control', 'no-cache')
        return reply.type('text/html; charset=utf-8').send(readFileSync(indexHtml))
      }
      return reply.status(404).send({ code: 'not_found', message: '资源不存在' })
    })
    app.log.info(`[static] 前端产物托管已开启：${distRoot}`)
  }

  return { app, config, db, mail, auth, shipments, documents, findings, rules, parseQueue, checkEngine }
}

/* ---------- 静态托管工具 ---------- */

/** 目录穿越防护：只允许 distRoot 内的真实文件 */
function safeResolve(root: string, pathname: string): string | null {
  const p = resolve(root, '.' + pathname)
  const base = resolve(root)
  return p === base || p.startsWith(base + sep) ? p : null
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
}

function mimeOf(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'
}
