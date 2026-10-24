/* ============================================================
   第五阶段 · LLM 客户端测试

   覆盖：
   - 请求体与鉴权头符合 OpenAI 兼容协议
   - 错误分类：鉴权失败 / 限流 / 额度不足 / 超时 / 服务异常 / 网络不可达
   - 重试：可重试错误会重试，不可重试错误（鉴权/额度）立即失败
   - JSON 稳健解析：代码块包裹、前后废话、括号配平
   - 密钥绝不出现在错误消息中
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { LlmClient, LlmError, extractJsonPayload } from '../src/modules/parsing/providers/llm/client.ts'
import { chatResponse, errorResponse, startFakeAiServer } from './helpers-fake-ai.ts'

const KEY = 'sk-test-do-not-leak-1234567890'

function client(baseUrl: string, overrides: Partial<{ maxRetries: number; timeoutMs: number }> = {}) {
  return new LlmClient({
    apiKey: KEY,
    baseUrl,
    model: 'qwen-plus',
    timeoutMs: overrides.timeoutMs ?? 5_000,
    maxRetries: overrides.maxRetries ?? 0,
  })
}

test('PH5LLM1 请求体与鉴权头符合 OpenAI 兼容协议', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('{"ok":true}') }) })
  try {
    const c = client(server.baseUrl)
    const out = await c.chat([{ role: 'user', content: 'hello' }])
    assert.equal(out.content, '{"ok":true}')
    assert.equal(server.requests.length, 1)
    const req = server.requests[0]
    assert.equal(req.path, '/compatible-mode/v1/chat/completions')
    assert.equal(req.authorization, `Bearer ${KEY}`)
    assert.equal(req.body.model, 'qwen-plus')
    assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hello' }])
  } finally {
    await server.close()
  }
})

test('PH5LLM2 图片输入走 image_url + base64 data URI', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('ok') }) })
  try {
    const c = client(server.baseUrl)
    await c.chat([
      {
        role: 'user',
        content: [
          { type: 'text', text: '识别这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAABBBB' } },
        ],
      },
    ])
    const content = server.requests[0].body.messages as Array<{ content: unknown }>
    const parts = content[0].content as Array<{ type: string; image_url?: { url: string } }>
    assert.equal(parts[1].type, 'image_url')
    assert.equal(parts[1].image_url!.url, 'data:image/png;base64,AAAABBBB')
  } finally {
    await server.close()
  }
})

test('PH5LLM3 401 鉴权失败 → 不可重试，错误码 auth_failed', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ status: 401, body: errorResponse(401, 'Invalid API-key provided.', 'invalid_api_key') }),
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 3 })
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'auth_failed')
        assert.equal(err.retryable, false)
        return true
      },
    )
    assert.equal(server.requests.length, 1, '鉴权失败不应重试')
  } finally {
    await server.close()
  }
})

test('PH5LLM4 429 限流 → 可重试错误码 rate_limited', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ status: 429, body: errorResponse(429, 'Rate limit reached for requests', 'rate_limit') }),
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 0 })
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'rate_limited')
        assert.equal(err.retryable, true)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('PH5LLM5 429 额度不足/欠费 → 独立错误码 quota_exceeded，不可重试', async () => {
  const server = await startFakeAiServer({
    responder: () => ({
      status: 429,
      body: errorResponse(429, 'You exceeded your current quota, please check your plan and billing details', 'quota'),
    }),
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 3 })
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'quota_exceeded')
        assert.equal(err.retryable, false, '欠费重试无意义')
        return true
      },
    )
    assert.equal(server.requests.length, 1, '额度不足不应重试')
  } finally {
    await server.close()
  }
})

test('PH5LLM6 请求超时 → 错误码 timeout', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ body: chatResponse('late'), delayMs: 300 }),
  })
  try {
    const c = client(server.baseUrl, { timeoutMs: 80, maxRetries: 0 })
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'timeout')
        assert.equal(err.retryable, true)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('PH5LLM7 5xx 服务异常 → 可重试错误码 service_unavailable', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ status: 503, body: errorResponse(503, 'The engine is currently overloaded', 'overloaded') }),
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 0 })
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'service_unavailable')
        assert.equal(err.retryable, true)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('PH5LLM8 可重试错误会按次数重试，最终失败时调用次数 = 1 + maxRetries', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ status: 503, body: errorResponse(503, 'overloaded', 'overloaded') }),
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 2 })
    await assert.rejects(() => c.chat([{ role: 'user', content: 'x' }]), (err: unknown) => {
      assert.ok(err instanceof LlmError)
      return true
    })
    assert.equal(server.requests.length, 3, '应尝试 1 次 + 重试 2 次')
  } finally {
    await server.close()
  }
})

test('PH5LLM9 重试期间若成功则正常返回（不误报失败）', async () => {
  const server = await startFakeAiServer({
    responder: (_req, idx) =>
      idx === 0
        ? { status: 503, body: errorResponse(503, 'overloaded', 'overloaded') }
        : { body: chatResponse('{"ok":1}') },
  })
  try {
    const c = client(server.baseUrl, { maxRetries: 2 })
    const out = await c.chat([{ role: 'user', content: 'x' }])
    assert.equal(out.content, '{"ok":1}')
    assert.equal(server.requests.length, 2)
  } finally {
    await server.close()
  }
})

test('PH5LLM10 服务地址不可达 → 错误码 network_error', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('ok') }) })
  const deadUrl = server.baseUrl
  await server.close()
  const c = client(deadUrl, { maxRetries: 0, timeoutMs: 2_000 })
  await assert.rejects(
    () => c.chat([{ role: 'user', content: 'x' }]),
    (err: unknown) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'network_error')
      return true
    },
  )
})

test('PH5LLM11 错误消息绝不包含 API Key', async () => {
  const server = await startFakeAiServer({
    responder: () => ({ status: 401, body: errorResponse(401, `Invalid API-key provided: ${KEY}`, 'invalid_api_key') }),
  })
  try {
    const c = client(server.baseUrl)
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'x' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.ok(!err.message.includes(KEY), '错误消息不得包含密钥')
        assert.ok(!JSON.stringify(err).includes(KEY), '错误对象序列化不得包含密钥')
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('PH5LLM12 JSON 解析：剥离 Markdown 代码块', () => {
  const payload = extractJsonPayload('```json\n{"docType":"invoice","fields":[]}\n```')
  assert.deepEqual(payload, { docType: 'invoice', fields: [] })
})

test('PH5LLM13 JSON 解析：从前后废话中提取首个完整对象', () => {
  const payload = extractJsonPayload('好的，结果如下：{"docType":"invoice","fields":[{"key":"a"}]} 以上。')
  assert.deepEqual(payload, { docType: 'invoice', fields: [{ key: 'a' }] })
})

test('PH5LLM14 JSON 解析：括号配平（值里含 } 不应截断）', () => {
  const payload = extractJsonPayload('{"note":"含 } 的值","fields":[]}')
  assert.deepEqual(payload, { note: '含 } 的值', fields: [] })
})

test('PH5LLM15 JSON 解析失败 → 抛出可识别错误码 invalid_json', () => {
  assert.throws(
    () => extractJsonPayload('完全不是 JSON'),
    (err: unknown) => {
      assert.ok(err instanceof LlmError)
      assert.equal(err.code, 'invalid_json')
      return true
    },
  )
})

/* ---------- 额度护栏：进程内累计用量上限 ---------- */

