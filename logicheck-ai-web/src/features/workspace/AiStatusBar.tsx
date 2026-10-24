import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useStore } from '../../store/AppStore'
import { apiMode } from '../../services/api'
import { toAiStatusView } from '../../services/domain/aiStatus'

/**
 * 工作台顶部 AI 状态条（第五阶段）
 *
 * 设计约束（用户明确要求）：
 *   - 顶部只放一句简短的「AI 已连接 / AI 不可用」，不堆技术信息
 *   - 点击才展开详情（模型名、运行模式、识别能力）
 *   - 不展示 API Key
 *   - 不把限流配额称作「免费余额」
 */
export function AiStatusBar() {
  const { state, refreshAiStatus } = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const view = toAiStatusView(state.aiStatus, apiMode)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="ai-status" ref={ref}>
      <button
        type="button"
        className={`ai-status-trigger tone-${view.tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-testid="ai-status-trigger"
        title={view.hint}
      >
        <span className="ai-status-dot" aria-hidden="true" />
        <span>{view.label}</span>
        <span className={`ai-status-caret${open ? ' open' : ''}`} aria-hidden="true">
          <Icon name="down" size="sm" />
        </span>
      </button>

      {open ? (
        <div className="ai-status-pop" role="dialog" aria-label="AI 能力状态" data-testid="ai-status-panel">
          <dl className="ai-status-list">
            {view.details.map((d) => (
              <div className="ai-status-item" key={d.label}>
                <dt>{d.label}</dt>
                <dd>{d.value}</dd>
              </div>
            ))}
          </dl>
          {view.hint ? <p className="ai-status-hint">{view.hint}</p> : null}
          <button
            type="button"
            className="ai-status-refresh"
            onClick={() => void refreshAiStatus()}
            data-testid="ai-status-refresh"
          >
            <Icon name="refresh" size="sm" /> 重新检测
          </button>
        </div>
      ) : null}
    </div>
  )
}
