/* ============================================================
 * 前端领域逻辑校验（AI 状态视图 + 解析错误映射）
 * ------------------------------------------------------------
 * 前端工程未引入测试框架（不想为了跑通流程硬装依赖），
 * 因此用 Node 原生类型剥离跑可执行断言脚本。
 * 覆盖的是「文案映射会不会误导用户」这类高风险逻辑：
 *   - 演示模式绝不能显示成「AI 已连接」
 *   - 未知错误码不能编造原因
 *   - 限流配额绝不能被称作免费额度余额
 * ============================================================ */

import assert from 'node:assert/strict'
import { toAiStatusView, toDocErrorView, isRetryWorthwhile, extractErrorCode } from '../src/services/domain/aiStatus.ts'

let passed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log('  ✓ ' + name)
  } catch (err) {
    console.error('  ✗ ' + name)
    console.error('    ' + (err instanceof Error ? err.message : String(err)))
    process.exitCode = 1
  }
}

console.log('\n=== 前端领域逻辑校验 ===\n')

console.log('[AI 状态视图]')

check('已接通 → 显示「AI 已连接」', () => {
  const v = toAiStatusView(
    {
      configured: true,
      extraction: 'ai',
      ocr: 'ocr',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
      visionModel: 'qwen3.8-omni-flash',
    },
    'real',
  )
  assert.equal(v.label, 'AI 已连接')
  assert.equal(v.tone, 'good')
  assert.ok(v.details.some((d) => d.value === 'qwen3.8-flash'), '详情应含提取模型名')
  assert.ok(v.details.some((d) => d.value === 'qwen3.8-omni-flash'), '详情应含视觉模型名')
})

check('已接通 → 详情不含任何密钥字样', () => {
  const v = toAiStatusView(
    { configured: true, extraction: 'ai', ocr: 'ocr', model: 'x', visionModel: 'y' },
    'real',
  )
  const dumped = JSON.stringify(v)
  assert.ok(!/sk-/i.test(dumped), '不得出现密钥前缀')
  assert.ok(!/api[_-]?key/i.test(dumped), '不得出现 apiKey 字段名')
})

check('已接通 → 详情不含「额度」「余额」字样（限流≠余额）', () => {
  const v = toAiStatusView(
    { configured: true, extraction: 'ai', ocr: 'ocr', model: 'x', visionModel: 'y' },
    'real',
  )
  const text = JSON.stringify(v)
  assert.ok(!/剩余额度|免费额度余额|余额/.test(text), '不得把限流配额称为余额')
})

check('未接通 → 显示「AI 不可用」并给出原因', () => {
  const v = toAiStatusView(
    {
      configured: false,
      extraction: 'deterministic',
      ocr: 'none',
      reason: '未配置 AI 服务（缺少 API Key 或模型名），当前使用确定性提取',
    },
    'real',
  )
  assert.equal(v.label, 'AI 不可用')
  assert.equal(v.tone, 'warn')
  assert.ok(v.hint && v.hint.includes('API Key'))
})

check('Mock 模式 → 绝不显示「AI 已连接」', () => {
  const v = toAiStatusView(
    { configured: true, extraction: 'ai', ocr: 'ocr', model: 'qwen3.8-flash' },
    'mock',
  )
  assert.notEqual(v.label, 'AI 已连接')
  assert.equal(v.label, '演示模式')
  assert.ok(v.hint && v.hint.includes('预置数据'))
})

check('Mock 模式 → 详情含运行模式/提取方式/图片识别', () => {
  const v = toAiStatusView(
    { configured: false, extraction: 'deterministic', ocr: 'none' },
    'mock',
  )
  const labels = v.details.map((d) => d.label)
  assert.ok(labels.includes('运行模式'))
  assert.ok(labels.includes('提取方式'))
  assert.ok(labels.includes('图片识别'))
})

