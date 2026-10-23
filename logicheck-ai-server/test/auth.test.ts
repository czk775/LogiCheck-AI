/* ============================================================
   认证模块测试（TDD RED → GREEN）。
   全部走真实 HTTP + 真实 SQLite 文件，无 Mock。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

test.beforeEach(async () => {
  env = await createTestEnv()
})

test.afterEach(async () => {
  await env.cleanup()
})

test('A1 注册成功：返回会话、写入 httpOnly cookie、密码不明文落库', async () => {
  const c = env.client()
  const res = await c.post('/api/auth/register', { email: 'Alice@Example.com', password: 'super-secret-123' })
  assert.equal(res.status, 201, res.text)
  const session = (res.json as { session: { email: string; isDemoSession: boolean } }).session
  assert.equal(session.email, 'alice@example.com')
  assert.equal(session.isDemoSession, false)

  const row = env.db.get<{ email: string; password_hash: string }>('SELECT email, password_hash FROM users WHERE email = ?', 'alice@example.com')
  assert.ok(row, '用户应已写入数据库')
  assert.ok(row.password_hash.startsWith('scrypt$'), '密码应为 scrypt 哈希')
  assert.ok(!row.password_hash.includes('super-secret-123'), '禁止明文存储密码')

  const cookie = res.headers.get('set-cookie') ?? ''
  assert.match(cookie, /HttpOnly/i, '会话 cookie 必须 httpOnly')
})

test('A2 重复邮箱注册返回 409', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'dup@example.com', password: 'super-secret-123' })
  const res = await c.post('/api/auth/register', { email: 'dup@example.com', password: 'another-secret-99' })
  assert.equal(res.status, 409, res.text)
  assert.equal((res.json as { code: string }).code, 'conflict')
})

test('A3 非法邮箱 / 短密码返回 400', async () => {
  const c = env.client()
  const bad1 = await c.post('/api/auth/register', { email: 'not-an-email', password: 'super-secret-123' })
  assert.equal(bad1.status, 400)
  const bad2 = await c.post('/api/auth/register', { email: 'short@example.com', password: '123' })
  assert.equal(bad2.status, 400)
})

test('A4 登录：错误密码 401 且不泄露差异；正确密码返回会话', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'bob@example.com', password: 'super-secret-123' })

  const wrong = await c.post('/api/auth/login', { email: 'bob@example.com', password: 'wrong-password-1' })
  assert.equal(wrong.status, 401)
  assert.equal((wrong.json as { message: string }).message, '邮箱或密码不正确')

  const noSuch = await c.post('/api/auth/login', { email: 'ghost@example.com', password: 'wrong-password-1' })
  assert.equal(noSuch.status, 401)
  assert.equal((noSuch.json as { message: string }).message, '邮箱或密码不正确')

  const ok = await c.post('/api/auth/login', { email: 'bob@example.com', password: 'super-secret-123' })
  assert.equal(ok.status, 200, ok.text)
  assert.equal((ok.json as { session: { email: string } }).session.email, 'bob@example.com')
})

test('A5 会话保持：带 cookie 查询 /session 返回身份', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'carol@example.com', password: 'super-secret-123' })
  const res = await c.get('/api/auth/session')
  assert.equal(res.status, 200)
  const session = (res.json as { session: { email: string } | null }).session
  assert.equal(session?.email, 'carol@example.com')
})

test('A6 退出：204 且会话失效（数据库行删除）', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'dave@example.com', password: 'super-secret-123' })
  const out = await c.post('/api/auth/logout')
  assert.equal(out.status, 204)
  const after = await c.get('/api/auth/session')
  assert.equal((after.json as { session: unknown }).session, null)
  const count = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n
  assert.equal(count, 0, '退出后会话行应删除')
})

test('A7 持久化：服务重启（重开同一数据库文件）后会话仍然有效', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'erin@example.com', password: 'super-secret-123' })
  await env.restart()
  const after = await c.get('/api/auth/session')
  assert.equal((after.json as { session: { email: string } | null }).session?.email, 'erin@example.com')
})

test('A8 过期会话被拒绝并清理', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'frank@example.com', password: 'super-secret-123' })
  env.db.run('UPDATE sessions SET expires_at = ?', '2020-01-01T00:00:00.000Z')
  const res = await c.get('/api/auth/session')
  assert.equal((res.json as { session: unknown }).session, null)
  const count = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n
  assert.equal(count, 0)
})

test('A9 找回密码：统一回包不泄露存在性；邮件写入本地发件箱且含重置链接', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'grace@example.com', password: 'super-secret-123' })

  const existing = await c.post('/api/auth/password/forgot', { email: 'grace@example.com' })
  assert.equal(existing.status, 200)
  const ghost = await c.post('/api/auth/password/forgot', { email: 'nobody@example.com' })
  assert.equal(ghost.status, 200)
  assert.deepEqual(existing.json, ghost.json, '两种情况响应必须一致，不泄露邮箱是否注册')

  const mails = env.readOutbox()
  assert.equal(mails.length, 1, '仅已注册邮箱收到邮件')
  assert.match(mails[0].to, /grace@example\.com/)
  const tokenMatch = mails[0].text.match(/token=([A-Za-z0-9_-]+)/)
  assert.ok(tokenMatch, '邮件应包含重置令牌')
})

test('A10 重置密码：成功后旧会话全部失效、令牌单次使用', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'heidi@example.com', password: 'super-secret-123' })
  await c.post('/api/auth/password/forgot', { email: 'heidi@example.com' })
  const token = env.readOutbox()[0].text.match(/token=([A-Za-z0-9_-]+)/)![1]

  // 快照旧会话 cookie 到独立客户端（模拟另一台设备上的登录态）
  const oldDevice = env.client()
  oldDevice.cookie = c.cookie

  const res = await c.post('/api/auth/password/reset', { token, newPassword: 'brand-new-pass-456' })
  assert.equal(res.status, 200, res.text)

  const oldSession = await oldDevice.get('/api/auth/session')
  assert.equal((oldSession.json as { session: unknown }).session, null, '旧会话应被吊销')

  const login = await c.post('/api/auth/login', { email: 'heidi@example.com', password: 'brand-new-pass-456' })
  assert.equal(login.status, 200, '新密码应可登录')

  const reuse = await c.post('/api/auth/password/reset', { token, newPassword: 'third-password-789' })
  assert.equal(reuse.status, 400, '重置令牌必须单次使用')
})

test('A11 过期重置令牌返回 400', async () => {
  const c = env.client()
  await c.post('/api/auth/register', { email: 'ivan@example.com', password: 'super-secret-123' })
  await c.post('/api/auth/password/forgot', { email: 'ivan@example.com' })
  const token = env.readOutbox()[0].text.match(/token=([A-Za-z0-9_-]+)/)![1]
  env.db.run('UPDATE password_resets SET expires_at = ?', '2020-01-01T00:00:00.000Z')
  const res = await c.post('/api/auth/password/reset', { token, newPassword: 'brand-new-pass-456' })
  assert.equal(res.status, 400)
})

test('A12 演示账号一键登录：isDemoSession=true 且可重复进入', async () => {
  const c = env.client()
  const res = await c.post('/api/auth/demo')
  assert.equal(res.status, 200, res.text)
  const session = (res.json as { session: { email: string; isDemoSession: boolean } }).session
  assert.equal(session.isDemoSession, true)
  const again = await c.post('/api/auth/demo')
  assert.equal(again.status, 200)
})
