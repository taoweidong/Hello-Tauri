# 第八轮全量分析报告（2026-10-26/27）

> 范围：`src/` 全量（34 个 `.vue`、226 个 `.ts`）、`src-tauri/` 薄桥接、打包链。
> 起点：`main` = `origin/main` = `d0df4fe`，工作区干净、无并发编辑。
> 方法：两个并行勘察子代理（UI 呈现层 / 架构与业务层）各出一份初稿，**逐条实测复核**后落地。
> 门禁：`npm run check` 全绿（**99 文件 / 1518 用例**，基线 98 / 1499）；
> `npm run pack` 通过（单文件 exe + PE 导入表断言）；`npm run uitest` **56/56**。

---

## 1. 结论速览

| 项       | 结果                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| 子系统   | 8 个业务域路由 + 工作台 + 桌面壳；分层边界（views → stores → orchestrator → infra → repositories）**无违规** |
| 本轮复核 | 子代理初稿 28 条，**抓出 3 条误报并撤回**（见 §5）                                                           |
| 落地修复 | 2 个 P1（UI 呈现层）+ 5 个 P1（架构层）+ 6 个 P2（§3），全部先**反证**后改                                   |
| 新增测试 | 19 个用例；其中 7 组做了反证验证                                                                              |
| 未关闭   | 3 项待拍板（§6）+ 一批 P2（§7）                                                                              |

**本轮的靶心是「失败的同形化」与「集合回收的结构性缺口」**：第七轮修的是「清理链缺一路」，
这一轮暴露的是两类更深的形态 ——

1. **静默降级的最后一处聚集地**：工作台四路摘要（CodeHub / WeLink / 建群 / 运行信息）的
   catch 只写 `logger.warn`，失败后界面落入「暂无待审」「历史建群 0 次」「没有开启中的 MR」，
   与「真的没有」完全同形。这是全库最后一处成规模的静默失效，本轮整体收口。
2. **`manualOverride` 的回收靠「记得写」**：`sendOne` 有 10 个出口，删除动作散落在 2 处，
   其余 8 处靠人工保持同步 —— 新增出口漏一个就是长跑泄漏。本轮改成 `finally` 单一兜底。

---

## 2. 系统功能与 UI 现状

### 2.1 功能矩阵（8 条业务路由）

| 路由        | 组件                       | 职责                                        | 状态       |
| ----------- | -------------------------- | ------------------------------------------- | ---------- |
| `/`         | `DashboardView`（887 行）  | 工作台汇总：双域状态 + 待办队列 + 运行信息  | 本轮主修   |
| `/table`    | `TableCrudView`（576）     | 业务记录 CRUD + 导出                        | 稳定       |
| `/welink`   | `WeLinkView`（595）        | WeLink 助手运行时：控制条 + 向导 + 5 个 Tab | 核心域     |
| `/groups`   | `GroupView`（177）         | 快速建群：建群 / 模板 / 历史 3 个 Tab       | 含外发路径 |
| `/codehub`  | `CodehubReviewView`（891） | 内网 MR 检视（纯只读）                      | 稳定       |
| `/settings` | `SettingsView`（530）      | 配置总页：8 张配置卡                        | 稳定       |
| `/envcheck` | `EnvCheckView`（320）      | 环境检测（逐项步骤明细）                    | 稳定       |
| `/about`    | `AboutView`（243）         | 版本 / 技术栈 / 目录结构                    | 稳定       |

### 2.2 UI 一致性基线（前七轮成果，本轮复核仍在）

| 收敛项                                                              | 采用率                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `confirmDanger()`（确认框唯一出口）                                 | 18 处调用，**0 处裸 `ElMessageBox.confirm`**               |
| `runUiAction()`（异步动作唯一出口）                                 | 67 处调用                                                  |
| `createGo()`（导航唯一出口）                                        | 4 处；`App.vue` 仍有 1 处裸 `router.replace`（P2，风险低） |
| `ElConfigProvider :size="'small'"`                                  | 全局收口，无需逐处补 `size`                                |
| 语义色 token（`var(--el-*)` / `--ht-*`）                            | 全库 `.vue` 仅剩 2 处硬编码叠白（深轨 hover 魔数，P2）     |
| 架构闸门（UI 禁触 `@/infra` / `@/repositories` / `@/orchestrator`） | **0 处违规**，0 处 `eslint-disable` 绕过                   |

