import { Icon } from '../../components/Icon'
import { Chip } from '../../components/Chip'
import { EmptyState } from '../../components/EmptyState'
import { useStore } from '../../store/AppStore'
import type { Finding } from '../../types/domain'

/** 待处理异常区块 —— 与原型 issueList 一致 */
export function IssuesSection() {
  const { activeShipment, openDrawer } = useStore()
  const s = activeShipment!
  const open = s.findings.filter((f) => f.status !== 'resolved')

  const onOpen = (f: Finding) => openDrawer({ type: 'issue', findingId: f.id })

  return (
    <section id="issues" className="glass-panel section-card">
      <div className="section-title">
        <h2>待处理异常</h2>
        <button type="button" className="section-link" onClick={() => openDrawer({ type: 'activity' })}>
          处理记录 <Icon name="arrow" size="sm" />
        </button>
      </div>
      {s.isDemo ? (
        open.length ? (
          <div className="issue-list">
            {open.map((f) => (
              <button
                type="button"
                className="issue-item"
                key={f.id}
                onClick={() => onOpen(f)}
                data-testid="issue-item"
              >
                <div className={`issue-icon ${f.severity === 'warn' ? 'warn' : ''}`}>
                  <Icon name={f.severity === 'danger' ? 'alert' : 'info'} />
                </div>
                <div className="issue-copy">
                  <strong>{f.title}</strong>
                  <small>{f.summary}</small>
                </div>
                <Chip
                  label={f.status === 'reviewed' ? '人工已复核' : '待处理'}
                  tone={f.status === 'reviewed' ? 'info' : f.severity === 'danger' ? 'danger' : 'warn'}
                />
                <Icon name="chevron" size="sm" />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            icon="checkcircle"
            title="暂无未解决异常"
            description="已解决事项保留在处理记录中。"
            compact
          />
        )
      ) : (
        <EmptyState
          icon="checkcircle"
          title={s.documents.length ? '暂无待处理异常' : '等待单证上传'}
          description={
            s.documents.length
              ? '当前演示异常已处理，查看历史记录了解变更。'
              : '添加单证后，异常会在预检完成后集中显示。'
          }
        />
      )}
    </section>
  )
}
