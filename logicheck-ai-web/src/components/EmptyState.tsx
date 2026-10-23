import type { ReactNode } from 'react'
import { Icon, type IconName } from './Icon'

interface EmptyStateProps {
  icon: IconName
  title: string
  description: string
  action?: ReactNode
  compact?: boolean
}

/** 空状态 —— 与原型 empty 组件一致 */
export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div className="empty" style={compact ? { padding: 24 } : undefined}>
      <div className="empty-icon">
        <Icon name={icon} size="xl" />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}
