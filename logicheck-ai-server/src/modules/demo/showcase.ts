/* ============================================================
   演示账号展示数据（公网演示环境用）
   ------------------------------------------------------------
   5 个独立演示账号，每个账号 3–5 票完整历史货物：
   单证（含真实原件，可在线预览）+ 提取字段 + 货物档案 +
   异常（findings，部分已人工处置）+ 处理记录 + 活动流水 +
   规则预检结果（check_results）。

   数据自洽原则：每票货物的提取字段严格对应其所挂原件的真实内容
   （原件取自项目根目录的 UAT 夹具：1000 PCS 发票 / 1000 PCS 装箱单 /
   900 PCS 冲突装箱单 / 扫描件 / OCR 图片 / EDIFACT / 符合性声明）。
   因此打开文件看到的数字与页面上展示的字段一致，不会自相矛盾。

   幂等：账号按 email、货物按固定 ID 判断；文件存在则跳过复制。
   环境重置（数据库与上传目录被清空）后重新启动即可完整恢复。
   ============================================================ */

import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Db } from '../../db/index.ts'
import { newId, nowIso } from '../../core/ids.ts'
import { hashPassword } from '../../core/password.ts'
import type { CheckItemStatus, CheckResultLite, RunStatus, Severity } from '../../types.ts'

/** 种子所需 IO 位置 */
export interface SeedIo {
  /** 上传目录绝对路径（原件的落盘根目录） */
  uploadDir: string
  /** 夹具候选目录（按顺序查找，命中即用） */
  fixtureDirs: readonly string[]
}

/* ---------- 原件清单（UAT 夹具，内容彼此自洽） ---------- */

const FIXTURE = {
  invoice: '01_Commercial_Invoice_1000PCS.pdf',
  packingOk: '02_Packing_List_1000PCS.pdf',
  packingConflict: '03_Packing_List_CONFLICT_900PCS.pdf',
  ocrImage: '04_Invoice_OCR_Image.png',
  scanned: '05_Invoice_Scanned_ImageOnly.pdf',
  edi: '06_Invoice_INVOIC_EDIFACT.edi',
  doc: '07_EU_Declaration_of_Conformity.pdf',
} as const

type DocKey = keyof typeof FIXTURE

interface DocTemplate {
  fileName: string
  docType: string
  format: 'pdf' | 'image' | 'edi'
  ext: string
  fields: Record<string, string>
  /** 解析摘要（页面「解析产物」区展示） */
  parseSummary: string
}

const SELLER = 'Shenzhen Nova Audio Technology Co., Ltd.'
const BUYER = 'Rheinblick Electronics GmbH'

