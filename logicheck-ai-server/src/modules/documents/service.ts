/* ============================================================
   单证管理服务：上传校验 / 私有存储 / 预览取回 / 删除 / 重试。

   状态机（阶段二接入真实解析流水线）：
   uploaded → parsing → parsed | failed（error 带稳定原因码）
   上传只负责「真实落库 + 入队」，解析由 ParsePipeline 异步推进。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import type { AppConfig } from '../../config.ts'
import { errors } from '../../core/errors.ts'
import { newId, nowIso } from '../../core/ids.ts'
import { AiQuota } from '../../core/aiQuota.ts'
import { FileStorage } from './storage.ts'
import type { Shipment, ShipmentDocument, UploadRejection, UploadResult } from '../../types.ts'

const MAX_FILE_SIZE = 15 * 1024 * 1024

const EXT_FORMAT: Record<string, { format: ShipmentDocument['format']; mime: string }> = {
  pdf: { format: 'pdf', mime: 'application/pdf' },
  png: { format: 'image', mime: 'image/png' },
  jpg: { format: 'image', mime: 'image/jpeg' },
  jpeg: { format: 'image', mime: 'image/jpeg' },
  webp: { format: 'image', mime: 'image/webp' },
  edi: { format: 'edi', mime: 'text/plain' },
  txt: { format: 'txt', mime: 'text/plain' },
}

/** 魔数校验：声明扩展名与文件实际内容必须一致（防 .exe 改名 .pdf） */
function magicMatches(ext: string, buf: Buffer): boolean {
  switch (ext) {
    case 'pdf':
      return buf.subarray(0, 5).toString('latin1') === '%PDF-'
    case 'png':
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'jpg':
    case 'jpeg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case 'webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    case 'edi':
    case 'txt':
      // 文本类：不含 NUL 字节且可 UTF-8 解码
      if (buf.includes(0)) return false
      try {
        buf.toString('utf8')
        return true
      } catch {
        return false
      }
    default:
      return false
  }
}

export interface IncomingFile {
  fileName: string
  mimeType: string
  buffer: Buffer
}

export class DocumentService {
  private readonly storage: FileStorage
  private readonly config: AppConfig
  /** 单账号每日 AI 解析配额（公网防滥用；deterministic 模式不消耗） */
  private readonly quota: AiQuota
  /** 原始入队回调（app.ts 传入的 ParsePipeline 队列） */
  private readonly enqueueParseRaw: (documentId: string) => void

  constructor(
    private readonly db: Db,
    config: AppConfig,
    private readonly shipments: { getForUser: (userId: string, id: string) => Shipment | null },
    /** 解析入队回调（阶段二：上传/重试后触发 ParsePipeline） */
    enqueueParse: (documentId: string) => void = () => {},
    /** 核验刷新回调（阶段四：单证被移除后，现有核验结论已过时，需重跑） */
    private readonly refreshCheck: (shipmentId: string) => void = () => {},
  ) {
    this.storage = new FileStorage(config)
    this.config = config
    this.quota = new AiQuota(db, {
      limit: config.aiDailyParseLimit,
      today: () => new Date().toISOString().slice(0, 10),
    })
    this.enqueueParseRaw = enqueueParse
  }

  /** AI 配额耗尽时的友好原因（文件已保留，不丢数据，可重试） */
  private quotaExceededMessage(): string {
    return `今日 AI 解析次数已用完（每账号每天 ${this.config.aiDailyParseLimit} 份）。文件已保留，明天再试或点击「重新解析」。`
  }

  /**
   * 入队前过 AI 配额（仅 EXTRACTION_PROVIDER=ai 且配置了上限时生效）。
   * @returns true = 已入队；false = 配额超限未入队（单证已标记 failed + 友好原因）
   */
  private enqueueParse(documentId: string): boolean {
    if (this.config.extractionProvider === 'ai' && this.config.aiDailyParseLimit > 0) {
      const row = this.db.get<{ user_id: string }>('SELECT user_id FROM documents WHERE id = ?', documentId)
      if (row && !this.quota.consume(row.user_id)) {
        this.db.run(
          'UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?',
          'failed',
          this.quotaExceededMessage(),
          nowIso(),
          documentId,
        )
        return false
      }
    }
    this.enqueueParseRaw(documentId)
    return true
  }

