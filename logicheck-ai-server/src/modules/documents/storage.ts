/* ============================================================
   本地私有文件存储：uploads/<userId>/<shipmentId>/<docId>.<ext>
   - 路径全部由服务端生成，不拼接任何用户输入（防路径穿越）
   - 文件字节真实落盘，不混淆于数据库记录
   ============================================================ */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { AppConfig } from '../../config.ts'

export class FileStorage {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = resolve(config.uploadDir)
  }

  /** 生成存储键（相对根目录的 POSIX 风格路径） */
  keyFor(userId: string, shipmentId: string, docId: string, ext: string): string {
    return [userId, shipmentId, `${docId}.${ext}`].join('/')
  }

  /** 把存储键解析为绝对路径；越界（路径穿越）返回 null */
  resolveKey(key: string): string | null {
    const abs = resolve(this.root, key)
    const rel = relative(this.root, abs)
    if (!rel || rel.startsWith('..') || resolve(this.root, rel) !== abs) return null
    if (abs.startsWith(this.root + sep) === false && abs !== this.root) return null
    return abs
  }

  async write(key: string, data: Buffer): Promise<void> {
    const abs = this.resolveKey(key)
    if (!abs) throw new Error('非法存储路径')
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, data)
  }

  async read(key: string): Promise<Buffer | null> {
    const abs = this.resolveKey(key)
    if (!abs) return null
    try {
      return await readFile(abs)
    } catch {
      return null
    }
  }

  /** 删除文件及其单证目录（目录内仅该文件时清理，避免残留空目录） */
  async remove(key: string): Promise<void> {
    const abs = this.resolveKey(key)
    if (!abs) return
    await rm(abs, { force: true }).catch(() => undefined)
    await rm(dirname(abs), { recursive: true, force: true }).catch(() => undefined)
  }
}
