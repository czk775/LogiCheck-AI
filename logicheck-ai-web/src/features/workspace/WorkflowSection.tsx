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
  // 真实货物：按实际解析 / 核验进度推导（演示货物沿用原有演示文案）
  const parsedCount = docs.filter((d) => d.status === 'parsed').length
  const failedCount = docs.filter((d) => d.status === 'failed').length
  const inFlight = docs.some((d) => d.status === 'uploading' || d.status === 'parsing')
  const engineRan = s.runs.some((r) => (r.trigger === 'check' || r.trigger === 'recheck') && r.status !== 'failed')

  const stages: Array<[string, string, 'done' | 'active' | 'todo']> = isDemo
    ? [
        ['单证上传', docs.length ? `${docs.length} 份已添加` : '等待上传', docs.length ? 'done' : 'todo'],
        ['单证理解', '已载入演示提取字段', 'done'],
        ['跨单证核验', '已运行演示规则', 'done'],
        ['目的国合规预检', '演示规则集已检查', 'done'],
        [
          '人工复核 / 重新检查',
          issues ? `${issues} 项需要关注` : '已完成当前演示检查',
          issues ? 'active' : 'todo',
        ],
      ]
    : [
        ['单证上传', docs.length ? `${docs.length} 份已添加` : '等待上传', docs.length ? 'done' : 'todo'],
        [
          '单证理解',
          failedCount ? `${parsedCount} 份已解析 · ${failedCount} 份失败` : `${parsedCount} 份已解析`,
          parsedCount ? 'done' : inFlight ? 'active' : 'todo',
        ],
        ['跨单证核验', engineRan ? '已基于实际提取值运行' : '等待解析完成', engineRan ? 'done' : 'todo'],
        ['目的国合规预检', engineRan ? '合规规则已预检' : '尚未检查', engineRan ? 'done' : 'todo'],
        [
          '人工复核 / 重新检查',
          issues ? `${issues} 项需要关注` : engineRan ? '无待处理异常' : '等待检查结果',
          issues ? 'active' : engineRan ? 'done' : 'todo',
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
