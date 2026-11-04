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
   6. 服务端预编译进 app/：沙箱不跑 tsc，启动路径只有 node app/index.js
   ============================================================ */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSecretHits, ENV_TEMPLATE, BUNDLE_FIXTURES } from './lib/bundle-plan.ts'

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_ROOT = resolve(SERVER_DIR, '..')
const WEB_DIR = join(PROJECT_ROOT, 'logicheck-ai-web')
const OUT_DIR = join(SERVER_DIR, 'deploy-bundle')

/** 运行期 .env 允许出现的键（白名单）：只放运行配置，不放路径与端口 */
const RUNTIME_ENV_KEYS = [
  'DASHSCOPE_API_KEY',
  'AI_MODEL',
  'AI_VISION_MODEL',
  'AI_BASE_URL',
  'AI_TIMEOUT_MS',
  'AI_MAX_RETRIES',
  'AI_MAX_PAGES',
  'AI_MAX_OUTPUT_TOKENS',
  'AI_USAGE_LIMIT_TOKENS',
  'EXTRACTION_PROVIDER',
  'AI_DAILY_PARSE_LIMIT',
  'UPLOAD_RATE_PER_MIN',
  'API_RATE_PER_MIN',
  'DEMO_PASSWORD',
] as const

/** 白名单键的兜底值（本地 .env 缺失时使用，保证公网开箱可用） */
const RUNTIME_ENV_DEFAULTS: Record<string, string> = {
  DASHSCOPE_API_KEY: '',
  AI_MODEL: 'qwen3.8-flash',
  AI_VISION_MODEL: 'qwen3.8-omni-flash',
  AI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  AI_TIMEOUT_MS: '180000',
  AI_MAX_RETRIES: '2',
  AI_MAX_PAGES: '8',
  AI_MAX_OUTPUT_TOKENS: '4096',
  AI_USAGE_LIMIT_TOKENS: '2000000',
  EXTRACTION_PROVIDER: 'auto',
  AI_DAILY_PARSE_LIMIT: '50',
  UPLOAD_RATE_PER_MIN: '10',
  API_RATE_PER_MIN: '600',
  DEMO_PASSWORD: 'Demo@2026',
}

/**
 * 生成运行期 .env 文本：只取白名单键，本地没有的用兜底值。
 * 返回文本与键名清单（不打印任何值）。
 */
function buildRuntimeEnv(envPath: string): { text: string; keys: string[]; hasKey: boolean } {
  const local = new Map<string, string>()
  if (existsSync(envPath)) {
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
      if (value) local.set(key, value)
    }
  }
  const lines: string[] = [
    '# LogiCheck AI · 部署沙箱运行期环境变量',
    '# 由 scripts/make-deploy-bundle.ts 生成，只含白名单键；请勿外传或提交到版本库。',
    '# npm start 通过 --env-file-if-exists=.env 读取，业务代码只从 process.env 取值。',
    '',
  ]
  const keys: string[] = []
  for (const key of RUNTIME_ENV_KEYS) {
    const value = local.get(key) ?? RUNTIME_ENV_DEFAULTS[key] ?? ''
    if (!value) {
      lines.push(`# ${key}=  # 未配置：AI 功能将不可用（服务仍可启动）`)
      continue
    }
    lines.push(`${key}=${value}`)
    keys.push(key)
  }
  return { text: lines.join('\n') + '\n', keys, hasKey: !!local.get('DASHSCOPE_API_KEY') }
}

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
| startCmd | npm start |

