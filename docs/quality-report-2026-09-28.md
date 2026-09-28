# Hello-Tauri 代码质量报告

- 评估日期：2026-09-28
- 评估对象：`E:\GitHub\Hello-Tauri`（分支 `br_builder`，HEAD `ec30a39`）
- 技术栈：Tauri 2 + Vue 3 + TypeScript + Element Plus + Pinia + rusqlite
- 评估方式：全量源码通读 + 实测验证（typecheck / vitest / 产物与调用链核查）

---

## 0. 摘要

| 维度                 | 得分     | 判读                                                           |
| -------------------- | -------- | -------------------------------------------------------------- |
| 代码规范与可读性     | 90 / 100 | 优秀。严格 TS 配置、注释质量罕见地高；缺自动化风格门           |
| 模块划分与架构合理性 | 93 / 100 | 优秀。三层单向依赖 + 端口适配器 + 组合根，本报告最大亮点       |
| 潜在缺陷与风险控制   | 80 / 100 | 良好。状态机与防双发包得非常严；保留期与内容清洗有落地缺口     |
| 性能与资源占用       | 68 / 100 | 需改进。全量引入 + 主线程同步 SQL + 轮询双重惩罚               |
| 安全                 | 78 / 100 | 良好。无 XSS 注入面、无密钥、子进程白名单；CSP 与 SQL 边界偏松 |
| 测试覆盖与可维护性   | 82 / 100 | 良好。466 用例 + 双实现契约测试；无覆盖率、脚本硬编码重        |

**总体评分：82 / 100（良好，具备生产可用基础）**

结论先行：架构层面这是少见的「教科书级」实现 —— 宿主边界单一、依赖方向严格向下、编排状态机有原子性与防双发保证。扣分几乎全部集中在**工程化配套（lint / CI / 覆盖率）**、**前端体积**、**Rust 命令的线程模型一致性**与**几处「写了但没接上」的能力**（保留期清理、回复清洗）。这些都不是设计缺陷，而是收尾债务。

---

## 1. 评估范围与实测证据

### 1.1 规模

| 分区                               | 文件数     | 行数   |
| ---------------------------------- | ---------- | ------ |
| 前端源码（非测试，`.ts` / `.vue`） | 59         | 14 946 |
| 前端测试（`*.spec.ts`）            | 16         | 6 622  |
| Rust 源码（`src-tauri/src`）       | 8          | 1 007  |
| 构建与验证脚本（`scripts/`）       | 6          | 2 257  |
| 文档（`docs/`）                    | 4 + 本报告 | —      |

### 1.2 实测结果

| 检查项                           | 命令                                   | 结果                                                                                 |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| 类型检查                         | `npm run typecheck`                    | 通过（`vue-tsc --noEmit` 无输出）                                                    |
| 单元测试                         | `npm test`                             | **16 文件 / 466 用例全部通过**，耗时 10.55s                                          |
| ESLint / Prettier / EditorConfig | 仓库根目录检索                         | **不存在**（无任何 lint 配置）                                                       |
| CI                               | `.github/` 检索                        | **不存在**                                                                           |
| 覆盖率统计                       | `vitest.config.ts` / `package.json`    | **未配置**（无 coverage provider）                                                   |
| 危险 DOM 注入                    | `grep v-html\|innerHTML`               | 无（仅 `dangerouslyUseHTMLString: false`）                                           |
| 硬编码密钥                       | `grep token\|password\|apiKey\|secret` | 无                                                                                   |
| 前端产物体积                     | `dist/assets`                          | 主 chunk **1 057 298 B**（1.01 MB）/ CSS **374 726 B**（366 KB），`dist` 合计 1.7 MB |
| 单文件 exe 校验                  | `scripts/build.mjs` 的 PE 导入表断言   | 存在且为强制门（禁止 webview2loader / vcruntime / msvcp / api-ms-win-crt）           |

---

## 2. 代码规范与可读性

### 2.1 做得好的部分

