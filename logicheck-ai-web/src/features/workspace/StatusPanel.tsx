import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { useStore } from '../../store/AppStore'
import { SHIPMENT_STATUS_META, countIssues, statusShip } from '../../services/domain/shipmentStatus'

/** 工作台总状态面板 —— 与原型 status-panel 一致 */
export function StatusPanel() {
  const { activeShipment } = useStore()
  const s = activeShipment!
  const status = statusShip(s)
  const issueCount = countIssues(s)
  const hasDocs = s.documents.length > 0
  const userOnly = !s.isDemo
  const meta = SHIPMENT_STATUS_META[status]

  const statusText = !hasDocs
    ? '上传第一份单证，开始预检'
    : userOnly
      ? '文件已接收，待接入真实 AI'
      : issueCount > 0
        ? '发现需要关注的异常'
        : s.dirty
          ? '已修改资料，等待重新检查'
          : '当前演示检查项已完成'

  const desc = !hasDocs
    ? '从第一份单证开始，逐步建立完整货物资料。'
    : userOnly
      ? '本演示不伪造上传文件的 AI 解析结果。文件已在浏览器端保存，未来将由真实 AI API 进行理解和核验。'
      : issueCount
        ? `当前有 ${issueCount} 项待处理问题。点击异常，可回溯来源单证并进行人工复核。`
        : '已完成当前演示核验。材料存在不代表具备法定合规结论。'

  const iconName = status === 'needs_review' ? 'alert' : status === 'draft' ? 'cloud' : 'activity'

  return (
    <div className="glass-panel status-panel">
      <div className="eyebrow">OVERALL PRE-CHECK STATUS</div>
      <h2>{statusText}</h2>
      <p>{desc}</p>
      <div className="status-line">
        <Icon name={iconName} />
        <Chip label={meta.label} tone={meta.tone} />
        <span>{s.dirty ? '资料已改变，建议重新检查' : '基于当前货物资料'}</span>
      </div>
    </div>
  )
}
