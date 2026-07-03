---
kind: error_handling
name: 跨端错误处理体系：Rust thiserror + Vue ErrorBoundary + 适配器模式
category: error_handling
scope:
    - '**'
source_files:
    - src-tauri/src/error.rs
    - src-tauri/src/commands.rs
    - src-tauri/src/decompress.rs
    - src/adapters/tauri-adapter.ts
    - src/adapters/web-adapter.ts
    - src/components/shared/ErrorBoundary.vue
---

## 1. 整体方案概述
本仓库采用「Rust 后端显式错误枚举 + Tauri IPC Result 传播」与「Vue 前端组件级错误边界」相结合的双层错误处理策略。Rust 侧使用 `thiserror` 定义统一业务错误类型并通过 `tauri::command` 的 `Result<T, AppError>` 返回；前端通过 `TauriAdapter` / `WebAdapter` 两套平台适配器屏蔽差异，并在 UI 层用 `ErrorBoundary.vue` 捕获渲染期异常。

## 2. Rust 后端（src-tauri）
- **统一错误类型**：`src-tauri/src/error.rs` 中定义 `AppError` 枚举，包含 `Io(std::io::Error)`、`Decompress(String)`、`NotFound(String)` 三个变体，借助 `#[derive(thiserror::Error)]` 自动生成 `Display`/`From` 实现，并手动实现 `Serialize` 以便序列化到前端。
- **命令层传播**：`src-tauri/src/commands.rs` 中所有 `#[tauri::command]` 函数均返回 `Result<..., AppError>`，IO 错误通过 `map_err(AppError::Io)` 转换，路径穿越等安全校验直接构造 `AppError::Io(PermissionDenied, ...)` 拒绝。
- **解压模块**：`src-tauri/src/decompress.rs` 将 zip/gzip 解析错误包装为 `AppError::Decompress(e.to_string())`；`decompress` 命令对不支持的格式走“成功但带 error 字段”的降级路径（`DecompressResult.success=false`），而非抛错。
- **panic/recover**：未发现 `panic!` 或 `std::panic::catch_unwind`，全部错误以 `Result` 形式向上冒泡。

## 3. 前端适配层（src/adapters）
- **TauriAdapter**（`src/adapters/tauri-adapter.ts`）：调用 `@tauri-apps/api/core` 的 `invoke`，不自行 try/catch，依赖 Tauri 将 Rust `Err` 转为 Promise reject，由上层调用方处理。
- **WebAdapter**（`src/adapters/web-adapter.ts`）：在 Web 模式下对不支持的能力主动 `throw new Error(...)`（如 `writeFile`、`listFiles`、`decompress`），HTTP 失败时抛出含状态码的错误信息；`streamRead` 内部用 try/catch 包裹 fetch 并将错误通过 `controller.error(e)` 注入流。

## 4. 前端 UI 层（Vue 组件）
- **ErrorBoundary**（`src/components/shared/ErrorBoundary.vue`）：基于 Vue 3 的 `onErrorCaptured` 钩子捕获子树渲染异常，显示 Naive UI 的 `NResult` 并提供“重试”按钮重置状态。该组件作为可复用兜底，避免单点崩溃导致整页白屏。
- 除 `ErrorBoundary` 外，应用代码中未见全局 `try/catch` 或自定义错误中间件，主要依赖组件级边界与适配器层的明确抛错语义。

## 5. 架构约定与设计决策
| 层面 | 约定 |
|---|---|
| Rust 错误定义 | 集中放在 `error.rs`，新增业务错误以 `AppError` 变体扩展，优先使用 `thiserror` 派生 Display/From |
| 命令返回值 | 一律 `Result<T, AppError>`，禁止 `panic!`；IO 错误统一经 `map_err(AppError::Io)` 转换 |
| 跨进程错误 | 通过 Tauri 自动序列化 `AppError` 字符串，前端以 Promise reject 接收 |
| 前端适配器 | 不支持的能力显式 `throw new Error`，保持调用方可区分“能力缺失”与“运行时错误” |
| UI 容错 | 使用 `ErrorBoundary` 包裹易崩溃视图，提供用户可恢复的重试入口 |

## 6. 开发者应遵循的规则
1. **新增 Rust 错误**：在 `src-tauri/src/error.rs` 追加 `AppError` 变体，必要时实现 `Serialize`。
2. **IPC 命令**：返回 `Result<_, AppError>`，不要吞掉错误；需要向用户展示的可恢复错误建议走 `DecompressResult` 这类结构化结果。
3. **前端调用**：在适配器之上使用 try/catch 或 `.catch()` 处理 Promise reject；对不支持的平台能力，依赖适配器抛出的明确错误消息。
4. **UI 健壮性**：将可能抛出异常的视图组件放入 `<ErrorBoundary>` 包裹范围，确保局部错误不影响全局。
5. **禁止 panic**：Rust 侧不使用 `panic!`，所有异常路径都应映射到 `AppError`。