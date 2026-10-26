/* ============================================================
   AI 可观测性 / 评估路由（最小可用版本）

   - GET  /api/system/ai-eval      读取最近一次评估结果（无则 null）
   - POST /api/system/ai-eval/run  启动一次真实评估（已在运行则不重复启动）

   说明：
   - 评估会真实调用大模型（消耗额度），因此要求已登录会话，
     避免未登录请求触发调用
   - 运行统计（调用次数 / 成功率 / 耗时 / token）复用
     /api/system/ai-status 的 usage 字段（同一份进程内计量），
     不新增第二套统计口径
   ============================================================ */

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AuthService } from '../auth/service.ts'
import { sessionTokenOf } from '../../core/guard.ts'
import { errors } from '../../core/errors.ts'
import type { AiQuota } from '../../core/aiQuota.ts'
import type { AiEvalRunner } from './eval.ts'

/** 一次评估约需的 LLM 调用数（7 份夹具中 6 份走模型 + 余量）；用于配额预留 */
const EVAL_RESERVED_CALLS = 8

export function registerSystemRoutes(
  app: FastifyInstance,
  auth: AuthService,
  evalRunner: AiEvalRunner,
  aiQuota?: AiQuota | null,
): void {
  const requireUser = (req: FastifyRequest): string => auth.requireUserId(sessionTokenOf(req))

  /* 最近一次评估结果（null = 尚未运行过） */
  app.get('/api/system/ai-eval', async (req) => {
    requireUser(req)
    return { report: evalRunner.snapshot() }
  })

  /* 启动一次评估；并发调用返回当前运行状态，不重复启动 */
  app.post('/api/system/ai-eval/run', async (req) => {
    const userId = requireUser(req)
    /* 公网防滥用：评估一次性触发多份提取，先扣整日配额（仅 AI 模式启用） */
    if (aiQuota && !aiQuota.consume(userId, EVAL_RESERVED_CALLS)) {
      throw errors.tooManyRequests(
        `今日 AI 解析次数已用完（评估需预留 ${EVAL_RESERVED_CALLS} 份），请明天再试`,
      )
    }
    return { report: evalRunner.start() }
  })
}
