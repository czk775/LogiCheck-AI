import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Button } from '../../components/Button'
import { Chip } from '../../components/Chip'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import { SHIPMENT_STATUS_META, countIssues, statusShip } from '../../services/domain/shipmentStatus'
import { formatTime } from '../../utils/format'
import { DEMO_NOTICE } from '../../constants'
import type { Shipment } from '../../types/domain'

/** 货物管理列表页 —— 与已确认原型一致 */
export function ShipmentListPage() {
  const { state, setSearch, setFilter, toggleMenu, openModal, createShipment, openShipment } = useStore()
  const navigate = useNavigate()
  const searchRef = useRef<HTMLInputElement>(null)

  // 点击空白处关闭行菜单
  useEffect(() => {
    if (!state.openMenuShipmentId) return
    const close = () => toggleMenu(state.openMenuShipmentId as string)
    const timer = setTimeout(() => document.addEventListener('click', close), 0)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', close)
    }
  }, [state.openMenuShipmentId, toggleMenu])

  const filtered = useMemo(() => {
    const query = state.search.trim().toLowerCase()
    return state.shipments.filter(
      (s) =>
        (!query || [s.name, s.id].some((v) => String(v).toLowerCase().includes(query))) &&
        (state.filter === 'all' || statusShip(s) === state.filter),
    )
  }, [state.shipments, state.search, state.filter])

  const onCreate = async () => {
    const shipment = await createShipment()
    if (shipment) navigate(`/shipments/${shipment.id}`)
  }

  const onOpen = (id: string) => {
    openShipment(id)
    navigate(`/shipments/${id}`)
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">SHIPMENT OPERATIONS</div>
          <h1>货物管理</h1>
          <p className="page-sub">管理每一票货物的单证、预检进度与待办事项。</p>
        </div>
        <div className="actions">
          <Button variant="primary" icon="plus" onClick={onCreate} data-testid="new-shipment">
            新建货物
          </Button>
        </div>
      </div>

      <div className="hero">
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            SHIPMENT CONTROL CENTER
          </div>
          <strong>所有单证，一处掌控。</strong>
          <p>上传单证后自动进入预检流程；问题集中呈现，证据随时可查，处理结果可追溯。</p>
        </div>
        <div className="hero-symbol">
          <Icon name="activity" size="xl" />
        </div>
      </div>

      <div className="section-title">
        <h2>
          全部货物{' '}
          <span style={{ color: 'var(--mute)', fontSize: 11, fontWeight: 500, marginLeft: 7 }}>
            {state.shipments.length} 票
          </span>
        </h2>
        <span className="section-hint">数据仅保存在当前浏览器的演示存储中</span>
      </div>

      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" />
          <input
            ref={searchRef}
            placeholder="搜索货物编号或产品名称..."
            value={state.search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索货物"
            data-testid="shipment-search"
          />
        </div>
        <select
          className="field select"
          aria-label="筛选货物状态"
          value={state.filter}
          onChange={(e) => setFilter(e.target.value as typeof state.filter)}
          data-testid="status-filter"
        >
          <option value="all">全部状态</option>
          <option value="draft">待上传</option>
          <option value="needs_review">待处理异常</option>
          <option value="awaiting">待接入 AI</option>
          <option value="checked">检查完成</option>
        </select>
      </div>

      <div className="table-wrap">
        <table className="ship-table">
          <thead>
            <tr>
              <th>货物信息</th>
              <th>贸易路线</th>
              <th>单证数量</th>
              <th>预检状态</th>
              <th>更新时间</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody data-testid="shipment-rows">
            {filtered.length ? (
              filtered.map((s) => (
                <ShipmentRow
                  key={s.id}
                  shipment={s}
                  menuOpen={state.openMenuShipmentId === s.id}
                  onOpen={onOpen}
                  onToggleMenu={toggleMenu}
                  onAskDelete={(id) => openModal({ type: 'delete-shipment', shipmentId: id })}
                />
              ))
            ) : (
              <tr>
                <td colSpan={6}>
                  {state.shipments.length ? (
                    <EmptyState
                      icon="search"
                      title="没有找到匹配的货物"
                      description="尝试调整搜索词或筛选条件。"
                    />
                  ) : (
                    <EmptyState
                      icon="package"
                      title="还没有货物"
                      description="新建第一票货物，然后上传单证即可开始。"
                      action={
                        <Button variant="primary" icon="plus" onClick={onCreate}>
                          新建货物
                        </Button>
                      }
                    />
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="footer-note">{DEMO_NOTICE}</div>
    </section>
  )
}

interface ShipmentRowProps {
  shipment: Shipment
  menuOpen: boolean
  onOpen: (id: string) => void
  onToggleMenu: (id: string) => void
  onAskDelete: (id: string) => void
}

function ShipmentRow({ shipment: s, menuOpen, onOpen, onToggleMenu, onAskDelete }: ShipmentRowProps) {
  const status = statusShip(s)
  const meta = SHIPMENT_STATUS_META[status]
  const issues = countIssues(s)

  return (
    <tr data-testid="shipment-row" data-shipment-id={s.id}>
      <td>
        <div className="ship-title">
          {s.name || '未命名货物'}{' '}
          {s.isDemo ? (
            <span style={{ color: 'var(--cyan)', fontSize: 10, marginLeft: 5 }}>· 演示</span>
          ) : null}
        </div>
        <div className="ship-sub">{s.id}</div>
      </td>
      <td>
        {s.origin} → {s.destination}
      </td>
      <td>{s.documents.length} 份</td>
      <td>
        <Chip label={meta.label} tone={meta.tone} />
        {issues > 0 && status === 'needs_review' ? (
          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--red)' }}>{issues} 项异常</span>
        ) : null}
      </td>
      <td style={{ color: 'var(--mute)' }}>{formatTime(s.updatedAt)}</td>
      <td>
        <div className="row-actions">
          <button type="button" className="link-btn" onClick={() => onOpen(s.id)}>
            进入工作台 <Icon name="arrowup" size="sm" />
          </button>
          <div className="menu-anchor">
            <button
              type="button"
              className="more-btn"
              onClick={(e) => {
                e.stopPropagation()
                onToggleMenu(s.id)
              }}
              title="更多操作"
              aria-label="更多操作"
              data-testid="row-menu-button"
            >
              <Icon name="dots" />
            </button>
            {menuOpen ? (
              <div className="popover-menu" data-testid="row-menu">
                <button type="button" onClick={() => onOpen(s.id)}>
                  <Icon name="arrowup" size="sm" />
                  进入工作台
                </button>
                <button
                  type="button"
                  className="warned"
                  onClick={() => {
                    onAskDelete(s.id)
                  }}
                  data-testid="delete-shipment"
                >
                  <Icon name="trash" size="sm" />
                  删除货物
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </td>
    </tr>
  )
}
