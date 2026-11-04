/* ============================================================
   数据访问层：SQLite（双驱动自适应，零配置）
   ------------------------------------------------------------
   驱动一：Node 内置 node:sqlite（Node ≥ 22.5 且需要 --experimental-sqlite；
           部分 22.x 小版本默认不启用该模块）
   驱动二：better-sqlite3（原生预编译包，Node ≥ 18 均可，作为兜底）

   发布沙箱的 Node 版本不可预知，因此这里在打开数据库时按顺序探测：
   内置可用就用内置（零第三方依赖、零编译），否则回落到 better-sqlite3。
   两者的 statement 接口（prepare / run / get / all / exec）语义一致，
   上层 157 处调用点无需感知驱动差异。

   - 所有查询走 prepare 参数绑定，禁止字符串拼接 SQL。
   - 开启外键约束，删除货物时级联清理关联数据。
   - 环境变量 SQLITE_DRIVER=better-sqlite3 可强制走兜底驱动（联调用）。
   ============================================================ */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'

export type SqlValue = string | number | null

/** 底层驱动最小接口（node:sqlite 与 better-sqlite3 都满足） */
interface RawStatement {
  run(...params: SqlValue[]): unknown
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown
}

interface RawDatabase {
  exec(sql: string): unknown
  prepare(sql: string): RawStatement
  close(): void
}

type RawCtor = new (path: string) => RawDatabase

export type SqliteDriver = 'node:sqlite' | 'better-sqlite3'

export interface Db {
  readonly raw: unknown
  /** 实际使用的底层驱动（健康检查与日志用） */
  readonly driver: SqliteDriver
  exec(sql: string): void
  run(sql: string, ...params: SqlValue[]): void
  get<T>(sql: string, ...params: SqlValue[]): T | undefined
  all<T>(sql: string, ...params: SqlValue[]): T[]
  transaction<T>(fn: () => T): T
  close(): void
}

const require = createRequire(import.meta.url)

/** 尝试加载内置 node:sqlite；不可用（版本过低/未开开关）返回 null */
function tryNodeSqlite(): RawCtor | null {
  try {
    const mod = require('node:sqlite') as { DatabaseSync?: RawCtor }
    return typeof mod.DatabaseSync === 'function' ? mod.DatabaseSync : null
  } catch {
    return null
  }
}

/** 尝试加载 better-sqlite3；未安装返回 null */
function tryBetterSqlite(): RawCtor | null {
  try {
    const mod = require('better-sqlite3') as RawCtor & { default?: RawCtor }
    const ctor = (mod.default ?? mod) as RawCtor
    return typeof ctor === 'function' ? ctor : null
  } catch {
    return null
  }
}

function pickDriver(): { ctor: RawCtor; name: SqliteDriver } {
  const forced = (process.env.SQLITE_DRIVER ?? '').trim()
  if (forced === 'better-sqlite3') {
    const ctor = tryBetterSqlite()
    if (!ctor) throw new Error('SQLITE_DRIVER=better-sqlite3 但未安装该依赖：请执行 npm install')
    return { ctor, name: 'better-sqlite3' }
  }
  if (forced === 'node:sqlite') {
    const ctor = tryNodeSqlite()
    if (!ctor) throw new Error('SQLITE_DRIVER=node:sqlite 但当前 Node 未启用内置 sqlite 模块')
    return { ctor, name: 'node:sqlite' }
  }
  const builtin = tryNodeSqlite()
  if (builtin) return { ctor: builtin, name: 'node:sqlite' }
  const fallback = tryBetterSqlite()
  if (fallback) return { ctor: fallback, name: 'better-sqlite3' }
  throw new Error(
    `当前 Node ${process.version} 既没有可用的内置 node:sqlite，也没有安装 better-sqlite3。` +
      `请升级到 Node ≥ 22.5，或在项目目录执行 npm install 后重试。`,
  )
}

export function openDatabase(dbPath: string): Db {
  const abs = resolve(dbPath)
  mkdirSync(dirname(abs), { recursive: true })

  const { ctor, name } = pickDriver()
  const raw = new ctor(abs)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 3000')

  return {
    raw,
    driver: name,
    exec(sql: string) {
      raw.exec(sql)
    },
    run(sql: string, ...params: SqlValue[]) {
      raw.prepare(sql).run(...params)
    },
    get<T>(sql: string, ...params: SqlValue[]): T | undefined {
      return raw.prepare(sql).get(...params) as T | undefined
    },
    all<T>(sql: string, ...params: SqlValue[]): T[] {
      return raw.prepare(sql).all(...params) as T[]
    },
    transaction<T>(fn: () => T): T {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        raw.exec('COMMIT')
        return result
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
    close() {
      raw.close()
    },
  }
}
