# 跨平台日志解析工具 — 系统架构设计

## 1. 总体架构

### 1.1 分层架构

```
┌─────────────────────────────────────────────────────┐
│                    UI Layer (Vue 3)                  │
│  ┌──────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐ │
│  │公共栏│ │压缩包列表│ │预览工作区│ │ 属性面板  │ │
│  └──┬───┘ └────┬─────┘ └────┬─────┘ └─────┬──────┘ │
├─────┴──────────┴────────────┴──────────────┴────────┤
│              Composables Layer (响应式状态)           │
│  useArchiveManager / useTabManager / usePluginEngine │
├─────────────────────────────────────────────────────┤
│              Core Services Layer                     │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │DecompressSvc │ │ ParserEngine │ │SearchService │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ │
├─────────┴────────────────┴────────────────┴─────────┤
│              Plugin Registry (插件注册中心)           │
│  ICompressionPlugin[]  /  IFileParserPlugin[]        │
├─────────────────────────────────────────────────────┤
│              Platform Adapter Layer                  │
│         WebAdapter (WASM)  |  TauriAdapter (IPC)    │
└─────────────────────────────────────────────────────┘
```

### 1.2 项目目录结构

```
hello-tauri/
├── src/
│   ├── adapters/              # 平台适配层
│   │   ├── types.ts           # IPlatformAdapter 接口定义
│   │   ├── web-adapter.ts     # Web 端实现（WASM）
│   │   └── tauri-adapter.ts   # Tauri 端实现（Rust IPC）
│   ├── plugins/               # 插件系统
│   │   ├── types.ts           # ICompressionPlugin, IFileParserPlugin
│   │   ├── registry.ts        # 插件注册中心
│   │   ├── compression/       # 解压插件
│   │   │   ├── zip-plugin.ts
│   │   │   ├── gzip-plugin.ts
│   │   │   ├── sevenz-plugin.ts
│   │   │   └── rar-plugin.ts
│   │   └── parser/            # 文件解析插件
│   │       ├── text-plugin.ts
│   │       ├── csv-plugin.ts
│   │       ├── json-plugin.ts
│   │       └── xml-plugin.ts
│   ├── core/                  # 核心业务逻辑
│   │   ├── decompress.ts      # 解压调度器
│   │   ├── parser-engine.ts   # 解析调度引擎
│   │   ├── search.ts          # 搜索服务
│   │   ├── file-tree.ts       # 文件树构建与虚拟滚动数据
│   │   └── task-scheduler.ts  # 任务队列与并发控制
│   ├── composables/           # Vue 组合式函数
│   │   ├── use-archives.ts
│   │   ├── use-tabs.ts
│   │   ├── use-plugins.ts
│   │   ├── use-search.ts
│   │   ├── use-platform.ts
│   │   └── use-vfs.ts
│   ├── components/            # UI 组件
│   │   ├── layout/            # 布局组件
│   │   ├── public-bar/        # 顶部公共信息栏
│   │   ├── archive-panel/     # 左侧压缩包列表
│   │   ├── workspace/         # 中间预览工作区
│   │   ├── property-panel/    # 右侧属性面板
│   │   └── shared/            # 通用基础组件
│   ├── stores/                # Pinia 全局状态（极少量）
│   │   └── app.ts
│   ├── styles/
│   │   ├── variables.css
│   │   ├── dark.css
│   │   └── light.css
│   ├── main.ts
│   └── App.vue
├── src-tauri/                 # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs        # IPC 命令注册
│   │   ├── file_ops.rs        # mmap 文件读取
│   │   └── decompress.rs      # 原生解压
│   └── Cargo.toml
├── public/
├── index.html
├── vite.config.ts
├── tsconfig.json
├── package.json
└── tauri.conf.json
```

## 2. 核心接口设计

### 2.1 IPlatformAdapter — 平台抽象

```
IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>   // Tauri 端零拷贝
  streamRead(path: string): ReadableStream<Uint8Array>                           // Web 端流式
}
```

Vite 环境变量 `VITE_PLATFORM=web|tauri` 控制编译期条件导入：

