import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { Modal } from '../../components/Modal'
import { useStore } from '../../store/AppStore'
import { DEMO_NOTICE } from '../../constants'

/** 体验指南弹窗 —— 与原型 guide 一致 */
export function GuideModal() {
  const { closeModal } = useStore()
  return (
    <Modal title="体验指南" onClose={closeModal} testId="guide-modal">
      <p>第一版支持从登录到异常复核的完整交互体验。建议按以下顺序操作：</p>
      <ol className="guide-list">
        <li>
          <span className="guide-number">1</span>
          进入演示货物「SHP-2026-001」，查看预置的数量冲突和合规提醒。
        </li>
        <li>
          <span className="guide-number">2</span>
          点击「数量不一致」，左右切换发票与装箱单证据。
        </li>
        <li>
          <span className="guide-number">3</span>
          点击「修正 AI 提取」，将装箱单数量 980 改为 1000，再点击「重新检查」。
        </li>
        <li>
          <span className="guide-number">4</span>
          创建新货物，选择真实 PDF / 图片 / EDIFACT 文件，体验批量上传和原件预览。
        </li>
        <li>
          <span className="guide-number">5</span>
          试用搜索、筛选、人工复核、规则详情和删除确认。
        </li>
      </ol>
      <div className="auth-note">
        <Icon name="info" size="sm" />
        重要：演示货物的数据是测试样例。上传的真实文件不会经过 AI 解析；不会向服务器上传，也不会自动生成虚假的字段和检查结论。
      </div>
      <Button variant="primary" icon="check" onClick={closeModal}>
        开始体验
      </Button>
    </Modal>
  )
}

/** 关于此演示弹窗 —— 与原型 about 一致 */
export function AboutModal() {
  const { closeModal } = useStore()
  return (
    <Modal title="关于此演示" onClose={closeModal} testId="about-modal">
      <p>{DEMO_NOTICE}</p>
      <div className="detail-list">
        <div>登录、账号隔离均为浏览器本地体验，不是生产级身份验证。</div>
        <div>演示案例包含人工制作的数据样例，可验证结构化核验和异常状态流转。</div>
        <div>新上传的真实文件仅保存在当前浏览器本地，并提供原件预览，不执行外部模型推理。</div>
        <div>正式开发时需接入真实 AI、后端数据库、私有对象存储和权限策略。</div>
      </div>
      <Button variant="primary" icon="check" onClick={closeModal}>
        知道了
      </Button>
    </Modal>
  )
}
