# Design

## Context

实测基线见 `docs/quality-report-2026-10-02.md`：总体 ≈87 分、无 P0/P1，测试 710 用例全绿。
本变更处理报告点名的三类债务（welink 前端单体 / 边界靠自觉 / 安全合同缺 spec）。
关键代码事实（设计依据，均已读码确认）：

- `stores/welink.ts`（973 行）是**单 facade store**：模块级日志旁路 + `useWelinkStore` 内
  混居「事件补丁 / 视图分页 / 运行控制 / 聚合计算」四类职责；7 个组件 + WeLinkView 只
  消费这一个导出面。
- 越层边的真实形态：S1 = `repo(): WelinkRepository { return welink() }`（:971，绕过
  已暴露 `repo` 的 `WelinkRuntime`，runtime.ts:45）+ `:278` 直调 `dbMigrateAll`；V2 =
  展示常量（`JOB_STATUS_LABEL` 等 4 个）住在 `infra/db/ports`；V1/V3 = 组件/视图直消费
  infra 工厂与 repositories。
- **stores 消费 infra 工厂是文档化的组合点模式**：`envcheck.ts → createEnvChecks`、
  `table.ts → recordsBackend`、`group.ts → groupClient/group` 均如此（Q3/D5 浏览器
  内存实现的装配点）——闸门设计必须尊重这个现实，不能一刀切。
- ESLint 为 flat config（`eslint.config.mjs`），已有 `no-restricted-imports` 先例
  （:112 禁 `@tauri-apps/api`），加规则是既有范式不是新机制。
- 硬超时/折叠横切件现有两份：`envcheck/port.ts withHardTimeout`（ProbeResult 专用、
  折叠 rejection）与 `windows/index.ts strictTimeout/foldedTimeout`（泛型、传播/折叠
  两态）——语义可用「rejection 处理策略」参数统一。

## Goals / Non-Goals

**Goals:**

- welink store 拆分后公共 API 不变（组件零改动），业务逻辑层覆盖率显著提升（37% → 70%+）。
- UI 层（views/components）与 infra/repositories 之间建立**机器闸**，V1/V2/V3 清零后落地。
- 存量核心能力获得 OpenSpec 主 specs（描述现状，安全合同可被后续变更 delta 引用）。
- 覆盖率阈值抬线到实测值之下留余量的位置（防回退，非指标竞赛）。

**Non-Goals:**

- 不把 envcheck/table/group 的 store 组合点收编进 orchestrator（见 D2 的被拒方案）。
- 不在本轮拆完 6 个 welink 大组件（只做 MessagesTab / SettingsCard 两个优先项，
  其余留后续 change）。
- 不改任何用户可见行为；不做真实 CLI/LLM 对接（`[CLI-ASSUME]`/`[LLM-ASSUME]` 不动）。

## Decisions

### D1. welink store 拆分 = 单 facade + 内部域模块，不做三 store

- **选择**：`src/stores/welink.ts` → `src/stores/welink/` 目录：`index.ts`（facade 装配 +
  日志旁路，保持 `useWelinkStore` 等全部既有导出）、`events.ts`（WelinkEvent → 状态补丁
  的纯函数）、`view.ts`（会话选择/分页/时间线/存档计数）、`control.ts`（runtime 装配与
  start/stop/L0/熔断/静音）、`aggregate.ts`（聚合口径纯函数）。内部模块以
  `createXxx(deps)` 工厂形态接收状态容器与编排层依赖，facade 负责组装——纯函数部分
  可脱离 Pinia 直测，这是覆盖率 70%+ 的主要来源。
- **被拒方案一**：拆成三个 Pinia store → 7 个消费组件全部改 import，爆炸半径大而
  行为收益为零，违反「行为不变」目标。
- **被拒方案二**：只抽 composables 不动文件结构 → 文件仍然 900+ 行，「单点债务」
  没有实质性收敛。
- 测试策略：现有 `welink.spec.ts` 按域迁入同目录 `*.spec.ts`；纯函数模块（events/
  aggregate/view 的无副作用部分）新增直测。

### D2. S1 边修复 = orchestrator 存储网关，展示常量迁往 types 层

- **选择**：新增 `src/orchestrator/welink-storage.ts`：`ensureWelinkStorage()`（迁移 +
  幂等）与 `getWelinkRepo()`（懒建仓储单例，浏览器模式自动内存实现——装配逻辑从
  store 上移到编排层）。welink store 的 `dbMigrateAll` 调用与 `repo()` 全部改走网关。
- **展示常量**：`HOLD_REASON_LABEL` / `JOB_STATUS_LABEL` / `SKIP_REASON_LABEL` /
  `CONVERSATION_PAGE_LIMIT` 迁至 `src/types/welink.ts`（types 是 stores/components 的
  合法依赖层），`infra/db/ports` 原地 re-export 保持 infra 内部与既有测试兼容——V2 边
  随之消失且无行为变化。
