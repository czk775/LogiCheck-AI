import { Icon } from '../../components/Icon'
import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { apiMode } from '../../services/api'
import { describeExtractionSource } from '../../services/domain/aiStatus'
import { FIELD_LABELS } from '../../types/domain'
import type { Shipment } from '../../types/domain'

/** 完整货物字段抽屉（窄）—— 与原型 profileDrawer 一致 */
export function ProfileDrawer({ shipment }: { shipment: Shipment }) {
  const { closeDrawer, openModal } = useStore()
  const real = apiMode === 'real'

  // 真实货物：profile 表尚未落库，字段来自各单证的确定性提取（含溯源）
  const merged = new Map<string, { value: string; from: string; confidence: number; status: string }>()
  if (real) {
    for (const d of shipment.documents) {
      for (const [k, v] of Object.entries(d.fields)) {
        merged.set(k, {
          value: v,
          from: d.fileName,
          confidence: d.fieldMeta?.[k]?.confidence ?? 0,
          status: d.fieldMeta?.[k]?.status ?? 'extracted',
        })
      }
    }
  }

  const valueOf = (k: string): string => (real ? merged.get(k)?.value ?? '' : shipment.profile[k] ?? '')

  // 来源说明按实际提取方式给出
  const sourceProvider =
    shipment.documents.find((d) => d.extractionProvider === 'ocr+ai')?.extractionProvider ??
    shipment.documents.find((d) => d.extractionProvider === 'ai')?.extractionProvider ??
    shipment.documents.find((d) => d.extractionProvider)?.extractionProvider
  const sourceModel = shipment.documents.find((d) => d.extractionModel)?.extractionModel

  return (
    <Drawer
      title="货物信息 · 完整字段"
      subtitle="统一货物信息 / 字段级复核 / 来源证据"
      onClose={closeDrawer}
      testId="profile-drawer"
    >
      <p className="detail-paragraph">
        {real
          ? describeExtractionSource(sourceProvider, sourceModel) + '缺失字段不以默认值填充，冲突项需根据原始单证人工复核。'
          : 'AI 将不同文件的字段汇总到统一货物对象。此处是演示提取结果，冲突项必须根据原始单证人工复核。'}
      </p>
      <div className="detail-list">
        {Object.keys(FIELD_LABELS).map((k) => {
          const entry = merged.get(k)
          return (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 18 }}>
              <span>
                <span style={{ display: 'block', color: 'var(--mute)', fontSize: 10 }}>{FIELD_LABELS[k]}</span>
                <strong style={{ fontSize: 12 }}>{valueOf(k) || '未提取到'}</strong>
                {real && entry ? (
                  <span style={{ display: 'block', color: 'var(--mute)', fontSize: 10 }}>
                    来源：{entry.from} · 置信度 {(entry.confidence * 100).toFixed(0)}%
                    {entry.status === 'low_confidence' ? ' · 低置信' : ''}
                  </span>
                ) : null}
              </span>
              <button
                type="button"
                className="section-link"
                onClick={() => openModal({ type: 'field-edit', fieldKey: k })}
              >
                查看 / 编辑 <Icon name="edit" size="sm" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="prototype-note" style={{ marginTop: 20 }}>
        字段修改只调整结构化提取结果，原始单证内容不变，所有变更会记入操作记录。
      </div>
    </Drawer>
  )
}
