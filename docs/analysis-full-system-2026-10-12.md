# Hello-Tauri 系统功能与 UI 全量分析报告

> 分析日期：2026-10-12 · 分支 `main` · 基线提交 `d4886c5`
> 范围：`src/**`（前端全量）+ `src-tauri/src/**`（宿主命令清点）+ 测试体系
> 产出：现状清单 → 缺陷定级 → 优化路线图；本轮已落地的修复见 §6

---

## 1. 规模与技术底座

| 项 | 数值 | 说明 |
| --- | --- | --- |
| `.vue` 文件 | 35 个 / 12,960 行 | 页面 8 + 布局 1 + 组件 26 |
| `.ts` / `.spec.ts` | 202 / 84 | 用例 1273 个，describe 254 个 |
| Rust 命令 | 34 个 | 全部为薄桥接，零业务规则 |
| Bridge 方法 | 36 个 + 1 字段 | tauri / web 双实现，运行时自动选择 |
| 路由 / 侧栏分组 | 8 条 / 4 组 | 全部懒加载，hash 模式 |
| 覆盖率（最近一次） | lines 69.31% · functions 82.67% · branches 85.69% | 阈值：`orchestrator` 95/90/88、`infra/db` 72/68、`infra/windows` 90/88 |
| 待核实假设标签 | 114 处 | `CLI-ASSUME` 38 · `MOCK-WIN` 34 · `MOCK-CLI` 19 · `MOCK-UPDATE` 8 · `RAG-ASSUME` 7 · `WIN-ASSUME` 5 · `UPD-ASSUME` 2 · `LLM-ASSUME` 1（已关闭） |

技术底座：Vue 3.5 + TypeScript + Vite 8 + Element Plus 2.14 + Pinia + vue-router 5；图标全内联 SVG（27 形状 / 31 导出），字体系统栈，运行时零外部请求。

**架构边界核查结论（正面）**：

| 闸门 | 结果 |
| --- | --- |
| UI 层（`views`/`components`/`layouts`）不直触 `@/infra` `@/repositories` `@/orchestrator` | ✅ 零违规 |
| `orchestrator/**` 不反向依赖 `stores`/`components`/`views` | ✅ 零违规 |
| `infra/**` 不依赖 `stores` | ✅ 零违规 |
| Rust 侧无业务规则、不知道表结构 | ✅ 表结构与迁移全在 TS |
| 路由表是导航的单一真值 | ✅ `navRoutes()` 派生，侧栏零硬编码清单 |

---

## 2. 功能模块矩阵

### 2.1 编排层 `src/orchestrator/**`（17 文件 / 4,636 行）

| 模块 | 入口 | 核心能力 | 外发数据 |
| --- | --- | --- | --- |
| 回复管线 | `pipeline.ts` (836) | 生成段并发 2 / 外发段严格串行 1；乐观锁防双发、回执核对、延时重试 | **是**（唯一消息外发点） |
| 轮询器 | `poller.ts` (443) | single-flight + setTimeout 链；热/温/冷分级；会话错峰；退避 5→60s | 否 |
| 安全闸 | `safety-gate.ts` (666) | L0 急停→L1 总开关→L2 场景→L3 会话→S1–S8 限流熔断；建群走独立 `checkGroupAction` | 否 |
| 启动恢复 | `bootstrap.ts` (206) | v1–v7 幂等迁移；未终态任务三分支恢复；Gate 配额预热 | 否 |
| 组合根 | `runtime.ts` (336) | 端口/仓储/闸口/轮询/管线/恢复/清理/沉淀装配；热更新 | 否 |
| 建群编排 | `group.ts` (137) | 闸门→pending 留痕→外呼→终态回写（先落库再外呼） | **是** |
| 知识沉淀 | `knowledge-harvester.ts` (535) | 问答归档 / 公告采集 / LLM 提取→指纹去重→待评审 | **是**（prompt） |
| CodeHub 同步 | `codehub-sync.ts` (256) | single-flight；整轮失败退避 60→600s；auth 类立即终止 | 否 |
| CodeHub 详情补拉 | `codehub-detail.ts` (77) | 快照优先；同 key 并发合并；失败返回原记录 | 否 |
| 保留期清理 | `retention.ts` (218) | 每日一次；分批 500×20；消息 180 天 / 语料 90 天 | 否 |
| 自动更新 | `update.ts` (395) | 9 态状态机；摆渡 inbox；启动 10s + 周期 30min；sha256 双保险 | **是** |
| 触发规则 / 技能路由 / 密钥脱敏 / 事件契约 / 存储网关 / 定时器 | `triggers.ts` `skill-router.ts` `secrets.ts` `events.ts` `welink-storage.ts` `timers.ts` | 纯函数或薄装配 | — |

