# Hello-Tauri 当前态架构模型 —— 证据索引

- 生成：`system-modeler`（场景）+ `c4model` / `graphviz`（格式）+ `drawio`（可编辑交付）
- 日期：2026-10-05 ｜ 范围：**仅当前态**（current-state），目标态与改进建议不在本轮
- **快照口径**：以 2026-10-05 07:45 的工作区为准。其中 **RAG 检索域（`src/infra/rag/`、`RagSettingsCard.vue`、`KnowledgeCard.vue`、pipeline 检索步骤）是本次建模期间落进工作树的在途改动，尚未提交（`git ls-files src/infra/rag` = 0，openspec 变更 `add-welink-rag-retrieval` 未归档）**，因此该域在 HEAD 里还不存在。
- 真源：`system-model.structurizr.dsl`（C4 结构）、`system-module-map.dot`（模块粒度依赖）
- 派生物：`system-model.drawio`（4 页可编辑交付）
- 置信度口径：`high`=直接证据（代码/配置/规格）；`medium`=多信号一致但无直证；`low`=命名/目录推断；`unknown`=待核实

## 1. 节点（Node）

| ID           | 标签                                   | 类型               | 状态    | 置信       | sourceRefs                                                                          |
| ------------ | -------------------------------------- | ------------------ | ------- | ---------- | ----------------------------------------------------------------------------------- |
| `operator`   | 内网办公用户                           | actor              | current | high       | `src/router/index.ts:62-106`、`AGENTS.md:3-8`                                       |
| `hello`      | Hello-Tauri 个人工作台                 | system             | current | high       | `AGENTS.md:3-8`、`src-tauri/src/lib.rs:13-54`                                       |
| `webview`    | WebView 前端（业务 100%）              | container          | current | high       | `src/main.ts`、`src/api/index.ts:1-10`                                              |
| `rustHost`   | Rust 宿主（25 命令薄桥接）             | container          | current | high       | `src-tauri/src/lib.rs:23-51`                                                        |
| `dataRoot`   | 本机数据根                             | container(storage) | current | high       | `src-tauri/src/storage.rs:13-17,78-127,163-293`                                     |
| `viewsL3`    | Views / Components                     | module             | current | high       | `src/views/*.vue`、`src/components/**`、`src/layouts/MainLayout.vue`                |
| `storesL3`   | Stores（Pinia）                        | module             | current | high       | `src/stores/welink/index.ts:24`、`src/stores/{group,codehub,app,envcheck,table}.ts` |
| `orchL3`     | Orchestrator                           | module             | current | high       | `src/orchestrator/runtime.ts:71-221`、`pipeline.ts:87-495`                          |
| `gateL3`     | Safety Gate                            | control            | current | high       | `src/orchestrator/safety-gate.ts:1-130`、`pipeline.ts:383-437`                      |
| `infraL3`    | Infra 端口-适配器 ×7（含 rag）         | module             | current | high       | `src/infra/{welink,agent,db,windows,codehub,envcheck,rag}/index.ts`                 |
| `reposL3`    | Repositories（records 遗留域）         | module             | current | high       | `src/repositories/records.ts:170-310`、`csv.ts`                                     |
| `bridgeL3`   | src/api Bridge                         | gateway            | current | high       | `src/api/index.ts:1-10`、`tauri.ts:46-76`、`web.ts`                                 |
| `cliCmd`     | cli.rs 子进程通道                      | component          | current | high       | `src-tauri/src/cli.rs:36-56,217`                                                    |
| `httpCmd`    | http.rs JSON POST 通道                 | component          | current | high       | `src-tauri/src/http.rs`、`src/api/tauri.ts:65-66`                                   |
| `dbCmd`      | db.rs 通用 SQL 通道                    | component          | current | high       | `src-tauri/src/db.rs:18-225`                                                        |
| `welinkCli`  | welink-cli.exe                         | external-system    | current | high       | `src/infra/welink/welink-cli.ts:34-63`、`cli.rs:36`                                 |
| `codehubCli` | codehub-cli.exe                        | external-system    | current | **medium** | `src/infra/codehub/codehub-cli.ts:208-242`（35 处 `[CLI-ASSUME]` 未核实）           |
| `llmService` | 阿里云 MaaS compatible-mode            | external-system    | current | high       | `src/infra/agent/agent-http.ts:11-15`（`[LLM-ASSUME]` 已核实关闭）                  |
| `ragService` | 知识检索服务（RAG）                    | external-system    | current | **low**    | `src/infra/rag/rag-http.ts:6,105`、`port.ts:11-25`（6 处 `[RAG-ASSUME]` 未核实）    |
| `knowledge`  | 数据根 `knowledge/*.md` + `index.json` | data-store         | current | high       | `src/components/welink/KnowledgeCard.vue:4-26,48-133`                               |
| `windowsOs`  | Windows 系统能力                       | external-system    | current | high       | `src/infra/windows/registry.ts:39-111`、`sysinfo.rs`、`shell.rs`                    |
| `appDb`      | data/app.db（SQLite WAL）              | data-store         | current | high       | `src/infra/db/index.ts:35`、`src/infra/db/migrations/*.ts`                          |

