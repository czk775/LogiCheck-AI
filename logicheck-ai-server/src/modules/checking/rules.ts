/* ============================================================
   合规规则评估器（阶段三 · 确定性）

   每条规则一个确定性评估函数：输入货物的真实提取字段与文档清单，
   输出 passed / issue / warning / insufficient_evidence /
   not_applicable / error + 判定依据（reasoning）+ 证据引用（evidenceRefs）。

   边界（诚实声明）：
   - 本模块只做「资料完整性与风险提示」：能确认的只有「材料是否存在」
     「字段是否提取到」，从不宣称产品实际满足法规要求
   - 法规元数据（来源/版本/适用范围）来自 compliance_rules 表，不硬编码在评估逻辑里
   - 证据不足 → insufficient_evidence；适用性无法从单证判断 → 待确认（warning）
   ============================================================ */

import type { CheckItemStatus, RuleKey } from '../../types.ts'

export interface RuleFieldValue {
  documentId: string
  fileName: string
  value: string
}

export interface RuleContext {
  /** fieldKey → 各文档的观测值（已排除 missing/unavailable） */
  fieldValues: Map<string, RuleFieldValue[]>
  /** 货物全部已解析文档 */
  documents: Array<{ id: string; fileName: string; docType: string }>
}

export interface RuleEvaluation {
  status: CheckItemStatus
  label: string
  tone: 'danger' | 'warn' | 'good' | 'info' | 'neutral'
  evidenceRefs: string[]
  reasoning: string
}

export type RuleEvaluator = (ctx: RuleContext) => RuleEvaluation

/** 文件名/单证类型中疑似「声明类材料」的文档 */
function declarationDocs(ctx: RuleContext, pattern: RegExp): Array<{ id: string; fileName: string }> {
  return ctx.documents.filter((d) => pattern.test(`${d.fileName} ${d.docType}`))
}

function firstValue(ctx: RuleContext, fieldKey: string): RuleFieldValue | null {
  return ctx.fieldValues.get(fieldKey)?.[0] ?? null
}

const DECLARATION_RE = /declaration|conformity|\bdoc\b|符合性声明|声明/i
const ROHS_RE = /rohs/i

const EVALUATORS: Record<RuleKey, RuleEvaluator> = {
  /* RED：需要 EU DoC 与型号等关键识别信息；仅确认材料存在，不核验内容 */
  red: (ctx) => {
    const docs = declarationDocs(ctx, DECLARATION_RE)
    const model = firstValue(ctx, 'model')
    if (docs.length) {
      return {
        status: 'warning',
        label: '材料已提供（内容未经核验）',
        tone: 'good',
        evidenceRefs: docs.map((d) => d.id),
        reasoning: `发现可能的符合性声明材料：${docs.map((d) => d.fileName).join('、')}。系统仅确认文件存在，不核验其签发信息、产品范围与型号覆盖；${model ? `已识别型号 ${model.value}（${model.fileName}）` : '未能从单证中识别型号，关键识别信息缺失'}。`,
      }
    }
    return {
      status: 'insufficient_evidence',
      label: '待补充证据',
      tone: 'danger',
      evidenceRefs: [],
      reasoning: `未发现欧盟符合性声明（DoC）相关材料${model ? `；已识别型号 ${model.value}（${model.fileName}）` : '；且未能从单证中识别型号，关键识别信息缺失'}。按 Directive 2014/53/EU 的证明要求，需补充对应型号的 DoC 并人工核对。`,
    }
  },

  /* RoHS：确认 RoHS 支撑材料是否存在 */
  rohs: (ctx) => {
    const docs = declarationDocs(ctx, ROHS_RE)
    if (docs.length) {
      return {
        status: 'warning',
        label: '材料已提供（内容未经核验）',
        tone: 'good',
        evidenceRefs: docs.map((d) => d.id),
        reasoning: `发现 RoHS 相关材料：${docs.map((d) => d.fileName).join('、')}。存在文件不等于满足限值要求，测试范围与型号覆盖需人工核对。`,
      }
    }
    return {
      status: 'insufficient_evidence',
      label: '待补充证据',
      tone: 'warn',
      evidenceRefs: [],
      reasoning: '未发现 RoHS 符合性声明或支撑材料。需补充后由人工核对声明内容与产品范围。',
    }
  },

  /* 电池：单证是否给出电池属性信息；义务适用性留人工 */
  battery: (ctx) => {
    const battery = ctx.fieldValues.get('battery') ?? []
    if (battery.length) {
      return {
        status: 'warning',
        label: '需按适用日期人工核对',
        tone: 'warn',
        evidenceRefs: battery.map((b) => b.documentId),
        reasoning: `单证提及电池信息：${battery.map((b) => `${b.fileName}=${b.value}`).join('、')}。Regulation (EU) 2023/1542 的义务取决于适用日期与投放市场安排，需人工确认当前适用要求。`,
      }
    }
    return {
      status: 'insufficient_evidence',
      label: '证据不足',
      tone: 'warn',
      evidenceRefs: [],
      reasoning: '未能从单证中获取电池属性信息，无法判断产品是否内含蓄电池，也无法确认电池相关义务是否适用。',
    }
  },

  /* WEEE / ElektroG：目的国是德国 → 适用性待确认；否则通常不适用（仍需人工确认市场安排） */
  weee: (ctx) => {
    const dest = firstValue(ctx, 'destination')
    if (!dest) {
      return {
        status: 'insufficient_evidence',
        label: '证据不足',
        tone: 'warn',
        evidenceRefs: [],
        reasoning: '未能从单证中确定目的国，无法判断德国生产者责任登记（ElektroG）是否可能适用。',
      }
    }
    if (/germany|deutschland|^de$|德国/i.test(dest.value)) {
      return {
        status: 'warning',
        label: '适用性待确认',
        tone: 'warn',
        evidenceRefs: dest.documentId ? [dest.documentId] : [],
        reasoning: `目的国为德国（${dest.fileName}=${dest.value}）。是否需要生产者责任登记取决于实际投放市场与销售安排，不能仅凭提单目的地判断；如确认在德国投放，需核实登记证据。`,
      }
    }
    return {
      status: 'not_applicable',
      label: '目的国非德国',
      tone: 'neutral',
      evidenceRefs: dest.documentId ? [dest.documentId] : [],
      reasoning: `目的国为 ${dest.value}（${dest.fileName}），ElektroG 登记义务通常不适用；实际市场投放安排仍需人工确认。`,
    }
  },

  /* HS：已申报编码 → 需人工核查；未申报 → 证据不足 */
  hs: (ctx) => {
    const hs = ctx.fieldValues.get('hs') ?? []
    if (hs.length) {
      return {
        status: 'warning',
        label: '需人工核查',
        tone: 'warn',
        evidenceRefs: hs.map((h) => h.documentId),
        reasoning: `已申报 HS 编码：${hs.map((h) => `${h.fileName}=${h.value}`).join('、')}。税则归类需按商品属性与当期税则人工核查，系统不自动判定唯一正确税号。`,
      }
    }
    return {
      status: 'insufficient_evidence',
      label: '证据不足',
      tone: 'warn',
      evidenceRefs: [],
      reasoning: '单证中未发现申报 HS 编码，无法启动归类核查。',
    }
  },
}

/** 取某规则的评估器；未实现时返回明确的 error 态（不静默跳过） */
export function evaluatorFor(key: string): RuleEvaluator | null {
  return (EVALUATORS as Record<string, RuleEvaluator>)[key] ?? null
}
