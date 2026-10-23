/* ============================================================
   密码哈希：scrypt（Node 内置 crypto，无外部依赖）。
   - 格式：scrypt$N$r$p$salt$hash，便于未来升级参数。
   - 恒定时间比较，防时序侧信道。
   - 明文密码绝不落库、绝不进日志。
   ============================================================ */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const N = 16384
const R = 8
const P = 1
const KEY_LEN = 64

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
