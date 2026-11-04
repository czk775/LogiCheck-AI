/* ============================================================
   演示账号启动种子测试（公网部署：体验账号无需注册即可登录）
   ------------------------------------------------------------
   - 空库首次启动即创建 demo@logicheck.ai，可用配置密码登录
   - 重复启动幂等：不重复插入，密码重置为配置值（体验账号永远进得来）
   - 登录表单路径可用（POST /api/auth/login），与 /api/auth/demo 并存
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

const DEMO_EMAIL = 'demo@logicheck.ai'
const DEMO_PASS = 'judge-demo-pass-42'

test.before(async () => {
  env = await createTestEnv({ demoPassword: DEMO_PASS })
})

test.after(async () => {
  await env.cleanup()
})

test('DEMOSEED1 空库启动即创建演示账号，配置密码可登录', async () => {
  const c = env.client()
  const res = await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASS })
  assert.equal(res.status, 200, res.text)
  assert.equal((res.json as { session: { email: string } }).session.email, DEMO_EMAIL)
  // 登录后能看到预置的演示货物（loginDemo 的种子路径同样幂等）
  const list = await c.get('/api/shipments')
  assert.equal(list.status, 200)
})

test('DEMOSEED2 错误密码拒绝登录（账号不是裸奔的）', async () => {
  const c = env.client()
  const res = await c.post('/api/auth/login', { email: DEMO_EMAIL, password: 'wrong-pass' })
  assert.equal(res.status, 401)
})

test('DEMOSEED3 重启后幂等：账号不重复、密码仍是配置值', async () => {
  await env.restart()
  const count = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE email = ?', DEMO_EMAIL)?.n ?? 0
  assert.equal(count, 1, '重启后演示账号应只有一条记录')
  const c = env.client()
  const res = await c.post('/api/auth/login', { email: DEMO_EMAIL, password: DEMO_PASS })
  assert.equal(res.status, 200, res.text)
})
