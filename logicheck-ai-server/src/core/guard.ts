/* 从请求中提取会话令牌（cookie） */

import type { FastifyRequest } from 'fastify'
import { SESSION_COOKIE } from '../modules/auth/service.ts'

export function sessionTokenOf(req: FastifyRequest): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined
  return cookies?.[SESSION_COOKIE]
}
