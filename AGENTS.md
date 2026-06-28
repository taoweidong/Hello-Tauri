# AGENTS.md

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
| 单个测试 | `npx vitest run src/__tests__/core/search.test.ts` |
| 构建（Web） | `npm run build`（vue-tsc -b && vite build） |
| 构建（桌面） | `npm run tauri:build` |
| Rust 检查 | `cargo check`（workdir: src-tauri/） |
| Rust 测试 | `cargo test`（workdir: src-tauri/） |

未配置 lint 或格式化脚本。

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

## 架构模式

- **插件系统**：`src/plugins/types.ts` 定义 `ICompressionPlugin` 和 `IFileParserPlugin`。新格式 = 新插件文件 + 在 `manifest.ts` 中注册，零核心改动。
- **适配器模式**：`src/adapters/types.ts` 定义 `IPlatformAdapter`（7 个方法）。WebAdapter 使用 fetch/Range/ReadableStream；TauriAdapter 使用懒加载 IPC `invoke`。
- **Composable 单例**：大多数 composable（`use-plugins`、`use-search`、`use-archives`、`use-tabs`）将状态保存在**模块级 ref** 中，而非 Pinia store。函数返回访问器。测试中调用 `reset()` 隔离状态。
- **Pinia**：仅 `src/stores/app.ts` — 纯 UI 状态（主题、面板宽度、禁用插件）。
- **插件注册表**：`PluginRegistry` 类，`safeParse`/`safeDecompress` 通过 `withTimeout` 包装 30 秒超时。
- **解压管道**：`use-decompress.ts` — TaskScheduler(3) 并发控制，通过动态 import 接入 `use-archives.addFiles()`（避免循环依赖）。

## 关键约定

- Vue 3 + `<script setup lang="ts">` + Composition API
- Naive UI 组件库（深色/浅色主题通过 `darkTheme` 导出 + `NConfigProvider`）
- 路径别名：`@/` 映射到 `src/`
- Rust 结构体使用 `#[serde(rename_all = "camelCase")]` 以兼容 TS
- Tauri 2：`src-tauri/capabilities/default.json` 是 IPC 权限必需文件
- Tauri 2：`src/lib.rs` 存放逻辑，`src/main.rs` 仅调用 `hello_tauri::run()`

## 已知特殊处理

- `vitest.config.ts` 第 6 行：`vue() as any` — vitest/vite 版本类型冲突必需的强制转换，不要移除。
- `tsconfig.node.json` 含 `skipLibCheck: true` — 抑制 `vue-tsc -b` 时 vitest 内部类型错误。
- `tauri.conf.json` 含 `"targets": []` — 跳过 WiX/NSIS 安装包生成。
- 压缩插件（zip）在 Web 端仅 Tauri 可用；gzip 有浏览器 `DecompressionStream` 回退。

## 文档

- 架构设计规格：`docs/superpowers/specs/2026-06-26-system-architecture-design.md`
- 实现计划（22 个任务）：`docs/superpowers/plans/2026-06-26-log-parser-implementation.md`
- 产品需求文档：`docs/design.md`
