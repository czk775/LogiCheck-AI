/* ============================================================
   免费额度查询脚本（npm run ai:quota）

   用途：一条命令查看「我还有多少免费 token、什么时候过期、够不够用」，
        避免反复切控制台页面。

   数据来源：
     - 主源：GET {AI_BASE_URL}/models/quota（百炼开放接口，返回免费额度余量）
     - 兜底：若该端点不可用，明确提示改看控制台（不编造数据）

   诚实边界：
     - 只读，不改任何配置
     - 不打印密钥
     - 接口失败时如实报错，不用估算值冒充真实余额
   ============================================================ */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseQuotaRows, hasUsableQuota, isVisionModel, daysUntil, resolveCandidate, findUsableModels } from './lib/quota-parse.ts'

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

  console.log('=== LogiCheck AI · 免费额度查询 ===\n')
  console.log('配置文件：', ENV_PATH, existsSync(ENV_PATH) ? '（已找到）' : '（不存在）')
  console.log('查询地址：', baseUrl)
  console.log('关注模型：', model, '|', visionModel, '\n')

  if (!apiKey) {
    console.error('✗ .env 中没有 DASHSCOPE_API_KEY，无法查询。')
    console.error('  先把 Key 填进 .env（只写在文件里，不要贴到聊天窗口）。')
    console.error('  然后重新执行：npm run ai:quota')
    console.error('\n提示：你也可以先在控制台查看，无需 Key：')
    console.error('  https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
    process.exit(1)
  }

  const url = `${baseUrl}/models/quota`
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
      } else if (res.status === 404) {
        console.error('  - 该服务商可能不支持此查询接口，请改看控制台免费额度页面')
      }
      console.error('\n控制台查看：https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
      process.exit(1)
    }

    const rows = parseQuotaRows(payload)

    if (rows.length === 0) {
      console.log('⚠ 接口请求成功，但没有解析出额度条目。')
      console.log('  原始响应（截断 800 字符）：')
      console.log(JSON.stringify(payload, null, 2).slice(0, 800))
      console.log('\n请到控制台确认：https://bailian.console.aliyun.com/cn-beijing/costing-balance/free-quota')
      process.exit(0)
    }

    console.log('✓ 查询成功\n')
    const usable = findUsableModels(rows)

    console.log('【1】.env 当前配置的模型')
    console.log('-'.repeat(72))
    for (const m of [model, visionModel]) {
      const r = resolveCandidate(rows, m)
      if (r.matchType === 'none') {
        console.log(`  ${m.padEnd(24)} ✗ 不在额度列表中（该模型可能未获发新人免费额度）`)
      } else {
        const days = daysUntil(r.row!.expiresAt)
        const dayText = days === null ? '到期未知' : days < 0 ? `已过期 ${-days} 天` : `剩 ${days} 天`
        const kind = isVisionModel(r.row!.model) ? '视觉' : '文本'
        console.log(
          `  ${m.padEnd(24)} ✓ ${kind}｜剩余 ${r.row!.remaining!.toLocaleString('en-US')} token` +
            `｜到期 ${r.row!.expiresAt ?? '未知'}（${dayText}）｜匹配 ${r.matchType}`,
        )
      }
    }

    console.log('\n【2】可用的视觉 / OCR 模型（图片与扫描件识别必需）')
    console.log('-'.repeat(72))
    if (usable.vision.length === 0) {
      console.log('  （额度列表中没有视觉模型 → 扫描件与图片 OCR 无法走 AI，需改用文本模型或充值）')
    } else {
      for (const r of usable.vision.slice(0, 15)) {
        const days = daysUntil(r.expiresAt)
        const dayText = days === null ? '' : days < 0 ? '已过期' : `剩 ${days} 天`
        console.log(
          '  ' + r.model.padEnd(30) + (r.remaining!.toLocaleString('en-US') + ' token').padStart(16) +
            '  ' + (r.expiresAt ?? '—').padEnd(12) + dayText,
        )
      }
    }

    console.log('\n【3】可用的文本模型（PDF 文本层字段提取用）')
    console.log('-'.repeat(72))
    if (usable.text.length === 0) {
      console.log('  （额度列表中没有文本模型）')
    } else {
      for (const r of usable.text.slice(0, 15)) {
        const days = daysUntil(r.expiresAt)
        const dayText = days === null ? '' : days < 0 ? '已过期' : `剩 ${days} 天`
        console.log(
          '  ' + r.model.padEnd(30) + (r.remaining!.toLocaleString('en-US') + ' token').padStart(16) +
            '  ' + (r.expiresAt ?? '—').padEnd(12) + dayText,
        )
      }
    }

    console.log('\n【4】全部额度条目（' + rows.length + ' 条）')
    console.log('-'.repeat(72))
    console.log('模型'.padEnd(34) + '剩余 token'.padStart(16) + '到期'.padStart(14))
    for (const r of rows.slice(0, 100)) {
      const remain = r.remaining!.toLocaleString('en-US')
      const exp = r.expiresAt ?? '—'
      const flag = isVisionModel(r.model) ? ' [视觉]' : ''
      console.log((r.model + flag).padEnd(34) + remain.padStart(16) + exp.padStart(14))
    }

    console.log('\n【5】建议的 .env 配置（可直接抄）')
    console.log('-'.repeat(72))
    const pickVision = usable.vision[0]?.model
    const pickText = usable.text[0]?.model
    if (pickText) {
      console.log('AI_MODEL=' + pickText)
    } else {
      console.log('AI_MODEL=（无可用文本模型，需充值或换账号）')
    }
    if (pickVision) {
      console.log('AI_VISION_MODEL=' + pickVision)
    } else if (pickText) {
      console.log('AI_VISION_MODEL=' + pickText + '   ← 无视觉模型，暂用文本模型（无法识别图片/扫描件）')
    } else {
      console.log('AI_VISION_MODEL=（无可用模型）')
    }
    console.log('EXTRACTION_PROVIDER=ai')

    console.log('\n用量参考：')
    console.log('  一次完整联调（自检 + 端到端）约消耗 3~6 万 token')
    console.log('  100 万 token 大约可支撑 15~30 次完整联调')
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