const DOC_TEMPLATES: Record<DocKey, DocTemplate> = {
  invoice: {
    fileName: 'Commercial_Invoice_1000PCS.pdf',
    docType: '商业发票',
    format: 'pdf',
    ext: 'pdf',
    parseSummary: '商业发票：型号、数量、单价、总价、毛净重、贸易术语已提取',
    fields: {
      product: 'Rechargeable Bluetooth Speaker',
      model: 'NOVA-BS20',
      quantity: '1000',
      unit: 'PCS',
      unitPrice: '20.00',
      currency: 'USD',
      totalAmount: '20000.00',
      incoterm: 'FOB Shenzhen',
      origin: 'China',
      destination: 'Germany',
      hs: '8518.21',
      gross: '620',
      net: '550',
      seller: SELLER,
      buyer: BUYER,
    },
  },
  packingOk: {
    fileName: 'Packing_List_1000PCS.pdf',
    docType: '装箱单',
    format: 'pdf',
    ext: 'pdf',
    parseSummary: '装箱单：数量、件数、毛净重已提取，与发票一致',
    fields: {
      product: 'Rechargeable Bluetooth Speaker',
      model: 'NOVA-BS20',
      quantity: '1000',
      unit: 'PCS',
      cartons: '100',
      gross: '620',
      net: '550',
      destination: 'Germany',
    },
  },
  packingConflict: {
    fileName: 'Packing_List_900PCS.pdf',
    docType: '装箱单',
    format: 'pdf',
    ext: 'pdf',
    parseSummary: '装箱单：数量 900 PCS，与发票 1000 PCS 不一致',
    fields: {
      product: 'Rechargeable Bluetooth Speaker',
      model: 'NOVA-BS20',
      quantity: '900',
      unit: 'PCS',
      cartons: '90',
      gross: '560',
      net: '500',
      destination: 'Germany',
    },
  },
  ocrImage: {
    fileName: 'Invoice_Photo.png',
    docType: '商业发票（图片）',
    format: 'image',
    ext: 'png',
    parseSummary: '图片识读：发票号、数量、币别、总价已提取（置信度中等）',
    fields: {
      product: 'Rechargeable Bluetooth Speaker',
      model: 'NOVA-BS20',
      quantity: '1000',
      unit: 'PCS',
      currency: 'USD',
      totalAmount: '20000.00',
      destination: 'Germany',
    },
  },
  scanned: {
    fileName: 'Invoice_Scanned.pdf',
    docType: '商业发票（扫描件）',
    format: 'pdf',
    ext: 'pdf',
    parseSummary: '扫描件识读：型号与数量已提取，其余字段需人工核对',
    fields: {
      product: 'Rechargeable Bluetooth Speaker',
      model: 'NOVA-BS20',
      quantity: '1000',
      unit: 'PCS',
      totalAmount: '20000.00',
      destination: 'Germany',
    },
  },
  edi: {
    fileName: 'Invoice_INVOIC.edi',
    docType: '提单 / EDI',
    format: 'edi',
    ext: 'edi',
    parseSummary: 'EDIFACT INVOIC：数量、型号、目的国已解析，与发票一致',
    fields: {
      model: 'NOVA-BS20',
      quantity: '1000',
      unit: 'PCS',
      gross: '620',
      destination: 'Germany',
    },
  },
  doc: {
    fileName: 'EU_Declaration_of_Conformity.pdf',
    docType: '合规材料',
    format: 'pdf',
    ext: 'pdf',
    parseSummary: '符合性声明：型号与声明类型已识别',
    fields: {
      model: 'NOVA-BS20',
      documentType: 'EU Declaration of Conformity',
    },
  },
}

/* ---------- 场景模板：单证组合 + 预检结果 + 异常 ---------- */

interface FindingSpec {
  title: string
  kind: 'cross' | 'rule'
  ruleKey?: string
  severity: Severity
  status: 'open' | 'reviewed' | 'resolved'
  summary: string
  /** 引用单证（按本票内 DocKey 索引） */
  evidence?: DocKey[]
  /** 人工处置记录（status 非 open 时展示） */
  decision?: string
}

interface Scenario {
  docs: DocKey[]
  checks: CheckResultLite[]
  findings: FindingSpec[]
  runStatus: RunStatus
  runSummary: string
}

const chk = (
  ruleKey: string,
  status: CheckItemStatus,
  label: string,
  tone: CheckResultLite['tone'],
  evidenceRefs: string[] = [],
  reasoning?: string,
): CheckResultLite => ({ ruleKey, status, label, tone, evidenceRefs, ...(reasoning ? { reasoning } : {}) })

/** A · 单证一致，材料基本齐备 */
const S_CLEAN: Scenario = {
  docs: ['invoice', 'packingOk', 'doc'],
  checks: [
    chk('red', 'passed', '已提供符合性声明', 'good', ['doc'], '商业发票型号 NOVA-BS20 与符合性声明型号一致'),
    chk('rohs', 'warning', '材料已提供', 'good', ['doc'], '已随附符合性声明，RoHS 专项测试报告仍需人工确认'),
    chk('battery', 'warning', '待人工确认', 'warn', [], '内置可充电锂电池，电池相关义务按适用日期人工核对'),
    chk('weee', 'not_applicable', '适用性待确认', 'neutral', [], '是否需德国生产者责任登记取决于投放市场的主体安排'),
    chk('hs', 'warning', '需人工核查', 'warn', ['invoice'], '申报编码 8518.21 与商品属性需归类人员复核'),
  ],
  findings: [
    {
      title: 'HS 编码需要人工核查',
      kind: 'rule',
      ruleKey: 'hs',
      severity: 'warn',
      status: 'reviewed',
      summary: '申报编码 8518.21 与商品属性需归类人员复核',
      evidence: ['invoice'],
      decision: '已转归类岗复核，暂按申报编码放行，出运前回收结论。',
    },
  ],
  runStatus: 'succeeded',
  runSummary: '跨单证一致性核验通过（数量、型号、目的国一致）；合规预检 1 项待人工确认',
}

