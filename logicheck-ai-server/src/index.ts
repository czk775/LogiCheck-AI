/* 服务端入口：加载配置 → 打开数据库 → 装配应用 → 监听端口 */

import { openDatabase } from './db/index.ts'
import { loadConfig } from './config.ts'
import { buildApp } from './app.ts'
import { mkdirSync } from 'node:fs'

const config = loadConfig()
mkdirSync(config.uploadDir, { recursive: true })
mkdirSync(config.mailOutboxDir, { recursive: true })

const db = openDatabase(config.databasePath)
const { app } = buildApp({ config, db })

try {
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[logicheck-ai-server] 已启动 → http://localhost:${config.port}（SQLite: ${config.databasePath}）`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.close().then(() => {
      db.close()
      process.exit(0)
    })
  })
}
