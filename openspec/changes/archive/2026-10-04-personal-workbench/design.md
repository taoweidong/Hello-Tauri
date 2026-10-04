# Design

## Context

见 proposal.md「Why」。落笔前的关键现状：

- `src-tauri/src/cli.rs` 已是**通用子进程薄管道**（`cli_run`：白名单 `ALLOWED_STEMS` +
  参数数组不经 shell + 2MB 输出截断 + 15s 默认超时 + base64 回传），welink-cli、
  python 探测、Windows 诊断命令都是它的消费方——codehub-cli 无需新建 Rust 通道。
- `src/infra/welink/` 已确立端口-适配器形态：`port.ts`（接口 + 错误分类
  transport/parse/auth）+ `exec.ts`（通用执行）+ `commands.ts`（命令拼装）+
  `mock.ts`（测试替身/浏览器数据源）；`WelinkPort.pull` 的游标分页语义可直接借鉴。
- SQLite 表结构归 TS 管（migrations 注册表 + 通用 db 命令），当前至 v3。
- 概览页（DashboardView）与侧栏（路由表 `navRoutes()` 单一真值派生，A-1）已存在。
- 配置页已有「大模型连接」先例：用户自配地址/密钥，存 `config.json`。

## Goals / Non-Goals

**Goals**

- codehub-cli 接入只花一行 Rust 白名单成本，其余全部在 TS 分层内完成。
- CLI 真实契约未知的前提下，UI/管线/快照行为先由 mock 锁定，对接期只换适配器。
- 内网离线不破防：检视数据全部本地快照，CLI 不可达时只读降级。

**Non-Goals**

- 不做 MR 写操作（评论/批准/合并）；不做 GitHub/GitLab 云端接入；不做多宿主
  适配器实现（仅预留 Port 边界）；不引入 Rust HTTP 通道；不改 welink 域行为。

## Decisions

### D1 通道：复用 `cli_run`，Rust 仅白名单 +1

`ALLOWED_STEMS` 增加 `"codehub-cli"`（附用途注释）。备选：
(a) 新增专用命令 `run_codehub_cli`——拒绝，`cli.rs` 本就是通用薄管道，welink-cli
同构接入，重复命令违背「Rust 无业务规则」；(b) WebView fetch REST——拒绝，内网
CodeHub 无公网可达性，且用户已决策走 CLI 机制。程序完整路径来自用户连接配置，
白名单只校验文件主干（与 welink-cli 一致），不做 PATH 自动发现，收窄误用面。

### D2 infra/codehub 端口-适配器（对齐 infra/welink 形态）

```
src/infra/codehub/
  port.ts        CodeHubPort 接口 + 归一化类型 + CodeHubError(transport/parse/auth)
  mock.ts        [MOCK-CLI] 测试替身与浏览器调试数据源
  codehub-cli.ts 命令拼装 + JSON 解析，[CLI-ASSUME] 假设集中标注于此
  exec.ts        通用执行装配（路径取连接配置、超时、b64 解码/编码兜底复用 utils/b64）
  index.ts       工厂 createCodeHub({ bridge, config })
```

Port 面收窄为三个方法（对接期返工面最小）：
`listMergeRequests(repo, opts)`、`getMergeRequestDetail(repo, iid)`、`verifyConnection()`。
备选：按 REST 资源形状铺满方法面——拒绝，真实 CLI 契约未知，先窄后宽。

### D3 CLI 契约：打桩先行，假设全部显式标注（[CLI-ASSUME]）

本期以打桩模拟真实场景：UI/管线/快照行为全部由 `[MOCK-CLI]` 替身锁定，
`CodeHubPort` 即为后续对接真实接口预留的接缝——对接期只换适配器实现，上层零改动。
仍为假设并集中标注在 `codehub-cli.ts`（对接前 `grep -rn "CLI-ASSUME" src/` 逐项
核实）的项：子命令语法 `mr list --repo <id> --state <s> --format json`、
`mr view <iid> --repo <id>`、JSON 输出字段（iid/title/state/author/
source_branch/target_branch/updated_at/检视摘要）、UTF-8 文本输出。
已确认不再属于假设的项：token 以命令行参数注入（用户决策，见 D6）。

