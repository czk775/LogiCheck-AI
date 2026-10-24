import { useState } from 'react'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'

/** 标记异常已人工处理完毕 —— 必须填写处理说明（留档不可删除） */
export function ResolveModal({ findingId }: { findingId: string }) {
  const { activeShipment, closeModal, resolveFinding } = useStore()
  const [note, setNote] = useState('')
  const finding = activeShipment?.findings.find((f) => f.id === findingId)

  return (
    <Modal
      title="标记为已处理"
      onClose={closeModal}
      testId="resolve-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="primary"
            icon="check"
            onClick={() => void resolveFinding(findingId, note)}
            data-testid="save-resolve"
          >
            确认已处理
          </Button>
        </>
      }
    >
      <p>标记为已处理表示你已人工完成该异常的处置。处理说明会写入处理记录，无法删除；后续重新检查不会自动撤销你的判断。</p>
      <div className="form-row">
        <label htmlFor="resolve-issue">异常问题</label>
        <div className="input" style={{ color: 'var(--soft)' }} id="resolve-issue">
          {finding?.title}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="resolve-note">处理说明（必填）</label>
        <textarea
          className="field"
          id="resolve-note"
          rows={5}
          required
          minLength={3}
          placeholder="例如：已与供应商确认并补发装箱单，货值与发票一致..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="resolve-note"
        />
      </div>
    </Modal>
  )
}

/** 重新打开异常 —— 人工发现此前判断有误 */
export function ReopenModal({ findingId }: { findingId: string }) {
  const { activeShipment, closeModal, reopenFinding } = useStore()
  const [note, setNote] = useState('')
  const finding = activeShipment?.findings.find((f) => f.id === findingId)

  return (
    <Modal
      title="重新打开异常"
      onClose={closeModal}
      testId="reopen-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="primary"
            icon="refresh"
            onClick={() => void reopenFinding(findingId, note)}
            data-testid="save-reopen"
          >
            重新打开
          </Button>
        </>
      }
    >
      <p>重新打开后该异常会回到待处理状态，重新检查时会再次核验。</p>
      <div className="form-row">
        <label htmlFor="reopen-issue">异常问题</label>
        <div className="input" style={{ color: 'var(--soft)' }} id="reopen-issue">
          {finding?.title}
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="reopen-note">重新打开的原因（必填）</label>
        <textarea
          className="field"
          id="reopen-note"
          rows={5}
          required
          minLength={3}
          placeholder="例如：供应商提供的装箱单数量仍与发票不符，需继续追查..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="reopen-note"
        />
      </div>
    </Modal>
  )
}
