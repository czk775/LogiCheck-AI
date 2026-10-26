/* ============================================================
   Node 版本守卫测试
   ------------------------------------------------------------
   服务端依赖 Node 内置 node:sqlite（需 ≥ 22.5）。发布沙箱的 Node
   版本未知，启动时必须给出人话错误，而不是抛出
   ERR_UNKNOWN_BUILTIN_MODULE 让运维/评委一头雾水。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNodeVersion, MIN_NODE_MAJOR, MIN_NODE_MINOR } from '../src/core/nodeGuard.ts'

test('NODEGRD1 低于 22.5 的版本被拒绝并带迁移指引', () => {
  assert.throws(() => assertNodeVersion('v20.11.0'), /node:sqlite/)
  assert.throws(() => assertNodeVersion('v22.4.0'), /22\.5/)
  assert.throws(() => assertNodeVersion('v18.20.4'), /node:sqlite/)
})

test('NODEGRD2 22.5 及以上放行（含大版本）', () => {
  assert.doesNotThrow(() => assertNodeVersion('v22.5.0'))
  assert.doesNotThrow(() => assertNodeVersion('v22.16.0'))
  assert.doesNotThrow(() => assertNodeVersion('v24.0.0'))
  assert.equal(MIN_NODE_MAJOR, 22)
  assert.equal(MIN_NODE_MINOR, 5)
})

test('NODEGRD3 无法解析的版本串不误杀（放行，由 import 层自然报错）', () => {
  assert.doesNotThrow(() => assertNodeVersion('weird-version'))
})
