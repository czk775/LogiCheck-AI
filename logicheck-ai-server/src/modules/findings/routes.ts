/* ============================================================
   字段 / 异常 / 复核 / 重检 / 记录路由（对齐前端 API Contract）
   ============================================================ */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthService } from '../auth/service.ts'
import { sessionTokenOf } from '../../core/guard.ts'
import { errors } from '../../core/errors.ts'
import type { FindingService } from './service.ts'

export function registerFindingRoutes(app: FastifyInstance, auth: AuthService, svc: FindingService): void {
  const userIdOf = (req: FastifyRequest): string => auth.requireUserId(sessionTokenOf(req))

  /* 字段候选 */
  app.get('/api/shipments/:id/fields/:fieldKey/candidates', async (req) => {
    const userId = userIdOf(req)
    const { id, fieldKey } = req.params as { id: string; fieldKey: string }
    return { candidates: svc.getCandidates(userId, id, fieldKey) }
  })

  /* 人工修正提取字段 */
  app.patch('/api/shipments/:id/fields', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { documentId?: unknown; fieldKey?: unknown; value?: unknown }
    if (typeof body.documentId !== 'string' || typeof body.fieldKey !== 'string' || typeof body.value !== 'string') {
      throw errors.badRequest('参数不完整')
    }
    if (!body.value.trim()) throw errors.badRequest('请输入修正后的值')
    const shipment = svc.updateField(userId, id, body.documentId, body.fieldKey, body.value.trim())
    return { shipment }
  })

  /* 人工复核记录 */
  app.post('/api/findings/:id/decisions', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { note?: unknown }
    if (typeof body.note !== 'string' || body.note.trim().length < 3) {
      throw errors.badRequest('请填写具体的复核意见')
    }
    return { finding: svc.recordDecision(userId, id, body.note.trim()) }
  })

  /* 规则人工跟进 */
  app.post('/api/shipments/:id/rules/:ruleKey/follow-up', async (req) => {
    const userId = userIdOf(req)
    const { id, ruleKey } = req.params as { id: string; ruleKey: string }
    return { finding: svc.createRuleFollowUp(userId, id, ruleKey) }
  })

  /* 重新检查 */
  app.post('/api/shipments/:id/recheck', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    return { report: svc.recheck(userId, id) }
  })

  /* 处理记录 / 操作记录 */
  app.get('/api/shipments/:id/runs', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    return { runs: svc.getRuns(userId, id) }
  })

  app.get('/api/shipments/:id/activities', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    return { activities: svc.getActivities(userId, id) }
  })

  /* 规则预检概况（演示货物为内置示例数据；真实预检属后续阶段） */
  app.get('/api/shipments/:id/check-results', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    return { results: svc.getCheckResults(userId, id) }
  })
}
