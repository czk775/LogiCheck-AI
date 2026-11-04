/* ============================================================
   极简 .env 加载（零依赖、零版本要求）
   ------------------------------------------------------------
   为什么不用 `node --env-file-if-exists=.env`：
   该命令行开关只在较新的 Node 小版本提供，发布沙箱的 Node 版本不可控，
   旧版本会直接以 `bad option` 退出，导致服务起不来。
   这里在代码内解析 .env，任何 Node ≥ 18 行为一致。

   规则：
   - 只补齐「进程环境中尚不存在的键」——真实环境变量优先级最高
     （平台注入的 PORT 等不会被 .env 覆盖）
   - 支持 # 注释、KEY=VALUE、去除首尾引号；不解析多行值与变量插值
   ============================================================ */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 服务端根目录（src/core/env.ts → 上两级；dist/core/env.js 同理） */
export const ENV_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** 默认配置文件位置：服务端根目录下的 .env */
export const DEFAULT_ENV_PATH = resolve(ENV_ROOT, '.env')

export interface LoadDotEnvResult {
  loaded: boolean
  keys: string[]
}

/** 把 .env 中的键补进 process.env（不覆盖已有值）；文件不存在则静默跳过 */
export function loadDotEnv(envPath: string = DEFAULT_ENV_PATH): LoadDotEnvResult {
  if (!existsSync(envPath)) return { loaded: false, keys: [] }
  const keys: string[] = []
  let raw = ''
  try {
    raw = readFileSync(envPath, 'utf8')
  } catch {
    return { loaded: false, keys: [] }
  }
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const eq = text.indexOf('=')
    if (eq <= 0) continue
    const key = text.slice(0, eq).trim()
    const value = text
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (!key || process.env[key] !== undefined) continue
    process.env[key] = value
    keys.push(key)
  }
  return { loaded: true, keys }
}
