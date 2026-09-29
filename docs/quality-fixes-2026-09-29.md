# 质量修复记录（2026-09-30）

对应报告：docs/quality-report-2026-09-29.md（6 专项并行评审）。本批共修复 **24 项**（8 个 P1、1 个回归、15 个 P2/P3），验证链全绿：ESLint ✅ · vue-tsc ✅ · Vitest **22 文件 / 561 用例**（新增 19 个）✅ · `cargo check` ✅。

## 第一批：立即修（报告 §7.1）

| # | 报告项 | 修复内容 |
| --- | --- | --- |
| 1 | P1-3.5 | `.github/workflows/full-verify.yml` 改为 `npm run verify -- --escalated`——CI 是无沙箱授权环境，此前打包阶段按 argv 硬判定设计性必败 |
| 2 | P1-3.6 | `scripts/smoke.mjs` 删除两处 `killByName('msedgewebview2.exe')`（全局误伤全机 WebView2 应用）；新增 `countByName`/`clearStaleInstances`，只按「先探测再动手」清理**本应用自己的**残留 |
| 3 | P1-3.8 | `ConfigTab.vue`：`total` 改为 `computed(filtered.length)` + 筛选变化重置页码——修复筛选后分页器过期、翻页空表 |
| 4 | P3 | `bootstrap.ts` 预热窗口 `slice(0,11)+'00:00'` → `slice(0,13)+':00:00'`——配额预热起点从「当日零点」修正为「本小时」（此前重启后助手哑到整点） |
| 5 | 【回归】D-9 | store 暴露幂等的 `subscribeWelinkLogs()`；WeLinkView 改用 `onActivated/onDeactivated` 配对 + `onMounted/onUnmounted` 兜底做幂等绑定/解绑——原 `onUnmounted` 版本在 keep-alive 下是永不执行的死代码 |
| 6 | P1-3.7 | 新增 poller 跨批去重测试：续批边界重复上一批末条 msgUid 时，`applyPollResult` 收到的每条 uid 恰好一次（删掉 poller.ts:295-300 去重本用例即红） |

## 第二批：安全防线生命周期（报告 §7.2）

| # | 报告项 | 修复内容 |
| --- | --- | --- |
| 7 | P1-3.1 急停持久化 | `WelinkSettings` 新增 `panicked` 运行期标记：`panicStop` 置位并随配置落盘；`store.init` 读到它强制 `sendMode='manual'` 并复位、返回 `panicRecovered` 供视图写回持久层 + 显式告知。重启后外发不再静默恢复。附 2 条 store 单测 |
| 8 | P1-3.2 提示词注入 | `prompt.ts` 新增 `sanitizeUntrusted`（剥控制字符 / 拍平换行 / 400 字截断留痕），`formatContextLine`/`renderPrompt` 全部接入；默认模板新增第 5 条反注入指令；默认黑名单新增外链句式 `https?://\|www\.`。**附带根治一个评审未发现的真漏洞**：`renderPrompt` 原为链式 `replaceAll`，消息正文含 `{{target}}` 会被二次展开（占位符注入）——改为单遍正则替换，用例钉死 |
| 9 | S-1/P2 Agent URL | `normalizeWelinkSettings` 校验 baseUrl 必须是 http(s) URL（防 file:/ftp: 等协议注入）；`agent-http.ts` 新增 `assertIntranetHost`——literal 公网 IP 直接拒绝（内网部署语义，主机名不做判定），篡改配置把含企业通信原文的 prompt 外带公网的路被堵死 |
| 10 | P1-3.3/3.4 迁移链路 | `storage_migrate` 改 async + `spawn_blocking`（不再冻结主线程）；storage 新增 NORMAL/MIGRATING/FROZEN 写入状态机：复制窗口内 DB 与文件写全部拒绝，迁移成功后 DB 写保持拒绝直到重启（读不受限）——「迁移窗口写入静默丢失」的两个窗口全部关闭；`db.rs` 新增 `with_db_exclusive` 独占连接完成 checkpoint+复制 |
| 11 | S-4 错误脱敏 | `exec.ts` 新增 `redactArgs`：错误串中 `--text` 的值（模型草稿，可能复述企业通信原文）替换为 `[文本已省略 N 字]`，不再随 last_error 与日志文件扩散 |

## 第三批：健壮性收口（报告 §7.3 选做项）

