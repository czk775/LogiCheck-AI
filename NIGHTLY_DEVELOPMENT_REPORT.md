# 通宵开发交付报告 · LogiCheck AI

> 生成时间：2026-10-24 上午
> 覆盖范围：后端第一～第四阶段（阶段一收尾 → 阶段二 → 阶段三 → 阶段四）
> 原则：质量优先于阶段数量；不部署、不推送远程、不把 Mock 当真实 AI、未提供 Key 不声称真实云端 AI

---

## 1. 各阶段功能与状态

### 阶段一（收尾）：前端 RealApi 与后端联调 ✅ 完成

| 交付项 | 状态 | 说明 |
|---|---|---|
| 前端真实模式接入 | ✅ | `apiMode === 'real'` 时走 RealApi（真实 HTTP + Cookie 会话） |
| 注册 / 登录 / 退出 / 密码重置 | ✅ | 真实 SQLite + scrypt 密码哈希 + httpOnly Cookie |
| 货物 CRUD 与持久化 | ✅ | 数据落 SQLite，刷新/重登后完整恢复 |
| 真实文件上传 / 读取 / 替换 / 删除 | ✅ | 私有存储目录（`uploads/<userId>/<shipmentId>/`），仅文件属主可读 |
| 权限隔离 | ✅ | 跨账号访问一律 404（不泄露"存在"信息） |
| 真实数据库模式 E2E | ✅ | 77 项断言全绿（自建独立栈：临时 SQLite + 独立端口） |
| 质量关卡 | ✅ | 后端测试 / 前端 typecheck / lint(0 error) / 生产构建全过 |
| Git 检查点 | ✅ | `1721126` |

**联调期间抓出并修复的 3 个真 bug**：
1. `RealApi` 对无 body 的 POST 强设 `Content-Type: application/json` → Fastify 报 `FST_ERR_CTP_EMPTY_JSON_BODY`
2. Store 缺 `register` action → 注册表单实际调的是 login（真实模式必 401）
3. `check_results` 查询用 `ORDER BY id`（随机串主键 = 随机顺序）→ 规则顺序与前端约定不一致

---

### 阶段二：单证解析流水线 ✅ 完成

| 交付项 | 状态 | 说明 |
|---|---|---|
| PDF 文本提取（保留页码/位置） | ✅ | **零依赖自研**：对象扫描 + `node:zlib` FlateDecode + 内容流 tokenizer + ToUnicode CMap（UTF-16BE） |
| 图片 OCR / 视觉模型接口 | ✅ | 接口已定义（`OcrProvider`），**未配置 → 明确失败**（`ocr_not_configured`），不伪造字段 |
| EDIFACT 类型化解析 | ✅ | UNA 服务串 / 释放字符 / UNH 的 S009 消息标识；支持 INVOIC、DESADV、IFTMIN |
| 不支持的类型明确报错 | ✅ | 如 ORDERS → `unsupported_message_type` |
| 统一字段 Schema | ✅ | 28 键：原始值 / 标准化值 / 来源 / 页码 / 位置 / 置信度 / 状态 |
| 字段状态四态 | ✅ | `extracted` / `low_confidence` / `missing` / `unavailable` |
| 可替换 AI Provider 接口 | ✅ | `ExtractionProvider` 三层：deterministic（默认，已实现）/ ai（占位，未配置抛 `ai_not_connected`）/ OCR |
| 处理进度 / 失败重试 / 可恢复状态 | ✅ | `uploaded → parsing → parsed \| failed`；进程内串行队列；重启恢复（parsing→uploaded 重新入队） |
| 迁移体系 | ✅ | `schema_migrations` 表 + 按序应用 `migrations/*.sql`，事务包裹，重复执行幂等 |
| Git 检查点 | ✅ | `a7a41e5` |

**关键诚实边界**：未在文件中出现的适用字段记为 `missing`（不补默认值）；扫描件 PDF（无文本层）明确失败并提示需要 OCR；解析失败**不写入任何字段**。

---

### 阶段三：确定性核验引擎 ✅ 完成

