/* ============================================================
   单证管理路由：/api/shipments/:id/documents、/api/documents/:id/*
   ============================================================ */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthService } from '../auth/service.ts'
import { sessionTokenOf } from '../../core/guard.ts'
import { errors } from '../../core/errors.ts'
import type { DocumentService, IncomingFile } from './service.ts'

export function registerDocumentRoutes(app: FastifyInstance, auth: AuthService, svc: DocumentService): void {
  const userIdOf = (req: FastifyRequest): string => auth.requireUserId(sessionTokenOf(req))

  /* 上传（multipart：files[] + 可选 replaceDocumentId） */
  app.post('/api/shipments/:id/documents', async (req, reply) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }

    const files: IncomingFile[] = []
    let replaceDocumentId: string | undefined
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        files.push({
          fileName: part.filename ?? 'unknown',
          mimeType: part.mimetype,
          buffer: await part.toBuffer(),
        })
      } else if (part.fieldname === 'replaceDocumentId') {
        replaceDocumentId = String(part.value)
      }
    }
    if (!files.length) throw errors.badRequest('请选择要上传的文件')
    if (files.length > 20) throw errors.badRequest('单次最多上传 20 份文件')

    const result = await svc.uploadDocuments(userId, id, files, replaceDocumentId)
    reply.status(201)
    return result
  })

  /* 私有内容取回（鉴权 + inline 预览） */
  app.get('/api/documents/:id/content', async (req, reply) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const content = await svc.readContent(userId, id)
    if (!content) throw errors.notFound('文件不存在或无权访问')
    reply.header('Content-Type', content.mime)
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(content.fileName)}`)
    reply.header('Cache-Control', 'private, max-age=300')
    return reply.send(content.buffer)
  })

  /* 删除 */
  app.delete('/api/documents/:id', async (req, reply) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const ok = await svc.deleteDocument(userId, id)
    if (!ok) throw errors.notFound('单证不存在或已被删除')
    reply.status(204)
    return null
  })

  /* 重试（保留文件，回到待真实解析） */
  app.post('/api/documents/:id/retry', async (req) => {
    const userId = userIdOf(req)
    const { id } = req.params as { id: string }
    const doc = await svc.retryDocument(userId, id)
    if (!doc) throw errors.notFound('单证不存在或已被删除')
    return { document: doc }
  })
}
