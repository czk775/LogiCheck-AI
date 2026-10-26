/* ============================================================
   演示数据 seed —— 与前端 Mock demoData.ts 逐字段一致。
   所有值均为人工制作的测试样例，明确标注 is_demo，
   不代表任何真实货物。真实上传的文件不会获得此类模拟提取结果。
   ============================================================ */

import type { Db } from '../../db/index.ts'
import { newId, nowIso } from '../../core/ids.ts'
import { hashPassword } from '../../core/password.ts'
import type { CheckResultLite, ComplianceRule, RuleKey } from '../../types.ts'

export const DEMO_SHIPMENT_ID = 'SHP-2026-001'

export const RULE_NAMES: Record<string, string> = {
  red: 'RED / 欧盟符合性声明',
  rohs: 'RoHS 相关材料',
  battery: '电池相关材料',
  weee: 'WEEE / ElektroG',
  hs: 'HS 编码分类风险',
}

interface DemoDocSpec {
  id: string
  fileName: string
  docType: string
  format: 'pdf' | 'edi'
  fields: Record<string, string>
}

const DEMO_DOCS: DemoDocSpec[] = [
  {
    id: 'doc-invoice',
    fileName: 'Commercial_Invoice.pdf',
    docType: '商业发票',
    format: 'pdf',
    fields: {
      product: 'Portable Bluetooth Speaker',
      model: 'LS-B200',
      quantity: '1000',
      unit: 'PCS',
      origin: 'China',
      destination: 'Germany',
      hs: '8518.21',
      gross: '420',
      battery: 'Rechargeable Li-ion battery',
    },
  },
  {
    id: 'doc-packing',
    fileName: 'Packing_List.pdf',
    docType: '装箱单',
    format: 'pdf',
    fields: {
      product: 'Bluetooth Speaker',
      model: 'LS-B200',
      quantity: '980',
      unit: 'PCS',
      cartons: '50',
      gross: '420',
      destination: 'Germany',
    },
  },
  {
    id: 'doc-bol',
    fileName: 'Bill_of_Lading.edi',
    docType: '提单 / EDI',
    format: 'edi',
    fields: { model: 'LS-B200', quantity: '1000', unit: 'PCS', destination: 'Germany', gross: '420' },
  },
  {
    id: 'doc-rohs',
    fileName: 'RoHS_Declaration.pdf',
    docType: '合规材料',
    format: 'pdf',
    fields: { model: 'LS-B200', documentType: 'RoHS Declaration' },
  },
]

const DEMO_PROFILE: Record<string, string> = {
  product: 'Portable Bluetooth Speaker',
  model: 'LS-B200',
  quantity: '待确认（存在冲突）',
  unit: 'PCS',
  origin: 'China',
  destination: 'Germany',
  hs: '8518.21',
  battery: '内置可充电锂电池',
  gross: '420 kg',
}

