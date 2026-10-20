# Hello-Tauri 全量分析（第四轮）：增量优化收口（2026-10-20）

> **范围**：按拍板结果执行 A–F —— 收口上一轮遗留的未提交工作、修复 v9 索引未生效、
> S9 IPC 批量化、静默失效扫尾、a11y 与小项打磨、报告与全量验证。
> **明确不做**：S7（UI 组件抽取）、S10（大文件拆分）、Q1（密钥落盘加密）、
> Q2（更新公钥轮换；发布期动作）。
> **边界**：未改 Rust、无表结构变更（仅新增两条索引迁移）、未提交 git。

## 0. 结论摘要

- 全量门禁通过：`npm run check` = lint + typecheck + **96 个测试文件 / 1438 条用例全绿**。
- 覆盖率基线守住：`orchestrator/**` 96.78% lines（门槛 92%），`infra/db/**` 80.39% lines（门槛 72%）。
- 修掉一个**「索引建了但完全没被用上」**的隐性性能缺陷：`ORDER BY id` 让 SQLite 选择
  rowid 全表扫描，v9 的时间索引形同虚设；改为以**真实 DELETE SQL 的 EXPLAIN** 钉住计划。
- 修掉公告落库的 IPC N+1：`applyAnnouncements` 从 **3N 次桥调用降为固定 3 次**，
  且批内重复 `ann_uid` 仍保持幂等。
- 扫清剩余的静默失效：沉淀卡装载、快速建群 init 失败现在都可见/留痕；
  控制条五个动作补齐共用 busy 与失败回滚（开关不再停在「假已启动」）。
- 补齐一类可测性缺口：`RagError`、内联图标系统、快速建群页、消息中心左栏、沉淀卡装载
  均有直连用例（含反证）。

## 1. 起点：上一轮遗留的未提交工作

本轮开始时工作区已存在一整组连贯改动（S2/S4/S6/S8 的续作）。它们不是可丢弃的
半成品，而是上一轮路线的落地部分，本轮**先校验、补测试、修其中未生效的项**，再继续加码：

| 主题                       | 关键改动                                                                                       | 语义                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| UI 动作统一出口（S6）      | `src/utils/ui-action.ts` 增加 `failOnFalse` 与行内 `error` 出口；14 个 `.vue`、56 处调用点接入 | 失败必提示；busy 与失败提示成对；store 的「返回布尔」语义可显式当失败 |
| 控制条防重入               | `WeLinkView` 五个动作共用 `actionBusy`，启动失败回滚开关与持久层                               | 消除「界面显示已启动、实际没跑」的静默不一致                          |
| 生成/外发预算隔离（S8）    | `commitDraft` 同条 UPDATE 写 `attempts = 0`（SQLite + 内存双侧）                               | 生成阶段的重试不再吃掉外发阶段预算                                    |
| 触发消息读取失败不猜（S4） | `pipeline` 不再 `.catch(() => null)`，改为按发送失败计数重试/终止                              | DB 抖动不再让安全闸的发送者限流静默失效                               |
| 启动恢复单条降级           | `bootstrap` 单条 `markStatus` 失败只 warn，不拖垮整轮恢复                                      | 一个坏 job 不再让重启后助手整体不动                                   |
| 沉淀留痕与熔断计数         | `knowledge-harvester` 写失败从静默改为 warn/报告                                               | 审计链与连续失败熔断不再无声断裂                                      |
| 会话与清理索引（v8/v9）    | `welink_conversations` 两条读路径索引；消息/语料的时间清理索引                                 | 7×24 常驻的轮询与保留期清理不再全表扫                                 |

## 2. 本轮修复

### 2.1 v9 索引「建了但没生效」

新增的 v9 迁移本身正确，但两条清理 SQL 的子查询里带着 `ORDER BY id`：

