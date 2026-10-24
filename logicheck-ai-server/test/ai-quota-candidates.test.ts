/* ============================================================
 * 额度候选模型筛选测试
 * ------------------------------------------------------------
 * 背景：控制台截图显示账号有 82 条免费额度记录，模型命名已迭代到
 *      qwen3.8-* 系列，而 .env 里配的 qwen-plus / qwen3-vl-plus
 *      未必在其中。必须能从真实额度列表中：
 *        1) 判定哪些模型具备视觉/OCR 能力（OCR 路径的唯一前提）
 *        2) 判定偏好模型是否精确命中 / 仅命中快照版本 / 需替代
 *        3) 计算额度剩余天数（用于排序与到期提醒）
 *      —— 全部基于接口返回的真实数据，不猜测、不编造。
 * ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQuotaRows,
  hasUsableQuota,
  isVisionModel,
  daysUntil,
  resolveCandidate,
  findUsableModels,
} from '../scripts/lib/quota-parse.ts'

const SAMPLE = {
  data: [
    { model: 'qwen3.8-flash', remaining: 1000000, total: 1000000, expire_time: '2026-11-25' },
    { model: 'qwen3.8-27b', remaining: 1000000, total: 1000000, expire_time: '2026-11-18' },
    { model: 'qwen3-vl-plus', remaining: 1000000, total: 1000000, expire_time: '2026-12-01' },
    { model: 'qwen3-vl-plus-2025-11-20', remaining: 900000, total: 1000000, expire_time: '2026-12-01' },
    { model: 'qwen-vl-ocr', remaining: 800000, total: 1000000, expire_time: '2026-11-30' },
    { model: 'kimi-k3', remaining: 1000000, total: 1000000, expire_time: '2026-11-18' },
    { model: 'deepseek-v4-flash-0731', remaining: 1000000, total: 1000000, expire_time: '2026-10-31' },
    { model: 'qwen-exhausted', remaining: 0, total: 1000000, expire_time: '2026-10-01' },
  ],
}

test('PH5QC1 视觉模型识别：vl / ocr / omni 视为具备视觉能力', () => {
  assert.equal(isVisionModel('qwen3-vl-plus'), true)
  assert.equal(isVisionModel('qwen-vl-ocr'), true)
  assert.equal(isVisionModel('qwen3.8-vl'), true)
  assert.equal(isVisionModel('qwen3-omni-flash'), true)
})

test('PH5QC2 纯文本模型不得被误判为视觉模型', () => {
  assert.equal(isVisionModel('qwen3.8-flash'), false)
  assert.equal(isVisionModel('kimi-k3'), false)
  assert.equal(isVisionModel('deepseek-v4-flash-0731'), false)
  assert.equal(isVisionModel('qwen-plus'), false)
})

test('PH5QC3 剩余天数计算：未来为正、已过期为负', () => {
  const today = new Date('2026-10-24T00:00:00Z')
  assert.equal(daysUntil('2026-11-25', today), 32)
  assert.equal(daysUntil('2026-10-01', today), -23)
  assert.equal(daysUntil(null, today), null, '无到期信息时不得编造天数')
})

test('PH5QC4 偏好模型精确命中 → matchType=exact', () => {
  const rows = parseQuotaRows(SAMPLE)
  const r = resolveCandidate(rows, 'qwen3-vl-plus')
  assert.equal(r.matchType, 'exact')
  assert.equal(r.row?.model, 'qwen3-vl-plus')
})

test('PH5QC5 偏好模型不在列表 → matchType=none，不得凭空给出替代', () => {
  const rows = parseQuotaRows(SAMPLE)
  const r = resolveCandidate(rows, 'qwen-plus')
  assert.equal(r.matchType, 'none')
  assert.equal(r.row, null)
})

test('PH5QC6 仅命中快照版本 → matchType=snapshot，仍可用', () => {
  const rows = parseQuotaRows({
    data: [{ model: 'qwen3-vl-plus-2025-11-20', remaining: 500000 }],
  })
  const r = resolveCandidate(rows, 'qwen3-vl-plus')
  assert.equal(r.matchType, 'snapshot')
  assert.equal(r.row?.model, 'qwen3-vl-plus-2025-11-20')
})

test('PH5QC7 findUsableModels 分离视觉与文本候选，且排除零额度', () => {
  const rows = parseQuotaRows(SAMPLE)
  const usable = findUsableModels(rows)
  assert.ok(usable.vision.some((r) => r.model === 'qwen3-vl-plus'))
  assert.ok(usable.vision.some((r) => r.model === 'qwen-vl-ocr'))
  assert.ok(!usable.vision.some((r) => r.model === 'qwen-exhausted'), '零额度不得进入可用列表')
  assert.ok(usable.text.some((r) => r.model === 'qwen3.8-flash'))
  assert.ok(!usable.text.some((r) => r.model === 'qwen3-vl-plus'), '视觉模型不得混入文本候选')
})

test('PH5QC8 findUsableModels 对空列表返回空数组（不编造候选）', () => {
  const usable = findUsableModels([])
  assert.deepEqual(usable.vision, [])
  assert.deepEqual(usable.text, [])
})

test('PH5QC9 视觉候选按剩余额度降序，便于优先选额度充足的', () => {
  const rows = parseQuotaRows(SAMPLE)
  const usable = findUsableModels(rows)
  const remainings = usable.vision.map((r) => r.remaining ?? 0)
  const sorted = [...remainings].sort((a, b) => b - a)
  assert.deepEqual(remainings, sorted)
})

test('PH5QC10 hasUsableQuota 对零额度仍返回 false（与候选筛选口径一致）', () => {
  const rows = parseQuotaRows(SAMPLE)
  assert.equal(hasUsableQuota(rows, 'qwen-exhausted'), false)
  assert.equal(hasUsableQuota(rows, 'qwen3.8-flash'), true)
})

test('PH5QC11 parseModelList 从 OpenAI 兼容 /models 响应提取模型 code', async () => {
  const { parseModelList } = await import('../scripts/lib/quota-parse.ts')
  const models = parseModelList({
    object: 'list',
    data: [
      { id: 'qwen3.8-flash', object: 'model' },
      { id: 'qwen3.8-omni-flash', object: 'model' },
      { id: 'qwen3.8-flash', object: 'model' },
    ],
  })
  assert.deepEqual(models, ['qwen3.8-flash', 'qwen3.8-omni-flash'], '应去重且保持顺序')
})

test('PH5QC12 parseModelList 对无法识别结构返回空数组（不编造模型名）', async () => {
  const { parseModelList } = await import('../scripts/lib/quota-parse.ts')
  assert.deepEqual(parseModelList({ request_id: 'x', output: {} }), [])
})
