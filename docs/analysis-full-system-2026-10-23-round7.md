# 第七轮全量分析报告（2026-10-23/24）

> 范围：`src/` 全量（34 个 `.vue`、224 个 `.ts`）、`src-tauri/` 薄桥接、打包链。
> 起点：`main` = `origin/main` = `739b4f8`，工作区干净、无并发编辑。
> 方法：两个并行勘察子代理（UI 呈现层 / 架构与业务层）各出一份初稿，**逐条实测复核**后落地。
> 门禁：`npm run check` 全绿（**98 文件 / 1499 用例**，基线 98 / 1476）；`npm run uitest` 56/56 通过。

---

## 1. 结论速览

| 项       | 结果                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 子系统   | 8 个业务域路由 + 工作台 + 桌面壳；分层边界（views → stores → orchestrator → infra → repositories）**无违规** |
| 本轮复核 | 子代理初稿 41 条，**抓出 3 条误报并撤回**（见 §5）                                                           |
| 落地修复 | 3 个 P0 + 8 个 P1（§3），全部先**反证**后改                                                                  |
| 新增测试 | 23 个用例；其中 6 组做了反证验证，2 组反证发现断言恒真/不敏感，已重写                                        |
| 未关闭   | 3 项待拍板（§6）+ 一批 P2（§7）                                                                              |

**本轮的靶心是「长跑失效」的第二层**：前几轮修的是「能力写了没人调用」与「集合只增不删」，
这一轮暴露的是**「清理链本身缺一路，并连锁锁死了另一条链」**（`welink_reply_jobs` 无保留期 →
消息保留期对被引用的行永久失效 + 启动恢复工作集被历史 failed 挤满）。

---

## 2. 系统功能与 UI 现状

### 2.1 功能矩阵（8 条业务路由）

| 路由        | 组件                       | 职责                                        | 状态       |
| ----------- | -------------------------- | ------------------------------------------- | ---------- |
| `/`         | `DashboardView`（787 行）  | 工作台汇总：双域状态 + 待办队列 + 运行信息  | 只读快照   |
| `/table`    | `TableCrudView`（576）     | 业务记录 CRUD + 导出                        | 稳定       |
| `/welink`   | `WeLinkView`（595）        | WeLink 助手运行时：控制条 + 向导 + 5 个 Tab | 核心域     |
| `/groups`   | `GroupView`（177）         | 快速建群：建群 / 模板 / 历史 3 个 Tab       | 含外发路径 |
| `/codehub`  | `CodehubReviewView`（891） | 内网 MR 检视（纯只读）                      | 稳定       |
| `/settings` | `SettingsView`（530）      | 配置总页：8 张配置卡                        | 稳定       |
| `/envcheck` | `EnvCheckView`（320）      | 环境检测（逐项步骤明细）                    | 稳定       |
| `/about`    | `AboutView`（243）         | 版本 / 技术栈 / 目录结构                    | 稳定       |

### 2.2 UI 一致性基线（前六轮的成果，本轮复核仍在）

| 收敛项                                                              | 采用率                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `confirmDanger()`（确认框唯一出口）                                 | 16 处调用，**0 处裸 `ElMessageBox.confirm`**               |
| `runUiAction()`（异步动作唯一出口）                                 | 62 处调用                                                  |
| `createGo()`（导航唯一出口）                                        | 4 处；`App.vue` 仍有 1 处裸 `router.replace`（P2，风险低） |
| `ElConfigProvider :size="'small'"`                                  | 全局收口，无需逐处补 `size`                                |
| 语义色 token（`var(--el-*)` / `--ht-*`）                            | 全库 `.vue` 仅剩 2 处硬编码叠白（深轨 hover 魔数，P2）     |
| 架构闸门（UI 禁触 `@/infra` / `@/repositories` / `@/orchestrator`） | **0 处违规**，0 处 `eslint-disable` 绕过                   |

---

## 3. 本轮落地的修复（3 个 P0 + 8 个 P1）

### P0-1　`welink_reply_jobs` 无保留期清理 —— 连锁锁死消息保留期与启动恢复

**证据**：`retention.doRun` 只有消息 / 语料 / 沉淀留痕 / 公告四路，全库无 `purgeJobsBefore`；
而 job 恰恰是写入最频繁的一张表。三个连锁后果：

1. `listUnfinishedJobs` 取「最老的 2000 条」，而 `failed` 永不离场（启动恢复刻意不重投 failed）
   —— 攒够 2000 条后，**新的 pending/ready 一条都进不了恢复集**：重启后不生成、不外发，
   且 `bootstrap.warnings` 为空、界面无任何异常。
