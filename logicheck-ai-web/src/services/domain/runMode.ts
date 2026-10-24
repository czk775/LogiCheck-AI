import { apiMode } from '../api'
import type { Shipment } from '../../types/domain'

/* ============================================================
   运行形态判定 —— UI 层唯一的分支依据。

   两种维度不可混用：
   - apiMode：这个前端连的是 Mock 服务还是真实后端（决定「有没有能力」）
   - shipment.isDemo：这个货物是不是内置演示数据（决定「数据从哪来」）

   「引擎模式」= 真实后端 + 非演示货物：此时结论来自确定性核验引擎，
   字段来自服务端解析流水线。演示货物即便跑在真实后端上，数据也仍是
   seed 的 curated 演示内容，必须走演示文案。
   ============================================================ */

/** 是否处于「确定性核验引擎」模式（真实后端 + 真实货物） */
export function isEngineMode(shipment: Pick<Shipment, 'isDemo'>): boolean {
  return apiMode === 'real' && !shipment.isDemo
}
