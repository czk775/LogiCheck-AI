import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import { api } from '../../services/api'
import { RULE_NAMES } from '../../services/mock/demoData'
import type { CheckResultLite } from '../../services/api/contracts'
import type { RuleKey } from '../../types/domain'

/** 德国 / 欧盟合规预检区块 —— 与原型 rules 区块一致 */
export function RulesSection() {
  const { activeShipment, openDrawer, openModal } = useStore()
  const s = activeShipment!
  const [results, setResults] = useState<CheckResultLite[]>([])

  useEffect(() => {
    let alive = true
    void api.getCheckResults(s.id).then((r) => {
      if (alive) setResults(r)
    })
    return () => {
      alive = false
    }
  }, [s.id, s.documents.length, s.findings.length])

  return (
    <section id="rules" className="glass-panel section-card">
      <div className="section-title">
        <h2>德国 / 欧盟合规预检</h2>
        <button type="button" className="section-link" onClick={() => openModal({ type: 'rule-help' })}>
          规则说明 <Icon name="arrow" size="sm" />
        </button>
      </div>
      {s.isDemo && results.length ? (
        <div>
          {results.map((r) => (
            <button
              type="button"
              className="rule-row"
              key={r.ruleKey}
              onClick={() => openDrawer({ type: 'rule', ruleKey: r.ruleKey as RuleKey })}
              data-testid="rule-row"
            >
              <div className="rule-symbol">
                <Icon name={r.ruleKey === 'hs' ? 'filter' : 'shield'} size="sm" />
              </div>
              <div className="rule-text">
                <strong>{RULE_NAMES[r.ruleKey] ?? r.ruleKey}</strong>
                <small>演示规则集 · Demo v0.1</small>
              </div>
              <Chip label={r.label} tone={r.tone} />
              <Icon name="chevron" size="sm" />
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="shield"
          title="等待合规规则执行"
          description="当前文件尚未经过真实 AI 提取，无法做出有效的合规材料判断。"
        />
      )}
      <div className="prototype-note" style={{ marginTop: 20 }}>
        <Icon name="info" size="sm" />
        合规检查是资料完整性与风险提示，不构成法律意见或海关放行结论。
      </div>
    </section>
  )
}