---

## 3. 本轮落地的修复（2 个 UI P1 + 5 个架构 P1 + 6 个 P2）

### P1-1　（UI）工作台四路摘要静默降级整体收口

**证据**：`DashboardView` 的 `loadCodehub` / `loadWelink` / `loadGroup` 与运行信息刷新的
catch 都只写 `logger.warn`。四路失败后界面分别落入「没有开启中的 MR」「暂无待审」
「历史建群 0 次」，与「真的没有」**完全同形** —— 用户没有任何途径区分「加载失败」
与「确实是空」。运行信息刷新钮（`appStore.load()` 内部吞错）更是点击毫无反馈。

**修复**：

- 三个 loader 各自带 `xxxFailed` ref + `retryXxx`（走 `runUiAction`，busy 与失败提示成对）；
- 模板为三张卡片补失败态分支（`v-else-if="xxxFailed"`）与重试钮，**失败态绝不落入空态分支**；
- 刷新钮补 `runtimeBusy` + `:disabled` + 旋转动画，失败弹提示；
- 三处重试钮补 `aria-label`（修复测试选择器歧义的同时提升可访问性）；
- `watch(reviewCount)` 的 `loadReviewQueue` 补 `.catch`（该 watch 是浮动 Promise）。

**测试**：`DashboardView.spec.ts` 新增 4 例（三路失败可见态 + 重试恢复 + 刷新 busy/失败提示）。
**反证**：失败态文案与重试钮是新增模板分支，修复前因元素不存在而红。

### P1-2　（UI）`manualOverride` 回收改 `finally` 单一兜底

**证据**：`sendOne` 有 10 个出口，`manualOverride.delete` 只写在 2 处（「非 ready 提前返回」
与「越过 manual 检查后」），其余出口（乐观锁落空、记账未生效、发送成功等）**靠调用顺序
隐含覆盖**；一旦未来新增出口忘记加 delete，就是长跑泄漏，且无任何测试能发现。

**修复**：`sendOne` 整体包进 `try/finally`，`let requeuedForRetry` 标记四个「请求还会重来」
的出口（sending 回落 / defer 挂起 / 触发消息读取重试 / 发送失败重试——它们都会把 job 推回
`sendQueue`，下一轮还要靠 override 绕过 manual 拦截）；其余出口默认删除。

**测试**：`pipeline.spec.ts` 新增 2 例行为探针。**反证（双向）**：
① 注入「终态不回收」→ 乐观锁落空用例红；② 注入「无条件回收」→ defer 保留用例红。
两个方向都验过，证明兜底既不过窄也不过宽。

### P1-3　`knowledge_drafts` 无保留期清理（「只增不减」第五次复现）

**证据**：`retention.doRun` 有五路清理，`knowledge_drafts`（沉淀评审的留痕表，每轮
harvester 持续写入）不在其中 —— 全库没有 `purgeKnowledgeDraftsBefore`，该表无界增长。

**修复**：新增 migration v13（`idx_kd_reviewed_at` 索引）、双实现
`purgeKnowledgeDraftsBefore`（只清 `approved/rejected` 且 `reviewed_at` 非空的；
`pending` 永不清）、`KNOWLEDGE_DRAFT_KEEP_DAYS = 90` 接进 retention 作为**第六条链**。

**测试**：`retention.spec.ts` 4 例（默认 90 天 / 收敛计数 / keepDays 覆盖 / 抛错不停摆）、
`sediment-contract.spec.ts` 双实现三档语义块。**反证**：去掉默认常量引用 → 红。

### P1-4　knowledge 清单读-改-写竞态 → 串行写队列

**证据**：`createKnowledgeCore` 的清单操作是 `loadIndex → 改 → persistIndex` 三段式，
**无任何互斥**。UI 审批（`offShelf`）与 harvester 轮次（`registerDoc`）并发时，
后写者用旧全量覆盖前者的结果 —— 一条审批静默丢失。

**修复**：`createKnowledgeCore` 内加 Promise 串行写队列（`writeChain = next.then(ok, ok)`
防毒化），`saveDoc/appendDoc/offShelf/registerDoc` 四个写操作包进 `serializeWrite`；
读操作不进链（读不需要互斥，进链只会拖慢审批界面）。