```
// use-platform.ts
const adapter: IPlatformAdapter =
  import.meta.env.VITE_PLATFORM === 'tauri'
    ? new TauriAdapter()
    : new WebAdapter()
```

### 2.2 ICompressionPlugin — 压缩格式插件

```
ICompressionPlugin {
  name: string                        // 'zip', '7z', etc.
  supportedExtensions: string[]       // ['.zip', '.jar']
  canHandle(file: FileEntry): boolean // 魔数检测
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
  getProgress?(): Observable<number>  // 可选进度流
}
```

### 2.3 IFileParserPlugin — 文件解析插件

```
IFileParserPlugin {
  name: string
  supportedExtensions: string[]
  canParse(file: FileEntry): boolean
  parse(data: Uint8Array, options?: any): Promise<ParsedContent>
  getComponent(): Component           // 返回渲染用的 Vue 组件
  getConfigSchema?(): ConfigSchema    // 可选的配置表单声明
  getSearchAdapter?(): ISearchAdapter // 可选的搜索适配器
}
```

### 2.4 平台切换编译配置

```
// vite.config.ts
const platform = process.env.VITE_PLATFORM || 'web'

export default defineConfig({
  define: {
    __PLATFORM__: JSON.stringify(platform)
  },
  resolve: {
    alias: {
      '@adapter': platform === 'tauri'
        ? './src/adapters/tauri-adapter'
        : './src/adapters/web-adapter'
    }
  },
  build: {
    rollupOptions: {
      external: platform === 'web'
        ? ['@tauri-apps/api/**']
        : []
    }
  }
})
```

## 3. 插件系统设计

### 3.1 注册中心架构

```
┌─────────────────────────────────┐
│        PluginRegistry           │
│                                 │
│  compressionPlugins: Map<       │
│    string, ICompressionPlugin>  │
│                                 │
│  parserPlugins: Map<            │
│    string, IFileParserPlugin>   │
│                                 │
│  +register()                    │
│  +getCompression(name)          │
│  +getParser(ext)                │
│  +detect(file) → plugin         │
│  +enable(name) / disable(name)  │
└─────────────────────────────────┘
```

插件注册采用显式清单文件方式：

```
// plugins/manifest.ts
export const compressionManifest: ICompressionPlugin[] = [
  new ZipPlugin(),
  new GzipPlugin(),
  new SevenZPlugin(),
  new RarPlugin(),
]

export const parserManifest: IFileParserPlugin[] = [
  new TextPlugin(),
  new CsvPlugin(),
  new JsonPlugin(),
  new XmlPlugin(),
]
```

`main.ts` 启动时调用 `registry.registerAll(manifest)` 完成初始化。

### 3.2 插件隔离机制

```
// registry.ts — 沙箱执行
async safeDecompress(plugin, data, outputDir): Promise<DecompressResult> {
  try {
    return await Promise.race([
      plugin.decompress(data, outputDir),
      timeout(PLUGIN_TIMEOUT_MS)        // 超时保护
    ])
  } catch (err) {
    this.emit('plugin-error', { plugin: plugin.name, err })
    return { success: false, error: err.message, files: [] }
  }
}
```

### 3.3 文件类型到插件的匹配

```
detect(file: FileEntry): IFileParserPlugin | null {
  for (const plugin of this.parserPlugins.values()) {
    if (plugin.canParse(file)) return plugin
  }
  return null   // 回退到原始十六进制查看器
}
```

### 3.4 插件热更新

```
enable(name: string): void   // 运行时启用
disable(name: string): void  // 运行时禁用，触发 UI 重新渲染
```

禁用后该插件对应的文件回退到默认查看器。

## 4. 数据流设计

### 4.1 解压流程

```
用户上传压缩包
    ↓
ArchiveManager 创建 ArchiveItem（状态: pending）
    ↓
TaskScheduler.enqueue(item, priority=0)
    ↓
TaskScheduler 按并发上限（默认 3）出队
    ↓
DecompressService：
  1. adapter.readFile() 获取二进制
  2. registry.detect(file) 匹配 ICompressionPlugin
  3. plugin.decompress() → 递归解压嵌套压缩包
  4. 构建 FileTreeNode 树
    ↓
更新 ArchiveItem.status = completed
    ↓
UI 响应式刷新（文件树渲染）
```

