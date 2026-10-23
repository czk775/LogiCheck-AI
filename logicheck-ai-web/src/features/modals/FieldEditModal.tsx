import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'
import { FIELD_LABELS } from '../../types/domain'

/** 修正提取字段弹窗 —— 与原型 profile-edit 一致 */
export function FieldEditModal({ fieldKey, sourceDocumentId }: { fieldKey: string; sourceDocumentId?: string }) {
  const { activeShipment, closeModal, updateField } = useStore()
  const s = activeShipment!

  const sourceDocs = useMemo(
    () => s.documents.filter((d) => Object.hasOwn(d.fields, fieldKey)),
    [s.documents, fieldKey],
  )
  const [selected, setSelected] = useState(sourceDocumentId ?? sourceDocs[0]?.id ?? '')
  const [value, setValue] = useState('')

  // 来源单证变化时同步当前值（与原型 sourceDoc change 行为一致）
  useEffect(() => {
    const doc = s.documents.find((d) => d.id === selected)
    setValue(doc?.fields[fieldKey] ?? s.profile[fieldKey] ?? '')
  }, [selected, s.documents, s.profile, fieldKey])

  if (!s.isDemo) {
    return (
      <Modal title="编辑字段" onClose={closeModal} testId="field-edit-modal">
        <p>当前新货物没有真实 AI 提取字段；请在后端接入后使用证据驱动的字段修正功能。</p>
        <Button variant="primary" onClick={closeModal}>
          知道了
        </Button>
      </Modal>
    )
  }

  const label = FIELD_LABELS[fieldKey] ?? fieldKey

  return (
    <Modal
      title="修正提取字段"
      onClose={closeModal}
      testId="field-edit-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => void updateField(fieldKey, selected, value)}
            disabled={!selected}
            data-testid="save-field"
          >
            保存修正
          </Button>
        </>
      }
    >
      <p>仅修改 AI 提取层数据，不会覆盖原始单证。修改后需要重新检查，系统仍保留原值和操作记录。</p>
      <div className="form-row">
        <label htmlFor="source-doc">来源单证</label>
        <select
          className="field"
          id="source-doc"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={!sourceDocs.length}
        >
          {sourceDocs.length ? (
            sourceDocs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.fileName}
              </option>
            ))
          ) : (
            <option value="">暂无来源</option>
          )}
        </select>
        <div className="form-hint">选择要修正的提取结果；如果两份单证实际内容冲突，单纯修改汇总字段不会消除冲突。</div>
      </div>
      <div className="form-row">
        <label htmlFor="new-value">{label}</label>
        <input
          className="field"
          id="new-value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
          data-testid="field-value-input"
        />
      </div>
      <div className="prototype-note">
        <Icon name="info" size="sm" />
        演示货物中的字段值为模拟提取结果，可用于验证编辑、留痕与重新核验。
      </div>
    </Modal>
  )
}