| 项                               | 证据                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TS 严格度拉满                    | `tsconfig.json` 开启 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noImplicitOverride` + `verbatimModuleSyntax` + `isolatedModules`，且 `noEmit` 前置到 build                   |
| 类型逃逸几乎为零                 | 全量源码仅 **1 处** `any`（`src/views/TableCrudView.vue:231`），无 `@ts-ignore` / `@ts-expect-error`                                                                                    |
| 注释解释「为什么」而非「是什么」 | 例：`src/orchestrator/pipeline.ts:92-102` 解释 `retryGenerate` 为何不能直接推回 `generateQueue`（会抹掉退避延时）；`src/orchestrator/triggers.ts:81-88` 解释 `\b` 对 CJK 失效的真实缺陷 |
| 时间语义统一收口                 | `src/utils/time.ts` 全部本地时间戳，明确拒绝 `toISOString()` 的 UTC 陷阱；Rust 侧 `logging.rs:20-22` 为同一目标放弃 chrono 改用 `GetLocalTime`                                          |
| 编码容错有层次                   | `src/utils/b64.ts` 严格 UTF-8 → GBK → lossy 三级降级，且说明为何必须用 `fatal: true` 才有判据                                                                                           |
| 无 `console.log` 残留            | 全部经 `src/utils/logger.ts` 统一出口（控制台 + 宿主日志文件 + UI 旁路订阅）                                                                                                            |
| 命名一致                         | DB 列 `snake_case` / TS 字段 `camelCase`，映射集中在仓储层；展示文案抽成常量表（`JOB_STATUS_LABEL` / `SKIP_REASON_LABEL` / `HOLD_REASON_LABEL`）                                        |

### 2.2 改进项

| 编号 | 问题                                                                                                             | 证据                                                                 | 建议                                                                                                                                                                                                 | 优先级 |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R-1  | 无 ESLint / Prettier / EditorConfig，风格与坏味道完全依赖人工评审 + `vue-tsc`                                    | 仓库根无任何配置文件                                                 | 引入 ESLint 9 flat config（`typescript-eslint` + `eslint-plugin-vue`）+ Prettier + `.editorconfig`；起手可只开 `recommended` 与 `no-floating-promises`（本项目 `void xxx()` 用法很多，该规则价值高） | **P1** |
| R-2  | 唯一类型逃逸：`({ row }: any)`                                                                                   | `src/views/TableCrudView.vue:231`                                    | 用 `ElTable` 的行类型参数或显式 `RowClassName` 签名替代                                                                                                                                              | P3     |
| R-3  | 版本号双真值：`web.ts` 硬编码 `'0.1.0'`，`MainLayout.vue` 再兜底一次，需与 `package.json` 手工同步               | `src/api/web.ts:68`、`src/layouts/MainLayout.vue:82`                 | Vite `define: { __APP_VERSION__: JSON.stringify(pkg.version) }`，全局唯一来源                                                                                                                        | P2     |
| R-4  | 迁移 SQL 双真值：`records.ts` 与 `infra/db/index.ts` 各声明一份 `version 1 / create_records`（注释自称逐字一致） | `src/repositories/records.ts:51-65` vs `src/infra/db/index.ts:18-35` | 合并为单一 `MIGRATIONS` 注册表，`records.ts` 改为 import                                                                                                                                             | P2     |

---

## 3. 模块划分与架构合理性

### 3.1 架构评分：优秀（93/100）

依赖方向严格单向向下，且**每一层都有可替换契约**：

```
src/views, src/components/*.vue
        ↓
src/stores/{app,table,welink}.ts
        ↓
src/orchestrator/{runtime,bootstrap,poller,pipeline,safety-gate,triggers}
        ↓
src/infra/{db,welink,agent}          ← 端口接口 + 真实实现 + mock 实现
        ↓
src/api/{types,tauri,web}.ts         ← 唯一宿主边界（Bridge）
```

| 亮点             | 说明                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主边界唯一     | `src/api/types.ts` 定义唯一 `Bridge` 接口（16 个方法），前端**从不直接 `invoke()`**；`tauri.ts` / `web.ts` 双实现契约对齐，且 `src/api/index.spec.ts` + `web.spec.ts` 有契约测试                                            |
| 运行时自适应     | `src/api/index.ts` 以 `'__TAURI_INTERNALS__' in window` 探测，浏览器模式零 Rust 依赖即可调试全部页面                                                                                                                        |
| Rust 保持「哑」  | Rust 只提供通用能力（SQL 通道、文件通道、子进程白名单通道、存储布局解析），**业务 SQL 全在 TS**（`src/infra/db/repos/welink.ts`）。新增业务表 = 加迁移 + 写仓储，Rust 零改动                                                |
| 端口-适配器彻底  | `db/ports.ts` / `welink/port.ts` / `agent/port.ts` 定义接口，真实实现与 mock 并存；`welink-contract.spec.ts` 断言 **SQLite ⇄ 内存双实现语义等价**（这是很多项目会漏的关键测试）                                             |
| 组合根收口       | `src/orchestrator/runtime.ts` 单独承担装配与启停顺序（管线先起、轮询后起；停则相反），store 只调 `runtime.xxx()`，不知道 repo/端口如何构造                                                                                  |
| 单一外发出口     | `SafetyGate` 是唯一外发闸口，管线**无法绕开**；L0–L3 开关栈 + S1–S8 限流熔断，每一条被拦都以 `skipped` + `skip_reason` 落库留痕                                                                                             |
| 状态机原子性     | `commitDraft` 把 `draft` 与 `status='ready'` 写进**同一条 UPDATE**（避免「有草稿无状态」中间态）；`markSent` 在同事务内写 `sent` + 回写 out 消息 + 更新会话行；`markStatus(pk, 'sending', 'ready')` 作乐观锁                |
| 防双发链路完整   | 生成段失败不重试（避免覆盖人工编辑）、发送段**不做传输层重试**（`welink-cli.ts:57-59`）、失败重发前必查 `hasOutgoingReceipt`、崩溃恢复 `sending` 分支凭回执补记 `sent`                                                      |
| 配置入口收敛     | `normalizeWelinkSettings` 逐层兜底 + `clampNumber` 范围收窄 + `isClock` 格式校验，把「用户手改 JSON」的越界风险挡在入口                                                                                                     |
| 打包链以产物为准 | `scripts/build.mjs` 自解析 PE 导入表断言无 `webview2loader / vcruntime / msvcp / api-ms-win-crt`；并用 `cargo build --features tauri/custom-protocol --offline` 绕开 `tauri build` 注入 RUSTFLAGS 顶掉 `+crt-static` 的问题 |

### 3.2 改进项

| 编号 | 问题                                                                                                                       | 证据                                                                                     | 建议                                                                       | 优先级 |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ |
| A-1  | 侧栏导航项双真值：`MainLayout.vue` 硬编码 `navItems`，与 `router/index.ts` 的 `meta.title` 重复；`uitest.mjs` 又把清单写死 | `src/layouts/MainLayout.vue:15-21`、`src/router/index.ts:5-37`、`scripts/uitest.mjs:317` | 由路由表派生侧栏（在 `meta` 上加 `icon`/`order`/`hidden`），新增页面零改动 | P2     |
| A-2  | 双文件通道并存：`readTable/writeTable`（旧版 `table.json`）与 `fsRead/fsWrite` 语义重叠，前者只为升级数据源保留            | `src/api/types.ts:15-16` vs `:28-30`，唯一的 legacy 使用点在 `records.ts:94`             | 明确标注 `@deprecated` 并加「v1 数据迁移完成后可删」的移除条件             | P3     |
| A-3  | `agent_logs` 承诺「提供清理入口」但无自动过期；`purgeMessagesBefore`（180 天保留期）**没有任何调度调用**                   | `src/infra/db/ports.ts:138-141,292`；除仓储实现与测试外全仓库无调用点                    | 见 D-1                                                                     | **P1** |

---

## 4. 潜在缺陷与风险点

### 4.1 高优先级

| 编号 | 问题                                                                                                                                 | 根因与证据                                                                                                                                                                           | 影响                                                                                                                                                                                                               | 建议                                                                                                                                                                                                                                        | 优先级 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-1  | **消息保留期形同虚设**：`RETENTION_KEEP_DAYS = 180` 与 `PURGE_BATCH_SIZE = 500` 定义了、`purgeMessagesBefore` 实现了，但**无人调用** | `src/infra/db/ports.ts:138-141`；`repos/welink.ts:833` 实现；全仓库无调用点                                                                                                          | `welink_messages` 与 `welink_agent_logs` 无界增长。桌面长跑场景（每分钟一轮轮询）下消息表会持续膨胀，最终拖慢所有列表查询                                                                                          | 在 `runtime` 或 `bootstrap` 中挂一个**每日一次**的清理任务（复用现有 `TimerApi` 的 setTimeout 链，勿用 `setInterval`），循环调 `purgeMessagesBefore` 直到返回 0；同时为 `agent_logs` 定义同口径保留期（语料含完整聊天上下文，隐私上更敏感） | **P1** |
| D-2  | **回复清洗未接入真实路径**：`sanitizeReply`（去 ``` 包裹、"回复："前缀、整体引号、连续空行）只在 mock 里被调用                       | `src/infra/agent/prompt.ts:75` 定义；唯一调用点 `src/infra/agent/mock.ts:106`                                                                                                        | 真实 Agent（内网模型）习惯性输出 `` 包裹或 `回复：xxx` 前缀时，群里会看到「``」而不是一句话。这在真实对接首日就会暴露                                                                                              | 在 `pipeline.generateOne` 拿到 `draft` 后、`commitDraft` 之前调用 `sanitizeReply(draft)`；注意与 S6 草稿长度校验的顺序（先清洗再判长度）                                                                                                    | **P1** |
| D-3  | **Rust DB 命令仍走主线程**，与 `cli.rs` 自己确立的 D9 原则自相矛盾                                                                   | `src-tauri/src/db.rs:173-267` 四个命令都是同步 `#[tauri::command]`；而 `cli.rs:1-15,190-204` 专门注释说明「同步命令在 WebView 主线程执行会卡死 UI」并改成 `async` + `spawn_blocking` | `db_select` 承载 `listInbox` 的 JOIN + GROUP BY 聚合、`listJobs`（limit 500 + 双 LEFT JOIN）、`db_migrate` 的建表建索引批量执行 —— 数据量上来后直接阻塞 UI 线程（掉帧/白屏）。当前千级数据可容忍，属**阈值型风险** | 把四个 DB 命令统一改为 `pub async fn` + `spawn_blocking`（与 `cli_run` 同构），或至少先加「耗时 > 50ms 记 warn 日志」的观测，用数据决定何时升级                                                                                             | **P1** |
| D-4  | **轮询间隔被最差退避二次惩罚**                                                                                                       | `src/orchestrator/poller.ts:110-119`：`baseIntervalMs()` 取所有会话 `backoffSec` 的最大值参与 `Math.max`；而 `:156` 已经用 `state.nextAllowedAt > nowMs` 做了**会话级**退避          | 一个坏会话进入 60s 退避后，全部健康会话（本可 5s 一轮）被一起拖慢 12 倍。双保险变成了双惩罚，且失败会话越多整体越慢 —— 与「单会话失败不中断整轮」的设计初衷相悖                                                    | 移除 `baseIntervalMs` 中的 `worst` 项，让退避只在会话级生效；若担心空转，改为「有会话退避中则整轮间隔取 base 的 2 倍」这类有上界的折中                                                                                                      | **P1** |

### 4.2 中优先级

| 编号 | 问题                                                                                                        | 证据                                                                                                                                                        | 建议                                                                                                                                    | 优先级 |
| ---- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| D-5  | `listConversations(500, 0)` 硬编码上限；超过 500 个会话**静默截断**，`watchingConversations` 因此可能漏会话 | `src/stores/welink.ts:380`                                                                                                                                  | 提到了配置或改为分页加载 + 明确提示；至少把 500 提为常量并记一条 warn                                                                   | P2     |
| D-6  | `staggerMs` 默认 2000ms 与 `pollIntervalSec` 默认 5s 语义冲突                                               | `src/orchestrator/poller.ts:78`、`src/types/welink.ts:221`                                                                                                  | 20 个会话单轮需 ~40s，用户把 `pollIntervalSec` 调到 3s 也达不到预期。建议按「会话数 × stagger」动态收敛，或在设置页显式提示实际轮询周期 | P2     |
| D-7  | `noUserIdFused` 的解除分支不可达                                                                            | `src/orchestrator/safety-gate.ts:438` 判断 `scope === 'global'`，但 `sceneLabel` 域只有 `group_at_me / private / manual`，`'global'` 永不出现               | 删掉死分支，或让 UI 的「解除全局熔断」传 `'global'` 并与 `snapshot()` 的 `globalFuse` 口径对齐                                          | P3     |
| D-8  | `panic = "abort"` 下 Mutex 中毒恢复代码不可达                                                               | `src-tauri/Cargo.toml`（`panic = "abort"`）vs `src-tauri/src/db.rs:39,53` 的 `unwrap_or_else(\|poisoned\| poisoned.into_inner())` 与注释「中毒锁恢复…更稳」 | panic 直接 abort，中毒分支永不执行。注释会误导后续维护者，建议改为注释说明或直接 `.lock().expect()`                                     | P3     |
| D-9  | `logUnsubscribe` 声明后退订函数从不调用                                                                     | `src/stores/welink.ts:43,248-250`                                                                                                                           | 单例 store + `if (!logUnsubscribe)` 守卫使重复订阅不会发生，实际泄漏有限；但声明即承诺，建议在 `stop()` 或模块卸载路径调用一次          | P3     |
| D-10 | `bundle.targets: ["nsis"]` 在 `bundle.active: false` 下无效                                                 | `src-tauri/tauri.conf.json:29-31`                                                                                                                           | 保留会有「本项目会产安装包」的误导；建议删除 `targets` 并加一行注释说明只产裸 exe（内网离线打包的关键不变量）                           | P3     |
| D-11 | 脚本中的「界面快照」硬编码断言                                                                              | `scripts/uitest.mjs:317` 导航清单全等、`:378` Tab 顺序全等、`:846,851` `_migrations` 表存在性、`:766` 表格行数                                              | 每次改 UI 都必须回改脚本，漏改则阶段 6 误报失败（历史上已发生过）。建议把「全等字符串」改为「结构契约」：断言数量、必含集合、顺序单调性 | P2     |

### 4.3 边界与幂等性评估（结论：优秀）

以下高风险点已逐项核查，**均已有正确处理**，列此以供复核：

| 检查点                       | 结论                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 重复拉取同一批消息           | `msg_uid` UNIQUE + `INSERT OR IGNORE` + 批内 `Map` 去重 + `applyPollResult` 先查重，三重保险                                |
| 同一 job 被两个 worker 处理  | `markStatus(pk,'discussing','pending')` 与 `commitDraft` 的 `WHERE status='discussing'` 乐观锁                              |
| 发送成功但未记账（崩溃窗口） | `hasOutgoingReceipt` 按「同会话 + 同内容 out 消息」核对，命中则补记 `sent` 而非重发                                         |
| 分发过程中进程被杀           | `bootstrap` 三分支恢复（凭回执补记 / 无回执回落 ready / pending·discussing 重新入队），且 `failed` 刻意不自动重投（防滥发） |
| 自回复死循环                 | `filterSelf` 把自发消息改 `direction='out'` 而非丢弃（保留双向存档），`buildTriggerMap` 因 `out` 不建任务                   |
| `@所有人` 误判为 `@我了`     | `isAtAll` 用否定前瞻（注释记录了 `\b` 对 CJK 失效的真实缺陷）+ 适配器侧双重排除                                             |
| 跨小时配额归零               | `rollHour()` 懒重置（读时判断），`convStates` 与全局桶同源                                                                  |
| 配置越界                     | `normalizeWelinkSettings` + `clampNumber` + `isClock` 入口收敛                                                              |

---

## 5. 性能问题

| 编号 | 问题                                                                                  | 证据                                                                                                                            | 影响                                                                                                                                      | 建议                                                                                                                                                                                 | 优先级 |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| P-1  | **Element Plus 全量引入**                                                             | `src/main.ts:1-13` 全量 `use(ElementPlus)` + 全量 CSS；产物 `index-DVf5MWeH.js` = 1 057 298 B、`index-D1-DNYiP.css` = 374 726 B | 主 chunk 1.01 MB 需在每次冷启动时解析；与「轻量 Windows 桌面模板」的项目定位直接冲突（`chunkSizeWarningLimit` 已被放宽到 900 以掩盖告警） | 引入 `unplugin-vue-components` + `unplugin-auto-import` 做按需引入（可预期降到 1/3 量级）；同时配 `build.rollupOptions.output.manualChunks` 拆分 `element-plus` / `vue` vendor       | **P1** |
| P-2  | 同步 DB 命令阻塞主线程                                                                | 见 D-3                                                                                                                          | UI 掉帧                                                                                                                                   | 见 D-3                                                                                                                                                                               | **P1** |
| P-3  | 轮询双重惩罚                                                                          | 见 D-4                                                                                                                          | 健康会话被拖慢 12 倍                                                                                                                      | 见 D-4                                                                                                                                                                               | **P1** |
| P-4  | `listInbox` / `countInbox` 的 `JOIN welink_messages + GROUP BY c.id` 在消息量大时退化 | `src/infra/db/repos/welink.ts:455-511`                                                                                          | 收件箱页随消息量线性变慢；`countInbox` 每次都全量重算                                                                                     | 会话表已有冗余汇总列（这是好设计），可再冗余一列 `last_content` 并表示「是否存在 in 消息」布尔列，把 JOIN+GROUP BY 降为纯读；`idx_wm_direction(direction, sent_at)` 可继续服务收件箱 | P2     |
| P-5  | Rust 单连接 + `Mutex` 串行化                                                          | `src-tauri/src/db.rs:15,44-55`                                                                                                  | 一条长查询会阻塞所有其他 DB IPC；与 P-2 叠加形成复合卡顿                                                                                  | 桌面单机可接受；若要改善，用 `r2d2_sqlite` 连接池（读多写少场景收益明显）。**先做 P-2，再评估是否必要**                                                                              | P3     |
| P-6  | `applyPollResult` 双重去重（先 SELECT 查重，再 `INSERT OR IGNORE`）                   | `repos/welink.ts:307-315, 324`                                                                                                  | 每批多一次 IPC 往返                                                                                                                       | 可接受（正确性优先）。若需优化，改为只靠 `INSERT OR IGNORE` 的 `changes` 判定，省掉前置 SELECT                                                                                       | P3     |
| P-7  | `flush()` 的 `guard = 500` 与 `deferredThisPass` 交互逻辑复杂度偏高                   | `src/orchestrator/pipeline.ts:426-489`                                                                                          | 可维护性风险：这段循环的「挂起重试」语义靠注释维系                                                                                        | 已有 60 个 pipeline 用例覆盖，保持现状；若再改，先补一条「guard 触顶」的显式用例                                                                                                     | P3     |

### 5.1 性能方面已做对的部分

- Rust `[profile.release]`：`lto = true` + `codegen-units = 1` + `opt-level = "s"` + `panic = "abort"` + `strip = true`。
- sqlite 打开即设 `journal_mode=WAL` / `synchronous=NORMAL` / `foreign_keys=ON`，且 WAL 失败时**降级而非阻断启动**（`db.rs:24-29`）。
- 子进程输出读写分离到两个线程 + 读到上限后继续读走丢弃（`cli.rs:69-93`），并说明「不这样做子进程会因管道写满永久阻塞」。
- 会话列表零聚合：`unread_count` / `mention_count` / `last_msg_at` / `last_active` 由 `applyPollResult` 与 `markRead` **同事务增量维护**。
- `SafetyGate` 保持**零 SELECT**：会话开关缓存 + 启动预热（`primeConversation` / `primeGlobal`），并说明「缓存必须有写入方，否则机制名存实亡」（`safety-gate.ts:78-85`）。
- 前端 `jobIndex` 用 `shallowRef<Map>` + 整体换引用触发更新，避免深层响应式开销。
- 日志 UI 侧 200 行内存环形缓冲，不落库不刷屏。
- 分级轮询（热 30min / 温 24h 每 3 轮 / 冷每 6 轮）+ 会话间错峰 + 窗口隐藏时 ×3。

---

## 6. 安全问题

| 编号 | 问题                                                                                      | 证据                                                                                                                             | 风险等级                                  | 建议                                                                                                                                                                                                                                                | 优先级             |
| ---- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| S-1  | **CSP 未设置**                                                                            | `src-tauri/tauri.conf.json:25-27` `"csp": null`                                                                                  | 中                                        | 既然全部资源本地，可设严格 CSP：`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:*`（Element Plus 依赖 inline style，`style-src` 需保留 `'unsafe-inline'`）。这是纵深防御，成本极低 | P2                 |
| S-2  | SQL 通道不限制语句种类                                                                    | `src-tauri/src/db.rs:173-186`：`db_execute` 接受任意 SQL 字符串；`ATTACH DATABASE` / `PRAGMA` 均可执行                           | 低（依赖「前端打包代码可信」假设）        | rusqlite 侧对 `ATTACH` / `PRAGMA journal_mode` 等做黑名单拒绝或告警；或明确把该假设写进 `db.rs` 头部注释作为威胁模型声明                                                                                                                            | P2                 |
| S-3  | Agent 通信为明文 HTTP，且请求体含聊天上下文                                               | `src/infra/agent/agent-http.ts:45,60-65`（默认 `http://127.0.0.1:8080`，body 为 `{ prompt }`，prompt 含 `{{context}}` 完整对话） | 中（内网设计，但 baseUrl 可配成任意地址） | 文档与设置页显式提示「仅限内网/回环地址」；如需跨机，支持 `https` 并给出证书配置指引                                                                                                                                                                | P2                 |
| S-4  | 语法语料明文长期留存：`agent_logs` 存完整 `prompt`（含聊天记录）与 `response`，无自动过期 | `src/infra/db/migrations/welink.ts:78-89`；`clearAgentLogs` 仅有手动入口                                                         | 中（隐私合规）                            | 与 D-1 合并处理：为 `agent_logs` 设保留期 + 在设置页展示「语料留存 N 天」并在急停/关闭助手时可选一键清理                                                                                                                                            | **P1**（并入 D-1） |
| S-5  | 子进程白名单只校验 `file_stem`                                                            | `src-tauri/src/cli.rs:51-67`：`eq_ignore_ascii_case("welink-cli")`                                                               | 低                                        | 属设计权衡（用户自配 `cliPath`），但意味着「能改配置文件者可在任意目录放一个同名 exe 执行」。建议在设置页展示实际解析到的绝对路径并要求用户确认一次                                                                                                 | P3                 |
| S-6  | `resolve_within_root` 仅做词法检查，不做 canonicalize                                     | `src-tauri/src/fs.rs:11-25`：拒绝绝对路径、盘符、`..`，但存储根内若存在指向根外的符号链接/junction，拼接结果会落在根外           | 低（需本地写权限才能构造）                | 在 `fs_read` / `fs_write` 内对最终路径 `canonicalize()` 后复查前缀（Windows 下需处理 `\\?\` 前缀）。注意「文件不存在时 canonicalize 会失败」的写入场景需特殊处理                                                                                    | P3                 |

### 6.1 安全方面已做对的部分

| 项                 | 证据                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 无 XSS 注入面      | 全量无 `v-html` / `innerHTML`；Vue 模板默认转义；唯一相关配置显式关掉（`ConfigTab.vue:198` `dangerouslyUseHTMLString: false`）   |
| 无硬编码凭据       | 全仓库检索无 token / password / apiKey / secret 字面量                                                                           |
| 命令注入防护到位   | `cli.rs:124-134` args 以数组传递**不经 shell**；Windows 下 `CREATE_NO_WINDOW` 不弹黑框；超时强杀并回收管道                       |
| 参数绑定无拼接     | 仓储层全量使用 `?1 ?2 …` 位置绑定；`placeholders()` / `WhereBuilder` 专门保证「SQL 与参数一一对应」（`repos/welink.ts:157-194`） |
| 路径穿越防护       | `fs.rs` 拒绝 `RootDir` / `Prefix` / `ParentDir` 组件，并注释说明「因此无需额外 containment 复核」                                |
| 最小权限           | `src-tauri/capabilities/default.json` 只开 `core:default`，明确不加联网插件                                                      |
| 离线约束贯穿       | 无 CDN / 无外部字体（系统字体栈）/ 无遥测；`rusqlite` 选 `bundled` 静态内联；`windows-sys` 替代 chrono 以规避内网缓存缺口        |
| 子进程输出洪泛防护 | 单路上限 2 MB，超限截断并置 `truncated` 标志                                                                                     |

---

## 7. 测试覆盖与可维护性

### 7.1 现状

| 项            | 数值 / 结论                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 测试文件      | 16                                                                                                                                     |
| 测试用例      | **466，全部通过**（10.55s）                                                                                                            |
| 测试代码量    | 6 622 行（源码 14 946 行）                                                                                                             |
| 覆盖率统计    | **未配置**                                                                                                                             |
| Rust 单元测试 | 无（用户明确要求 Rust 侧保持精简直给，测试放 TS 层 —— 属有意决策）                                                                     |
| Vue 组件测试  | 15 个 `.vue` 中只有 `stores` / `repositories` / `orchestrator` / `infra` 有 spec，**视图与组件层无单测**（由 `uitest.mjs` 端到端覆盖） |

覆盖分布（按主题）：

| 主题       | 文件                                     | 用例数（文件内） | 质量判读                                                 |
| ---------- | ---------------------------------------- | ---------------- | -------------------------------------------------------- |
| 安全闸口   | `orchestrator/safety-gate.spec.ts`       | 827 行           | 优秀，L0–L3 + S1–S8 逐条断言                             |
| 回复管线   | `orchestrator/pipeline.spec.ts`          | 60               | 优秀，含并发不变量与异常隔离                             |
| 轮询器     | `orchestrator/poller.spec.ts`            | —                | 优秀，专门断言「是 setTimeout 链而非 setInterval」       |
| 触发规则   | `orchestrator/triggers.spec.ts`          | —                | 优秀，含 `\b` 对 CJK 失效的回归用例                      |
| 双实现契约 | `infra/db/repos/welink-contract.spec.ts` | 503 行           | 优秀，SQLite ⇄ 内存语义等价                              |
| 仓储 SQL   | `infra/db/welink.spec.ts`                | —                | 优秀，直接断言 SQL 文本与参数绑定、要点3 原子性、防双发  |
| 全链路     | `orchestrator/runtime.spec.ts`           | 475 行           | 优秀，mock 端口 → 内存库 → mock Agent → Gate → mock send |
| 崩溃恢复   | `orchestrator/bootstrap.spec.ts`         | —                | 优秀，三分支逐条                                         |
| 端口契约   | `infra/{agent,welink}/ports.spec.ts`     | —                | 良好，HTTP/CLI 用假 fetch / 假输出验证「形状」           |
| 编码       | `utils/b64.spec.ts`                      | —                | 良好，三级降级逐级                                       |
| Store      | `stores/{app,table}.spec.ts`             | —                | 良好，注入假后端                                         |

### 7.2 测试设计上的可复用经验（值得固化）

1. **端口-适配器让 mock 成为一等公民**：`TimerApi` / `WelinkPort` / `AgentClient` / `WelinkRepository` / `now()` 全部可注入，使「假时钟 + 假后端」测试不需要 `vi.useFakeTimers()` 与真实宏任务队列打架。
2. **契约测试对齐双实现**：`welink-contract.spec.ts` 用同一个测试体跑两套仓储，这类「同一断言、两种实现」的写法值得作为项目惯例保留。
3. **注释即缺陷档案**：多处注释直接记录了「曾经写错过什么、为什么」（如 `generateOne` 的状态分流、`isAtAll` 的 `\b`、`retryGenerate` 独立队列），使回归防护有据可查。

### 7.3 改进项

| 编号 | 问题                                                                                                            | 建议                                                                                                                                                 | 优先级 |
| ---- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| T-1  | 无覆盖率统计，「466 用例全绿」无法回答「关键路径覆盖了多少」                                                    | 加 `@vitest/coverage-v8`，先在 `orchestrator/` 与 `infra/db/` 设阈值（如 lines/functions 80%），不追求全局数字                                       | P2     |
| T-2  | 无 CI                                                                                                           | 加 `.github/workflows/verify.yml`，跑 `npm run typecheck` + `npm test`（`--fast` 可跳过打包）；Windows runner 上跑 `verify.mjs` 全量以覆盖 UI 自动化 | **P1** |
| T-3  | `uitest.mjs` 硬编码快照（见 D-11）                                                                              | 改为结构契约断言                                                                                                                                     | P2     |
| T-4  | 视图层无单测，而 `MessagesTab.vue`（818 行）/ `SettingsCard.vue`（711 行）/ `ConfigTab.vue`（606 行）体量已偏大 | 短期：把这三个组件里的纯逻辑（校验、格式化、`reviewCount`/`quotaText` 派生）抽到 `utils`/`composables` 并补单测；长期：按 Tab 继续拆分               | P2     |
| T-5  | `verify.mjs`（482 行）与 `uitest.mjs`（1110 行）本身无测试，但它们承载了「质量门」职责                          | 至少为 `verify.mjs` 的阶段编排与报告渲染加冒烟测试（可用 `--fast` + 假 stage 注入）                                                                  | P3     |

---

## 8. 问题总清单

按优先级汇总（共 27 项）：

| 优先级 | 编号            | 问题摘要                                         | 类型        |
| ------ | --------------- | ------------------------------------------------ | ----------- |
| **P1** | D-1             | 180 天保留期未接入调度，消息与语料表无界增长     | 缺陷        |
| **P1** | D-2             | `sanitizeReply` 未接入真实外发路径               | 缺陷        |
| **P1** | D-3             | Rust DB 命令同步执行，阻塞 UI 主线程             | 缺陷 / 性能 |
| **P1** | D-4             | 轮询间隔被最差退避二次惩罚                       | 缺陷 / 性能 |
| **P1** | P-1             | Element Plus 全量引入，主 chunk 1.01 MB          | 性能        |
| **P1** | S-4             | Agent 语料明文长期留存，无自动过期               | 安全 / 隐私 |
| **P1** | R-1             | 无 ESLint / Prettier / EditorConfig              | 工程化      |
| **P1** | T-2             | 无 CI                                            | 工程化      |
| P2     | R-3             | 版本号双真值（`web.ts` 硬编码 `0.1.0`）          | 规范        |
| P2     | R-4             | 迁移 SQL 双真值（`records.ts` ↔ `infra/db`）     | 规范 / 架构 |
| P2     | A-1             | 侧栏导航项双真值（未由路由派生）                 | 架构        |
| P2     | D-5             | `listConversations(500)` 静默截断                | 缺陷        |
| P2     | D-6             | `staggerMs` 与 `pollIntervalSec` 语义冲突        | 缺陷        |
| P2     | D-11            | `uitest.mjs` 界面快照硬编码                      | 可维护性    |
| P2     | P-4             | 收件箱 JOIN + GROUP BY 随消息量退化              | 性能        |
| P2     | S-1             | CSP 未设置                                       | 安全        |
| P2     | S-2             | SQL 通道不限语句种类（ATTACH / PRAGMA）          | 安全        |
| P2     | S-3             | Agent 明文 HTTP + prompt 含聊天内容              | 安全        |
| P2     | T-1             | 无覆盖率统计                                     | 可维护性    |
| P2     | T-4             | 视图层无单测且部分组件体量偏大                   | 可维护性    |
| P3     | R-2             | 唯一 `any` 用法                                  | 规范        |
| P3     | A-2             | 双文件通道并存（legacy `table.json`）            | 架构        |
| P3     | D-7             | `noUserIdFused` 解除分支不可达                   | 缺陷        |
| P3     | D-8             | `panic="abort"` 下中毒锁恢复代码不可达且注释误导 | 缺陷        |
| P3     | D-9             | `logUnsubscribe` 从不调用                        | 缺陷        |
| P3     | D-10            | `bundle.targets: ["nsis"]` 无效配置              | 规范        |
| P3     | P-5 / P-6 / P-7 | 单连接串行化 / 双重去重 / `flush` 复杂度         | 性能        |
| P3     | S-5 / S-6       | 白名单只校验 stem / 路径检查不做 canonicalize    | 安全        |
| P3     | T-5             | `verify.mjs` / `uitest.mjs` 自身无测试           | 可维护性    |

### 8.1 建议的推进顺序

1. **第一批（低成本高收益，建议本迭代内完成）**：D-2（回复清洗）、D-4（轮询惩罚）、R-3（版本号注入）、D-10 / D-7 / D-8（清理死配置与死分支）、S-1（CSP）。
2. **第二批（工程化底座）**：R-1（lint）+ T-2（CI）+ T-1（覆盖率阈值）。这三件互为支撑：lint 与覆盖率都靠 CI 才能形成持续约束。
3. **第三批（体积与线程模型）**：P-1（Element Plus 按需引入）+ D-3（DB 命令异步化）。两者都需要回归验证，建议合并为一次「性能专项」并跑一遍 `npm run verify` 全量。
4. **第四批（数据生命周期）**：D-1 + S-4（保留期清理任务 + 语料过期策略）。需先确定保留天数与是否提供「一键清空语料」入口。
5. **持续项**：A-1（路由派生侧栏）、R-4（迁移单一注册表）、P-4（收件箱冗余列）、T-4（视图逻辑抽取）。每项都可独立小步提交。

---

## 9. 结论

**总体评分 82 / 100 —— 良好，具备生产可用基础，且架构质量显著高于同规模项目。**

三条结论：

1. **架构是这个项目最扎实的资产。** 宿主边界唯一（`Bridge`）、依赖严格单向（views → stores → orchestrator → infra → ports）、端口-适配器 + mock 双实现 + 组合根装配 —— 这套结构使得「换掉真实 CLI / 换掉 Agent 协议 / 加一张业务表」都不需要动 Rust，且每一层都能在无真实依赖下测试。`src/api/types.ts`、`src/orchestrator/runtime.ts`、`src/infra/db/ports.ts` 三个文件体现了对「边界的价值」的清晰认识。

2. **正确性投入明显超过工程化投入。** 状态机原子性、防双发、崩溃恢复三分支、配额只在发送成功后扣减、熔断不计入内容质量问题 —— 这些是「出事故会很难受」的地方，都做对了，且有 466 个用例与契约测试守着。相反，lint / CI / 覆盖率 / 保留期清理 / 内容清洗这些「不出事故但会持续钝化」的地方存在缺口。

3. **四个 P1 里有三个是「已经写好了、只差接上」。** `purgeMessagesBefore` 已实现且有测试、`sanitizeReply` 已实现且有测试、`RETENTION_KEEP_DAYS` 已定义 —— 缺的是一个定时任务和一个函数调用。这类债务的修复成本极低而收益立刻可见，建议优先清掉。

**风险提示**：D-3（DB 命令主线程执行）与 D-1（保留期未生效）是两个会**随数据量增长而恶化**的问题，当前千级数据下无法察觉，属于典型的「上线三个月后才暴露」类型，建议在真实数据接入前处理。

---

_本报告基于 `ec30a39` 的快照通读与实测；所有问题均标注了可复核的文件与行号。_
