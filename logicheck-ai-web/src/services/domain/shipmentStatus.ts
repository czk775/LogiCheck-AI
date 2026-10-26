import { apiMode } from '../../services/api'
import type { Shipment, ShipmentDocument, ShipmentStatusCode } from '../../types/domain'

/* ============================================================
   货物 / 单证状态推导 —— 与已确认原型 statusShip / docStatus 一致。
   纯函数，UI 与 Mock 服务共用。

   阶段二起，真实模式（本地服务）的单证状态由后端解析流水线推进：
   uploaded → parsing → parsed | failed（failed 带失败原因）。
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
  if (s.documents.some(isInFlight)) return 'processing'
  if (!s.isDemo) {
    // 真实模式：解析失败 → 检查失败；全部解析完成但尚无合规预检结果 → 证据不足
    // Mock 模式：没有真实解析与引擎 → 待接入 AI（保持原有诚实边界）
    if (s.documents.some((d) => d.status === 'failed')) return 'failed'
    if (apiMode !== 'real') return 'awaiting'
    // 核验引擎已运行过 → 与演示分支同语义按未解决异常推导；
    // 从未跑过核验（如单证尚未解析完）→ 证据不足
    const pending = s.findings.filter((f) => f.status !== 'resolved').length
    if (pending) return 'needs_review'
    const verified = s.runs.some(
      (r) => (r.trigger === 'check' || r.trigger === 'recheck') && r.status !== 'failed' && r.status !== 'running',
    )
    return verified ? 'checked' : 'insufficient'
  }
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
      // 失败带明确原因（OCR 未接入 / 不支持的报文类型 / 无文本层…）
      return { label: '处理失败', tone: 'danger' }
    default:
      // uploaded：文件已保存并进入解析队列
      return { label: '等待解析', tone: 'warn' }
  }
}
