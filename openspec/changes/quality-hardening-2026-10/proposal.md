# Proposal

## Why

`docs/quality-report-2026-10-02.md` 实测评估给出总体 ≈87 分（无 P0/P1 阻塞），但指出
三类值得在下一轮功能迭代前处理的债务：**welink 前端单体**（store 973 行 / 37% 覆盖，
6 个 600+ 行组件）是后续迭代的最大风险；**架构边界靠自觉**（4 条越层 import 无机器闸）；
**核心安全合同缺 spec**（safety-gate/pipeline/轮询/迁移铁律只活在注释里）。趁当前无
阻塞项、测试全绿的窗口期集中收口，避免债务在后续功能迭代中复利。

## What Changes

全部为重构 / 补测 / 工具链 / 文档工作，**不改任何用户可见行为**：

- **第一批（高杠杆）**
  - 拆分 `stores/welink.ts`（973 行 → 会话视图 / 外发编排 / 配置归一化三块），
    覆盖率 37% → 70%+，同时消掉 `welink.ts → infra/db` 越层边（S1）；
  - 补测真实适配器 wrapper：`infra/welink/welink-cli.ts`（19%）、`infra/welink/index.ts`
    （21%），注入桩验证 invoke 组装与 base64 解码链。
- **第二批（结构性收口）**
  - welink 大组件瘦身（MessagesTab 832 / SettingsCard 890 等 6 个，拆子组件 +
    composables，行为不变）；
  - 越层边治理：`SettingsCard → infra/agent`（V1）、`HistoryTab → infra/db/ports`（V2）、
    `TableCrudView → repositories/csv`（V3）改走合法路径，随后加 ESLint
    `no-restricted-imports` 规则把分层边界闸门化；
  - 提取 infra 工厂横切件（硬超时 + 异常折叠），`envcheck` / `windows` 改引用，
    消除双份变体实现。
- **第三批（长期护栏）**
  - 存量能力 spec 补齐：把 safety-gate（分级/配额/静默/熔断）、pipeline 时序、welink
    轮询铁律、db 迁移规则写成 OpenSpec 主 specs（直接补 `openspec/specs/`，描述现状
    行为，非 delta）；
  - 覆盖率阈值抬线：`infra/windows` 新增 90% 防回退阈值（实测 97%）；orchestrator
    92% → 95%；
  - 小额补测：`orchestrator/timers.ts`（50%）、`utils/time.ts`（54%）、`utils/logger.ts`
    （69%）、`repositories/csv.ts`（0%）；
  - 复验上轮报告 3.8（监控页筛选分页脱节）：人工确认是否复现，复现则修复（唯一可能
    触碰行为的项，修复前单独确认）。

**非目标**：不做新功能；不动 welink-cli / LLM 的对接假设（`[CLI-ASSUME]`/
`[LLM-ASSUME]` 待对接期统一核实）；不改打包链路与 Rust 命令面。

## Capabilities

### New Capabilities

（无——本变更为重构 / 补测 / 工具链 / 文档，无 spec 级行为变更，
`.openspec.yaml` 声明 `skip_specs: true`。第三批的存量 spec 补齐直接写
`openspec/specs/` 主 specs、描述既有行为，不产生本变更的 delta。）

### Modified Capabilities

（无既有 spec 需求变更。）

## Impact

- **TS**：`src/stores/welink.ts` 拆分（对外导出面保持兼容，`views`/`components` 消费方
  少量改 import）；`src/infra/welink/`、`src/infra/envcheck/`、`src/infra/windows/` 横切件
  抽取；`src/components/welink/` 组件拆分。
- **构建**：`vitest.config.ts` 覆盖率阈值调整（`infra/windows` 新增、orchestrator 抬线）；
  `eslint` 配置加 `no-restricted-imports` 分层规则。
- **文档**：`openspec/specs/` 新增 4~5 个存量能力主 specs；`docs/quality-report-2026-10-02.md`
  的优化项逐项核销。
- **风险**：store/组件拆分是纯搬移，靠「拆分前后快照测试 + typecheck + 710 用例全绿」
  兜底；ESLint 新规则落地时若存量违规未清完会红——规则与本变更内的治理同步落地，
  不留中间态。