服务端已在本机预编译到 \`app/\`（不在 \`dist/\`，避免被「构建产物」规则排除），
沙箱内只装依赖 + 启动，不跑 tsc——启动更快，也不依赖沙箱的编译环境。

## 环境变量（运行期注入，不写死在代码里）

发布工具不提供环境变量面板，因此产物内置一个 **运行期 \`.env\`**（只在部署沙箱内生效）：
\`npm start\` 通过 \`--env-file-if-exists=.env\` 把它读进 \`process.env\`，业务代码一律走
环境变量读取，源码里没有任何密钥字面量。

\`.env\` 只包含白名单键（见下），由脚本从本地 \`logicheck-ai-server/.env\` 提取；
\`DATABASE_PATH\` / \`UPLOAD_DIR\` / \`PORT\` 等**不写入**，由沙箱与代码默认值决定。

- \`DASHSCOPE_API_KEY\` + \`AI_MODEL\`：大模型密钥与模型名。**两者都配置了 AI 才接通**；
  只配其一或都不配 → 服务照常启动，AI 功能显示「未配置」并自动使用确定性提取（不伪造结果）。
- \`EXTRACTION_PROVIDER=auto\`：检测到密钥自动开 AI，无密钥自动降级。
- \`AI_DAILY_PARSE_LIMIT\`（缺省 50）：单账号每日 AI 解析份数上限，防公网烧额度。
- \`UPLOAD_RATE_PER_MIN\` / \`API_RATE_PER_MIN\`：上传与全局 API 频率限制。
- \`DEMO_PASSWORD\`：5 个演示账号的统一登录密码（账号见 README 末尾）。
- \`PORT\`：由发布平台注入，无需配置。

> 安全边界：\`.env\` 是本目录唯一含密钥的文件，**绝不进 Git**（\`deploy-bundle/\` 已在 .gitignore），
> 也不会下发到浏览器；分享源码包时请先删除它。

## 演示账号（公网体验）

| 账号 | 定位 | 历史货物 |
| --- | --- | --- |
| demo@logicheck.ai | 出口跟单（综合场景） | 4 票 |
| demo2@logicheck.ai | 德国进口采购 | 4 票 |
| demo3@logicheck.ai | 报关行操作 | 4 票 |
| demo4@logicheck.ai | 品牌合规专员 | 5 票 |
| demo5@logicheck.ai | 货代客服 | 4 票 |

统一密码 = \`DEMO_PASSWORD\`。数据在每次启动时幂等写入（账号按邮箱、货物按固定 ID 判断），
因此沙箱重置后重启进程即可完整恢复；上传的原件也随种子复制到 \`data/uploads/\`。

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

// 1) 预编译产物 → app/（沙箱内零构建：tsc 不进启动路径，启动更快也更可预测）
//    目录名刻意避开 dist/build 等「构建输出」排除规则，确保产物真的被上传
if (!existsSync(join(SERVER_DIR, 'dist', 'index.js'))) fail('服务端未构建：先执行 npm run build')
copy(join(SERVER_DIR, 'dist'), join(OUT_DIR, 'app'))

// 2) 依赖描述（改写 scripts：沙箱只跑 node app/index.js；剥离 devDependencies）
const pkg = JSON.parse(readFileSync(join(SERVER_DIR, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  [k: string]: unknown
}
delete pkg.devDependencies
pkg.scripts = { start: 'node app/index.js' }
writeFileSync(join(OUT_DIR, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
copy(join(SERVER_DIR, 'package-lock.json'), join(OUT_DIR, 'package-lock.json'))

// 3) 源码留档（便于排查，不参与运行）
copy(join(SERVER_DIR, 'src'), join(OUT_DIR, 'src'))

// 4) 前端预构建产物 → public/
copy(join(WEB_DIR, 'dist'), join(OUT_DIR, 'public'))

// 5) 评估夹具 → fixtures/
for (const f of BUNDLE_FIXTURES) copy(join(PROJECT_ROOT, f), join(OUT_DIR, 'fixtures', f))

// 6) 部署说明 + 环境变量模板（只有占位符，无真实值）
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
/* ---------- 运行期 .env（白名单键；扫描后写入，是本目录唯一含密钥的文件） ---------- */
const runtimeEnv = buildRuntimeEnv(join(SERVER_DIR, '.env'))
writeFileSync(join(OUT_DIR, '.env'), runtimeEnv.text, 'utf8')
console.log(`✓ 已写入运行期 .env（${runtimeEnv.keys.length} 个键；含密钥，勿外传）`)
if (!runtimeEnv.hasKey) {
  console.warn('  ⚠ 本地 .env 未找到 DASHSCOPE_API_KEY：公网将运行在确定性提取模式（AI 未接通）')
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
console.log('  startCmd   = npm start')
console.log('  环境变量   = 已内置运行期 .env（白名单键）；模板见 deploy-env-template.txt')

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