/** B · 数量冲突（发票 1000 / 装箱单 900） */
const S_CONFLICT: Scenario = {
  docs: ['invoice', 'packingConflict'],
  checks: [
    chk('red', 'insufficient_evidence', '待补充证据', 'danger', [], '未提供欧盟符合性声明，无法核实无线设备合规材料'),
    chk('rohs', 'insufficient_evidence', '证据不足', 'warn', [], '未提供 RoHS 支撑材料'),
    chk('battery', 'insufficient_evidence', '证据不足', 'warn', [], '内置锂电池，未见电池属性与安全支撑材料'),
    chk('weee', 'not_applicable', '适用性待确认', 'neutral', [], '需先确认投放市场主体'),
    chk('hs', 'warning', '需人工核查', 'warn', ['invoice'], '申报编码 8518.21 与商品属性需归类人员复核'),
  ],
  findings: [
    {
      title: '商业发票与装箱单数量不一致',
      kind: 'cross',
      severity: 'danger',
      status: 'open',
      summary: 'Invoice：1000 PCS · Packing List：900 PCS（相差 100 PCS）',
      evidence: ['invoice', 'packingConflict'],
    },
    {
      title: '缺少 RED 相关声明材料',
      kind: 'rule',
      ruleKey: 'red',
      severity: 'warn',
      status: 'open',
      summary: '尚未提供对应型号的欧盟符合性声明',
    },
  ],
  runStatus: 'partially_succeeded',
  runSummary: '跨单证核验发现 1 项数量冲突；合规预检发现 2 项待补充',
}

/** C · 扫描件识读，待人工核对 */
const S_SCAN: Scenario = {
  docs: ['scanned', 'doc'],
  checks: [
    chk('red', 'warning', '材料已提供', 'good', ['doc'], '符合性声明已随附，型号需与扫描件人工比对'),
    chk('rohs', 'insufficient_evidence', '证据不足', 'warn', [], '未提供 RoHS 支撑材料'),
    chk('battery', 'insufficient_evidence', '证据不足', 'warn', [], '内置锂电池，未见电池属性与安全支撑材料'),
    chk('weee', 'not_applicable', '适用性待确认', 'neutral', [], '需先确认投放市场主体'),
    chk('hs', 'warning', '需人工核查', 'warn', ['scanned'], '扫描件未识别出申报编码，需人工补录后复核'),
  ],
  findings: [
    {
      title: '扫描件字段置信度偏低，需人工核对',
      kind: 'cross',
      severity: 'warn',
      status: 'reviewed',
      summary: '扫描件识读数量 1000 PCS、总价 20000.00 USD；单价与毛重未识别',
      evidence: ['scanned'],
      decision: '已人工对照原件补录单价 20.00 USD 与毛重 620 KG，等待复核确认。',
    },
    {
      title: '缺少 RoHS 支撑材料',
      kind: 'rule',
      ruleKey: 'rohs',
      severity: 'warn',
      status: 'open',
      summary: '未随附 RoHS 符合性声明或测试报告',
    },
  ],
  runStatus: 'succeeded',
  runSummary: '扫描件识读完成；跨单证比对受限（仅 2 份单证），合规预检 2 项待补充',
}

