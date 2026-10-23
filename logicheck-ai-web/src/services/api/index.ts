/* ============================================================
   API 服务层出口

   默认接入真实后端（RealApi，HTTP + httpOnly Cookie 会话）。
   需要回到纯前端 Mock 演示时：设置环境变量 VITE_API_MODE=mock 后重启 dev server。

   后端契约见 ./contracts.ts；替换服务端实现只需改动本文件一行。
   ============================================================ */

import type { LogiCheckApi } from './contracts'
import { MockLogiCheckApi } from '../mock/mockApi'
import { RealApi } from './realApi'

const mode = import.meta.env.VITE_API_MODE ?? 'real'

export const api: LogiCheckApi = mode === 'mock' ? new MockLogiCheckApi() : new RealApi()

export const apiMode: 'mock' | 'real' = mode === 'mock' ? 'mock' : 'real'

export type {
  LogiCheckApi,
  LoginRequest,
  RegisterRequest,
  CreateShipmentRequest,
  UploadDocumentsRequest,
  UploadResult,
  UploadRejection,
  UpdateFieldRequest,
  RecordDecisionRequest,
  RecheckReport,
  CheckResultLite,
} from './contracts'
