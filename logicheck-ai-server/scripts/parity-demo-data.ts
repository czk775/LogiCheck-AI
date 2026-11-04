/* Parity 校验：前端 Mock 演示数据 vs 后端 seed —— 必须逐字段一致 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
/** 仓库根目录（本脚本位于 <repo>/logicheck-ai-server/scripts/） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FE = resolve(REPO_ROOT, 'logicheck-ai-web/src/services/mock/demoData.ts')
const BE = resolve(REPO_ROOT, 'logicheck-ai-server/src/modules/demo/seed.ts')

const fe = await import(pathToFileURL(FE).href)
const be = await import(pathToFileURL(BE).href)

// 规则逐字段比对（accessedAt 为访问时间戳：前端取模块加载时间、后端取 seed 时间，语义等价故排除）
assert.equal(fe.DEMO_RULES.length, be.DEMO_RULES.length, '规则数量不一致')
fe.DEMO_RULES.forEach((r: Record<string, unknown>, i: number) => {
  const b = be.DEMO_RULES[i] as Record<string, unknown>
  for (const key of Object.keys(r)) {
    if (key === 'accessedAt') continue
    assert.deepEqual(r[key], b[key], `规则[${i}] 字段 ${key} 不一致：FE=${JSON.stringify(r[key])} BE=${JSON.stringify(b[key])}`)
  }
})
console.log(`✅ 规则 parity：${fe.DEMO_RULES.length} 条 × 全字段一致`)

// 演示货物关键结构比对
const feShip = fe.createDemoShipment()
assert.equal(feShip.name, '便携式可充电蓝牙音箱')
assert.equal(feShip.origin, '中国')
assert.equal(feShip.destination, '德国')
assert.deepEqual(feShip.profile, {
  product: 'Portable Bluetooth Speaker',
  model: 'LS-B200',
  quantity: '待确认（存在冲突）',
  unit: 'PCS',
  origin: 'China',
  destination: 'Germany',
  hs: '8518.21',
  battery: '内置可充电锂电池',
  gross: '420 kg',
}, 'profile 不一致')
assert.equal(feShip.documents.length, 4)
for (const d of feShip.documents) {
  assert.ok(d.fields && Object.keys(d.fields).length > 0, `文档 ${d.fileName} 字段为空`)
}
assert.equal(feShip.findings.length, 3)
assert.deepEqual(feShip.findings.map((f: { id: string }) => f.id), ['f-qty', 'f-red', 'f-hs'])
assert.equal(feShip.runs.length, 1)
assert.match(feShip.runs[0].summary, /数量核验发现 1 项冲突/)
console.log('✅ 演示货物 parity：结构 / profile / findings / runs 一致')
console.log('✅ parity 校验通过')
