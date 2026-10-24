import { apiMode } from './services/api'
import type { AiStatus } from './services/api/contracts'

/**
 * 全局环境声明（诚实标注当前运行边界，PRD §十二）
 *
 * 说明文案必须与真实运行状态一致：AI 接通后不得再宣称「尚未接入」，
 * 否则会误导使用者以为模型不可用。运行时状态由后端 /api/system/ai-status 提供。
 */
export function demoNotice(aiStatus?: AiStatus | null): string {
  if (apiMode !== 'real') {
    return '前端演示版本 · Mock 服务 · 数据仅保存在当前浏览器 · 未连接真实 AI、数据库或身份验证服务'
  }
  if (aiStatus?.configured) {
    const model = aiStatus.model ? `（提取模型 ${aiStatus.model}）` : ''
    return `本地服务版 · 数据保存在本机服务器（SQLite + 本地文件） · AI 解析已接通${model} · 提取字段可溯源到原文`
  }
  if (aiStatus && !aiStatus.configured) {
    return '本地服务版 · 数据保存在本机服务器（SQLite + 本地文件） · AI 解析未接通，当前使用确定性提取'
  }
  return '本地服务版 · 数据保存在本机服务器（SQLite + 本地文件） · 正在检测 AI 连接状态'
}

/** 上传限制（与原型一致） */
export const MAX_FILE_SIZE = 15 * 1024 * 1024
export const ACCEPTED_FILE_TYPES =
  '.pdf,.png,.jpg,.jpeg,.webp,.edi,.edifact,.txt,application/pdf,image/*'
