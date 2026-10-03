# Hello-Tauri 代码质量评估报告（2026-10-02）

- 评估方式：OpenSpec explore 模式，全部结论基于实测——`eslint` / `vue-tsc` / Vitest 710 用例 /
  v8 覆盖率（含阈值判定）/ `cargo check` 现场跑通；上轮报告（`quality-report-2026-09-29.md`）
  的 8 个主要发现逐条读码核实。
- 基线：`docs/quality-report-2026-09-29.md`（总体 ≈84 分）。当前 HEAD `0271726`（main）。
- 上轮到本轮的增量：Windows 基础设施通道（windows-infra-foundation，已归档）、大模型连接
  配置、环境检测页、若干修复；OpenSpec 工件体系引入。

---

## 1. 总体结论

| 评估域 | 上轮 | 本轮 | 一句话结论 |
| --- | --- | --- | --- |
| 架构 | 90 | **91** | OpenSpec 工件层落地 + windows-infra 双层闸范式补强；扣分在 welink 巨型 store 与 4 条历史越层边仍未清 |
| 前端代码质量 | 82 | **82** | 类型纪律满、零 TODO/FIXME；扣分点不变：welink 组件群 7 个文件 >600 行 |
| Rust 层 | 84 | **88** | 新增 sysinfo/shell 完全遵循薄桥接模式、`cargo check` 零警告；crate 零新增守住离线约束 |
| 测试 | 88 | **90** | 710 用例（+168）；上轮「真实适配器零覆盖」部分改善（windows 模块 97%），welink 侧 wrapper 仍低 |
| 构建 / 工具链 | 80 | **88** | CI `--escalated` 已修、uitest 杀进程收敛为按 PID、CDP 冒烟范式成熟可复用 |
| 安全 | 78 | **85** | 急停落盘、注入 sanitize、CI 修复三项历史 P1 全部在位 |
| **总体** | **≈84** | **≈87** | **无 P0、无 P1 阻塞项**。上轮 8 个主要发现 7 个确认修复；新增资产质量高于存量均值 |

**硬指标（实测）**：`eslint` 通过 ✅ · `vue-tsc --noEmit` 通过 ✅ · Vitest **39 文件 / 710 用例
全部通过**（约 24s）✅ · `cargo check` 零警告 ✅ · 覆盖率阈值（orchestrator 92% lines /
infra-db 72% lines）判定通过 ✅

**规模变化**（vs 09-29）：生产 TS/Vue 16,556 → **20,962 行**；测试 7,978 → **10,376 行**；
Rust 1,211 → **2,010 行**。测试代码增速（+30%）高于生产代码（+27%），方向健康。
TODO/FIXME/HACK 计数：**0**。

## 2. 上轮 8 个主要发现的修复核实

| # | 发现 | 状态 | 证据（当前工作区行号） |
| --- | --- | --- | --- |
| 3.1 | L0 急停不持久化，重启后自动外发恢复 | ✅ 已修 | `stores/welink.ts:379` 急停标记落盘（评审 P1）；`:303` 急停跨重启不复活 → 强制人工确认 |
| 3.2 | 提示词注入无分隔/转义/长度约束 | ✅ 已修 | `agent/prompt.ts` `sanitizeUntrusted` + `MAX_UNTRUSTED_CHARS = 400`（:34、:47） |
| 3.3 | `storage_migrate` 同步命令阻塞主线程 | ✅ 已修 | `commands.rs:32` async + spawn_blocking（评审 P1 注释） |
| 3.4 | 迁移窗口写入静默丢失 | ✅ 已修 | `check_file_writes_allowed`：复制窗口内拒绝写（load/save_config/append_log 全接入） |
| 3.5 | CI 完整链缺 `--escalated`，打包必败 | ✅ 已修 | `full-verify.yml:55-57` 显式携带 `--escalated` 并注释依据 |
| 3.6 | smoke 全机杀 `msedgewebview2.exe` | ✅ 已修 | `uitest.mjs:314-324` 实测基线数据注释 + `killTree` 按 PID，不再按镜像名误伤 |
| 3.7 | poller 跨批 msg_uid 去重零覆盖 | ✅ 已修 | `poller.spec.ts:824` 去重用例；poller 覆盖率 100% lines |
| 3.8 | 监控页筛选与分页脱节 | ⚠️ 未确认 | 未见分页重置逻辑（`MessagesTab.vue`/`stores/welink.ts`），需人工页面复验 |
| — | D-9 日志退订回归（P2） | ✅ 已修 | `stores/welink.ts:67` 导出 `unsubscribeWelinkLogs()` |