### 2.2 基础设施层 `src/infra/**`（8 个端口-适配器域 / 80 文件 / 9,388 行）

| 域 | 桥接命令 | 外发 | 状态 |
| --- | --- | --- | --- |
| welink（消息 + 建群） | `cli_run` | **是** | CLI 适配器完成，子命令/字段均为 `[CLI-ASSUME]` |
| agent（大模型） | `http_post_json` | **是** | 2026-10-04 已对真实服务逐项核实 |
| rag（检索） | `http_post_json` | **是** | 7 处 `[RAG-ASSUME]` 待核实 |
| db（SQLite） | `db_*` 4 个 | 否 | v1–v7 迁移，45 方法仓储契约 |
| envcheck | `cli_run` | 否 | 硬超时 16s，`run()` 永不 reject |
| knowledge | `fs_read/write` | 否 | 路径安全校验 + 先写文件后登记 |
| windows | `sys_*` `shell_*` `clipboard_*` `notify_*` | 否 | 双层命令白名单；5 处 `[WIN-ASSUME]` |
| codehub | `cli_run` | 否（只读） | `--token` 硬脱敏 |
| update | `http_get_text` `update_*` | **是** | minisign 公钥为 PoC 一次性密钥，发布前必换 |

### 2.3 页面清单 `src/views/`

| 页面 | 行数 | 区块 | loading | empty | error | 分页 | 筛选 | 排序 | 导出 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DashboardView | 777 | 双域面板 + 双列待办 + 运行信息 | ❌ | ✅ | ⚠️ 仅日志 | — | — | — | — |
| TableCrudView | 548 | 工具栏 + 9 列表格 + 分页 + 表单 | ❌→**已修** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ CSV |
| WeLinkView | 526 | 控制条 + 引导 + 日志 + 5 Tab | ⚠️ | ✅ | ✅ | — | — | — | — |
| GroupView | 170 | 页头 + 重试条 + 3 Tab | ❌ | ✅ | ✅ | — | — | — | — |
| CodehubReviewView | 813 | 引导/状态条 + 仓库 + chip + MR 列表 + 详情 | ⚠️ | ✅ | ✅ | ❌ 上限 200 | ✅ | ❌ | — |
| SettingsView | 522 | 界面偏好 + 存储 + 7 张配置卡 | ✅ | — | ✅ | — | — | — | — |
| EnvCheckView | 323 | 总览 alert + 检测项卡 | ✅ | ✅ | ✅ | — | — | — | — |
| AboutView | 242 | 信息 kv + 技术栈 + 目录树 | — | — | — | — | — | — | — |

Element Plus 使用频次 Top 6：`el-button` 102 · `el-form-item` 94 · `el-input` 46 · `el-table-column` 40 · `el-tag` 36 · `el-input-number` 23。

---

## 3. 四条主链路

### 3.1 WeLink 自动回复（轮询 → 外发）

1. `store.init()` → `ensureSchema()` → `loadConversations()`
2. `createWelinkRuntime()` 装配 repo/gate/poller/pipeline/bootstrap/retention/harvester，接线 `jobCreated → pipeline.enqueue`
3. `bootstrap.run()`：迁移 → 未终态任务三分支恢复 → Gate 预热 → 启动管线与轮询
4. `poller.runRound()`：`listWatching()` → 分级过滤 `due` → 错峰
5. 逐会话 `port.pull()`（续批 ≤3，跨批 msg_uid 去重）→ `filterSelf()` 防自回复
6. `buildTriggerMap()` → 同人短窗合并
7. `applyPollResult()` **单事务**：消息批写 + cursor 推进 + 建 job + 汇总列
8. 生成段：技能路由 → RAG → 知识文档 → `agent.complete()` → `sanitizeReply()` → `commitDraft()`（落 ready）
9. 外发段（严格串行）：`gate.check()` L0→S3 → `markStatus(sending)` 乐观锁 → `port.send()` → `markSent()` 单事务
10. 失败：`hasOutgoingReceipt()` 核对，有回执补记 sent（不重发），无回执 ≤3 次回 ready，超限转 failed

