/* ============================================================
   货物管理路由：/api/shipments（PRD §9.2）
   ============================================================ */

import type { FastifyInstance } from 'fastify'
import type { AuthService } from '../auth/service.ts'
import { sessionTokenOf } from '../../core/guard.ts'
import { errors } from '../../core/errors.ts'
import type { ShipmentService } from './service.ts'

export function registerShipmentRoutes(app: FastifyInstance, auth: AuthService, svc: ShipmentService): void {
  const userIdOf = (req: Parameters<typeof sessionTokenOf>[0]): string =>
    auth.requireUserId(sessionTokenOf(req))

  app.get('/api/shipments', async (req) => {
    const userId = userIdOf(req)
    const search = (req.query as { search?: string }).search
    return { shipments: svc.list(userId, search) }
  })

  app.post('/api/shipments', async (req, reply) => {
    const userId = userIdOf(req)
    const body = (req.body ?? {}) as { name?: unknown }
    if (body.name !== undefined && typeof body.name !== 'string') throw errors.badRequest('名称格式不正确')
    if (typeof body.name === 'string' && body.name.length > 60) throw errors.badRequest('名称不能超过 60 个字符')
    const shipment = svc.create(userId, body.name)
    reply.status(201)
    return { shipment }
  })

  app.get('/api/shipments/:id', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const shipment = svc.getForUser(userId, id)
    if (!shipment) throw errors.notFound('货物不存在或已被删除')
    return { shipment }
  })

  app.delete('/api/shipments/:id', async (req, reply) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const ok = await svc.deleteForUser(userId, id)
    if (!ok) throw errors.notFound('货物不存在或已被删除')
    reply.status(204)
    return null
  })
}
