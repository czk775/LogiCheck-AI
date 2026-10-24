# 第五阶段开发报告 · 真实 AI 能力接入

> 生成时间：2026-10-24 上午
> 覆盖范围：后端 + 前端第五阶段（真实大模型单证理解、视觉 OCR、错误恢复）
> 原则：不部署、不推送远程、未配置密钥时不假装 AI 已接通、限流配额绝不称作免费余额
> Git 检查点：`6ff8a6f` → `d39252a` → `4054363` → `3ae066d` → `f61cf68` → `adcdd1f`（均在本地 main 分支，未推送）

---

## 1. 本阶段做了什么

一句话：**项目从「确定性解析 + AI 接口预留」，变成真正能读 PDF、图片、扫描件并给出可核验字段的完整产品。**

| 交付项 | 状态 | 说明 |
| --- | --- | --- |
| 真实大模型接入（OpenAI 兼容协议） | ✅ | 百炼 DashScope `compatible-mode/v1`，零 SDK 依赖（Node 内置 fetch） |
| PDF 文本层 → 字段提取 | ✅ | 大模型理解单证，每条字段必须给原文引用 |
| 图片 / 扫描件 → 视觉 OCR → 字段提取 | ✅ | `pdfjs-dist` + `@napi-rs/canvas` 光栅化，无 AGPL 依赖 |
| **原文引用核验机制** | ✅ | 页码 / 位置 / 置信度**全部由服务端计算**，不采信模型自报 |
| AI 结果 → 结构化校验 → 确定性核验引擎 | ✅ | 未通过核验的字段标 `unverified`，不进核验、不制造假冲突 |
| AI 状态展示（前端） | ✅ | 顶部简洁状态条，点击展开详情；双主题适配 |
| 解析失败恢复（前端） | ✅ | 失败原因与「重新解析」放在对应单证卡片上 |
| 失败场景自动化测试 | ✅ | 后端 15 条 + 前端 33 条 + E2E 三模式 |
| 额度护栏 | ✅ | `max_tokens=4096`、`temperature=0`，单次调用成本可控 |
| 密钥隔离 | ✅ | 仅后端环境变量；`apiKey` 用不可枚举属性存储，整体序列化不泄漏 |

---

## 2. 架构：AI 在哪里接入

```
上传文件
   │
   ├─ EDI 报文 ──────────→ 确定性段映射（不调用大模型）
   │
   ├─ PDF 有文本层 ──────→ 文本层提取 ──→ 大模型提取 ──→ 引用核验 ──→ 落库
   │
   └─ 图片 / 扫描件 PDF ─→ 视觉 OCR ──→ 大模型提取 ──→ 引用核验 ──→ 落库
                                              │
                                              ▼
                              确定性核验引擎（跨单证比对 + 合规规则）
```

**为什么 EDI 不走大模型**：EDIFACT 是结构化报文，字段位置由段限定符精确指定（如 `QTY+12:1000:PCE` 就是数量 1000、单位 PCE）。确定性段映射既更准、又零成本、可复算可审计；交给大模型反而引入本不该有的不确定性。这是本阶段修复的一个真实缺陷（详见 §5）。

**Provider 接口未变**：复用阶段二就定好的 `ExtractionProvider` / `OcrProvider`，流水线不关心背后是谁。切换 AI / 确定性只改环境变量。

---

## 3. 核心机制：原文引用核验

这是本阶段最关键的设计。**大模型说的页码、位置、置信度，一律不信。**

流程：

1. 提示词要求模型对每个字段给出 `quote`（值在原文中的连续片段，必须逐字出现）
2. 服务端拿 `quote` 去**该页真实文本**里找
3. **找不到 → 该字段标 `unverified`：值不采信、页码位置置空、不参与核验**
4. 找得到 → 页码取「quote 实际出现的那一页」，位置取字符偏移，置信度由服务端按证据强度计算

实测效果（真实模型输出）：

```
模型称 quote 在第 2 页 → 服务端核验发现实际在第 1 页 → 按实际位置修正
```