### 4.2 文件预览流程

```
用户点击文件树节点
    ↓
TabManager.openTab(file) → 创建或激活标签页
    ↓
ParserEngine：
  1. adapter.readFile(file.path) 获取二进制
  2. registry.detect(file) 匹配 IFileParserPlugin
  3. plugin.parse(data, options) → ParsedContent
    ↓
<component :is="plugin.getComponent()" :content="parsed" />
    ↓
属性面板自动注入 plugin.getConfigSchema() 表单
```

### 4.3 全局搜索流程

```
用户输入关键词
    ↓
SearchService：
  1. 遍历所有已解压文件列表
  2. 按文件扩展名匹配 plugin.getSearchAdapter()
  3. 分发到 Web Worker（Web）/ Rust 线程（Tauri）
  4. 并行搜索，结果聚合
    ↓
SearchResults 列表渲染
    ↓
点击结果项 → TabManager.openTab(file, { line, highlight })
```

## 5. 关键 Composables 设计

| Composable | 职责 | 核心 API |
|---|---|---|
| `useArchiveManager()` | 管理压缩包生命周期 | `addFiles(files[])`, `remove(id)`, `retry(id)`, `archives` (reactive) |
| `useTabManager()` | 标签页 CRUD | `open(file)`, `close(id)`, `tabs`, `activeTab`, `splitView(id, dir)` |
| `usePluginEngine()` | 插件注册中心封装 | `detect(file)`, `getComponent(file)`, `enable/disable(name)` |
| `useSearch()` | 全局搜索 | `search(keyword)`, `results`, `searching`, `jumpTo(result)` |
| `usePlatform()` | 平台适配器单例 | `adapter: IPlatformAdapter`, `isTauri`, `isWeb` |
| `useVirtualFileSystem()` | VFS 抽象 | `readFile(path)`, `listDir(path)`, `getTree(archiveId)` |

## 6. 状态管理策略

| 状态类型 | 存储位置 | 示例 |
|---|---|---|
| UI 局部状态 | 组件 `ref()` | 下拉菜单展开、输入框内容 |
| 跨组件共享状态 | Composable（模块级 reactive） | 当前激活标签页、选中文件 |
| 全局持久状态 | Pinia store | 主题偏好、插件启禁用、面板布局 |

绝大多数状态通过 Composable 管理，Pinia 仅用于极少量全局持久化配置。

## 7. 错误处理设计

| 层级 | 错误类型 | 处理方式 |
|---|---|---|
| 平台层 | 文件读写失败、IPC 断连 | Adapter 抛出 → Composable 捕获 → 状态标记 error |
| 插件层 | 解压失败、解析异常、超时 | Registry 沙箱捕获 → 插件错误事件 → UI 提示 |
| 业务层 | 文件不存在、格式不支持 | 回退到十六进制查看器或空状态提示 |
| UI 层 | 组件渲染异常 | `ErrorBoundary` 包裹，降级显示错误信息 |

## 8. 测试策略

| 类型 | 覆盖目标 | 工具 |
|---|---|---|
| 单元测试 | Composable 逻辑、工具函数、插件解析 | Vitest |
| 组件测试 | UI 组件渲染与交互 | Vitest + Vue Test Utils |
| 插件测试 | 各插件 canHandle / decompress / parse | Vitest + 测试夹具文件 |
| E2E 测试 | 端到端流程（上传→解压→预览→搜索） | Playwright（Web）|
| 性能测试 | 10万+文件树渲染、大文件虚拟滚动 | 手动基准 + CI 阈值 |

## 9. 构建产物

| 平台 | 命令 | 产物 |
|---|---|---|
| Web | `vite build --mode web` | 静态 HTML/JS/CSS + WASM |
| Windows EXE | `tauri build` | 单文件 .exe (~8-15MB) |
| 开发 | `vite dev` + `tauri dev` | HMR + Rust 热重载 |
