/* ============================================================
   评估夹具目录解析测试（TDD RED → GREEN）
   ------------------------------------------------------------
   本地开发：夹具在项目根（服务端目录的上一级）。
   公网 bundle：夹具随包放在服务端目录下的 fixtures/。
   环境变量 UAT_FIXTURES_DIR 始终优先。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { resolveFixtureDir } from '../src/modules/system/eval.ts'

/** 用真实绝对路径构造（Windows 下 '/srv' 不是合法绝对路径，会触发 resolve 漂移） */
const SRV = resolve(process.cwd(), 'srv-under-test')

test('FIXDIR1 环境变量优先', () => {
  const dir = resolveFixtureDir(SRV, { UAT_FIXTURES_DIR: '/custom/fixtures' }, () => true)
  assert.equal(dir, '/custom/fixtures')
})

test('FIXDIR2 无环境变量时优先 bundle 内的 fixtures/（公网部署）', () => {
  const expected = resolve(SRV, 'fixtures')
  const dir = resolveFixtureDir(SRV, {}, (p) => p === expected)
  assert.equal(dir, expected)
})

test('FIXDIR3 无 fixtures/ 时回退项目根（本地开发行为不变）', () => {
  const dir = resolveFixtureDir(SRV, {}, () => false)
  assert.equal(dir, resolve(SRV, '..'))
})