这个机制保证了：**页码、位置、置信度永远是核验计算出来的，不是模型编的。**

字段状态共 5 种：

| 状态 | 含义 | 是否进核验 |
| --- | --- | --- |
| `extracted` | 已提取且来源可核实 | ✅ |
| `low_confidence` | 已提取但标准化失败 / 证据强度不足 | ✅（值仍可用） |
| `missing` | 适用该单证类型但未提取到 | ❌ |
| `unavailable` | 该单证类型不适用此字段 | ❌ |
| `unverified` | 模型给了但无法在原文中核实来源 | ❌ |

---

## 4. 配置方法（安全）

### 4.1 在哪里填

**只在后端**：`logicheck-ai-server/.env`。该文件已被 `.gitignore` 排除，永远不会进 Git。

```bash
# logicheck-ai-server/.env
EXTRACTION_PROVIDER=ai
DASHSCOPE_API_KEY=sk-你的密钥
AI_MODEL=qwen3.8-flash
AI_VISION_MODEL=qwen3.8-omni-flash
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

### 4.2 密钥安全边界（已验证）

| 检查项 | 结果 |
| --- | --- |
| 前端代码含密钥 | ❌ 无（前端只有 `GET /api/system/ai-status`，响应不含凭据） |
| Git 仓库含密钥 | ❌ 无（`.env` 被 `.gitignore` 排除） |
| 日志 / 错误消息含密钥 | ❌ 无（`Authorization` 头只在请求瞬间使用；服务商回显的错误体也不拼进异常） |
| 整体序列化配置泄漏密钥 | ❌ 无（`apiKey` 用 `Object.defineProperty` 设为**不可枚举属性**，`JSON.stringify(config)` 看不到它） |

### 4.3 辅助脚本

| 命令 | 用途 |
| --- | --- |
| `npm run ai:check` | 连通性自检（真实调一次模型，打印耗时与 token） |
| `npm run ai:models` | 列出账号可用的全部模型（应对模型代际迭代） |
| `npm run ai:quota` | 查询限流配额（**注意：这是限流阈值，不是余额**） |
| `npm run ai:e2e` | 用真实文件跑完整端到端联调 |

---

## 5. 本阶段抓出并修复的真实缺陷

不是「写完就交」，是真跑真测之后暴露的问题。

### 5.1 EDI 被错误路由到大模型

**现象**：AI 模式下上传 EDI 报文 → 报 `ai_no_text`「没有可送入模型的单证文本」。
**根因**：流水线把 EDI 交给了 AI 提取器，但 AI 提取器只接受 `pages`（页面文本），EDI 传的是 `message`（报文结构）。而且这一分支明明把 `source` 标成了 `deterministic`，实际调用却是 AI——自相矛盾。
**修复**：EDI 分支改用独立的确定性提取器实例，与大模型彻底解耦。
**回归**：新增 PH5F14 / PH5F15 两条用例，断言「EDI 解析期间大模型调用次数 = 0」。

### 5.2 HTTP 400 被误报成「返回结构不对」

**现象**：1×1 像素的测试图 → 报错「AI 返回内容不符合预期结构」。
**根因**：服务商实际返回的是 HTTP 400 +「图片宽高必须大于 10px」，但错误分类把 400 归到了 `invalid_response`（「响应结构不对」），文案与真实原因完全不符，用户会去错误的方向排查。
**修复**：新增独立错误码 `invalid_request`（400 / 422），与 `invalid_response` 严格区分。前端文案改为「模型服务拒绝了本次请求」，并禁用「重新解析」（同一份输入重试还是会被拒）。

### 5.3 `unverified` 字段污染前端汇总

**现象**：模型给了但引用核验不通过的字段，值为空串，却仍被写进 `fields` 值映射，前端会把它当成一个「已提取的空字段」。
**根因**：前后端 `FieldMeta.status` 类型都缺 `unverified`，聚合层用 `as` 强制转换掩盖了类型不匹配。
**修复**：类型补齐；聚合时 `unverified` 与 `missing` / `unavailable` 同样**不进入值映射**。

### 5.4 前端错误码映射表大面积缺失

**现象**：后端实际会产出 20+ 种错误码，前端映射表只覆盖 13 种，且 `ai_server_error` 这个码**后端根本不产生**（后端是 `ai_service_unavailable`）——结果最常见的 5xx 错误永远落到「解析失败」兜底文案。OCR 链路的错误码几乎全缺。
**修复**：映射表重构，`ai_` / `ocr_` 前缀归一化后复用同一套底层语义；补齐全部变体。

### 5.5 「免费额度已用完」误称

**现象**：前端把 `quota_exceeded` 翻译成「免费额度已用完」。
**问题**：这既可能指免费额度耗尽，也可能指账户欠费，说死就是误导；而且用户明确要求「不将限流配额误称为免费余额」。
**修复**：改为「AI 额度不足或账户欠费」，建议指向控制台确认额度与账单。

### 5.6 AI 接通后仍声称「确定性解析」

**现象**：抽屉 / 货物信息 / 完整字段三处都硬写「字段由服务端确定性解析提取」。
**问题**：AI 已经接管了提取，这时还说「确定性」是在对用户撒谎。
**修复**：新增 `describeExtractionSource()`，按后端 `extraction_provider`（`deterministic` / `ai` / `ocr+ai`）如实描述，并显示模型名。

### 5.7 真实货物的字段修正被前端堵死

**现象**：点「查看 / 编辑」弹出「当前新货物没有真实 AI 提取字段」。
**问题**：后端 `PATCH /api/shipments/:id/fields` 一直都支持真实货物（留痕 + 触发重检），是前端自己拦住了。第五阶段真实 AI 字段落库后，这条人工复核闭环本该打通。
**修复**：真实货物开放编辑弹窗；确实没有来源单证时如实说明原因。

### 5.8 前端不轮询，永远停在「解析中」

**现象**：真实 AI 解析要几十秒，前端没有轮询机制，状态条永远显示「解析中」。
**修复**：新增解析轮询（1.5 秒一次），所有单证到达终态后自动停止。

---

## 6. 真实联调结果

### 6.1 连通性自检

```
接入地址： https://dashscope.aliyuncs.com/compatible-mode/v1
提取模型： qwen3.8-flash
视觉模型： qwen3.8-omni-flash

