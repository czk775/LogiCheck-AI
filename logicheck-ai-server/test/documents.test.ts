/* ============================================================
   单证管理测试（TDD RED → GREEN）：真实 multipart 上传 + 真实磁盘文件。
   覆盖：鉴权 / 合法上传落盘 / 重启后可取回 / 四类拒绝（类型·大小·空文件·伪装）/
         跨账号隔离（上传·预览·删除）/ 删除 / 重试 / 替换模式。
   ============================================================ */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

test.beforeEach(async () => {
  env = await createTestEnv()
})

test.afterEach(async () => {
  await env.cleanup()
})

async function registerAndLogin(email: string) {
  const c = env.client()
  const res = await c.post('/api/auth/register', { email, password: 'super-secret-123' })
  assert.equal(res.status, 201, res.text)
  return c
}

async function createShipment(c: ReturnType<typeof env.client>, name = '文件测试货物') {
  const res = await c.post('/api/shipments', { name })
  assert.equal(res.status, 201, res.text)
  return (res.json as { shipment: { id: string } }).shipment.id
}

function pngBytes(): Buffer {
  // 合法最小 PNG（1x1 透明）
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  )
}

function form(fields: Array<[string, string]>, files: Array<{ name: string; type: string; bytes: Buffer }>): FormData {
  const fd = new FormData()
  for (const [k, v] of fields) fd.set(k, v)
  for (const f of files) fd.append('files', new Blob([f.bytes], { type: f.type }), f.name)
  return fd
}

test('D1 未登录上传返回 401', async () => {
  const c = env.client()
  const fd = form([], [{ name: 'a.png', type: 'image/png', bytes: pngBytes() }])
  const res = await c.postForm('/api/shipments/SHP-2026-001/documents', fd)
  assert.equal(res.status, 401)
})

test('D2 合法上传：accepted、状态 uploaded、真实落盘且内容一致', async () => {
  const c = await registerAndLogin('uploader@example.com')
  const sid = await createShipment(c)
  const bytes = pngBytes()
  const fd = form([], [
    { name: 'invoice.png', type: 'image/png', bytes },
    { name: 'bol.edi', type: 'text/plain', bytes: Buffer.from('UNB+UNOA:3+SENDER+RECEIVER+260101:0100+SHIPMENT001\'\nUNH+1+IFTMBF\'\n', 'utf8') },
  ])
  const res = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  assert.equal(res.status, 201, res.text)
  const result = res.json as { accepted: Array<{ id: string; fileName: string; status: string; size: number; format: string }>; rejected: unknown[] }
  assert.equal(result.accepted.length, 2, res.text)
  assert.equal(result.rejected.length, 0)
  assert.equal(result.accepted[0].status, 'uploaded', '上传后应为 uploaded（不伪造 AI 解析）')
  assert.equal(result.accepted[0].size, bytes.length)
  assert.equal(result.accepted[1].format, 'edi')

  // 磁盘真实存在
  const doc = result.accepted[0]
  const row = env.db.get<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = ?', doc.id)
  assert.ok(row?.storage_key, 'storage_key 应已记录')
  const abs = join(env.uploadsDir, row.storage_key)
  assert.ok(existsSync(abs), '文件应真实落盘')
  assert.deepEqual(readFileSync(abs), bytes, '磁盘内容应与上传一致')
})

test('D3 重启后文件仍可取回且字节一致（真实持久化）', async () => {
  const c = await registerAndLogin('persist-files@example.com')
  const sid = await createShipment(c)
  const bytes = pngBytes()
  const fd = form([], [{ name: 'persist.png', type: 'image/png', bytes }])
  const up = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const docId = (up.json as { accepted: Array<{ id: string }> }).accepted[0].id

  await env.restart()

  const res = await c.get(`/api/documents/${docId}/content`)
  assert.equal(res.status, 200, res.text)
  const buf = Buffer.from(await res.raw.arrayBuffer())
  assert.deepEqual(buf, bytes)
})

test('D4 不支持的类型被拒绝且不落库', async () => {
  const c = await registerAndLogin('reject-type@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'notes.xyz', type: 'application/octet-stream', bytes: Buffer.from('hello') }])
  const res = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  assert.equal(res.status, 201)
  const result = res.json as { accepted: unknown[]; rejected: Array<{ reason: string }> }
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected.length, 1)
  assert.equal(result.rejected[0].reason, 'unsupported_format')
  const rows = env.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM documents')!.n
  assert.equal(rows, 0, '被拒绝的文件不得入库')
})

test('D5 超过 15MB 被拒绝', async () => {
  const c = await registerAndLogin('reject-large@example.com')
  const sid = await createShipment(c)
  const big = Buffer.alloc(15 * 1024 * 1024 + 1024, 0x41)
  const fd = form([], [{ name: 'huge.pdf', type: 'application/pdf', bytes: big }])
  const res = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  assert.equal(res.status, 201)
  const result = res.json as { accepted: unknown[]; rejected: Array<{ reason: string }> }
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected[0].reason, 'too_large')
})

test('D6 空文件被拒绝', async () => {
  const c = await registerAndLogin('reject-empty@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'empty.pdf', type: 'application/pdf', bytes: Buffer.alloc(0) }])
  const res = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const result = res.json as { accepted: unknown[]; rejected: Array<{ reason: string }> }
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected[0].reason, 'empty_file')
})

