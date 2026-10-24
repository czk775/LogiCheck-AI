import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import type { Finding } from '../../types/domain'

/** 异常区块 —— 待处理异常 + 已处理归档（可展开查看并重新打开） */
export function IssuesSection() {
  const { activeShipment, openDrawer } = useStore()
  const s = activeShipment!
  const [showResolved, setShowResolved] = useState(false)

  const open = s.findings.filter((f) => f.status !== 'resolved')
  const resolved = s.findings.filter((f) => f.status === 'resolved')

  const onOpen = (f: Finding) => openDrawer({ type: 'issue', findingId: f.id })

  const renderItem = (f: Finding) => (
    <button
      type="button"
      className="issue-item"
      key={f.id}
      onClick={() => onOpen(f)}
      data-testid="issue-item"
      data-finding-id={f.id}
      data-finding-status={f.status}
    >
      <div className={`issue-icon ${f.severity === 'warn' ? 'warn' : ''}`}>
        <Icon name={f.status === 'resolved' ? 'checkcircle' : f.severity === 'danger' ? 'alert' : 'info'} />
      </div>
      <div className="issue-copy">
        <strong>{f.title}</strong>
        <small>{f.summary}</small>
      </div>
      <Chip
        label={f.status === 'resolved' ? '已处理' : f.status === 'reviewed' ? '人工已复核' : '待处理'}
        tone={f.status === 'resolved' ? 'good' : f.status === 'reviewed' ? 'info' : f.severity === 'danger' ? 'danger' : 'warn'}
      />
      <Icon name="chevron" size="sm" />
    </button>
  )

  return (
    <section id="issues" className="glass-panel section-card">
      <div className="section-title">
        <h2>{s.isDemo ? '待处理异常' : '异常与处理状态'}</h2>
        <button type="button" className="section-link" onClick={() => openDrawer({ type: 'activity' })}>
          处理记录 <Icon name="arrow" size="sm" />
        </button>
      </div>

      {open.length ? (
        <div className="issue-list">{open.map(renderItem)}</div>
      ) : s.documents.length ? (
        <EmptyState
          icon="checkcircle"
          title="暂无待处理异常"
          description={
            s.isDemo
              ? '已解决事项保留在处理记录中。'
              : '当前没有待处理的冲突或规则跟进项；已处理事项可在此展开查看。'
          }
          compact
        />
      ) : (
        <EmptyState
          icon="checkcircle"
          title="等待单证上传"
          description="添加单证后，异常会在预检完成后集中显示。"
        />
      )}

      {resolved.length ? (
        <>
          <button
            type="button"
            className="section-link"
            style={{ marginTop: 14 }}
            onClick={() => setShowResolved((v) => !v)}
            data-testid="toggle-resolved"
          >
            {showResolved ? '收起已处理' : `查看已处理（${resolved.length}）`}
            <Icon name={showResolved ? 'chevron' : 'arrow'} size="sm" />
          </button>
          {showResolved ? (
            <div className="issue-list" style={{ marginTop: 10 }}>
              {resolved.map(renderItem)}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
