import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'

/** 合规检查说明弹窗 —— 与原型 rule-help 一致 */
export function RuleHelpModal() {
  const { closeModal } = useStore()
  return (
    <Modal title="合规检查说明" onClose={closeModal} testId="rule-help-modal">
      <p>首版合规预检聚焦中国出口德国的便携式可充电蓝牙音箱，围绕 RED、RoHS、电池、德国 WEEE 及 HS 风险提示。</p>
      <div className="detail-list">
        <div>每条规则在正式系统中需要明确来源、版本、适用条件和证据要求。</div>
        <div>「已提供材料」不等于产品真实合规，「证据不足」不能判为通过。</div>
        <div>法规风险不得由大模型自由发挥，不自动给出最终法律判断。</div>
      </div>
      <Button variant="primary" icon="check" onClick={closeModal}>
        了解
      </Button>
    </Modal>
  )
}

/** 重新检查说明弹窗 —— 与原型 recheck-info 一致 */
export function RecheckInfoModal() {
  const { closeModal } = useStore()
  return (
    <Modal title="检查说明" onClose={closeModal} testId="recheck-info-modal">
      <p>当前只有预置演示案例支持可验证的本地数量一致性核验。其他规则仍为带明确标识的案例结果。</p>
      <div className="prototype-note">
        <Icon name="info" size="sm" />
        真实上传文件的 AI 理解、法规模型与自动预检必须等待后端真实接入，演示不会伪造处理成功。
      </div>
      <Button variant="primary" onClick={closeModal}>
        返回
      </Button>
    </Modal>
  )
}
