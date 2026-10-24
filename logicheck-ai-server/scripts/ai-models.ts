/* ============================================================
 * 可用模型清单脚本（npm run ai:models）
 *
 * 用途：控制台免费额度页 10 条/页、需翻 9 页，搜索框只认英文 model
 *      code，很容易「找不到 qwen-plus」。这个脚本直接调用开放接口
 *      GET /models，一次列出当前 Key 能调用的所有模型 code，
 *      并标注哪些具备视觉/OCR 能力（图片与扫描件识别必需）。
 *
 * 诚实边界：
 *   - 只读，不改任何配置
 *   - 不打印密钥
 *   - 接口失败时如实报错并引导看控制台，不用硬编码列表冒充真实可用模型
 * ============================================================ */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseModelList, isVisionModel } from './lib/quota-parse.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..')
const ENV_PATH = join(SERVER_DIR, '.env')

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

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

async function main(): Promise<void> {
  const env = { ...process.env, ...readEnvFile(ENV_PATH) }
  const apiKey = env.DASHSCOPE_API_KEY?.trim()
  const baseUrl = (env.AI_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')

  console.log('=== LogiCheck AI · 可用模型清单 ===\n')
  console.log('查询地址：', baseUrl)

  if (!apiKey) {
    console.error('\n✗ .env 中没有 DASHSCOPE_API_KEY，无法查询。')
    console.error('  先把 Key 填进 .env（只写在文件里，不要贴到聊天窗口）。')
    console.error('\n提示：控制台查看可用模型（无需 Key）：')
    console.error('  https://bailian.console.aliyun.com/cn-beijing/model-square')
    process.exit(1)
  }

  const url = `${baseUrl}/models`
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
    })
    const text = await res.text()
    let payload: unknown = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = null
    }

    if (!res.ok) {
      console.error(`\n✗ 查询失败（HTTP ${res.status}）\n`)
      const errMsg =
        payload && typeof payload === 'object'
          ? String((payload as { error?: { message?: string } }).error?.message ?? '')
          : ''
      console.error('接口返回：', errMsg || text.slice(0, 300) || '（空）')
      console.error('\n排查建议：')
      if (res.status === 401 || res.status === 403) {
        console.error('  - Key 无效或与接入地址不属同一地域（国内 Key 配 dashscope.aliyuncs.com）')
      } else if (res.status === 404) {
        console.error('  - 该服务商可能不支持此端点，请改看控制台模型广场')
      }
      console.error('\n控制台查看：https://bailian.console.aliyun.com/cn-beijing/model-square')
      process.exit(1)
    }

    const models = parseModelList(payload)
    if (models.length === 0) {
      console.log('\n⚠ 请求成功，但没有解析出模型列表。')
      console.log('  原始响应（截断 800 字符）：')
      console.log(JSON.stringify(payload, null, 2).slice(0, 800))
      process.exit(0)
    }

    const vision = models.filter(isVisionModel)
    const textModels = models.filter((m) => !isVisionModel(m))

    console.log(`\n✓ 共 ${models.length} 个可用模型\n`)
    console.log('【视觉 / OCR 模型】' + (vision.length ? `（${vision.length} 个）` : '（无）'))
    console.log('─'.repeat(60))
    if (vision.length === 0) {
      console.log('  没有视觉模型 → 图片与扫描件无法用 AI 识别，只能处理带文本层的 PDF')
    } else {
      for (const m of vision) console.log('  ' + m)
    }

    console.log('\n【文本模型】' + (textModels.length ? `（${textModels.length} 个）` : '（无）'))
    console.log('─'.repeat(60))
    for (const m of textModels) console.log('  ' + m)

    console.log('\n把上面任选的 code 填进 .env 即可，例如：')
    console.log('  AI_MODEL=' + (textModels[0] ?? '（无）'))
    console.log('  AI_VISION_MODEL=' + (vision[0] ?? '（无）'))
    process.exit(0)
  } catch (err) {
    console.error('✗ 无法连接查询接口：', err instanceof Error ? err.message : err)
    console.error('\n控制台查看：https://bailian.console.aliyun.com/cn-beijing/model-square')
    process.exit(1)
  }
}

if (isDirectRun) {
  await main()
}
