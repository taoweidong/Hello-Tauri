---
kind: build_system
name: Tauri 2 + Vite 混合构建系统
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

本项目采用 Tauri 2 + Vite/Vue3 的混合构建体系，由顶层 package.json 统一驱动前端与 Rust 后端的编译、打包与发布流程。

## 1. 构建系统与工具链
- 前端构建: Vite 8 + Vue 3 + TypeScript (vue-tsc)，输出目录为 build/web/
- 桌面后端: Tauri 2 CLI (@tauri-apps/cli) 管理 Rust crate (src-tauri/)，使用 Cargo 编译
- 测试: Vitest 4，基于 jsdom 模拟浏览器环境
- Node 版本要求: >=20（通过 engines 字段约束）

## 2. 关键文件与职责
- package.json: 统一脚本入口：dev/build/test/tauri:dev/tauri:build
- vite.config.ts: 平台别名切换（@adapter -> tauri-adapter 或 web-adapter），定义 __PLATFORM__ 常量
- src-tauri/Cargo.toml: Rust 依赖声明（tauri 2、tokio、zip、flate2、rayon 等）
- src-tauri/tauri.conf.json: Tauri 应用配置：版本号、窗口尺寸、前后端集成命令
- src-tauri/build.rs: 调用 tauri_build::build() 生成类型绑定

## 3. 架构与约定
双平台适配器模式：Vite 通过 resolve.alias 根据环境变量 VITE_PLATFORM 在运行时注入不同实现。VITE_PLATFORM=web 指向 src/adapters/web-adapter.ts，VITE_PLATFORM=tauri 指向 src/adapters/tauri-adapter.ts，使同一份业务代码可在浏览器和桌面端复用。

前后端集成流程：npm run tauri:dev 启动 Tauri dev server，自动执行 beforeDevCommand: npm run dev，将 http://localhost:5173 作为前端 URL；npm run tauri:build 先执行 beforeBuildCommand: npm run build 产出静态资源到 build/web/，再由 Tauri bundle 打包为原生安装包。tauri.conf.json 中 frontendDist 指向 ../build/web，完成前后端产物衔接。

版本管理：应用版本在两个位置同步维护——package.json#version 与 src-tauri/tauri.conf.json#version，当前均为 0.1.0，无自动化同步脚本。

## 4. 开发者应遵循的规则
- 新增依赖时：前端依赖加到 dependencies/devDependencies，Rust 依赖加到 src-tauri/Cargo.toml，不要混放
- 修改版本号：需同时更新 package.json 与 src-tauri/tauri.conf.json 中的 version
- 平台适配：新增平台相关逻辑时，应在 src/adapters/ 下分别实现 tauri-adapter.ts 与 web-adapter.ts，并通过 @adapter 别名引用，而非直接 import 具体文件
- 构建入口：始终通过 npm run tauri:* 脚本触发构建，不要绕过 Tauri CLI 直接调用 vite/cargo
- 测试运行：使用 npm test / npm run test:watch，无需额外配置

## 5. 缺失项说明
仓库中未发现 CI/CD 配置文件（.github/workflows/、Makefile、Dockerfile、*.sh 等），本地构建完全依赖 npm scripts + tauri CLI 组合。