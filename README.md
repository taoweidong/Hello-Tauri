# Hello-Tauri — 跨平台日志解析工具

基于 Vue 3 + Tauri 的微内核日志解析工具，支持 Web 和桌面双端构建。

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vue 3 + TypeScript + Vite |
| UI | Naive UI |
| 状态管理 | Pinia |
| 桌面 | Tauri 2 (Rust) |
| 测试 | Vitest + Vue Test Utils |

## 三方库依赖

### 运行时依赖

| 依赖 | 版本 | 功能 / 作用 |
|------|------|-------------|
| `vue` | ^3.5.39 | 前端框架，Composition API + `<script setup>` 响应式组件 |
| `naive-ui` | ^2.44.1 | Vue 3 组件库，提供深色/浅色主题、表格、树、对话框等 |
| `pinia` | ^3.0.4 | Vue 状态管理，setup store 语法 |
| `@vueuse/core` | ^14.3.0 | Vue 组合式工具集，提供 breakpoints、useStorage 等 |
| `@tauri-apps/api` | ^2.11.1 | Tauri 2 IPC 客户端，`invoke` 调用 Rust 后端命令 |
| `fflate` | ^0.8.3 | 纯 JS 压缩/解压库，Web 端 ZIP 解压回退（无需 WASM） |
| `splitpanes` | ^4.1.2 | 可拖拽分栏布局，支持最小/最大尺寸约束 |
| `vue-draggable-plus` | ^0.6.1 | Vue 拖拽排序组件，支持文件树节点拖拽 |

### 开发依赖

| 依赖 | 版本 | 功能 / 作用 |
|------|------|-------------|
| `typescript` | ~6.0.0 | TypeScript 编译器，静态类型检查 |
| `vite` | ^8.1.0 | 构建工具与开发服务器（Rolldown 引擎） |
| `@vitejs/plugin-vue` | ^6.0.7 | Vite 的 Vue SFC 插件，支持 HMR |
| `vue-tsc` | ^3.3.5 | Vue TypeScript 类型检查器，`--noEmit` 模式 |
| `vitest` | ^4.1.9 | 单元测试框架，兼容 Vite 生态 |
| `@vue/test-utils` | ^2.4.11 | Vue 组件测试工具，`mount` + `shallowMount` |
| `jsdom` | ^29.1.1 | 浏览器 DOM 模拟环境，测试中替代真实浏览器 |
| `@tauri-apps/cli` | ^2.11.3 | Tauri 命令行工具，`tauri dev` / `tauri build` |
| `@types/node` | ^26.0.1 | Node.js 类型声明 |

## 核心特性

- **插件化架构** — 内置 text/csv/json/hex 解析插件 + zip/gzip 压缩插件，可按需扩展
- **双端构建** — `vite build` 输出静态站点，`tauri build` 输出单文件 .exe
- **大文件友好** — mmap 零拷贝读取、虚拟滚动、分页加载
- **多任务并发** — TaskScheduler 控制解压并发数，支持队列和重试

## 快速开始

```bash
npm install

# Web 模式开发
npm run dev

# 桌面模式开发（需要 Rust 工具链）
npm run tauri:dev

# 类型检查 + 测试
npm run typecheck
npm test

# 构建
npm run build          # Web
npm run tauri:build    # 桌面
```

## 项目结构

```
├── src/
│   ├── adapters/
│   │   ├── types.ts              # 核心类型定义（FileTreeNode, ArchiveItem, IPlatformAdapter 等）
│   │   ├── web-adapter.ts        # Web 平台适配器（fetch + Range + ReadableStream）
│   │   └── tauri-adapter.ts      # Tauri 平台适配器（IPC invoke 懒加载）
│   ├── plugins/
│   │   ├── types.ts              # 插件接口（ICompressionPlugin, IFileParserPlugin, ConfigSchema）
│   │   ├── registry.ts           # PluginRegistry（注册/检测/超时保护/启用禁用）
│   │   ├── manifest.ts           # 内置插件注册入口
│   │   ├── parser/               # 解析插件：text / csv / json / hex
│   │   └── compression/          # 压缩插件：zip / gzip
│   ├── core/
│   │   ├── file-tree.ts          # FileTreeNode 构建、查找、扁平化
│   │   ├── task-scheduler.ts     # 并发控制任务调度器（队列 + 重试）
│   │   ├── search.ts             # SearchService 全文搜索
│   │   ├── decompress.ts         # DecompressService 解压编排
│   │   └── parser-engine.ts      # ParserEngine 文件解析引擎
│   ├── composables/
│   │   ├── use-archives.ts       # 压缩包管理（addFiles, remove, stats）
│   │   ├── use-tabs.ts           # 标签页管理（openTab, closeTab, togglePin）
│   │   ├── use-decompress.ts     # 解压管道（upload → decompress → tree → UI）
│   │   ├── use-platform.ts       # 平台检测与 adapter 工厂
│   │   ├── use-plugins.ts        # 插件引擎单例
│   │   ├── use-search.ts         # 搜索服务响应式封装
│   │   ├── use-vfs.ts            # 虚拟文件系统适配
│   │   └── use-panel-layout.ts   # 响应式面板布局（@vueuse/core breakpoints）
│   ├── stores/
│   │   └── app.ts                # Pinia setup store（主题、面板宽度、插件禁用）
│   ├── components/
│   │   ├── layout/AppLayout.vue  # 四栏布局（PublicBar / 左 / 中 / 右）
│   │   ├── shared/ErrorBoundary.vue
│   │   ├── public-bar/           # 顶部栏：GlobalStats + GlobalSearch + 批量操作
│   │   ├── archive-panel/        # 左侧栏：UploadZone + ArchiveCard + FileTree
│   │   ├── workspace/            # 中间区：TabBar + PreviewToolbar + PreviewPane + StatusBar
│   │   └── property-panel/       # 右侧栏：MetadataView + ConfigForm + PathBreadcrumb
│   ├── styles/theme.ts           # Naive UI 主题覆盖配置
│   ├── App.vue                   # 根组件（NConfigProvider → ErrorBoundary → AppLayout）
│   └── main.ts                   # 入口（createPinia + mount）
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                # Tauri Builder 初始化 + 命令注册
│   │   ├── main.rs               # 入口（调用 lib::run）
│   │   ├── commands.rs           # IPC 命令（read_file, write_file, mmap_read, decompress 等）
│   │   ├── file_ops.rs           # mmap 零拷贝读取 + 递归目录遍历
│   │   ├── decompress.rs         # zip / gzip 原生解压
│   │   └── error.rs              # AppError 枚举（Io, Decompress, NotFound）
│   ├── capabilities/default.json # Tauri 2 权限配置
│   ├── Cargo.toml                # Rust 依赖（tauri, memmap2, zip, flate2 等）
│   └── tauri.conf.json           # Tauri 窗口/构建配置
└── docs/
    ├── design.md                                         # 产品需求文档
    ├── superpowers/specs/2026-06-26-system-architecture-design.md  # 架构设计规格
    └── superpowers/plans/2026-06-26-log-parser-implementation.md   # 实现计划（22 任务）
```

## 文档

| 文档 | 说明 |
|------|------|
| [架构设计规格](docs/superpowers/specs/2026-06-26-system-architecture-design.md) | 前后端架构、组件选型、页面布局、PlantUML 图 |
| [实现计划](docs/superpowers/plans/2026-06-26-log-parser-implementation.md) | 22 个任务的逐步实现指南（含完整代码） |
| [产品需求文档](docs/design.md) | 原始产品设计与交互说明 |

## 许可证

MIT
