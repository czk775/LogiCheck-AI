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

  /**
   * 删除文件；其所在目录仅在「已空」时才清理。
   * 注意：不能直接递归删目录 —— 同一货物的多份单证共用 <userId>/<shipmentId>/ 目录，
   * 替换单证时删旧文件会连带删掉刚写入的新文件（曾导致替换后解析报「文件在存储中缺失」）。
   */
  async remove(key: string): Promise<void> {
    const abs = this.resolveKey(key)
    if (!abs) return
    await rm(abs, { force: true }).catch(() => undefined)
    // 目录为空才删（非空则保留，避免影响同目录其他单证）
    try {
      const { readdir } = await import('node:fs/promises')
      const rest = await readdir(dirname(abs))
      if (rest.length === 0) await rm(dirname(abs), { recursive: true, force: true }).catch(() => undefined)
    } catch {
      /* 目录已不存在或不可读：忽略 */
    }
  }
}