✓ 连通成功
实际模型： qwen3.8-flash
耗时：     2407 ms
token：    {"promptTokens":165,"completionTokens":156,"totalTokens":321}
```

### 6.2 端到端联调（10 步全通过）

```
[3] AI 状态端点 → configured:true, model:qwen3.8-flash ✓ 未泄漏密钥
[5] 解析 → real-invoice.pdf: parsed / provider=ai
    摘要：提取 22 个字段（1 个低置信）；引用实际位于第 1 页（模型称第 2 页），已按实际位置修正
[6] 提取 30 个可采信字段，每个都有真实页码 + 位置 + 置信度 + 原文证据
[7] 跨单证核验 → 检出「数量不一致：发票=1000 PCS · 装箱单=900 PCS」
[8-9] 扫描件 PDF → provider=ocr+ai ✓ ；图片 PNG → provider=ocr+ai ✓
```

真实提取结果（节选，每个字段都带原文证据）：

```
invoice_number  = INV-2024-8891              p1 p1@75  conf=0.9  src=ai
    证据：Invoice No: INV-2024-8891
total_amount    = USD 12,500.00              p1 p1@317 conf=0.9  src=ai
    证据：Total Amount: USD 12,500.00
port_of_loading = Shanghai                   p2 p2@21  conf=0.9  src=ai
    证据：Port of Loading: Shanghai