| # | 报告项 | 修复内容 |
| --- | --- | --- |
| 12 | R-1 | `db_migrate` 迁移 SQL 过语句闸口（`guard_statement`）——补上 S-2 唯一漏防的 SQL 入口 |
| 13 | R-2 | `db_select` 加 10000 行硬顶，触顶报错并提示加 LIMIT（报错优于静默截断） |
| 14 | R-3 | 超 2^53 整数转字符串返回（f64 会静默丢精度；字符串可绑定回查，SQLite 按列亲和性仍等值匹配） |
| 15 | R-4 | `write_file` 统一改临时文件 + rename 原子写（config.json/table.json 断电不再半截） |
| 16 | R-5 | bootstrap.json 损坏/内容非法/dataDir 非法（非绝对路径或盘根）时，原因写入 `storage_info.note` 并区分三类文案——不再静默回退让用户以为「数据全没了」 |
| 17 | P2-6 部分 | `prune_logs` 改为跨天首次写入执行一次（此前每条日志全量 read_dir+sort）；日志 level 白名单（防伪造日志头）；控制字符统一压空格（ANSI 序列无法再污染日志文件） |
| 18 | F-1 | SettingsCard 热更新 push 加 300ms debounce——多行提示词输入不再逐键触发 runtime.reload + 日志落盘 |
| 19 | F-2 | SettingsCard 以 `lastPushedJson` 识别 normalize 回环，自己 push 的回写不再重置草稿——「清空提示词模板被顶回出厂文案、输入丢光标」修复 |
| 20 | F-3 | `toggleEnabled`/`onPanicStop`/`liftPanic` 改以热副本 `store.settings` 为基底写回持久层——设置卡片未保存的编辑不再被持久层旧值覆盖 |
| 21 | F-4 | store 新增 `timelineSeq` 代次守卫 + `loadEarlierMessages` in-flight 锁——快速切换会话不再显示错会话内容，连点不再重复拼接消息 |
| 22 | A-1 | `infra/agent` 新增 `createAgentProbe` 工厂（共享环境兜底、不进缓存、不挂 onCall）；SettingsCard 改用它——浏览器模式探测不再对被强制 mock 的运行链路报「连通正常」假信心 |
| 23 | T-3/T-4/T-5 | runtime 熔断用例改为确定性构造（cap=1+threshold=1，3 条消息，断言 scope/reason，替换恒真断言）；bootstrap 新增 Gate 预热接线断言（primeGlobal 参数、watching 逐会话 prime、失败不阻断，含小时桶起点回归闸）；safety-gate 新增时钟回拨/前拨语义用例（钉住「桶变化即清零」的已知取舍） |
| 24 | B-1/B-3 | engines `>=20` → `>=22.5`（uitest/smoke 依赖 Node 22 内置 node:sqlite），README/AGENTS.md 同步；`build.mjs` 打包入口新增 package.json ↔ tauri.conf.json 版本一致性硬校验，vite.config.ts 不实注释更正 |

## 新增测试（19 个）

- `infra/agent/prompt.spec.ts`（新文件，10 用例）：消毒三道处理、渲染管线接入、占位符不可二次展开（抓到真漏洞的用例）、默认模板反注入条款、外链黑名单生效。
- `stores/welink.spec.ts` +2：急停标记跨重启强制 manual 并复位 / 无标记不改动。
- `orchestrator/poller.spec.ts` +1：续批边界重复 msgUid 收敛。
- `orchestrator/bootstrap.spec.ts` +3：Gate 预热接线三断言。
- `orchestrator/safety-gate.spec.ts` +3：时钟回拨/前拨/S1 绝对时间戳语义。

## 未处理（后续批次，按报告 §7.3/§7.4 遗留）

- **第三批未做**：F-5（withToast 统一包装 12+ 处未 catch 动作）、A-2（records 反向边迁移位置）、A-3（dependency-cruiser 分层闸）、B-2（vitest 升级收敛双 Vite）、B-4（CDP close 快速失败）、B-5（pack/uitest/smoke 重入锁）、R-6 的 `resolve_storage` 缓存（仅做了 prune 每日一次）、T-1/T-2（真实 CLI 适配器与 HTTP 超时路径测试）。
- **第四批全部**：welink 大组件拆分（7 个 >500 行）、测试共享夹具 builder、`myUserId` 权威字段与自回复熔断（S-3）、agent_logs 脱敏开关与界面明示（S-5）、CSP connect-src 收敛（依赖 Agent 地址策略定型，当前由 agent-http 内网守卫兜底）、PE 校验 delay-import 目录、JOIN 同名列处理。