### 3.2 快速建群

`validateGroupDraft` → `gate.checkGroupAction`（L0/S8/S4/间隔/小时上限）→ 不通过抛 `GroupGateError`（**不留痕不外呼**）→ `validateGroupMembers`（≤500 人、禁逗号、去重）→ `createJob` 落 pending → `port.createGroup()` → `completeJob/failJob` 原子回写。

### 3.3 知识沉淀

问答归档（无 LLM，逐条推进水位）→ 公告采集（端口缺失诚实降级）→ LLM 提取 → 指纹去重 → 待评审队列 → `auto` 直通 / `manual` 人工评审（先写文件后置终态）。

### 3.4 CodeHub 检视

`codeHubConfigured()` 未配置则不发任何 CLI 调用 → `startAuto()` → 逐仓库 `listMergeRequests` → `applySnapshot()` 单事务 upsert → auth 失败立即终止本轮 → 详情面板按需补拉（快照优先，同 key 并发合并）。

---

## 4. 缺陷清单（定级：P0 功能不可用 / P1 明显影响 / P2 打磨）

### P1 — 本轮已修 ✅

| # | 位置 | 问题 | 根因 |
| --- | --- | --- | --- |
| P1-A | `orchestrator/retention.ts:158` | **`stop()` 后清理链静默复活**：只清了定时器，在飞轮次的 `.finally(() => schedule())` 仍无条件续排 | 缺「链是否在跑」的显式状态位；`timer === null` 无法区分「已停」与「在飞」 |
| P1-B | `infra/db/repos/sediment.ts:297` | **问答归档丢数据 + 重复归档**：水位是秒级 `finished_at` 单列游标，同秒并列条目被永久跳过 | 标量游标无法表达「消费到哪一条」；且排序 `(rating='up') DESC` 与游标不同序 |
| P1-C | `views/TableCrudView.vue:239` | `el-table` 无 loading，store 已暴露 `busy` 却未绑定 | 遗漏绑定 |
| P1-D | `views/WeLinkView.vue` 5 个 async | 裸 `await` 无 try/catch → 失败变成未处理拒绝，界面停在「什么都没发生」 | 缺统一失败出口 |
| P1-E | `components/group/CreateTab.vue:136` | `el-alert` 同时传 `description` 与 `#default`，同一句话渲染两遍 | 属性与插槽重复 |
| P1-F | `components/welink/ConfigTab.vue:430` | 提示文案含 Markdown 字面量 `**`，纯文本渲染直接显示星号 | 复制 Markdown 写法 |
| P1-G | `styles/index.css` + 4 处调用 | `var(--ht-border)` / `--ht-font-mono` / `--ht-mono` **从未定义**，恒走 fallback（暗色下边框不跟随主题） | token 定义了使用方、没定义提供者 |
| P1-H | `MrStateBadge.vue:38` `CodehubReviewView.vue:474/646` | 语义色硬编码 `rgba(...)`，暗色主题对比度不足 | 未走 EP 变量 |
| P1-I | 全局 53 个原生 `<button>` | 仅 8 条 `:focus-visible`，键盘用户看不到焦点 | 缺全局兜底 |

### P1 — 本轮未修（列入路线图）

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P1-1 | `stores/app.ts:105` | **密钥明文落盘**：`config.json` 明文含 agent/rag `apiKey`、`codeHub.token`；`registerSecret` 只遮蔽日志 | 改存 Windows Credential Manager / DPAPI，config.json 只放引用；至少设 ACL 并在导出时剔除 |
| P1-2 | `repositories/records.ts:198` | `loadAll()` 无 LIMIT，违反 P7 分页强制，全表载入 + 全量渲染 | 复用 `settings.pageSize` 加 `limit/offset` |
| P1-3 | 4 个表格缺 loading / 2 个缺分页 | `TemplateTab`、`DashboardView` 三轮异步装载零反馈；`CodehubReviewView` 硬上限 200 | 绑 `v-loading`；启用已定义但 0 使用的 `.skeleton` |
| P1-4 | `ConfigTab` / `HistoryTab` / `PendingJobsPanel` / `TraceTab` | 写操作无 try/catch 且按钮无 in-flight 禁用 → 连点重复入队 / 重复清理 | 统一 `busy` ref + per-row `pendingPk` |
| P1-5 | `MessagesTab.vue:70` | 窄屏 `@media(max-width:1180px)` 用 `display:none` 藏右栏，但「展开待办」按钮仍可见 → 点击无效果 | 窄屏一并隐藏该按钮，或改抽屉 |
| P1-6 | `SettingsView:206` vs `MainLayout:154` | 两处主题开关提交语义不一致（顶栏即时生效 / 设置页需保存） | 设置页主题单选改绑 `appStore.settings.theme` |
| P1-7 | `TimelinePanel.vue:71` | 模板内 `jobOfMessage()` 单条消息调用 8 次，每次全量 `find()` → O(消息×任务) | computed 预建 `Map<triggerMsgPk, Job>` |

