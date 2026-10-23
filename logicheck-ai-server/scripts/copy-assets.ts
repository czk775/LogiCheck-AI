/* 构建辅助：把非 TS 资产（schema.sql）拷入 dist */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const dist = join(HERE, '..', 'dist')
mkdirSync(join(dist, 'db'), { recursive: true })
copyFileSync(join(HERE, '..', 'src', 'db', 'schema.sql'), join(dist, 'db', 'schema.sql'))
console.log('[copy-assets] schema.sql → dist/db/schema.sql')
