/* ============================================================
 * 限流配额解析测试（npm run ai:quota 的核心）
 *
 * 背景：实测发现 GET {baseUrl}/models/quota 不是额度接口（它是「查单个
 *      模型详情」的路由），真实端点是 GET /api/v1/quotas，返回结构是
 *      output.quotas[] + model_limit / workspace_limit。
 *      解析逻辑必须锁定这个真实结构，且解析不到时不编造。
 * ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimits } from '../scripts/lib/quota-parse.ts'

test('PH5RL1 解析真实 /api/v1/quotas 结构：model + model_limit', () => {
  const rows = parseRateLimits({
    code: null,
    success: true,
    output: {
      total: 357,
      page_no: 1,
      page_size: 100,
      quotas: [
        {
          model: 'qwen3.8-flash',
          workspace_id: 'ws-xxx',
          model_limit: {
            request_limit: null,
            usage_limit: 500000,
            usage_limit_field: 'total_tokens',
            usage_limit_period: 6,
          },
          workspace_limit: null,
        },
      ],
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].model, 'qwen3.8-flash')
  assert.equal(rows[0].tokenLimit, 500000)
  assert.equal(rows[0].periodMinutes, 6)
  assert.equal(rows[0].requestLimit, null)
})

test('PH5RL2 request_limit 有值时正确解析', () => {
  const rows = parseRateLimits({
    output: {
      quotas: [
        {
          model: 'qwen3-vl-plus',
          model_limit: { usage_limit: 500000, usage_limit_period: 6, request_limit: 250 },
        },
      ],
    },
  })
  assert.equal(rows[0].requestLimit, 250)
})

test('PH5RL3 workspace_limit 有值时正确解析', () => {
  const rows = parseRateLimits({
    output: {
      quotas: [
        {
          model: 'qwen3.8-max',
          model_limit: { usage_limit: 500000, usage_limit_period: 6 },
          workspace_limit: { usage_limit: 123456 },
        },
      ],
    },
  })
  assert.equal(rows[0].workspaceTokenLimit, 123456)
})

test('PH5RL4 无 model_limit 的条目被跳过（不编造限流值）', () => {
  const rows = parseRateLimits({
    output: { quotas: [{ model: 'some-model', workspace_id: 'ws-1' }] },
  })
  assert.equal(rows.length, 0)
})

test('PH5RL5 完全不同结构返回空数组', () => {
  assert.deepEqual(parseRateLimits({ request_id: 'x' }), [])
  assert.deepEqual(parseRateLimits(null), [])
})

test('PH5RL6 同一模型重复出现只保留一条', () => {
  const rows = parseRateLimits({
    output: {
      quotas: [
        { model: 'qwen3.8-flash', model_limit: { usage_limit: 500000, usage_limit_period: 6 } },
        { model: 'qwen3.8-flash', model_limit: { usage_limit: 999, usage_limit_period: 6 } },
      ],
    },
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tokenLimit, 500000)
})
