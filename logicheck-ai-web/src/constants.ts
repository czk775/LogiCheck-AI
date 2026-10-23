import { apiMode } from './services/api'

/** 全局环境声明（诚实标注当前运行边界，PRD §十二） */
export const DEMO_NOTICE =
  apiMode === 'real'
    ? '本地服务版 · 数据保存在本机服务器（SQLite + 本地文件） · AI 解析尚未接入，提取字段为演示数据'
    : '前端演示版本 · Mock 服务 · 数据仅保存在当前浏览器 · 未连接真实 AI、数据库或身份验证服务'

/** 上传限制（与原型一致） */
export const MAX_FILE_SIZE = 15 * 1024 * 1024
export const ACCEPTED_FILE_TYPES =
  '.pdf,.png,.jpg,.jpeg,.webp,.edi,.edifact,.txt,application/pdf,image/*'
