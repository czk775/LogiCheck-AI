import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

export type ThemeMode = 'dark' | 'light'

/** 与已确认原型一致的存储键，用户此前的主题偏好可以延续 */
export const THEME_STORAGE_KEY = 'logicheck_theme_v2'

function readStoredTheme(): ThemeMode {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

interface ThemeContextValue {
  mode: ThemeMode
  toggle: () => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(readStoredTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = mode
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', mode === 'light' ? '#f3f7fb' : '#070c15')
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
    } catch {
      /* 隐私模式下忽略持久化 */
    }
  }, [mode])

  const toggle = useCallback(() => {
    setMode((m) => (m === 'light' ? 'dark' : 'light'))
  }, [])

  const value = useMemo(() => ({ mode, toggle }), [mode, toggle])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用')
  return ctx
}
