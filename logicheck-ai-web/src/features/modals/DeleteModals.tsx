import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'

/** 删除货物确认弹窗 —— 与原型 delete 一致 */
export function DeleteShipmentModal({ shipmentId }: { shipmentId: string }) {
  const { state, closeModal, deleteShipment } = useStore()
  const target = state.shipments.find((s) => s.id === shipmentId)

  return (
    <Modal
      title="删除这票货物？"
      onClose={closeModal}
      testId="delete-shipment-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="danger"
            icon="trash"
            onClick={() => void deleteShipment(shipmentId)}
            data-testid="confirm-delete-shipment"
          >
            确认删除
          </Button>
        </>
      }
    >
      <p>
        你即将删除 <strong style={{ color: 'var(--txt)' }}>{target?.id} · {target?.name}</strong>
        。这会删除与它关联的单证、提取字段、异常和处理记录。
      </p>
    </Modal>
  )
}

/** 移除单证确认弹窗 —— 与原型 delete-doc 一致 */
export function DeleteDocumentModal({ documentId }: { documentId: string }) {
  const { activeShipment, closeModal, deleteDocument } = useStore()
  const doc = activeShipment?.documents.find((d) => d.id === documentId)

  return (
    <Modal
      title="移除单证？"
      onClose={closeModal}
      testId="delete-doc-modal"
      actions={
        <>
          <Button onClick={closeModal}>取消</Button>
          <Button
            variant="danger"
            icon="trash"
            onClick={() => void deleteDocument(documentId)}
            data-testid="confirm-delete-doc"
          >
            移除单证
          </Button>
        </>
      }
    >
      <p>
        确认移除 <strong style={{ color: 'var(--txt)' }}>{doc?.fileName}</strong>？关联证据会被标为缺失或需重新检查。
      </p>
    </Modal>
  )
}