### P2 — 打磨（未修）

| # | 问题 | 建议 |
| --- | --- | --- |
| P2-1 | 102 处 `el-button` 中 31 处不带 `size`；`text` 21 处 vs `link` 11 处混用；`el-tag` `plain` 28 vs `light` 8 | 统一 `size="small"` / `link` / `plain`，或在 `el-config-provider` 设默认值 |
| P2-2 | 6 份近乎相同的「防抖 push + 回环防护」样板（SettingsCard / Llm / Rag / Sediment / Codehub / Update） | 抽 `useDebouncedModel(normalize, emit, 300)` 组合式函数 |
| P2-3 | `ConversationListPanel.vue:92` vs `:134` 群聊/私聊两段模板近乎全等复制 | 抽 `<ConvRow :conv>` 子组件 |
| P2-4 | `WeLinkView:415` / `GroupView:164` `.tabs__body{max-height:calc(100vh-320px)}` 与外层 `.canvas` 双层滚动 | 改 `height:100%` + 父级 flex `min-height:0` |
| P2-5 | 无 `document.title` 同步（**本轮已修**）；404 直接 `redirect:'/'` 无提示；无 404 视图 | 已修标题；404 建议加视图或至少一次提示 |
| P2-6 | `MainLayout` 无宽度断点；侧栏角标硬编码 `item.path === '/welink'`；面包屑首级硬编码「工作台」 | 加 `@media(max-width:900px)`；角标与面包屑改由 meta 派生 |
| P2-7 | `pipeline.ts:583/724` 双 magic-number 忙循环（500×100 最坏 5 万次库操作）；`bootstrap.ts:177` Gate 预热最坏 2000 次 IPC；`knowledge-harvester.ts:229` `knownDocHashes()` 每轮全量读文档 | 改事件驱动消费；聚合查询替代逐会话；加哈希缓存 |
| P2-8 | `agent-http.ts`(266) / `rag-http.ts`(261) 两条**真实外发路径无直连 spec**；`stores/update.ts`、`stores/welink/knowledge.ts` 无 spec | 优先补这四个的测试 |
| P2-9 | `hasOutgoingReceipt` 用「同会话 + content 全等」当回执 → 内容重复时误判已发送 | 发送前生成幂等 `msg_uid` 落 job 列，回执核对改按 msg_uid |
| P2-10 | `updateDraft()` 无 status 守卫，可改 `sent`/`skipped` 的草稿；`manualOverride` 集合可能残留 | 加 `AND status IN (...)`；在 `sendOne` 结束时清除旁路标记 |
| P2-11 | 11 个 >400 行文件（`CodehubReviewView` 813、`DashboardView` 777、`HistoryTab` 688 居前） | 按区块拆子组件 |
| P2-12 | `sediment-memory.ts` / `welink-memory.ts` 等仓储记忆实现缺独立契约测试 | 已有 `sediment-contract.spec.ts` 模式，照搬 |

---

## 5. 优化路线图

| 阶段 | 目标 | 内容 | 判据 |
| --- | --- | --- | --- |
| **S1（本轮已做）** | 消除 P1 缺陷 | retention 链复活、沉淀水位丢数据、5 处 UI 静默失败、design token 补齐、暗色语义色、键盘焦点 | `npm run check` 全绿 |
| **S2（下一轮）** | 数据安全与性能 | P1-1 密钥加密存储 · P1-2 分页强制 · P2-7 三处 N+1/忙循环 · P2-9 幂等 msg_uid | 新增 spec 覆盖加解密往返与批量查询 |
| **S3** | UI 一致性收口 | P2-1 组件属性统一 · P2-2 抽 `useDebouncedModel` · P2-3 抽 `ConvRow` · P2-4 双层滚动 · P1-3 loading/分页 | `components.d.ts` 与 `git status` 复核；uitest 56 用例全绿 |
| **S4** | 测试补缺口 | P2-8 四个无 spec 模块；仓储记忆实现契约化 | 覆盖率阈值不回退，`orchestrator` ≥95 lines |
| **S5** | 大文件拆分 | P2-11 拆 11 个 >400 行文件 | 单文件 ≤400 行；行为零变化（先补测试再拆） |

