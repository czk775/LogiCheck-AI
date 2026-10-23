/* 构建辅助：把非 TS 资产（migrations/*.sql）拷入 dist/db/migrations */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const dist = join(HERE, '..', 'dist')
const srcDir = join(HERE, '..', 'src', 'db', 'migrations')
mkdirSync(join(dist, 'db', 'migrations'), { recursive: true })
for (const f of readdirSync(srcDir).filter((x) => x.endsWith('.sql'))) {
  copyFileSync(join(srcDir, f), join(dist, 'db', 'migrations', f))
}
console.log(`[copy-assets] migrations → dist/db/migrations（${readdirSync(srcDir).length} 个）`)
