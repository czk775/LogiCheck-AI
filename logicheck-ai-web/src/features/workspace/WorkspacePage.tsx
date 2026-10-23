import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { useStore } from '../../store/AppStore'
import { useToast } from '../../components/Toast'
import { useFileChooser } from '../layout/AppShell'
import { StatusPanel } from './StatusPanel'
import { NextActionPanel } from './NextActionPanel'
import { MetricsRow } from './MetricsRow'
import { IssuesSection } from './IssuesSection'
import { DocumentsSection } from './DocumentsSection'
import { ProfileSection } from './ProfileSection'
import { RulesSection } from './RulesSection'
import { WorkflowSection } from './WorkflowSection'
import { formatTime } from '../../utils/format'
import { DEMO_NOTICE } from '../../constants'
import { apiMode } from '../../services/api'

/** 货物工作台 —— 与已确认原型一致：状态 → 异常 → 行动优先 */
export function WorkspacePage() {
  const { shipmentId } = useParams<{ shipmentId: string }>()
  const { state, activeShipment, openShipment, recheck } = useStore()
  const { push } = useToast()
  const navigate = useNavigate()
  const chooser = useFileChooser()

  // 同步 URL 参数与激活货物；货物不存在时回列表
  // 注意：必须等 Store 水合完成再判断存在性，否则刷新深链接会误判为「不存在」
  useEffect(() => {
    if (!shipmentId || !state.hydrated) return
    const found = state.shipments.find((s) => s.id === shipmentId)
    if (found) {
      if (state.activeShipmentId !== shipmentId) openShipment(shipmentId)
    } else {
      push('货物不存在或已被删除', 'error')
      navigate('/shipments', { replace: true })
    }
  }, [shipmentId, state.shipments, state.activeShipmentId, state.hydrated, openShipment, push, navigate])

  if (!state.hydrated) return null
  if (!activeShipment || activeShipment.id !== shipmentId) {
    return null
  }

  const s = activeShipment

  return (
    <section className="page">
      <button type="button" className="backlink" onClick={() => navigate('/shipments')}>
        <Icon name="left" size="sm" /> 返回货物列表
      </button>

      <div className="workspace-head">
        <div>
          <div className="eyebrow">SHIPMENT / {s.id}</div>
          <h1 className="workspace-title">{s.name}</h1>
          <div className="workspace-meta">
            <span>
              {s.origin} → {s.destination}
            </span>
            <span className="dotsep" />
            <span>{s.isDemo ? '演示场景' : '用户创建'}</span>
            <span className="dotsep" />
            <span>更新于 {formatTime(s.updatedAt)}</span>
          </div>
        </div>
        <div className="actions">
          <Button icon="plus" onClick={() => chooser.open({ kind: 'add' })} data-testid="upload-documents">
            补充单证
          </Button>
          <Button variant="primary" icon="refresh" onClick={() => void recheck()} data-testid="recheck">
            重新检查
          </Button>
        </div>
      </div>

      <div className="workspace-hero">
        <StatusPanel />
        <NextActionPanel />
      </div>

      <MetricsRow />

      <div className="grid-work">
        <div className="work-col">
          <IssuesSection />
          <DocumentsSection />
          <ProfileSection />
        </div>
        <div className="work-col">
          <RulesSection />
          <WorkflowSection />
        </div>
      </div>

      <div className="foot-disclaimer">
        {DEMO_NOTICE}。
        {apiMode === 'real'
          ? '上传的真实文件保存在本机服务器磁盘，仅你本人可以访问；本机部署不等于生产级数据安全方案。'
          : '上传的真实文件不会被发送到云端；浏览器本地文件缓存不属于生产级数据安全方案。'}
      </div>
    </section>
  )
}
