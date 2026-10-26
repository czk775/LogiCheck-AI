/* ============================================================
   发布 bundle 安全扫描测试（TDD RED → GREEN）
   ------------------------------------------------------------
   安全底线：密钥绝不进入发布产物。扫描逻辑必须先红后绿。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { findSecretHits, BUNDLE_FIXTURES } from '../scripts/lib/bundle-plan.ts'

const REAL_KEY = 'abc123def456ghi789jkl012mno345pqr'

test('BNDL1 产物中夹带真实密钥值 → 命中', () => {
  const hits = findSecretHits(
    [{ path: 'dist/config.js', text: `const key = "${REAL_KEY}"` }],
    [REAL_KEY],
  )
  assert.equal(hits.length, 1)
  assert.match(hits[0], /dist\/config\.js/)
})

test('BNDL2 干净产物 → 零命中', () => {
  const hits = findSecretHits(
    [
      { path: 'package.json', text: '{"name":"logicheck-ai-server"}' },
      { path: 'src/app.ts', text: 'const port = process.env.PORT ?? 4000' },
      { path: 'public/index.html', text: '<html><body>LogiCheck</body></html>' },
    ],
    [REAL_KEY, 'another-secret-value-9876'],
  )
  assert.deepEqual(hits, [])
})

test('BNDL3 sk- 格式密钥即使不在密钥清单也命中（格式扫描）', () => {
  const hits = findSecretHits(
    [{ path: 'leftover.txt', text: 'key=sk-verylonglookingkey1234567890abcd' }],
    [],
  )
  assert.equal(hits.length, 1)
  assert.match(hits[0], /sk-/)
})

test('BNDL4 短值不参与扫描（避免 PORT=4000 误报）', () => {
  const hits = findSecretHits(
    [{ path: 'config.js', text: 'port = 4000' }],
    ['4000', 'abc'],
  )
  assert.deepEqual(hits, [])
})

test('BNDL5 阿里云 AccessKey 格式命中', () => {
  const hits = findSecretHits([{ path: 'x.js', text: 'LTAI5tGhKlMnOpQrStUvWxYz0123456789' }], [])
  assert.equal(hits.length, 1)
})

test('BNDL6 夹具清单覆盖评估所需的 8 个文件', () => {
  assert.equal(BUNDLE_FIXTURES.length, 8)
  assert.ok(BUNDLE_FIXTURES.includes('07_EU_Declaration_of_Conformity.pdf'))
  assert.ok(BUNDLE_FIXTURES.includes('ground_truth.json'))
})
