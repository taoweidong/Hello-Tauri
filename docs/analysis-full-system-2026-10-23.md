# Hello-Tauri 全量分析（第六轮）：静默失效收尾与长跑泄漏收口（2026-10-23）

> **范围**：按既定节奏做第六轮全量分析 —— 两个并行子代理（UI 呈现层 / 业务架构层）
> 全量勘察，交叉比对后落地修复，再跑全量门禁。
> **明确不做**：Q1（密钥落盘加密 DPAPI）、Q2（发版前轮换更新公钥）、大文件拆分
> （S10）—— 均维持上轮结论，见 §7。
> **边界**：未改 Rust；新增一条索引迁移（v12）；未触碰覆盖率阈值。

## 0. 结论摘要

| 项                   | 结果                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------ |
| 门禁 `npm run check` | lint 0 问题 / `vue-tsc` 无错 / **98 文件 · 1476 用例全绿**（上轮 97 · 1461）                |
| 覆盖率（lines）      | `orchestrator` / `infra/db` / `infra/windows` 三项均高于基线（92 / 72 / 90）                |
| 新迁移               | **v12** `idx_wan_created_at`（群公告 `created_at` 索引）                                    |
| 新模块               | `src/utils/nav.ts`（`createGo`）、`ui-action.ts` 新增 `confirmDanger()`                      |
| 修复                 | 3 个 P0 + 10 个 P1（见 §4 / §5），另有 1 项「上轮误报」的撤回                               |
| 提交                 | 见 §6                                                                                        |

三个最值得说的：

1. **长跑泄漏一口气收掉三处**：`pipeline` 的 `generateRetries`、`promptOwners` 与
   `safety-gate` 的 `convStates` 都是「只 set 不 delete」的容器。桌面应用 7×24 不重启，
   「每个曾失败过的 job」「每个被 check 过的会话」都会永久占一条。其中
   `promptOwners` 的回收 `finally` **只包住了 `agent.complete` 一步** —— 而槽位早在
   技能路由阶段就登记了，路由/取上下文/读知识文档任一步抛错都漏 —— 是本轮最隐蔽的一处。
2. **`welink_announcements` 是「清理缺的不是实现，是调度」的第四次复现**：v6 建表至今
   五个版本，它既无保留期也无清理接口，唯一索引 `(conv_pk, published_at)` 对按时间清理
   的谓词**用不上**（与 v9 同构）。本轮补 v12 索引 + `purgeAnnouncementsBefore` +
   接进 `retention`，保留 90 天。
3. **`confirmDanger()` 收口 16 处确认弹窗**：抄了 16 遍的样板里，真正的风险不是行数，
   是 `dangerouslyUseHTMLString` —— 会话标题等外部数据会拼进弹窗文案，任何一处手抖开成
   true 就是一个 XSS 口子；现在它在唯一一处显式关死。

## 1. 勘察口径

- 工作区干净（`main` 与 `origin/main` 同步于 `da3f0a2`；跑前用
  `find src docs -newermt "-10 minutes"` 复核无并发编辑）。
- 两路勘察互不共享结论，交叉比对后按 P0 → P1 → P2 排序落地；**每条结论均实测复核**
  （`wc -l` / `grep -c` / `sed -n` 逐条验证，不照单全收 —— 第五轮子代理误报过
  `UpdateSettingsCard` 缺 busy）。

**已收口、不再重复报告**（复核确认在位）：组件 `size` 由 `ElConfigProvider` 收口、
`runUiAction` 覆盖 80 处、密钥三重遮蔽、`maskSecrets` 落库遮蔽、`sediment_logs` 清理链
（v11）、生成段异常回写、UI 层直触 `@/infra`（**0 处**，闸门有效）、CodeHub 200 条截断提示。

## 2. 系统功能矩阵（六轮基线）