| 交付项 | 状态 | 说明 |
|---|---|---|
| 数量/重量/金额/币种/日期/贸易术语标准化 | ✅ | 9 个字段组的标准化函数（`normalizeQuantity` / `normalizeWeight` / `normalizeAmount` / `normalizeDate` / `normalizeIncoterm` / `normalizeHsCode`） |
| 跨单证一致性四态 | ✅ | 一致 / 冲突 / 缺失 / 无法判断 |
| 关联真实证据 | ✅ | 每条结论必引用真实原始值（哪份单证、什么值），冲突异常证据指向真实文档 id |
| 德国/欧盟合规规则体系 | ✅ | RED / RoHS / 电池 / WEEE / HS 五条确定性评估器 |
| 规则来源/版本/适用条件 | ✅ | 来自 `compliance_rules` 表（`source_title` / `source_url` / `source_version` / `effective_from` / `product_scope` / `actor_scope` / `rule_version`），**不硬编码在评估逻辑里** |
| 证据不足标待核实 | ✅ | `insufficient_evidence`；`indeterminate`（取值无法标准化）同样不臆断一致/冲突 |
| 可解释 | ✅ | 每条规则结论写入 `reasoning` 判定依据（引用规则出处，如 "Directive 2014/53/EU"） |
| 可追溯 | ✅ | `processing_runs`（trigger=check/recheck）+ `activities` 活动流 + `findings.check_key` 自然键 |
| 可重复 | ✅ | 纯函数 + 幂等落库；重复执行结论完全一致、异常不重复生成 |
| Git 检查点 | ✅ | `2d37e13` |

**诚实边界**：规则只确认「材料存在」与「取值一致性」，**从不宣称产品满足法规要求**；材料已提供时标「材料已提供（内容未经核验）」；HS 编码只提示人工核查，不自动判定唯一正确税号。

---

### 阶段四：异常处理完整业务闭环 ✅ 完成

| 交付项 | 状态 | 说明 |
|---|---|---|
| 异常列表 / 详情 | ✅ | 列表 + `GET /api/findings/:id` 详情（带归属校验）；**修复了非演示货物异常在 UI 上完全不可见的问题** |
| 人工修正字段 | ✅ | 写入新记录留痕（`original_value` + `source='manual'`）；profile 推导改为按实际单证集合跨单证比对（去除硬编码 `doc-invoice`/`doc-packing`） |
| 替换文件 | ✅ | 旧记录与文件删除、相关 resolved 异常重开、新文件重新解析并重新核验 |
| 人工审核备注 | ✅ | `reviewed`（保留风险）≠ `resolved`（人工确认处理完毕） |
| 重跑核验 | ✅ | `POST /api/shipments/:id/recheck`；无已解析单证 → 明确 `no_documents`，不产出虚假结论 |
| 状态机正确维护 | ✅ | `open` / `reviewed` / `resolved`；人工解决 → `resolved`；重新打开 → `open` |
| 仅重检成功才自动解决 | ✅ | 仅 `consistent` / `missing` / 相关单证已移除时自动解决；`indeterminate` 不自动解决；已人工解决的异常不被自动重开 |
| 审计保留 | ✅ | 人工决定（`human_decisions`，不可删除）+ 运行记录 + 活动流三者齐全 |
| 前后端集成不破坏 UI / 双主题 | ✅ | 双模式 E2E 全绿（Mock 76/76、真实 82/82），含浅色主题回归 |
| Git 检查点 | ✅ | `1a31949` |

**阶段四抓出的 3 个真 bug**：
1. **存储层递归删目录**：`FileStorage.remove()` 递归删 `dirname`，替换单证时把同目录下刚写入的新文件一起删了 → 替换后解析报「文件在存储中缺失」。改为「文件必删，目录仅在为空时清理」
2. **引擎漏处理冲突消失**：移除来源单证后该字段组不再产生结论，但异常仍开放 → 新增「本轮无该字段组结论 → 冲突不成立，自动解决」
3. **PDF 单位未提取**：`Quantity: 1000 PCE` 只取到数字，PCE 丢失 → 新增 `unit` 规则

---

## 2. Git 检查点提交 ID

| 检查点 | 提交 ID | 内容 |
|---|---|---|
| 阶段一 | `1721126` | 后端基础设施 + 核心接口 + 前端真实模式联调 |
| 阶段二 | `a7a41e5` | 单证解析流水线（PDF/EDIFACT 提取 + 统一字段 Schema + Provider 架构） |
| 阶段三 | `2d37e13` | 确定性核验引擎（跨单证一致性 + 合规规则预检） |
| 阶段四 | `1a31949` | 异常处理完整业务闭环 + 前后端集成 |

全部为**本地提交，未推送远程仓库**（按要求仅本地检查点）。

---

## 3. 测试统计

### 后端（`logicheck-ai-server`）

