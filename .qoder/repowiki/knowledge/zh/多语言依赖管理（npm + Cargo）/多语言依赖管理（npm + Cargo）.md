---
kind: dependency_management
name: 多语言依赖管理（npm + Cargo）
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

本仓库是一个 Tauri 2 + Vue 3 桌面应用，采用双语言栈：前端使用 npm 生态，后端 Rust 使用 Cargo。两套依赖体系各自独立声明与锁定，无跨语言共享的包管理器或 vendoring 策略。

### 1. 前端依赖（npm / Node.js）
- **声明文件**：根目录 `package.json`，通过 `dependencies` 与 `devDependencies` 划分运行期与开发期依赖。
- **锁定文件**：根目录 `package-lock.json`（lockfileVersion 3），由 npm 生成并随仓库提交，保证构建可重现。
- **版本策略**：生产依赖普遍使用 `^` 前缀（如 `vue ^3.5.39`、`naive-ui ^2.44.1`、`@tauri-apps/api ^2.11.1`），允许小版本/补丁自动升级；TypeScript 等工具链使用 `~` 前缀（`typescript ~6.0.0`）以限制次版本漂移。
- **引擎约束**：`engines.node >= 20` 强制最低 Node 版本。
- **私有子项目**：`.opencode/package.json` 是独立的 OpenCode 插件子包，仅声明一个运行时依赖 `@opencode-ai/plugin 1.17.11`，其自身也带有 `package-lock.json`，形成嵌套的 npm 工作区。
- **构建脚本**：`scripts` 中通过 `tauri dev/build` 桥接 Tauri CLI，其余为 Vite/Vitest/vue-tsc 命令，未定义自定义安装钩子。
- **注册源**：从 `package-lock.json` 中的 `resolved: https://registry.npmmirror.com/...` 可见默认镜像指向国内 npmmirror，但未在仓库内显式配置 `.npmrc`。

### 2. 后端依赖（Cargo / Rust）
- **声明文件**：`src-tauri/Cargo.toml`，将 `tauri = { version = "2", features = [] }` 等 crate 作为 `[dependencies]` 列出，构建时依赖放在 `[build-dependencies]`。
- **锁定文件**：`src-tauri/Cargo.lock`（version 4），由 Cargo 自动生成并提交，记录每个 crate 的精确版本与 checksum，来源统一为 `registry+https://github.com/rust-lang/crates.io-index`。
- **版本策略**：所有 crate 均使用宽松语义化版本（如 `tokio 1`、`serde 1`、`zip 2`），不指定具体次/补丁号，依赖 Cargo 的语义化解析。
- **特性开关**：仅在 `tauri` 与 `tauri-build` 上显式开启空 `features = []`，其他 crate 按需启用（如 `serde { features = ["derive"] }`、`tokio { features = ["full"] }`）。
- **无 vendoring**：未见 `Cargo vendor` 产物或 `source = "local"` 条目，完全依赖 crates.io 远程索引。

### 3. 架构与约定
- **前后端解耦**：前端通过 `@tauri-apps/api` 调用 Rust 侧暴露的 IPC 命令，但两者依赖版本互不影响，分别由各自的 lockfile 锁定。
- **无 monorepo 工作区**：虽然存在 `.opencode` 子目录，但它不是 npm workspace，而是独立包，需单独安装。
- **无私有仓库/代理配置**：未发现 `.npmrc`、`cargo config.toml` 或 CI 环境变量级别的私有源配置，全部走公开源。
- **无依赖更新自动化**：仓库内未检出 Dependabot、Renovate 等配置文件，依赖升级依赖人工维护。

### 4. 开发者应遵循的规则
- 新增依赖时同时更新对应 `package.json` 或 `Cargo.toml`，并确保锁文件已提交。
- 生产依赖优先使用 `^`，仅对编译器/类型检查等工具链使用 `~` 以稳定构建。
- 如需引入私有 npm 包或 crates，应在仓库根或 `src-tauri` 下显式配置 `.npmrc` / `config.toml`，避免依赖本地环境。
- 升级依赖后重新生成 lockfile 并验证 `tauri build` 与 `npm test` 通过。