test('PH5LLM16 累计用量被如实记录（可观测，不只是限制）', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('ok') }) })
  try {
    const c = client(server.baseUrl)
    await c.chat([{ role: 'user', content: 'a' }])
    await c.chat([{ role: 'user', content: 'b' }])
    const snap = c.usage.snapshot()
    assert.equal(snap.calls, 2, '应记录调用次数')
    assert.equal(snap.promptTokens, 20, '应累计 prompt token')
    assert.equal(snap.completionTokens, 20, '应累计 completion token')
    assert.equal(snap.totalTokens, 40, '应累计总 token')
    assert.equal(snap.exhausted, false)
  } finally {
    await server.close()
  }
})

test('PH5LLM17 累计用量触顶后停止调用模型（额度护栏第二道防线）', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('ok') }) })
  try {
    // 单次调用消耗 20 token（chatResponse 的 usage），限额设为 25
    const c = new LlmClient({
      apiKey: KEY,
      baseUrl: server.baseUrl,
      model: 'qwen-plus',
      timeoutMs: 5_000,
      maxRetries: 0,
      usageLimitTokens: 25,
    })
    await c.chat([{ role: 'user', content: 'a' }])
    assert.equal(c.usage.snapshot().totalTokens, 20)
    assert.equal(c.usage.snapshot().exhausted, false, '尚未触顶')

    // 第二次调用后累计 40 > 25 → 触顶
    await c.chat([{ role: 'user', content: 'b' }])
    assert.equal(c.usage.snapshot().exhausted, true, '应已触顶')

    // 第三次调用必须被拒绝，且不得再发请求
    const callsBefore = server.requests.length
    await assert.rejects(
      () => c.chat([{ role: 'user', content: 'c' }]),
      (err: unknown) => {
        assert.ok(err instanceof LlmError)
        assert.equal(err.code, 'quota_exceeded')
        assert.equal(err.retryable, false, '触顶后不应重试')
        assert.ok(!err.message.includes(KEY), '错误消息不得含密钥')
        return true
      },
    )
    assert.equal(server.requests.length, callsBefore, '触顶后不得再向服务商发请求')
  } finally {
    await server.close()
  }
})

test('PH5LLM18 未配置用量上限时不限制（默认无限）', async () => {
  const server = await startFakeAiServer({ responder: () => ({ body: chatResponse('ok') }) })
  try {
    const c = client(server.baseUrl)
    for (let i = 0; i < 5; i++) await c.chat([{ role: 'user', content: 'x' }])
    assert.equal(c.usage.snapshot().totalTokens, 100)
    assert.equal(c.usage.snapshot().exhausted, false, '未设上限时不应触顶')
    assert.equal(server.requests.length, 5)
  } finally {
    await server.close()
  }
})
