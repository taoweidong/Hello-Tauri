---
kind: configuration_system
name: 配置系统 — 基于 Vite 构建期常量与 Tauri 静态配置的轻量方案
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.ts
    - src-tauri/tauri.conf.json
    - src/config/layout.ts
    - src/adapters/tauri-adapter.ts
    - src/adapters/web-adapter.ts
---

本仓库未引入运行时配置中心或配置文件加载器，而是采用「构建期常量 + 静态 JSON」的极简配置策略，通过 Vite 的 `define` 注入平台标识，由 Tauri CLI 读取 `tauri.conf.json` 完成应用元数据与窗口参数配置。

## 1. 使用的系统与工具
- **Vite**：通过 `vite.config.ts` 中的 `define.__PLATFORM__` 将 `VITE_PLATFORM` 环境变量编译为全局常量，驱动前端在 Web / Tauri 两套适配器间切换。
- **Tauri CLI**：以 `src-tauri/tauri.conf.json` 作为唯一的应用级配置源（产品名、版本、窗口尺寸、打包图标等）。
- **TypeScript 常量模块**：`src/config/layout.ts` 集中导出 UI 布局相关的硬编码常量（面板宽度上下限等），由 `src/config/index.ts` 统一再导出。

## 2. 关键文件与包
- `vite.config.ts` — 定义 `__PLATFORM__` 常量及 `@adapter` 别名，决定构建产物是否包含 `@tauri-apps/api`。
- `src-tauri/tauri.conf.json` — Tauri 2 应用清单，声明窗口、构建前后命令、bundle 图标等。
- `src/config/layout.ts` — 前端布局常量（左右面板默认/最小/最大宽度）。
- `src/adapters/tauri-adapter.ts` / `src/adapters/web-adapter.ts` — 根据 `__PLATFORM__` 在构建期被别名替换，实现同一份业务代码在不同运行时的行为差异。
- `package.json` — 顶层脚本 `tauri:dev` / `tauri:build` 驱动 Tauri 生命周期，间接消费 `tauri.conf.json`。

## 3. 架构与约定
- **无运行时配置加载**：应用不解析 `.env`、`.yaml`、`.toml` 等外部配置文件；所有可配置项在构建时确定。
- **平台开关通过构建期常量**：`VITE_PLATFORM=web|tauri` 传入 Vite，生成 `__PLATFORM__`，配合 `resolve.alias['@adapter']` 在打包阶段选择 `web-adapter` 或 `tauri-adapter`，从而让业务代码无需 `if (platform)` 分支。
- **UI 布局常量集中管理**：`src/config/layout.ts` 仅暴露只读常量，避免散落在组件中；当前没有持久化到本地存储的逻辑。
- **Tauri 配置即源码**：`tauri.conf.json` 随源码版本控制，修改后需重新执行 `npm run tauri:dev` 或 `tauri:build` 生效。

## 4. 开发者应遵循的规则
- 新增构建期常量 → 在 `vite.config.ts` 的 `define` 中注册，并通过 `process.env.VITE_*` 注入，不要使用 `import.meta.env` 做运行时判断。
- 新增平台差异化能力 → 扩展 `IPlatformAdapter` 并在 `src/adapters/*.ts` 中实现，保持 `@adapter` 别名不变。
- 调整 UI 布局阈值 → 修改 `src/config/layout.ts`，不要在各组件内重复定义。
- 修改应用元信息（名称、版本、窗口大小）→ 直接编辑 `src-tauri/tauri.conf.json`，然后重新运行 Tauri 命令。
- 不引入运行时配置中心：本项目刻意保持零运行时依赖，如需新增配置项，优先评估是否适合改为构建期常量或 Tauri 配置。

## 5. 置信度说明
该仓库确实存在一套清晰但极其轻量的配置体系，证据来自 `vite.config.ts`、`tauri.conf.json` 和 `src/config/` 三个位置的一致用法，且全仓未见任何运行时配置加载逻辑，因此置信度为 high。