```

### 6.3 测试覆盖

| 层次 | 结果 |
| --- | --- |
| 后端单元 / 集成测试 | **206 / 206 通过** |
| 后端 typecheck + build | 通过 |
| 前端 typecheck | 通过 |
| 前端 lint | 0 error（6 个既有 warning，与本阶段无关） |
| 前端领域逻辑校验 | **33 / 33 通过** |
| E2E 真实后端（确定性提取） | **91 / 91 通过** |
| E2E Mock 模式 | **91 / 91 通过** |
| E2E 真实大模型模式（`E2E_AI=1`） | **93 / 93 通过** |

---

## 7. 诚实边界（明确说明做不到什么）

| 事项 | 现状 |
| --- | --- |
| 免费额度余额查询 | **没有开放 API**。`GET /api/v1/quotas` 返回的是**限流配额**（如 50 万 token/6 分钟），不是余额。脚本如实说明，不编造余额数字 |
| 模型自报页码 / 位置 / 置信度 | **一律不采信**，全部由服务端核验计算 |
| 引用核验不通过的字段 | **不采信**（标 `unverified`），宁可缺字段也不填错值 |
| 缺失字段 | **不填默认值**，显示「—」 |
| EDI 字段 | **不经过大模型**（确定性段映射），报告来源标记为 `deterministic` |
| 扫描件 PDF 页数 | 超出 `AI_MAX_PAGES`（默认 8）的部分**不处理**，解析摘要里会写明「仅送入前 N 页」 |
| 未配置 Key | AI Provider **明确失败**（`ai_not_configured`），**不回落**成确定性提取冒充 AI 结果 |
| Mock 模式 | 状态条显示「演示模式」，**绝不显示「AI 已连接」** |
| 生产部署 | **未进行**。本阶段只做本机联调 |

---

## 8. 额度说明

| 项目 | 数值 |
| --- | --- |
| `qwen3.8-flash` 限流配额 | 500,000 token / 6 分钟 |
| `qwen3.8-omni-flash` 限流配额 | 200,000 token / 6 分钟 |
| 一次连通性自检（`ai:check`） | 约 400 token |
| 一次完整端到端联调（`ai:e2e`，4 份真实文件） | **11,090 token / 6 次调用**（实测） |

按实测值，单次联调约占限流阈值的 **2.2%**，正常开发测试**不会触发 429**。

> ⚠️ 再次强调：上面两个数字是**限流阈值**（同一时间窗口内最多能用多少），**不是账户余额**。免费额度是否耗尽只能在百炼控制台查看。

### 额度护栏（两道防线）

| 防线 | 机制 | 配置项 | 默认值 |
| --- | --- | --- | --- |
| 第一道 | 单次响应输出封顶（防单次失控） | `AI_MAX_OUTPUT_TOKENS` | 4096 token |
| 第二道 | **进程内累计用量熔断**（防跑批 / 误循环） | `AI_USAGE_LIMIT_TOKENS` | 2,000,000 token |

第二道防线是本阶段补上的：累计用量触顶后**直接拒绝发起新调用**（返回 `quota_exceeded`），而不是等服务商返回 429 或账单超支才发现。累计用量可通过 `GET /api/system/ai-status` 的 `usage` 字段观测（不含密钥）。

同时固定 `temperature=0`，保证同输入同输出、结果可复现。

---

## 9. 主要改动文件

### 后端

| 文件 | 改动 |
| --- | --- |
| `src/config.ts` | AI 配置层；密钥改不可枚举属性防泄漏 |
| `src/modules/parsing/providers/llm/client.ts` | OpenAI 兼容客户端、错误分类、指数退避重试、`max_tokens` 护栏、`UsageMeter` 累计用量熔断、`invalid_request` 新错误码 |
| `src/modules/parsing/providers/ai/provider.ts` | 提示词 + 结构化校验 + 引用核验接线 |
| `src/modules/parsing/providers/ai/verify.ts` | 引用核验核心（页码/位置/置信度计算） |
| `src/modules/parsing/providers/ocr/vision.ts` | 视觉 OCR Provider |
| `src/modules/parsing/ocr/raster.ts` | PDF 光栅化（pdfjs + napi-canvas） |
| `src/modules/parsing/pipeline.ts` | EDI 走确定性提取；失败落库带 `[错误码]` |
| `src/modules/parsing/schema.ts` | `FieldStatus` 增加 `unverified` |
| `src/modules/parsing/providers/index.ts` | 真正读取 `config.ai`；未配置时明确失败；暴露 `usage()` 观测口 |
| `src/modules/shipments/aggregate.ts` | `unverified` 不进值映射；暴露 `extractionProvider` / `extractionModel` |
| `src/app.ts` | 新增 `GET /api/system/ai-status`（含 `usage`） |
| `src/config.ts` | AI 配置层；密钥改不可枚举属性防泄漏；新增 `AI_USAGE_LIMIT_TOKENS` |
| `src/db/migrations/004_ai.sql` | `evidence_quote` / `extraction_model` / `extraction_provider` |
| `scripts/ai-check.ts` `ai-e2e.ts` `ai-models.ts` `ai-quota.ts` | 联调与诊断脚本（`ai-e2e` 输出实测 token 消耗） |

### 前端

| 文件 | 改动 |
| --- | --- |
| `src/services/domain/aiStatus.ts` | 状态视图 + 错误码映射 + 来源说明（纯函数，可独立测试） |
| `src/features/workspace/AiStatusBar.tsx` | 顶部状态条 + 详情浮层 |
| `src/features/workspace/DocumentsSection.tsx` | 单证卡片内嵌失败原因与「重新解析」 |
| `src/features/drawers/DocDrawer.tsx` | 来源说明按实际提取方式展示 |
| `src/features/workspace/ProfileSection.tsx` `ProfileDrawer.tsx` | 同上 |
| `src/features/modals/FieldEditModal.tsx` | 真实货物开放字段修正 |
| `src/store/AppStore.tsx` | AI 状态同步 + 解析轮询 |
| `src/services/api/contracts.ts` `realApi.ts` `mockApi.ts` | AI 状态契约与实现（Mock 如实返回未接通） |
| `src/types/domain.ts` | `FieldMeta.status` 补 `unverified`；新增来源字段 |
| `src/styles/global.css` | AI 状态条 / 错误块样式（含浅色主题） |
| `scripts/check-domain.ts` | 领域校验脚本（33 条） |
| `e2e/run-tests.mjs` | 真实 AI 模式回归 + 失败现场诊断 |

### 新增测试

| 文件 | 条数 |
| --- | --- |
| 后端 `test/ai-failure-scenarios.test.ts` | 15 |
| 后端 `test/ai-pipeline-e2e.test.ts` | 6 |
| 后端 `test/llm-client.test.ts` | 18 |
| 后端 `test/ai-extraction.test.ts` / `ai-ocr.test.ts` / `ai-config.test.ts` | 各 4～6 |
| 后端 `test/ai-quota-parse.test.ts` / `ai-rate-limit-parse.test.ts` / `ai-quota-candidates.test.ts` / `api-key-format.test.ts` | 6 / 6 / 12 / 13 |
| 前端 `scripts/check-domain.ts` | 33 |
| E2E 真实 AI 模式 | 93 断言 |
| **后端合计** | **206 条** |

---

## 10. 遗留事项与建议

| 事项 | 说明 |
| --- | --- |
| 复核（Recheck）按钮的 AI 状态同步 | 目前解析结束会同步一次 AI 状态，AI 未配置时的提示语可再打磨 |
| 单证类型自动判定的准确率 | `unknown` 兜底仍会出现，可考虑用少量标注样本做一次评估 |
| 字段级证据展示 | 证据已落库（`evidence_quote`），但前端只在字段抽屉里显示值，**逐条展示原文片段**尚未实现 |
| 大文件 / 多页单证 | 超过 8 页的部分目前直接截断，产品上可考虑「分段提取 + 合并」 |
| 生产部署 | 本阶段明确不做。如需部署，需先补：密钥托管、限流与成本告警、日志脱敏复查 |

---

## 11. 下一步

按你的要求，**第五阶段开发到此停止，等待统一人工验收**。

人工验收请见：[`PHASE5-ACCEPTANCE-GUIDE.md`](./PHASE5-ACCEPTANCE-GUIDE.md)
