/* ============================================================
   数据库迁移：按文件名顺序应用 migrations/*.sql，已应用的记录在
   schema_migrations 表。升级不覆盖既有数据（仅新增列/表）。

   - 新环境：从 001 开始全量应用
   - 既有环境：自动跳过已应用版本，只跑新增迁移
   - 每个迁移在事务内执行，失败即回滚并抛出
   ============================================================ */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Db } from './index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, 'migrations')

export interface MigrationInfo {
  version: string
  appliedAt: string
}

/** 应用所有未执行的迁移；返回本次应用的版本列表（空 = 已是最新） */
export function migrate(db: Db, nowIso: () => string = () => new Date().toISOString()): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`)

  const applied = new Set(db.all<{ version: string }>('SELECT version FROM schema_migrations').map((r) => r.version))
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()

  const ran: string[] = []
  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
    db.transaction(() => {
      db.exec(sql)
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, nowIso())
    })
    ran.push(version)
  }
  return ran
}

/** 查询已应用的迁移（供诊断/测试） */
export function appliedMigrations(db: Db): MigrationInfo[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
  )`)
  return db.all<MigrationInfo>('SELECT version, applied_at AS appliedAt FROM schema_migrations ORDER BY version')
}