## 2. 关系（Edge）

| ID        | from → to             | 类型/协议                                                            | 置信       | sourceRefs                                                                                                                                                                                  |
| --------- | --------------------- | -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.e1`  | operator → webview    | uses / sync                                                          | high       | `src/router/index.ts:62-106`                                                                                                                                                                |
| `lay.e1`  | viewsL3 → storesL3    | depends-on                                                           | high       | `eslint.config.mjs:142-155`（闸门）、唯一例外 `src/components/group/CreateTab.vue:23` 走 orchestrator 纯函数                                                                                |
| `lay.e2`  | storesL3 → orchL3     | calls                                                                | high       | `src/stores/welink/index.ts:24`、`group.ts:22`、`codehub.ts:17-23`                                                                                                                          |
| `lay.e3`  | storesL3 → infraL3    | depends-on（装配例外）                                               | high       | `src/stores/envcheck.ts:21`、`group.ts:15-18`、`codehub.ts:13-15`、`table.ts:5-6`                                                                                                           |
| `lay.e2b` | storesL3 → bridgeL3   | calls                                                                | high       | `src/stores/app.ts:35-59`                                                                                                                                                                   |
| `lay.e5`  | orchL3 → infraL3      | depends-on（只经 Port）                                              | high       | `src/orchestrator/runtime.ts:14-16`                                                                                                                                                         |
| `lay.e4`  | orchL3 → gateL3       | validates                                                            | high       | `src/orchestrator/pipeline.ts:383`                                                                                                                                                          |
| `lay.e6`  | infraL3 → bridgeL3    | calls                                                                | high       | `src/infra/welink/exec.ts:16,61`、`db/repos/welink.ts:13`、`agent/index.ts:11`                                                                                                              |
| `lay.e7`  | reposL3 → bridgeL3    | calls                                                                | high       | `src/repositories/records.ts:170-229`                                                                                                                                                       |
| `ui.e1`   | viewsL3 → bridgeL3    | calls（UI 直连宿主通道；闸门只禁 `@/infra/**`、`@/repositories/**`） | high       | `src/components/welink/KnowledgeCard.vue:16,48-133`、`src/views/{DashboardView,GroupView,SettingsView}.vue`、`src/components/welink/SettingsCard.vue`、`src/components/group/CreateTab.vue` |
| `lay.e8`  | bridgeL3 → rustHost   | calls / Tauri IPC（25 命令）                                         | high       | `src/api/tauri.ts:46-76`（`invoke<` 实测 25 处）、`lib.rs:23-51`                                                                                                                            |
| `ctn.e4`  | rustHost → welinkCli  | calls / 子进程 stdout(base64)                                        | high       | `src/infra/welink/commands.ts:34-82`                                                                                                                                                        |
| `ctn.e5`  | rustHost → codehubCli | calls / 子进程                                                       | **medium** | `src/infra/codehub/codehub-cli.ts:208-242`、`exec.ts:29`（`--token` 参数名待核实）                                                                                                          |
| `ctn.e6`  | rustHost → llmService | calls / HTTPS JSON                                                   | high       | `src/infra/agent/agent-http.ts:125-163`                                                                                                                                                     |
| `rag.e1`  | rustHost → ragService | calls / HTTPS JSON（复用 `http_post_json`）                          | **low**    | `src/infra/rag/index.ts:26`、`rag-http.ts:130-163`                                                                                                                                          |
| `ctn.e7`  | rustHost → windowsOs  | calls / 白名单 exec                                                  | high       | `src-tauri/src/cli.rs:36-56`                                                                                                                                                                |
| `ctn.e3`  | rustHost → dataRoot   | reads/writes / file+SQL                                              | high       | `src-tauri/src/storage.rs:163-293`                                                                                                                                                          |
| `cmd.e1`  | dbCmd → appDb         | reads / SQL                                                          | high       | `src-tauri/src/db.rs:18-107`                                                                                                                                                                |
| `lay.e9`  | gateL3 → storesL3     | publishes（`safetyChanged`/`fuseTripped`）                           | high       | `src/orchestrator/runtime.ts:93-96,123`                                                                                                                                                     |

## 3. 关键不变量（有证据，非推测）

| 不变量                                                                                                          | 证据                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 草稿必须与 `status='ready'` 同一条 UPDATE 落库（`commitDraft`）后才允许外发                                     | `src/orchestrator/pipeline.ts:284-295`、`AGENTS.md:115-117`                                |
| 外发前必过 `safety-gate.check()`，且 `sending` 由乐观锁 `markStatus(pk,'sending','ready')` 抢占                 | `pipeline.ts:383,416`                                                                      |
| 建群外呼前先落 `pending`，终态以 `WHERE status='pending'` 原子回写，且无传输层重试                              | `src/orchestrator/group.ts:47,52,61`、`AGENTS.md:118-119`                                  |
| CodeHub 纯只读、不接 safety-gate、无外发；token 经 `registerSecret` 遮蔽                                        | `AGENTS.md:120-122`、`openspec/specs/codehub-review/spec.md`                               |
| 表结构归 TS：`MIGRATIONS` 注册表 v1–v5，Rust 侧 `db.rs` 不感知表                                                | `src/infra/db/index.ts:35`、`db/migrations/{records,welink,group,codehub,welink-skill}.ts` |
| Windows 命令双层闸：TS 注册表（只读诊断）+ Rust `ALLOWED_STEMS`                                                 | `src/infra/windows/registry.ts:39-111`、`cli.rs:36-56`                                     |
| 运行时零外部请求（图标内联 SVG、系统字体栈）                                                                    | `src/components/icons.ts`、`AGENTS.md:79-80`                                               |
| RAG 检索只产草稿上下文，不构成第二个外发出口：片段进 prompt 后仍走同一条 `gate.check()` → `send`                | `src/orchestrator/pipeline.ts:242-268,383`                                                 |
| 知识清单真源是数据根 `knowledge/index.json`（`fs_read`/`fs_write`），**不进 SQLite**（`MIGRATIONS` 仍为 v1–v5） | `src/components/welink/KnowledgeCard.vue:26,48,58`、`src/infra/db/index.ts:35`             |

## 4. 未知项 / 待核实（本轮不当作既成事实）

| #   | 未知                                                                                                    | 影响面                                                           | 核实动作                                                       |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| U1  | 真实 `codehub-cli` 的子命令/参数名/字段形状（35 处 `[CLI-ASSUME]`）                                     | `infra/codehub`、`orchestrator/codehub-*`、migration v4 字段映射 | 按 `docs/cli-integration-adaptation-2026-10-04.md` §4 逐项核实 |
| U2  | 真实 `welink-cli` 输出契约残留假设（17 处 `[MOCK-CLI]` + 若干 `[CLI-ASSUME]`）                          | `infra/welink`、自动回复链路                                     | 同上指南 §1–§3                                                 |
| U3  | 运行时真实 IPC 次数/延迟/失败率                                                                         | 无遥测来源，模型只表达静态设计                                   | 需要 `deployment-topology-analyzer` + 实际日志                 |
| U4  | 生产部署与多机数据根分布                                                                                | 本轮未建 runtime 视图                                            | 同上（deployment 场景）                                        |
| U6  | 真实 RAG 检索服务的协议（`[RAG-ASSUME]` 6 处：路径/鉴权头/`filter` 透传/响应容器与字段名/`score` 语义） | `infra/rag`、pipeline 检索步骤、RAG 设置卡                       | 拿到检索服务文档后逐项核实并更新标签                           |
| U7  | RAG 域是否在 HEAD 中：**否**（在途未提交，openspec 变更 `add-welink-rag-retrieval` 未归档）             | 本模型的 RAG 部分随该改动一起变动                                | 该变更合入后重跑模型（或跑 `architecture-health` 对表）        |
| U5  | `welink-cli` / `codehub-cli` 的内网服务端边界                                                           | 图上只到 CLI 进程，未画其后端                                    | 拿到 CLI 文档后补外部链路                                      |

## 5. 视图维护口径

- 结构变更（新域/新容器/新闸门）→ 先改 `system-model.structurizr.dsl` 与本文件表格，再同步 `.drawio`。
- 模块粒度变更（新 orchestrator/infra 模块）→ 先改 `system-module-map.dot`。
- `.drawio` 里的手工排版调整可以保留；但**改了架构事实必须回写 DSL/DOT 与本证据索引**，否则模型与代码漂移。
- freshness 校验请路由 `architecture-health`（比对图与 `lib.rs` 命令清单、`MIGRATIONS` 列表、ESLint 闸门规则）。
