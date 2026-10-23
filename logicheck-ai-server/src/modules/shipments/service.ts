/* ============================================================
   货物管理服务：新建 / 列表 / 搜索 / 详情聚合 / 删除（级联文件）。
   数据隔离：所有查询强制 user_id 条件；他人货物一律按「不存在」处理。
   ============================================================ */

import { rm, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Db } from '../../db/index.ts'
import type { AppConfig } from '../../config.ts'
import { newId, nowIso } from '../../core/ids.ts'
import { shipmentRowToAggregate } from './aggregate.ts'
import type { Shipment } from '../../types.ts'

interface ShipmentRow {
  id: string
  user_id: string
  name: string
  origin: string
  destination: string
  is_demo: number
  dirty: number
  created_at: string
  updated_at: string
}

export class ShipmentService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
  ) {}

  /** 当前用户的货物列表（可选名称搜索，SQL 层） */
  list(userId: string, search?: string): Shipment[] {
    const q = search?.trim()
    const rows = q
      ? this.db.all<ShipmentRow>(
          'SELECT * FROM shipments WHERE user_id = ? AND name LIKE ? ORDER BY created_at DESC',
          userId,
          `%${escapeLike(q)}%`,
        )
      : this.db.all<ShipmentRow>('SELECT * FROM shipments WHERE user_id = ? ORDER BY created_at DESC', userId)
    return rows.map((r) => shipmentRowToAggregate(this.db, r))
  }

  /** 新建货物：自动生成 ID 与草稿活动记录 */
  create(userId: string, name?: string): Shipment {
    const t = nowIso()
    const id = this.nextShipmentId()
    const row: ShipmentRow = {
      id,
      user_id: userId,
      name: name?.trim() || '新建货物 · 待识别',
      origin: '待提取',
      destination: '待提取',
      is_demo: 0,
      dirty: 0,
      created_at: t,
      updated_at: t,
    }
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO shipments (id, user_id, name, origin, destination, is_demo, dirty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)',
        row.id,
        row.user_id,
        row.name,
        row.origin,
        row.destination,
        row.created_at,
        row.updated_at,
      )
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.id,
        '创建货物草稿',
        t,
      )
    })
    return shipmentRowToAggregate(this.db, row)
  }

  /** 详情：仅本人货物；不存在或非本人返回 null（路由层统一 404） */
  getForUser(userId: string, shipmentId: string): Shipment | null {
    const row = this.db.get<ShipmentRow>('SELECT * FROM shipments WHERE id = ? AND user_id = ?', shipmentId, userId)
    return row ? shipmentRowToAggregate(this.db, row) : null
  }

  /** 删除：先清理磁盘文件，再由外键级联删除全部关联数据。返回是否删除成功 */
  async deleteForUser(userId: string, shipmentId: string): Promise<boolean> {
    const row = this.db.get<{ id: string }>(
      'SELECT id FROM shipments WHERE id = ? AND user_id = ?',
      shipmentId,
      userId,
    )
    if (!row) return false

    const docs = this.db.all<{ storage_key: string | null }>(
      'SELECT storage_key FROM documents WHERE shipment_id = ?',
      shipmentId,
    )
    const uploadRoot = resolve(this.config.uploadDir)
    for (const d of docs) {
      if (!d.storage_key) continue
      const abs = resolve(join(uploadRoot, d.storage_key))
      // 防路径穿越：必须位于上传根目录内
      if (!abs.startsWith(uploadRoot)) continue
      await unlink(abs).catch(() => undefined)
      // 清理单证目录（目录内仅该文件，避免残留空目录）
      await rm(dirname(abs), { recursive: true, force: true }).catch(() => undefined)
    }

    this.db.run('DELETE FROM shipments WHERE id = ?', shipmentId)
    return true
  }

  /** 下一个货物 ID（全局序号，SHP-2026-NNN；ID 为主键必须全局唯一） */
  private nextShipmentId(): string {
    const row = this.db.get<{ max_seq: number | null }>(
      `SELECT MAX(CAST(SUBSTR(id, 10) AS INTEGER)) AS max_seq FROM shipments WHERE id LIKE 'SHP-2026-%'`,
    )
    const seq = (row?.max_seq ?? 0) + 1
    return `SHP-2026-${String(seq).padStart(3, '0')}`
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c)
}