```sql
-- 修复前
SELECT m.id FROM welink_messages m
 WHERE m.sent_at < ?1 AND NOT EXISTS (...)
 ORDER BY m.id LIMIT ?2
```

`id` 是 `INTEGER PRIMARY KEY`（rowid 别名）。SQLite 为省掉排序，**主动放弃时间索引**、
改为按 rowid 全表扫描 —— 实测 `EXPLAIN QUERY PLAN` 为 `SCAN m`，v9 的
`idx_wm_sent_at` 完全用不上。分批顺序没有业务语义（调度器循环到返回 0 为止），因此：

- 去掉两处 `ORDER BY id`，计划变为 `SEARCH m USING COVERING INDEX idx_wm_sent_at`
  与 `SEARCH welink_agent_logs USING COVERING INDEX idx_wal_created_at`；
- 测试不再断言「SQL 文本里有没有索引」，而是捕获仓储**实际下发的 DELETE SQL** 并
  `EXPLAIN QUERY PLAN`（见 `src/infra/db/repos/welink-sqlite-integration.spec.ts`）。
  第一版测试用简化 SELECT 曾「立即变绿」，证明不了生产 SQL，已废弃重写。

v8 的两条索引也在真实仓储 SQL 上复核：`listWatching` 走
`idx_wc_watching`（COVERING），会话列表排序走 `idx_wc_type_last`，均确认生效。

### 2.2 公告落库的 IPC N+1（S9）

`applyAnnouncements` 原先逐条执行「查会话 → INSERT → 回读」，N 条公告要 **3N 次 IPC**。
改为固定三段：

1. 一次 `SELECT ... WHERE conv_id IN (...)` 解析会话主键；
2. 一次 `dbTransaction` 批量 `INSERT OR IGNORE`；
3. 一次 `SELECT ... WHERE ann_uid IN (...)` 回读新增行。

用 `changes[index] > 0` 判定「真正新增」，批内重复 `ann_uid` 仍幂等；返回顺序保持
首次插入序。测试同时钉住 IPC 次数与公告条数无关（12 条公告：1 transaction + 2 select +
0 execute），并修正了测试替身的保真度：`dbTransaction` 的宿主语义是**各语句受影响行数**，
不是 lastInsertRowid。

### 2.3 静默失效扫尾

| 位置                          | 修复前                                        | 修复后                                                                    |
| ----------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `SedimentCard` 挂载           | 会话清单/日志装载 `.catch(() => undefined)`   | `runUiAction` 提示失败原因（「白名单空了/日志没了」不再被误读为数据丢失） |
| `GroupView.runInit`           | 裸 `await store.init()`，拒绝时页头停在无错误 | try/catch → 既有可重试告警 + `logger.error`，两种失败形态都可见           |
| `SettingsView.applyAutostart` | 复核结论：**无需改动**                        | `bridge` 的 `probe` 永不 reject；`ok:false` 已有可见提示且 store 回滚开关 |
| `SkillsSection.loadDocs`      | 静默失败（有意的降级：候选文档为空）          | 保持原语义，注释已说明「不挡技能编辑」；未额外制造噪声提示                |

新增用例（均先看红再实现）：沉淀卡「装载失败必须提示」、快速建群「init 拒绝仍出告警并留痕」；
消息中心左栏与其余若干 UI 动作的失败/可达性契约由既有 S6 用例覆盖。

### 2.4 可达性与一致性（a11y）

- 消息中心左栏行内「更多」原为纯 `<span @click>`：鼠标能点、键盘永远够不到。由于外层
  会话行已是 `<button>`（HTML 不允许嵌套），改为 `role="button" + tabindex="0" +
aria-label`，Enter/Space 转发为 click 交给 `el-dropdown`；补 `:focus-visible` 焦点环。
- 过滤控件补可读名称：监控会话过滤框、表格搜索/分类、监控配置类型、调用轨迹状态与
  起止日期。仅靠 placeholder 不足以让读屏识别。
