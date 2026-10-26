/* ============================================================
   单账号每日 AI 解析配额（公网防滥用 · 额度护栏第三道防线）
   ------------------------------------------------------------
   背景：服务发布到公网后，任何人都能上传单证触发真实大模型调用
   （按量计费）。除 token 上限（客户端护栏）外，还需要按账号限制
   「每天最多解析多少份」，避免个别账号把额度烧穿。

   设计：
   - 计数落 SQLite（ai_usage_daily 表），重启不丢；跨天自动重置
   - limit=0 表示不限制（本地/测试环境）
   - 单进程部署假设：check-then-write 在事务外，SQLite  busy_timeout
     已设 3s；单写者模型下不会超发（多实例部署需换 Redis，见限流模块注释）
   - 超限时由调用方决定降级行为（单证标记失败 + 友好原因），这里只判配额
   ============================================================ */

import type { Db } from '../db/index.ts'

export interface AiQuotaOptions {
  /** 每账号每日解析份数上限；0 = 不限制 */
  limit: number
  /** 当前日期（YYYY-MM-DD），测试可注入 */
  today: () => string
}

export class AiQuota {
  constructor(
    private readonly db: Db,
    private readonly opts: AiQuotaOptions,
  ) {}

  /** 剩余份数；不限制时返回 Infinity */
  remaining(userId: string): number {
    if (this.opts.limit <= 0) return Number.POSITIVE_INFINITY
    const row = this.db.get<{ parses: number }>(
      'SELECT parses FROM ai_usage_daily WHERE user_id = ? AND day = ?',
      userId,
      this.opts.today(),
    )
    return Math.max(0, this.opts.limit - (row?.parses ?? 0))
  }

  /** 尝试消耗 n 份；成功 true，超限 false（不写入） */
  consume(userId: string, n = 1): boolean {
    if (this.opts.limit <= 0) return true
    const day = this.opts.today()
    const row = this.db.get<{ parses: number }>(
      'SELECT parses FROM ai_usage_daily WHERE user_id = ? AND day = ?',
      userId,
      day,
    )
    const used = row?.parses ?? 0
    if (used + n > this.opts.limit) return false
    if (row) {
      this.db.run('UPDATE ai_usage_daily SET parses = parses + ?, updated_at = ? WHERE user_id = ? AND day = ?', n, new Date().toISOString(), userId, day)
    } else {
      this.db.run(
        'INSERT INTO ai_usage_daily (user_id, day, parses, updated_at) VALUES (?, ?, ?, ?)',
        userId,
        day,
        n,
        new Date().toISOString(),
      )
    }
    return true
  }
}