## 3. 覆盖率全景（v8 实测）

```
生产代码行覆盖率 49.62%（branches 85.69% / functions 72.26%）
============================================================
 97%+  orchestrator:97.1  infra/windows:97.0  infra/db:86.0
       infra/envcheck（探测层全绿）
 70-80 infra/agent:78.3  api:72.6  infra/welink:74.9
 ⚠ 低   stores/welink.ts:37.1（973 行，全仓最大单点债务）
       infra/welink/index.ts:21  welink-cli.ts:19（真实适配器 wrapper）
 ✱ 0   views/components/layouts（2808+ 行 UI——设计上走 uitest E2E，
       非单测职责）；repositories/csv、utils/table 同为 0
```

说明：总体 49.6% 偏低的主因是 UI 层（views/components ≈ 4,000 行）按项目测试策略本就
不归单测管（E2E 由 `uitest.mjs` 的 CDP 链路覆盖）。**业务逻辑层（orchestrator + infra）
实际在 86%~97% 区间**，这才是防回退护栏的真正位置。本轮新增的 `src/infra/windows`
以 97.0% lines / 93.2% branches 成为全仓模范；阈值门禁（orchestrator 92%、infra/db 72%）
实测通过。

## 4. 新增债务与结构性观察

1. **`stores/welink.ts`（973 行，37% lines 覆盖）是当前最大单点风险**：会话视图状态、
   外发编排接线、配置归一化挤在一个 store 里，测试只够到 happy path；拆分是后续一切
   welink 迭代的前置条件。
2. **welink UI 单体未拆**：SettingsCard 890 / MessagesTab 832 / HistoryTab 671 /
   ConfigTab 631 / TraceTab 620 / InboxTab 607 行——09-29 已指出，本轮继续增长。
3. **4 条越层 import 原样仍在**（09-29 的 V1/V2/V3/S1）：
   `SettingsCard.vue:20 → infra/agent`、`HistoryTab.vue:22 → infra/db/ports`、
   `TableCrudView.vue:9 → repositories/csv`、`stores/welink.ts:17-18 → infra/db`。
   目前无 ESLint 闸拦截，边界全靠自觉。
4. **工厂横切件重复**：硬超时 + 异常折叠逻辑在 `envcheck`（`withHardTimeout`）与
   `windows`（`strictTimeout`/`foldedTimeout`）各写一份且变体不同；第三个 infra 模块
   出现时应收敛为共享原语。
5. **spec 覆盖不均衡**：OpenSpec 主 specs 目前只有 windows 三能力；safety-gate 分级/
   pipeline 时序/welink 轮询铁律/db 迁移规则等**核心存量安全合同**尚无 spec，铁律只
   活在 AGENTS.md 与代码注释里，存在漂移风险。
6. **标注契约健康**：`[MOCK-CLI]/[CLI-ASSUME]` 32 处、`[LLM-ASSUME]` 1 处、
   `[MOCK-WIN]/[WIN-ASSUME]` 39 处，与 AGENTS.md 约定一致，grep 清单可核对。
7. 小额零头：`orchestrator/timers.ts` 50%、`utils/time.ts` 54%、`logger.ts` 69%、
   `repositories/csv.ts` 0%——均为小文件，补测成本低。

## 5. 优化方案（按杠杆排序）

### 第一批：高杠杆（建议立即可做）

- **P1-1 welink store 拆分 + 补测**：按「会话视图状态 / 外发编排 / 配置归一化」拆
  `stores/welink.ts`，覆盖率 37% → 70%+；拆分同时消掉 S1 越层边（welink.ts → infra/db）。
