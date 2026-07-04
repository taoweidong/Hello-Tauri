---
kind: dependency_management
name: 依赖管理 — npm + Cargo 双栈锁定策略
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - src-tauri/Cargo.toml
    - src-tauri/Cargo.lock
    - .opencode/package.json
---

本项目采用前端与后端各自独立的包管理器，通过锁文件保证构建可复现：

- **前端（Vue 3 + Vite）**：使用 npm，依赖声明在根 `package.json`，通过 `package-lock.json`（lockfileVersion 3）锁定所有子依赖版本；Node 运行时要求通过 `engines.node >=20` 约束。
- **Rust 后端（Tauri 2）**：使用 Cargo，依赖声明在 `src-tauri/Cargo.toml`，通过 `src-tauri/Cargo.lock` 锁定 crate 及其传递依赖的精确版本与 checksum。
- **工具链子项目**：`.opencode/package.json` 是独立于主工程的 AI 插件工作区，拥有自己的 `package-lock.json`，与主工程隔离。

关键约定：
- 未使用任何私有 npm registry 或镜像配置，也未见 `.npmrc`/`.yarnrc`/`pnpm-workspace.yaml`，默认走公共源（从 lock 中可见 `registry.npmmirror.com` 为实际解析来源）。
- 未对第三方依赖进行 vendoring（无 `vendor/`、`node_modules` 提交），依赖安装由包管理器在 CI/本地完成。
- 前后端均遵循“声明式版本 + 锁文件”模式，升级依赖需同步更新对应 lock 文件。