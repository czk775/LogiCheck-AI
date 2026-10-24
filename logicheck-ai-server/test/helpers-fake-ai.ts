/* ============================================================
   第五阶段 · 假 OpenAI 兼容服务器（测试基建）

   用真实的 HTTP 服务模拟大模型接口，测试走完整网络栈（而非 mock 函数），
   从而验证：请求体格式、鉴权头、超时、错误码分类、重试退避、JSON 解析。
   零外网依赖、零额度消耗。
   ============================================================ */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface CapturedRequest {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

export type Responder = (req: CapturedRequest, callIndex: number) => {
  status?: number
  body: unknown
  /** 延迟毫秒（用于测试超时） */
  delayMs?: number
}
export interface FakeAiServer {
  baseUrl: string
  requests: CapturedRequest[]
  close(): Promise<void>
}

export interface FakeAiServerOptions {
  /** 按调用序返回响应；用尽后重复最后一个 */
  responder: Responder
}

/** 启动一个本地假 OpenAI 兼容服务器 */
export async function startFakeAiServer(options: FakeAiServerOptions): Promise<FakeAiServer> {
  const requests: CapturedRequest[] = []
  let callIndex = 0

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = { __unparsed: raw }
      }
      const captured: CapturedRequest = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        body,
      }
      requests.push(captured)
      const idx = callIndex++

      let outcome: ReturnType<Responder>
      try {
        outcome = options.responder(captured, idx)
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(err) } }))
        return
      }

      const send = () => {
        res.writeHead(outcome.status ?? 200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(outcome.body))
      }
      if (outcome.delayMs) setTimeout(send, outcome.delayMs)
      else send()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/compatible-mode/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 构造一个标准 chat/completions 成功响应 */
export function chatResponse(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

/** 构造一个 OpenAI 风格错误响应 */
export function errorResponse(status: number, message: string, code = 'error'): unknown {
  return { error: { message, type: 'invalid_request_error', param: null, code, status } }
}
