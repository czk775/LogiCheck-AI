import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import { FIELD_LABELS, PROFILE_DISPLAY_FIELDS } from '../../types/domain'

/** 货物信息区块 —— 与原型 profile 区块一致（演示货物显示字段卡 + 编辑入口） */
export function ProfileSection() {
  const { activeShipment, openDrawer, openModal } = useStore()
  const s = activeShipment!

  return (
    <section id="profile" className="glass-panel section-card">
      <div className="section-title">
        <h2>货物信息</h2>
        {s.isDemo ? (
          <button type="button" className="section-link" onClick={() => openDrawer({ type: 'profile' })}>
            查看完整字段 <Icon name="arrow" size="sm" />
          </button>
        ) : null}
      </div>
      {s.isDemo ? (
        <div className="profile-items">
          {PROFILE_DISPLAY_FIELDS.map((k) => {
            const value = s.profile[k] ?? '—'
            return (
              <div className="profile-item" key={k}>
                <label>{FIELD_LABELS[k]}</label>
                <div className="pvalue">
                  {value}
                  {k === 'quantity' && value.includes('冲突') ? <span className="tagtiny">需复核</span> : null}
                </div>
                <button
                  type="button"
                  className="section-link"
                  onClick={() => openModal({ type: 'field-edit', fieldKey: k })}
                  data-testid={`edit-field-${k}`}
                >
                  查看 / 编辑 <Icon name="chevron" size="sm" />
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <EmptyState
          icon="brain"
          title="暂无 AI 提取字段"
          description="上传真实文件后，需接入 AI 才能生成可验证的货物信息。"
        />
      )}
    </section>
  )
}
