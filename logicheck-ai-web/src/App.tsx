import { Navigate, Route, Routes } from 'react-router-dom'
import type { ReactElement } from 'react'
import { RequireAuth } from './features/layout/RequireAuth'
import { AppShell } from './features/layout/AppShell'
import { AuthPage } from './features/auth/AuthPage'
import { ShipmentListPage } from './features/shipments/ShipmentListPage'
import { WorkspacePage } from './features/workspace/WorkspacePage'
import { ModalHost } from './features/modals/ModalHost'
import { DrawerHost } from './features/drawers/DrawerHost'

/** 已登录区域的统一外壳（侧栏 + 顶栏 + 弹窗/抽屉挂载点） */
function AuthedLayout({ children }: { children: ReactElement }) {
  return (
    <RequireAuth>
      <AppShell>
        {children}
        <ModalHost />
        <DrawerHost />
      </AppShell>
    </RequireAuth>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<AuthPage />} />
      <Route
        path="/shipments"
        element={
          <AuthedLayout>
            <ShipmentListPage />
          </AuthedLayout>
        }
      />
      <Route
        path="/shipments/:shipmentId"
        element={
          <AuthedLayout>
            <WorkspacePage />
          </AuthedLayout>
        }
      />
      <Route path="*" element={<Navigate to="/shipments" replace />} />
    </Routes>
  )
}