| 域       | 能力                                                                 | 入口                                                        | 数据                                        |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| 工作台   | 四域摘要聚合 + 快捷入口、建群（模板/成员/留痕）、表格 CRUD + CSV 导出 | `DashboardView` / `GroupView` / `TableCrudView`             | `records`、`welink_group_*`                 |
| WeLink   | 轮询 → 技能路由 → 本地大模型 → 安全外发；收件箱/历史/回溯/配置         | `WeLinkView`（6 Tab）+ 13 个组件                            | `welink_*` 六表 + `welink_agent_logs`       |
| CodeHub  | 内网 MR 检视：CLI 子进程 → SQLite 快照 → 列表/详情（纯只读、无外发）  | `CodehubReviewView`                                         | `codehub_*` 三表                            |
| 知识沉淀 | 公告/群消息 → 待评审队列 → 知识库 md；调用留痕可回溯                  | `KnowledgeCard` / `SedimentCard`                            | `welink_announcements`、`knowledge_drafts`  |
| 设置     | 存储迁移、自启、主题、PageSize、更新源与摆渡扫描                      | `SettingsView` / `UpdateSettingsCard`                       | `config.json`、注册表                       |
| 系统     | 环境自检、日志、关于、托盘驻留、自动更新                              | `EnvCheckView` / `AboutView`                                | `logs/app-*.log`                            |

- 代码规模：TS 221 个 / `.vue` 35 个；`orchestrator` 33 文件 13.3k 行、`infra` 104 文件
  17.5k 行、`stores` 28 文件 6.3k 行。
- 数据层：迁移 **12** 版（本轮 +1），索引 22 条（本轮 +1），5 条外键（仅
  `jobs.trigger_msg_pk → messages` 为 NO ACTION，刻意保留）。

## 3. UI 层现状（34 个 `.vue`）

### 3.1 规模分布

| 层         | 文件数 | 最大文件（总行 / style 占比）                                        |
| ---------- | ------ | -------------------------------------------------------------------- |
| views      | 8      | `CodehubReviewView` 892 / 50.8%、`DashboardView` 788 / 54.3%          |
| layouts    | 1      | `MainLayout` 480 / **62.7%**（全库最高）                              |
| components | 25     | `HistoryTab` 754、`ConfigTab` 683、`TraceTab` 672、`InboxTab` 643     |

> CSS 占比 ≥50% 的 6 个：`MainLayout` 62.7% / `TimelinePanel` 62.5% / `DashboardView`
> 54.3% / `InboxTab` 52.9% / `CodehubReviewView` 50.8% / `WizardPanel` 49.0%。

### 3.2 本轮收口的重复样板

| 样板                  | 收口前                                     | 收口后                                   |
| --------------------- | ------------------------------------------ | ---------------------------------------- |
| `ElMessageBox.confirm`| **16 处**（14 处 `.catch(() => false)` + 2 处 `try/catch`） | `confirmDanger()` 1 处实现         |
| 路由跳转 `go()`       | **3 份定义且实现不一致** + 1 处裸 `push`    | `createGo()` 1 处实现，4 处调用           |
| 卡片头 `.spacer`      | 18 个文件各定义一遍（6 个文件逐字重复）     | **本轮未做**（见 §7 P2）                  |
| 空状态                | 22 处、5 套 class 命名、3 种机制            | **本轮未做**（见 §7 P2）                  |

### 3.3 剩余缺口（未做）

- **不可逆删除按钮无 `:loading`**：本轮修 4 个（建群历史 / 模板 / 会话 / 任务记录），
  剩余 `SettingsView:271`（恢复默认）未修。
- **无障碍**：81 个控件无 accessible name（`el-input` 27 / `el-input-number` 16 /
  `el-switch` 14 / `el-select` 8 / 其它 16）；2 个 `el-dialog` 无 Esc 关闭与焦点陷阱。
- **测试**：20 个 `.vue` 无 spec（按行数占 42.4%），其中 `HistoryTab`/`ConfigTab`/
  `WeLinkView`/`TraceTab` 四个大页面连续两轮点名未补。
- **`InboxTab` `limit: 100`** 静默截断且无提示（CodeHub 已有 `truncated` 模式可照搬）。

## 4. 缺陷清单与处置

### P0

