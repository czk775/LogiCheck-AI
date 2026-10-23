import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { useEscapeKey } from './Toast'

interface DrawerProps {
  title: string
  subtitle?: string
  onClose: () => void
  /** true = 宽抽屉（900px，异常详情）；false = 窄抽屉（640px） */
  wide?: boolean
  children: ReactNode
  testId?: string
}

/** 右侧抽屉 —— 与原型 drawer 组件一致 */
export function Drawer({ title, subtitle, onClose, wide = false, children, testId }: DrawerProps) {
  useEscapeKey(true, onClose)
  return (
    <>
      <div className="drawer-overlay" onClick={onClose} data-testid="drawer-overlay" />
      <aside
        className={`drawer ${wide ? '' : 'narrow'}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId ?? 'drawer'}
      >
        <div className="drawer-head">
          <div>
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </div>
          <button type="button" className="close" onClick={onClose} title="关闭" aria-label="关闭抽屉">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-content">{children}</div>
      </aside>
    </>
  )
}