test('D7 伪装扩展名（.pdf 内为 PNG）被魔数校验拒绝', async () => {
  const c = await registerAndLogin('reject-fake@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'fake.pdf', type: 'application/pdf', bytes: pngBytes() }])
  const res = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const result = res.json as { accepted: unknown[]; rejected: Array<{ reason: string; message: string }> }
  assert.equal(result.accepted.length, 0)
  assert.equal(result.rejected[0].reason, 'unsupported_format')
  assert.match(result.rejected[0].message, /内容/)
})

test('D8 上传到他人货物返回 404（不暴露存在性）', async () => {
  const alice = await registerAndLogin('alice-files@example.com')
  const bob = await registerAndLogin('bob-files@example.com')
  const sid = await createShipment(alice)
  const fd = form([], [{ name: 'x.png', type: 'image/png', bytes: pngBytes() }])
  const res = await bob.postForm(`/api/shipments/${sid}/documents`, fd)
  assert.equal(res.status, 404)
})

test('D9 文件内容跨账号不可取（404）', async () => {
  const alice = await registerAndLogin('alice-secret@example.com')
  const bob = await registerAndLogin('bob-secret@example.com')
  const sid = await createShipment(alice)
  const fd = form([], [{ name: 'secret.png', type: 'image/png', bytes: pngBytes() }])
  const up = await alice.postForm(`/api/shipments/${sid}/documents`, fd)
  const docId = (up.json as { accepted: Array<{ id: string }> }).accepted[0].id

  const stolen = await bob.get(`/api/documents/${docId}/content`)
  assert.equal(stolen.status, 404, 'B 不得读取 A 的文件')
  const own = await alice.get(`/api/documents/${docId}/content`)
  assert.equal(own.status, 200)
})

test('D10 删除单证：204、文件与记录清除', async () => {
  const c = await registerAndLogin('doc-deleter@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'bye.png', type: 'image/png', bytes: pngBytes() }])
  const up = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const docId = (up.json as { accepted: Array<{ id: string }> }).accepted[0].id
  const storageKey = env.db.get<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = ?', docId)!.storage_key

  const del = await c.delete(`/api/documents/${docId}`)
  assert.equal(del.status, 204)
  assert.equal(existsSync(join(env.uploadsDir, storageKey)), false, '磁盘文件应删除')
  const detail = await c.get(`/api/shipments/${sid}`)
  const docs = (detail.json as { shipment: { documents: unknown[] } }).shipment.documents
  assert.equal(docs.length, 0)
})

test('D11 重试：failed → uploaded', async () => {
  const c = await registerAndLogin('retryer@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'retry.png', type: 'image/png', bytes: pngBytes() }])
  const up = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const docId = (up.json as { accepted: Array<{ id: string }> }).accepted[0].id
  env.db.run('UPDATE documents SET status = ?, error = ? WHERE id = ?', 'failed', '本地文件保存失败', docId)

  const retry = await c.post(`/api/documents/${docId}/retry`)
  assert.equal(retry.status, 200, retry.text)
  const doc = (retry.json as { document: { status: string; error?: string } }).document
  assert.equal(doc.status, 'uploaded')
  assert.equal(doc.error, undefined)
})

test('D12 替换模式：旧文件删除、新文件就位、活动留痕', async () => {
  const c = await registerAndLogin('replacer@example.com')
  const sid = await createShipment(c)
  const first = await c.postForm(`/api/shipments/${sid}/documents`, form([], [{ name: 'v1.png', type: 'image/png', bytes: pngBytes() }]))
  const oldId = (first.json as { accepted: Array<{ id: string }> }).accepted[0].id
  const oldKey = env.db.get<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = ?', oldId)!.storage_key

  const newBytes = Buffer.from(pngBytes())
  const second = await c.postForm(
    `/api/shipments/${sid}/documents`,
    form([['replaceDocumentId', oldId]], [{ name: 'v2.png', type: 'image/png', bytes: newBytes }]),
  )
  const result = second.json as { accepted: Array<{ id: string; fileName: string }> }
  assert.equal(result.accepted.length, 1)
  assert.equal(result.accepted[0].fileName, 'v2.png')
  assert.notEqual(result.accepted[0].id, oldId)
  assert.equal(existsSync(join(env.uploadsDir, oldKey)), false, '旧文件应被替换删除')

  const detail = await c.get(`/api/shipments/${sid}`)
  const shipment = (detail.json as { shipment: { documents: Array<{ fileName: string }>; activities: Array<{ text: string }> } }).shipment
  assert.equal(shipment.documents.length, 1)
  assert.equal(shipment.documents[0].fileName, 'v2.png')
  assert.ok(shipment.activities.some((a) => a.text.includes('替换单证')), '应有替换审计记录')
})

test('D13 content 响应头：inline 预览与正确 MIME', async () => {
  const c = await registerAndLogin('headers@example.com')
  const sid = await createShipment(c)
  const fd = form([], [{ name: 'preview.png', type: 'image/png', bytes: pngBytes() }])
  const up = await c.postForm(`/api/shipments/${sid}/documents`, fd)
  const docId = (up.json as { accepted: Array<{ id: string }> }).accepted[0].id
  const res = await c.get(`/api/documents/${docId}/content`)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.match(res.headers.get('content-disposition') ?? '', /inline/)
})
