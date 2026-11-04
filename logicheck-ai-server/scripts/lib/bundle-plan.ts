/* ============================================================
   发布 bundle 规划（纯函数，无 IO —— 可单测）
   ------------------------------------------------------------
   公网发布的安全底线：密钥（.env）绝不进入发布产物。
   本模块提供两道可机器验证的保障：
   1. findSecretHits：扫描产物文本中是否夹带真实密钥值或
       常见密钥格式（sk-...），命中即报
   2. BUNDLE_FIXTURES：评估夹具清单（eval 功能随包发布所需）
   ============================================================ */

/** 评估夹具（与 eval.ts FILES 一致；随 bundle 发布，公网评估功能可用） */
export const BUNDLE_FIXTURES = [
  '01_Commercial_Invoice_1000PCS.pdf',
  '02_Packing_List_1000PCS.pdf',
  '03_Packing_List_CONFLICT_900PCS.pdf',
  '04_Invoice_OCR_Image.png',
  '05_Invoice_Scanned_ImageOnly.pdf',
  '06_Invoice_INVOIC_EDIFACT.edi',
  '07_EU_Declaration_of_Conformity.pdf',
  'ground_truth.json',
] as const

/** 低于该长度的值不参与密钥扫描（避免 PORT=4000 之类误报） */
const MIN_SECRET_LEN = 8

export interface ScannableFile {
  path: string
  text: string
}

/**
 * 在产物文件中查找夹带的密钥。
 * @param files 产物文件（path + 文本内容）
 * @param secretValues 真实密钥值（来自本地 .env；绝不会写进产物）
 * @returns 命中描述列表；空数组 = 干净
 */
export function findSecretHits(files: ScannableFile[], secretValues: readonly string[]): string[] {
  const hits: string[] = []
  const values = secretValues.map((v) => v.trim()).filter((v) => v.length >= MIN_SECRET_LEN)
  for (const f of files) {
    for (const v of values) {
      if (f.text.includes(v)) hits.push(`${f.path}: 夹带密钥值（长度 ${v.length}）`)
    }
    // 常见密钥格式扫描（与具体值无关）：OpenAI/百炼风格 sk- 开头
    if (/sk-[A-Za-z0-9]{16,}/.test(f.text)) hits.push(`${f.path}: 疑似 API Key 格式（sk-…）`)
    // DashScope / 阿里云风格长 key
    if (/\b(?:LTAI|AK)[A-Za-z0-9]{16,}\b/.test(f.text)) hits.push(`${f.path}: 疑似阿里云 AccessKey 格式`)
  }
  return hits
}

/** 发布产物的环境变量模板（只有占位符，没有任何真实值） */
export const ENV_TEMPLATE = `# LogiCheck AI 公网部署 · 环境变量模板
# 用法：在发布平台的应用配置里逐项添加（若平台支持环境变量）；
#       平台不支持时，保持缺省即可启动（AI 自动降级为确定性提取）。
#       本文件只有占位符，绝不填写真实密钥。

# ===== 必填（不配则服务仍可启动，但 AI 功能不可用）=====
# 大模型 API Key（百炼 DashScope 或任何 OpenAI 兼容服务商）
DASHSCOPE_API_KEY=
# 提取模型名（配置 Key 后必须同时配置，否则视为未接通）
AI_MODEL=qwen3.8-flash
# 视觉/OCR 模型名（留空复用 AI_MODEL）
AI_VISION_MODEL=qwen3.8-omni-flash

# ===== 可选（有合理默认值）=====
# AI 调用超时（毫秒；实测 DashScope 峰值 92-119s，建议 ≥180000）
AI_TIMEOUT_MS=180000
# 单账号每日 AI 解析份数上限（0=不限制；公网建议 50）
AI_DAILY_PARSE_LIMIT=50
# 每账号每分钟上传次数 / 每 IP 每分钟 API 请求上限（0=不限制）
UPLOAD_RATE_PER_MIN=10
API_RATE_PER_MIN=600
# 演示账号密码（体验登录用；非密钥）
DEMO_PASSWORD=demo1234
# CORS 来源（同端口部署可不管）
CORS_ORIGIN=
`
