import { Icon } from '../../components/Icon'
import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { FIELD_LABELS } from '../../types/domain'
import type { Shipment } from '../../types/domain'

/** 完整货物字段抽屉（窄）—— 与原型 profileDrawer 一致 */
export function ProfileDrawer({ shipment }: { shipment: Shipment }) {
  const { closeDrawer, openModal } = useStore()

  return (
    <Drawer
      title="货物信息 · 完整字段"
      subtitle="统一货物信息 / 字段级复核 / 来源证据"
      onClose={closeDrawer}
      testId="profile-drawer"
    >
      <p className="detail-paragraph">
        AI 将不同文件的字段汇总到统一货物对象。此处是演示提取结果，冲突项必须根据原始单证人工复核。
      </p>
      <div className="detail-list">
        {Object.keys(FIELD_LABELS).map((k) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18 }}>
            <span>
              <span style={{ display: 'block', color: 'var(--mute)', fontSize: 10 }}>{FIELD_LABELS[k]}</span>
              <strong style={{ fontSize: 12 }}>{shipment.profile[k] || '未提供'}</strong>
            </span>
            <button
              type="button"
              className="section-link"
              onClick={() => openModal({ type: 'field-edit', fieldKey: k })}
            >
              查看 / 编辑 <Icon name="edit" size="sm" />
            </button>
          </div>
        ))}
      </div>
      <div className="prototype-note" style={{ marginTop: 20 }}>
        字段修改只调整结构化提取结果，原始单证内容不变，所有变更会记入操作记录。
      </div>
    </Drawer>
  )
}
