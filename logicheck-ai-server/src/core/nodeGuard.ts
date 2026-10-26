/* ============================================================
   Node 版本守卫
   ------------------------------------------------------------
   服务端使用 Node 内置 node:sqlite（DatabaseSync），该模块自
   Node 22.5 提供（实验性，需 --experimental-sqlite 参数）。
   发布沙箱的 Node 版本不可预知，版本不够时必须在入口处给出
   人话错误与升级指引，而不是把 ERR_UNKNOWN_BUILTIN_MODULE
   原样抛给部署平台。

   用法：作为 src/index.ts 的第一个 import（ESM 按源码顺序
   求值，先于 db 层的 node:sqlite import）。
   ============================================================ */

export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 5

/** 校验 Node 版本；不满足最低要求时抛出带指引的错误 */
export function assertNodeVersion(version: string): void {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version)
  if (!m) return // 无法解析（测试/异常环境）：放行，由 import 层自然报错
  const major = Number(m[1])
  const minor = Number(m[2])
  const ok = major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  if (!ok) {
    throw new Error(
      `[nodeGuard] 需要 Node.js ≥ ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}（当前 ${version}）：` +
        `服务端使用内置 node:sqlite 数据库。请升级 Node（推荐 LTS 22+）后重试。`,
    )
  }
}

/* 模块加载即校验（index.ts 首个 import，先于 node:sqlite 求值） */
assertNodeVersion(process.version)
