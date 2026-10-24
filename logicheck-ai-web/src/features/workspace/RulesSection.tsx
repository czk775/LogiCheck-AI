import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import { api } from '../../services/api'
import { RULE_NAMES } from '../../services/mock/demoData'
import { isEngineMode } from '../../services/domain/runMode'
import type { CheckResultLite } from '../../services/api/contracts'
import type { RuleKey } from '../../types/domain'

/** 德国 / 欧盟合规预检区块 —— 演示货物读内置示例，真实货物读核验引擎的真实结论 */
export function RulesSection() {
  const { activeShipment, openDrawer, openModal } = useStore()
  const s = activeShipment!
  const [results, setResults] = useState<CheckResultLite[]>([])
  // 引擎模式 = 真实后端 + 非演示货物（演示货物在真实后端上仍是 seed 数据）
  const engine = isEngineMode(s)

  useEffect(() => {
    let alive = true
    void api.getCheckResults(s.id).then((r) => {
      if (alive) setResults(r)
    })
    return () => {
      alive = false
    }
  }, [s.id, s.documents.length, s.findings.length])

  const hasResults = results.length > 0

  return (
    <section id="rules" className="glass-panel section-card">
      <div className="section-title">
        <h2>德国 / 欧盟合规预检</h2>
        <button type="button" className="section-link" onClick={() => openModal({ type: 'rule-help' })}>
          规则说明 <Icon name="arrow" size="sm" />
        </button>
      </div>
      {hasResults ? (
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
                <small>{engine ? '确定性核验引擎 · 依据单证实际提取值' : '演示规则集 · Demo v0.1'}</small>
              </div>
              <Chip label={r.label} tone={r.tone} />
              <Icon name="chevron" size="sm" />
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          icon="shield"
          title={engine ? '等待核验引擎运行' : '等待合规规则执行'}
          description={
            engine
              ? '单证解析成功后会自动执行跨单证核验与合规预检；当前尚无已解析的单证可供判断。'
              : '当前文件尚未经过真实 AI 提取，无法做出有效的合规材料判断。'
          }
        />
      )}
      <div className="prototype-note" style={{ marginTop: 20 }}>
        <Icon name="info" size="sm" />
        合规检查是资料完整性与风险提示，不构成法律意见或海关放行结论。
      </div>
    </section>
  )
}
