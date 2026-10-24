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
  // AI 接入状态（只打印是否接通与模型名，绝不打印密钥）
  if (config.ai) {
    const d = config.ai.describe()
    console.log(`[logicheck-ai-server] AI 已接通：提取模型 ${d.model}｜视觉模型 ${d.visionModel ?? d.model}｜端点 ${d.baseUrl}`)
  } else if (config.extractionProvider === 'ai') {
    console.warn('[logicheck-ai-server] 警告：EXTRACTION_PROVIDER=ai 但未配置 API Key / 模型名 —— AI 解析会明确失败（不会伪造结果）')
  } else {
    console.log('[logicheck-ai-server] AI 未配置，当前使用确定性提取（零外部调用）')
  }
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
