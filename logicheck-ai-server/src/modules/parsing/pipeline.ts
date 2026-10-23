/* ============================================================
   单证解析流水线（阶段二）

   状态机（documents.status）：
     uploaded ──enqueue──▶ parsing ──成功──▶ parsed
                   ▲            └──失败──▶ failed（error 带原因）
                   └──────────── 重试 / 服务重启恢复

   设计要点：
   - 进程内串行队列：上传只落库 + 入队，API 快速返回；解析异步推进
   - 每次解析写 processing_runs（trigger=parse）与 activities，全程可审计
   - 服务重启：parsing 中的文档重置为 uploaded 并重新入队（可恢复）
   - 失败原因使用稳定错误码 + 人类可读文案，不编造中间结果
   ============================================================ */

import type { Db } from '../../db/index.ts'
import { newId, nowIso } from '../../core/ids.ts'
import { FileStorage } from '../documents/storage.ts'
import { PdfParseError, extractPdfText } from './pdf/text.ts'
import { EdiParseError, assertSupportedType, parseEdifact } from './edi/parse.ts'
import { ProviderError, type ExtractionProvider, type OcrProvider } from './providers/types.ts'

interface DocumentRow {
  id: string
  shipment_id: string
  user_id: string
  file_name: string
  doc_type: string
  format: string
  status: string
  storage_key: string | null
  is_demo: number
}

export class ParsePipeline {
  constructor(
    private readonly db: Db,
    private readonly storage: FileStorage,
    private readonly extraction: ExtractionProvider,
    private readonly ocr: OcrProvider,
  ) {}

  /** 服务启动时恢复：parsing → uploaded（上次被打断的解析重新来） */
  recoverInterrupted(): string[] {
    const stuck = this.db.all<{ id: string }>("SELECT id FROM documents WHERE status = 'parsing'")
    for (const d of stuck) {
      this.db.run('UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?', 'uploaded', '服务重启，解析已重新排队', nowIso(), d.id)
    }
    return stuck.map((d) => d.id)
  }

  /** 重启后需要重新入队的文档（uploaded 且未解析） */
  pendingDocumentIds(): string[] {
    return this.db
      .all<{ id: string }>("SELECT id FROM documents WHERE status = 'uploaded' ORDER BY created_at ASC")
      .map((r) => r.id)
  }

  /** 执行单个文档的解析（队列调用；自身不抛错，失败落库为 failed） */
  async run(documentId: string): Promise<void> {
    const doc = this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', documentId)
    if (!doc) return
    if (doc.status !== 'uploaded' && doc.status !== 'failed') return
    if (doc.is_demo === 1) return // 演示货物字段由 seed 提供，不重复解析

    const runId = newId('run')
    this.db.transaction(() => {
      this.db.run('UPDATE documents SET status = ?, error = NULL, updated_at = ? WHERE id = ?', 'parsing', nowIso(), doc.id)
      this.db.run(
        `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, summary)
         VALUES (?, ?, 'parse', 'running', ?, ?)`,
        runId,
        doc.shipment_id,
        nowIso(),
        `解析单证 ${doc.file_name}`,
      )
    })

    try {
      const output = await this.parseDocument(doc)
      this.persistSuccess(doc, runId, output)
    } catch (err) {
      this.persistFailure(doc, runId, err)
    }
  }

  /* ---------- 内部 ---------- */

  private async parseDocument(doc: DocumentRow) {
    const bytes = doc.storage_key ? await this.storage.read(doc.storage_key) : null
    if (!bytes) throw new ProviderError('file_missing', '文件在存储中缺失，无法解析')

    if (doc.format === 'pdf') {
      const result = extractPdfText(bytes)
      if (result.warnings.includes('no_text_layer')) {
        throw new ProviderError('no_text_layer', 'PDF 未检测到文本层（可能是扫描件），需要 OCR 支持——当前未接入')
      }
      return this.extraction.extract({ format: 'pdf', fileName: doc.file_name, pages: result.pages })
    }

    if (doc.format === 'edi' || doc.format === 'txt') {
      const text = bytes.toString('utf8')
      if (doc.format === 'edi') {
        const message = parseEdifact(text)
        assertSupportedType(message)
        return this.extraction.extract({ format: 'edi', fileName: doc.file_name, message })
      }
      // 纯文本：按 PDF 文本层同构处理（单页）
      return this.extraction.extract({ format: 'txt', fileName: doc.file_name, pages: [{ pageNumber: 1, text }] })
    }

    // 图片：走 OCR 接入点（未接入 → 明确失败）
    if (!this.ocr.isConfigured()) {
      throw new ProviderError('ocr_not_configured', 'OCR / 视觉模型尚未接入，图片单证暂无法提取字段（等待第五阶段配置）')
    }
    const ocr = await this.ocr.recognize(bytes, doc.format === 'image' ? 'image/*' : 'application/octet-stream', doc.file_name)
    return this.extraction.extract({ format: 'image', fileName: doc.file_name, pages: ocr.pages })
  }

