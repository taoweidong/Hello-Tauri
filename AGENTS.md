# AGENTS.md — Hello-Tauri 工作区指引

Tauri 2 + Vue 3 + Element Plus 的 Windows 桌面应用，打包为**单文件离线 exe**（面向内网环境）。
三大技术域：桌面壳（Rust，薄桥接）、前端业务（100% TypeScript）、WeLink × Agent 自动回复（轮询
welink-cli → SQLite → 本地大模型 Agent → 安全外发）；WeLink 域另含「快速建群」（建群模板 →
welink-cli create-group → 全程留痕，migration v3）。CodeHub 域（内网 MR 检视：codehub-cli 子进程
→ SQLite 快照 → 检视页，纯只读、无外发，migration v4）首页是聚合各域的「工作台」。仅支持 Windows。

## 常用命令

| 命令                  | 说明                                                          |
| --------------------- | ------------------------------------------------------------- |
| `npm run dev`         | 浏览器开发模式，**无需 Rust**，可调试全部页面（web Bridge）   |
| `npm run tauri:dev`   | 桌面开发模式（需 Rust 工具链）                                |
| `npm run typecheck`   | `vue-tsc --noEmit` 类型检查                                   |
| `npm run lint`        | ESLint（风格归 Prettier，lint 只抓真问题）                    |
| `npm test`            | **全量单测一键入口**：Vitest（happy-dom，`src/**/*.spec.ts`） |
| `npm run check`       | lint + typecheck + test 一条龙                                |
| `npm run pack`        | **产出可分发单文件 exe 的唯一正道**（含产物硬校验）           |
| `npm run verify`      | 全量验证：静态检查→单测→UI 测试→构建→打包→产物校验            |
| `npm run verify:fast` | 跳过打包的快速验证                                            |

需要 Node.js ≥ 22.5（uitest/smoke 依赖 Node 22 内置的 `node:sqlite` 与稳定的 WebSocket）。Rust 产物统一输出到根 `target/`（`.cargo/config.toml` 指定），不是 `src-tauri/target/`。

## 会话收尾测试门禁（强制）

- **一键单测入口只有一个**：`npm test`（= `vitest run`，一次跑完 `src/**/*.spec.ts` 全部用例）。
- **所有会话结束前必须执行 `npm test` 并确认全绿**；单元测试**必须强制通过才能进行后续操作**
  （提交、打包、切换新任务均以前最近一次全绿为前提）。
- **无法通过时先分析原因并解决**：定位根因 → 修复 → 重跑至全绿；禁止用跳过/注释/删除用例、
  放宽断言、残留 `.skip`/`.only` 等方式让测试「变绿」后收尾。
- **范围升级**：改动 `orchestrator/**`、`infra/db/**` 或可能触及覆盖率基线的会话，收尾改跑
  `npm run check`（lint + typecheck + test）；必要时另跑 `npm run test:coverage` 核对阈值。

## 架构边界（改代码前必读）

- **前端不直接依赖 Rust/Tauri**：任何 `src/` 下的文件禁止 `import '@tauri-apps/api'`（ESLint
  `no-restricted-imports` 强制），宿主交互一律走 `src/api/` 的 Bridge 接口。`src/api/tauri.ts`
  是唯一例外（桌面实现），`web.ts` 是浏览器实现（localStorage），`index.ts` 运行时按
  `__TAURI_INTERNALS__` 自动选择。
- **Rust 无业务规则**：`src-tauri/src/` 只有「开窗口 + 存储读写 + SQLite 通用通道 +
  CLI 子进程（welink-cli / codehub-cli 共用一条通道）+ HTTP 通道（POST=大模型对接 /
  GET=更新清单等小文本，WebView fetch 受 CORS 拦截由宿主代发）+ Windows 基础设施只读通道 +
  自动更新（update.rs：流式下载/minisign 验签/自替换重启，清单协议、版本判定与状态机
  全在 TS 侧）+ 托盘驻留（tray.rs：关窗拦截/托盘菜单/状态显示，动作语义全在前端）+
  开机自启注册表薄桥接」共 33 个
  命令（commands 9 / db 4 / fs 2 / cli 1 / http 2 / update 3 / sysinfo 4 / shell 4 / tray 2 / autostart 2）。新增功能全部写在 `src/` 的
  TypeScript 中，不要动 Rust；新增宿主能力 = 薄桥接命令 + Bridge 双侧实现 + infra
  端口-适配器（同 windows-infra 模式）。
- **SQLite 表结构归 TS 管**：迁移写在 `src/infra/db/migrations/`，经通用命令
  `db_migrate/db_select/db_execute/db_transaction` 下发。Rust 侧（`db.rs`）不知道任何表结构。
