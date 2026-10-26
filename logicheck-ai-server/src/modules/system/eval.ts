/* ============================================================
   AI 评估（Eval）—— 最小可用版本

   目标：用固定的 UAT 单证 + ground_truth.json，对三项核心能力做
   **真实**评估（走真实大模型，不写死任何准确率）：

   1. 字段提取准确率：AI 提取的关键字段 vs 标准答案
   2. 跨单证冲突识别：正常单证无数量冲突；冲突单证识别出 1000 vs 900 PCS
   3. 证据引用有效性：AI 引用的原文片段是否真实存在于对应单证中

   复用现有能力（不重造轮子）：
   - buildExtractionPrompt / parseAiResponse / verifyFieldQuote / NORMALIZERS
     （与生产提取链路完全相同的提示词、结构校验、引用核验、标准化规则）
   - crossCheckShipment（与核验引擎相同的跨单证比对纯函数）
   - VisionOcrProvider（扫描件 / 图片走与生产相同的视觉 OCR）
   - DeterministicExtractionProvider（EDI 走与生产相同的确定性段映射）

   诚实边界：
   - 评估调用与生产调用走同一个 LlmClient（task='eval'），
     因此「AI 运行概览」里的用量包含评估消耗，不 duplicated 统计
   - 任何失败（AI 未配置、夹具缺失、模型返回异常）都如实报错，
     不用历史结果或估算值冒充
   ============================================================ */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PdfPage } from '../parsing/schema.ts'
import type { FieldKey } from '../parsing/schema.ts'
import { extractPdfText } from '../parsing/pdf/text.ts'
import { parseEdifact, assertSupportedType } from '../parsing/edi/parse.ts'
import { DeterministicExtractionProvider } from '../parsing/providers/deterministic.ts'
import type { OcrProvider } from '../parsing/providers/types.ts'
import {
  buildExtractionPrompt,
  NORMALIZERS,
  parseAiResponse,
} from '../parsing/providers/ai/provider.ts'
import { verifyFieldQuote, type AiFieldClaim } from '../parsing/providers/ai/verify.ts'
import { extractJsonPayload, LlmClient } from '../parsing/providers/llm/client.ts'
import { crossCheckShipment } from '../checking/crossCheck.ts'
import { normalizeQuantity } from '../parsing/schema.ts'

/* ---------- 夹具与标准答案 ---------- */

const HERE = dirname(fileURLToPath(import.meta.url))
/** 服务端目录（src/modules/system → 上三级） */
const SERVER_DIR = resolve(HERE, '..', '..', '..')

/**
 * 解析 UAT 夹具目录：
 * 1. 环境变量 UAT_FIXTURES_DIR 优先（测试/特殊部署）
 * 2. 服务端目录下 fixtures/（公网 bundle：夹具随包发布）
 * 3. 项目根目录（本地开发：夹具在仓库根）
 */