2. `purgeMessagesBefore` 的 `NOT EXISTS` 跳过仍被 job 引用的消息 → job 不清 ⇒ 这些消息
   **永不过期** ⇒ 消息保留期对它们永久失效。
3. `jobStats` 是无 `WHERE` 的全表聚合，随 job 无界增长线性变慢。

**修复**：新增 `purgeJobsBefore(cutoff, batch)`（只清 `sent/failed/skipped` 且 `finished_at`
非空）、`JOB_KEEP_DAYS = 180`、接进 `retention` 作为**第五条链且排在消息链之前**
（先清 job 才能解放被引用消息）。索引复用 v10 的 `idx_wrj_status_finished`，无需新迁移。

**测试**：`retention.spec.ts`（截止时刻 + 顺序 + 串行）、`welink-sqlite-integration.spec.ts`
（真库：只清终态 / finished_at 为空不清 / 边界 / 解放消息 / 级联留痕 / 分批）、
`welink-contract.spec.ts`（内存实现同口径）。**反证**：顺序改回去 → 红；SQL 白名单去掉 → 红。

### P0-2　`insertAgentLog` / `insertSedimentLog` 落库未过遮蔽表 —— 密钥的第二条出口

**证据**：`maskSecrets` 此前只用在 `welink_reply_jobs.last_error` 一处。而 `agent-http` 会把
响应体前 200 字拼进 `AgentError`（`orchestrator/secrets.ts` 自述过这个风险），部分网关 4xx
会回显请求信息；该串经 `pipeline.onCall` 原样落入 `welink_agent_logs`，
`knowledge-harvester` 同样把 `error.message` 落进 `sediment_logs`。

**修复**：双实现（SQLite + 内存）落库前 `maskSecrets`，顺序统一为「先遮蔽再截断」。
顺带修掉一处**返回值与落库值不同源**：SQL 侧旧写法返回 `{ ...log }`（入参原样展开），
等于「库里安全、调用方拿到明文」。

**测试**：真库回读断言不含密钥且含 `***`；双实现遮蔽结果一致。**反证**：去掉遮蔽 → 红。

### P0-3　（UI）4 张 `el-table` 缺 `row-key`

`GroupHistoryTab` / `ConfigTab` / `HistoryTab` / `TemplateTab` 四张表没有 `row-key`，
Element Plus 退化为按**行下标**锚定展开态与勾选态 —— 删行后展开态会落到邻行
（A 群的成员清单展开着、标题却写着 B 群）。

**修正了子代理的两处夸大**：① `GroupHistoryTab.remove()` 不重拉是**误报**
（`store.removeJob` 会 bump `historyVersion`，组件有 watch 驱动重载）；
② `selected` 存的是**行对象**不是下标，`batchAutoReply` 读的 `conv.convId` 不会漂，
所以这不是「误操作到别的会话」级别的问题，定 P1（视觉态漂移）而非 P0。

### P1（8 项）

| #   | 修复                                                                                                        | 位置                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | 启动恢复：`failed` 移出 `listUnfinishedJobs`，计数改走新增的 `countFailedJobs()`；循环内保留兜底 `continue` | `bootstrap.ts` + 双仓储                         |
| 2   | `manualOverride` 在 `sendOne` 的「非 ready 提前返回」处补 `delete`（唯一未回收的出口）                      | `pipeline.ts`                                   |
| 3   | `convCache` 加 LRU 上限 2048 + 命中刷新位置；`view.removeConversation` 补 `invalidateConversation`          | `safety-gate.ts` / `view.ts`                    |
| 4   | 技能关键词正则补齐三道护栏（长度上限 / `looksCatastrophic` / 编译缓存），与黑名单同款                       | `skill-router.ts`                               |
| 5   | `retention` 四条链由 `Promise.all` 改**串行**（文件头约束本就写着「避免叠加成并发删除」）                   | `retention.ts`                                  |
| 6   | `HistoryTab` / `GroupHistoryTab` 三触发源叠加 → `requestLoad()` 微任务合并                                  | 2 个组件                                        |
| 7   | `SkillsSection` 删除技能补 `confirmDanger`（全项目最后一处无确认的删除）                                    | `SkillsSection.vue`                             |
| 8   | `HistoryTab`「重发」补 `:loading`（重发会把任务送回外发队列）                                               | `HistoryTab.vue`                                |
| 9   | 3 处可点击非按钮元素补 `role="button"` + `tabindex="0"` + 键盘事件                                          | `HistoryTab` / `AgentSection` / `SkillsSection` |

