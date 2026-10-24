/* ============================================================
 * 配额与模型状态查询脚本（npm run ai:quota）
 *
 * 用途：一条命令查看「我们配的模型能不能用、限流是多少、还剩多少免费额度」。
 *
 * 数据来源（均已用真实 Key 实测确认）：
 *   - 限流配额：GET https://dashscope.aliyuncs.com/api/v1/quotas
 *       返回每模型的「每 N 分钟 token 上限 / 请求数上限」
 *   - 免费额度余额：**没有开放 API**，只能看控制台免费额度页
 *       （脚本会明确指出这一点，不拿限流值冒充余额）
 *
 * 历史踩坑（勿回退）：
 *   GET {AI_BASE_URL}/models/quota **不是**额度接口 —— 它是「查单个模型详情」
 *   的路由，返回 "The model 'quota' does not exist"。社区文章有误。
 *   早先用无效 Key 探测时 401 鉴权层先拦截，误以为端点存在。
 *
 * 诚实边界：
 *   - 只读，不改任何配置
 *   - 不打印密钥
 *   - 接口失败时如实报错，不用估算值冒充真实余额
 * ============================================================ */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRateLimits, isVisionModel } from './lib/quota-parse.ts'

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

/* 仅在直接执行本脚本时运行查询；被 import 时只导出纯函数 */
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]

async function main(): Promise<void> {
  const env = { ...process.env, ...readEnvFile(ENV_PATH) }
  const apiKey = env.DASHSCOPE_API_KEY?.trim()
  const baseUrl = (env.AI_BASE_URL?.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '')
  const model = env.AI_MODEL?.trim() || 'qwen3.8-flash'
  const visionModel = env.AI_VISION_MODEL?.trim() || 'qwen3.8-omni-flash'

  console.log('=== LogiCheck AI · 配额与模型状态 ===\n')
  console.log('配置文件：', ENV_PATH, existsSync(ENV_PATH) ? '（已找到）' : '（不存在）')
  console.log('接入地址：', baseUrl)
  console.log('关注模型：', model, '|', visionModel, '\n')

  if (!apiKey) {
    console.error('✗ .env 中没有 DASHSCOPE_API_KEY，无法查询。')
    console.error('  先把 Key 填进 .env（只写在文件里，不要贴到聊天窗口）。')
    console.error('  然后重新执行：npm run ai:quota')
    console.error('\n提示：你也可以先在控制台查看，无需 Key：')
    console.error('  https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
    process.exit(1)
  }

  // 真实限流配额端点（不在 compatible-mode 路径下，需用官方域名）
  const origin = baseUrl.replace(/\/compatible-mode\/v1$/, '')
  const url = `${origin}/api/v1/quotas?page_size=100`
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
      console.error(`✗ 查询失败（HTTP ${res.status}）\n`)
      const errMsg =
        payload && typeof payload === 'object'
          ? String((payload as { error?: { message?: string } }).error?.message ?? '')
          : ''
      console.error('接口返回：', errMsg || text.slice(0, 300) || '（空）')
      console.error('\n排查建议：')
      if (res.status === 401 || res.status === 403) {
        console.error('  - Key 无效或与接入地址不属同一地域（国内 Key 配 dashscope.aliyuncs.com）')
        console.error('  - Key 已被删除或停用')
      }
      console.error('\n控制台查看：https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
      process.exit(1)
    }

    const rows = parseRateLimits(payload)

    if (rows.length === 0) {
      console.log('⚠ 接口请求成功，但没有解析出限流条目。')
      console.log('  原始响应（截断 800 字符）：')
      console.log(JSON.stringify(payload, null, 2).slice(0, 800))
      process.exit(0)
    }

    console.log(`✓ 查询成功（服务端共 ${rows.length} 个模型的限流配置）\n`)

    console.log('【1】我们配置的模型 · 限流情况')
    console.log('-'.repeat(72))
    for (const m of [model, visionModel]) {
      const hit = rows.find((r) => r.model === m)
      if (!hit) {
        console.log(`  ${m.padEnd(24)} ✗ 未在限流配置中找到该模型`)
        continue
      }
      const kind = isVisionModel(hit.model) ? '视觉' : '文本'
      const tokenText =
        hit.tokenLimit !== null
          ? `${hit.tokenLimit.toLocaleString('en-US')} token / ${hit.periodMinutes ?? '?'} 分钟`
          : '未设 token 上限'
      const reqText = hit.requestLimit !== null ? `，${hit.requestLimit} 请求/窗口` : ''
      console.log(`  ${m.padEnd(24)} ✓ ${kind}｜${tokenText}${reqText}`)
    }

    console.log('\n【2】可用的视觉 / OCR 模型（图片与扫描件识别必需）')
    console.log('-'.repeat(72))
    const visionRows = rows.filter((r) => isVisionModel(r.model))
    if (visionRows.length === 0) {
      console.log('  （没有视觉模型 → 扫描件与图片 OCR 无法走 AI）')
    } else {
      for (const r of visionRows.slice(0, 12)) {
        const tokenText = r.tokenLimit !== null ? `${r.tokenLimit.toLocaleString('en-US')} / ${r.periodMinutes ?? '?'}min` : '—'
        console.log('  ' + r.model.padEnd(34) + tokenText.padStart(18))
      }
    }

    console.log('\n【3】可用的文本模型（PDF 文本层字段提取用）')
    console.log('-'.repeat(72))
    const textRows = rows.filter((r) => !isVisionModel(r.model))
    if (textRows.length === 0) {
      console.log('  （没有文本模型）')
    } else {
      for (const r of textRows.slice(0, 12)) {
        const tokenText = r.tokenLimit !== null ? `${r.tokenLimit.toLocaleString('en-US')} / ${r.periodMinutes ?? '?'}min` : '—'
        console.log('  ' + r.model.padEnd(34) + tokenText.padStart(18))
      }
    }

    console.log('\n【4】免费额度余额')
    console.log('-'.repeat(72))
    console.log('  ⚠ 百炼未开放「免费额度余额」查询 API —— 上面的限流值 ≠ 剩余额度。')
    console.log('  实际余额请看控制台（能看到剩余 token、总量、到期日）：')
    console.log('    https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
    console.log('  建议在该页开启「免费额度用完即停」，避免意外从余额扣费。')

    console.log('\n用量参考：')
    console.log('  一次完整联调（自检 + 端到端）约消耗 3~6 万 token')
    console.log('  qwen3.8-flash 限流 50 万 token/6 分钟，单次联调远低于限流，不会触发 429')
    console.log('  若剩余额度偏低，优先把 EXTRACTION_PROVIDER 改回 deterministic')
    process.exit(0)
  } catch (err) {
    console.error('✗ 无法连接查询接口：', err instanceof Error ? err.message : err)
    console.error('\n控制台查看：https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
    process.exit(1)
  }
}

if (isDirectRun) {
  await main()
}
