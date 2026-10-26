import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { useStore } from '../../store/AppStore'
import { useFileChooser } from '../layout/AppShell'
import { countIssues } from '../../services/domain/shipmentStatus'

/** 下一步建议面板 —— 与原型 next-panel 一致 */
export function NextActionPanel() {
  const { activeShipment, openDrawer } = useStore()
  const chooser = useFileChooser()
  const s = activeShipment!
  const hasDocs = s.documents.length > 0
  const issueCount = countIssues(s)
  const failedCount = s.documents.filter((d) => d.status === 'failed').length

  const title = !hasDocs
    ? '上传这票货物的单证'
    : issueCount
      ? '优先处理待办异常'
      : failedCount
        ? '处理失败的单证'
        : '继续管理单证与货物资料'

  const desc = !hasDocs
    ? '支持多文件上传、批量添加。'
    : issueCount
      ? '请先处理数量冲突或缺失的合规材料，再重新检查。'
      : failedCount
        ? '失败原因已标注在单证卡片上，可修正后重新上传，或对单证重试解析。'
        : '可以继续补充单证，或查看已保存的检查记录。'

  const onAction = () => {
    if (!hasDocs) {
      chooser.open({ kind: 'add' })
    } else if (issueCount) {
      const first = s.findings.find((f) => f.status !== 'resolved')
      if (first) openDrawer({ type: 'issue', findingId: first.id })
    } else {
      openDrawer({ type: 'activity' })
    }
  }

  const actionLabel = !hasDocs
    ? '上传单证'
    : issueCount
      ? '查看第一个异常'
      : '查看处理记录'

  return (
    <div className="glass-panel next-panel">
      <div className="top-mini">
        <Icon name="bolt" /> 下一步建议
      </div>
      <div>
        <h3>{title}</h3>
        <p>{desc}</p>
      </div>
      <Button icon="arrow" onClick={onAction} data-testid="next-action">
        {actionLabel}
      </Button>
    </div>
  )
}
