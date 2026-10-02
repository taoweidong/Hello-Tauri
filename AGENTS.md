# AGENTS.md — Hello-Tauri 工作区指引

Tauri 2 + Vue 3 + Element Plus 的 Windows 桌面应用，打包为**单文件离线 exe**（面向内网环境）。
三大技术域：桌面壳（Rust，薄桥接）、前端业务（100% TypeScript）、WeLink × Agent 自动回复（轮询
welink-cli → SQLite → 本地大模型 Agent → 安全外发）；WeLink 域另含「快速建群」（建群模板 →
welink-cli create-group → 全程留痕，migration v3）。仅支持 Windows。

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
  welink-cli 子进程 + Windows 基础设施只读通道」共 24 个命令（commands 9 / db 4 / fs 2 /
  cli 1 / sysinfo 4 / shell 4）。新增功能全部写在 `src/` 的 TypeScript 中，不要动 Rust；
  新增宿主能力 = 薄桥接命令 + Bridge 双侧实现 + infra 端口-适配器（同 windows-infra 模式）。
- **SQLite 表结构归 TS 管**：迁移写在 `src/infra/db/migrations/`，经通用命令
  `db_migrate/db_select/db_execute/db_transaction` 下发。Rust 侧（`db.rs`）不知道任何表结构。
- **TS 内部分层**（依赖自上而下）：`views`/`components` → `stores`（Pinia）→ `orchestrator`
  （轮询/管线/安全闸/启动恢复/建群流程）→ `infra`（welink / agent / db / windows 四个端口-适配器模块）→ `repositories`。
  外部世界一律先定义 Port 接口 + `mock.ts` 实现（测试替身，真实现后到只换适配器文件）。
- **Windows 基础设施闸门**（`src/infra/windows/`）：系统命令执行走「TS 命令注册表
  （registry.ts）+ Rust 白名单（cli.rs `ALLOWED_STEMS`）」双层闸，只登记只读诊断类
  System32 EXE，禁止任何 `cmd /c` 自由字符串通道；系统信息探测与 Shell 交互
  （打开/剪贴板/通知）为**永不 reject** 结果对象语义，硬超时由工厂统一施加。
- **模拟替身标注约定**：welink-cli 的模拟替身与假设契约带统一标签，对接真实 CLI 前先
  `grep -rn "MOCK-CLI\|CLI-ASSUME" src/` 逐项核对：`[MOCK-CLI]` = 模拟实现（对接后**保留**
  为测试替身与浏览器调试数据源）；`[CLI-ASSUME]` = 对真实 CLI 的假设（子命令/参数/字段名/
  编码/游标/占位 ID），对接时必须逐一核实，核实后更新或删除对应标签。
  大模型 HTTP 适配器同款约定：`[LLM-ASSUME]` = 对真实大模型服务的协议假设（路径/鉴权头/
  model 字段/消息结构/流式开关/响应形状/CORS），对接前 `grep -rn "LLM-ASSUME" src/` 逐项核实，
  清单见 `docs/design-llm-connection-2026-10-02.md`。
  Windows 基础设施模块（`src/infra/windows/`）同款约定：`[MOCK-WIN]` = 模拟实现（保留为
  测试替身与浏览器调试数据源）；`[WIN-ASSUME]` = 对真实 Windows 行为的假设（登记命令的
  参数语法、剪贴板属主语义、气球通知转 toast 等），改动前 `grep -rn "MOCK-WIN\|WIN-ASSUME" src/`
  逐项核实。
- **运行时零外部请求**：无 CDN 字体/图标/更新检查。图标用内联 SVG（`src/components/icons.ts`），
  字体用系统字体栈。

## 数据存储

所有持久化数据在数据根目录（默认 `D:\TangYuan`，可在配置页迁移）：`config\config.json`、
`data\app.db`（SQLite WAL）、`data\table.json`、`logs\app-YYYY-MM-DD.log`（保留 30 天）。
真实数据根由固定引导文件 `%APPDATA%\com.taowd.hello-tauri\bootstrap.json` 指向，子目录自动创建。

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
- **`__APP_VERSION__`** 是 Vite `define` 注入的构建期常量；改动版本注入时要同步
  `vite.config.ts` 与 `vitest.config.ts` 两处。
- 注释、文档、commit message 均使用中文；`.workbuddy/skills/` 下有 rust/typescript/vitest/
  code-review/frontend-design 项目级技能可供参考。

## 已知陷阱

- **不要用 `tauri build` 出交付物**：它会注入 `CARGO_TARGET_*_RUSTFLAGS` 顶掉 `+crt-static`
  （产物退回动态 CRT，不再是单文件），且重复构建前端。`npm run pack` 直接
  `cargo build --release --features tauri/custom-protocol` 并做 PE 导入表硬校验（出现
  `WebView2Loader.dll`/`VCRUNTIME*`/`api-ms-win-crt-*` 即失败）。`npm run tauri:build`
  不保证静态 CRT，仅作调试。
- **`bundle.active = false`**：只出裸 exe，无安装包，打包过程不得联网（内网离线是硬需求）。
- **沙箱环境跑 `verify`**：删 `coverage/`、`dist/`、写 `target/` 会被拦，需 `--escalated`
  授权模式；否则只能跑静态检查。
- **cargo 镜像**：用 rsproxy sparse 镜像时不要加 `cargo --offline`（sparse 索引离线解析不到）。
- **WeLink 自动回复铁律**：回复草稿必须先落库置 `ready` 才允许外发；外发前必须过
  `orchestrator/safety-gate.ts`（开关分级/配额/最小间隔/静默时段/熔断）。welink-cli 为 Windows
  exe，子进程输出 UTF-8→GBK 兜底解码。
- **快速建群铁律**：外呼 CLI 前必须先落 `pending` 留痕，终态（success/failed）以
  `WHERE status='pending'` 原子回写；建群**不做传输层自动重试**（响应丢失时重试会建出两个群）。
- 进「快速建群」页会触发 migration v3；该页在浏览器模式走内存仓储（localStorage），桌面模式才落 SQLite。
- `dist/`、`release/`、`target/`、`coverage/` 是构建产物，勿提交勿手改。

## 改动前先读的文档

- `docs/design-welink-agent-2026-09-27.md` — WeLink × Agent 总设计（架构分层 §3、数据模型 §4、
  安全闸 §5A、时序 §6、快速建群 §15）；动 `src/infra/`、`src/orchestrator/`、welink 相关表结构前必读。
- `docs/` 其余为历史设计/质量报告，可按需查阅。
- `README.md` — 打包与内网迁移细节（存储迁移、bootstrap 引导、离线依赖清单）。