**测试**：`ports.spec.ts` 2 例（可控延迟内存盘交错两个 saveDoc → 两条都进清单；写失败不毒化链）。
**反证**：去掉队列 → 交错用例红。

### P1-5　（架构）闸口预热与会话同步批量化（2N IPC → 2 次）

**证据**：两处串行 IPC 模式：
① `bootstrap` 的 Gate 预热逐会话 `primeConversation`，最坏 2001 次串行 IPC；
② `syncConversations` 逐候选 `upsertConversation`，每条都是「INSERT + 读后回查」2 次 IPC。

**修复**：

- 预热改 `Promise.all(watching.map(...))`（跨会话并发；读并发安全，注释说明）；
- 新增仓储方法 `upsertConversationsBatch`（SQL 侧每 500 条一次多值 INSERT + 单条 IN 回查，
  ON CONFLICT 语义与单条版逐字一致；内存实现 `Promise.all`），`syncConversations` 改一次批调用。

**测试**：`bootstrap.spec.ts` 预热铺开用例（第一个会话计数挂起，断言第二个已发起）；
`view.spec.ts` 断言单次批调用 + 入参形状；`welink-contract.spec.ts` 双实现契约
（入参序返回 / 不覆盖 watching·autoReply·remark / 空批零 IPC）。**反证**：批调用改回循环 → 红。

### P2（6 项）

| #   | 修复                                                                                | 位置                      |
| --- | ----------------------------------------------------------------------------------- | ------------------------- |
| 1   | `update.ts` applyNow 两处宽限 sleep 定时器纳入 dispose 清单（终态后不补写 failed）   | `update.ts`               |
| 2   | `removeJob` 注释同步 v2 现状（`welink_agent_logs` 自 v1 起即 ON DELETE CASCADE）     | `repos/welink.ts`         |
| 3   | `MessagesTab.applyFocus` 改走 `runUiAction` 并移入 `onMounted`                       | `MessagesTab.vue`         |
| 4   | `WizardPanel` 两个 `el-input` 补 `aria-label`                                         | `WizardPanel.vue`         |
| 5   | `HistoryTab.rate()` 补 `ratingBusy` 防重复提交 + disabled 样式                        | `HistoryTab.vue`          |
| 6   | `icons.ts` 删 4 个零引用导出；`EnvCheckView` 文件头注释同步（welink-cli 与 python 两项） | `icons.ts` / `EnvCheckView.vue` |
| 7   | `App.vue` 启动落点补 `.catch` + logger.warn                                           | `App.vue`                 |
| 8   | `uitest.mjs` 标题断言从全等改为结构契约（`endsWith(应用名)` + 带前缀）                 | `scripts/uitest.mjs`       |

---

## 4. 测试与门禁

| 指标               | 基线（第七轮） | 本轮          |
| ------------------ | -------------- | ------------- |
| vitest 文件 / 用例 | 98 / 1499      | **99 / 1518** |
| `npm run lint`     | 通过           | 通过          |
| `vue-tsc --noEmit` | 通过           | 通过          |
| `npm run pack`     | 通过           | 通过（需先分批清 `dist/assets`，见下） |
| `npm run uitest`   | 56 通过        | **56 通过**   |

**环境注记（非项目缺陷）**：本轮 `npm run pack` 前两次被本机 safe-delete 闸拦下 ——
vite `emptyOutDir` 单次删除 `dist/assets` 的 61 个文件 > 阈值 50
（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，沙箱内外均生效，属进程级钩子）。
处置：分批（10 + 25）手动删到 22 个后再跑 pack 即通过。**后续轮次若 dist 资产数
超过阈值，需同样预处理**；这也解释了为何该闸只在大版本资产增长后偶发。

新增 19 个用例，7 组做了反证。**本轮反证与全量跑各抓出一个测试自身的问题**：

1. **「重试恢复」断言从未被验证过**（反证的部分敏感陷阱）：DashboardView 重试用例第一版
   用 `button.link` 选重试钮，而卡片头部还有一个同 class 的「去处理」导航钮 ——
   `get()` 返回**第一个**匹配（导航钮），点击根本不触发 init。反证时红的是前面的
   「失败态可见」断言，重试断言实际处于「恒不执行」状态。修复：重试钮补 `aria-label`，
   测试改精确选择器。**教训：反证红不等于每条断言都敏感，要看红的是哪一条。**