- **被拒方案**：把 envcheck/table/group 的 store → infra 组合点一并收编 orchestrator →
  三个 store 的装配链全部重写，纯结构调整却波及建群/环境检测两条已验证链路，
  风险收益不成比例。**组合点模式合法化**写入 AGENTS.md（「store 可消费 infra 工厂作
  装配点；业务逻辑仍归 orchestrator」），本轮闸门不覆盖 stores 层（D4）。

### D3. 组件瘦身本轮只做两个，手段是「子组件 + props/emits」

- `MessagesTab.vue`（832）拆：会话列表 / 任务列表 / 右栏详情三个子组件；
  `SettingsCard.vue`（890）按设置分区拆卡片级子组件。逻辑下沉优先复用 welink store
  既有方法（动作即映射），**不新建业务逻辑**。
- 快照兜底：拆分前后 `npm test` 全绿 + uitest 冒烟（`npm run uitest` 驱动打包产物）
  页面可交互。
- 其余 4 个大组件（HistoryTab/ConfigTab/TraceTab/InboxTab）显式留待后续 change，
  避免单变更爆炸。

### D4. ESLint 闸门范围 = UI 层禁触 infra/repositories

- **选择**：`eslint.config.mjs` 对 `src/views/**` 与 `src/components/**` 施加
  `no-restricted-imports` patterns：禁止 `@/infra/**`、`@/repositories/**`（V1/V2/V3
  清零后立即落地，不留中间态）。
- **被拒方案**：同时禁止 stores → infra → 见 D2：组合点模式是设计内行为，机械规则
  无法区分「工厂装配」与「绕层业务」，硬闸会逼出为过闸而生的透传包装层，净复杂度
  上升。stores 层边界靠评审 + AGENTS.md 口径约束，报告后续轮次观察。

### D5. 横切件提取 = `src/utils/async-guard.ts` 两个原语

- `withHardTimeout(task, timeoutMs, onTimeout)`：超时确定性完成（定时器 settle 后必须
  清除——envcheck 注释里的教训）；`foldRejection(task, onFailure)`：rejection 折叠为
  失败结果。`envcheck/port.ts` 与 `windows/index.ts` 改为薄引用（各自语义经参数表达：
  envcheck 的折叠策略、windows 的传播策略）。**验收 = 两个模块现有 spec 不改一行
  断言全绿**——语义未漂移的机械证明。
- **被拒方案**：不提取（容忍两份）→ 第三个 infra 模块出现时必然出现第三份变体；
  提取成本低（两个原语 + 参数化），现在做最便宜。

### D6. 存量 spec 补齐 = 三个能力主 specs，现有测试是真值来源

- `welink-auto-reply`：轮询→草稿→安全闸→外发全链（L0-L3 分级、O7 配额、O11 静默、
  S8 熔断、pending→ready 铁律、急停落盘）。
- `welink-group-creation`：pending 留痕、原子终态回写、禁传输层重试。
- `data-storage-lifecycle`：数据根/引导文件/迁移/日志保留。
- 需求与场景从 AGENTS.md 铁律 + 现有 710 用例提取（测试即现状的权威描述），每个
  spec 控制在 4~8 条需求——写「已成立且被测试钉住的行为」，不写愿景。直接写
  `openspec/specs/`，不经 delta 流程（本变更 `skip_specs: true`）。

### D7. 阈值抬线：只抬到实测值减 2~3 个百分点的防回退位

- `infra/windows`：lines 90 / statements 90 / functions 75 / branches 88（实测
  97.0/97.0/80/93.2）。
- `orchestrator`：lines 92→95、statements 92→95、functions 88→90、branches 85→88
  （实测 97.1/97.1/93/92）。
- 抬线后立即跑 `npm run test:coverage` 确认全绿；阈值语义是防回退基线，不追高点。

## Risks / Trade-offs

- [store 拆分引入状态共享 bug] → 拆分是纯搬移：现有 welink.spec 全部断言不动、按域
  迁移；内部模块纯函数化后新增直测；`npm run check` 每组收尾全绿。
- [ESLint 新规则误伤未发现的合法 import] → 落地前先以 warn 跑全量盘点清单，确认
  仅 V1/V2/V3 命中后再切 error（同一变更内完成，不留 warn 中间态提交）。
- [组件拆分引入 props/emits 传值错漏] → 优先两个组件、子组件保持纯展示（逻辑留
  store）；uitest 冒烟驱动打包产物做端到端确认。
- [spec 补齐与实现漂移] → 需求逐条标注来源测试文件；后续改行为时 delta 流程会
  对照主 specs，漂移在 validate 时暴露。
- [阈值抬线在 Windows/CI 环境间波动] → 抬线幅度留 2~3 个百分点余量（D7），
  不贴着实测值设线。

## Migration Plan

纯内部重构，无数据迁移、无接口变更（facade 导出面不变）。每组任务收尾
`npm run check` 全绿再进下一组；任何一组回滚 = 还原该组文件，不影响其他组。
ESLint 闸门在 V1/V2/V3 清零的同一组任务内落地（warn 盘点 → error 生效）。

## Open Questions

无——影响设计与任务拆分的事实均已读码确认；3.8（筛选分页）本身就是一个验证
任务而非未决设计问题。