/** D · 电子单证（EDIFACT）交叉一致 */
const S_EDI: Scenario = {
  docs: ['invoice', 'edi', 'doc'],
  checks: [
    chk('red', 'passed', '已提供符合性声明', 'good', ['doc'], '发票型号 NOVA-BS20 与符合性声明型号一致'),
    chk('rohs', 'warning', '材料已提供', 'good', ['doc'], '已随附符合性声明，RoHS 专项材料仍需人工确认'),
    chk('battery', 'warning', '待人工确认', 'warn', [], '内置可充电锂电池，按适用日期人工核对义务'),
    chk('weee', 'not_applicable', '适用性待确认', 'neutral', [], '是否需德国生产者责任登记取决于投放市场的主体安排'),
    chk('hs', 'warning', '需人工核查', 'warn', ['invoice'], '发票与 EDI 申报编码一致，归类结论仍需人工确认'),
  ],
  findings: [
    {
      title: 'HS 编码需要人工核查',
      kind: 'rule',
      ruleKey: 'hs',
      severity: 'warn',
      status: 'resolved',
      summary: '发票与 EDIFACT 报文申报编码一致，仍需归类人员确认',
      evidence: ['invoice', 'edi'],
      decision: '归类岗已确认 8518.21 适用，结论回填后关闭该项。',
    },
  ],
  runStatus: 'succeeded',
  runSummary: '发票与 EDIFACT 报文数量、型号、目的国一致；合规预检 1 项待人工确认',
}

/* ---------- 演示账号定义 ---------- */

interface ShipmentSpec {
  id: string
  name: string
  origin: string
  destination: string
  /** 固定时间戳（确定性：重复启动不产生新时间） */
  createdAt: string
  scenario: Scenario
  /** 货物档案（页面顶部概览） */
  profile: Record<string, string>
  activities: string[]
}

interface AccountSpec {
  email: string
  displayName: string
  /** 账号定位说明（登录后的引导文案不需要，仅内部文档用） */
  persona: string
  shipments: ShipmentSpec[]
}

const PROFILE_BASE = {
  product: 'Rechargeable Bluetooth Speaker',
  model: 'NOVA-BS20',
  unit: 'PCS',
  origin: '中国',
  destination: '德国',
  hs: '8518.21',
  battery: '内置可充电锂电池',
}

const profile = (quantity: string, gross: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...PROFILE_BASE,
  quantity,
  gross,
  ...extra,
})