  /* ---------- 上传（含替换模式） ---------- */

  async uploadDocuments(
    userId: string,
    shipmentId: string,
    files: IncomingFile[],
    replaceDocumentId?: string,
  ): Promise<UploadResult> {
    const shipment = this.shipments.getForUser(userId, shipmentId)
    if (!shipment) throw errors.notFound('货物不存在或已被删除')

    if (replaceDocumentId) {
      const old = this.db.get<{ id: string }>(
        'SELECT id FROM documents WHERE id = ? AND shipment_id = ? AND user_id = ?',
        replaceDocumentId,
        shipmentId,
        userId,
      )
      if (!old) throw errors.notFound('被替换的单证不存在')
    }

    const accepted: ShipmentDocument[] = []
    const rejected: UploadRejection[] = []

    for (const file of files) {
      const verdict = this.validate(file)
      if ('reason' in verdict) {
        rejected.push({ fileName: file.fileName, reason: verdict.reason, message: verdict.message })
        continue
      }
      const doc = await this.saveDocument(userId, shipmentId, file, verdict.ext, replaceDocumentId)
      accepted.push(doc)
    }

    if (accepted.length) {
      if (shipment.isDemo) {
        this.db.run('UPDATE shipments SET dirty = 1, updated_at = ? WHERE id = ?', nowIso(), shipmentId)
      }
      this.touchShipment(shipmentId)
    }
    return { accepted, rejected }
  }

  private validate(file: IncomingFile):
    | { ext: string; format: ShipmentDocument['format'] }
    | { reason: UploadRejection['reason']; message: string } {
    const match = /\.([a-z0-9]+)$/i.exec(file.fileName.trim())
    const ext = match?.[1]?.toLowerCase() ?? ''
    const known = EXT_FORMAT[ext]
    if (!known) {
      return { reason: 'unsupported_format', message: '不支持的文件类型（仅支持 PDF / PNG / JPG / WEBP / EDI / TXT）' }
    }
    if (file.buffer.length === 0) {
      return { reason: 'empty_file', message: '空文件，请检查后重试' }
    }
    if (file.buffer.length > MAX_FILE_SIZE) {
      return { reason: 'too_large', message: '超过 15MB 的单文件限制' }
    }
    if (!magicMatches(ext, file.buffer)) {
      return { reason: 'unsupported_format', message: '文件内容与声明的格式不符，请上传真实有效的文件' }
    }
    return { ext, format: known.format }
  }

