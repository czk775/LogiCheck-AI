/* ============================================================
   数据访问层：SQLite（Node 内置 node:sqlite，零原生依赖）

   - 生产/开发同一实现：真实关系型数据库，不是 Mock。
   - 所有查询走 prepare 参数绑定，禁止字符串拼接 SQL。
   - 开启外键约束，删除货物时级联清理关联数据。
   ============================================================ */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface Db {
  readonly raw: DatabaseSync
  exec(sql: string): void
  run(sql: string, ...params: SqlValue[]): void
  get<T>(sql: string, ...params: SqlValue[]): T | undefined
  all<T>(sql: string, ...params: SqlValue[]): T[]
  transaction<T>(fn: () => T): T
  close(): void
}

export type SqlValue = string | number | null

export function openDatabase(dbPath: string): Db {
  const abs = resolve(dbPath)
  mkdirSync(dirname(abs), { recursive: true })
  const raw = new DatabaseSync(abs)
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')
  raw.exec('PRAGMA busy_timeout = 3000')

  return {
    raw,
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