| #   | 缺陷                                                            | 位置                                  | 处置 |
| --- | --------------------------------------------------------------- | ------------------------------------- | ---- |
| A-1 | `promptOwners` 槽位泄漏：回收 `finally` 只包住 `agent.complete`  | `pipeline.ts:142 / 330`               | ✅ 登记簿提到闭包层，由 `flush` 的 `finally` 统一回收 |
| A-2 | `generateRetries` 只 set 不 delete                               | `pipeline.ts:131`                     | ✅ `emitStatus` 按终态集合回收（一处收口，不散写）     |
| A-3 | `convStates` 只 set 不 delete                                    | `safety-gate.ts:218`                  | ✅ LRU 上限 2048（**不**接 `invalidateConversation`，那是限流绕过口子） |
| A-4 | `welink_announcements` 无保留期、无清理接口、无可用索引           | `retention.ts` / `sediment-ports.ts`  | ✅ v12 索引 + `purgeAnnouncementsBefore` + 接线（90 天） |

### P1

| #   | 缺陷                                                       | 位置                                                     | 处置 |
| --- | ---------------------------------------------------------- | -------------------------------------------------------- | ---- |
| B-1 | 16 处确认弹窗样板（含 XSS 开关无统一约束）                  | 11 个 `.vue`                                             | ✅ `confirmDanger()` |
| B-2 | 4 个不可逆删除按钮无 busy                                   | `GroupHistoryTab` / `TemplateTab` / `ConfigTab` / `HistoryTab` | ✅ 补 `removing` + `:loading` |
| B-3 | `go()` 三份定义不一致 + `WeLinkView` 裸 `router.push`        | 4 个文件                                                 | ✅ `createGo()` 合一 |
| B-4 | 6 处浮动 Promise 无 `.catch`（reject 即未处理拒绝且零感知）  | `update.ts:247/252/256`、`app.ts:125`、`control.ts:236`、`events.ts:139` | ✅ 逐处补 catch + 日志 |
| B-5 | `codehub_sync_state` 全表 SELECT 无 LIMIT（P7 违规）         | `repos/codehub.ts:252`                                   | ✅ `LIMIT 1000` |

### P2（本轮未做，列入 §7）

`retention.running()` 用单一标量表达复合状态（在飞轮次期间为假）；`fuseHandlers` 无退订
接口；`bootstrap` 与 `syncConversations` 两处 N+1 IPC；`knownDocHashes()` 每轮全量重算；
`archiveQaRound` 逐条双写水位；LLM/RAG 出网未过安全闸（**待拍板，见 §7-Q3**）；
7 个零引用导出；`str/num/nullable` 行映射四份重复。

### 撤回一项上轮误报

`scheduleRetry` 被判为死代码 —— 实测有 **5 处调用**（`pipeline.ts:405/475/518/553/628`）
加 1 处内部递归，是活跃代码，**本轮撤回该建议**。

## 5. 本轮修复要点

### 5.1 `promptOwners`：把回收点移出 `generateOne`

槽位在**技能路由**（`routeSkill` → `onClassifyPrompt`）时就登记，而原有 `finally` 只包住
`agent.complete`。修法不是把 140 行代码整体缩进进 `try`，而是：

- 新增闭包级登记簿 `slotOwners: Map<jobPk, Slot[]>`；
- `generateOne` 入口 `slotOwners.set(jobPk, ownedSlots)`；
- 快路径（模型调用结束）与慢路径（`flush` 的 `.finally`）都调 `releaseSlots(jobPk)`，**幂等**。

> 判据（可复用）：凡「回收逻辑写在被回收对象的生产者内部」，先看它的 `try` 起点是否
> **早于**第一次登记。早于才安全，否则任何前置步骤抛错都漏。

### 5.2 终态集合：`TERMINAL_JOB_STATUS`

`generateRetries` 的清理没有散在每个终态分支，而是收在 `emitStatus` 一处 —— 因为
「状态流转」是唯一能同时看到所有终态的地方。散写漏一个就是泄漏，这正是抄写型代码的
典型失效形态。

### 5.3 `convStates` 为什么用 LRU 而不是顺手删

`invalidateConversation()` 是 **upsert 会话时**调用的（开关/静音变了要让缓存失效）。
在那里顺手删 `convStates` 等于「每次改配置就清零该会话的小时配额」—— 一个**限流绕过
口子**。所以改用 LRU：命中即刷新位置，活跃会话永不淘汰，只淘汰最久未被 check 的冷会话。

### 5.4 公告清理：第四次复现的同一个毛病

