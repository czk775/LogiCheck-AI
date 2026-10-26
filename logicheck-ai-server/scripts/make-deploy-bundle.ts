/* ============================================================
   发布 bundle 组装脚本（公网部署专用）
   ------------------------------------------------------------
   用法（在 logicheck-ai-server 目录）：
     npm run build            # 先构建服务端 dist（本脚本不重复构建）
     cd ../logicheck-ai-web && npm run build   # 前端产物 → dist/
     npm run bundle           # 本脚本：组装 deploy-bundle/

   设计要点（对应上线要求）：
   1. 密钥零进入：.env / data/ / node_modules 一律不进包；
      组装后自动全量扫描（真实密钥值 + sk-/AccessKey 格式），命中即销毁产物并退出 1
   2. 前端产物进 public/（Vite 约定目录名，避开构建产物排除规则）
   3. 服务端带源码进包，沙箱内 `npm run build && npm start`——
      不依赖本地 dist 是否会被发布工具的「构建产物排除」规则清掉
   4. 评估夹具随包进 fixtures/（公网 AI 评估功能可用）
   5. 数据库不打进包：首次启动自动建库 + 迁移 + 种子（演示账号/演示货物）
   ============================================================ */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSecretHits, ENV_TEMPLATE, BUNDLE_FIXTURES } from './lib/bundle-plan.ts'

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(SERVER_DIR, '..')
const WEB_DIR = join(PROJECT_ROOT, 'logicheck-ai-web')
const OUT_DIR = join(SERVER_DIR, 'deploy-bundle')