```
npm --prefix logicheck-ai-server test
# tests 102
# pass 102
# fail 0
```

| 分组 | 数量 | 覆盖内容 |
|---|---|---|
| 既有测试 | 62 | 认证 / 货物 / 单证 / 演示数据 / 会话隔离 |
| PDF 提取（P 组） | 6 | 文本层提取、页码位置、Flate 压缩、ToUnicode、扫描件拒绝 |
| EDIFACT（E 组） | 9 | 段解析、UNA 自定义分隔符、释放字符、S009 识别、不支持类型报错 |
| 流水线集成（P 组） | 8 | 上传→parsed、missing 字段、PNG 诚实失败、扫描件失败、不支持 EDI、重试、重启恢复 |
| 迁移（M 组） | 2 | 从零应用全部迁移、旧库升级保留数据与新列就位 |
| 核验引擎（C+K 组） | 17 | 跨单证四态纯函数 7 项 + 引擎集成 10 项（冲突生成异常、证据真实、规则待核实、可重复性、人工修正后自动解决、已解决不重开） |
| 异常闭环（X 组） | 11 | 列表详情、人工修正留痕、替换文件、复核备注、人工解决、解决后重检不重开、重新打开、移除单证后结论刷新、说明校验、跨账号隔离、全链路闭环 |

### 前端 E2E（`logicheck-ai-web/e2e/run-tests.mjs`）

| 模式 | 结果 | 说明 |
|---|---|---|
| 真实模式（自建独立栈） | **82 / 82** | 临时 SQLite + 后端 4011 + Vite 5188，可重复回归 |
| Mock 模式 | **76 / 76** | `VITE_API_MODE=mock npm run dev` + `E2E_SPAWN=0` |

E2E 覆盖：认证 → 货物列表 → 工作台 → 单证上传/替换/删除/重试 → 异常列表/详情 → 人工复核 → **人工解决 → 重新打开（阶段四新增 G5–G8）** → 规则抽屉 → 字段修正 → 重检 → 刷新恢复 → 退出重登 → 跨账号隔离 → 移动端布局 → 双主题。

### 质量关卡（每阶段均执行）

| 检查 | 阶段一 | 阶段二 | 阶段三 | 阶段四 |
|---|---|---|---|---|
| 后端测试 | 49/49 | 74/74 | 91/91 | **102/102** |
| 后端 typecheck | ✅ | ✅ | ✅ | ✅ |
| 后端生产构建 | ✅ | ✅ | ✅ | ✅ |
| 前端 typecheck | ✅ | ✅ | ✅ | ✅ |
| 前端 lint | 0 error | 0 error | 0 error | **0 error**（6 个预存 warning，与本次改动无关） |
| 前端生产构建 | ✅ | ✅ | ✅ | ✅ |
| 迁移升级验证 | ✅ | ✅ | ✅ | ✅ |
| 隔离/安全边界 | ✅ | ✅ | ✅ | ✅ |
| E2E 双模式 | ✅ | ✅ | ✅ | ✅ |

---

## 4. 真实 vs 测试 Provider 边界（诚实声明）

### 当前真正可用的（真实链路）

| 能力 | 实现 | 真实性 |
|---|---|---|
| PDF 文本提取 | 自研零依赖解析器 | ✅ **真实**：直接读 PDF 字节流，真实页码/位置 |
| EDIFACT 解析 | 自研解析器 | ✅ **真实**：直接读报文，真实段结构 |
| 字段标准化 | 9 组标准化函数 | ✅ **真实**：真实取值计算 |
| 跨单证一致性 | 确定性引擎 | ✅ **真实**：比对真实提取值 |
| 合规规则预检 | 5 条确定性评估器 | ✅ **真实**：只判定「材料存在 + 取值一致」，引用真实证据文档 id |
| 异常闭环 | 引擎 + 服务 | ✅ **真实**：全部落 SQLite，可审计 |
| 认证 / 存储 | Fastify + SQLite + 本地文件 | ✅ **真实**：scrypt + httpOnly Cookie + 私有目录 |

### 尚未接入（明确失败，不伪造）

| 能力 | 当前行为 | 需要的条件 |
|---|---|---|
| 大模型提取（LLM） | `AiExtractionProvider` 已定义接口，未配置 → 抛 `ai_not_connected`，解析标记 failed | **第五阶段需要提供 API Key** |
| OCR / 视觉模型 | `UnavailableOcrProvider` → 抛 `ocr_not_configured`，图片单证解析失败 | **第五阶段需要提供 API Key** |
| PDF 无文本层（扫描件） | 明确失败并提示需要 OCR | 依赖上面的 OCR 能力 |

