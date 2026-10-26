/* ============================================================
   数据库迁移测试：验证 001 → 002 升级路径（阶段二新增列）
   - 旧环境（仅应用 001）的既有数据在升级后完整保留
   - 新环境从零应用全部迁移
   - 已应用的迁移不会重复执行
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { openDatabase } from '../src/db/index.ts'
import { appliedMigrations, migrate } from '../src/db/migrate.ts'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', 'src', 'db', 'migrations')

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'logicheck-migrate-')), 'test.db')
}

test('M1 新环境：从零应用全部迁移', () => {
  const path = tempDbPath()
  const db = openDatabase(path)
  try {
    const ran = migrate(db)
    assert.deepEqual(ran, ['001_initial', '002_parsing', '003_checking', '004_ai', '005_ai_usage_daily'])
    assert.deepEqual(
      appliedMigrations(db).map((m) => m.version),
      ['001_initial', '002_parsing', '003_checking', '004_ai', '005_ai_usage_daily'],
    )
    // 重复执行：无新迁移
    assert.deepEqual(migrate(db), [])
  } finally {
    db.close()
    rmSync(path, { force: true })
  }
})

test('M2 旧库升级：001 的既有数据保留，002 新列就位', () => {
  const path = tempDbPath()
  const db = openDatabase(path)
  try {
    // 模拟「上一阶段部署的旧库」：只应用 001（并记录版本，如旧版 migrate 所做）
    db.exec(readFileSync(join(MIGRATIONS_DIR, '001_initial.sql'), 'utf8'))
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`)
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', '001_initial', '2026-08-01T00:00:00.000Z')

    // 旧 shape 的最小数据（用户在 001 时代留下的真实行）
    db.run(
      `INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      'usr-legacy', 'legacy@example.com', 'hash', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
    )
    db.run(
      `INSERT INTO shipments (id, user_id, name, origin, destination, is_demo, dirty, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      'SHP-LEGACY', 'usr-legacy', '旧库货物', 'CN', 'DE', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
    )
    db.run(
      `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, is_demo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', 100, 'k', 0, ?, ?)`,
      'doc-legacy', 'SHP-LEGACY', 'usr-legacy', 'old.pdf', '待 AI 识别', 'pdf', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
    )
    db.run(
      `INSERT INTO extracted_fields (id, document_id, shipment_id, field_key, value, source, updated_at)
       VALUES (?, ?, ?, 'quantity', '500', 'manual', ?)`,
      'fld-legacy', 'doc-legacy', 'SHP-LEGACY', '2026-08-01T00:00:00.000Z',
    )

    // 升级：只应应用 002、003、004
    const ran = migrate(db)
    assert.deepEqual(ran, ['002_parsing', '003_checking', '004_ai', '005_ai_usage_daily'], '已应用过 001 的库只应跑后续迁移')

    // 旧数据完整保留
    const legacy = db.get<{ value: string; source: string; status: string }>(
      'SELECT value, source, status FROM extracted_fields WHERE id = ?',
      'fld-legacy',
    )
    assert.equal(legacy?.value, '500')
    assert.equal(legacy?.source, 'manual')
    assert.equal(legacy?.status, 'extracted', '旧行按 DEFAULT 获得新状态列')

    // 新列可写可读
    db.run(
      `UPDATE extracted_fields SET normalized_value = ?, page = ?, position = ?, confidence = ?, status = ? WHERE id = ?`,
      '500', 1, 'p1@0', 0.9, 'extracted', 'fld-legacy',
    )
    const upgraded = db.get<{ normalized_value: string; page: number; position: string; confidence: number }>(
      'SELECT normalized_value, page, position, confidence FROM extracted_fields WHERE id = ?',
      'fld-legacy',
    )
    assert.equal(upgraded?.normalized_value, '500')
    assert.equal(upgraded?.page, 1)
    assert.equal(upgraded?.confidence, 0.9)

    // documents.parse_summary 新列就位
    db.run('UPDATE documents SET parse_summary = ? WHERE id = ?', '升级后摘要', 'doc-legacy')
    const doc = db.get<{ parse_summary: string }>('SELECT parse_summary FROM documents WHERE id = ?', 'doc-legacy')
    assert.equal(doc?.parse_summary, '升级后摘要')

    // 003 新列就位：check_results.reasoning 与 findings.check_key
    db.run(
      `INSERT INTO check_results (id, shipment_id, rule_key, status, label, tone, evidence_refs, reasoning)
       VALUES (?, ?, 'red', 'warning', '材料已提供', 'good', '[]', ?)`,
      'chk-legacy', 'SHP-LEGACY', '旧库判定依据',
    )
    const chk = db.get<{ reasoning: string }>('SELECT reasoning FROM check_results WHERE shipment_id = ?', 'SHP-LEGACY')
    assert.equal(chk?.reasoning, '旧库判定依据')
    db.run(
      `INSERT INTO findings (id, shipment_id, title, kind, severity, status, summary, evidence, check_key, created_at)
       VALUES (?, ?, ?, 'cross', 'danger', 'open', ?, '[]', ?, ?)`,
      'fnd-legacy', 'SHP-LEGACY', '旧库新增冲突', '数量不一致', 'cross:quantity', '2026-08-01T00:00:00.000Z',
    )
    const fnd = db.get<{ check_key: string }>('SELECT check_key FROM findings WHERE id = ?', 'fnd-legacy')
    assert.equal(fnd?.check_key, 'cross:quantity')

    // 004 新列就位（第五阶段）：AI 证据片段与模型名、单证级来源
    db.run(
      `UPDATE extracted_fields SET evidence_quote = ?, extraction_model = ? WHERE id = ?`,
      'Quantity: 500', 'qwen-plus', 'fld-legacy',
    )
    const ev = db.get<{ evidence_quote: string; extraction_model: string }>(
      'SELECT evidence_quote, extraction_model FROM extracted_fields WHERE id = ?',
      'fld-legacy',
    )
    assert.equal(ev?.evidence_quote, 'Quantity: 500')
    assert.equal(ev?.extraction_model, 'qwen-plus')
    db.run(
      'UPDATE documents SET extraction_provider = ?, extraction_model = ? WHERE id = ?',
      'ai', 'qwen-plus', 'doc-legacy',
    )
    const docSrc = db.get<{ extraction_provider: string; extraction_model: string }>(
      'SELECT extraction_provider, extraction_model FROM documents WHERE id = ?',
      'doc-legacy',
    )
    assert.equal(docSrc?.extraction_provider, 'ai')
    assert.equal(docSrc?.extraction_model, 'qwen-plus')
  } finally {
    db.close()
    rmSync(path, { force: true })
  }
})