### D4 数据模型（migration v4）：三表快照

- `codehub_repos`：用户注册仓库（仓库标识/名称/启用）。
- `codehub_mrs`：快照表，仓库标识+MR 唯一键**覆盖写**；可筛字段列存
  （state/author/updated_at/检视状态摘要），详情 JSON 列存全量。
- `codehub_sync_state`：每仓库最后成功同步时间、最近错误摘要。

**实现期修正（与落地代码对齐）**：

- **没有游标列**。本期同步语义是「每轮按批上限全量重拉」（`CODEHUB_MAX_BATCH=200`），
  upsert 幂等，游标只是空转；真实 CLI 若提供增量游标，届时另立变更加列（v5）。
- **覆盖写只增改不删**：远端已消失的 MR 会残留在本地快照里。取舍是刻意的——只读
  快照的价值在「最后已知状态」，按轮次差集删除会让一次同步失败误伤成「数据丢失」；
  真正的清理入口是删除仓库时的显式级联（同事务删 `codehub_mrs` + `codehub_sync_state`）。

备选：(a) 全 JSON 单表——筛选要读 JSON，弃；(b) 规范化 review/comment 子表——
只读快照无关联查询需求，过度规范化，弃。快照覆盖写不留历史，数据量有界
（spec「快照落库与离线只读降级」）。

### D5 同步管线：orchestrator/codehub-sync.ts

一轮同步 = 遍历启用仓库 → `listMergeRequests` → 归一化 → `db_transaction` 覆盖
upsert → 回写同步状态。复用既有 `timers`/`poller`/`runtime` 组件；手动刷新 +
周期轮询（间隔用户可配，**下限钳制 60s，默认手动优先**）；失败退避沿用 welink
管线参数风格；纯只读，不接 safety-gate（其开关/配额/静默时段语义针对外发）。

**降级信号的着陆点（实现期定稿，原「截断时弃详情保列表」的可观测化）**：
子进程输出触到宿主 2MB 截断上限时，适配器按花括号深度抢救完整元素、丢弃残缺的
尾元素，并把降级事实**上抛为端口契约的一部分**——

```
CodeHubPort.listMergeRequests → { records, degraded: stdoutTruncated }
  → 编排层累积 degraded: string[]（每轮摘要 CodeHubSyncSummary.degraded）
  → logger.warn（每仓库一条，含已入库条数）
  → 检视页状态条 .pill--degraded（「本轮数据可能不完整」）
```

三条约束：`degraded` 非空时 `phase` 仍可为 `ok`（数据有效，只是可能少了尾巴）；
**不**写 `codehub_sync_state.last_error`（那是失败通道，混入降级会让「保留旧快照」
的语义失真）；批上限 `CODEHUB_MAX_BATCH=200` 单一真值在 `types/codehub.ts`，
适配器钳制与配置页输入 `max` 共用同一常量。降级只在真机 CLI 截断时触发，
mock 端口恒 `degraded:false`。

### D6 凭据：连接配置沿用大模型连接模式，token 走命令行参数 + 全链路脱敏

连接配置节（cliPath/token/interval/enabled）存 `config.json`；配置页新增
「CodeHub 连接」节（CLI 接口路径选择 + token 输入 + 连通验证按钮）——均为用户
显式配置项（用户决策点 2）。token 注入方式已确认为**命令行参数**：脱敏随之升级为
硬约束——exec 组装诊断信息与任何日志输出 MUST 剔除/遮蔽 token 参数值（spec
「token 全链路脱敏」），logger 出口对配置类日志统一遮蔽。

