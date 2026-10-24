/* ============================================================
   AI 连通性自检脚本（npm run ai:check）

   用途：填好 .env 后，先用一条命令确认「Key 有效 + 模型可用 + 输出格式正常」，
        再去跑完整业务流程，避免把额度浪费在失败的联调上。

   行为：
     - 读取服务端 .env（只读，不写回，不打印密钥）
     - 发起一次最小化的真实调用
     - 打印：是否连通、模型名、耗时、token 消耗、返回内容前若干字符
     - 失败时按错误类型给出可执行建议（鉴权/限流/额度/超时/网络）

   退出码：0 = 连通且返回合法 JSON；1 = 失败
   ============================================================ */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LlmClient, LlmError } from '../src/modules/parsing/providers/llm/client.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..')
const ENV_PATH = join(SERVER_DIR, '.env')

/** 读取 .env（支持 KEY=value / KEY="value" / # 注释） */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

const env = { ...process.env, ...readEnvFile(ENV_PATH) }

const apiKey = env.DASHSCOPE_API_KEY?.trim()
const model = env.AI_MODEL?.trim()

console.log('=== LogiCheck AI · 大模型连通性自检 ===\n')
console.log('配置文件：', ENV_PATH, existsSync(ENV_PATH) ? '（已找到）' : '（不存在）')

if (!apiKey || !model) {
  console.error('\n✗ 未检测到完整配置。')
  console.error('  需要两个变量同时存在：')
  console.error('    DASHSCOPE_API_KEY = 你的百炼 API Key')
  console.error('    AI_MODEL         = qwen-plus（或其它可用模型名）')
  console.error('\n操作步骤：')
  console.error('  1) 打开百炼控制台创建 Key：https://bailian.console.aliyun.com/')
  console.error('  2) 复制 .env.example 为 .env（同一目录）')
  console.error('  3) 在 .env 中填入上面两个变量')
  console.error('  4) 重新执行：npm run ai:check')
  console.error('\n（密钥请只写在 .env 里，不要贴到聊天窗口或代码中）')
  process.exit(1)
}

const baseUrl = (env.AI_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
const visionModel = env.AI_VISION_MODEL?.trim()
const timeoutMs = Number(env.AI_TIMEOUT_MS || 60_000)
const maxRetries = Number(env.AI_MAX_RETRIES ?? 2)

console.log('接入地址：', baseUrl)
console.log('提取模型：', model)
console.log('视觉模型：', visionModel || '（复用提取模型）')
console.log('密钥状态：已配置（' + apiKey.length + ' 字符，不显示内容）\n')

const client = new LlmClient({ apiKey, baseUrl, model, timeoutMs, maxRetries })

const started = Date.now()
try {
  const res = await client.chat([
    {
      role: 'system',
      content: '你是一个单证字段提取器，只输出 JSON。',
    },
    {
      role: 'user',
      content:
        '从下面的单证文本中提取字段。只输出 JSON，格式为 {"docType":"invoice","fields":[{"key":"invoice_number","value":"...","quote":"...","page":1}]}。\n' +
        '找不到的字段不要输出。\n\n' +
        '[第1页]\nCOMMERCIAL INVOICE\nInvoice No: INV-CHECK-0001\nInvoice Date: 2024-03-15\nTotal Amount: USD 1,000.00',
    },
  ])
  const elapsed = Date.now() - started
  console.log('✓ 连通成功\n')
  console.log('实际模型：', res.model)
  console.log('耗时：    ', elapsed, 'ms')
  if (res.usage) {
    console.log('token：   ', JSON.stringify(res.usage))
  }
  console.log('返回内容：', res.content.slice(0, 600))
  console.log('\n下一步：')
  console.log('  1) 把 .env 里的 EXTRACTION_PROVIDER 改为 ai')
  console.log('  2) 重启后端：npm run dev')
  console.log('  3) 上传真实 PDF / 图片单证，验证字段提取与跨单证核验')
  process.exit(0)
} catch (err) {
  const elapsed = Date.now() - started
  console.error('\n✗ 连通失败（耗时 ' + elapsed + ' ms）\n')
  if (err instanceof LlmError) {
    console.error('错误类型：', err.code)
    console.error('说明：    ', err.userMessage)
    console.error('可重试：  ', err.retryable ? '是' : '否')
    console.error('HTTP 状态：', err.statusCode || '（无，网络层失败）')
    if (err.code === 'auth_failed') {
      console.error('\n排查建议：')
      console.error('  - Key 是否复制完整（不要带空格或换行）')
      console.error('  - Key 与 AI_BASE_URL 是否属于同一地域')
      console.error('  - Key 是否已启用 / 是否被停用')
    } else if (err.code === 'quota_exceeded') {
      console.error('\n排查建议：前往百炼控制台检查账户余额与免费额度。')
    } else if (err.code === 'rate_limited') {
      console.error('\n排查建议：稍后重试；如频繁出现可调低并发或提高 AI_MAX_RETRIES。')
    } else if (err.code === 'invalid_json') {
      console.error('\n排查建议：模型未按 JSON 输出。可尝试更换模型名（如 qwen-plus）或重试。')
    }
  } else {
    console.error('未知错误：', err)
  }
  process.exit(1)
}
