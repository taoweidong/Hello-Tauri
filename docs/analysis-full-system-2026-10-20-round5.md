# Hello-Tauri 全量分析（第五轮）：静默失效收尾与沉淀域清理补链（2026-10-20/21）

> **范围**：按既定节奏做第五轮全量分析 —— 两个并行子代理（UI 呈现层 / 业务架构层）
> 全量勘察，交叉比对后落地修复，再跑全量门禁。
> **明确不做**：S7（UI 组件抽取）、S10（大文件拆分）、Q1（密钥落盘加密）、
> Q2（发版前轮换更新公钥）—— 均维持上轮结论（见 §5）。
> **边界**：未改 Rust；新增一条索引迁移（v11）；未触碰覆盖率阈值。

## 0. 结论摘要

| 项                   | 结果                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 门禁 `npm run check` | lint 0 问题 / `vue-tsc` 无错 / **97 文件 · 1461 用例全绿**（上轮 96 · 1443）                                               |
| 覆盖率（lines）      | `orchestrator` **96.75%**（门槛 92）/ `infra/db` **90.54%**（门槛 72）/ `infra/windows` **98.02%**（门槛 90）/ 全仓 71.58% |
| 新迁移               | **v11** `idx_slog_created_at`（沉淀留痕的 `created_at` 索引）                                                              |
| 修复                 | 3 个 P0 + 9 个 P1（详见 §2），另有 1 项「勘察发现已收口」的纠偏                                                            |
| 提交                 | 见 §6                                                                                                                      |

三个最值得说的：

1. **修掉「接口写好了但没人调用」的第三次复现**：`sediment_logs` 的清理入口
   `clearSedimentLogs()` 从 v6 起无人调用，实现还是无 `LIMIT` 的全表 `DELETE`，
   且该表**四轮补索引都绕过了它**。本轮改成按时间分批 + 接进 `retention` 清理链
   - v11 补索引 —— 这是本项目第三次撞上「清理缺的不是实现，是调度」。
2. **密钥遮蔽从「日志出口」扩到「落点」**：`registerSecret` 只管日志，而
   `last_error` 是**持久化留痕**（网关 4xx 回显请求信息时会带密钥），日志看不见、
   库里躺着。`maskSecrets` 导出后同时接入 SQLite 与内存两个实现，契约测试双侧断言。
3. **生成段异常不再把 job 永久留在 `discussing`**：任何一步抛错（路由/取上下文/
   落草稿）都走与「生成失败」同一套预算与终态，而不是只 `logger.error` 后消失。

## 1. 起点与勘察口径

- 工作区干净（`main` 与 `origin/main` 同步，无并发编辑 —— 跑前用
  `find src docs -newermt "-5 minutes"` 复核）。
- 两个 Explore 子代理并行：UI 层（35 个 `.vue` + 8 个 view）与架构层
  （orchestrator 14 文件 / infra 7 端口 / migrations v1–v10 / stores）。
- 两路互不共享结论，交叉比对后按 P0 → P1 → P2 排序落地。

**已收口、不再重复报告**（复核确认）：v9 索引生效、公告 3N→3、详情死键、
`flush()` 停止语义、v10 三条 `finished_at` 谓词、UI 直触 `@/infra`（0 处）、
`type="link"`（0 处）、语义色全 token 化、焦点环全局兜底、`size` 由
`ElConfigProvider` 收口、Windows 命令白名单双侧对齐、外发两条路径均过闸。

## 2. 本轮修复

### 2.1 P0：`sediment_logs` 无界增长（接口在、无调度、无索引、全表删）

四重问题叠加，任何单独一条都不致命，合在一起是「只增不减」：

| #   | 问题                         | 证据                                                                                             |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | 清理能力写好了但**无人调用** | `grep clearSedimentLogs` 只命中接口 + 2 个实现，`retention.doRun()` 不含它                       |
| 2   | 实现本身不合用               | `DELETE FROM sediment_logs` 全表、无 `LIMIT` —— 几万行库上一次删完会长时间独占 SQLite 全局 Mutex |
| 3   | 表无任何索引                 | v6 建表未建，v7/v8/v9/v10 四轮补索引都没补到它                                                   |
| 4   | 单位体积最大                 | 每轮提取写一条 **prompt（≤8000 字）+ response**，单条 10 KB 量级，远超消息/语料                  |

修复三件套：

- `SedimentRepository.clearSedimentLogs()` → `purgeSedimentLogsBefore(cutoff, batch)`
  （与 `purgeAgentLogsBefore` 同构：子查询 + `LIMIT`，**不写 `ORDER BY id`**）；
- **migration v11** `idx_slog_created_at`，用 `IF NOT EXISTS`；
- 接进 `retention` 清理链：新增 `sedimentLogs` 计数与 `SEDIMENT_LOG_KEEP_DAYS = 30`
  （比语料 90 天短是刻意的 —— 它唯一用途是排障回看）。

契约测试三档语义（不过期不删 / `batch=1` 只删一条 / 剩余清干净），单测另加
「与消息/语料同轮清理、保留期独立」「删到收敛进报告与日志」「清理抛错不拖垮整轮」。