export const SHOWCASE_ACCOUNTS: readonly AccountSpec[] = [
  {
    email: 'demo@logicheck.ai',
    displayName: '演示账号 · 出口跟单',
    persona: '华东出口企业跟单员：批次多、单证杂，重点是快速发现跨单证冲突',
    shipments: [
      {
        id: 'SHP-DEMO-101',
        name: 'NOVA-BS20 蓝牙音箱 · 8 月第 3 批',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-18T09:20:00.000Z',
        scenario: S_CONFLICT,
        profile: profile('待确认（存在冲突）', '620 kg'),
        activities: ['上传 2 份单证：商业发票、装箱单', '跨单证核验完成：发现数量冲突 1 项'],
      },
      {
        id: 'SHP-DEMO-102',
        name: 'NOVA-BS20 蓝牙音箱 · 7 月第 5 批',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-07-29T02:05:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '合规预检完成：1 项待人工确认'],
      },
      {
        id: 'SHP-DEMO-103',
        name: 'NOVA-BS20 蓝牙音箱 · 6 月第 1 批',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-06-15T06:40:00.000Z',
        scenario: S_EDI,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、EDIFACT 报文、符合性声明', 'HS 编码核查完成并关闭'],
      },
      {
        id: 'SHP-DEMO-104',
        name: 'NOVA-BS20 蓝牙音箱 · 8 月补料批',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-02T04:25:00.000Z',
        scenario: S_SCAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 2 份单证：扫描件发票、符合性声明', '扫描件识读完成，RoHS 材料缺口已登记'],
      },
    ],
  },
  {
    email: 'demo2@logicheck.ai',
    displayName: '演示账号 · 德国进口采购',
    persona: '德国进口商采购：关注每批到货的单证齐套与数量吻合',
    shipments: [
      {
        id: 'SHP-DEMO-201',
        name: 'NOVA-BS20 · 采购批次 2026-08-A',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-20T03:10:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '核验通过，等待到货'],
      },
      {
        id: 'SHP-DEMO-202',
        name: 'NOVA-BS20 · 采购批次 2026-08-B',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-05T07:55:00.000Z',
        scenario: S_SCAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 2 份单证：扫描件发票、符合性声明', '扫描件识读完成，人工补录单价与毛重'],
      },
      {
        id: 'SHP-DEMO-203',
        name: 'NOVA-BS20 · 采购批次 2026-07-A',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-07-11T01:30:00.000Z',
        scenario: S_CONFLICT,
        profile: profile('待确认（存在冲突）', '620 kg'),
        activities: ['上传 2 份单证：商业发票、装箱单', '数量冲突已通知供应商补发更正装箱单'],
      },
      {
        id: 'SHP-DEMO-204',
        name: 'NOVA-BS20 · 采购批次 2026-05-A',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-05-28T08:15:00.000Z',
        scenario: S_EDI,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、EDIFACT 报文、符合性声明', '电子单证与纸质单证交叉一致'],
      },
    ],
  },
  {
    email: 'demo3@logicheck.ai',
    displayName: '演示账号 · 报关行操作',
    persona: '报关行操作员：批量处理客户委托，重点在单证格式与申报一致性',
    shipments: [
      {
        id: 'SHP-DEMO-301',
        name: '报关委托 · NOVA-BS20 8 月批次',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-21T05:45:00.000Z',
        scenario: S_EDI,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、EDIFACT 报文、符合性声明', '申报要素核对完成'],
      },
      {
        id: 'SHP-DEMO-302',
        name: '报关委托 · NOVA-BS20 8 月第二票',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-09T02:25:00.000Z',
        scenario: S_CONFLICT,
        profile: profile('待确认（存在冲突）', '620 kg'),
        activities: ['上传 2 份单证：商业发票、装箱单', '数量冲突退回客户确认'],
      },
      {
        id: 'SHP-DEMO-303',
        name: '报关委托 · NOVA-BS20 7 月批次',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-07-02T09:00:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '单证齐套，转人工放行'],
      },
      {
        id: 'SHP-DEMO-304',
        name: '报关委托 · NOVA-BS20 6 月批次',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-06-20T04:35:00.000Z',
        scenario: S_SCAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 2 份单证：扫描件发票、符合性声明', '扫描件识读完成，转人工核对'],
      },
    ],
  },
  {
    email: 'demo4@logicheck.ai',
    displayName: '演示账号 · 品牌合规专员',
    persona: '品牌方合规专员：最关心法规预检结论与证据缺口',
    shipments: [
      {
        id: 'SHP-DEMO-401',
        name: '合规预检 · NOVA-BS20 8 月出运',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-22T01:15:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '合规预检完成：RED 已覆盖，电池材料待补'],
      },
      {
        id: 'SHP-DEMO-402',
        name: '合规预检 · NOVA-BS20 8 月补发批',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-12T06:50:00.000Z',
        scenario: S_SCAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 2 份单证：扫描件发票、符合性声明', '扫描件识读完成，RoHS 材料缺口已登记'],
      },
      {
        id: 'SHP-DEMO-403',
        name: '合规预检 · NOVA-BS20 7 月出运',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-07-25T03:05:00.000Z',
        scenario: S_CONFLICT,
        profile: profile('待确认（存在冲突）', '620 kg'),
        activities: ['上传 2 份单证：商业发票、装箱单', '数量冲突与合规缺口同时登记'],
      },
      {
        id: 'SHP-DEMO-404',
        name: '合规预检 · NOVA-BS20 6 月出运',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-06-30T08:20:00.000Z',
        scenario: S_EDI,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、EDIFACT 报文、符合性声明', 'HS 归类结论已回填并关闭'],
      },
      {
        id: 'SHP-DEMO-405',
        name: '合规预检 · NOVA-BS20 5 月出运',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-05-16T07:40:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '合规预检完成，材料齐备'],
      },
    ],
  },
  {
    email: 'demo5@logicheck.ai',
    displayName: '演示账号 · 货代客服',
    persona: '第三方物流客服：客户提单证过来就要出结论，异常处理是日常',
    shipments: [
      {
        id: 'SHP-DEMO-501',
        name: '托单 · NOVA-BS20 8 月急件',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-23T02:45:00.000Z',
        scenario: S_CONFLICT,
        profile: profile('待确认（存在冲突）', '620 kg'),
        activities: ['上传 2 份单证：商业发票、装箱单', '数量冲突已反馈客户，等待更正单证'],
      },
      {
        id: 'SHP-DEMO-502',
        name: '托单 · NOVA-BS20 8 月常规',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-08-14T05:30:00.000Z',
        scenario: S_CLEAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、装箱单、符合性声明', '单证齐套，安排订舱'],
      },
      {
        id: 'SHP-DEMO-503',
        name: '托单 · NOVA-BS20 7 月补料',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-07-18T09:10:00.000Z',
        scenario: S_SCAN,
        profile: profile('1000', '620 kg'),
        activities: ['上传 2 份单证：扫描件发票、符合性声明', '扫描件识别完成，提醒客户补 RoHS 材料'],
      },
      {
        id: 'SHP-DEMO-504',
        name: '托单 · NOVA-BS20 6 月电子单证',
        origin: '中国',
        destination: '德国',
        createdAt: '2026-06-08T03:55:00.000Z',
        scenario: S_EDI,
        profile: profile('1000', '620 kg'),
        activities: ['上传 3 份单证：商业发票、EDIFACT 报文、符合性声明', '电子单证核验通过，报文归档'],
      },
    ],
  },
]

