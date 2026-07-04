---
kind: error_handling
name: 跨层错误处理：Rust thiserror + Tauri IPC 异常传播与 Vue 边界捕获
category: error_handling
scope:
    - '**'
source_files:
    - src-tauri/src/error.rs
    - src-tauri/src/commands.rs
    - src-tauri/src/decompress.rs
    - src-tauri/src/file_ops.rs
    - src/components/shared/ErrorBoundary.vue
    - src/adapters/tauri-adapter.ts
---

## 1. 整体方案
本仓库采用「分层错误模型」：
- Rust 后端使用 `thiserror` 定义强类型枚举 `AppError`，通过 `Result<T, AppError>` 统一向上返回；
- Tauri IPC 命令直接以 `Result<..., AppError>` 暴露给前端，Tauri 自动将 `Err(AppError)` 序列化为字符串（`AppError` 实现了 `Serialize`）；
- 前端通过适配器调用 `@tauri-apps/api/core.invoke`，所有失败以 Promise reject 形式抛出原生 Error，由组件级 `onErrorCaptured` 在 `ErrorBoundary.vue` 中兜底渲染。

## 2. 关键文件与职责
- `src-tauri/src/error.rs` — 全局错误枚举定义与序列化实现
- `src-tauri/src/commands.rs` — Tauri 命令入口，统一用 `Result<..., AppError>` 返回错误
- `src-tauri/src/decompress.rs` / `file_ops.rs` — 业务层函数，通过 `?` 和 `map_err` 将底层 IO/解压错误转为 `AppError`
- `src/components/shared/ErrorBoundary.vue` — Vue 3 组件级错误捕获与展示
- `src/adapters/tauri-adapter.ts` — 平台适配层，透传 invoke 的 Promise reject 给上层 composable/store

## 3. 架构与约定
### Rust 侧
- 单一 `AppError` 枚举承载所有领域错误：`Io(std::io::Error)`、`Decompress(String)`、`NotFound(String)`；
- 使用 `#[from]` 自动从 `std::io::Error` 转换，配合 `?` 运算符在业务函数中短路返回；
- 对非 IO 场景（如路径穿越、不支持的压缩格式）手动构造 `AppError` 或返回带 `error: Some(...)` 的 `DecompressResult`；
- 所有 `#[tauri::command]` 函数签名均为 `-> Result<T, AppError>`，不自行 catch，交由 Tauri 框架序列化并传给前端。

### 前端侧
- 适配器方法直接 await invoke，不吞掉 reject，让上层 composable/store 决定重试或上报；
- 视图层通过 `<ErrorBoundary>` 包裹易崩溃的子树，利用 `onErrorCaptured` 拦截子组件抛出的 Error，并以 Naive UI 的 `NResult` 展示“渲染异常”及 message，提供“重试”按钮重置状态；
- 未覆盖到全局 try/catch 或 window.onerror 的统一日志上报逻辑。

## 4. 开发者应遵循的规则
1. **新增 Rust 错误**：在 `AppError` 枚举中添加变体，优先复用 `#[from] std::io::Error`，仅在语义不同（如 Decompress/NotFound）时自定义；
2. **IPC 命令返回**：一律使用 `Result<T, AppError>`，不要在前端侧 catch 后再包装新错误类型；
3. **业务函数错误传播**：使用 `?` 和 `map_err(AppError::*)` 将底层错误上抛，禁止在业务层 `unwrap()/expect()`；
4. **前端错误消费**：在 composable/store 层区分“可恢复错误”（显示用户提示）与“致命错误”（触发 ErrorBoundary），避免在适配器层吞掉异常；
5. **UI 兜底**：任何可能异步失败的子树都应被 `<ErrorBoundary>` 包裹，确保应用不会白屏。