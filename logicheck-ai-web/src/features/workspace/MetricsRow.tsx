import { Icon } from '../../components/Icon'
import { useStore } from '../../store/AppStore'
import { countIssues } from '../../services/domain/shipmentStatus'
import { scrollToSection } from '../../utils/format'

/** 工作台顶部四个指标卡 —— 与原型 metrics 一致，点击滚动到对应区块 */
export function MetricsRow() {
  const { activeShipment } = useStore()
  const s = activeShipment!
  const issueCount = countIssues(s)
  const profileCount = Object.values(s.profile).filter(Boolean).length

  return (
    <div className="metrics">
      <button type="button" className="metric" onClick={() => scrollToSection('docs')}>
        <div className="m-top">
          已上传单证 <Icon name="file" />
        </div>
        <strong>{String(s.documents.length).padStart(2, '0')}</strong>
        <small>支持继续补充文件</small>
      </button>
      <button type="button" className="metric" onClick={() => scrollToSection('issues')} data-testid="metric-issues">
        <div className="m-top">
          待处理异常 <Icon name="alert" />
        </div>
        <strong style={{ color: issueCount ? 'var(--red)' : undefined }}>
          {String(issueCount).padStart(2, '0')}
        </strong>
        <small>集中查看及修正</small>
      </button>
      <button type="button" className="metric" onClick={() => scrollToSection('profile')}>
        <div className="m-top">
          货物字段 <Icon name="package" />
        </div>
        <strong>{String(profileCount).padStart(2, '0')}</strong>
        <small>{s.isDemo ? 'AI 字段结果（演示）' : '尚未提取'}</small>
      </button>
      <button type="button" className="metric" onClick={() => scrollToSection('rules')}>
        <div className="m-top">
          合规规则 <Icon name="shield" />
        </div>
        <strong>{s.isDemo ? '05' : '—'}</strong>
        <small>{s.isDemo ? '有限规则演示集' : '等待规则执行'}</small>
      </button>
    </div>
  )
}
