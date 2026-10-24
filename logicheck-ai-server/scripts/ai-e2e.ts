/* ============================================================
   真实 AI 端到端联调脚本（npm run ai:e2e）

   用途：配置好 .env 后，用真实文件走完整链路，验证真实模型能力：
        上传 → 解析（真实调用大模型）→ 字段落库（含页码/证据）→ 跨单证核验

   与自动化测试的区别：自动化测试用本地假 AI 服务（零额度、可离线）；
   本脚本连真实服务商，会消耗额度，因此默认只跑一次最小样本。

   退出码：0 = 全部通过；1 = 有环节失败
   ============================================================ */

import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { openDatabase } from '../src/db/index.ts'
import { buildApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(HERE, '..')
const FIXTURES = join(SERVER_DIR, 'test', 'fixtures', 'real')

const log = (...a: unknown[]) => console.log(...a)
const step = (n: number, title: string) => log(`\n[${n}] ${title}`)

/** 读取 .env */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    let v = t.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, eq).trim()] = v
  }
  return out
}

const env = { ...process.env, ...readEnvFile(join(SERVER_DIR, '.env')) }

if (!env.DASHSCOPE_API_KEY?.trim() || !env.AI_MODEL?.trim()) {
  log('✗ 未配置 DASHSCOPE_API_KEY / AI_MODEL —— 请先在服务端 .env 中填写')
  log('  配置完成后执行：npm run ai:check（先自检）→ npm run ai:e2e（本脚本）')
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'logicheck-ai-e2e-'))
const config = loadConfig({
  ...env,
  DATABASE_PATH: join(dir, 'e2e.db'),
  UPLOAD_DIR: join(dir, 'uploads'),
  MAIL_OUTBOX_DIR: join(dir, 'outbox'),
  EXTRACTION_PROVIDER: 'ai',
} as NodeJS.ProcessEnv)

