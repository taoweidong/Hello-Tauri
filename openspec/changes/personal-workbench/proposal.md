# Proposal

## Why

当前应用是 WeLink 垂直工具（自动回复 + 快速建群），用户的日常工作还需要在内网
CodeHub 上跟进 MR 的合并与检视进展，但内网环境无法访问 GitHub/GitLab 云端 API，
信息只能靠登录网页逐个翻查。本次将应用升级为「个人工作台」：概览页升级为聚合各
工作域的首页，并新增「CodeHub 检视」域——通过内网 codehub-cli 工具（机制对标
GitHub 的 gh CLI）拉取 MR 合并与检视信息，落库快照、离线可查。数据通道走既有
通用子进程闸门（`cli_run`），与 welink-cli 完全同构，内网离线约束不被打破。

## What Changes

- **概览页升级为「工作台首页」**：域卡片聚合（WeLink 助手 / CodeHub 检视 / 数据管理 /
  环境检测）、快捷入口与关键摘要；侧栏导航按分组展示（工作台 / WeLink / CodeHub / 系统）。
  既有各域功能行为不变。
- **新增 CodeHub 检视域**（数据源 = codehub-cli 子进程，复用 welink-cli 既有模式）：
  - `src/infra/codehub/` 端口-适配器：`CodeHubPort` 接口 + `mock.ts` 测试替身（标
    `[MOCK-CLI]`）+ codehub-cli 真实适配器（对 CLI 的接口假设一律标 `[CLI-ASSUME]`，
    对接真实工具前逐项核实）。
  - **连接配置**：codehub-cli 可执行路径与访问 token 均由用户在配置页填写（token 存储
    沿用大模型连接配置的既有方式，调用时以命令行参数注入），调用侧与日志侧脱敏。
  - **SQLite 快照**（新 migration v4）：注册仓库表、MR 快照表（标题/状态/作者/分支/
    更新时间/检视摘要/详情 JSON）、同步状态表（每仓库最后成功时间与最近错误；本期
    无游标列，按批上限全量重拉）；断网或 CLI 不可用时展示最后同步快照（只读降级）。
  - **同步管线**（orchestrator）：手动刷新 + 可配置周期轮询，失败退避；纯只读、无外发，
    不涉及 safety-gate。
  - **检视页**：按仓库分组、状态筛选（开启 / 已合并 / 已关闭）、MR 详情视图（快照缺
    详情时按条补拉）、最后同步时间与手动刷新。
- **Rust 侧仅一处薄桥接改动**：`cli.rs` 的 `ALLOWED_STEMS` 白名单增加 `codehub-cli`
  （无新增命令、无业务规则，通用子进程通道原样复用）。
- **web（浏览器）模式**：Bridge 的 web 实现为 codehub-cli 返回模拟数据，保持全部页面
  无 Rust 可调试。

**不做（本期）**：
- 不接 GitHub/GitLab 云端 API（内网不可达）；Port 设计不绑 CodeHub 特有字段，为后续
  多宿主（如 gh CLI）预留适配器位。
- 不做 MR 写操作（评论 / 批准 / 合并一律只读）。
- 不做「待检视」判定与专属筛选（口径依赖真实 CLI 契约，本期状态筛选覆盖
  开启 / 已合并 / 已关闭，待检视待对接后另立变更）。
- 不新增 Rust HTTP 通道（决策点 3：传输一律走 CLI 机制）。

## Capabilities

### New Capabilities

- `workbench-home`: 工作台首页与导航信息架构——域卡片聚合、快捷入口、摘要展示、
  导航分组；守护「各域功能不被首页改造破坏」的边界。
- `codehub-review`: CodeHub MR 检视信息域——连接配置（路径/token 用户配置）、
  codehub-cli 通道契约（含 `[CLI-ASSUME]` 假设清单的处置规则）、同步管线与退避、
  SQLite 快照与离线只读降级、检视页筛选与详情展示。

### Modified Capabilities

（无。现有六个 spec 的需求均不变：新增表走既有版本化迁移机制，`data-storage-lifecycle`
的迁移/回退/日志保留要求原样适用；codehub-cli 是既有通用子进程通道的新登记消费方，
`windows-command-exec` 的注册表闸门/编码兜底/超时预算要求原样适用且不被放宽。）

## Impact

- **代码（TS 层为主）**：
  - 改：`src/views/DashboardView.vue`（升级为工作台首页）、`src/router/index.ts`
    （新路由 + 导航分组 meta）、`src/layouts/MainLayout.vue`（侧栏分组渲染）、
    `src/stores/app.ts`（如需工作台摘要装配）、`src/api/web.ts`（codehub-cli 模拟返回）。
  - 增：`src/infra/codehub/**`（port / mock / adapter / exec）、`src/stores/codehub.ts`
    （D2 组合点例外模式装配）、`src/orchestrator/codehub-sync.ts`、
    `src/infra/db/migrations/`（v4）、`src/components/codehub/**`、检视页视图。
  - Bridge 三侧（`api/index.ts` 运行时选择、`api/tauri.ts`、`api/web.ts`）：复用
    `cliRun` 既有契约，无新增宿主命令。
- **Rust**：仅 `src-tauri/src/cli.rs` 白名单 +1 行（`codehub-cli`，附用途注释）。
- **数据**：`app.db` 新增表（migration v4）；`config.json` 新增 codehub 连接配置节
  （CLI 路径 / token / 轮询间隔 / 启用开关）。
- **测试**：各新增模块同目录 `*.spec.ts` + mock 替身；`uitest/smoke` 对导航标题的断言
  随新页签同步；`orchestrator/**` 92% lines、`infra/db/**` 72% lines 覆盖率基线不得回退。
- **依赖**：零新增（不引 HTTP SDK，CLI JSON 用既有解析手段；图标继续用内联 SVG）。