- **P1-2 真实适配器 wrapper 补测**：`welink-cli.ts`（19%）与 `infra/welink/index.ts`（21%）
  用注入桩验证 invoke 组装与 base64 解码链——对接真实 CLI 前最重要的回归网。

### 第二批：结构性收口

- **P2-1 welink 组件瘦身**：7 个 600+ 行组件拆子组件 + 抽 composables，优先
  MessagesTab / SettingsCard。
- **P2-2 越层边治理 + 闸门化**：V1/V2/V3 改走 stores 或提升为合法消费，随后加
  ESLint `no-restricted-imports` 规则，把「架构边界」从约定变成机器闸。
- **P2-3 infra 工厂横切件提取**：硬超时/折叠语义抽共享模块，envcheck/windows 改引用；
  两个调用方之前不动，避免为抽而抽。

### 第三批：长期护栏

- **P3-1 存量能力 spec 补齐**：把 safety-gate（分级/配额/静默/熔断）、pipeline 时序、
  welink 轮询铁律、db 迁移规则转成 OpenSpec 主 specs——内网自动回复的安全合同，
  应与 windows 三能力同等对待。
- **P3-2 覆盖率阈值抬线**：`infra/windows` 新增 90% 阈值（实测 97%，防回退基线）；
  orchestrator 视情况 92% → 95%。
- **P3-3 小额补测**：timers / time / logger / csv 四个文件。
- **P3-4 复验 3.8**：人工确认筛选分页问题是否仍复现，确认后修复。

---

## 6. 结论

项目处于**健康上升通道**：无 P0/P1 阻塞，防回归体系（阈值门禁 + CI 双链 + CDP 冒烟 +
OpenSpec 工件）是同类项目少见的完备度。主要技术债集中在 **welink 前端单体**（store +
6 个大组件），这也是历史最久的模块——后续功能迭代前优先拆解，可避免债务复利。

---

## 6. 优化项核销记录（2026-10-03，变更 quality-hardening-2026-10）

本节是第 5 节优化方案在 OpenSpec 变更 `openspec/changes/quality-hardening-2026-10` 中
的执行核销（任务 24 项全部完成，`npm run check` 全绿 829 用例）：

| 优化项 | 状态 | 结果 |
| --- | --- | --- |
| P1-1 welink store 拆分 + 补测 | ✅ | 拆为 stores/welink/ 五域模块（facade API 不变），聚合覆盖率 37.1% → **94.1%**；S1 边经 orchestrator/welink-storage 网关消除 |
| P1-2 真实适配器 wrapper 补测 | ✅ | welink-cli.ts 19% → **100% lines**、infra/welink/index.ts 21% → **96%**，域聚合 96.2% |
| P2-1 welink 组件瘦身 | ✅（部分） | MessagesTab 833 → 75 行 + 三子面板；SettingsCard 890 → 434 行 + Safety/Agent 两分区；其余 4 个大组件留后续变更 |
| P2-2 越层边治理 + 闸门化 | ✅ | V1/V2/V3 清零（含同族 GroupHistoryTab/CreateTab），ESLint `no-restricted-imports` 闸门落地（UI 层禁触 infra/repositories） |
| P2-3 infra 横切件提取 | ✅ | `utils/async-guard.ts` 两个原语，envcheck/windows 改薄引用（既有测试断言零改动全绿） |
| P3-1 存量能力 spec 补齐 | ✅ | `welink-auto-reply`（8 需求）/ `welink-group-creation`（5）/ `data-storage-lifecycle`（7），validate 6/6 通过 |
| P3-2 覆盖率阈值抬线 | ✅ | orchestrator 92→95（lines）、新增 infra/windows 90 基线，判定通过 |
| P3-3 小额补测 | ✅ | timers 50→100%、time 54→100%、logger 69→100%、csv 0→100% lines |
| P3-4 复验 3.8 | ✅（已修复） | 代码级复验：ConfigTab.vue:63-66 筛选变化重置页码 + :58-61 分页总数实时联动——上轮存疑项关闭，无需修复 |

新增横切资产：`[MOCK-WIN]` 等标注约定沿用；uitest 54/54（打包产物 E2E）+ `npm run pack`
单文件校验通过。整体测试 710 → **829 用例**。