const db = openDatabase(config.databasePath)
const built = buildApp({ config, db })
await built.app.listen({ port: 0, host: '127.0.0.1' })
const port = (built.app.server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

let failures = 0
const check = (ok: boolean, label: string, detail = '') => {
  if (ok) log(`   ✓ ${label}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    log(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

try {
  step(1, '准备账号与货物')
  const email = `ai-e2e-${Date.now()}@test.local`
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Passw0rd!test' }),
  })
  check(reg.status === 201, '注册账号', `HTTP ${reg.status}`)
  const cookie = (reg.headers.get('set-cookie') ?? '').split(';')[0]
  const ship = await fetch(`${base}/api/shipments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: '真实 AI 联调货物' }),
  })
  const shipBody = (await ship.json()) as { shipment: { id: string } }
  const shipmentId = shipBody.shipment.id
  check(!!shipmentId, '创建货物', shipmentId)

  step(2, '检查 AI 状态端点（确认已接通且未泄漏密钥）')
  const statusRes = await fetch(`${base}/api/system/ai-status`)
  const status = (await statusRes.json()) as Record<string, unknown>
  log('   ', JSON.stringify(status))
  check(status.configured === true, 'AI 状态：已接通')
  check(!JSON.stringify(status).includes(env.DASHSCOPE_API_KEY!), 'AI 状态未泄漏密钥')

  const upload = async (fileName: string, contentType: string) => {
    const buf = readFileSync(join(FIXTURES, fileName))
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array(buf)], { type: contentType }), fileName)
    const res = await fetch(`${base}/api/shipments/${shipmentId}/documents`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
    return res.status
  }

  step(3, '上传真实发票 PDF（两页，含文本层）')
  check((await upload('real-invoice.pdf', 'application/pdf')) === 201, '上传 real-invoice.pdf')

  step(4, '上传真实装箱单 PDF（数量故意与发票不一致：900 vs 1000）')
  check((await upload('real-packing.pdf', 'application/pdf')) === 201, '上传 real-packing.pdf')

  step(5, '等待真实 AI 解析完成')
  const deadline = Date.now() + 180_000
  let docs: Array<{ file_name: string; status: string; error: string | null; doc_type: string; parse_summary: string | null; extraction_provider: string | null }> = []
  while (Date.now() < deadline) {
    docs = db.all('SELECT file_name, status, error, doc_type, parse_summary, extraction_provider FROM documents ORDER BY created_at ASC')
    if (docs.length >= 2 && docs.every((d) => d.status === 'parsed' || d.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  for (const d of docs) {
    log(`   ${d.file_name}: status=${d.status} type=${d.doc_type} provider=${d.extraction_provider}`)
    if (d.parse_summary) log(`     摘要：${d.parse_summary}`)
    if (d.error) log(`     错误：${d.error}`)
  }
  check(docs.every((d) => d.status === 'parsed'), '两份单证均解析成功')

  step(6, '校验 AI 提取字段（含真实页码与原文证据）')
  const fields = db.all<{
    field_key: string; value: string; normalized_value: string | null; page: number | null
    position: string | null; confidence: number | null; status: string; source: string
    evidence_quote: string | null; extraction_model: string | null; document_id: string
  }>(
    `SELECT f.field_key, f.value, f.normalized_value, f.page, f.position, f.confidence,
            f.status, f.source, f.evidence_quote, f.extraction_model, f.document_id
       FROM extracted_fields f JOIN documents d ON d.id = f.document_id
      ORDER BY f.rowid ASC`,
  )
  const extracted = fields.filter((f) => f.status === 'extracted' || f.status === 'low_confidence')
  log(`   提取到 ${extracted.length} 个可采信字段（共 ${fields.length} 条记录）`)
  for (const f of extracted.slice(0, 20)) {
    log(`   ${f.field_key.padEnd(18)} = ${String(f.value).slice(0, 42).padEnd(44)} p${f.page ?? '-'} ${f.position ?? ''} conf=${f.confidence} src=${f.source}`)
    if (f.evidence_quote) log(`       证据：${f.evidence_quote.slice(0, 90)}`)
  }
  check(extracted.length > 0, '至少提取到一个可采信字段')
  check(extracted.every((f) => f.source === 'ai' || f.source === 'ocr+ai'), '来源标记为 AI')
  check(extracted.every((f) => f.page !== null && f.position !== null), '每个可采信字段都有真实页码与位置')
  check(extracted.every((f) => (f.confidence ?? 0) > 0), '每个可采信字段都有置信度')
  check(extracted.some((f) => f.evidence_quote), '至少一个字段带原文证据')

  step(7, '校验跨单证核验（发票 1000 vs 装箱单 900 → 应报冲突）')
  const findings = db.all<{ title: string; summary: string; kind: string; status: string }>(
    'SELECT title, summary, kind, status FROM findings',
  )
  for (const f of findings) log(`   [${f.kind}/${f.status}] ${f.title} — ${f.summary}`)
  const conflict = findings.find((f) => f.kind === 'cross' && /数量/.test(f.title))
  check(!!conflict, '检出跨单证数量冲突')

  step(8, '上传扫描件 PDF（无文本层 → 应走 OCR 路径）')
  check((await upload('real-scan.pdf', 'application/pdf')) === 201, '上传 real-scan.pdf')

  step(9, '上传图片单证（→ 应走视觉 OCR 路径）')
  check((await upload('real-invoice.png', 'image/png')) === 201, '上传 real-invoice.png')

  const deadline2 = Date.now() + 180_000
  while (Date.now() < deadline2) {
    docs = db.all('SELECT file_name, status, error, doc_type, parse_summary, extraction_provider FROM documents ORDER BY created_at ASC')
    if (docs.length >= 4 && docs.every((d) => d.status === 'parsed' || d.status === 'failed')) break
    await new Promise((r) => setTimeout(r, 500))
  }
  for (const d of docs) {
    log(`   ${d.file_name}: status=${d.status} provider=${d.extraction_provider}${d.error ? ` error=${d.error}` : ''}`)
  }
  const ocrDocs = docs.filter((d) => d.extraction_provider === 'ocr+ai')
  check(ocrDocs.length >= 1, '扫描件/图片走 OCR 路径（provider=ocr+ai）')

  step(10, '汇总')
  if (failures === 0) {
    log('   ✅ 真实 AI 端到端联调全部通过')
  } else {
    log(`   ⚠️ ${failures} 项未通过（详见上方标记）`)
  }
} catch (err) {
  failures++
  log('\n✗ 联调过程异常：', err)
} finally {
  await built.app.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

process.exit(failures === 0 ? 0 : 1)
