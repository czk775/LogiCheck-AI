import type { Shipment, ShipmentDocument, ShipmentStatusCode } from '../../types/domain'

/* ============================================================
   货物 / 单证状态推导 —— 与已确认原型 statusShip / docStatus 一致。
   纯函数，UI 与 Mock 服务共用。
   ============================================================ */

export type ChipTone = 'neutral' | 'info' | 'danger' | 'warn' | 'good'

export const SHIPMENT_STATUS_META: Record<ShipmentStatusCode, { label: string; tone: ChipTone }> = {
  draft: { label: '待上传', tone: 'neutral' },
  processing: { label: '预检进行中', tone: 'info' },
  awaiting: { label: '待接入 AI', tone: 'warn' },
  needs_review: { label: '待处理异常', tone: 'danger' },
  insufficient: { label: '证据不足', tone: 'warn' },
  checked: { label: '检查完成', tone: 'good' },
  failed: { label: '检查失败', tone: 'danger' },
}

const isInFlight = (d: ShipmentDocument) => d.status === 'uploading' || d.status === 'parsing'

export function statusShip(s: Shipment): ShipmentStatusCode {
  if (!s.documents.length) return 'draft'
  if (!s.isDemo) return s.documents.some(isInFlight) ? 'processing' : 'awaiting'
  if (s.documents.some(isInFlight)) return 'processing'
  const pending = s.findings.filter((f) => f.status !== 'resolved').length
  if (pending) return 'needs_review'
  return s.documents.some((d) => d.status !== 'parsed') ? 'insufficient' : 'checked'
}

export function countIssues(s: Shipment): number {
  return s.findings.filter((f) => f.status !== 'resolved').length
}

export function docStatusMeta(d: ShipmentDocument): { label: string; tone: ChipTone } {
  switch (d.status) {
    case 'parsed':
      return { label: d.isDemo ? '已解析 · 演示' : '已解析', tone: 'good' }
    case 'uploading':
      return { label: '上传处理中', tone: 'info' }
    case 'parsing':
      return { label: '解析中', tone: 'info' }
    case 'failed':
      return { label: '上传失败', tone: 'danger' }
    default:
      // uploaded：文件已保存，等待真实 AI 解析
      return { label: '待真实 AI 解析', tone: 'warn' }
  }
}