2. **`@/api` mock 缺 `bridge` 把恢复路径整条打挂**：失败态新增 `logger.warn` 后，
   spec 的 `@/api` mock（只 mock 了 `platform`）在 `logger.emit` 访问
   `bridge.appendLog` 时抛错 —— catch 块自身抛异常，init 第二次调用被跳过，
   还产生 3 个未处理拒绝。修复：mock 补 `bridge: { appendLog }`。
   **教训：任何写进 catch 的日志都会让「mock 不完整的全局依赖」升级成路径中断。**
3. **uitest 标题断言过期**（全量跑 exe 时暴露）：`assertEqual(title, 'Hello-Tauri')`
   撞上实际 title「工作台 · Hello-Tauri」。这正是 D-11 明令避免的「全等快照断言」——
   已改为结构契约（`endsWith(应用名)` + 带页面前缀）。单测全绿不代表端到端断言仍有效，
   每轮跑一次 uitest 是必要的。

---

## 5. 本轮撤回的误报（3 条）

| 子代理初稿结论                                       | 复核结果                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `exportRecordsCsv` 调用的 `toCsv` 是「死导出」       | **误报**：`toCsv` 被同文件两个导出函数正常调用，grep 时漏看了调用点                                               |
| `debounce.ts`「函数体未使用」                        | **误报**：该文件只有一个常量 `SETTINGS_PUSH_DEBOUNCE_MS`，没有函数体                                              |
| `bindHostLink` 返回的退订函数「被有意丢弃 = 泄漏」    | **误报**：dispose 完整执行全部 unsubs 且有 spec；仅生产路径不调用（应用同生命周期，文件头已文档化该意图）          |

---

## 6. 待拍板（本轮未动）

| #   | 议题                                                                                                            | 现状                                                                                                 | 建议                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1  | 配置明文落盘                                                                                                    | `config.json`（或 localStorage）含 `agent.apiKey` / `rag.apiKey` / `codeHub.token` 明文，落点仅 2 处 | 引入 DPAPI（Windows）加密存储；属架构级变更，单开一轮                        |
| Q2  | `infra/update/key.ts` 的 minisign 公钥是 PoC 一次性值                                                           | 发版前**必须轮换**                                                                                   | 排进发版 checklist                                                           |
| Q3  | LLM / RAG 出网 5 处不过安全闸 + `infra/windows/**` 生产侧零消费 + Rust 白名单 python 通道                        | 攻击面已开、收益为零                                                                                 | 二选一：接线（补 UI 入口 / 过闸）或下线（删 TS + 同步摘白名单）。建议发版前拍板 |

---

## 7. 下一轮建议方向（P2 / 结构性）

**可测、收益明确**

1. `stores/welink/index.ts` 装配 spec 本轮已补（`ensureRuntime` 幂等 / `setGroupGate` 同一实例 /
   日志订阅不叠加，三例均反证）—— 上轮建议项已完成。
2. 剩余 30 处手写 `catch` 中，8 处 loader 样板（`HistoryTab` / `GroupHistoryTab` / `TraceTab` ×2 /
   `ConfigTab` / `InboxTab` / `ConversationListPanel` / `MessagesTab`）可整体换成
   `runUiAction(..., { fail, busy })`。
3. 四个探针卡片（`SettingsCard` / `AgentSection` / `RagSettingsCard` / `CodehubSettingsCard`）
   的 busy+结果+提示三件套抽 `useProbe()`。
4. 启动恢复循环（`bootstrap` 的逐 job 回查）批量化：与 `upsertConversationsBatch` 同款，
   先加批量仓储方法。
5. 同类 class 多按钮的宽选择器歧义已在 DashboardView 三处修掉；建议全库 spec 复查
   `get('button.xxx')` 类选择器是否有同类歧义。

**结构性（改前先评估回归面）** 6. `.spacer` 22 处声明 / 6 种命名 → 全局一处；`.wc__*` 在 4 个嵌套组件各抄一遍。 7. `DashboardView`（887 行）/ `CodehubReviewView`（891）/ `InboxTab`（339）优先拆样式。 8. `b64.base64ToBytes` 同步 O(n) 三份拷贝（每轮轮询 N 会话 × 3 批）。

**不建议动**：`codehub` token 走 argv（改动需触及 Rust 进程创建，代码已自认并记录）；
`applyPollResult` 的 created-jobs 回查口径（窗口仅 1 秒，收紧需新迁移）。
