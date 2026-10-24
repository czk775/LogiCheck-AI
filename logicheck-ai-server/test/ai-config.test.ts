/* ============================================================
   第五阶段 · AI 配置层测试

   验证点：
   - AI 参数全部来自环境变量（不落代码、不落库）
   - 缺 Key 时 isConfigured = false（不假装已接通）
   - 密钥不出现在任何可序列化输出中（防止泄漏到 healthz / 日志）
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.ts'

test('PH5CFG1 未配置任何 AI 变量时 ai 为 null（未接通即未接通）', () => {
  const c = loadConfig({} as NodeJS.ProcessEnv)
  assert.equal(c.ai, null, '没有任何 AI 环境变量时不应构造出 ai 配置')
})

test('PH5CFG2 只有 Key 缺模型时视为未配置（避免用错模型名静默失败）', () => {
  const c = loadConfig({
    DASHSCOPE_API_KEY: 'sk-test-1234567890',
  } as NodeJS.ProcessEnv)
  assert.equal(c.ai, null, '缺模型名时不应算作已配置')
})

test('PH5CFG3 Key + 模型齐全时构造出可用配置，密钥只存在于 ai.apiKey', () => {
  const c = loadConfig({
    DASHSCOPE_API_KEY: 'sk-test-1234567890',
    AI_MODEL: 'qwen-plus',
  } as NodeJS.ProcessEnv)
  assert.ok(c.ai, '配置齐全时应有 ai 配置')
  assert.equal(c.ai!.apiKey, 'sk-test-1234567890')
  assert.equal(c.ai!.model, 'qwen-plus')
  assert.equal(c.ai!.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1')
  // 视觉模型缺省与文本模型同源（DashScope 用 qwen-vl-* 系列时由 AI_VISION_MODEL 覆盖）
  assert.equal(c.ai!.visionModel, null)
})

test('PH5CFG4 自定义 baseUrl / 视觉模型 / 超时 / 重试 均可覆盖', () => {
  const c = loadConfig({
    DASHSCOPE_API_KEY: 'sk-test-1234567890',
    AI_MODEL: 'qwen3-vl-plus',
    AI_VISION_MODEL: 'qwen3-vl-plus',
    AI_BASE_URL: 'https://example.test/v1',
    AI_TIMEOUT_MS: '90000',
    AI_MAX_RETRIES: '5',
    AI_MAX_PAGES: '3',
  } as NodeJS.ProcessEnv)
  assert.equal(c.ai!.baseUrl, 'https://example.test/v1')
  assert.equal(c.ai!.visionModel, 'qwen3-vl-plus')
  assert.equal(c.ai!.timeoutMs, 90000)
  assert.equal(c.ai!.maxRetries, 5)
  assert.equal(c.ai!.maxPages, 3)
})

test('PH5CFG5 API Key 不出现在配置的序列化输出里（防日志泄漏）', () => {
  const c = loadConfig({
    DASHSCOPE_API_KEY: 'sk-super-secret-value',
    AI_MODEL: 'qwen-plus',
  } as NodeJS.ProcessEnv)
  const serialized = JSON.stringify(c)
  assert.ok(!serialized.includes('sk-super-secret-value'), '序列化结果不得包含密钥明文')
  // 但内部对象确实持有密钥（供发起请求用）
  assert.equal(c.ai!.apiKey, 'sk-super-secret-value')
})

test('PH5CFG6 脱敏描述不泄漏密钥，可安全展示给用户', () => {
  const c = loadConfig({
    DASHSCOPE_API_KEY: 'sk-super-secret-value',
    AI_MODEL: 'qwen-plus',
  } as NodeJS.ProcessEnv)
  assert.ok(c.ai)
  const safe = JSON.stringify(c.ai!.describe())
  assert.ok(!safe.includes('sk-super-secret-value'), 'describe() 不得包含密钥')
  assert.ok(safe.includes('qwen-plus'), 'describe() 应说明当前模型')
})

test('PH5CFG7 AI 参数缺失时不影响既有配置（阶段一至四回归）', () => {
  const c = loadConfig({
    PORT: '4321',
    DATABASE_PATH: './data/x.db',
    UPLOAD_DIR: './data/u',
    MAIL_OUTBOX_DIR: './data/m',
    SESSION_TTL_DAYS: '3',
    CORS_ORIGIN: 'http://example.test',
  } as NodeJS.ProcessEnv)
  assert.equal(c.port, 4321)
  assert.equal(c.sessionTtlDays, 3)
  assert.equal(c.ai, null)
  assert.equal(c.smtp, null)
})
