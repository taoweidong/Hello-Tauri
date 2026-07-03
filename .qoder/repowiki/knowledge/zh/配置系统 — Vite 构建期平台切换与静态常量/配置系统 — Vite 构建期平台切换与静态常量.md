---
kind: configuration_system
name: 配置系统 — Vite 构建期平台切换与静态常量
category: configuration_system
scope:
    - '**'
source_files:
    - vite.config.ts
    - src/vite-env.d.ts
    - src/config/layout.ts
    - src/config/index.ts
    - src-tauri/tauri.conf.json
    - src-tauri/Cargo.toml
---

本仓库未实现运行时应用级配置加载（如 .env、配置文件解析、动态 feature flag），而是采用“构建期常量 + 静态导出”的轻量配置方式，核心围绕以下三个层面：

1. **Vite 构建期平台常量**
   - `vite.config.ts` 通过 `process.env.VITE_PLATFORM` 决定 `__PLATFORM__` 常量值（默认 `'web'`），并在 `define` 中注入到前端代码。
   - 同时基于该变量切换 `@adapter` 别名指向 `src/adapters/tauri-adapter` 或 `src/adapters/web-adapter`，实现同一份前端源码在 Tauri 桌面端与纯 Web 环境间编译出不同产物。
   - `src/vite-env.d.ts` 声明 `__PLATFORM__: 'web' | 'tauri'`，供 TypeScript 类型检查使用。
   - 典型用法见 `src/composables/use-platform.ts` 与压缩插件中通过 `__PLATFORM__ === 'tauri'` 分支调用原生能力。

2. **前端静态配置常量**
   - `src/config/layout.ts` 以纯 TS 模块导出布局尺寸等 UI 常量（左右面板默认宽度、最小/最大宽度），由 `src/config/index.ts` 统一 re-export。
   - 这些常量是编译期确定的，无运行时读取、无持久化、无 schema 校验，属于“硬编码可配置项”。

3. **Tauri 应用元数据配置**
   - `src-tauri/tauri.conf.json` 定义应用名称、版本、窗口尺寸、打包图标、构建前后命令等，由 Tauri CLI 在构建时消费。
   - `src-tauri/Cargo.toml` 仅承载 Rust crate 依赖与版本信息，不包含应用运行参数。

**设计决策与约束**
- 当前项目处于早期阶段，配置系统尚未抽象为统一的运行时配置层；所有“可配置项”均以编译期常量形式存在。
- 若未来需要支持用户自定义（如主题、快捷键、插件开关），应引入集中式配置入口（例如 `src/config/index.ts` 扩展为加载 JSON/YAML 并合并默认值），并通过 `useConfig` 之类的 composable 暴露给组件。
- 环境变量仅用于构建期选择平台（`VITE_PLATFORM`），不用于传递运行时敏感信息。

**关键文件**
- `vite.config.ts` — 构建期平台常量与别名切换
- `src/vite-env.d.ts` — `__PLATFORM__` 类型声明
- `src/config/layout.ts` / `src/config/index.ts` — 前端静态配置常量
- `src-tauri/tauri.conf.json` — Tauri 应用元数据
- `src-tauri/Cargo.toml` — Rust 后端依赖清单