- **TS 内部分层**（依赖自上而下）：`views`/`components` → `stores`（Pinia）→ `orchestrator`
  （轮询/管线/安全闸/启动恢复/建群流程/知识沉淀/CodeHub 同步与详情补拉）→ `infra`（welink / agent /
  db / envcheck / knowledge / windows / codehub 七个端口-适配器模块）→ `repositories`。
  外部世界一律先定义 Port 接口 + `mock.ts` 实现（测试替身，真实现后到只换适配器文件）。
  **组合点例外**（quality-hardening-2026-10 D2）：store 允许消费 infra 工厂做**装配**
  （如 `envcheck.ts → createEnvChecks`、`table.ts → recordsBackend`、`group.ts → groupClient`、
  `stores/welink/knowledge.ts → knowledgePort/sediment`，浏览器内存实现的切换点），业务逻辑仍归
  orchestrator；UI 层（views/components）禁止
  直触 `@/infra/**` 与 `@/repositories/**`（ESLint `no-restricted-imports` 闸门强制）。
- **Windows 基础设施闸门**（`src/infra/windows/`）：系统命令执行走「TS 命令注册表
  （registry.ts）+ Rust 白名单（cli.rs `ALLOWED_STEMS`）」双层闸，只登记只读诊断类
  System32 EXE，禁止任何 `cmd /c` 自由字符串通道；系统信息探测与 Shell 交互
  （打开/剪贴板/通知）为**永不 reject** 结果对象语义，硬超时由工厂统一施加。
- **模拟替身标注约定**：welink-cli / codehub-cli 的模拟替身与假设契约带统一标签，对接真实 CLI 前先
  `grep -rn "MOCK-CLI\|CLI-ASSUME" src/` 逐项核对：`[MOCK-CLI]` = 模拟实现（对接后**保留**
  为测试替身与浏览器调试数据源）；`[CLI-ASSUME]` = 对真实 CLI 的假设（子命令/参数/字段名/
  编码/游标/占位 ID），对接时必须逐一核实，核实后更新或删除对应标签。
  **对接适配总指南**（两 CLI 的假设汇总核对表 + mock 能力清单 + 对接 SOP）：
  `docs/cli-integration-adaptation-2026-10-04.md` —— 拿到真实接口文档后从它入手；
  CodeHub 逐项清单的原始归档在
  `openspec/changes/archive/2026-10-04-personal-workbench/cli-assume-checklist.md`
  （已并入总指南 §4，归档原貌保留）。
  大模型 HTTP 适配器同款约定：`[LLM-ASSUME]` = 对真实大模型服务的协议假设（路径/鉴权头/
  model 字段/消息结构/流式开关/响应形状/CORS），对接前 `grep -rn "LLM-ASSUME" src/` 逐项核实，
  核实后更新或删除对应标签，清单与对接记录见 `docs/design-llm-connection-2026-10-02.md`
  （2026-10-04 已完成阿里云 MaaS compatible-mode 真实对接：协议逐项核实通过，唯一不成立的
  CORS 走 Rust 宿主通道 `http_post_json` 处置，密钥只存本机数据根 config.json、不入仓库）。
  RAG 检索适配器同款约定：`[RAG-ASSUME]` = 对真实 RAG 检索服务的协议假设（端点/鉴权/请求体
  query+top_k+filter/响应形状与字段容错/score 语义/CORS），对接前 `grep -rn "RAG-ASSUME" src/`
  逐项核实，核实后更新或删除对应标签，清单与对接 SOP 见
  `docs/design-welink-rag-retrieval-2026-10-05.md`（应用只查不建索引，mock 先行）。
  Windows 基础设施模块（`src/infra/windows/`）同款约定：`[MOCK-WIN]` = 模拟实现（保留为
  测试替身与浏览器调试数据源）；`[WIN-ASSUME]` = 对真实 Windows 行为的假设（登记命令的
  参数语法、剪贴板属主语义、气球通知转 toast 等），改动前 `grep -rn "MOCK-WIN\|WIN-ASSUME" src/`
  逐项核实。
  自动更新模块（`src/infra/update/`、`src-tauri/src/update.rs`）同款约定：
  `[MOCK-UPDATE]` = 模拟实现（浏览器调试更新全流程：假清单/假进度/成功但不重启）；
  `[UPD-ASSUME]` = 对更新链路的假设（运行映像可 rename、tauri signer 与 minisign-verify
  的格式往返、清单 `<endpoint>`/`<endpoint>.minisig` 双 GET、staged 复核语义等——
  2026-10-11 实施期已逐项 PoC 核实并关闭，记录见设计文档 §13 与 §16 实施勘误），
  改动前 `grep -rn "MOCK-UPDATE\|UPD-ASSUME" src/` 逐项核对。
