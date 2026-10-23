import { useState } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'

/** 记录人工复核弹窗 —— 与原型 review 一致 */
export function ReviewModal({ findingId }: { findingId: string }) {
  const { activeShipment, closeModal, recordReview } = useStore()
  const [note, setNote] = useState('')
  const finding = activeShipment?.findings.find((f) => f.id === findingId)

  return (
    <Modal
      title="记录人工复核"
      onClose={closeModal}
      testId="review-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => void recordReview(findingId, note)}
            data-testid="save-review"
          >
            保存复核意见
          </Button>
        </>
      }
    >
      <p>记录处理意见，不会自动将异常判为「已解决」。如果风险仍然存在，系统保留异常标记。</p>
      <div className="form-row">
        <label htmlFor="review-issue">异常问题</label>
        <div className="input" style={{ color: 'var(--soft)' }} id="review-issue">
          {finding?.title}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="review-note">复核说明</label>
        <textarea
          className="field"
          id="review-note"
          rows={5}
          required
          minLength={3}
          placeholder="例如：已联系供应商，等待补发正确装箱单..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="review-note"
        />
      </div>
    </Modal>
  )
}
