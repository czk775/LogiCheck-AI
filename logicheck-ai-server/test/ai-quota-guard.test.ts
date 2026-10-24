/* ============================================================
   第五阶段 · 额度保护护栏测试
   ------------------------------------------------------------
   背景：免费额度每个模型仅约 100 万 Token，若模型输出失控
   （一次调用输出上万 token），会快速烧穿额度。
   护栏：
   - max_tokens：限制单次输出上限（配置项 AI_MAX_OUTPUT_TOKENS）
   - 默认值足够覆盖提取任务的真实需要（几百 token）
   - 未配置时也必须有安全默认值，不能无限输出
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmClient } from '../src/modules/parsing/providers/llm/client.ts'
import { chatResponse, startFakeAiServer } from './helpers-fake-ai.ts'

const KEY = 'sk-test-guard-1234567890'

test('PH5GRD1 未显式配置时使用默认输出上限（防止额度失控）', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('{"ok":true}') }) })
  try {
    const c = new LlmClient({
      apiKey: KEY,
      baseUrl: server.baseUrl,
      model: 'qwen-plus',
      timeoutMs: 5_000,
      maxRetries: 0,
    })
    await c.chat([{ role: 'user', content: 'hello' }])
    const body = server.requests[0].body as { max_tokens?: number }
    assert.equal(typeof body.max_tokens, 'number', '必须携带 max_tokens')
    assert.ok(body.max_tokens! > 0, 'max_tokens 必须为正数')
    assert.ok(body.max_tokens! <= 8192, `默认上限不应过大（实际 ${body.max_tokens}）`)
  } finally {
    await server.close()
  }
})

test('PH5GRD2 显式配置的上限被写入请求体', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('{"ok":true}') }) })
  try {
    const c = new LlmClient({
      apiKey: KEY,
      baseUrl: server.baseUrl,
      model: 'qwen-plus',
      timeoutMs: 5_000,
      maxRetries: 0,
      maxOutputTokens: 1234,
    })
    await c.chat([{ role: 'user', content: 'hello' }])
    const body = server.requests[0].body as { max_tokens?: number }
    assert.equal(body.max_tokens, 1234)
  } finally {
    await server.close()
  }
})

test('PH5GRD3 提取任务用 temperature=0 保证结果稳定可复现', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('{"ok":true}') }) })
  try {
    const c = new LlmClient({
      apiKey: KEY,
      baseUrl: server.baseUrl,
      model: 'qwen-plus',
      timeoutMs: 5_000,
      maxRetries: 0,
    })
    await c.chat([{ role: 'user', content: 'hello' }])
    const body = server.requests[0].body as { temperature?: number }
    assert.equal(body.temperature, 0, '提取任务应固定 temperature=0，保证同输入同输出')
  } finally {
    await server.close()
  }
})