export function resolveFixtureDir(
  serverDir: string,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string {
  const fromEnv = env.UAT_FIXTURES_DIR?.trim()
  if (fromEnv) return fromEnv
  const bundled = resolve(serverDir, 'fixtures')
  if (exists(bundled)) return bundled
  return resolve(serverDir, '..')
}

const FIXTURE_DIR = resolveFixtureDir(SERVER_DIR, process.env, existsSync)

const FILES = {
  invoice: '01_Commercial_Invoice_1000PCS.pdf',
  packing: '02_Packing_List_1000PCS.pdf',
  conflictPacking: '03_Packing_List_CONFLICT_900PCS.pdf',
  ocrImage: '04_Invoice_OCR_Image.png',
  scanned: '05_Invoice_Scanned_ImageOnly.pdf',
  edi: '06_Invoice_INVOIC_EDIFACT.edi',
  compliance: '07_EU_Declaration_of_Conformity.pdf',
} as const

type FileKey = keyof typeof FILES

interface GroundTruth {
  baseline: Record<string, string | number>
  expected_checks: Record<string, string>
  expected_ocr: Record<string, string | number>
}

/* ---------- 结果结构 ---------- */

export interface EvalFieldItem {
  file: string
  field: string
  expected: string
  actual: string
  ok: boolean
}

export interface EvalConflictCase {
  name: string
  files: string[]
  expected: 'consistent' | 'conflict'
  actual: string
  ok: boolean
  summary: string
}

export interface EvalEvidenceItem {
  file: string
  field: string
  quote: string
  page: number | null
  ok: boolean
}

export interface EvalSections {
  extraction: { total: number; matched: number; accuracy: number; items: EvalFieldItem[] }
  conflict: { total: number; passed: number; cases: EvalConflictCase[] }
  evidence: { total: number; valid: number; rate: number; items: EvalEvidenceItem[] }
}

export type EvalStatus = 'running' | 'done' | 'error'

export interface EvalReport extends EvalSections {
  status: EvalStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  error?: string
  /** 参与评估的样本总数（字段项 + 冲突用例 + 证据项） */
  samples: number
}

/* ---------- 字段期望（来自 ground_truth.json，不硬编码结论） ---------- */

/** 文本类字段：大小写不敏感比较 */
const TEXT_FIELDS = new Set<FieldKey>(['product', 'model', 'unit', 'shipper', 'consignee'])

/** ground_truth.baseline → 字段键 */
const BASELINE_FIELDS: Array<{ key: FieldKey; from: keyof GroundTruth['baseline'] }> = [
  { key: 'invoice_number', from: 'invoice_no' },
  { key: 'quantity', from: 'quantity' },
  { key: 'unit', from: 'unit' },
  { key: 'unit_price', from: 'unit_price' },
  { key: 'total_amount', from: 'invoice_total' },
  { key: 'currency', from: 'currency' },
  { key: 'invoice_date', from: 'date' },
  { key: 'incoterms', from: 'incoterm' },
  { key: 'gross', from: 'gross_weight_kg' },
  { key: 'net_weight', from: 'net_weight_kg' },
  { key: 'cartons', from: 'cartons' },
  { key: 'hs', from: 'hs_code' },
]

/** ground_truth.expected_ocr → 字段键（图片 / 扫描件） */
const OCR_FIELDS: Array<{ key: FieldKey; from: keyof GroundTruth['expected_ocr'] }> = [
  { key: 'invoice_number', from: 'invoice_no' },
  { key: 'quantity', from: 'quantity' },
  { key: 'currency', from: 'currency' },
  { key: 'total_amount', from: 'total' },
]

/** 每份单证评估哪些字段（只评估该单证文本中真实存在、且有标准答案的字段） */
const FILE_FIELDS: Record<FileKey, Array<{ key: FieldKey; from: string }>> = {
  // 发票文本只含商务字段（无重量/箱数），不评估发票中不存在的字段
  invoice: [
    { key: 'invoice_number', from: 'baseline' },
    { key: 'quantity', from: 'baseline' },
    { key: 'unit', from: 'baseline' },
    { key: 'unit_price', from: 'baseline' },
    { key: 'total_amount', from: 'baseline' },
    { key: 'currency', from: 'baseline' },
    { key: 'invoice_date', from: 'baseline' },
    { key: 'incoterms', from: 'baseline' },
    { key: 'hs', from: 'baseline' },
  ],
  packing: [
    { key: 'quantity', from: 'baseline' },
    { key: 'unit', from: 'baseline' },
    { key: 'cartons', from: 'baseline' },
    { key: 'gross', from: 'baseline' },
    { key: 'net_weight', from: 'baseline' },
  ],
  // 冲突装箱单是另一票货物（900 PCS），ground truth 只定义数量期望与单位；
  // 其箱数/重量与 baseline 无关，无标准答案，不评估
  conflictPacking: [
    { key: 'quantity', from: 'conflict' },
    { key: 'unit', from: 'baseline' },
  ],
  ocrImage: OCR_FIELDS.map((f) => ({ key: f.key, from: 'ocr' })),
  scanned: OCR_FIELDS.map((f) => ({ key: f.key, from: 'ocr' })),
  // 合规声明没有字段级标准答案（ground_truth 只说明其「未经证实」），只参与证据评估
  compliance: [],
  edi: [],
}

/** 跨单证冲突识别用例（期望直接来自 ground_truth.expected_checks） */
const CONFLICT_CASES: Array<{ name: string; docs: FileKey[]; expected: 'consistent' | 'conflict' }> = [
  { name: '发票 vs 正常装箱单', docs: ['invoice', 'packing'], expected: 'consistent' },
  { name: '发票 vs 冲突装箱单', docs: ['invoice', 'conflictPacking'], expected: 'conflict' },
  { name: '发票 vs EDIFACT', docs: ['invoice', 'edi'], expected: 'consistent' },
]

/* ---------- 单份单证的提取结果 ---------- */

interface DocExtraction {
  fileKey: FileKey
  fileName: string
  /** 提取来源：ai（文本层）/ ocr+ai（视觉识别）/ deterministic（EDI） */
  source: string
  /** 模型给出的原始字段声明（含未通过核验的） */
  claims: AiFieldClaim[]
  /** 通过引用核验的声明（生产链路会采信的） */
  accepted: AiFieldClaim[]
  /** 文本页（证据核验基准；EDI 为 null） */
  pages: PdfPage[] | null
}

/* ---------- 工具 ---------- */

function readFixture(fileKey: FileKey): Buffer {
  const p = join(FIXTURE_DIR, FILES[fileKey])
  if (!existsSync(p)) {
    throw new Error(`UAT 夹具缺失：${p}（可通过 UAT_FIXTURES_DIR 指定目录）`)
  }
  return readFileSync(p)
}

function readGroundTruth(): GroundTruth {
  const p = join(FIXTURE_DIR, 'ground_truth.json')
  if (!existsSync(p)) {
    throw new Error(`标准答案缺失：${p}（可通过 UAT_FIXTURES_DIR 指定目录）`)
  }
  return JSON.parse(readFileSync(p, 'utf8')) as GroundTruth
}

/** 期望值取值（baseline / ocr / conflict 三种来源） */
function expectedValue(gt: GroundTruth, from: string, key: FieldKey): string {
  if (from === 'baseline') {
    const entry = BASELINE_FIELDS.find((f) => f.key === key)!
    const raw = gt.baseline[entry.from as string]
    return raw === undefined ? '' : String(raw)
  }
  if (from === 'ocr') {
    const entry = OCR_FIELDS.find((f) => f.key === key)!
    const raw = gt.expected_ocr[entry.from as string]
    return raw === undefined ? '' : String(raw)
  }
  // conflict：从 expected_checks.invoice_vs_conflict_packing 的描述中取冲突侧数量
  const text = gt.expected_checks.invoice_vs_conflict_packing ?? ''
  const nums = text.match(/\d+/g) ?? []
  return nums.length >= 2 ? nums[1] : ''
}

/** Eval 本地标准化表：生产 NORMALIZERS + cartons（"100 CTNS" → "100"，与数量同一取数规则） */
const EVAL_NORMALIZERS: Partial<Record<FieldKey, (raw: string) => string | null>> = {
  ...NORMALIZERS,
  cartons: (raw) => normalizeQuantity(raw),
}

/** 期望值与实际值的比较（用生产同一条标准化规则；cartons 扩展为取数值） */
function compareField(key: FieldKey, expectedRaw: string, actualRaw: string | null): { ok: boolean; expected: string; actual: string } {
  const norm = EVAL_NORMALIZERS[key]
  const expected = norm ? norm(expectedRaw) ?? expectedRaw : expectedRaw
  const actual = actualRaw === null ? '' : norm ? norm(actualRaw) ?? actualRaw : actualRaw
  const eq = TEXT_FIELDS.has(key)
    ? expected.trim().toLowerCase() === actual.trim().toLowerCase()
    : expected === actual
  return { ok: eq, expected, actual }
}

/** 取单证文本页：PDF 文本层 → 扫描件走视觉 OCR；图片直接 OCR */
async function loadPages(
  fileKey: FileKey,
  bytes: Buffer,
  ocr: OcrProvider,
): Promise<{ pages: PdfPage[]; source: string }> {
  const fileName = FILES[fileKey]
  if (fileKey === 'ocrImage') {
    if (!ocr.isConfigured()) throw new Error(`视觉 OCR 未接入，无法识别图片单证 ${fileName}`)
    const r = await ocr.recognize(bytes, 'image/png', fileName)
    return { pages: r.pages, source: 'ocr+ai' }
  }
  const text = extractPdfText(bytes)
  if (text.warnings.includes('no_text_layer')) {
    if (!ocr.isConfigured()) throw new Error(`视觉 OCR 未接入，无法识别扫描件 ${fileName}`)
    const r = await ocr.recognize(bytes, 'application/pdf', fileName)
    return { pages: r.pages, source: 'ocr+ai' }
  }
  return { pages: text.pages, source: 'ai' }
}

/** 走真实大模型提取（与生产链路相同的提示词 / 结构校验 / 引用核验） */
async function extractWithAi(
  fileKey: FileKey,
  bytes: Buffer,
  client: LlmClient,
  ocr: OcrProvider,
): Promise<DocExtraction> {
  const fileName = FILES[fileKey]
  const { pages, source } = await loadPages(fileKey, bytes, ocr)
  if (!pages.length) throw new Error(`${fileName} 没有得到任何文本页，无法提取`)

  const res = await client.chat(
    [
      { role: 'system', content: '你是单证字段提取器，只输出 JSON。' },
      { role: 'user', content: buildExtractionPrompt(pages) },
    ],
    'eval',
  )
  const { claims } = parseAiResponse(extractJsonPayload(res.content))

  const accepted: AiFieldClaim[] = []
  for (const claim of claims) {
    const v = verifyFieldQuote(claim, pages)
    if (v.accepted) accepted.push(claim)
  }
  return { fileKey, fileName, source, claims, accepted, pages }
}

/** EDI：与生产相同，走确定性段映射（不调用大模型） */
async function extractEdi(fileKey: FileKey, bytes: Buffer): Promise<DocExtraction> {
  const fileName = FILES[fileKey]
  const message = parseEdifact(bytes.toString('utf8'))
  assertSupportedType(message)
  const provider = new DeterministicExtractionProvider()
  const out = await provider.extract({ format: 'edi', fileName, message })
  const claims: AiFieldClaim[] = out.fields
    .filter((f) => f.status !== 'missing' && f.status !== 'unavailable')
    .map((f) => ({ key: f.fieldKey, value: f.value, quote: '', page: null }))
  return { fileKey, fileName, source: 'deterministic', claims, accepted: claims, pages: null }
}

/* ---------- 评估主流程 ---------- */

export interface EvalDeps {
  /** 提取链路客户端（与生产同一个实例，task='eval'）；null = AI 未配置 */
  extractionClient: LlmClient | null
  /** OCR 提供者（扫描件 / 图片） */
  ocr: OcrProvider
}

const EMPTY_SECTIONS: EvalSections = {
  extraction: { total: 0, matched: 0, accuracy: 0, items: [] },
  conflict: { total: 0, passed: 0, cases: [] },
  evidence: { total: 0, valid: 0, rate: 0, items: [] },
}

/** 执行一次完整评估（真实调用；抛错即失败，由调用方转成 error 状态） */
export async function runEvaluation(deps: EvalDeps): Promise<EvalSections> {
  const client = deps.extractionClient
  if (!client) {
    throw new Error('AI 未配置：请在服务端 .env 填入 DASHSCOPE_API_KEY 与 AI_MODEL 后重启服务，再运行评估')
  }
  const ocr = deps.ocr
  const gt = readGroundTruth()

  /* 1) 逐份单证提取（AI 链路；EDI 走确定性） */
  const docs: DocExtraction[] = []
  for (const key of ['invoice', 'packing', 'conflictPacking', 'ocrImage', 'scanned', 'compliance'] as FileKey[]) {
    docs.push(await extractWithAi(key, readFixture(key), client, ocr))
  }
  docs.push(await extractEdi('edi', readFixture('edi')))

  /* 2) 字段提取准确率 */
  const items: EvalFieldItem[] = []
  for (const doc of docs) {
    for (const spec of FILE_FIELDS[doc.fileKey]) {
      const expectedRaw = expectedValue(gt, spec.from, spec.key)
      if (!expectedRaw) continue
      const verified = doc.accepted.find((c) => c.key === spec.key)
      const unverified = doc.claims.find((c) => c.key === spec.key && !doc.accepted.includes(c))
      const actualRaw = verified ? verified.value : null
      const cmp = compareField(spec.key, expectedRaw, actualRaw)
      items.push({
        file: doc.fileName,
        field: spec.key,
        expected: cmp.expected,
        actual: verified ? cmp.actual : unverified ? `未采信（${unverified.value}）` : '未提取到',
        ok: cmp.ok && !!verified,
      })
    }
  }
  const matched = items.filter((i) => i.ok).length

  /* 3) 跨单证冲突识别（复用核验引擎的纯函数） */
  const cases: EvalConflictCase[] = []
  for (const c of CONFLICT_CASES) {
    const docFields = new Map<string, { fileName: string; fields: Map<string, string> }>()
    for (const key of c.docs) {
      const doc = docs.find((d) => d.fileKey === key)!
      const fields = new Map<string, string>()
      for (const claim of doc.accepted) fields.set(claim.key, claim.value)
      docFields.set(key, { fileName: doc.fileName, fields })
    }
    const results = crossCheckShipment(docFields)
    const qty = results.find((r) => r.fieldKey === 'quantity')
    const actual = qty?.status ?? 'no_data'
    cases.push({
      name: c.name,
      files: c.docs.map((k) => FILES[k]),
      expected: c.expected,
      actual,
      ok: actual === c.expected,
      summary: qty?.summary ?? '未得到数量比对结论',
    })
  }
  const passed = cases.filter((c) => c.ok).length

  /* 4) 证据引用有效性（AI 声明级；EDI 为确定性提取，不参与） */
  const evidenceItems: EvalEvidenceItem[] = []
  for (const doc of docs) {
    if (!doc.pages) continue
    for (const claim of doc.claims) {
      const v = verifyFieldQuote(claim, doc.pages)
      evidenceItems.push({
        file: doc.fileName,
        field: claim.key,
        quote: claim.quote.length > 60 ? `${claim.quote.slice(0, 60)}…` : claim.quote,
        page: v.page,
        ok: v.accepted,
      })
    }
  }
  const valid = evidenceItems.filter((i) => i.ok).length

  return {
    extraction: {
      total: items.length,
      matched,
      accuracy: items.length ? round2(matched / items.length) : 0,
      items,
    },
    conflict: { total: cases.length, passed, cases },
    evidence: {
      total: evidenceItems.length,
      valid,
      rate: evidenceItems.length ? round2(valid / evidenceItems.length) : 0,
      items: evidenceItems,
    },
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/* ---------- 运行器（进程内单次运行，避免并发评估烧额度） ---------- */

export class AiEvalRunner {
  private report: EvalReport | null = null
  private running = false

  constructor(private readonly deps: EvalDeps) {}

  snapshot(): EvalReport | null {
    return this.report
  }

  /** 启动一次评估；已在运行时返回当前状态（不重复启动） */
  start(): EvalReport {
    if (this.running && this.report) return this.report
    this.running = true
    const startedAt = new Date().toISOString()
    this.report = { ...EMPTY_SECTIONS, status: 'running', startedAt, samples: 0 }
    void this.execute(startedAt)
    return this.report
  }

  private async execute(startedAt: string): Promise<void> {
    const t0 = Date.now()
    try {
      const sections = await runEvaluation(this.deps)
      this.report = {
        ...sections,
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        samples:
          sections.extraction.total + sections.conflict.total + sections.evidence.total,
      }
    } catch (err) {
      this.report = {
        ...EMPTY_SECTIONS,
        status: 'error',
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
        samples: 0,
      }
    } finally {
      this.running = false
    }
  }
}