### 2.2 P0：密钥脱敏只覆盖日志出口，没覆盖落库

| 位置                                    | 修复前                                                                  | 修复后                                                                           |
| --------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `repos/welink.ts::recordAttemptFailure` | `error.slice(0, 500)` —— 网关 4xx 回显请求信息时密钥原样进 `last_error` | `maskSecrets(error).slice(0, 500)`（先遮蔽再截断，防截断把密钥切碎导致替换不掉） |
| `repos/welink-memory.ts`                | 同左                                                                    | 同左（双实现契约一致）                                                           |

`utils/logger.ts` 导出 `maskSecrets`，与日志出口共用同一张遮蔽表。三处断言：
SQLite 侧（`welink.spec.ts`）、双实现契约侧（`welink-contract.spec.ts`）、
遮蔽函数本身（`logger.spec.ts`）。

> 旁证：CodeHub 侧早有落库脱敏（`infra/codehub/exec.ts::redactToken`），
> WeLink 侧是漏的 —— 两侧不对称本身就是「这条路该有闸」的证明。

### 2.3 P0：生成段异常把 job 永久留在 `discussing`

```ts
// 修复前（pipeline.ts flush 段）
const task = generateOne(jobPk).catch((error) => {
  logger.error(`生成段异常（job ${jobPk}）`, error) // 只记日志
})
```

`generateOne` 里技能路由、取会话上下文、取触发消息、`commitDraft`、`holdJob`
**任何一步抛错**都会走到这里：job 停在 `discussing`，既不在 `generateQueue`
也不在 `sendQueue`，本会话内再也无人处理，界面却一直显示「生成中」——
用户只有重启才看得到变化（靠 bootstrap 的 `discussing` 分支救回）。

修复：抽 `reportGenerateFailure(jobPk, attemptsBase, failure)` 供两条路径共用；
新增 `abortGenerate` 兜底（读 job 失败时按 0 起算，宁可多给一次重试也不在库抖时
静默判死；兜底自身失败只告警、**不重新抛出**）。新增 4 条反证用例。

### 2.4 P1：人工重发的外发预算被旧计数吃光

`requeueJob` 的 SET 列表没有 `attempts = 0`：

- 外发失败 3 次的 job（attempts=3, status=failed）→ 用户点「重发」→ `ready`，attempts 仍 3；
- 下一次外发失败 → `attempts=4`，`4 < MAX_SEND_ATTEMPTS(3)` 为假 → 直接判 `failed`；
- UI 文案「发送重试 4 次耗尽」—— 数字与用户刚经历的次数也对不上。

而「上一条就是发送失败」恰恰是用户会点重发的**唯一场景**，即这条路径在最该
生效时必然失效。修复：SQLite 与内存两侧同时补 `attempts = 0`（与 `commitDraft`
的两段预算是同一口径），契约测试断言两侧 `attemptsBefore=2 → attemptsAfter=0`。

### 2.5 UI 层：一处真 P0 + 一批一致性与可达性

| 位置                                            | 问题                                                                                                                            | 修复                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `TimelinePanel.vue:49`                          | 「加载更早的消息」是模板内裸调 store 异步方法，store 只 `finally` 不 `catch` → 未处理拒绝 + 界面零反馈 + 按钮不复位（连点无效） | 走 `runUiAction` + `busy` + 加载中文案；新增 5 条组件用例（这是全项目最后一处漏网点）        |
| `HistoryTab.copyDraft` / `TraceTab.copy`        | **假成功**：先弹「已复制」再 `void writeText`，剪贴板被拒时既静默失败又留未处理拒绝                                             | 改 `bridge.clipboardWrite`（永不 reject 的结果对象语义），`failOnFalse` 把 `ok:false` 当失败 |
| `DashboardView` 9 处 + `CodehubReviewView` 1 处 | 模板内裸 `router.push`，重复导航 reject → 未处理拒绝                                                                            | 统一 `go()` 出口（后者本来就有，只是漏了一处）                                               |
| 11 个过滤控件                                   | 只有 placeholder 没有 `aria-label`（上轮只补了一半）                                                                            | 全量补齐（回复历史 5 / 收件箱 2 / 建群历史 4）                                               |
| `TableCrudView` 删除                            | 文件头注释写「工具条三个动作的繁忙态」却只定义了两个 ref —— **批量删除无 busy**，连点重复提交                                   | 补 `removing`，单条/批量都接入；`runUiAction` 收口                                           |
| `KnowledgeCard` 下架/拒绝、`ConfigTab` 批量开关 | 有失败出口但无 `:loading`，连点会报「已被评审过」/把「关」又刷成「开」                                                          | 补 `offShelving` / `rejecting` / `batching`                                                  |
| `CodehubReviewView`                             | 左栏显示「共 N 条」而列表最多 200 条 —— **UI 数字与内容自相矛盾**（日志 warn 只有开发者看得见）                                 | 加 `truncated` 计算属性 + 列表上方醒目提示                                                   |

> 纠偏：勘察把 `UpdateSettingsCard` 的「检查更新/下载安装」列为缺 busy，复核
> **不成立** —— 两处已绑定 `status.state === 'checking'/'downloading'` 与
> `updateStore.busy`，无需改动。勘察结论必须复核，不能照单全收。