---

## 4. 测试与门禁

| 指标               | 基线（第六轮） | 本轮          |
| ------------------ | -------------- | ------------- |
| vitest 文件 / 用例 | 98 / 1476      | **98 / 1499** |
| `npm run lint`     | 通过           | 通过          |
| `vue-tsc --noEmit` | 通过           | 通过          |
| `npm run uitest`   | 56 通过        | **56 通过**   |

新增 23 个用例。按项目铁律**逐组先反证**，其中两次反证抓出了问题：

- 「清理链顺序」第一版写成 `[...jobCalls, ...messageCalls][0] === jobCalls[0]` —— **恒真**，
  反证不改红。改成共享一根 `callOrder` 序列后反证通过。
- 「编译缓存」用例复用了前面用例已编译进缓存的词条（模块级单例），spy 记到 0 次而恒绿。
  换成独一份词条后反证通过（去掉缓存 → 20 次编译 → 红）。

---

## 5. 本轮撤回的误报（3 条）

| 子代理初稿结论                                       | 复核结果                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GroupHistoryTab.remove()` 删完不重拉 → 幽灵行       | **误报**：`stores/group.removeJob` 会 `historyVersion += 1`，组件 `watch(store.historyVersion)` 已驱动重载         |
| `ConfigTab` 三个开关全量 `load()` → 应该改成局部更新 | **有意设计**：代码注释与项目铁律都明写「开关失败必须重拉，否则界面开着、库里没开」。改成局部更新会**引入**静默失效 |
| `ConfigTab` 缺 row-key → 批量操作作用到错的会话      | **夸大**：`selected` 存的是行对象，`convId` 从对象读，不会漂。仅视觉勾选态与展开态漂移 → 降 P1                     |

（前几轮子代理还误报过「`scheduleRetry` 是死代码」，已在上轮撤回。本轮两条报告未再出现。）

---

## 6. 待拍板（本轮未动）

| #   | 议题                                                                                                            | 现状                                                                                                 | 建议                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1  | 配置明文落盘                                                                                                    | `config.json`（或 localStorage）含 `agent.apiKey` / `rag.apiKey` / `codeHub.token` 明文，落点仅 2 处 | 引入 DPAPI（Windows）加密存储；属架构级变更，单开一轮                        |
| Q2  | `infra/update/key.ts` 的 minisign 公钥是 PoC 一次性值                                                           | 发版前**必须轮换**                                                                                   | 排进发版 checklist                                                           |
| Q3  | `infra/windows/**`（7 文件 ~600 行 + 6 个 spec）**生产侧零消费方**，但 Rust 白名单已为它放行 8 个 System32 程序 | 攻击面已开、收益为零                                                                                 | 二选一：接线（补一个 UI 入口）或下线（删 TS + 同步摘白名单）。建议发版前拍板 |

---

## 7. 下一轮建议方向（P2 / 结构性）

**可测、收益明确**

1. `confirmDanger` 之外仍剩 30 处手写 `catch`；其中 8 处 loader 样板（`HistoryTab` /
   `GroupHistoryTab` / `TraceTab` ×2 / `ConfigTab` / `InboxTab` / `ConversationListPanel` /
   `MessagesTab`）可整体换成 `runUiAction(..., { fail, busy })`。
2. 四个探针卡片（`SettingsCard` / `AgentSection` / `RagSettingsCard` / `CodehubSettingsCard`）
   的 busy+结果+提示三件套抽 `useProbe()`。
3. 补 `stores/welink/index.ts`（376 行装配根，唯一公共 facade，**零 spec**）的装配测试：
   `ensureRuntime` 幂等、`setGroupGate` 拿到同一 gate 实例、日志订阅不叠加。

**结构性（改前先评估回归面）** 4. `.spacer` 22 处声明 / 6 种命名 → 全局一处；`.wc__*` 在 4 个嵌套组件各抄一遍。5. `DashboardView`（427 行 scoped CSS）/ `CodehubReviewView`（452）/ `InboxTab`（339）优先拆样式。6. 三处 N+1 IPC：Gate 预热（最坏 2001 次串行 IPC）、`syncConversations` 逐条 upsert、
沉淀归档单轮 ~300 次 IO —— 都需先加批量仓储方法。7. `b64.base64ToBytes` 同步 O(n) 三份拷贝（每轮轮询 N 会话 × 3 批）。

**不建议动**：`codehub` token 走 argv（改动需触及 Rust 进程创建，代码已自认并记录）；
`applyPollResult` 的 created-jobs 回查口径（窗口仅 1 秒，收紧需新迁移）。
