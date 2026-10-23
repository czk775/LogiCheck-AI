import { Navigate, useLocation } from 'react-router-dom'
import type { ReactElement } from 'react'
import { useStore } from '../../store/AppStore'

/** 路由守卫：未登录访问已登录区域时跳转登录页 */
export function RequireAuth({ children }: { children: ReactElement }) {
  const { state } = useStore()
  const location = useLocation()
  // 水合完成前不得做登录判断：否则刷新深链接时会因 account 暂空被误踢到登录页，
  // 且 replace 跳转会永久丢失原始 URL（refresh 深链接恢复失败）
  if (!state.hydrated) return null
  if (!state.account) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return children
}
