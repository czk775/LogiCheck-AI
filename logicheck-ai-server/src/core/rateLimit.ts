/* 内存级滑动窗口限流（防暴力尝试）。单进程部署够用；多实例需换 Redis（后续阶段） */

export interface RateLimitRule {
  windowMs: number
  max: number
}

export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(private readonly rules: Record<string, RateLimitRule>) {}

  /** 超限返回 false */
  check(bucket: string, key: string): boolean {
    const rule = this.rules[bucket]
    if (!rule) return true
    const now = Date.now()
    const k = `${bucket}:${key}`
    const arr = (this.hits.get(k) ?? []).filter((t) => now - t < rule.windowMs)
    arr.push(now)
    this.hits.set(k, arr)
    if (arr.length > rule.max) return false
    if (this.hits.size > 10_000) {
      for (const [hk, ha] of this.hits) {
        if (ha.every((t) => now - t >= rule.windowMs)) this.hits.delete(hk)
      }
    }
    return true
  }
}
