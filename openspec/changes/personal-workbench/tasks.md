# Tasks

> 每组收尾必须 `npm test` 全绿（会话收尾门禁）；orchestrator/** 92% lines、
> infra/db/** 72% lines 覆盖率基线不得回退。

## 1. 通道登记（Rust 薄桥接 + Bridge 核对）

- [x] 1.1 `src-tauri/src/cli.rs` 的 `ALLOWED_STEMS` 增加 `codehub-cli` 并附用途注释（仅此一行改动）；验证：`cargo test`（src-tauri 既有单测）通过
- [x] 1.2 核对 Bridge 三侧 `cliRun` 契约（`api/types.ts` / `api/tauri.ts` / `api/web.ts`）无需扩展，补注释说明 codehub-cli 为新登记消费方；验证：`npm run typecheck` 通过

## 2. infra/codehub 端口与模拟替身

- [x] 2.1 新建 `src/infra/codehub/port.ts`：`CodeHubPort`（listMergeRequests / getMergeRequestDetail / verifyConnection）、归一化类型、`CodeHubError`（transport/parse/auth 分类）；验证：`port.spec.ts` 通过
- [x] 2.2 新建 `src/infra/codehub/mock.ts`（标 `[MOCK-CLI]`）：多仓库、覆盖开启/已合并/已关闭三态的 MR 数据与检视摘要（「待检视」本期不做）；验证：`mock` 行为单测通过
- [x] 2.3 新建 `src/infra/codehub/codehub-cli.ts`：命令拼装 + JSON 解析 + `[CLI-ASSUME]` 假设集中标注 + 截断降级语义；验证：注入假 `cliRun` 的适配器单测通过（含非零退出/编码兜底/parse 失败归类）
- [x] 2.4 新建 `src/infra/codehub/exec.ts` 与 `index.ts`：执行装配（程序路径取连接配置、超时预算、b64 解码复用 `utils/b64`）与工厂 `createCodeHub`；验证：单测通过（超时/通道故障/工厂选择）
- [x] 2.5 组内收尾：`npm test` 全绿

## 3. 数据层（migration v4 + 仓储）

- [x] 3.1 `src/infra/db/migrations/` 注册 v4：`codehub_repos` / `codehub_mrs`（仓库+MR 唯一键、可筛字段列存、详情 JSON 列）/ `codehub_sync_state` 三表及索引；验证：迁移单测（表结构、重复执行幂等）通过
- [x] 3.2 仓储函数：事务覆盖 upsert 快照、按仓库/状态筛选查询、同步状态读写；验证：单测通过（覆盖写幂等、筛选正确性、事务回滚）
- [x] 3.3 组内收尾：`npm test` 全绿，核对 infra/db 覆盖率不低于 72% lines

## 4. 同步管线（orchestrator）

- [x] 4.1 新建 `src/orchestrator/codehub-sync.ts`：一轮同步状态机（遍历启用仓库 → 拉取 → 归一化 → 事务 upsert → 同步状态回写、截断降级）；验证：单测通过（成功/部分仓库失败/详情弃写）
- [x] 4.2 触发与退避：手动刷新 + 周期轮询（间隔钳制 ≥60s、默认关闭）+ 失败退避（复用 `timers`/`poller` 模式）；验证：单测通过（退避序列、间隔钳制、UI 不阻塞）
- [x] 4.3 同步状态事件派发（`events.ts` 扩展：同步中/成功/失败/最后同步时间）；验证：单测通过
- [x] 4.4 组内收尾：`npm test` 全绿，核对 orchestrator 覆盖率不低于 92% lines

## 5. 连接配置与 store

- [x] 5.1 扩展 `config.json` schema 的 codehub 连接节（cliPath/token/interval/enabled）与配置页「CodeHub 连接」UI（CLI 接口路径、token、轮询间隔、连通验证按钮）；实现 token 以命令行参数注入与全链路脱敏（exec 诊断信息剔除 token 值 + logger 出口遮蔽）；验证：单测通过（配置读写、日志无 token 明文）
- [x] 5.2 新建 `src/stores/codehub.ts`（D2 组合点例外：消费 `createCodeHub` 工厂装配，桌面=真实适配器+SQLite，浏览器=mock+内存）；验证：单测通过（装配选择、快照读取、同步触发）
- [x] 5.3 组内收尾：`npm test` 全绿

## 6. 工作台首页与检视 UI

- [x] 6.1 路由 `meta.group` 分组 + `navRoutes()` 派生带分组 + `MainLayout` 侧栏分组渲染（未分组路由归默认组）；验证：更新并扩展 `router/index.spec.ts` 通过
- [x] 6.2 `DashboardView.vue` 升级为工作台首页：域卡片（WeLink/CodeHub/数据管理/环境检测）+ 摘要（welink 待处理、codehub 待检视、存储状态）+ 卡片跳转；既有页面路由路径不变；验证：组件单测通过
- [x] 6.3 新建检视页视图与 `src/components/codehub/**`：仓库分组列表、状态筛选（开启/已合并/已关闭）、详情视图、离线降级标识、未配置引导态、空态；验证：组件单测通过（筛选/空态/引导态/只读快照浏览不触发子进程）
- [x] 6.4 组内收尾：`npm test` 全绿

## 7. 集成验证

- [x] 7.1 更新 `scripts/uitest.mjs` 与 `scripts/smoke.mjs` 的导航/页面断言（新页签、分组、首页改造）并本地跑通；验证：`npm run uitest`、`npm run smoke` 通过
  - 导航必含清单加 `工作台`（原 `概览`）与 `CodeHub 检视`；页面副标题断言改为
    「工作台 / 各工作域入口与数据摘要」，并新增 CodeHub 页结构断言（筛选条四枚、
    来源徽标「模拟数据」、全部仓库行、未同步空态文案）。
  - `smoke.mjs` 无需改动：建表断言是「包含 records/_migrations」的结构契约，v4 三张表自然通过。
  - 实测：`npm run pack` 产物单文件校验通过 → `npm run uitest` 56/56（迁移 v1-v4、
    运行期 0 CSP 违规 / 0 未捕获异常 / 0 console.error）→ `npm run smoke` 6/6。
- [x] 7.2 全量验证：`npm run check`（lint + typecheck + test）全绿；`npm run test:coverage` 核对 orchestrator 92% / infra/db 72% 基线
  - 静态检查与单测：lint 0 问题、typecheck 0 错误、Vitest 63 文件 / 956 用例全绿。
  - 覆盖率（防回退基线全部满足）：orchestrator 97.5 lines / 91.4 branch，
    infra/db 87.3 lines / 78.9 branch，infra/windows 97.3 lines / 93.0 branch，
    新增 infra/codehub 97.5 lines / 86.1 branch。
- [x] 7.3 输出对接核对清单：`grep -rn "CLI-ASSUME\|MOCK-CLI" src/` 结果整理进本变更目录（对接真实 codehub-cli 时逐项核实用）；验证：清单文件存在且条目与源码一致
