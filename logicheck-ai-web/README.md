# LogiCheck AI v2.0 — 跨境货物单证智能预检工作台（前端工程）

基于 `LogiCheck-PRD-v2-FINAL.docx` 产品需求与已验收的高保真双主题 HTML 原型实现的正式前端工程。
**当前为 Mock 服务演示版：不接入任何后端，不伪造 AI 识别结果。**

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React 18.3 + TypeScript 5.7（strict） |
| 构建 | Vite 6 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`，CSS-first `@theme inline`）+ 原型 1:1 移植的组件类 |
| 路由 | React Router 6 |
| 字体 | DM Sans / Manrope 可变 woff2 自托管（latin 子集，无运行时 CDN 依赖） |
| 校验 | ESLint 9（flat config）+ `tsc --noEmit` |
| 测试 | CDP 无头 Chrome E2E 断言套件（零依赖，Node 22 原生 WebSocket） |

## 快速开始

```bash
npm install        # 安装依赖
npm run dev        # 开发服务器 → http://localhost:5173
npm run build      # 生产构建（tsc -b && vite build）→ dist/
npm run preview    # 预览生产构建 → http://localhost:4173
npm run lint       # ESLint 检查
npm run typecheck  # 类型检查
node e2e/run-tests.mjs   # E2E 套件（需先启动 npm run dev）
```

Node 版本要求 ≥ 20（开发环境使用 Node 22 验证通过）。

## 目录结构与架构

```
logicheck-ai-web/
├── index.html                  # 主题 bootstrap 内联脚本（防首屏闪白）
├── src/
│   ├── main.tsx                # 入口：ThemeProvider > ToastProvider > StoreProvider > Router
│   ├── App.tsx                 # 路由表 + AuthedLayout（RequireAuth + AppShell + Modal/Drawer 挂载点）
│   ├── theme/                  # 双主题 Provider（data-theme + localStorage 记忆）
│   ├── styles/                 # tokens.css（设计令牌）/ global.css（原型 1:1 移植）/ fonts.css
│   ├── types/domain.ts         # 领域模型（Shipment / Document / Finding / Rule / Run…）
│   ├── services/
│   │   ├── api/
│   │   │   ├── contracts.ts    # ★ LogiCheckApi 接口契约（后端对接面）
│   │   │   └── index.ts        # 单点切换：api = new MockLogiCheckApi() → RealApi
│   │   ├── mock/               # Mock 实现 + 演示数据（⚠️ 演示专用，见下方边界声明）
│   │   ├── domain/             # 纯函数（状态推导、计数、状态元数据）
│   │   └── storage/            # safeStorage（隐私模式降级）/ idb（IndexedDB 文件缓存）
│   ├── store/AppStore.tsx      # useReducer + Context 全局状态，订阅 api 变更自动同步
│   ├── components/             # Button / Chip / Icon / Modal / Drawer / Toast / ThemeToggle / EmptyState
│   ├── constants.ts            # DEMO_NOTICE 等全局常量
│   ├── utils/format.ts         # 时间/体积格式化
│   └── features/
│       ├── auth/               # 登录 / 注册 / 忘记密码 / 一键演示
│       ├── layout/             # AppShell（侧栏+顶栏）/ RequireAuth（hydrated 守卫）
│       ├── shipments/          # 货物列表（搜索 / 筛选 / 行菜单 / 删除确认）
│       ├── workspace/          # 工作台各区块 + 证据预览（IDB blob URL / EDI 原文）
│       ├── drawers/            # 异常 / 规则 / 单证 / 字段 / 活动抽屉 + DrawerHost
│       └── modals/             # 指南 / 关于 / 规则帮助 / 重检说明 / 删除 / 修正 / 复核 + ModalHost
└── e2e/                        # CDP E2E 套件 + 调试脚本 + 测试夹具
```

分层原则：**页面表现（features）/ 业务状态（store）/ 模拟数据（mock）/ API 契约（contracts）严格分离**。
所有数据读写只经过 `services/api` 出口；页面不直接触碰 localStorage / IndexedDB。

## Mock 服务边界（重要）

当前 `MockLogiCheckApi` 用 localStorage（按账号隔离）+ sessionStorage（会话）+ IndexedDB（上传文件缓存）模拟服务端行为。边界如下，**后端接入前不会改变**：

1. **不伪造 AI 识别成功**：真实上传的文件只保存到 IndexedDB 并提供原件预览；文档状态机只推进 `uploading → uploaded`（待真实 AI 解析），**绝不进入 parsed**，不生成提取字段、核验结论或合规结果。
2. **演示账号不是真实安全认证**：不索取、不存储任何真实密码用途之外的凭证；登录/注册均为本地演示身份。
3. **重检不伪造结果**：对非演示货物明确返回 `ai_not_connected` 并记录 failed Run，不把失败写成通过。
4. 上传的真实文件仅存于浏览器本地，不发送到任何服务端。

## 后端对接指南

后端就绪后，按以下步骤替换，**页面零改动**：

1. 新建 `src/services/api/realApi.ts`，实现 `LogiCheckApi` 接口（契约定义见 `src/services/api/contracts.ts`，含全部请求/响应 DTO）。
2. 修改 `src/services/api/index.ts` 一行：`export const api: LogiCheckApi = new RealLogiCheckApi()`。

需要后端提供的接口清单（与 contracts.ts 一一对应）：

| # | 方法 | 用途 | 优先级 |
|---|---|---|---|
| 1 | `login / register / loginDemo / logout / getSession` | 账号与会话（真实实现需服务端认证 + 令牌） | P0 |
| 2 | `listShipments / getShipment / createShipment / deleteShipment` | 货物 CRUD | P0 |
| 3 | `uploadDocuments / deleteDocument / retryDocument / getDocumentBlob / getDocumentText` | 单证上传、删除、重试、原件取回 | P0 |
| 4 | `getFieldCandidates / updateExtractedField` | 提取字段候选与人工修正留痕 | P1 |
| 5 | `recordHumanDecision / createRuleFollowUp` | 人工复核与规则跟进 | P1 |
| 6 | `recheck` | 触发重新检查（需真实 AI + 规则引擎） | P1 |
| 7 | `getRules / getCheckResults` | 合规规则清单与预检结果 | P1 |
| 8 | `getRuns / getActivities` | 处理记录与操作审计 | P2 |
| 9 | `subscribe` | 数据变更推送（WebSocket / SSE，替换 Mock 的事件总线） | P2 |

AI 解析接入后，文档状态机应推进 `uploaded → parsed` 并产出 `fields`；在此之前前端所有相关 UI 已按"待解析"状态设计。

## E2E 测试

`e2e/run-tests.mjs` 覆盖 71 项断言（A–Q 组）：登录/主题、演示登录、搜索筛选、工作台、证据链、字段修正+重检+审计、人工复核、规则抽屉、真实文件上传/预览/拒绝、失败重试、删除确认、刷新深链接恢复、退出重登、移动端响应式、双主题视觉、全流程无 JS 异常。

```bash
npm run dev &          # 先启动开发服务器
node e2e/run-tests.mjs # 运行（自动拉起无头 Chrome，零第三方依赖）
```

针对性调试脚本：`e2e/debug-login.mjs`、`e2e/debug-upload.mjs`、`e2e/debug-reload.mjs`。

## 已知限制

1. **Mock 数据存于浏览器本地**：localStorage / IndexedDB 容量有限（单文件 ≤ 15MB），隐私模式下自动降级为内存存储（刷新即丢），不属于生产级数据安全方案。
2. **无真实 AI 能力**：演示货物的检查结果是写死的确定性演示数据（数量一致性核验）；真实上传文件不会产生任何提取结果。
3. **ESLint 6 条 react-refresh 警告**：`useStore` / `useTheme` / `useFileChooser` 等 hook 与组件同文件导出，属 React 生态常规实践，不影响构建与运行；后续可拆分独立文件消除。
4. **未做单元测试框架**：验证策略为 CDP E2E 断言（见上）；引入后端后可补充 Vitest 覆盖 services 层。
5. **主题徽章 / 演示标注**：顶栏 DEMO BUILD 徽章、侧栏演示环境声明、合规免责声明为有意保留的诚实标注，不建议在接入真实后端前移除。