- `EnvCheckView` 去掉两处非空断言，改为一次 `computed` 取值（模板内的 `v-if` 窄化
  不跨访问）。
- 六张设置卡的防抖节奏收成 `SETTINGS_PUSH_DEBOUNCE_MS = 300`（`src/utils/debounce.ts`），
  避免各卡各自漂移。
- 内联图标的 `size` prop 原先「声明了但从未消费」——传了也没用。现在显式传入时
  落到 SVG 宽高，缺省仍是 `1em` 跟随字号。

## 3. 测试与门禁

| 门禁        | 命令                               | 结果                                                                              |
| ----------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| 静态 + 单测 | `npm run check`                    | lint 0 问题；`vue-tsc` 无错；**96 files / 1443 tests passed**                     |
| 覆盖率      | `npm run test:coverage`            | 总 lines 71.13%；`orchestrator` 96.78%（门槛 92%）；`infra/db` 80.39%（门槛 72%） |
| 格式        | `prettier --check`（本轮触及文件） | 通过                                                                              |

本轮新增/强化的测试锚点：

- `src/infra/db/repos/welink-sqlite-integration.spec.ts`：两条清理 DELETE 的真实执行计划。
- `src/infra/db/repos/sediment-contract.spec.ts`：公告批量 IPC 次数与批内幂等。
- `src/infra/db/welink.spec.ts`：清理 SQL 断言 `LIMIT` 且**不含 `ORDER BY`**。
- `src/components/welink/SedimentCard.spec.ts`：装载成功不提示、失败必须提示。
- `src/views/GroupView.spec.ts`：init 成功/拒绝两种路径。
- `src/components/welink/messages/ConversationListPanel.spec.ts`：键盘可达与过滤框名称。
- `src/infra/rag/port.spec.ts`：`RagError` 分类与 `cause` 保留。
- `src/components/icons.spec.ts`：SVG 契约、动态缓存、`size` 生效。
- `src/orchestrator/codehub-detail.spec.ts`：快照读失败不留死键（见 §6.1）。
- `src/orchestrator/pipeline.spec.ts`：`stop()` 落在外发 await 期间不再继续消费队列（§6.2）。

## 4. 未做与后续建议

1. **S7 UI 模板重复**：EmptyState / CardPanel / StatusTag / confirmDanger 的抽取会触及大量
   视觉基线，建议单独一轮并以截图对照验收，不与缺陷修复混做。
2. **S10 大文件**：仍集中在 `WeLinkView`、`CodehubReviewView`、`SettingsView` 等视图与
   若干仓储文件；拆分前先补页面级契约测试，否则「纯搬代码」也会丢行为。
3. **Q1 密钥落盘**：当前 API Key 只在本机数据根 `config.json`，威胁模型是「拿到磁盘」；
   若要升级，优先 DPAPI（Windows 原生、无新依赖）而非自研加密。
4. **Q2 更新公钥轮换**：这是发布流程动作（新私钥签新清单 + 客户端换内置公钥），
   需与发布规程一起演练，避免「发出去的新版再也更不动」。
5. **视图覆盖率仍低**（`src/views` 40.05%）：当前阈值只护 `orchestrator` 与 `infra/db`，
   属有意选择。若要抬线，按页面补「失败态/空态/重试」用例，不要用快照凑数。
6. **`SkillsSection.loadDocs` 的静默降级**是唯一保留的「静默」：候选列表为空不影响
   技能编辑本身。若后续该列表承担「必选知识文档」语义，需改为可见失败。

## 5. 验证口径

- 单测环境：Vitest + happy-dom，`src/**/*.spec.ts`；Node ≥ 22.5。
- 覆盖率阈值是防回退基线而非目标；本轮未调整任何阈值，也未跳过/放宽任何用例。
- 本轮所有涉 DB 查询计划的结论均来自 `node:sqlite` 实测 `EXPLAIN QUERY PLAN`，
  不依赖注释或推断。