/* ---------- 写库 ---------- */

/** 在候选目录中查找夹具；找不到返回 null（缺文件不阻断建库，仅该单证无原件） */
function findFixture(io: SeedIo, name: string): string | null {
  for (const dir of io.fixtureDirs) {
    const abs = resolve(dir, name)
    if (existsSync(abs)) return abs
  }
  return null
}

/** 把原件复制到上传目录并返回存储键；文件已存在则直接复用 */
function ensureFile(
  io: SeedIo,
  userId: string,
  shipmentId: string,
  docId: string,
  key: DocKey,
): { storageKey: string; size: number } | null {
  const tpl = DOC_TEMPLATES[key]
  const storageKey = [userId, shipmentId, `${docId}.${tpl.ext}`].join('/')
  const abs = resolve(io.uploadDir, storageKey)
  if (existsSync(abs)) return { storageKey, size: statSync(abs).size }
  const src = findFixture(io, FIXTURE[key])
  if (!src) return null
  mkdirSync(dirname(abs), { recursive: true })
  cpSync(src, abs)
  return { storageKey, size: statSync(abs).size }
}

/** 幂等创建单个演示账号；返回 userId */
function ensureAccount(db: Db, spec: AccountSpec, password: string): string {
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', spec.email)
  const t = nowIso()
  if (existing) {
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?', hashPassword(password), t, spec.email)
    return existing.id
  }
  const userId = newId('usr')
  db.run(
    'INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    userId,
    spec.email,
    hashPassword(password),
    spec.displayName,
    t,
    t,
  )
  return userId
}

