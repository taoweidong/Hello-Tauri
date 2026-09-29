# Hello-Tauri 代码质量与架构评估报告（2026-09-29）

- 评估方式：6 个并行专项评审（前端质量 / 架构边界 / Rust 层 / 测试质量 / 构建工具链 / 安全专项）+ 全量 lint / typecheck / 单测实测 + **全部 P1 发现逐条人工读码复核**。
- 上轮对照：逐项核实 docs/quality-report-2026-09-28.md 的 27 项修复——26 项确认在位且质量良好；**1 项（D-9 日志退订）为【回归】**：修复代码存在，但触发时机被 keep-alive 架空（见 4.2）。
- 行号以 2026-09-29 工作区为准（branch `br_builder`，HEAD `8e08251`）。

---

## 1. 总体结论

| 评估域 | 评分 | 一句话结论 |
| --- | --- | --- |
| 架构 | **90 / 100** | 声明铁律逐条真实成立，组合根/事件管道/Port-mock 一致性优于设计文档；仅 5 条越层边且无自动化闸 |
| 前端代码质量 | **82 / 100** | 类型纪律近乎满分、展示口径单一真值；扣分在 welink 大组件、配置三副本漂移与若干竞态 |
| Rust 层 | **84 / 100** | 命令面零 panic、SQL 闸口有真实解析深度；扣分集中在**存储迁移链路**（同步重 IO + 写入丢失窗口） |
| 测试 | **88 / 100** | 542 用例、安全铁律三层纵深防护、手写假时钟控制并发；扣分在真实适配器零覆盖与一个承重去重逻辑未测 |
| 构建 / 工具链 | **80 / 100** | 自研 PE 校验 + 阶段化验证链防回归意识强；但 CI 配置错、smoke 保留危险杀进程行为 |
| 安全 | **78 / 100** | 外发单出口收敛、SQL 全参数化、宿主通道克制；残余风险集中在急停不持久化与内容级防护薄弱 |
| **总体** | **≈ 84 / 100** | **无 P0**。整体是同类项目中防回归意识最强的梯队；主要债务集中在「安全防线生命周期」与「迁移链路」两处 |

**硬指标（实测）**：`eslint` 通过 ✅ · `vue-tsc --noEmit` 通过 ✅ · Vitest **21 文件 / 542 用例全部通过**（12.4s）✅
**代码规模**：生产 TS/Vue 16,556 行 · 测试 7,978 行 · Rust 1,211 行 · 脚本 2,906 行。

---

## 2. 架构评估

### 2.1 实际分层依赖（按 import 事实绘制）

```
views/(6) layouts/ components/welink/(8)
    │ ✓ → stores
    │ ✗ [V1] SettingsCard.vue:20-21 → infra/agent（直构适配器实例）
    │ ✗ [V2] HistoryTab.vue:22 → infra/db/ports（展示常量）
    │ ✗ [V3] TableCrudView.vue:9 → repositories/csv
    │ △ SettingsView / SettingsCard → api（设置页一次性宿主动作，可辩护）
    ▼
stores/{app, table, welink}
    │ ✓ → orchestrator（welink.ts:34-37）
    │ ✗ [S1] welink.ts:38 → infra/db/ports（展示常量）；welink.ts:17 → infra/db（跳层）
    ▼
orchestrator/{runtime(组合根), bootstrap, pipeline, poller, safety-gate, retention, triggers, timers, events}
    │ ✓ 全部只向下；模块间仅 type-only import；grep 证实零反向、零循环
    ▼
infra/{welink, agent, db}  ←──────────┐
    │ ✓ → api                         │ ✗ [R1] repositories/records.ts:2
    ▼                                 │    → infra/db/migrations（反向边，无环）
api/{types, tauri, web, index}        │
    │ 全 src 唯一 @tauri-apps/api：tauri.ts:1 ✓
    ▼
Rust 16 命令（commands 9 / fs 2 / db 4 / cli 1，lib.rs:20-37 实测一致）
```

### 2.2 铁律逐条验证

