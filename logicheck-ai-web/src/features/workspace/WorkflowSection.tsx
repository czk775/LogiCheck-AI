import { Icon } from '../../components/Icon'
import { useStore } from '../../store/AppStore'
import { countIssues } from '../../services/domain/shipmentStatus'

/** 处理流程区块 —— 与原型 workflow 一致 */
export function WorkflowSection() {
  const { activeShipment, openDrawer } = useStore()
  const s = activeShipment!
  const docs = s.documents
  const isDemo = s.isDemo
  const issues = countIssues(s)

  const stages: Array<[string, string, 'done' | 'active' | 'todo']> = [
    ['单证上传', docs.length ? `${docs.length} 份已添加` : '等待上传', docs.length ? 'done' : 'todo'],
    ['单证理解', isDemo ? '已载入演示提取字段' : '等待真实 AI 服务', isDemo ? 'done' : 'todo'],
    ['跨单证核验', isDemo ? '已运行演示规则' : '等待真实字段', isDemo ? 'done' : 'todo'],
    ['目的国合规预检', isDemo ? '演示规则集已检查' : '尚未检查', isDemo ? 'done' : 'todo'],
    [
      '人工复核 / 重新检查',
      isDemo && issues
        ? `${issues} 项需要关注`
        : isDemo
          ? '已完成当前演示检查'
          : '等待检查结果',
      isDemo && issues ? 'active' : 'todo',
    ],
  ]

  return (
    <section className="glass-panel section-card">
      <div className="section-title">
        <h2>处理流程</h2>
        <button type="button" className="section-link" onClick={() => openDrawer({ type: 'activity' })}>
          查看记录 <Icon name="arrow" size="sm" />
        </button>
      </div>
      <div className="workflow-items">
        {stages.map(([name, desc, kind]) => (
          <div className="wf-item" key={name}>
            <span className={`wf-circle ${kind}`}>
              <Icon name={kind === 'done' ? 'check' : kind === 'active' ? 'activity' : 'clock'} size="sm" />
            </span>
            <div className="wf-copy">
              <strong>{name}</strong>
              <span>{desc}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
