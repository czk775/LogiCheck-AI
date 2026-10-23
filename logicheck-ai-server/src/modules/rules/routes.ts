/* 合规规则路由：GET /api/rules */

import type { FastifyInstance } from 'fastify'
import type { RuleService } from './service.ts'

export function registerRuleRoutes(app: FastifyInstance, svc: RuleService): void {
  app.get('/api/rules', async () => ({ rules: svc.list() }))
}