### 2.6 分层闸门补洞：`@/orchestrator`

`eslint.config.mjs` 的分层闸门此前只禁 `@/infra` / `@/repositories`，
于是 `CreateTab.vue` 长期直触 `@/orchestrator/group`（与「UI 直触 infra」同性质的洞）。

- `stores/group.ts` 转出 `validateGroupDraft` / `GroupGateError`（UI 真正需要的两个符号）；
- 闸门 `patterns` 补 `@/orchestrator` / `@/orchestrator/**`；
- `**/*.spec.ts` 显式放开该规则（用例要直触编排层类型，走 store 转一层反而测不到真契约；
  `CodehubReviewView.spec.ts` 就 import 了 `@/orchestrator/events` 的类型）。

## 3. 测试与门禁

| 门禁        | 命令                                                      | 结果                                                                                                      |
| ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 静态 + 单测 | `npm run check`                                           | lint 0 问题；`vue-tsc` 无错；**97 files / 1461 tests passed**                                             |
| 覆盖率      | `vitest run --coverage`（`coverage-tmp`，规避沙箱清理闸） | 全仓 71.58%；`orchestrator` 96.75% / `infra/db` 90.54% / `infra/windows` 98.02%，**三条阈值全部高于基线** |

本轮新增/强化的测试锚点：

| 文件                          | 钉住什么                                                               |
| ----------------------------- | ---------------------------------------------------------------------- |
| `pipeline.spec.ts`            | 生成段异常必须回写状态（4 条：未耗尽 / 耗尽 / 读 job 也失败 / 隔离性） |
| `retention.spec.ts`           | 沉淀留痕进清理链、保留期独立 30 天、删到收敛、抛错续排                 |
| `welink.spec.ts`              | `requeueJob` 归零 attempts；`last_error` 落库即遮蔽                    |
| `welink-contract.spec.ts`     | 双实现一致：requeue 归零 + 遮蔽（仿真器新增两个 UPDATE 分支）          |
| `logger.spec.ts`              | `maskSecrets` 三档语义（单值 / 多值 / 空表）                           |
| `TimelinePanel.spec.ts`（新） | 失败必提示、busy 复位、在飞文案、无更多不渲染、内联状态条跳转          |

口径纪律沿用上轮：所有改动**先写/看反证用例再落地**；覆盖率阈值未动、未跳过任何用例。

## 4. 未做与后续建议

1. **S7 UI 模板重复**：`confirmDanger()` 是最值得抽的一处（18 处 confirm / 14 处逐字
   重复的 cancel 分支），会同时统一危险按钮样式；EmptyState/CardPanel 次之。仍建议
   单独一轮 + 截图对照，不与缺陷修复混做。
2. **S10 大文件**：`CodehubReviewView`(869)/`DashboardView`(777)/`HistoryTab`(730)/
   `ConfigTab`(681)/`TraceTab`(665)。前两个主要是 `<style scoped>` 体积（442 / 480 行），
   **优先拆样式而非拆逻辑**。
3. **无 spec 的 UI 文件（21 个）**：按风险排序最该补的是 `HistoryTab`（唯一人工外发通道
   `confirmEdit` 失败路径全无断言）、`ConfigTab`（`batchAutoReply` 一次改 N 个外发开关）、
   `WeLinkView`（乐观更新 + 失败回滚无人盯）、`TraceTab`（导出/清理两个不可逆动作）。
4. **两处 N+1 IPC**（本轮未动，改动面 2–3 文件）：`bootstrap` 安全闸预热（2N 次串行）、
   `syncConversations` 逐条 upsert（2N 次串行）。两者都需要**先加批量仓储方法**。
5. **`welink_announcements` 未纳入保留期清理**：与 `sediment_logs` 同病但轻（条目数有界，
   `ann_uid` 幂等），可作下一轮顺带项。
6. **P2 项**（未动，均为局部小改）：`generateRetries` Map 只 set 不 delete；
   `manualOverride` 三条早退路径泄漏；`convStates` 无淘汰；`scheduleRetry` 的
   `if (retryGenerate.length)` 死代码；`insertAgentLog` 回读结果被 `void` 丢弃。
7. **Q1 / Q2 维持待拍板**：密钥明文落盘（建议 DPAPI）、发版前轮换 `infra/update/key.ts`
   的 PoC 一次性公钥。后者是发布流程动作，需与发版规程一起演练。

## 5. 验证口径

- 单测环境：Vitest + happy-dom，`src/**/*.spec.ts`；Node ≥ 22.5。
- 覆盖率在沙箱里跑不完（`rm -rf coverage/` 撞安全删除闸），改用
  `--coverage.reportsDirectory=coverage-tmp --coverage.clean=false` 后读
  `coverage-summary.json` 自行聚合；产物已清理、未入库。
- 本轮未调整任何阈值，未跳过/放宽任何用例；所有 DB 相关结论均来自真实仓储 SQL 的
  `EXPLAIN QUERY PLAN` 或契约测试实测，不依赖注释推断。