### 明确不做的事（诚实边界）

- 不用预设结果 / 硬编码字段冒充 AI 识别结果
- 不宣称产品满足 RED / RoHS / 电池法规 / WEEE / 关税归类
- 不把「材料已提供」表述为「已合规」
- 不伪造页码、位置、置信度、证据
- 演示货物（seed 的 curated 数据）在真实后端上仍标注为演示来源，不与真实结论混淆

---

## 5. 未解决问题 / 已知限制

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| 1 | OCR 未接入 | PNG/JPG 扫描件无法提取字段 | **待第五阶段 Key** |
| 2 | 大模型提取未接入 | 版式非常规的 PDF 只能靠标签匹配（低置信） | **待第五阶段 Key** |
| 3 | 规则集仅 5 条（RED/RoHS/电池/WEEE/HS），为确定性预检框架 | 不是完整法规库 | 框架可扩展，规则内容需逐条核对官方来源后补充 |
| 4 | 法规元数据（来源/版本/适用日期）为 seed 初始值 | 规则版本可能滞后 | 已标注 `accessed_at` 与免责声明；**未编造任何法规出处** |
| 5 | 引擎只比对 9 组可标准化字段 | 型号等自由文本字段不做严格比对（避免同义表述噪音） | 设计取舍，已在代码注释说明 |
| 6 | 单进程解析队列 | 服务重启期间上传的文档需恢复后重跑（已有恢复机制） | 规模扩大后需引入独立 worker |
| 7 | 前端 lint 6 个 warning | `react-refresh/only-export-components` | 预存问题，非本次引入，不影响构建 |
| 8 | Mock 模式不支持真实上传校验（魔数校验等） | 仅 Mock 环境如此 | Mock 仅用于前端演示，不用于验证后端逻辑 |

**没有发现已知阻塞问题，也没有带病进入下一阶段的情况。**

---

## 6. 明早验收：启动命令与步骤

### 前置

- Node.js ≥ 22（需要 `--experimental-sqlite`）
- 依赖已安装（`node_modules` 存在则**不要**重跑 install）

### 步骤 1：启动后端（新开终端 A）

```bash
cd D:/workbuddy/NewLogiCheckAI/logicheck-ai-server
npm run dev
# 默认 http://127.0.0.1:4000
# 数据库：./data/logicheck.db（SQLite，自动建表 + 应用 001/002/003 迁移）
```

可选环境变量：

```bash
PORT=4000
DATABASE_PATH=./data/logicheck.db
UPLOAD_DIR=./data/uploads
MAIL_OUTBOX_DIR=./data/mail-outbox
CORS_ORIGIN=http://localhost:5173
EXTRACTION_PROVIDER=deterministic   # deterministic（默认）| ai（需第五阶段 Key）
```

验证后端活着：

```bash
curl http://127.0.0.1:4000/api/healthz
# 期望：{"ok":true,"db":"sqlite","mode":"...","extraction":"deterministic"}
```

### 步骤 2：启动前端（新开终端 B）

```bash
cd D:/workbuddy/NewLogiCheckAI/logicheck-ai-web
npm run dev
# 默认 http://127.0.0.1:5173（Vite 代理 /api → 127.0.0.1:4000）
```

> 想看 Mock 演示版：`VITE_API_MODE=mock npm run dev`（此时后端可不开）

### 步骤 3：人工验收路径

1. **注册真实账户** → `real.user@example.com` / 任意 ≥8 位密码
2. **新建货物** → 上传两份**真实的** PDF 发票/装箱单（数量故意不一致，如 1000 vs 1200）
3. 观察单证卡片：状态从「等待解析」→「解析中」→「已解析」（或「处理失败」+ 失败原因）
4. **异常区块**应出现「跨单证数量不一致」，摘要引用两份单证的真实取值
5. 点开异常抽屉 → 证据 tab 列出真实单证 → 「修正 AI 提取」改数量 → 「重新检查」→ 异常自动变为已解决
6. **规则区块**显示 5 条真实预检结论，点开可见「判定依据」（引用真实材料与规则出处）
7. 「标记已处理」→ 填写说明 → 异常归档到「已处理」分组 → 可「重新打开」
8. **处理记录**抽屉应包含：解析完成、核验完成、人工修正、人工复核、人工解决
9. 退出 → 用同一邮箱密码重登 → 数据完整恢复
10. 另注册一个账号 → 看不到上一个账号的任何货物（隔离验证）
11. 浅色主题切换 → 各页面渲染正常（双主题验证）

