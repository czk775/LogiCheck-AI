import type { ComplianceRule, Finding, ProcessingRun, Shipment, ShipmentDocument } from '../../types/domain'

/* ============================================================
   演示数据 —— 与已确认高保真原型逐字段一致（sampleDocs / sampleShipment）。
   所有值均为人工制作的测试样例，用于验证结构化核验与异常状态流转，
   不代表任何真实货物。真实上传的文件不会获得此类模拟提取结果。
   ============================================================ */

const DEMO_TIME = new Date().toISOString()

function demoDoc(
  id: string,
  fileName: string,
  docType: string,
  format: ShipmentDocument['format'],
  fields: Record<string, string>,
): ShipmentDocument {
  return {
    id,
    shipmentId: 'SHP-2026-001',
    fileName,
    docType,
    format,
    status: 'parsed',
    size: 0,
    createdAt: DEMO_TIME,
    updatedAt: DEMO_TIME,
    isDemo: true,
    fields,
    originalFields: { ...fields },
  }
}

export const DEMO_SHIPMENT_ID = 'SHP-2026-001'

export function createDemoShipment(): Shipment {
  const invoice = demoDoc('doc-invoice', 'Commercial_Invoice.pdf', '商业发票', 'pdf', {
    product: 'Portable Bluetooth Speaker',
    model: 'LS-B200',
    quantity: '1000',
    unit: 'PCS',
    origin: 'China',
    destination: 'Germany',
    hs: '8518.21',
    gross: '420',
    battery: 'Rechargeable Li-ion battery',
  })
  const packing = demoDoc('doc-packing', 'Packing_List.pdf', '装箱单', 'pdf', {
    product: 'Bluetooth Speaker',
    model: 'LS-B200',
    quantity: '980',
    unit: 'PCS',
    cartons: '50',
    gross: '420',
    destination: 'Germany',
  })
  const bol = demoDoc('doc-bol', 'Bill_of_Lading.edi', '提单 / EDI', 'edi', {
    model: 'LS-B200',
    quantity: '1000',
    unit: 'PCS',
    destination: 'Germany',
    gross: '420',
  })
  const rohs = demoDoc('doc-rohs', 'RoHS_Declaration.pdf', '合规材料', 'pdf', {
    model: 'LS-B200',
    documentType: 'RoHS Declaration',
  })

  const findings: Finding[] = [
    {
      id: 'f-qty',
      shipmentId: DEMO_SHIPMENT_ID,
      title: '商业发票与装箱单数量不一致',
      kind: 'cross',
      severity: 'danger',
      status: 'open',
      summary: 'Invoice：1,000 PCS · Packing List：980 PCS',
      evidence: ['doc-invoice', 'doc-packing'],
      notes: [],
      createdAt: DEMO_TIME,
    },
    {
      id: 'f-red',
      shipmentId: DEMO_SHIPMENT_ID,
      title: '缺少 RED 相关声明材料',
      kind: 'rule',
      ruleKey: 'red',
      severity: 'warn',
      status: 'open',
      summary: '尚未提供对应产品的欧盟符合性声明',
      evidence: [],
      notes: [],
      createdAt: DEMO_TIME,
    },
    {
      id: 'f-hs',
      shipmentId: DEMO_SHIPMENT_ID,
      title: 'HS 编码需要人工核查',
      kind: 'rule',
      ruleKey: 'hs',
      severity: 'warn',
      status: 'open',
      summary: '申报编码与商品属性需要进一步确认',
      evidence: ['doc-invoice'],
      notes: [],
      createdAt: DEMO_TIME,
    },
  ]

  const runs: ProcessingRun[] = [
    {
      id: 'run-demo-001',
      shipmentId: DEMO_SHIPMENT_ID,
      trigger: 'manual',
      status: 'partially_succeeded',
      startedAt: DEMO_TIME,
      finishedAt: DEMO_TIME,
      summary: '演示数据载入：跨单证数量核验发现 1 项冲突，合规预检发现 2 项待确认',
      ruleVersion: 'Demo v0.1',
    },
  ]

  return {
    id: DEMO_SHIPMENT_ID,
    name: '便携式可充电蓝牙音箱',
    isDemo: true,
    origin: '中国',
    destination: '德国',
    createdAt: DEMO_TIME,
    updatedAt: DEMO_TIME,
    dirty: false,
    documents: [invoice, packing, bol, rohs],
    profile: {
      product: 'Portable Bluetooth Speaker',
      model: 'LS-B200',
      quantity: '待确认（存在冲突）',
      unit: 'PCS',
      origin: 'China',
      destination: 'Germany',
      hs: '8518.21',
      battery: '内置可充电锂电池',
      gross: '420 kg',
    },
    findings,
    activities: [{ text: '演示案例已载入（示例数据）', at: DEMO_TIME }],
    runs,
  }
}

/* ============================================================
   合规规则集（PRD §7.1 Rule Contract）
   范围：中国 → 德国，便携式可充电蓝牙音箱。
   法律适用条件、实施日期与版本须在真实接入时逐条依据官方材料核实。
   ============================================================ */

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
    accessedAt: DEMO_TIME,
    ruleVersion: 'Demo v0.1',
    detail:
      '演示规则检查是否提供欧盟符合性声明等相关材料，以及型号等基本识别信息。实际适用性、证据内容和法规版本需由专业人员核验。',
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
    accessedAt: DEMO_TIME,
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
    accessedAt: DEMO_TIME,
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
    accessedAt: DEMO_TIME,
    ruleVersion: 'Demo v0.1',
    detail:
      '是否需要德国生产者责任登记，取决于销售与投放市场的具体安排，不能仅凭目的地判断。',
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
    accessedAt: DEMO_TIME,
    ruleVersion: 'Demo v0.1',
    detail: '演示仅提醒产品描述与申报编码需要进一步核查，不自动给出具有法律效力的正确税号。',
    recommend: '结合材质、功能、产品说明与申报编码，交由熟悉进口归类的人员核查。',
  },
]

export const RULE_NAMES: Record<string, string> = {
  red: 'RED / 欧盟符合性声明',
  rohs: 'RoHS 相关材料',
  battery: '电池相关材料',
  weee: 'WEEE / ElektroG',
  hs: 'HS 编码分类风险',
}
