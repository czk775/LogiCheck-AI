import { useTheme } from '../theme/ThemeProvider'
import { Icon } from './Icon'

/** 主题切换按钮 —— 与原型一致：图标 + 文案 + 开关，写入 localStorage 记忆 */
export function ThemeToggle() {
  const { mode, toggle } = useTheme()
  const light = mode === 'light'
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`切换到${light ? '深色' : '浅色'}主题`}
      title={`切换到${light ? '深色' : '浅色'}主题`}
      aria-pressed={light}
      data-testid="theme-toggle"
    >
      <Icon name={light ? 'moon' : 'sun'} size="sm" />
      <span>{light ? '浅色模式' : '深色模式'}</span>
      <span className="theme-switch" aria-hidden="true">
        <span />
      </span>
    </button>
  )
}
