/* ============================================================
   前后端同端口部署 · 前端静态托管测试
   ------------------------------------------------------------
   公网发布只暴露一个端口：Fastify 必须同时承担 API 与前端产物托管。
   期望行为：
   - GET /                        → 200 text/html（index.html）
   - GET /shipments/xxx 等前端路由 → 200 text/html（SPA 回退）
   - GET /assets/app.js           → 200 原样内容 + 正确 Content-Type
   - GET /api/不存在的路由          → 404 JSON（不被 SPA 回退吞掉）
   - GET /assets/不存在的文件       → 404（有扩展名的真实 404，不回退）
   - 未配置 webDistDir             → / 为普通 404（本地 API-only 行为不变）
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestEnv, type TestEnv } from './helpers.ts'

let env: TestEnv
let distDir: string

/** 造一个最小前端产物目录：index.html + assets/app.js */
function makeDistDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'logicheck-dist-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>LogiCheck AI 工作台</title><div id="root">SPA-ROOT</div>', 'utf8')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("logicheck-asset-marker")', 'utf8')
  return dir
}

test.before(async () => {
  distDir = makeDistDir()
  env = await createTestEnv({ webDistDir: distDir })
})

test.after(async () => {
  await env.cleanup()
  rmSync(distDir, { recursive: true, force: true })
})

test('WEB1 GET / 返回前端 index.html（200 + text/html）', async () => {
  const res = await env.client().get('/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(res.text, /LogiCheck AI 工作台/)
})

test('WEB2 未知前端路由回退 index.html（SPA 直接打开工作台链接可用）', async () => {
  const res = await env.client().get('/shipments/SHP-2026-001')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/html/)
  assert.match(res.text, /SPA-ROOT/)
})

test('WEB3 静态资源按原样返回（内容 + Content-Type）', async () => {
  const res = await env.client().get('/assets/app.js')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /javascript/)
  assert.match(res.text, /logicheck-asset-marker/)
})

test('WEB4 /api 未知路由返回 JSON 404（不被 SPA 回退吞掉）', async () => {
  const res = await env.client().get('/api/no-such-endpoint')
  assert.equal(res.status, 404)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.equal((res.json as { code?: string } | null)?.code, 'not_found')
})

test('WEB5 不存在的静态资源返回 404（有扩展名不回退 index.html）', async () => {
  const res = await env.client().get('/assets/missing.js')
  assert.equal(res.status, 404)
})

test('WEB6 API 正常路由不受静态托管影响（健康检查仍是 JSON）', async () => {
  const res = await env.client().get('/api/healthz')
  assert.equal(res.status, 200)
  assert.equal((res.json as { ok?: boolean } | null)?.ok, true)
})