export const DEMO_RULES: ComplianceRule[] = [
  {
    ruleId: 'DE-RED-001',
    key: 'red',
    title: 'RED / 欧盟符合性声明',
    category: '无线设备',
    jurisdiction: '欧盟',
    productScope: '便携式可充电蓝牙音箱（无线设备）',
    actorScope: '制造商 / 进口商 / 授权代表（按实际责任链确认）',
    effectiveFrom: '2016-06-13',
    trigger: '产品属于无线电设备类别',
    requiredEvidence: ['EU Declaration of Conformity', '型号等关键识别信息'],
    checkLogic: '检查是否提供 DoC 及关键识别信息能否与单证关联',
    severity: 'warn',
    sourceTitle: 'Directive 2014/53/EU',
    sourceURL: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32014L0053',
    sourceVersion: 'CELEX:32014L0053',
    accessedAt: '',
    ruleVersion: 'Demo v0.1',
    detail: '演示规则检查是否提供欧盟符合性声明等相关材料，以及型号等基本识别信息。实际适用性、证据内容和法规版本需由专业人员核验。',
    recommend: '补充对应型号的 EU Declaration of Conformity，并人工核对签发信息和产品范围。',
  },
  {
    ruleId: 'EU-ROHS-001',
    key: 'rohs',
    title: 'RoHS 相关材料',
    category: '限制有害物质',
    jurisdiction: '欧盟',
    productScope: '电子电气产品（含蓝牙音箱）',
    actorScope: '制造商 / 进口商（按实际责任链确认）',
    effectiveFrom: '2013-01-03',
    trigger: '产品属于 RoHS 指令管辖的电子电气设备',
    requiredEvidence: ['RoHS 符合性声明或支撑材料'],
    checkLogic: '检查预设 RoHS 支撑材料是否存在',
    severity: 'warn',
    sourceTitle: 'Directive 2011/65/EU',
    sourceURL: 'https://eur-lex.europa.eu/eli/dir/2011/65/oj',
    sourceVersion: 'ELI:dir/2011/65/oj',
    accessedAt: '',
    ruleVersion: 'Demo v0.1',
    detail: '检查预设 RoHS 支撑材料是否存在，无法凭文件存在证明产品实际满足限值。',
    recommend: '核对 RoHS 声明、测试范围和产品型号。',
  },
  {
    ruleId: 'EU-BATT-001',
    key: 'battery',
    title: '电池相关材料',
    category: '电池相关',
    jurisdiction: '欧盟',
    productScope: '内置可充电锂电池的便携式蓝牙音箱',
    actorScope: '生产者 / 进口商（按适用日期与投放市场安排确认）',
    effectiveFrom: '2023-08-17',
    trigger: '产品内含蓄电池',
    requiredEvidence: ['电池属性信息', '适用阶段下的相关证据'],
    checkLogic: '检查内置电池产品相关资料是否齐全，并按适用日期人工核对',
    severity: 'warn',
    sourceTitle: 'Regulation (EU) 2023/1542',
    sourceURL: 'https://eur-lex.europa.eu/eli/reg/2023/1542/oj',
    sourceVersion: 'ELI:reg/2023/1542/oj',
    accessedAt: '',
    ruleVersion: 'Demo v0.1',
    detail: '检查内置电池产品相关资料是否齐全，并根据适用日期及产品属性人工核对要求。',
    recommend: '补充适用的电池信息与安全支撑资料，并人工确认当前适用义务。',
  },
  {
    ruleId: 'DE-WEEE-001',
    key: 'weee',
    title: 'WEEE / ElektroG',
    category: '德国市场责任',
    jurisdiction: '德国',
    productScope: '在德国投放市场的电子电气设备',
    actorScope: '生产者 / 进口商（取决于销售与投放市场的具体安排）',
    effectiveFrom: '2015-10-24',
    trigger: '产品在德国市场投放',
    requiredEvidence: ['生产者责任登记 / WEEE 相关材料'],
    checkLogic: '检查适用主体与相关注册/责任材料的证据',
    severity: 'warn',
    sourceTitle: 'ElektroG / Stiftung EAR',
    sourceURL: 'https://www.gesetze-im-internet.de/elektrog_2015/',
    sourceVersion: 'ElektroG 2015',
    accessedAt: '',
    ruleVersion: 'Demo v0.1',
    detail: '是否需要德国生产者责任登记，取决于销售与投放市场的具体安排，不能仅凭目的地判断。',
    recommend: '核实产品投放市场的主体及责任链，并检查适用的登记证据。',
  },
  {
    ruleId: 'EU-HS-001',
    key: 'hs',
    title: 'HS 编码分类风险',
    category: '税则归类风险',
    jurisdiction: '欧盟',
    productScope: '便携式蓝牙音箱（税则归类需按商品属性核实）',
    actorScope: '进口商 / 报关相关人员',
    effectiveFrom: '按当期税则版本',
    trigger: '存在申报 HS 编码',
    requiredEvidence: ['产品描述与申报编码的一致性说明'],
    checkLogic: '检查产品描述与申报编码之间的明显不一致、缺失或待核查项',
    severity: 'warn',
    sourceTitle: '欧盟税则归类规则；需按日期与商品属性核实',
    sourceURL: 'https://taxation-customs.ec.europa.eu/customs/customs-tariff_en',
    sourceVersion: '当期税则',
    accessedAt: '',
    ruleVersion: 'Demo v0.1',
    detail: '演示仅提醒产品描述与申报编码需要进一步核查，不自动给出具有法律效力的正确税号。',
    recommend: '结合材质、功能、产品说明与申报编码，交由熟悉进口归类的人员核查。',
  },
]