| # | 铁律 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 前端禁止直接 import @tauri-apps/api | ✅ 成立 | 全 src 仅 `src/api/tauri.ts:1`；ESLint paths+patterns 双闸（eslint.config.mjs:112-127） |
| 2 | Rust 无业务逻辑（16 命令） | ✅ 成立 | lib.rs:20-37 与文档一致；db.rs 无任何业务表名 |
| 3 | 表结构归 TS | ✅ 成立 | 迁移唯一真值 `infra/db/index.ts:26`；业务 SQL 全在 repos/migrations |
| 4 | TS 分层单向 | ⚠️ 基本成立 | 主链干净、零循环；共 **5 条越层边**（V1/V2/V3/S1/R1），均为跳层或反向，无一条越过 Bridge |
| 5 | 外部世界一律 Port+mock | ✅ 成立 | 三模块同构；mock 与真实适配器共享 Port 类型，**非测试代码 0 处 any / @ts-ignore** |
| 6 | 运行时零外部请求 | ✅ 成立 | fetch 仅存在于 agent-http.ts（默认 127.0.0.1，用户自配内网）；无 CDN/在线字体 |

**Bridge 对齐性**：`types.ts` 16 方法 ↔ `tauri.ts` 1:1 映射 Rust 命令 ↔ `web.ts` 全实现。web 侧语义是**诚实抛错**而非假数据（web.ts:52-97），契约测试 `api/index.spec.ts` 逐方法对齐。唯一非对称：`web.ts:88-90 dbMigrate` 返回 `[]` 而非抛错，与相邻注释措辞不符（无害）。

**events.ts 不是全局总线**：封闭判别联合（12 种事件）+ 单生产方 + 单消费方（stores/welink.ts switch 全覆盖）+ 组合根中转并注释漏接后果——是窄管道而非广播。

### 2.3 与设计文档的偏差（docs/design-welink-agent §3）

1. `runtime.ts` 组合根在设计图中不存在（实现收口为 store 只认 runtime）——**优于设计**。
2. `retention/timers/triggers/events` 四模块设计图未画、实现拆分并有独立 spec——良性具象化。
3. DB 命令已全部 async 化（D-3）——**比设计更进一步**。
4. UI 层 5 条越层边是主要偏差——设计图 UI 只连 stores。

### 2.4 架构可扩展性推演（新增「定时摘要推送」）

不动 Rust/Bridge/infra 三模块；要动 types → orchestrator/digest.ts（新）→ runtime 装配 → events（封闭联合需同步 store switch）→ stores → UI。两个真痛点：① `trigger_type` 的 CHECK 约束要发 migration v3 重建表（SQLite 不能 ALTER CHECK）；② SafetyGate 的 S2 小时配额会掐死批量外发，需要新增 Gate 规则语义。**结论：干净的纵切，无需为它开后门——分层在强制设计者回答「摘要算不算滥发风险」，这是收益。**

---

## 3. P1 发现清单（8 项，全部经人工读码复核）

> P0：无。P1 = 明确缺陷 / 高维护风险 / 安全防线缺口。

### 3.1【安全】L0 一键急停不持久化，重启后静默失效 → 自动外发恢复

- 位置：`src/orchestrator/safety-gate.ts:129`（`let panic = false` 仅实例内存）+ `src/views/WeLinkView.vue:148-152`（启动时按 `settings.enabled` 自动恢复调度）
- 复核确认：`panic` 不落库不落配置；只有 `liftPanic` 才把 `sendMode` 降级写回配置（WeLinkView.vue:111）。急停后直接关机/崩溃重启，`bootstrap.ts:155-163` 会把所有 `ready` 任务重新入队，**自动外发恢复**。
- 影响：用户视角「已封死所有外发」的最后防线在重启后无声解除——这正是防滥发设计最不能开的口子。
- 修复：panic 状态持久化（config 专项字段或独立标记文件），启动恢复时检测到则以 `sendMode='manual'` 启动 + Gate 预置 panic + 显式提示。

### 3.2【安全】提示词注入无分隔/转义/长度约束，注入内容可直达自动外发

