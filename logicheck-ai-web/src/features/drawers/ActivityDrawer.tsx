import { Drawer } from '../../components/Drawer'
import { useStore } from '../../store/AppStore'
import { formatTime } from '../../utils/format'
import type { Shipment } from '../../types/domain'

/** 操作与检查记录抽屉（窄）—— 与原型 activityDrawer 一致 */
export function ActivityDrawer({ shipment }: { shipment: Shipment }) {
  const { closeDrawer } = useStore()

  return (
    <Drawer
      title="操作与检查记录"
      subtitle="已保存的修改、复核和检查行为"
      onClose={closeDrawer}
      testId="activity-drawer"
    >
      {shipment.activities.length ? (
        shipment.activities.map((a, i) => (
          <div className="activity-entry" key={`${a.at}-${i}`}>
            <strong>{a.text}</strong>
            <small>{formatTime(a.at)}</small>
          </div>
        ))
      ) : (
        <p className="text-note">暂无记录</p>
      )}
      {shipment.runs.length ? (
        <>
          <div className="small-divider" />
          <div className="detail-label">检查运行（Run）</div>
          {shipment.runs.map((r) => (
            <div className="activity-entry" key={r.id}>
              <strong>
                {r.trigger === 'recheck' ? '重新检查' : r.trigger === 'upload' ? '上传触发' : '手动运行'} ·{' '}
                {r.status === 'succeeded' ? '成功' : r.status === 'failed' ? '失败' : '部分成功'}
              </strong>
              <small>
                {formatTime(r.startedAt)} · {r.summary}
                {r.ruleVersion ? ` · 规则版本 ${r.ruleVersion}` : ''}
              </small>
            </div>
          ))}
        </>
      ) : null}
    </Drawer>
  )
}