/** 演示货物的规则预检概况（与原型 getCheckResults 一致；引用演示单证 ID） */
export function demoCheckResults(): CheckResultLite[] {
  return [
    { ruleKey: 'red', status: 'insufficient_evidence', label: '待补充证据', tone: 'danger', evidenceRefs: [] },
    { ruleKey: 'rohs', status: 'warning', label: '材料已提供', tone: 'good', evidenceRefs: ['doc-rohs'] },
    { ruleKey: 'battery', status: 'insufficient_evidence', label: '证据不足', tone: 'warn', evidenceRefs: [] },
    { ruleKey: 'weee', status: 'not_applicable', label: '适用性待确认', tone: 'neutral', evidenceRefs: [] },
    { ruleKey: 'hs', status: 'warning', label: '需人工核查', tone: 'warn', evidenceRefs: [] },
  ]
}

/**
 * 为演示账号预置一票演示货物（幂等：该用户已有货物则不重复 seed）。
 * 写入真实数据库表，与用户创建的真实货物同库共存、同权限模型。
 */
export function seedDemoShipment(db: Db, userId: string): void {
  const existing = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shipments WHERE user_id = ?', userId)?.n ?? 0
  if (existing > 0) return

  const t = nowIso()
  const sid = DEMO_SHIPMENT_ID
  db.transaction(() => {
    db.run(
      'INSERT INTO shipments (id, user_id, name, origin, destination, is_demo, dirty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)',
      sid,
      userId,
      '便携式可充电蓝牙音箱',
      '中国',
      '德国',
      t,
      t,
    )

    for (const doc of DEMO_DOCS) {
      db.run(
        `INSERT INTO documents (id, shipment_id, user_id, file_name, doc_type, format, status, size, storage_key, error, is_demo, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'parsed', 0, NULL, NULL, 1, ?, ?)`,
        doc.id,
        sid,
        userId,
        doc.fileName,
        doc.docType,
        doc.format,
        t,
        t,
      )
      for (const [key, value] of Object.entries(doc.fields)) {
        db.run(
          'INSERT INTO extracted_fields (id, document_id, shipment_id, field_key, value, original_value, source, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
          newId('fld'),
          doc.id,
          sid,
          key,
          value,
          'ai',
          t,
        )
      }
    }

    for (const [key, value] of Object.entries(DEMO_PROFILE)) {
      db.run(
        'INSERT INTO shipment_profiles (shipment_id, field_key, value) VALUES (?, ?, ?)',
        sid,
        key,
        value,
      )
    }

    const findings: Array<{
      id: string
      title: string
      kind: 'cross' | 'rule'
      ruleKey?: RuleKey
      severity: 'danger' | 'warn'
      summary: string
      evidence: string[]
    }> = [
      {
        id: 'f-qty',
        title: '商业发票与装箱单数量不一致',
        kind: 'cross',
        severity: 'danger',
        summary: 'Invoice：1,000 PCS · Packing List：980 PCS',
        evidence: ['doc-invoice', 'doc-packing'],
      },
      {
        id: 'f-red',
        title: '缺少 RED 相关声明材料',
        kind: 'rule',
        ruleKey: 'red',
        severity: 'warn',
        summary: '尚未提供对应产品的欧盟符合性声明',
        evidence: [],
      },
      {
        id: 'f-hs',
        title: 'HS 编码需要人工核查',
        kind: 'rule',
        ruleKey: 'hs',
        severity: 'warn',
        summary: '申报编码与商品属性需要进一步确认',
        evidence: ['doc-invoice'],
      },
    ]
    for (const f of findings) {
      db.run(
        `INSERT INTO findings (id, shipment_id, title, kind, rule_key, severity, status, summary, evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        f.id,
        sid,
        f.title,
        f.kind,
        f.ruleKey ?? null,
        f.severity,
        f.summary,
        JSON.stringify(f.evidence),
        t,
      )
    }

    db.run(
      `INSERT INTO processing_runs (id, shipment_id, trigger, status, started_at, finished_at, summary, rule_version, error)
       VALUES (?, ?, 'manual', 'partially_succeeded', ?, ?, '演示数据载入：跨单证数量核验发现 1 项冲突，合规预检发现 2 项待确认', 'Demo v0.1', NULL)`,
      'run-demo-001',
      sid,
      t,
      t,
    )

    db.run(
      'INSERT INTO activities (id, shipment_id, text, at) VALUES (?, ?, ?, ?)',
      newId('act'),
      sid,
      '演示案例已载入（示例数据）',
      t,
    )

    for (const r of demoCheckResults()) {
      db.run(
        'INSERT INTO check_results (id, shipment_id, rule_key, status, label, tone, evidence_refs) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId('chk'),
        sid,
        r.ruleKey,
        r.status,
        r.label,
        r.tone,
        JSON.stringify(r.evidenceRefs),
      )
    }
  })
}

/** 规则参考数据入库（幂等：已存在则跳过） */
export function seedRules(db: Db): void {
  const t = nowIso()
  DEMO_RULES.forEach((rule, index) => {
    const exists = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM compliance_rules WHERE key = ?', rule.key)?.n
    if (exists) return
    db.run(
      `INSERT INTO compliance_rules (rule_id, key, sort_order, title, category, jurisdiction, product_scope, actor_scope, effective_from, effective_to, trigger, required_evidence, check_logic, severity, source_title, source_url, source_version, accessed_at, rule_version, detail, recommend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rule.ruleId,
      rule.key,
      index,
      rule.title,
      rule.category,
      rule.jurisdiction,
      rule.productScope,
      rule.actorScope,
      rule.effectiveFrom,
      rule.trigger,
      JSON.stringify(rule.requiredEvidence),
      rule.checkLogic,
      rule.severity,
      rule.sourceTitle,
      rule.sourceURL,
      rule.sourceVersion,
      t,
      rule.ruleVersion,
      rule.detail,
      rule.recommend,
    )
  })
}

/* ============================================================
   演示账号种子（公网部署用）：确保 demo@logicheck.ai 存在且可用
   配置的密码登录（评委无需注册即可体验；本地开发同样生效）。
   - 幂等：每次启动执行，账号存在则重置密码为配置值
   - 密码来自环境变量 DEMO_PASSWORD（默认 demo1234），非密钥
   - 登录表单可用；POST /api/auth/demo 的随机密码路径保持不变
   ============================================================ */

export const DEMO_ACCOUNT_EMAIL = 'demo@logicheck.ai'

export function seedDemoAccount(db: Db, password: string): void {
  const existing = db.get<{ id: string }>('SELECT id FROM users WHERE email = ?', DEMO_ACCOUNT_EMAIL)
  const t = nowIso()
  if (existing) {
    // 已存在：重置为配置密码，保证评委随时能用（演示账号，非真实资产）
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?', hashPassword(password), t, DEMO_ACCOUNT_EMAIL)
    return
  }
  db.run(
    'INSERT INTO users (id, email, password_hash, display_name, is_demo, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    newId('usr'),
    DEMO_ACCOUNT_EMAIL,
    hashPassword(password),
    '演示账号',
    t,
    t,
  )
}
