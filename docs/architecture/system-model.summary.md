# Hello-Tauri 当前态架构理解

> 产物由 `system-modeler`（场景）+ `c4model`/`graphviz`（格式）+ `drawio`（可编辑交付）生成
> 生成日期：2026-10-05 ｜ 范围：**当前态**，作用域 = 整个仓库（含 Rust 宿主与 TS 前端）
> 本文件只回答「系统是什么、边界在哪」；风险、影响面、演进方案不在本轮口径内。

## 1. 一句话边界

一个**只支持 Windows 的单文件离线 exe**：Rust 侧只做「开窗 + 存储读写 + SQLite 通用通道 + CLI 子进程 + HTTP 代发 + 系统只读通道」共 25 个命令，**所有业务规则都在 WebView 里的 TypeScript**。

## 2. 三个容器 + 五个外部系统

| 容器         | 承担                                                                                                                                                                                              | 关键证据                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| WebView 前端 | 分层 `views → stores → orchestrator → infra → repositories → api`，业务全量                                                                                                                       | `src/api/index.ts:1-10`                                    |
| Rust 宿主    | 25 命令薄桥接，不知道任何表结构、不含业务判断                                                                                                                                                     | `src-tauri/src/lib.rs:23-51`                               |
| 本机数据根   | `config/config.json`、`data/app.db`（SQLite WAL，migration v1–v5）、`table.json`、`logs/`（30 天）、`knowledge/*.md` + `knowledge/index.json`（RAG 知识源，走 `fs_read`/`fs_write`，不入 SQLite） | `src-tauri/src/storage.rs:13-17,78-127`、`AGENTS.md:82-86` |

外部系统：`welink-cli.exe`（消息与建群）、`codehub-cli.exe`（MR 只读拉取）、大模型服务（阿里云 MaaS compatible-mode）、**知识检索服务（RAG，协议未核实）**、Windows 系统能力（System32 只读诊断 + 剪贴板/通知/打开）。

**五个外部出口全部收敛在宿主的三条通道上**：`cli_run`（子进程，白名单双层闸）、`http_post_json`（宿主代发，解 CORS）、`db_*`/`fs_*` + `sys_*`/`shell_*`。前端拿不到任何「传什么跑什么」的自由通道。

## 3. 最重要的五条关系

1. **Bridge 是唯一宿主出口**：`src/api/tauri.ts` 里 25 个 `invoke` 与 `lib.rs` 的 25 个命令一一对应；`web.ts` 让同一套 TS 代码能在浏览器跑（`npm run dev` 无需 Rust）。
2. **依赖方向严格向下**：store 只调 `runtime.start()/stop()/pullNow()`，业务判断（轮询节奏、草稿生成、重试立场、熔断）全在 `src/orchestrator/`。
3. **组合点例外**：store 允许消费 infra 工厂做**装配**（`createEnvChecks`/`groupClient`/`codeHubPort`/`recordsBackend`/`createRagProbe`），这是「桌面↔浏览器实现切换」的落点，业务逻辑仍不下沉到 store。infra 现有 **7 个端口-适配器域**（welink / agent / db / envcheck / windows / codehub / rag）。
4. **外发必经闸门**：`pipeline.ts:383` 在 `send` 之前调 `gate.check()`；`check()` 是纯判定，配额只在 `onSent` 扣减，熔断以状态集合存在。这条边是自动回复域唯一的对外动作许可来源。**RAG 检索（`pipeline.ts:242-268`）只往 prompt 里填片段，不构成第二个外发出口**。
5. **数据归属分治**：SQLite 表结构与迁移（v1 records → v2 welink 四表 → v3 建群两表 → v4 CodeHub 三表 → v5 回复任务技能列）全在 TS 的 `src/infra/db/migrations/`，Rust 只有通用执行器，并额外禁 `ATTACH`。

## 4. 两道闸门（结构性约束，机器可校验）

| 闸门                           | 位置                                                                                                                                  | 拦什么                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| ESLint `no-restricted-imports` | `eslint.config.mjs:112-136`（禁 `@tauri-apps/api`，仅 `api/tauri.ts` 例外）、`142-155`（UI 禁直触 `@/infra/**`、`@/repositories/**`） | 前端绕过 Bridge、UI 绕过 store |
| Windows 命令双层闸             | TS 注册表 `src/infra/windows/registry.ts:39-111`（只登记只读诊断）+ Rust `cli.rs:36-56` `ALLOWED_STEMS`                               | Bridge 被当通用命令通道滥用    |

## 5. 证据强度与不确定区

- 结构层面**证据充分**：容器/分层/命令清单/迁移清单/闸门规则均有 `file:line` 直证（详见 `system-model.evidence.md` 第 1–3 节）。
- **`codehub-cli` 的契约是本轮唯一的 medium 置信外部依赖**：35 处 `[CLI-ASSUME]`（子命令、`--token` 参数名、字段形状、`view` 单对象输出、认证失败特征串）尚未对真实 CLI 核实。图上用虚线表示。
- `[MOCK-CLI]` 17 处（9 文件）是**保留的测试替身**，不是缺陷；`[LLM-ASSUME]` 已于 2026-10-04 核实关闭（唯一不成立的 CORS 走宿主代发）。
- **运行时拓扑未建模**：无遥测来源，本轮不声称 IPC 次数/延迟/失败率；生产数据根分布与多机部署同理。
- **在途改动提醒**：RAG 检索域（`src/infra/rag/`、`KnowledgeCard.vue`、`RagSettingsCard.vue`、pipeline 检索步骤）是本次建模期间进入工作树、**尚未提交**的改动（`git ls-files src/infra/rag` = 0，openspec 变更 `add-welink-rag-retrieval` 未归档），且带 6 处 `[RAG-ASSUME]`。这部分模型会随该改动合入而变动，别当稳定基线用。

## 6. 阅读顺序与产物

1. `system-model.structurizr.dsl` —— C4 真源（`L1-system-context` → `L2-containers` → `L3-ts-layers` → `L3-rust-channels`），Qoder Structurizr DSL 预览器可开。
2. `system-module-map.dot` —— 模块粒度依赖真源（orchestrator/infra 内部、Bridge 双侧、宿主通道、数据归属），Graphviz DOT 预览器可开。
3. `system-module-map.svg` —— 上面这份 DOT 的**渲染导出**（Graphviz 16.1.0 引擎，2026-10-05 出图；本机未装系统级 `dot`，用免提权的 WASM Graphviz 渲染）。44 节点 / 9 分层框 / 0 重叠已几何校验。派生物，改图请改 `.dot` 再重渲。
4. `system-model.evidence.md` —— 节点/关系/不变量/未知的 `file:line` 索引。
5. `system-model.drawio` —— 4 页可编辑交付（派生物，非真源；见 `drawio-summary.md`）。

## 7. 下一步该路由到哪

| 你接下来想问                                 | 该用的场景 skill               |
| -------------------------------------------- | ------------------------------ |
| 自动回复一次轮询端到端怎么走、失败路径与留痕 | `flow-visualizer`              |
| 改 `orchestrator/pipeline` 或某张表会波及谁  | `dependency-impact-analyzer`   |
| 单 exe / 内网离线怎么部署与发布              | `deployment-topology-analyzer` |
| 分层与闸门的债、风险与优先级                 | `risk-quality-reviewer`        |
| 这套图有没有跟代码漂移                       | `architecture-health`          |