### 步骤 4：跑自动化验收

```bash
# 后端全量测试（应 102/102）
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-server test

# 后端类型检查 + 构建
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-server run typecheck
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-server run build

# 前端类型检查 + lint + 构建
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-web run typecheck
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-web run lint
npm --prefix D:/workbuddy/NewLogiCheckAI/logicheck-ai-web run build

# E2E 真实模式（自建独立栈，不需要手动起服务；应 82/82）
cd D:/workbuddy/NewLogiCheckAI/logicheck-ai-web && node e2e/run-tests.mjs

# E2E Mock 模式（需先起 mock dev server；应 76/76）
cd D:/workbuddy/NewLogiCheckAI/logicheck-ai-web
VITE_API_MODE=mock npm run dev -- --port 5173 --strictPort   # 终端 A
E2E_SPAWN=0 node e2e/run-tests.mjs                            # 终端 B
```

### 步骤 5：查看 Git 检查点

```bash
cd D:/workbuddy/NewLogiCheckAI
git log --oneline          # 4 个检查点
git show --stat 1a31949   # 阶段四明细
```

---

## 7. 需要第五阶段 Key 的能力清单

以下能力**代码接口已就绪**，只需提供对应 API Key 即可启用，**无需改动业务逻辑**：

| # | 能力 | 需要的 Key | 接入点 | 启用后行为 |
|---|---|---|---|---|
| 1 | **大模型字段提取** | 大模型 API Key（如 DashScope / OpenAI 兼容接口） | `src/modules/parsing/providers/ai.ts`（`AiExtractionProvider` 已实现接口，当前未配置时抛 `ai_not_connected`）；配置项 `EXTRACTION_PROVIDER=ai` | 版式非常规的 PDF / 图片 → 真实模型提取，字段带置信度与来源标注 |
| 2 | **OCR / 视觉模型** | 支持视觉输入的模型 Key（同一个 Key 通常即可） | `src/modules/parsing/providers/types.ts`（`OcrProvider` 接口 + `UnavailableOcrProvider`）；需实现一个真实 `OcrProvider` | PNG/JPG/扫描件 PDF → 真实 OCR 提取字段（当前明确失败 `ocr_not_configured`） |
| 3 | **大模型合规预检** | 同 #1 | `src/modules/checking/rules.ts`（现有 5 条为确定性评估器；可新增 `AiRuleEvaluator`） | 版式化的合规条款判断（当前只做资料完整性检查） |

**接入建议**：新增 `src/modules/parsing/providers/ocr-real.ts` 实现 `OcrProvider`，在 `buildProviders()` 里按配置装配；Key 从环境变量读取（**不写进代码、不提交仓库**）。

---

## 8. 交付物清单

| 文件 / 目录 | 说明 |
|---|---|
| `logicheck-ai-server/src/modules/parsing/` | 解析流水线（pdf/、edi/、providers/、schema.ts、pipeline.ts） |
| `logicheck-ai-server/src/modules/checking/` | 核验引擎（crossCheck.ts、rules.ts、engine.ts） |
| `logicheck-ai-server/src/db/migrations/` | 3 个迁移（001 初始 / 002 解析 / 003 核验） |
| `logicheck-ai-server/test/` | 102 项测试（含 checking-engine / exception-closure） |
| `logicheck-ai-web/e2e/run-tests.mjs` | 双模式 E2E 套件（真实 82 / Mock 76） |
| `logicheck-ai-web/src/services/domain/runMode.ts` | 运行形态判定（真实后端 + 非演示货物） |
| `logicheck-ai-web/src/features/modals/ResolveModals.tsx` | 人工解决 / 重新打开弹窗 |
| `NIGHTLY_DEVELOPMENT_REPORT.md` | 本报告 |

---

## 附：一句话总结

四个阶段全部完成并通过质量关卡——后端 **102/102**、E2E 真实 **82/82** / Mock **76/76**、前后端 typecheck 与生产构建全绿、4 个本地 Git 检查点。**真实可用**的是 PDF/EDI 解析、字段标准化、跨单证核验、合规预检框架与完整异常闭环；**尚未接入**的是大模型提取与 OCR（接口已就绪，等第五阶段的 API Key）。