- **运行时零外部请求**：无 CDN 字体/图标。图标用内联 SVG（`src/components/icons.ts`），
  字体用系统字体栈。**自动更新为唯一显式例外**：默认关闭、启用后仅 GET 用户配置的
  内网更新源（清单/签名/产物三种 GET，无遥测；design-auto-update U-G）。

## 数据存储

所有持久化数据在数据根目录（默认 `D:\TangYuan`，可在配置页迁移）：`config\config.json`、
`data\app.db`（SQLite WAL）、`data\table.json`、`knowledge\*.md`（本地知识库与知识沉淀产物：
`index.json` 清单 + `qa-archive/` 问答归档，随存储根迁移一同搬运）、`logs\app-YYYY-MM-DD.log`
（保留 30 天）。真实数据根由固定引导文件 `%APPDATA%\com.taowd.hello-tauri\bootstrap.json` 指向，
子目录自动创建。

## 代码约定

- **Prettier**：无分号、单引号、尾逗号、120 列、**LF 行尾**（`.gitattributes` 已固化 `eol=lf`，
  仅 `*.bat/*.cmd` 为 CRLF。若 prettier 报「未格式化」但 `git diff` 为空，是行尾问题，勿手改）。
- **自动导入**：`ref`/`computed`/`onMounted` 及 vue-router、Pinia API 由 `unplugin-auto-import`
  构建期注入，**不要手写这些 import**；Element Plus 组件由 `unplugin-vue-components` 自动注册。
  globals 清单在 `.eslintrc-auto-import.json`（构建后生成）。
- **路径别名**：`@/*` → `src/*`。
- **日志**：业务代码经 `src/utils/logger.ts` 唯一出口（控制台 + 落盘 `append_log`）。
- **测试**：与源码同目录 `*.spec.ts`。覆盖率阈值是**防回退基线**而非目标——`orchestrator/**`
  92% lines、`infra/db/**` 72% lines，抬线前先补测试。`src/**/mock.ts` 视为测试替身，不计覆盖率。
- **版本元数据**：`__APP_VERSION__` / `__GIT_COMMIT__`（HEAD 前 6 位）/ `__BUILD_TIME__`
  （打包时间）是构建期注入常量，真值统一在 `scripts/version-meta.mjs`（vite / vitest /
  build.mjs 三处共享，界面显示与 exe 文件名时间戳同源）；改注入逻辑时核对这三个消费方，
  不要在源码里硬编码版本串。
- 注释、文档、commit message 均使用中文；`.workbuddy/skills/` 下有 rust/typescript/vitest/
  code-review/frontend-design 项目级技能可供参考。

## 已知陷阱

- **不要用 `tauri build` 出交付物**：它会注入 `CARGO_TARGET_*_RUSTFLAGS` 顶掉 `+crt-static`
  （产物退回动态 CRT，不再是单文件），且重复构建前端。`npm run pack` 直接
  `cargo build --release --features tauri/custom-protocol` 并做 PE 导入表硬校验（出现
  `WebView2Loader.dll`/`VCRUNTIME*`/`api-ms-win-crt-*` 即失败）。`npm run tauri:build`
  不保证静态 CRT，仅作调试。
- **`bundle.active = false`**：只出裸 exe，无安装包，打包过程不得联网（内网离线是硬需求）。
- **托盘驻留语义**（service-residency）：点 X 默认隐藏入托盘（`closeBehavior:'quit'` 可回旧行为）；
  Rust→前端事件是固定白名单 3 个（`host://window-hidden|window-shown|tray-toggle`，两侧常量
  必须逐字一致）；托盘「暂停/恢复」的判据只有 `store.runtimeRunning()`，恢复走完整 bootstrap；
  托盘「退出」= `app.exit(0)` 直杀（WAL+bootstrap 恢复兜底，无宽限期）；单实例插件
  （tauri-plugin-single-instance **=2.4.5**，2.5+ 要求 tauri ^2.12 会顶走 2.11.6 基线）；
  开机自启真值在注册表 HKCU Run、**不入 config.json**；隐藏态防节流靠
  `additionalBrowserArgs` 禁 `CalculateNativeWinOcclusion`（整体替换语义，默认三项须写全）。
- **沙箱环境跑 `verify`**：删 `coverage/`、`dist/`、写 `target/` 会被拦，需 `--escalated`
  授权模式；否则只能跑静态检查。
- **cargo 镜像**：用 rsproxy sparse 镜像时不要加 `cargo --offline`（sparse 索引离线解析不到）。
- **WeLink 自动回复铁律**：回复草稿必须先落库置 `ready` 才允许外发；外发前必须过
  `orchestrator/safety-gate.ts`（开关分级/配额/最小间隔/静默时段/熔断）。welink-cli 为 Windows
  exe，子进程输出 UTF-8→GBK 兜底解码。
