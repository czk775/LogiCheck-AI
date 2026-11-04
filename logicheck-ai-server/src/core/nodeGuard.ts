/* ============================================================
   运行时守卫（Node 版本 + SQLite 驱动可用性）
   ------------------------------------------------------------
   数据库层有两条腿（见 db/index.ts）：
   1. 内置 node:sqlite —— 需要 Node ≥ 22.5（部分 22.x 需 --experimental-sqlite）
   2. better-sqlite3 —— 任何 Node ≥ 18 均可（随依赖安装）

   只有「两条腿都不可用」时才判定不可运行，并在入口处给人话错误，
   而不是把 ERR_UNKNOWN_BUILTIN_MODULE 原样抛给部署平台。

   用法：作为 src/index.ts 的第一个 import（ESM 按源码顺序求值）。
   ============================================================ */

import { createRequire } from 'node:module'

export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 5

/** 内置 node:sqlite 在当前 Node 上是否真的可用（实际尝试加载） */
export function hasBuiltinSqlite(): boolean {
  try {
    const mod = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync?: unknown }
    return typeof mod.DatabaseSync === 'function'
  } catch {
    return false
  }
}

/** better-sqlite3 是否已安装可用 */
export function hasBetterSqlite(): boolean {
  try {
    const mod = createRequire(import.meta.url)('better-sqlite3') as { default?: unknown }
    return typeof mod === 'function' || typeof mod.default === 'function'
  } catch {
    return false
  }
}

/** 版本是否达到内置 node:sqlite 的下限 */
export function satisfiesMinNode(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  if (!m) return true // 无法解析（异常/测试环境）：放行
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
}

/** 驱动可用性探测结果（可注入，便于测试两条腿的各种组合） */
export interface DriverProbe {
  builtin: boolean
  better: boolean
}

/**
 * 校验运行时能否提供 SQLite。
 * 内置可用 → 放行；否则看 better-sqlite3；两者都没有才抛错。
 */
export function assertRuntime(
  version: string,
  probe: DriverProbe = { builtin: hasBuiltinSqlite(), better: hasBetterSqlite() },
): void {
  if (satisfiesMinNode(version) && probe.builtin) return
  if (probe.better) return
  throw new Error(
    `[nodeGuard] 当前 Node ${version} 没有可用的 SQLite 驱动：` +
      `内置 node:sqlite 需要 Node ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}，且未安装 better-sqlite3。` +
      `请执行 npm install（或升级 Node）后重试。`,
  )
}

/** 兼容旧命名：只判断版本是否达到内置模块下限 */
export function assertNodeVersion(version: string): void {
  if (satisfiesMinNode(version)) return
  throw new Error(
    `[nodeGuard] 需要 Node.js ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}（当前 ${version}）：` +
      `内置 node:sqlite 不可用，且未启用 better-sqlite3 兜底。请执行 npm install 或升级 Node 后重试。`,
  )
}

/* 模块加载即在入口处校验（index.ts 首个 import） */
assertRuntime(process.version)
