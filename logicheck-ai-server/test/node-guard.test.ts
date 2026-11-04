/* ============================================================
   运行时守卫测试（Node 版本 + SQLite 驱动两条腿）
   ------------------------------------------------------------
   数据库层现在有两条腿：内置 node:sqlite（Node ≥ 22.5）与
   better-sqlite3（任何 Node ≥ 18）。守卫只在两条腿都不可用时
   才拒绝启动，并给出人话错误。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertNodeVersion,
  assertRuntime,
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
  satisfiesMinNode,
} from '../src/core/nodeGuard.ts'

const NONE = { builtin: false, better: false }
const BUILTIN = { builtin: true, better: false }
const BETTER = { builtin: false, better: true }

test('NODEGRD1 两条腿都没有时，低版本与高版本都被拒绝并带指引', () => {
  assert.throws(() => assertRuntime('v20.11.0', NONE), /SQLite 驱动/)
  assert.throws(() => assertRuntime('v22.4.0', NONE), /22\.5/)
  assert.throws(() => assertRuntime('v18.20.4', NONE), /npm install/)
  // 版本够但内置模块加载失败、又没装兜底包 → 同样不可运行
  assert.throws(() => assertRuntime('v22.16.0', NONE), /SQLite 驱动/)
})

test('NODEGRD2 内置可用时放行（含大版本）', () => {
  assert.doesNotThrow(() => assertRuntime('v22.5.0', BUILTIN))
  assert.doesNotThrow(() => assertRuntime('v22.16.0', BUILTIN))
  assert.doesNotThrow(() => assertRuntime('v24.0.0', BUILTIN))
  assert.equal(MIN_NODE_MAJOR, 22)
  assert.equal(MIN_NODE_MINOR, 5)
})

test('NODEGRD3 内置不可用时，better-sqlite3 兜底放行（沙箱低版本场景）', () => {
  assert.doesNotThrow(() => assertRuntime('v22.4.0', BETTER))
  assert.doesNotThrow(() => assertRuntime('v18.20.4', BETTER))
  // 沙箱实测版本：22.13.1 的内置模块未启用，靠兜底驱动运行
  assert.doesNotThrow(() => assertRuntime('v22.13.1', BETTER))
})

test('NODEGRD4 无法解析的版本串不误杀（放行，交由驱动层自然报错）', () => {
  assert.doesNotThrow(() => assertNodeVersion('weird-version'))
  assert.equal(satisfiesMinNode('weird-version'), true)
})

test('NODEGRD5 版本比较边界', () => {
  assert.equal(satisfiesMinNode('v22.5.0'), true)
  assert.equal(satisfiesMinNode('v22.4.9'), false)
  assert.equal(satisfiesMinNode('v21.99.0'), false)
  assert.equal(satisfiesMinNode('v23.0.0'), true)
})