const fail = (msg: string): never => {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const README = `# LogiCheck AI · 公网部署产物

本目录由 \`npm run bundle\` 自动生成，**不要手工编辑**（重新生成会覆盖）。

## 这是什么

前后端同端口的完整应用：Fastify 同时提供 API 与前端页面（public/ 为前端预构建产物）。
首次启动自动建库（SQLite）、执行迁移、写入演示账号与演示货物——**数据库不在包里，
重启/重新发布后回到「全新种子状态」，演示中新增的数据以沙箱实际持久性为准**。

## 发布参数（发布为应用）

| 项 | 值 |
| --- | --- |
| language | node |
| installCmd | npm install |
| startCmd | npm run build && npm start |

startCmd 先构建服务端（tsc）再启动——发布工具若清掉构建产物目录也能自愈。

## 环境变量（密钥只在平台配置，绝不打包）

见 \`deploy-env-template.txt\`。要点：

- \`DASHSCOPE_API_KEY\` + \`AI_MODEL\`：大模型密钥与模型名。**两者都配置了 AI 才接通**；
  只配其一或都不配 → 服务照常启动，AI 功能显示「未配置」并自动使用确定性提取（不伪造结果）。
- \`EXTRACTION_PROVIDER\` 缺省 auto：检测到密钥自动开 AI，无密钥自动降级。
- \`AI_DAILY_PARSE_LIMIT\`（缺省 50）：单账号每日 AI 解析份数上限，防公网烧额度。
- \`UPLOAD_RATE_PER_MIN\` / \`API_RATE_PER_MIN\`：上传与全局 API 频率限制。
- \`DEMO_PASSWORD\`（缺省 demo1234）：演示账号 demo@logicheck.ai 的登录密码。
- \`PORT\`：由发布平台注入，无需配置。

## 公网访问须知

- 邮件为开发模式（不连接 SMTP）：注册/找回密码的邮件不会真正送达，
  注册本身可用（邮箱即账号，自设密码）。
- 上传文件大小上限 15MB/份、20 份/次。
- 健康检查：GET /api/healthz（返回 Node 版本，可用于核实沙箱运行时）。
`

/* ---------- 前置检查 ---------- */
if (!existsSync(join(WEB_DIR, 'dist', 'index.html'))) {
  fail(`前端未构建：${join(WEB_DIR, 'dist', 'index.html')} 不存在。先执行 cd logicheck-ai-web && npm run build`)
}
for (const f of BUNDLE_FIXTURES) {
  if (!existsSync(join(PROJECT_ROOT, f))) fail(`评估夹具缺失：${join(PROJECT_ROOT, f)}`)
}
if (!existsSync(join(SERVER_DIR, 'src', 'index.ts'))) fail('服务端源码缺失')

/* ---------- 清空旧产物 ---------- */
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

/* ---------- 组装（正向清单，绝不整体拷贝目录） ---------- */
const copy = (from: string, to: string) => {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
}

// 1) 服务端依赖描述 + 构建配置 + 源码（含 db/migrations/*.sql）
copy(join(SERVER_DIR, 'package.json'), join(OUT_DIR, 'package.json'))
copy(join(SERVER_DIR, 'package-lock.json'), join(OUT_DIR, 'package-lock.json'))
copy(join(SERVER_DIR, 'tsconfig.json'), join(OUT_DIR, 'tsconfig.json'))
copy(join(SERVER_DIR, 'tsconfig.build.json'), join(OUT_DIR, 'tsconfig.build.json'))
copy(join(SERVER_DIR, 'src'), join(OUT_DIR, 'src'))
copy(join(SERVER_DIR, 'scripts', 'copy-assets.ts'), join(OUT_DIR, 'scripts', 'copy-assets.ts'))

// 2) 前端预构建产物 → public/
copy(join(WEB_DIR, 'dist'), join(OUT_DIR, 'public'))

// 3) 评估夹具 → fixtures/
for (const f of BUNDLE_FIXTURES) copy(join(PROJECT_ROOT, f), join(OUT_DIR, 'fixtures', f))

// 4) 部署说明 + 环境变量模板（只有占位符，无真实值）
writeFileSync(join(OUT_DIR, 'deploy-env-template.txt'), ENV_TEMPLATE, 'utf8')
writeFileSync(join(OUT_DIR, 'README-DEPLOY.md'), README, 'utf8')

/* ---------- 安全自检：密钥零进入 ---------- */
const TEXT_EXT = new Set(['.ts', '.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.sql', '.edi'])
const secretValues = readEnvSecretValues(join(SERVER_DIR, '.env'))
const textFiles = listTextFiles(OUT_DIR)
const hits = findSecretHits(
  textFiles.map((p) => ({ path: p, text: safeRead(p) })),
  secretValues,
)
if (hits.length > 0) {
  console.error('✗ 安全自检失败：发布产物中检测到密钥！')
  for (const h of hits) console.error(`  - ${h}`)
  rmSync(OUT_DIR, { recursive: true, force: true })
  console.error('  已销毁 deploy-bundle/，请检查 .env 与源码后重试')
  process.exit(1)
}
if (existsSync(join(OUT_DIR, '.env'))) {
  rmSync(OUT_DIR, { recursive: true, force: true })
  fail('安全自检失败：.env 进入产物（已销毁）')
}

/* ---------- 清单 ---------- */
const allFiles = listAllFiles(OUT_DIR)
const totalBytes = allFiles.reduce((n, p) => n + statSync(p).size, 0)
console.log('✓ 发布产物已组装：logicheck-ai-server/deploy-bundle/')
console.log(`  文件 ${allFiles.length} 个，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
console.log(`  密钥扫描：${secretValues.length} 个本地密钥值 + 格式规则 → 0 命中`)
console.log('  目录结构：')
for (const entry of readdirSync(OUT_DIR).sort()) {
  const p = join(OUT_DIR, entry)
  const kind = statSync(p).isDirectory() ? `${readdirSync(p).length} 个文件` : `${(statSync(p).size / 1024).toFixed(1)} KB`
  console.log(`    ${entry}/`.replace(/\/$/, statSync(p).isDirectory() ? '/' : '') + `  ${kind}`)
}
console.log('')
console.log('下一步（发布）：对 deploy-bundle/ 目录执行「发布为应用」，参数建议：')
console.log('  language   = node')
console.log('  installCmd = npm install')
console.log('  startCmd   = npm run build && npm start')
console.log('  环境变量   = 按 deploy-env-template.txt 在平台配置（密钥绝不打包）')

/* ---------- 工具 ---------- */

/** 从 .env 提取「像密钥的」值（键名含 KEY/SECRET/TOKEN/PASS）；只用于扫描，不落盘不打印 */
function readEnvSecretValues(envPath: string): string[] {
  if (!existsSync(envPath)) return []
  const values: string[] = []
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    const value = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
    if (/KEY|SECRET|TOKEN|PASS/i.test(key) && value.length >= 8) values.push(value)
  }
  return values
}

function listTextFiles(dir: string): string[] {
  return listAllFiles(dir).filter((p) => TEXT_EXT.has(p.slice(p.lastIndexOf('.'))))
}

function listAllFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