- 位置：`src/infra/agent/prompt.ts:29-49`；内容防护仅 `safety-gate.ts:191-213`（非空/长度/5 条资金凭据正则）
- 复核确认：消息正文原样嵌入 prompt，`[时间] 昵称：内容` 行格式可被正文逐字伪造，模板内行为约束是纯软指令。黑名单不含 URL/伪装/语义检查。
- 为什么不是 P0：每会话 `autoReply` 默认关且需人工勾选（migrations/welink.ts:27），S1-S3/S5/S8 频控熔断齐备，黑名单命中转人工——纵深存在，内容级最后一闸薄弱。
- 修复：① 正文嵌入前结构消毒（剥离 `【】` 模板标记与行首格式）+ 不可信内容定界符；② 单条消息与总 prompt 长度上限；③ URL/外发类句式纳入默认黑名单；④ 考虑群外发默认 manual。

### 3.3【Rust】`storage_migrate` 同步命令在主线程做全量目录复制

- 位置：`src-tauri/src/commands.rs:29-32`（同步 command）+ `src-tauri/src/storage.rs:196-200`（递归复制含 app.db、-wal、全部聊天记录与 30 份日志）
- 复核确认：db.rs:58-68 用整段注释论证了「同步命令卡 UI 主线程」并据此把 4 个 DB 命令 async 化（上轮 D-3），但比任何 SQL 重几个量级的迁移复制却在主线程同步执行——同一原则的漏网之鱼。
- 修复：改 `pub async fn` + 与 `run_blocking_db` 同构。

### 3.4【Rust】迁移窗口无写入冻结：复制期间与迁移后到重启前的写入静默丢失

- 位置：`src-tauri/src/storage.rs:193-203`
- 复核确认：`:193` checkpoint 后立即释放锁；`:196-200` 复制期间 async DB 命令（跑在 spawn_blocking 线程）可并发写入旧根 `-wal`；`:203` 切换 bootstrap 指针后、重启前的所有写入同样只落旧根。`:179` 注释只写「需重启生效」，未写「期间写入会丢」。
- 影响：轮询器在复制窗口拉到的新消息对新根而言**永久缺失**（旧目录保留但无机制提示差异）——有界的静默数据丢失路径。
- 修复：迁移期间置全局写入冻结标志（`with_db` 入口检查）或整个复制过程持有 `Db` 锁；迁移成功后拒绝 DB 写命令直至重启。

### 3.5【构建】CI 完整验证链缺 `--escalated`，打包阶段设计性必败

- 位置：`.github/workflows/full-verify.yml:56`（`run: npm run verify`）+ `scripts/verify.mjs:458-462`（argv 硬判定 `if (!escalated) return ok:false`，与环境是否真受限无关）
- 影响：手动/每日完整链每次都停在阶段 6、退出码 1——workflow 常红，真实打包链回归会被淹没。
- 修复：workflow 改 `npm run verify -- --escalated`（一行）；或给 verify 增加「CI 环境自动视为已授权」开关。

### 3.6【构建】smoke 仍全局 `taskkill /F /IM msedgewebview2.exe`，杀掉全机 WebView2 应用

- 位置：`scripts/smoke.mjs:112-113`（清场）与 `:184`（收尾）
- 复核确认：uitest.mjs:305-322 已用实测数据（基线 6 个无关进程）证明这是全机误伤并已移除同款代码，还记录了两个验证流程并发互杀的真实事故——**smoke 没有同步这一修复**。verify 阶段 9 会调 smoke（verify.mjs:552）。
- 影响：任何一次 `npm run smoke` / `npm run verify` 都会杀掉用户机器上所有 WebView2 应用（新版 Outlook、Teams 等），可造成用户可见数据丢失。
- 修复：对齐 uitest——只 `killTree(pid)` + `countByName` 先探测再动手。

### 3.7【测试】poller 跨批 msg_uid 去重（防双回复承重逻辑）零测试覆盖

- 位置：`src/orchestrator/poller.ts:295-300`（去重实现，注释明言「避免同一条消息建出两个 job」）vs `poller.spec.ts:800-817`（唯一续批用例三批 uid 互不重复）
- 复核确认：删掉这段去重，现有 65 个 poller 用例全绿；而仓储侧「已入库过滤」拦不住同一轮内的重复 → `createJobStatements` 会为同一消息建两个 job → 双回复。
- 修复：补「第 2 批首条 msgUid == 第 1 批末条」用例，断言只收到一份、triggers 只有一个 uid。

