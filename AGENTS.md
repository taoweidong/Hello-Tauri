# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

## 语言规则

所有对话回复、代码注释、commit 消息、文档内容必须使用**简体中文**。

## 技术栈版本（2026-06-28 升级）

| 依赖 | 版本 |
|------|------|
| Node | `>=20`（当前 v24.13.0） |
| Vue | ^3.5.39 |
| Naive UI | ^2.44.1 |
| Pinia | ^3.0.4 |
| @vueuse/core | ^14.3.0 |
| TypeScript | ~6.0.0 |
| Vite | ^8.1.0（使用 Rolldown） |
| Vitest | ^4.1.9 |
| vue-tsc | ^3.3.5 |
| Tauri CLI/API | ^2.11.3 / ^2.11.1 |

## 命令

| 任务 | 命令 |
|------|------|
| 开发（Web） | `npm run dev` |
| 开发（桌面） | `npm run tauri:dev` |
| 类型检查 | `npm run typecheck`（vue-tsc --noEmit） |
| 测试 | `npm test`（vitest run） |
| 测试（watch） | `npm run test:watch`（vitest） |
| 单个测试 | `npx vitest run src/__tests__/core/search.test.ts` |
| 构建（Web） | `npm run build`（vue-tsc -b && vite build） |
| 构建（桌面） | `npm run tauri:build` |
| Rust 检查 | `cargo check`（workdir: src-tauri/） |
| Rust 测试 | `cargo test`（workdir: src-tauri/） |

未配置 lint 或格式化脚本。

## 三方库依赖

除 Vue/Naive UI/Pinia 等核心框架外，以下三方库在架构中扮演关键角色：

| 依赖 | 用途 |
|------|------|
| `fflate` | 纯 JS 压缩/解压库，Web 端 ZIP 解压回退方案（无需 WASM） |
| `splitpanes` | 可拖拽分栏布局（Workspace 区域的 SplitView） |
| `vue-draggable-plus` | 文件树节点拖拽排序 |
| `@tauri-apps/api` | Tauri 2 IPC 客户端，`invoke` 调用 Rust 后端命令 |

## Rust 工具链（Windows）

