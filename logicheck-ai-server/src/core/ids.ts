/* ID 生成：货物/单证/用户等业务 ID（可读前缀 + 随机后缀，避免枚举） */

import { randomBytes, randomUUID } from 'node:crypto'

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

/** 不透明会话/重置令牌（32 bytes 高熵随机） */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function nowIso(): string {
  return new Date().toISOString()
}