### 3.8【前端】监控配置页筛选与分页脱节，翻页出现空页

- 位置：`src/components/welink/ConfigTab.vue:63`（`total` 仅在 `load()` 赋值；筛选输入 :273-279 均不触发 load）+ `:376`（el-pagination 用过期 total）
- 影响：筛选后分页器仍显示全量条数；`page > 1` 时翻到筛选后不足一页的位置直接显示空表，数据「看起来丢了」。
- 修复：`total` 改 `computed(() => filtered.value.length)`，筛选变化时 `page = 1`（对齐 HistoryTab.vue:120-138 的既有做法）。

---

## 4. P2 发现（按域分组，共 25 项）

### 4.1 前端（welink 界面与状态）

| # | 位置 | 问题 |
| --- | --- | --- |
| F-1 | SettingsCard.vue:58 + welink.ts:289-294 + runtime.ts:212-216 | 提示词 textarea 深度 watch 逐键触发 `runtime.reload` + 日志落盘（一段模板=数百次 IPC 写），需 300-500ms debounce |
| F-2 | SettingsCard.vue:45-56 + types/welink.ts:346 | 「清空即回填」：normalize 回环把空串钉回默认模板，用户无法清空重写、输入中丢光标 |
| F-3 | WeLinkView.vue:90-91,111 + stores/app.ts:74-83 | 配置三副本漂移：助手页开关/liftPanic 以**持久层旧值**为基底整体覆盖，卡片未保存的逐键热更新编辑在重启后静默丢失 |
| F-4 | stores/welink.ts:468-497 | `selectConversation` 无竞态守卫（快速切 A→B 可能显示 A 的消息）；`loadEarlierMessages` 无 in-flight 锁，双击拼重 |
| F-5 | WeLinkView.vue:119-137 等 12+ 处 | 用户动作 Promise 未 catch（pullNow/pauseMonitor/retryJob/clearLogs/toggle 系），失败=控制台 unhandled rejection + 界面无反应；同项目 HistoryTab/TableCrud 已有 catch+ElMessage 惯例未贯彻 |
| F-6 | ControlBar.vue:55-81 + safety-gate.ts:444-452 | 熔断横幅泄漏原始枚举（"group_at_me场景…"）；「解除」传 `undefined` 清掉**所有**场景熔断；safety-gate.ts:457 注释声称的「全局」路径实际不可达 |
| F-7 | **【回归】** MainLayout.vue:143-145 + WeLinkView.vue:161-171 | keep-alive 未设 `include`，所有路由组件常驻 → `onUnmounted` 永不触发，D-9 的日志退订与 visibilitychange 移除是死代码。修：改 `onDeactivated/onActivated` 配对或 keep-alive 白名单 |

### 4.2 Rust 层

| # | 位置 | 问题 |
| --- | --- | --- |
| R-1 | db.rs:399 vs :345-346 | `db_migrate` 不过语句闸口（事务路径专门加了闸防绕过，迁移路径 `execute_batch` 直接放行）——S-2 修复的绕过路径 |
| R-2 | db.rs:152-156 | `db_select` 无行数上限，忘写 LIMIT 的查询整表转 JSON 拖垮内存与 IPC |
| R-3 | db.rs:113-119 | 超 2^53 整数静默转 f64（雪花 ID 类丢精度且无标记；BLOB 有 `[blob]` 占位、大整数伪装成正常数字） |
| R-4 | storage.rs:143-148 vs :53-67 | `write_file` 非原子写（config.json/table.json 断电即截断损坏）；tmp+rename 正确写法同文件 bootstrap 已有现成实现未复用 |
| R-5 | storage.rs:47-51,91-96 | bootstrap.json 损坏静默回退默认根，已迁移用户视角「数据全没了」且无日志无提示；`dataDir` 无绝对路径校验 |
| R-6 | commands.rs:57-62 + storage.rs:24-29 + logging.rs:127 | `append_log` 每条日志主线程 ~7 次 fs 操作（探针三连+全目录扫描）；`resolve_storage` 12 个调用点每次重做探针——应缓存到 State，`prune_logs` 改跨天一次 |

### 4.3 架构与分层