/** 幂等写入单票演示货物（含单证、字段、档案、异常、处理记录、预检结果） */
function ensureShipment(db: Db, io: SeedIo, userId: string, spec: ShipmentSpec): boolean {
  const exists = db.get<{ id: string }>('SELECT id FROM shipments WHERE id = ?', spec.id)
  if (exists) return false

  const t = spec.createdAt
  const sc = spec.scenario
  const docIds = new Map<DocKey, string>()
  const docFiles = new Map<DocKey, { storageKey: string; size: number } | null>()

  // 文件落盘先于事务（IO 不放在事务里）
  for (const key of sc.docs) {
    const docId = `DOC-${spec.id.replace('SHP-DEMO-', '')}-${key.toUpperCase()}`
    docIds.set(key, docId)
    docFiles.set(key, ensureFile(io, userId, spec.id, docId, key))
  }

  db.transaction(() => {
    db.run(
      'INSERT INTO shipments (id, user_id, name, origin, destination, is_demo, dirty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
      spec.id,
      userId,
      spec.name,
      spec.origin,
      spec.destination,
      t,
      t,
    )

    for (const key of sc.docs) {
      const tpl = DOC_TEMPLATES[key]
      const docId = docIds.get(key)!
      const file = docFiles.get(key) ?? null
      db.run(
        `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, error, is_demo, created_at, updated_at, parse_summary, extraction_provider, extraction_model)
         VALUES (?, ?, ?, ?, ?, ?, 'parsed', ?, ?, NULL, 1, ?, ?, ?, 'deterministic', NULL)`,
        docId,
        spec.id,
        userId,
        tpl.fileName,
        tpl.docType,
        tpl.format,
        file?.size ?? 0,
        file?.storageKey ?? null,
        t,
        t,
        tpl.parseSummary,
      )
      for (const [fieldKey, value] of Object.entries(tpl.fields)) {
        db.run(
          `INSERT INTO extracted_fields (id, document_id, shipment_id, field_key, value, original_value, source, updated_at, normalized_value, page, position, confidence, status, evidence_quote, extraction_model)
           VALUES (?, ?, ?, ?, ?, NULL, 'ai', ?, ?, 1, NULL, 0.95, 'extracted', NULL, NULL)`,
          newId('fld'),
          docId,
          spec.id,
          fieldKey,
          value,
          t,
          value,
        )
      }
    }

    for (const [fieldKey, value] of Object.entries(spec.profile)) {
      db.run('INSERT INTO shipment_profiles (shipment_id, field_key, value) VALUES (?, ?, ?)', spec.id, fieldKey, value)
    }

    for (const f of sc.findings) {
      const fid = `FND-${spec.id.replace('SHP-DEMO-', '')}-${f.kind === 'cross' ? 'X' : (f.ruleKey ?? 'R').toUpperCase()}`
      const evidence = (f.evidence ?? []).map((k) => docIds.get(k)).filter((x): x is string => !!x)
      db.run(
        `INSERT INTO findings (id, shipment_id, title, kind, rule_key, severity, status, summary, evidence, created_at, check_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        fid,
        spec.id,
        f.title,
        f.kind,
        f.ruleKey ?? null,
        f.severity,
        f.status,
        f.summary,
        JSON.stringify(evidence),
        t,
      )
      if (f.decision) {
        db.run(
          'INSERT INTO human_decisions (id, finding_id, shipment_id, text, kind, at) VALUES (?, ?, ?, ?, ?, ?)',
          newId('dec'),
          fid,
          spec.id,
          f.decision,
          f.status === 'resolved' ? 'resolve' : 'review',
          t,
        )
      }
    }

    db.run(
      `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
       VALUES (?, ?, 'upload', ?, ?, ?, ?, 'Demo v0.1', NULL)`,
      `RUN-${spec.id.replace('SHP-DEMO-', '')}-01`,
      spec.id,
      sc.runStatus,
      t,
      t,
      sc.runSummary,
    )

    db.run(
      'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
      newId('act'),
      spec.id,
      '演示案例已载入（示例数据）',
      t,
    )
    for (const text of spec.activities) {
      db.run('INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)', newId('act'), spec.id, text, t)
    }

    for (const c of sc.checks) {
      const refs = c.evidenceRefs.map((k) => docIds.get(k as DocKey)).filter((x): x is string => !!x)
      db.run(
        'INSERT INTO check_results (id, shipment_id, rule_key, status, label, tone, evidence_refs, reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId('chk'),
        spec.id,
        c.ruleKey,
        c.status,
        c.label,
        c.tone,
        JSON.stringify(refs),
        c.reasoning ?? null,
      )
    }
  })
  return true
}

export interface SeedResult {
  accounts: number
  shipmentsCreated: number
  documentsMissingFile: number
}

/**
 * 演示账号与历史货物种子（幂等）。
 * 每次启动执行：账号存在则重置为配置密码；货物按固定 ID 判断，已存在则跳过。
 * 因此沙箱环境重置后重启进程即可完整恢复演示数据。
 */
export function seedShowcase(db: Db, password: string, io: SeedIo): SeedResult {
  let shipmentsCreated = 0
  let documentsMissingFile = 0
  for (const spec of SHOWCASE_ACCOUNTS) {
    const userId = ensureAccount(db, spec, password)
    for (const shipment of spec.shipments) {
      if (ensureShipment(db, io, userId, shipment)) shipmentsCreated += 1
      const missing = db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM documents WHERE shipment_id = ? AND storage_key IS NULL",
        shipment.id,
      )
      documentsMissingFile += missing?.n ?? 0
    }
  }
  return { accounts: SHOWCASE_ACCOUNTS.length, shipmentsCreated, documentsMissingFile }
}