**铁律（执行 S2–S5 时必须遵守）**：先补测试再改实现；新用例先做反证（注入缺陷看是否变红）；禁止用跳过/注释/放宽断言让测试变绿。

---

## 6. 本轮已落地的优化（S1）

| 文件 | 改动 |
| --- | --- |
| `src/orchestrator/retention.ts` | 新增 `chaining` 状态位；`start()`/`stop()`/`dispose()`/`schedule()`/`running()` 全部按它判定，杜绝「stop 后静默复活」 |
| `src/orchestrator/retention.spec.ts` | 新增回归用例「stop 后不再续排」（**已反证**：去掉 `chaining = false` 后该用例变红） |
| `src/infra/db/sediment-ports.ts` | 新增 `SEDIMENT_KEYS.qaFinishedId`；`listSentQaSince` 改复合游标 `(finished_at, id)` 并写明「排序必须与游标同序」契约 |
| `src/infra/db/repos/sediment.ts` | SQL 改 `finished_at > ?1 OR (finished_at = ?1 AND id > ?2)`，`ORDER BY finished_at ASC, id ASC` |
| `src/infra/db/repos/sediment-memory.ts` | 内存实现同口径 |
| `src/orchestrator/knowledge-harvester.ts` | 抽 `advanceQaWatermark()`，两列一起推进 |
| `src/infra/db/repos/sediment-contract.spec.ts` | 契约用例改为断言「同秒并列不丢」；排序断言随实现修正（原 `['up', null]` → `[null, 'up']`） |
| `src/views/TableCrudView.vue` | `el-table` 绑 `v-loading="tableStore.busy"` + `size="small"` |
| `src/views/WeLinkView.vue` | 新增 `failAction()` 统一失败出口；5 个 async 动作全部包 try/catch（急停/解除/启动/暂停/拉取/刷新/演示） |
| `src/styles/index.css` | 补 `--ht-border`（跟随主题）、`--ht-font-mono` / `--ht-mono` 单一等宽栈；`.mono` 引用之；新增全局 `:focus-visible` 兜底 |
| `src/components/codehub/MrStateBadge.vue` | merged 语义色改 `var(--el-color-success-light-9)` / `var(--el-color-success)` |
| `src/views/CodehubReviewView.vue` | degraded 标签与 `.repo__remove` hover 改 EP 变量 |
| `src/components/group/CreateTab.vue` | 删掉与插槽重复的 `description` |
| `src/components/welink/ConfigTab.vue` | `**不监控、不回复**` → `「不监控、不回复」` |
| `src/components/welink/settings/SafetySection.vue` | 删掉重复的 `.wc__patterns` 规则 |
| `src/components/update/UpdateSettingsCard.vue` | 补 `onBeforeUnmount` 清理未决防抖定时器（其余 5 张卡本来就有） |
| `src/router/index.ts` | 新增 `router.afterEach` 同步 `document.title`（`页面 · Hello-Tauri`） |

---

## 7. 结论

1. **架构分层执行得相当严格**：UI 层零越界、`orchestrator` 零反向依赖、Rust 34 命令全部薄桥接、路由表单一真值——这部分无需返工。
2. **本轮修复的两个 P1 都是「静默失效」型缺陷**（清理链假装已停、归档假装已完成），共同根因是**用单一标量表达不了复合状态**（状态位 / 水位）。这类问题不会在功能测试里暴露，只会以「数据悄悄少了」的形式出现。
3. **UI 债集中在三处**：状态缺失（loading/分页/错误提示）、一致性（size/text-link/token/暗色）、键盘可达性。本轮补了 token、焦点与几处静默失败；组件属性统一与重复模板抽取列入 S3。
4. **最值得优先补齐的测试缺口**是两条真实外发适配器（`agent-http.ts`、`rag-http.ts`）与两个无 spec 的 store（`update.ts`、`welink/knowledge.ts`）。
5. **发布前硬门槛**：`infra/update/key.ts` 的 minisign 公钥仍是 PoC 一次性密钥（`UPD-ASSUME`），首次真实发布前必须替换。