| # | 位置 | 问题 |
| --- | --- | --- |
| A-1 | SettingsCard.vue:20-21,236-242 | 组件直构 `createHttpAgent/createMockAgent` 绕过工厂环境兜底——浏览器模式连通性测试给「Agent 连通正常」假信心而运行链路实际强制 mock |
| A-2 | repositories/records.ts:2 | repositories→infra **反向边**（migrationV1 住错层），R-4 修复引入的第一个合法化反例 |
| A-3 | eslint.config.mjs:112-127 | 分层约束纯靠约定，5 条越层边全是「溜进来无人拦」——建议 dependency-cruiser 或按目录 patterns 建闸 |

### 4.4 测试

| # | 位置 | 问题 |
| --- | --- | --- |
| T-1 | welink-cli.ts / exec.ts | 真实 CLI 适配器整体零覆盖（错误分类驱动退避 vs 重试分流，恰是真实接口接入时最易改坏处） |
| T-2 | ports.spec.ts:280-403 | HTTP 客户端超时路径（AbortController → timeout 分类）未测，现有 fetch 全部立即返回 |
| T-3 | runtime.spec.ts:444-461 | 「熔断触发 fuseTripped」断言恒真（`every` 于可能为空的数组），漏注册 onFuse 仍绿 |
| T-4 | bootstrap.spec.ts:128-131 | Gate 预热（重启后配额恢复）只建桩不断言，`hourStart` 传错不会被抓（且确实传错了，见 P3-1） |
| T-5 | safety-gate.spec.ts | 时钟回拨语义未钉住（rollHour 回拨到上一小时桶会清零配额，行为方向未被任何测试固定） |

### 4.5 构建与工具链

| # | 位置 | 问题 |
| --- | --- | --- |
| B-1 | package.json:8 vs uitest.mjs:24 等 | engines `>=20` 低报：uitest 依赖 `node:sqlite`（Node 22 内置）+ WebSocket（22.4+ 免 flag）；Node 20/21 能装包能打包，verify 阶段 4/8/9 以晦涩报错崩 |
| B-2 | package-lock.json | 双 Vite 大版本并存（根 8.3.0 rolldown + vitest 嵌套 7.3.6 rollup），单测与生产构建跑在不同 bundler major；define/alias 双份手工同步 |
| B-3 | vite.config.ts:21-22 | 注释声称 verify 有 tauri.conf↔package.json 版本一致性断言——**实际不存在**（grep 零命中），不实注释制造兜底假象 |
| B-4 | scripts/lib/cdp.mjs:53-101 | 无 close/error 后置监听：WebView2 崩溃后 40+ 用例逐个 15s 超时磨完（最坏拖长 ~10 分钟），失败原因被系统性误导 |
| B-5 | build.mjs / uitest / smoke | 全链无重入防护：并发 pack 可交错读半成品；uitest/smoke 并发互写 bootstrap.json（事故已有文字记录，修复只做了进程层） |

### 4.6 安全

| # | 位置 | 问题 |
| --- | --- | --- |
| S-1 | agent-http.ts:44-45 + tauri.conf.json:26 | Agent baseUrl 完全来自配置无 scheme/host 校验 + CSP `connect-src http: https:` 过宽——篡改 config 即可把含企业通信原文的 prompt 外带任意地址 |
| S-2 | storage.rs:90-124,180-211 | bootstrap/storage_migrate 无目标路径约束（C:\Windows、UNC 网络共享均可），企业通信数据可被重定位到攻击者可读路径 |
| S-3 | adapter.ts:96 + triggers.ts:59 | 自发消息判定完全依赖 `myUserId` 配置，填错工号 → 自回复循环仅靠限流压到 ~1 条/30s，不会停；CLI 若有权威 direction 字段未被采信 |
| S-4 | exec.ts:48,66 + repos/welink.ts:658-666 | 发送失败错误串带完整 `--text <草稿>` 进日志文件与 last_error——模型生成的草稿（可能复述企业通信）超出预期存储边界，且普通日志无 90 天过期 |
| S-5 | pipeline.ts:129-143 + ports.ts:149-157 | agent_logs 全量 prompt/response 明文落库 90 天，Trace 页一键复制，无「含对话原文」的界面明示 |

