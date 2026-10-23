/* ============================================================
   迁移：幂等应用 schema.sql（CREATE TABLE IF NOT EXISTS）。
   后续阶段新增表时追加到 schema.sql 即可，历史数据不受影响。
   ============================================================ */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Db } from './index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export function migrate(db: Db): void {
  const sql = readFileSync(join(HERE, 'schema.sql'), 'utf8')
  db.exec(sql)
}
