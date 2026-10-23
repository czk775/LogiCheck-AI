/**
 * 安全存储封装：隐私模式 / 存储被禁用时退化为内存存储，保证 UI 不崩溃。
 * 与已确认原型行为一致。
 */

const memoryStore: Record<string, string> = {}

function safeGet(kind: 'local' | 'session', key: string): string | null {
  try {
    return kind === 'local' ? localStorage.getItem(key) : sessionStorage.getItem(key)
  } catch {
    return memoryStore[`${kind}:${key}`] ?? null
  }
}

function safeSet(kind: 'local' | 'session', key: string, value: string): void {
  try {
    if (kind === 'local') localStorage.setItem(key, value)
    else sessionStorage.setItem(key, value)
  } catch {
    memoryStore[`${kind}:${key}`] = value
  }
}

function safeRemove(kind: 'local' | 'session', key: string): void {
  try {
    if (kind === 'local') localStorage.removeItem(key)
    else sessionStorage.removeItem(key)
  } catch {
    delete memoryStore[`${kind}:${key}`]
  }
}

export const safeLocalGet = (key: string) => safeGet('local', key)
export const safeLocalSet = (key: string, value: string) => safeSet('local', key, value)
export const safeSessionGet = (key: string) => safeGet('session', key)
export const safeSessionSet = (key: string, value: string) => safeSet('session', key, value)
export const safeSessionRemove = (key: string) => safeRemove('session', key)