Cargo 需要在 PATH 中，且可能需要绕过代理：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:https_proxy = ""; $env:no_proxy = "*"
```

## 构建产物

所有构建输出到 `build/`（不是 `dist/`）：

- `build/web/` — Vite 生产构建
- `build/node/` — vue-tsc 编译的配置文件
- `build/app.tsbuildinfo` — TypeScript 增量信息
- `src-tauri/target/` — Rust/Cargo（标准位置，不移动）

## 平台切换

`VITE_PLATFORM=web|tauri` 控制：

- **别名 `@adapter`**（vite.config.ts）：解析为 `web-adapter.ts` 或 `tauri-adapter.ts`
- **全局 `__PLATFORM__`**：通过 Vite `define` 编译时替换为字符串字面量
- Vue SFC 中需先赋值给局部常量：`const platform = __PLATFORM__`（模板无法直接访问全局 `declare const`，否则报 TS2339）

## 目录结构

- `src/layout/` — 整体布局（`AppLayout.vue`）
- `src/views/` — 页面组件/数据展示（含 `renderers/` 子目录）
- `src/components/` — 公共组件（按功能分子目录，如 `archive-panel/`）
- `src/composables/` — 公共组合式函数（模块级单例状态）
- `src/stores/` — Pinia 状态管理（仅 `app.ts`，纯 UI 状态）
- `src/plugins/` — 文件解析与压缩插件。**新增文件类型在此一处添加**：
  - `parser/` — 插件包装层（实现 `IFileParserPlugin`）
  - `parsers/` — 纯 TS 解析函数层（text/csv/json/log 等，从 `src/core/parsers/` 迁入）
  - `compression/` — 压缩插件（zip/gzip）
- `src/core/` — 核心逻辑纯 TS（`decompress`、`parser-engine`、`search`、`file-tree`、`task-scheduler`）
- `src/adapters/` — 平台适配器（**保留独立目录**，不在目标结构列表内）。`types.ts` 仅存 `IPlatformAdapter` 接口；共享领域类型已迁至 `src/types/`
- `src/types/` — 共享领域类型（`FileEntry`、`DecompressResult`、`ArchiveStatus` 等 9 个）
- `src/config/` — 应用常量（`layout.ts`：面板宽度默认值与边界）
- `src/styles/` — 公共样式
- `src/assets/` — 图标静态资源
- `src/api/` — 后端 API 接口

## 架构模式

- **插件系统**：`src/plugins/types.ts` 定义 `ICompressionPlugin` 和 `IFileParserPlugin`。新格式 = 新插件文件 + 在 `manifest.ts` 中注册，零核心改动。解析函数层在 `src/plugins/parsers/`（纯 TS 解析逻辑），插件包装层在 `src/plugins/parser/`（实现 `IFileParserPlugin` 接口并关联 Vue 渲染组件）。每个解析插件的 `getComponent()` 返回对应渲染器（如 `text` → `TextRenderer`、`csv` → `CsvRenderer`）。
- **适配器模式**：`src/adapters/types.ts` 定义 `IPlatformAdapter`（7 个方法）。WebAdapter 使用 fetch/Range/ReadableStream；TauriAdapter 使用懒加载 IPC `invoke`。`use-platform.ts` 通过 `__PLATFORM__` 编译时常量决定加载哪个适配器，并使用 Promise 缓存实现单例。共享领域类型（`FileEntry` 等）在 `src/types/`。
- **Composable 单例**：大多数 composable（`use-plugins`、`use-search`、`use-archives`、`use-tabs`）将状态保存在**模块级 ref** 中，而非 Pinia store。函数返回访问器。测试中调用 `reset()` 隔离状态。
- **Pinia**：仅 `src/stores/app.ts` — 纯 UI 状态（主题、面板宽度、禁用插件）。面板宽度默认值/边界常量提取至 `src/config/layout.ts`。
- **插件注册表**：`PluginRegistry` 类，`safeParse`/`safeDecompress` 通过 `withTimeout` 包装 30 秒超时。
- **解压管道**：`use-decompress.ts` — TaskScheduler(3) 并发控制，通过动态 import 接入 `use-archives.addFiles()`（避免 `use-archives` ↔ `use-decompress` 循环依赖）。流程：读取 ArrayBuffer → 检测压缩插件 → safeDecompress → FileTreeBuilder 构建树 → 更新 ArchiveItem 状态。

## 页面布局

`AppLayout.vue` 实现四栏布局：顶部 `PublicBar`（64px）+ 左侧 `ArchivePanel`（可折叠侧栏）+ 中间 `Workspace`（标签页+预览）+ 右侧 `PropertyPanel`（可折叠侧栏）。使用 Naive UI 的 `NLayout`/`NLayoutSider` 组件，面板宽度由 Pinia store 管理。

## 关键约定

- Vue 3 + `<script setup lang="ts">` + Composition API
- Naive UI 组件库（深色/浅色主题通过 `darkTheme` 导出 + `NConfigProvider`）
- 路径别名：`@/` 映射到 `src/`，测试中使用 `@/composables/...` 而非相对路径
- 测试约定：composable 测试在 `beforeEach` 中调用 `reset()` 隔离模块级状态
- Vitest 配置中 `@adapter` 始终解析为 `web-adapter`（测试环境无 Tauri）
- Rust 结构体使用 `#[serde(rename_all = "camelCase")]` 以兼容 TS
- Tauri 2：`src-tauri/capabilities/default.json` 是 IPC 权限必需文件
- Tauri 2：`src/lib.rs` 存放逻辑，`src/main.rs` 仅调用 `hello_tauri::run()`

## 已知特殊处理

- `tsconfig.node.json` 含 `skipLibCheck: true` — 抑制 `vue-tsc -b` 时 vitest 内部类型错误。
- `tauri.conf.json` 含 `"targets": []` — 跳过 WiX/NSIS 安装包生成。
- 压缩插件（zip）在 Web 端仅 Tauri 可用；gzip 有浏览器 `DecompressionStream` 回退。

## 文档

- 架构设计规格：`docs/superpowers/specs/2026-06-26-system-architecture-design.md`
- 实现计划（22 个任务）：`docs/superpowers/plans/2026-06-26-log-parser-implementation.md`
- 产品需求文档：`docs/design.md`