| 版本 | 表                    | 症状                                          |
| ---- | --------------------- | --------------------------------------------- |
| v6   | `welink_messages`     | 清理接口写好了，无人调度                       |
| v6   | `welink_agent_logs`   | 同上                                           |
| v6   | `sediment_logs`       | 同上 + 全表 DELETE + 无索引（第五轮修）        |
| v6   | `welink_announcements`| **连接口都没有** + 索引不可用（本轮修）        |

> 判据：`grep` 清理符号的调用点 = 0，且该表**持续写入**。这两条同时成立就是定时炸弹。

### 5.5 `confirmDanger` 的语义边界

- 返回 `true` = 确认，`false` = 取消或关闭（`ElMessageBox` 用 **reject** 表达取消，
  在此折叠为布尔，避免调用方漏挂 `.catch`）；
- `dangerouslyUseHTMLString` 恒 `false`（外部数据会拼进文案）；
- `danger: true` 才挂 `el-button--danger`；`tone` 支持中性批量操作用 `info`；
- 取消**不算错误**，不弹 toast —— 由调用方决定 `return` 还是回滚字段值
  （如配额放宽被拒时改回默认值）。

## 6. 门禁

| 项         | 结果                                                          |
| ---------- | ------------------------------------------------------------- |
| `npm run lint` | **0 问题**                                                 |
| `vue-tsc --noEmit` | **无错**                                               |
| `npm test` | **98 文件 / 1476 用例全绿**（上轮 97 / 1461；本轮 +1 文件 +15 用例） |
| 覆盖率 | `orchestrator` / `infra/db` / `infra/windows` 均不低于基线（92 / 72 / 90） |

**新增用例与反证记录**

| 用例                                   | 条数 | 反证方式                                     |
| -------------------------------------- | ---- | -------------------------------------------- |
| `confirmDanger` 五条契约               | 5    | 把 HTML 开关改成 `true` → 「恒不启用 HTML」变红 ✅ |
| `createGo` 五条语义（新文件 `nav.spec.ts`） | 5    | 删同路径守卫 → ②⑤ 变红；去 `.catch` → ④ 变红（已按反证修正 mock 返回值） |
| `convStates` LRU 容量                  | 2    | 上限改成 999999 → 「不随历史会话数增长」变红 ✅ |
| 公告清理（retention 3 + 契约断言 7）    | 3    | 依赖双实现对照（SQL vs 内存），同错即假绿已由 `annCountBeforePurge` 护栏挡住 |

## 7. 下一轮建议与待拍板

**建议方向**（按性价比排序）

1. `.spacer` 与卡片头 CSS 提到全局样式（18 / 6 文件重复）—— 与 `confirmDanger` 同型。
2. 空状态统一为 1 个 `AppEmpty` 组件（5 套命名 + 3 种机制 → 1 套）。
3. `DashboardView` 4 处 `logger.warn` 降级改为可见错误态（首屏摘要卡可能全空）。
4. 补 4 个无 spec 大页面（`HistoryTab` / `ConfigTab` / `WeLinkView` / `TraceTab`）。
5. `bootstrap` / `syncConversations` N+1 IPC（需先加批量仓储，照搬 `applyAnnouncements`）。
6. `str/num/nullable` + `placeholders` 抽到 `infra/db/repos/row-map.ts`（消 4 + 2 处重复）。
7. `stores/welink/index.ts`（376 行装配根，仍是最大未测点）补 spec。

**待拍板**

- **Q1 密钥明文落盘**（`config.json` 存 `agent.apiKey` / `rag.apiKey` / CodeHub token）。
  建议方案 A：Windows DPAPI 加密，Rust 侧已有 `autostart` 薄桥接先例。
- **Q2 发版前必须轮换** `infra/update/key.ts` 的 PoC 一次性公钥。
- **Q3 LLM/RAG 出网未过安全闸**：`safety-gate` 是**消息/建群外发**的唯一出口，但
  `agent`/`rag` 走 `bridge.httpPostJson` 直连，prompt 携带会话原文出网。是否新建
  `egress-gate`（关开 + 配额 + 审计）需产品定调 —— 本轮**未动**（改动面涉及生成主链路）。