- **快速建群铁律**：外呼 CLI 前必须先落 `pending` 留痕，终态（success/failed）以
  `WHERE status='pending'` 原子回写；建群**不做传输层自动重试**（响应丢失时重试会建出两个群）。
- **知识沉淀铁律**（knowledge-sedimentation）：沉淀全程**纯本地写入**——不产生回复任务、
  不调用消息发送、不接 safety-gate；提取条目必须经人工评审（或显式开启 auto 直通）写入知识库，
  `pending` 条目不得进入知识库清单；knowledge/*.md 是唯一长期记忆落点（不受 SQLite 保留期影响）。
- **CodeHub 检视铁律**：纯只读域，**不接 safety-gate、无任何外发**；列表浏览只读本地快照，
  唯一的子进程出口是「点开缺详情的 MR 按条补拉」（在飞去重归 `orchestrator/codehub-detail.ts`）。
  token 以 `--token` 参数注入并经 `registerSecret` 全链路遮蔽；本期**无游标列**（每轮按
  `CODEHUB_MAX_BATCH=200` 全量重拉），覆盖写只增改不删，清理只随仓库删除级联发生；
  输出截断只记 `degraded`（UI 标「数据可能不完整」），**不写** `last_error`。
- 进「快速建群」页会触发 migration v3；进「CodeHub 检视」页会触发 migration v4
  （仓库注册 / MR 快照 / 同步状态）；两页在浏览器模式走内存仓储（localStorage），桌面模式才落 SQLite。
- `dist/`、`release/`、`target/`、`coverage/` 是构建产物，勿提交勿手改。

## 改动前先读的文档

- `docs/design-welink-agent-2026-09-27.md` — WeLink × Agent 总设计（架构分层 §3、数据模型 §4、
  安全闸 §5A、时序 §6、快速建群 §15）；动 `src/infra/`、`src/orchestrator/`、welink 相关表结构前必读。
- `docs/design-welink-skill-routing-2026-10-04.md` — 问题分类与技能路由设计（决策 S-A~S-J）；
  动 `src/orchestrator/skill-router.ts`、pipeline 生成段、技能编辑 UI 前必读。
- `docs/design-welink-rag-retrieval-2026-10-05.md` — RAG 检索增强与本地知识库设计（决策 D-A~D-J、
  `[RAG-ASSUME]` 假设清单与对接 SOP）；动 `src/infra/rag/`、pipeline 检索注入段、RAG/知识库配置卡前必读。
- `docs/design-welink-knowledge-sedimentation-2026-10-06.md` — 知识沉淀与答复知识路由设计
  （决策 K-A~K-J、`[CLI-ASSUME]` 公告假设清单）；动 `src/orchestrator/knowledge-harvester.ts`、
  `src/infra/knowledge/`、沉淀相关表结构与 `{{docs}}` 注入链路前必读。
- `docs/design-service-residency-2026-10-10.md` — 服务常驻（系统托盘驻留）设计（决策 T-A~T-N、
  首验项 V-1~V-8）；动 `src-tauri/src/tray.rs`、`src/stores/welink/host-link.ts`、Bridge
  服务常驻通道、`AppSettings.closeBehavior` 与开机自启前必读。
- `docs/design-auto-update-2026-10-10.md` — 自动更新（单 exe 拉取远端最新版本）设计
  （决策 U-A~U-M、`[UPD-ASSUME]` 首验项 U-1~U-8、清单 schema 与发布规程，§16 为实施勘误）；
  动 `src-tauri/src/update.rs`、`src/infra/update/`、`src/orchestrator/update.ts`、
  `AppSettings.update` 与 `scripts/publish-update.mjs` 前必读。
- `openspec/specs/welink-auto-reply/spec.md` — 自动回复主规格（16 条需求，含技能路由与检索增强）；
  `openspec/specs/knowledge-base/spec.md` — 知识库管理主规格；改动经 delta 流程对照。
- `openspec/specs/codehub-review/spec.md`、`openspec/specs/workbench-home/spec.md` — CodeHub 检视域
  与工作台首页的主规格（验收口径）。设计决策与核对表在归档变更
  `openspec/changes/archive/2026-10-04-personal-workbench/`（`design.md` 的 D3 打桩先行、D5 截断降级、
  D6 token 注入、D7 工作台首页、D8 分层归位，+ 同目录 `cli-assume-checklist.md`）。
- `docs/` 其余为历史设计/质量报告，可按需查阅。
- `README.md` — 打包与内网迁移细节（存储迁移、bootstrap 引导、离线依赖清单）。