---

## 5. P3 发现（择要，共 20 项）

- **真实缺陷**：`bootstrap.ts:167` 配额预热窗口实为「当日零点」而非「本小时」（`slice(0,11)+'00:00'`，对照 stores/welink.ts:627 的正确写法）——方向保守（多拦不少发）但造成「重启后助手变哑 until 整点」，且 ：180 日志「本小时已发」是谎报。
- HistoryTab.vue:284 占位文案「被拦 m 条」；ConfigTab.vue:421 markdown 星号原样显示；HistoryTab.vue:479 编辑框 maxlength=500 与可配 maxDraftChars(4000) 脱节，静默截断。
- HistoryTab.vue:244 / TraceTab.vue:175 复制动作未 await 即报「已复制」。
- icons.ts:180-196 AppIcon + 4 图标零使用（死代码）；`fetchConversations(500)` 默认值与 `CONVERSATION_PAGE_LIMIT` 双真值。
- WeLinkView.vue:231 prepend-only 日志用 index 作 key；`:178` 存量待审被报成「新增」。
- SettingsView.vue:14-20 表单浅拷贝 + 深度 watch 回写，跨页覆盖未保存 weLink 草稿；save() 每次双写配置文件。
- cli.rs：`cli_run` 无串行化锁（pull/send 两条定时器链可并发 spawn welink-cli，会话级状态语义未定义）；kill 失败后 `wait()` 无限阻塞该 IPC。
- logging.rs:105,117：日志仅滤 \r\n，ANSI 转义与其余控制字符可直入日志；`level` 参数未白名单。
- db.rs:141-147：JOIN 同名列后者静默覆盖前者。
- fs.rs:46-68 + storage.rs:113-121：双根均不可写时 `contain_root` 回溯越过根，把权限问题误报成「越权」；`strip_verbatim` 不处理 `\\?\UNC\`（网络共享场景全拒）。
- build/verify PE 解析只看数据目录项 1，延迟加载导入（项 13）不覆盖；无越界防御。
- tsconfig.json:22 include 不含 vitest.config.ts（其中的 @ts-expect-error 永不被检验）；vitest.config.ts 未挂 AutoImport/Components 插件，与生产构建模块解析能力存在潜伏差异。
- verify --fast 复用 release/ 旧 exe 无新鲜度提示；uitest CDP 端口随机不探测占用。
- safety-gate.ts:286-288 会话 id 零规范化（大小写/空白分裂配额计数）；:203-213 用户自定义黑名单正则 ReDoS 自伤面；agent-http.ts:76 响应无大小上限。
- repos/welink.ts:751-762 回执核对按「同会话同内容」匹配，同会话同文本的另一 job 会造成误判（fail-safe 方向，仅数据准确性）。
- 测试卫生：`job()/conversation()` 夹具五份近拷贝、`createScheduler()` 四份逐字重复；pipeline.spec.ts:1276-1298 完全重复用例；safety-gate.spec.ts:899 与 bootstrap.spec.ts:253 标题与断言相反。
- vitest.config.ts:45 注释「483 用例」已过时（现 542）。

---

## 6. 上轮 27 项修复核实结果

26 项确认在位：D-1（retention 生命周期）、D-2（pipeline 单飞）、D-3（DB async 化）、D-4（poll.ts 共享）、D-5、D-6（页面数字真值）、D-8（锁注释）、D-10、P-1（按需引入）、R-2（any 消除，实测 0 处）、R-3（版本号注入双配置同步）、R-4（迁移单一真值）、S-1（CSP）、S-2（SQL 闸口）、S-6（canonicalize）、T-4（welink-display 抽取）、A-1（路由派生侧栏）等。
**1 项回归**：D-9（日志退订）→ 见 F-7。

---

## 7. 改进路线图

### 第一批：立即修（半天内，高杠杆低成本）

1. **CI**：full-verify.yml 加 `--escalated`（一行，3.5）。
2. **smoke 杀进程**：对齐 uitest 的 killTree+countByName 模式（3.6）。
3. **ConfigTab 分页**：`total` 改 computed + 筛选重置页码（3.8）。
4. **bootstrap.ts:167**：`slice(0,13) + ':00:00'`（P3 真实缺陷，一行）。
5. **D-9 回归**：退订改 `onDeactivated`（F-7）。
6. **poller 去重测试**：补跨批重复用例（3.7）。

### 第二批：安全防线生命周期（本周）

7. **急停持久化**（3.1）——panic 标记落盘 + 启动检测 + manual 降级。
8. **prompt 消毒**（3.2）——定界符 + 结构剥离 + 长度上限 + URL 黑名单。
9. **Agent URL 校验 + CSP 收紧**（S-1）——至少拒绝公网地址或强制确认。
10. **迁移链路**（3.3+3.4 一起修）——async 化 + 写入冻结/写拒绝直至重启。
11. **send 错误串脱敏**（S-4）。

### 第三批：健壮性收口（两周内）

12. Rust 六项（R-1～R-6）：`db_migrate` 过闸、行数上限、大整数转字符串、`write_file` 统一 tmp+rename、bootstrap 损坏提示、`resolve_storage` 缓存。
13. 前端四项（F-1～F-4）：debounce、normalize 回环、三副本收敛为单一真值、store 加载序号守卫。
14. 统一 `withToast` 错误包装补齐 12+ 处未 catch 动作（F-5）。
15. 测试补齐（T-1～T-5）：cli/exec 错误分类、HTTP 超时、fuseTripped 真断言、prime 接线断言、时钟回拨语义。
16. engines `>=22.5` + Node 版本探测指引（B-1）；uitest/smoke lockfile 互斥（B-5）。
17. 分层自动化闸（A-3）：dependency-cruiser 或 eslint patterns，先以现状 5 条边为基线防新增。
18. CDP close/error 快速失败（B-4）；verify 补版本一致性断言或删不实注释（B-3）。

### 第四批：结构与长期

19. welink 组件拆分：7 个文件 >500 行（MessagesTab 832 / SettingsCard 807 / HistoryTab 671 / ConfigTab 622 / TraceTab 620 / InboxTab 607 / WeLinkView 501）；SettingsCard 的 draft 双向 normalize 抽 composable（F-1/F-2 的温床）。
20. 测试共享夹具 builder（五份 job()/conversation() 近拷贝收敛）。
21. 消除反向边（A-2）：migrationV1 挪位置；SettingsCard 直构改 `createAgentProbe` 工厂（A-1）。
22. vitest 升级收敛双 Vite（B-2）；PE 校验补 delay-import 目录；日志过滤控制字符 + level 白名单；`myUserId` 权威字段与自回复熔断原因（S-3）；agent_logs 明示与可选脱敏（S-5）。
23. vitest.config.ts 注释实测数字加「如何复测」或更新为 542。

---

## 8. 值得保持的亮点（跨域汇总）

1. **防双发铁律三层纵深**：SQL 文本断言（welink.spec.ts:276-313）→ 管线崩溃恢复（pipeline.spec.ts:1079-1106）→ 全链路回执补记（runtime.spec.ts:422-442）。
2. **外发单出口真正收敛**：全仓唯一 `port.send` 在 pipeline 外发 worker（pipeline.ts:366），manual/重发/崩溃恢复全部折返 gate.check；配额只在发送成功后扣减。
3. **SQL 通道纵深防御**：TS 层全参数化（40+ 语句逐一核查无拼接）+ Rust 层语句闸口（含注释/字面量剥除的词边界匹配，db.rs:193-280）。
4. **组合根把装配与编排彻底分离**（runtime.ts），全链路可注入假端口/假时钟整测；events 是带类型的窄管道而非总线。
5. **手写假时钟 + deferred 并发控制**使「生成并发=2 / 外发串行=1」「退避 5/10/20/40/60」都能卡在中间精确观察——比 vi.useFakeTimers 更强的测试基建。
6. **注释即架构文档**：几乎每个模块头写明「为什么不用更直觉的写法」，本报告的多数结论可仅凭源码自洽复核。

---

*评估执行：主线程 + 6 个并行专项评审 agent（前端 / 架构 / Rust / 测试 / 构建 / 安全），全部 P1 与【回归】发现经主线程逐条读码复核后才收录本报告。*
