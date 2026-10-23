import { Icon } from '../../components/Icon'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import { apiMode } from '../../services/api'
import { FIELD_LABELS, PROFILE_DISPLAY_FIELDS } from '../../types/domain'
import type { Shipment } from '../../types/domain'

/** 货物信息区块 —— 与原型 profile 区块一致（演示货物显示字段卡 + 编辑入口） */
export function ProfileSection() {
  const { activeShipment, openDrawer, openModal } = useStore()
  const s = activeShipment!
  const real = apiMode === 'real'

  if (!s.isDemo) {
    return <RealProfileSection s={s} real={real} openDrawer={openDrawer} openModal={openModal} />
  }

  return (
    <section id="profile" className="glass-panel section-card">
      <div className="section-title">
        <h2>货物信息</h2>
        <button type="button" className="section-link" onClick={() => openDrawer({ type: 'profile' })}>
          查看完整字段 <Icon name="arrow" size="sm" />
        </button>
      </div>
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
    </section>
  )
}

/** 真实上传货物：展示服务端确定性提取的字段（无演示数据，缺失即缺失） */
function RealProfileSection({
  s,
  real,
  openDrawer,
  openModal,
}: {
  s: Shipment
  real: boolean
  openDrawer: (d: { type: 'profile' }) => void
  openModal: (m: { type: 'field-edit'; fieldKey: string }) => void
}) {
  // 合并各单证的提取字段（后解析的文档覆盖先前的同键值）
  const merged: Record<string, { value: string; status?: string }> = {}
  for (const d of s.documents) {
    for (const [k, v] of Object.entries(d.fields)) {
      merged[k] = { value: v, status: d.fieldMeta?.[k]?.status }
    }
  }
  const hasFields = Object.keys(merged).length > 0

  return (
    <section id="profile" className="glass-panel section-card">
      <div className="section-title">
        <h2>货物信息</h2>
        {hasFields ? (
          <button type="button" className="section-link" onClick={() => openDrawer({ type: 'profile' })}>
            查看完整字段 <Icon name="arrow" size="sm" />
          </button>
        ) : null}
      </div>
      {hasFields ? (
        <>
          <div className="profile-items">
            {PROFILE_DISPLAY_FIELDS.map((k) => {
              const entry = merged[k]
              const value = entry?.value ?? '—'
              return (
                <div className="profile-item" key={k}>
                  <label>{FIELD_LABELS[k]}</label>
                  <div className="pvalue">
                    {value}
                    {entry?.status === 'low_confidence' ? <span className="tagtiny">低置信</span> : null}
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
          <p className="text-note" style={{ marginTop: 10 }}>
            {real
              ? '字段来自服务端确定性解析（PDF 文本层 / EDIFACT 段映射）；「—」表示尚未从单证中提取到，不以默认值填充。'
              : '上传真实文件后，需接入 AI 才能生成可验证的货物信息。'}
          </p>
        </>
      ) : (
        <EmptyState
          icon="brain"
          title={real ? '暂无提取字段' : '暂无 AI 提取字段'}
          description={
            real
              ? s.documents.some((d) => d.status === 'failed')
                ? '当前单证处理失败（详见单证卡片上的失败原因），修正或重新上传后可再次解析。'
                : '单证正在解析或尚未提取到字段；解析完成后这里会展示可追溯的提取值。'
              : '上传真实文件后，需接入 AI 才能生成可验证的货物信息。'
          }
        />
      )}
    </section>
  )
}
