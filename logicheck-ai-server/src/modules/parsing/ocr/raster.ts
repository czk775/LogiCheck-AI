/* ============================================================
   扫描件 PDF 光栅化（第五阶段）

   目的：把「没有文本层的 PDF」渲染成逐页 PNG，才能送视觉模型识别。
   为什么不用 mupdf：mupdf 是 AGPL-3.0 许可，商业项目有合规风险。
   本模块采用 pdfjs-dist（Apache-2.0）+ @napi-rs/canvas（MIT），均为宽松许可。

   诚实边界：
     - 加密 PDF → 明确报错（不尝试破解）
     - 损坏 PDF → 明确报错（不返回空白页）
     - 页数上限由调用方控制，避免超大文件耗尽内存
   ============================================================ */

import { createCanvas } from '@napi-rs/canvas'

export class RasterizeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RasterizeError'
  }
}

export interface RasterizedPage {
  pageNumber: number
  /** PNG 字节 */
  png: Buffer
  /** 渲染宽度（像素） */
  width: number
  height: number
}

export interface RasterizeOptions {
  /** 渲染缩放倍数（2 = 144dpi，兼顾清晰度与体积） */
  scale?: number
  /** 最多渲染多少页 */
  maxPages?: number
}

/**
 * 把 PDF 逐页渲染为 PNG。
 * 失败一律抛 RasterizeError（带稳定错误码），绝不返回空数组冒充成功。
 */
export async function rasterizePdfToPng(
  bytes: Buffer,
  options: RasterizeOptions = {},
): Promise<RasterizedPage[]> {
  const scale = options.scale ?? 2
  const maxPages = options.maxPages ?? 8

  if (!bytes.subarray(0, 5).toString('latin1').startsWith('%PDF-')) {
    throw new RasterizeError('not_pdf', '文件不是有效的 PDF（缺少 %PDF- 头）')
  }

  // 动态导入：pdfjs 在 Node 下需走 legacy 构建；只在真正需要光栅化时加载
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(bytes)

  let doc: { numPages: number; getPage(n: number): Promise<unknown> }
  try {
    doc = (await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise) as never
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/password/i.test(msg)) {
      throw new RasterizeError('encrypted_pdf', '扫描件 PDF 已加密，无法渲染（不绕过口令）')
    }
    throw new RasterizeError('pdf_load_failed', `PDF 无法加载（可能已损坏）：${msg}`)
  }

  const total = doc.numPages
  if (!total) throw new RasterizeError('pdf_no_pages', 'PDF 中没有任何页面')

  const limit = Math.min(total, maxPages)
  const pages: RasterizedPage[] = []

  for (let n = 1; n <= limit; n++) {
    const page = (await doc.getPage(n)) as {
      getViewport(o: { scale: number }): { width: number; height: number }
      render(o: unknown): { promise: Promise<void> }
    }
    const viewport = page.getViewport({ scale })
    const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)))
    const ctx = canvas.getContext('2d')
    // 白色背景：透明底在部分模型上会降低可读性
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx as never, viewport, canvas: canvas as never }).promise
    pages.push({
      pageNumber: n,
      png: canvas.toBuffer('image/png'),
      width: canvas.width,
      height: canvas.height,
    })
  }

  if (!pages.length) throw new RasterizeError('pdf_render_empty', 'PDF 渲染结果为空，无法进行识别')
  return pages
}
