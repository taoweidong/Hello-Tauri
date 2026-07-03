---
kind: build_system
name: Tauri + Vite 双端构建系统
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - vite.config.ts
    - src-tauri/Cargo.toml
    - src-tauri/tauri.conf.json
    - src-tauri/build.rs
---

本项目采用 Tauri 2 + Vue 3 + Vite 的混合构建体系，通过环境变量在 Web 与桌面两套前端产物间切换，Rust 后端由 Cargo 编译并打包为原生应用。

## 构建流程概览
- 前端构建：Vite 8 + Vue 3 + TypeScript，通过 __PLATFORM__ 常量与别名 @adapter 在 src/adapters/web-adapter.ts 与 src/adapters/tauri-adapter.ts 之间切换运行时实现。
- 桌面构建：Tauri CLI (@tauri-apps/cli) 作为桥接层，先执行 npm run build 产出静态资源到 build/web，再由 Rust crate 打包为平台可执行文件。
- 测试：Vitest 4 运行 src/__tests__ 下的单元测试，覆盖 core、plugins、stores、views/renderers 等模块。

## 关键配置
- package.json：定义 dev / build / tauri:dev / tauri:build 等脚本，Node 引擎要求 >=20。
- vite.config.ts：通过 process.env.VITE_PLATFORM（默认 web）控制别名解析与外部依赖排除；输出目录固定为 build/web。
- src-tauri/Cargo.toml：单一 Rust crate，依赖 tauri v2、tokio、zip、flate2、rayon、serde 等，使用 tauri-build v2 作为构建依赖。
- src-tauri/tauri.conf.json：声明产品名称、版本、窗口尺寸、图标路径，并通过 beforeDevCommand / beforeBuildCommand 串联 npm 构建步骤。
- src-tauri/build.rs：仅调用 tauri_build::build()，无自定义构建逻辑。

## 架构约定
- 前端与 Rust 后端的版本同步通过各自 package.json 与 Cargo.toml 中的 version 字段维护，当前均为 0.1.0。
- 适配器模式：所有平台相关能力（文件系统、IPC 等）均通过 @adapter 别名注入，业务代码不直接依赖具体平台。
- 开发体验：tauri dev 自动启动 Vite 开发服务器（http://localhost:5173），热重载前端并在 Tauri 窗口中预览。

## 开发者须知
- 切换前端运行环境需设置 VITE_PLATFORM=tauri（Tauri 模式）或 web（纯 Web 预览）。
- 新增 Rust 依赖后需重新生成 Tauri schema：npx tauri dev 会自动触发，也可手动运行 cargo build -p hello-tauri。
- 打包前确保已执行 npm run build，否则 frontendDist 指向的 build/web 为空。
- 当前未配置 CI/CD 流水线、Makefile、Dockerfile 或跨平台交叉编译脚本，发布流程依赖本地 npx tauri build。