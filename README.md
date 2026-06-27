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
