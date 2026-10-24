import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { useFileChooser } from '../layout/AppShell'
import { DEMO_RULES } from '../../services/mock/demoData'
import { api } from '../../services/api'
import { isEngineMode } from '../../services/domain/runMode'
import type { RuleKey, Shipment } from '../../types/domain'

/** 合规规则详情抽屉（窄）—— 演示货物读内置规则说明，真实货物展示核验引擎的实际结论 */
export function RuleDrawer({ shipment, ruleKey }: { shipment: Shipment; ruleKey: RuleKey }) {
  const { closeDrawer, followUpRule } = useStore()
  const chooser = useFileChooser()
  const rule = DEMO_RULES.find((r) => r.key === ruleKey)
  // 引擎模式 = 真实后端 + 非演示货物（演示货物在真实后端上仍是 seed 数据）
  const engine = isEngineMode(shipment)
  const [reasoning, setReasoning] = useState<string | null>(null)
  const [statusLabel, setStatusLabel] = useState<string | null>(null)
  const [evidenceNames, setEvidenceNames] = useState<string[]>([])

  // 真实货物：拉取核验引擎对这条规则的实际结论（含判定依据）
  useEffect(() => {
    if (!engine) return
    let alive = true
    void api.getCheckResults(shipment.id).then((results) => {
      if (!alive) return
      const hit = results.find((r) => r.ruleKey === ruleKey)
      setReasoning(hit?.reasoning ?? null)
      setStatusLabel(hit?.label ?? null)
      const ids = new Set(hit?.evidenceRefs ?? [])
      setEvidenceNames(shipment.documents.filter((d) => ids.has(d.id)).map((d) => d.fileName))
    })
    return () => {
      alive = false
    }
  }, [engine, shipment.id, ruleKey, shipment.documents])

  if (!rule) return null

  const has = (part: string) => shipment.documents.some((d) => d.fileName.toLowerCase().includes(part))
  const demoStatus =
    ruleKey === 'red'
      ? has('doc')
        ? '已上传待审'
        : '证据待补充'
      : ruleKey === 'rohs'
        ? '材料已提供'
        : ruleKey === 'weee'
          ? '适用性待确认'
          : '证据不足 / 待人工核查'

  const ruleStatus = engine ? (statusLabel ?? '等待核验') : demoStatus

  return (
    <Drawer title={rule.title} subtitle="法规适用范围 / 证据 / 处理建议" onClose={closeDrawer} testId="rule-drawer">
      <div className="eyebrow" style={{ marginBottom: 13 }}>
        {engine ? 'DETERMINISTIC CHECK ENGINE' : 'VERSIONED DEMO RULESET'}
      </div>
      <Chip label={ruleStatus} tone="warn" />

      {engine && reasoning ? (
        <>
          <div className="small-divider" />
          <div className="detail-label">判定依据（本次核验的实际结论）</div>
          <p className="detail-paragraph" data-testid="rule-reasoning">
            {reasoning}
          </p>
          {evidenceNames.length > 0 ? (
            <div className="detail-list">
              <div>
                <strong style={{ color: 'var(--txt)' }}>引用的真实单证</strong>
                <br />
                {evidenceNames.join('、')}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="small-divider" />

      <div className="detail-label">检查目的</div>
      <p className="detail-paragraph">{rule.detail}</p>

      <div className="detail-label">规则来源（官方）</div>
      <div className="detail-list">
        <div>
          <strong style={{ color: 'var(--txt)' }}>{rule.sourceTitle}</strong>
          <br />
          <a
            href={rule.sourceURL}
            rel="noreferrer noopener"
            target="_blank"
            style={{ display: 'inline-block', marginTop: 7, color: 'var(--cyan)' }}
          >
            打开官方资料 <Icon name="external" size="sm" />
          </a>
        </div>
        <div>
          规则版本：{rule.ruleVersion} · 适用范围：{rule.productScope} · 生效：{rule.effectiveFrom}
          <br />
          实际义务、适用日期及来源文本应在真实接入时逐项确认。
        </div>
      </div>

      <div className="detail-label" style={{ marginTop: 24 }}>
        下一步建议
      </div>
      <p className="detail-paragraph">{rule.recommend}</p>

      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
        <Button variant="primary" icon="plus" onClick={() => chooser.open({ kind: 'add' })}>
          补充材料
        </Button>
        <Button icon="edit" onClick={() => void followUpRule(ruleKey)} data-testid="rule-follow-up">
          记录人工意见
        </Button>
      </div>

      <div className="prototype-note" style={{ marginTop: 24 }}>
        <Icon name="info" size="sm" />
        {engine
          ? '本判定由确定性核验引擎依据单证实际提取值生成，只确认材料存在与取值一致性，不构成合规裁决。'
          : '该检查是演示预检，不是具有法律效力的合规裁决。「已提供」仅指材料存在，不代表其内容真实性或适用性已确认。'}
      </div>
    </Drawer>
  )
}
