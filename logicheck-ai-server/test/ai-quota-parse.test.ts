/* ============================================================
   免费额度解析逻辑测试（npm run ai:quota 的核心）

   为什么需要测试：服务商返回的 JSON 结构可能调整，
   解析逻辑必须对多种结构都稳健，且绝不能把「解析不到」
   伪装成「额度为 0」。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseQuotaRows, hasUsableQuota } from '../scripts/lib/quota-parse.ts'

test('PH5QT1 解析标准结构：data 数组含 model + remaining', () => {
  const rows = parseQuotaRows({
    data: [
      { model: 'qwen-plus', remaining: 950000, total: 1000000, expire_time: '2026-12-20' },
      { model: 'qwen3-vl-plus', remaining: 800000, total: 1000000, expire_time: '2026-12-20' },
    ],
  })
  assert.equal(rows.length, 2)
  const p = rows.find((r) => r.model === 'qwen-plus')!
  assert.equal(p.remaining, 950000)
  assert.equal(p.total, 1000000)
  assert.equal(p.expiresAt, '2026-12-20')
})

test('PH5QT2 兼容 camelCase 与嵌套 output 结构', () => {
  const rows = parseQuotaRows({
    output: {
      quotas: [
        { modelName: 'qwen-plus', remainingTokens: 12345, totalTokens: 1000000, expiresAt: '2026-11-01' },
      ],
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'qwen-plus')
  assert.equal(rows[0].remaining, 12345)
  assert.equal(rows[0].total, 1000000)
  assert.equal(rows[0].expiresAt, '2026-11-01')
})

test('PH5QT3 无额度模型不应被误认为有额度（不编造数据）', () => {
  const rows = parseQuotaRows({
    data: [{ model: 'qwen-max', remaining: 0, total: 1000000 }],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].remaining, 0)
  assert.equal(hasUsableQuota(rows, 'qwen-max'), false, 'remaining=0 必须判定为不可用')
})

test('PH5QT4 完全无法识别结构时返回空数组（不得凭空造一条）', () => {
  const rows = parseQuotaRows({ request_id: 'abc', output: { total: 0, page_no: 1 } })
  assert.equal(rows.length, 0)
})

test('PH5QT5 时间戳型到期时间可转为可读日期', () => {
  const rows = parseQuotaRows({
    data: [{ model: 'qwen-plus', remaining: 100, expire_time: 1798761600000 }],
  })
  assert.equal(rows.length, 1)
  assert.match(rows[0].expiresAt!, /^\d{4}-\d{2}-\d{2}$/)
})

test('PH5QT6 同一模型重复出现时只保留一条', () => {
  const rows = parseQuotaRows({
    data: [
      { model: 'qwen-plus', remaining: 500 },
      { model: 'qwen-plus', remaining: 999 },
    ],
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].remaining, 500, '应保留首次出现的记录')
})

test('PH5QT7 hasUsableQuota 需精确命中或前缀匹配', () => {
  const rows = parseQuotaRows({
    data: [
      { model: 'qwen-plus', remaining: 10 },
      { model: 'qwen3-vl-plus-2025-11-20', remaining: 20 },
    ],
  })
  assert.equal(hasUsableQuota(rows, 'qwen-plus'), true)
  assert.equal(hasUsableQuota(rows, 'qwen3-vl-plus'), true, '快照版本应视为同一系列可用')
  assert.equal(hasUsableQuota(rows, 'qwen-max'), false)
})
