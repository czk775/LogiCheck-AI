import { useStore } from '../../store/AppStore'
import { IssueDrawer } from './IssueDrawer'
import { RuleDrawer } from './RuleDrawer'
import { DocDrawer } from './DocDrawer'
import { ProfileDrawer } from './ProfileDrawer'
import { ActivityDrawer } from './ActivityDrawer'

/** 抽屉挂载点：按 UI 状态渲染对应抽屉 */
export function DrawerHost() {
  const { state, activeShipment } = useStore()
  const drawer = state.drawer
  if (!drawer || !activeShipment) return null

  switch (drawer.type) {
    case 'issue': {
      const finding = activeShipment.findings.find((f) => f.id === drawer.findingId)
      if (!finding) return null
      return <IssueDrawer shipment={activeShipment} finding={finding} />
    }
    case 'rule':
      return <RuleDrawer shipment={activeShipment} ruleKey={drawer.ruleKey} />
    case 'document': {
      const doc = activeShipment.documents.find((d) => d.id === drawer.documentId)
      if (!doc) return null
      return <DocDrawer doc={doc} />
    }
    case 'profile':
      return <ProfileDrawer shipment={activeShipment} />
    case 'activity':
      return <ActivityDrawer shipment={activeShipment} />
    default:
      return null
  }
}
