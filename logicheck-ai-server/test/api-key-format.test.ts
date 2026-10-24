/* ============================================================
 * API Key 格式体检测试
 * ------------------------------------------------------------
 * 这些用例刻画的是「用户真实会犯的错」，每一条都对应一次
 * 真实的 401/403 排查。宁可在这里多花时间，也不要在联调时
 * 把问题归因到代码上。
 * ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { checkApiKey, maskKey } from '../scripts/lib/key-format.ts'

test('PH5KF1 正常的百炼 Key 应通过体检', () => {
  const r = checkApiKey('sk-abcdef0123456789abcdef0123456789')
  assert.equal(r.ok, true)
  assert.equal(r.issues.length, 0)
  assert.equal(r.length, 35)
})

test('PH5KF2 未填写 → 报 empty', () => {
  assert.equal(checkApiKey('').issues[0].code, 'empty')
  assert.equal(checkApiKey(undefined).issues[0].code, 'empty')
  assert.equal(checkApiKey('   ').issues[0].code, 'empty')
})

test('PH5KF3 占位符未替换 → 报 placeholder', () => {
  const r = checkApiKey('在这里粘贴你的百炼API Key')
  assert.ok(r.issues.some((i) => i.code === 'placeholder'))
  assert.equal(r.ok, false)
})

test('PH5KF4 复制带首尾空格 → 提示可 trim，且不阻断（程序自动清理）', () => {
  const r = checkApiKey('  sk-abcdef0123456789abcdef0123456789  ')
  const issue = r.issues.find((i) => i.code === 'has_edge_whitespace')
  assert.ok(issue, '应提示首尾空白')
  assert.equal(issue!.severity, 'warn', '首尾空白可自动修复，不应阻断')
  assert.equal(r.shouldTrim, true, '应提示调用方先 trim')
  assert.equal(r.ok, true, '仅首尾空白时不应判为不可用')
})

test('PH5KF5 复制带换行 → 报 has_whitespace', () => {
  const r = checkApiKey('sk-abcdef0123456789\nabcdef0123456789')
  assert.ok(r.issues.some((i) => i.code === 'has_whitespace'))
})

test('PH5KF6 中文输入法全角引号 → 报 has_quote', () => {
  const r = checkApiKey('「sk-abcdef0123456789abcdef0123456789」')
  assert.ok(r.issues.some((i) => i.code === 'has_quote'))
})

test('PH5KF7 全角字符 → 报 has_fullwidth', () => {
  const r = checkApiKey('sk-abcdef0123456789abcdef０１２３')
  assert.ok(r.issues.some((i) => i.code === 'has_fullwidth'))
})

test('PH5KF8 Token Plan Key（sk-sp-）→ 报 token_plan_key 并警告按量付费', () => {
  const r = checkApiKey('sk-sp-abcdef0123456789abcdef0123456789')
  const issue = r.issues.find((i) => i.code === 'token_plan_key')
  assert.ok(issue)
  assert.match(issue!.message, /按量付费/)
})

test('PH5KF9 长度明显偏短 → 报 too_short', () => {
  const r = checkApiKey('sk-abc')
  assert.ok(r.issues.some((i) => i.code === 'too_short'))
})

test('PH5KF10 前缀不对 → 报 bad_prefix', () => {
  const r = checkApiKey('abcdef0123456789abcdef0123456789')
  assert.ok(r.issues.some((i) => i.code === 'bad_prefix'))
})

test('PH5KF11 脱敏预览不泄露完整密钥', () => {
  const m = maskKey('sk-abcdef0123456789abcdef0123456789')
  assert.ok(!m.includes('abcdef0123456789abcdef'), '不得包含中段明文')
  assert.match(m, /^sk-abc/)
  assert.match(m, /6789$/)
})

test('PH5KF12 体检结果绝不回显密钥明文', () => {
  const key = 'sk-abcdef0123456789abcdef0123456789'
  const r = checkApiKey(key)
  const dumped = JSON.stringify(r)
  assert.ok(!dumped.includes(key), '体检结果序列化后不得出现完整密钥')
})

test('PH5KF13 多个问题同时报出（不只报第一个）', () => {
  const r = checkApiKey('「sk-abc 123」')
  const codes = r.issues.map((i) => i.code)
  assert.ok(codes.includes('has_quote'))
  assert.ok(codes.includes('has_whitespace'))
  assert.ok(codes.includes('too_short'))
})