  /** 落盘 + 入库；替换模式下先删旧单证（记录与文件），保留审计活动 */
  private async saveDocument(
    userId: string,
    shipmentId: string,
    file: IncomingFile,
    ext: string,
    replaceDocumentId?: string,
  ): Promise<ShipmentDocument> {
    const t = nowIso()
    const docId = newId('doc')
    const key = this.storage.keyFor(userId, shipmentId, docId, ext)
    let status: ShipmentDocument['status'] = 'uploaded'
    let error: string | undefined
    try {
      await this.storage.write(key, file.buffer)
    } catch {
      status = 'failed'
      error = '本地文件保存失败'
    }

    const doc: ShipmentDocument = {
      id: docId,
      shipmentId,
      fileName: file.fileName,
      docType: '待 AI 识别',
      format: EXT_FORMAT[ext].format,
      status,
      size: file.buffer.length,
      createdAt: t,
      updatedAt: t,
      isDemo: false,
      fields: {},
    }
    if (error) doc.error = error

    const old = replaceDocumentId
      ? this.db.get<{ file_name: string; storage_key: string | null }>(
          'SELECT file_name, storage_key FROM documents WHERE id = ?',
          replaceDocumentId,
        )
      : null

    this.db.transaction(() => {
      if (replaceDocumentId) {
        this.db.run('DELETE FROM documents WHERE id = ?', replaceDocumentId)
        // 证据被替换：相关 resolved 异常重新打开（PRD RES-01：旧版保留审计）
        this.db.run(
          `UPDATE findings SET status = 'open' WHERE shipment_id = ? AND status = 'resolved' AND evidence LIKE ?`,
          shipmentId,
          `%${replaceDocumentId}%`,
        )
      }
      this.db.run(
        `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, error, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        doc.id,
        shipmentId,
        userId,
        doc.fileName,
        doc.docType,
        doc.format,
        doc.status,
        doc.size,
        status === 'failed' ? null : key,
        doc.error ?? null,
        t,
        t,
      )
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        shipmentId,
        replaceDocumentId
          ? `替换单证 ${old?.file_name ?? replaceDocumentId} → ${file.fileName}；原提取字段已失效`
          : `上传单证 ${file.fileName}`,
        nowIso(),
      )
    })

    if (old?.storage_key) await this.storage.remove(old.storage_key)
    if (status === 'uploaded' && !this.enqueueParse(doc.id)) {
      // 配额超限：DB 已标记 failed，同步返回值让上传响应立即反映真实状态
      doc.status = 'failed'
      doc.error = this.quotaExceededMessage()
    }
    return doc
  }

  /* ---------- 预览取回（鉴权：仅文件属主） ---------- */

  async readContent(userId: string, documentId: string): Promise<{ buffer: Buffer; fileName: string; mime: string } | null> {
    const row = this.db.get<{ storage_key: string | null; file_name: string }>(
      'SELECT storage_key, file_name FROM documents WHERE id = ? AND user_id = ?',
      documentId,
      userId,
    )
    if (!row?.storage_key) return null
    const buffer = await this.storage.read(row.storage_key)
    if (!buffer) return null
    const ext = extOf(row.file_name)
    return { buffer, fileName: row.file_name, mime: EXT_FORMAT[ext]?.mime ?? 'application/octet-stream' }
  }

  /* ---------- 删除 ---------- */

  async deleteDocument(userId: string, documentId: string): Promise<boolean> {
    const row = this.db.get<{ id: string; shipment_id: string; file_name: string; storage_key: string | null }>(
      'SELECT id, shipment_id, file_name, storage_key FROM documents WHERE id = ? AND user_id = ?',
      documentId,
      userId,
    )
    if (!row) return false
    if (row.storage_key) await this.storage.remove(row.storage_key)
    this.db.transaction(() => {
      this.db.run('DELETE FROM documents WHERE id = ?', row.id)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.shipment_id,
        `移除单证 ${row.file_name}；相关检查等待重新执行`,
        nowIso(),
      )
    })
    // 证据已消失 → 现有核验结论过时，立即重跑（无已解析单证时引擎不产生结论）
    this.refreshCheck(row.shipment_id)
    return true
  }

  /* ---------- 重试（保留文件，回到待解析） ---------- */

  async retryDocument(userId: string, documentId: string): Promise<ShipmentDocument | null> {
    const row = this.db.get<{
      id: string
      shipment_id: string
      file_name: string
      doc_type: string
      format: ShipmentDocument['format']
      size: number
      error: string | null
      is_demo: number
      created_at: string
      updated_at: string
    }>(
      'SELECT * FROM documents WHERE id = ? AND user_id = ?',
      documentId,
      userId,
    )
    if (!row) return null
    this.db.transaction(() => {
      this.db.run('UPDATE documents SET status = ?, error = NULL, updated_at = ? WHERE id = ?', 'uploaded', nowIso(), row.id)
      this.db.run(
        'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
        newId('act'),
        row.shipment_id,
        `重试 ${row.file_name}：文件已保留，重新排队解析`,
        nowIso(),
      )
    })
    const queued = this.enqueueParse(row.id)
    const doc: ShipmentDocument = {
      id: row.id,
      shipmentId: row.shipment_id,
      fileName: row.file_name,
      docType: row.doc_type,
      format: row.format,
      status: queued ? 'uploaded' : 'failed',
      size: row.size,
      createdAt: row.created_at,
      updatedAt: nowIso(),
      isDemo: row.is_demo === 1,
      fields: {},
    }
    if (!queued) doc.error = this.quotaExceededMessage()
    return doc
  }

  private touchShipment(shipmentId: string): void {
    this.db.run('UPDATE shipments SET updated_at = ? WHERE id = ?', nowIso(), shipmentId)
  }
}

function extOf(fileName: string): string {
  return /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? 'bin'
}