### D7 工作台首页与导航：单一真值不变

分组声明进路由 `meta.group`，`navRoutes()` 派生时带出分组字段，`MainLayout`
按分组渲染；未声明分组的带图标路由归入默认组（A-1 不变量「有图标必可达」不被
分组破坏）。DashboardView 升级为卡片网格：welink 待处理数、codehub 待检视数、
存储状态、快捷入口。uitest/smoke 对导航标题的断言同步更新。

### D8 store 装配走 D2 组合点例外

`src/stores/codehub.ts` 消费 `infra/codehub` 工厂做装配（同 `envcheck.ts`/
`group.ts` 先例）：桌面模式真实适配器 + SQLite 快照，浏览器模式 mock 适配器 +
内存快照；业务编排除外。UI 层不直触 `@/infra/**`（ESLint 闸门原样生效）。
web.ts 的 `cliRun` 保持既有 stub 行为（浏览器模式根本不走子进程）。

**实现期修正**：装配范围含 `createCodeHubSyncer` 与 `createDetailBackfill` 两个
编排模块。后者的存在是因为「点详情才补拉」会起子进程，需要**在飞去重**（连点同一
条 MR 不能排起 N 个进程）——这是调度规则，不是状态聚合，所以落在
`orchestrator/codehub-detail.ts`，store 只转发（D8 的「编排不在 store」原意）。
轮询生命周期同样不随页面卸载消失：`store.init()` 由 `App.vue` 启动装配与配置页保存
共同触发，页面 `onMounted` 只是幂等复用同一次装载。

### D9 测试策略

新增模块同目录 `*.spec.ts`；`mock.ts` 不计覆盖率；同步管线状态机（成功/部分
失败/退避/覆盖写幂等/截断降级）重点覆盖，orchestrator 92% lines 基线不回退；
CLI 适配器用注入假 `cliRun` 的方式测，不依赖真实 codehub-cli。

## Risks / Trade-offs

- **[CLI-ASSUME] 契约全是假设，对接期可能返工** → Port 面收窄至 3 方法；归一化层
  隔离字段映射；mock 先行锁定 UI/管线/快照行为；假设标签集中可检索。
- **codehub-cli 实际不存在或输出非 JSON** → 适配器 parse 层失败归类明确（不重试
  刷日志）；spec 的行为需求（快照/筛选/离线降级）不依赖具体 CLI 形态，契约核实
  只影响 `codehub-cli.ts`。
- **同名程序冒充（白名单按主干校验）** → 路径仅来自用户显式配置；配置页展示完整
  路径供人工确认；文档注明风险。
- **轮询拖累内网服务** → 间隔下限钳制 60s、默认关闭自动同步、失败退避加倍。
- **详情 JSON 超大撑爆 IPC** → 既有 2MB 截断兜住体积，截断不再静默：完整元素照常
  入库、残缺尾元素丢弃，整轮标记降级并经摘要/告警/状态条三级上报（D5）。
- **降级被当成成功**（用户以为快照是全的） → 降级信号是端口契约字段而非旁路日志；
  `phase='ok'` 与 `degraded` 非空可共存，UI 必须同时呈现两者。
- **覆盖率基线回退** → 分组任务各自收尾跑 `npm test`；orchestrator/db 新文件全部
  带测试落地后再进下一组。

## Migration Plan

无存量数据风险：v4 仅新增三表，不改旧表，旧域零感知；回滚 = 不进新页面，残留
表无害。合入顺序按任务分组依赖：infra → db → orchestrator → store/配置 → UI；
每组收尾 `npm test` 全绿后再进下一组。

## Open Questions

- codehub-cli 真实命令面与输出格式：对接期核实（打桩已锁行为，不阻塞本期）。

已裁决（本轮用户确认，不再是开放问题）：token 以命令行参数注入（见 D6）；
「待检视」判定与筛选本期不做，待真实 CLI 契约明确后另立变更。