## 6. 复核追加（独立勘察后的补强）

本轮报告定稿后又做了一次独立的全量勘察（UI 层与架构层各一路，互不共享结论），
交叉比对后追加三项。三项都遵循同一条纪律：**先提交反证用例（确认红），再改实现**。

### 6.1 `codehub-detail`：快照读失败会留下「死键」（P0，静默失效）

`run()` 把 `repo.getMr()` 写在 `try` **之外**，它的 `finally` 只包住补拉段。于是
快照读一抛（DB 抖动 / 库被锁）：

- `finally` 不执行 → 在飞表的键**永不删除**；
- 此后 `fetch()` 每次都复用同一个 rejected promise → 该 MR 的详情**永久加载不出**，
  且违反接口注释「永不 reject」。

修复：快照读移入 `try`，与补拉分开 `catch`（两者失败语义不同：读不到记录只能返回
`null`，补拉失败还有列表字段可降级），共用同一个 `finally` 清理在飞键。

### 6.2 `pipeline.flush()`：停止语义只在入口判了一次（P0，停止后仍外发）

外发段是 `await sendOne(...)` 之后 `continue` 回循环头的。`stop()` 只清定时器、
不清队列 —— 入口那次 `if (!running) return 0` 判过之后，用户在这一段 await 期间
按急停或关总开关，循环**照样继续消费 `sendQueue` 并继续外发**，与文件头
「停止后不再消费队列」的承诺直接矛盾（急停靠 Gate panic 兜住，普通 `stop()` 兜不住）。

修复：循环体每次迭代开头复检 `running`。

### 6.3 migration v10：`finished_at` 的三条热谓词（P1，性能）

安全闸预热（`countSentSince`，每个监控会话一次）与沉淀水位扫描（`listSentQaSince`）
都以 `finished_at` 为主谓词，而 v1–v9 **没有一条索引覆盖它**。

> 与 v9 那条「索引建了没生效」不同，这三条在 v9 为止**不是全表扫描**，而是
> 「定位到了但范围没收窄」：旧计划是 `idx_wrj_status(status=?)` 后把 `status='sent'`
> 的**全部**行过一遍再过滤时间，沉淀那条还要额外 `USE TEMP B-TREE` 排序。
> 结论同样来自实测 EXPLAIN，初稿注释写「全表扫描」是对不上的，已按实测改正。

新增 `idx_wrj_target_finished(target_id, finished_at)` 与
`idx_wrj_status_finished(status, finished_at)` 后，两条计数查询的范围收窄到
`finished_at>?`，水位扫描的排序步骤直接消失。断言**不钉具体哪条索引**（选谁是
代价估算的结果、不是契约），只钉「走了 v10 索引且范围收窄到 `finished_at`」。

### 6.4 复核后仍未关闭的项（不在本轮落地，供下一轮排序）

| 项                                                                 | 定级 | 为什么本轮不做                         |
| ------------------------------------------------------------------ | ---- | -------------------------------------- |
| `pipeline` 生成异常（路由/取上下文抛错）不回写状态，job 卡在 `discussing` | P0   | 需与「生成重试预算」一起改，改动面 2 文件 + 状态机回归 |
| 模型/检索两条出网通道未过安全闸（急停封消息但封不住把原文发给 LLM/RAG）   | P0   | 属安全语义变更，需拍板「是否要闸」再动   |
| 密钥脱敏只覆盖 logger 出口，未覆盖**落库**（`last_error` 可能回显网关错误串） | P0   | 需抽 `maskSecrets` 并逐处接入，单独一轮 |
| `CreateTab.vue` 直触 `@/orchestrator`（ESLint 未禁该路径，闸门有洞）    | P1   | 需先经 `stores/group.ts` 导出再改 import |
| CodeHub 列表超 200 条静默截断，UI 数字与内容自相矛盾                    | P1   | 需改分页或显式提示，属交互变更          |