check('未接通 → 详情同样含运行模式/提取方式/图片识别', () => {
  const v = toAiStatusView(
    { configured: false, extraction: 'deterministic', ocr: 'none', reason: '未配置' },
    'real',
  )
  const labels = v.details.map((d) => d.label)
  assert.ok(labels.includes('运行模式'))
  assert.ok(labels.includes('提取方式'))
  assert.ok(labels.includes('图片识别'))
})

check('状态为 null → 提示未知而非谎报已连接', () => {
  const v = toAiStatusView(null, 'real')
  assert.equal(v.label, 'AI 状态未知')
  assert.notEqual(v.label, 'AI 已连接')
})

console.log('\n[解析失败原因映射]')

check('鉴权失败 → 明确提示 Key 无效', () => {
  const v = toDocErrorView('ai_auth_failed: 鉴权失败：API Key 无效')!
  assert.equal(v.title, 'API Key 无效')
  assert.equal(v.known, true)
  assert.ok(v.advice.includes('Key'))
})

check('限流 → 提示稍后重试', () => {
  const v = toDocErrorView('ai_rate_limited: 请求过于频繁')!
  assert.equal(v.title, '调用过于频繁，已被限流')
})

check('额度用尽 → 提示去控制台确认', () => {
  const v = toDocErrorView('ai_quota_exceeded: 免费额度已用完')!
  assert.equal(v.title, '免费额度已用完')
  assert.ok(v.advice.includes('控制台'))
})

check('超时 → 提示可重试', () => {
  const v = toDocErrorView('ai_timeout: 请求超时')!
  assert.equal(v.title, '模型响应超时')
})

check('OCR 未配置 → 指向 AI_VISION_MODEL', () => {
  const v = toDocErrorView('ocr_not_configured: 视觉模型未配置')!
  assert.equal(v.title, '图片识别未启用')
  assert.ok(v.advice.includes('AI_VISION_MODEL'))
})

check('未知错误码 → 不编造原因，仅给通用建议', () => {
  const v = toDocErrorView('[weird_unknown_error] 某种没见过的错')!
  assert.equal(v.title, '解析失败')
  assert.equal(v.known, false)
  assert.equal(v.raw, '[weird_unknown_error] 某种没见过的错', '原始错误必须保留')
})

check('后端方括号码格式 → 正确映射', () => {
  const v = toDocErrorView('[ai_auth_failed] AI 服务鉴权失败：API Key 无效')!
  assert.equal(v.title, 'API Key 无效')
  assert.equal(v.known, true)
})

check('OCR 未配置（方括号码）→ 指向 AI_VISION_MODEL', () => {
  const v = toDocErrorView('[ocr_not_configured] OCR / 视觉模型尚未接入')!
  assert.equal(v.title, '图片识别未启用')
  assert.ok(v.advice.includes('AI_VISION_MODEL'))
})

check('extractErrorCode：方括号码 / 历史冒号格式 / 无码', () => {
  assert.equal(extractErrorCode('[ai_timeout] 响应超时'), 'ai_timeout')
  assert.equal(extractErrorCode('ai_auth_failed: 鉴权失败'), 'ai_auth_failed')
  assert.equal(extractErrorCode('某种中文错误，没有码'), null)
})

check('空错误 → 返回 null（不渲染错误块）', () => {
  assert.equal(toDocErrorView(null), null)
  assert.equal(toDocErrorView(''), null)
  assert.equal(toDocErrorView('   '), null)
})

console.log('\n[是否值得重试]')

check('配额/鉴权类问题 → 重试无意义', () => {
  assert.equal(isRetryWorthwhile('ai_auth_failed'), false)
  assert.equal(isRetryWorthwhile('ai_quota_exceeded'), false)
  assert.equal(isRetryWorthwhile('ocr_not_configured'), false)
})

check('超时/限流/格式类 → 值得重试', () => {
  assert.equal(isRetryWorthwhile('ai_timeout'), true)
  assert.equal(isRetryWorthwhile('ai_rate_limited'), true)
  assert.equal(isRetryWorthwhile('ai_invalid_json'), true)
})

console.log(`\n${process.exitCode ? '✗ 存在失败用例' : `✓ 全部通过（${passed} 条）`}\n`)
