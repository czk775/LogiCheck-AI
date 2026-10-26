import { useStore } from '../../store/AppStore'
import { ForgotPasswordModal } from './ForgotPasswordModal'
import { RecheckInfoModal, RuleHelpModal } from './RuleHelpModal'
import { DeleteDocumentModal, DeleteShipmentModal } from './DeleteModals'
import { FieldEditModal } from './FieldEditModal'
import { ReviewModal } from './ReviewModal'
import { ReopenModal, ResolveModal } from './ResolveModals'

/** 弹窗挂载点：按 UI 状态渲染对应模态 */
export function ModalHost() {
  const { state } = useStore()
  const modal = state.modal
  if (!modal) return null

  switch (modal.type) {
    case 'rule-help':
      return <RuleHelpModal />
    case 'recheck-info':
      return <RecheckInfoModal />
    case 'forgot-password':
      return <ForgotPasswordModal />
    case 'delete-shipment':
      return <DeleteShipmentModal shipmentId={modal.shipmentId} />
    case 'delete-document':
      return <DeleteDocumentModal documentId={modal.documentId} />
    case 'field-edit':
      return <FieldEditModal fieldKey={modal.fieldKey} sourceDocumentId={modal.sourceDocumentId} />
    case 'review':
      return <ReviewModal findingId={modal.findingId} />
    case 'resolve':
      return <ResolveModal findingId={modal.findingId} />
    case 'reopen':
      return <ReopenModal findingId={modal.findingId} />
    default:
      return null
  }
}