  private persistSuccess(doc: DocumentRow, runId: string, output: Awaited<ReturnType<ExtractionProvider['extract']>>): void {
    const t = nowIso()
    const extracted = output.fields.filter((f) => f.status !== 'missing' && f.status !== 'unavailable')
    const missing = output.fields.filter((f) => f.status === 'missing')
    const low = output.fields.filter((f) => f.status === 'low_confidence')
    const summary =
      `提取 ${extracted.length} 个字段` +
      (low.length ? `（${low.length} 个低置信）` : '') +
      (missing.length ? `，${missing.length} 个适用字段缺失` : '') +
      (output.docType ? `；单证类型：${output.docType}` : '')
    const parseSummary = [summary, ...output.notes].join('；')

    this.db.transaction(() => {
      // 重解析 = 全量替换该文档的提取结果（旧证据失效，审计保留在 runs/activities）
      this.db.run('DELETE FROM extracted_fields WHERE document_id = ?', doc.id)
      for (const f of output.fields) {
        this.db.run(
          `INSERT INTO extracted_fields
             (id, document_id, shipment_id, field_key, value, original_value, source,
              normalized_value, page, position, confidence, status, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'deterministic', ?, ?, ?, ?, ?, ?)`,
          newId('fld'),
          doc.id,
          doc.shipment_id,
          f.fieldKey,
          f.value,
          f.status === 'missing' || f.status === 'unavailable' ? null : f.value,
          f.normalized || null,
          f.page,
          f.position,
          f.confidence,
          f.status,
          t,
        )
      }
      const docType = output.docType && output.docType !== 'unknown' ? output.docType : null
      this.db.run(
        'UPDATE documents SET status = ?, error = NULL, doc_type = COALESCE(?, doc_type), parse_summary = ?, updated_at = ? WHERE id = ?',
        'parsed',
        docType,
        parseSummary,
        t,
        doc.id,
      )
      this.db.run('UPDATE processing_runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?', 'succeeded', t, summary, runId)
      this.db.run('INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)', newId('act'), doc.shipment_id, `解析完成：${doc.file_name}（${summary}）`, t)
    })
  }

  private persistFailure(doc: DocumentRow, runId: string, err: unknown): void {
    const t = nowIso()
    let code = 'unknown_error'
    let message = '解析过程发生未知错误'
    if (err instanceof PdfParseError) {
      code = err.code
      message = `PDF 解析失败：${err.message}`
    } else if (err instanceof EdiParseError) {
      code = err.code
      message = `EDI 解析失败：${err.message}`
    } else if (err instanceof ProviderError) {
      code = err.code
      message = err.message
    } else if (err instanceof Error) {
      message = `解析过程异常：${err.message}`
    }
    this.db.transaction(() => {
      this.db.run('UPDATE documents SET status = ?, error = ?, updated_at = ? WHERE id = ?', 'failed', message, t, doc.id)
      this.db.run('UPDATE processing_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?', 'failed', t, `[${code}] ${message}`, runId)
      this.db.run('INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)', newId('act'), doc.shipment_id, `解析失败：${doc.file_name}（${code}：${message}）`, t)
    })
  }
}

/** 进程内串行解析队列 */
export class ParseQueue {
  private readonly queue: string[] = []
  private readonly queued = new Set<string>()
  private running = false
  private idleWaiters: Array<() => void> = []

  constructor(private readonly runner: (documentId: string) => Promise<void>) {}

  /** 入队（去重）；立即尝试排水 */
  enqueue(documentId: string): void {
    if (this.queued.has(documentId)) return
    this.queued.add(documentId)
    this.queue.push(documentId)
    void this.drain()
  }

  get pending(): number {
    return this.queue.length
  }

  /** 等待队列排空（测试断言与优雅停机前调用，避免竞态） */
  onIdle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private flushIdleWaiters(): void {
    if (this.running || this.queue.length) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!
        this.queued.delete(id)
        try {
          await this.runner(id)
        } catch (err) {
          // 队列永不因单个文档崩溃；pipeline 内部已落库失败原因
          console.error(`[parse-queue] 文档 ${id} 处理异常：`, err)
        }
      }
    } finally {
      this.running = false
      this.flushIdleWaiters()
    }
  }
}
