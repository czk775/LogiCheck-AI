/* 统一错误类型与 HTTP 错误响应（对齐前端 ApiErrorShape { code, message }） */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const errors = {
  badRequest: (msg = '请求参数不正确') => new ApiError(400, 'bad_request', msg),
  unauthorized: (msg = '登录状态已失效，请重新登录') => new ApiError(401, 'unauthorized', msg),
  forbidden: (msg = '没有权限访问该资源') => new ApiError(403, 'forbidden', msg),
  notFound: (msg = '资源不存在') => new ApiError(404, 'not_found', msg),
  conflict: (msg = '资源已存在') => new ApiError(409, 'conflict', msg),
  payloadTooLarge: (msg = '文件超过大小限制') => new ApiError(413, 'payload_too_large', msg),
  unsupportedType: (msg = '不支持的文件类型') => new ApiError(415, 'unsupported_media_type', msg),
  tooManyRequests: (msg = '操作过于频繁，请稍后再试') => new ApiError(429, 'too_many_requests', msg),
  internal: (msg = '服务端内部错误') => new ApiError(500, 'internal_error', msg),
  notImplemented: (msg = '该能力属于后续阶段，当前未接入') => new ApiError(501, 'not_implemented', msg),
}
