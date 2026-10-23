import type { ChipTone } from '../services/domain/shipmentStatus'

interface ChipProps {
  label: string
  tone?: ChipTone
  withDot?: boolean
  className?: string
}

/** 状态徽章 —— 与原型 chip 组件一致 */
export function Chip({ label, tone = 'neutral', withDot = true, className = '' }: ChipProps) {
  const toneClass = tone === 'neutral' ? 'neutral' : tone
  return (
    <span className={`chip ${toneClass} ${className}`.trim()}>
      {withDot ? <span className="chipdot" /> : null}
      <span>{label}</span>
    </span>
  )
}
