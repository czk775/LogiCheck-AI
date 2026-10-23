/* ============================================================
   认证路由：/api/auth/*
   ============================================================ */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z, ZodError } from 'zod'
import type { AuthService } from './service.ts'
import { SESSION_COOKIE } from './service.ts'
import { errors } from '../../core/errors.ts'
import type { RateLimiter } from '../../core/rateLimit.ts'
import type { AppConfig } from '../../config.ts'

const emailSchema = z.string().trim().toLowerCase().email('请填写有效的邮箱地址')

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  config: AppConfig,
  limiter: RateLimiter,
): void {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: config.sessionTtlDays * 86400,
    // 生产 HTTPS 部署时应改为 true
    secure: false,
  }

  const setSessionCookie = (reply: FastifyReply, token: string) => {
    reply.setCookie(SESSION_COOKIE, token, cookieOptions)
  }

  const readToken = (req: FastifyRequest): string | undefined => {
    const cookies = req.cookies as Record<string, string | undefined>
    return cookies[SESSION_COOKIE]
  }

  const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
    try {
      return schema.parse(body)
    } catch (err) {
      if (err instanceof ZodError) throw errors.badRequest(err.issues[0]?.message ?? '请求参数不正确')
      throw err
    }
  }

  app.post('/api/auth/register', async (req, reply) => {
    const { email, password } = parse(
      z.object({ email: emailSchema, password: z.string().min(8, '密码至少需要 8 位') }),
      req.body,
    )
    if (!limiter.check('register', req.ip)) throw errors.tooManyRequests('注册过于频繁，请稍后再试')
    const { session, token } = await auth.register(email, password)
    setSessionCookie(reply, token)
    reply.status(201)
    return { session }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = parse(
      z.object({ email: emailSchema, password: z.string().min(1, '请输入密码') }),
      req.body,
    )
    if (!limiter.check('login', req.ip)) throw errors.tooManyRequests('登录尝试过于频繁，请 1 分钟后再试')
    const { session, token } = await auth.login(email, password)
    setSessionCookie(reply, token)
    return { session }
  })

  app.post('/api/auth/demo', async (_req, reply) => {
    const { session, token } = await auth.loginDemo()
    setSessionCookie(reply, token)
    return { session }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    auth.logout(readToken(req))
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    reply.status(204)
    return null
  })

  app.get('/api/auth/session', async (req) => {
    return { session: auth.getSession(readToken(req)) }
  })

  app.post('/api/auth/password/forgot', async (req) => {
    const { email } = parse(z.object({ email: emailSchema }), req.body)
    if (!limiter.check('forgot', email)) throw errors.tooManyRequests('重置请求过于频繁，请稍后再试')
    return auth.requestPasswordReset(email)
  })

  app.post('/api/auth/password/reset', async (req, reply) => {
    const { token, newPassword } = parse(
      z.object({ token: z.string().min(10), newPassword: z.string().min(8, '密码至少需要 8 位') }),
      req.body,
    )
    const { session, token: sessionToken } = await auth.resetPassword(token, newPassword)
    setSessionCookie(reply, sessionToken)
    return { session, message: '密码已重置，请使用新密码登录' }
  })
}
