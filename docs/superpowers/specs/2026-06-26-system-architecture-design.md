# 跨平台日志解析工具 — 系统架构设计

## 1. 总体架构

### 1.1 分层架构

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam componentStyle rectangle
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #16213e
skinparam packageBorderColor #0f3460
skinparam componentBackgroundColor #0f3460
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "UI Layer (Vue 3 + Naive UI)" {
  component "PublicBar\n全局公共信息栏" as UI1
  component "ArchivePanel\n压缩包列表+文件树" as UI2
  component "Workspace\n多标签预览工作区" as UI3
  component "PropertyPanel\n右侧属性面板" as UI4
}

package "Composables Layer (响应式状态)" {
  component "useArchiveManager" as C1
  component "useTabManager" as C2
  component "usePluginEngine" as C3
  component "useSearch" as C4
  component "usePlatform" as C5
  component "useVFS" as C6
}

package "Core Services Layer" {
  component "DecompressService" as S1
  component "ParserEngine" as S2
  component "SearchService" as S3
  component "TaskScheduler" as S4
}

package "Plugin Registry" {
  component "ICompressionPlugin[]" as P1
  component "IFileParserPlugin[]" as P2
}

package "Platform Adapter Layer" {
  component "WebAdapter\n(WASM + TransformStream)" as A1
  component "TauriAdapter\n(Rust IPC + mmap)" as A2
}

UI1 --> C1
UI1 --> C4
UI2 --> C1
UI2 --> C6
UI3 --> C2
UI3 --> C3
UI4 --> C3

C1 --> S1
C1 --> S4
C2 --> S2
C4 --> S3

S1 --> P1
S2 --> P2
S3 --> P2

S1 --> A1
S1 --> A2
S2 --> A1
S2 --> A2
S3 --> A1
S3 --> A2
@enduml
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
│   │   ├── manifest.ts        # 插件清单（显式注册）
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
│   ├── components/            # UI 组件（基于 Naive UI）
│   │   ├── layout/            # 布局组件
│   │   │   └── AppLayout.vue
│   │   ├── public-bar/        # 顶部公共信息栏
│   │   │   ├── PublicBar.vue
│   │   │   ├── GlobalStats.vue
│   │   │   └── GlobalSearch.vue
│   │   ├── archive-panel/     # 左侧压缩包列表
│   │   │   ├── ArchivePanel.vue
│   │   │   ├── ArchiveCard.vue
│   │   │   └── FileTree.vue
│   │   ├── workspace/         # 中间预览工作区
│   │   │   ├── Workspace.vue
│   │   │   ├── TabBar.vue
│   │   │   ├── PreviewPane.vue
│   │   │   └── SplitView.vue
│   │   ├── property-panel/    # 右侧属性面板
│   │   │   ├── PropertyPanel.vue
│   │   │   └── ConfigForm.vue
│   │   └── shared/            # 通用基础组件
│   │       ├── ErrorBoundary.vue
│   │       └── VirtualScroll.vue
│   ├── stores/                # Pinia 全局状态（极少量）
│   │   └── app.ts
│   ├── styles/
│   │   └── theme.ts           # Naive UI themeOverrides
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

## 2. 前端组件库选型

### 2.1 选型结论：Naive UI

| 维度 | Element Plus | Naive UI | Ant Design Vue | Vuetify 3 |
|---|---|---|---|---|
| Stars | ~27.6k | ~18.4k | ~21.6k | ~41k |
| 暗黑主题 | CSS 变量，需手动切换 | JS 主题对象，一行切换 | ConfigProvider | SCSS 变量 |
| 虚拟滚动树 | `el-tree-v2` 内置 | `NTree` 默认虚拟 | v4 支持 | 不支持 |
| 虚拟滚动表格 | `el-table-v2`（仍 Beta） | `NDataTable` 成熟 | v4 支持 | v4 支持 |
| Tree-shaking | 好（有 CSS 副作用） | 最佳（纯 JS，零 CSS） | 一般（Less 依赖） | 好（但体积最大） |
| 包体积 (gzip) | ~289 KB | ~422 KB | ~420 KB | ~4 MB+ |
| TypeScript | 好 | 100% TS，类型完善 | 好 | 好 |
| 维护状态 | 活跃 | 活跃 | 停滞（1.5 年未更新） | 活跃 |

### 2.2 选型理由

| 项目需求 | Naive UI 匹配度 |
|---|---|
| 暗黑主题 | `import { darkTheme } from 'naive-ui'` + `<n-config-provider :theme="darkTheme">` — 零 CSS 配置 |
| 10 万+ 文件树 | `NTree` 默认启用虚拟滚动，原生支持异步加载、自定义渲染、过滤 |
| CSV 大表格 | `NDataTable` 虚拟滚动成熟，列固定/排序/筛选全支持 |
| Tauri EXE 包体积 | 最佳 tree-shaking，纯 JS 主题无 CSS 副作用 |
| 多标签工作区 | `NTabs` 支持 closable/card 模式，拖拽排序通过 `vue-draggable-plus` 扩展 |
| TypeScript 优先 | 100% TS 编写，主题系统类型安全 |

### 2.3 Naive UI 组件使用映射

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "UI 区域" {
  rectangle "顶部公共信息栏" as bar
  rectangle "左侧压缩包列表" as left
  rectangle "中间预览工作区" as center
  rectangle "右侧属性面板" as right
}

rectangle "Naive UI 组件" {
  rectangle "NLayout / NLayoutHeader\nNLayoutSider / NLayoutContent" as layout
  rectangle "NInput + NButton\nNStatistic / NTag" as pub
  rectangle "NTree (virtual-scroll)\nNCard / NProgress / NTag" as tree
  rectangle "NTabs (type=card, closable)\nNDynamicComponent / NScrollbar" as tab
  rectangle "NDescriptions / NForm\nNDynamicTags / NCollapse" as prop
}

bar --> pub
left --> tree
center --> tab
right --> prop
layout --> bar
layout --> left
layout --> center
layout --> right
@enduml
```

### 2.4 主题配置

```
// styles/theme.ts
import type { GlobalThemeOverrides } from 'naive-ui'

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#3B82F6',
    errorColor: '#EF4444',
    warningColor: '#F59E0B',
    successColor: '#10B981',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontFamilyMono: '"JetBrains Mono", "Fira Code", monospace',
  }
}
```

### 2.5 辅助依赖

| 库 | 用途 |
|---|---|
| `vue-draggable-plus` | 标签页拖拽排序 |
| `@vueuse/core` | 通用 composable 工具（防抖、响应式断点等） |

## 3. 核心接口设计

### 3.1 IPlatformAdapter — 平台抽象

```
IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>
  streamRead(path: string): ReadableStream<Uint8Array>
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

### 3.2 ICompressionPlugin — 压缩格式插件

```
ICompressionPlugin {
  name: string
  supportedExtensions: string[]
  canHandle(file: FileEntry): boolean
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
  getProgress?(): Observable<number>
}
```

### 3.3 IFileParserPlugin — 文件解析插件

```
IFileParserPlugin {
  name: string
  supportedExtensions: string[]
  canParse(file: FileEntry): boolean
  parse(data: Uint8Array, options?: any): Promise<ParsedContent>
  getComponent(): Component
  getConfigSchema?(): ConfigSchema
  getSearchAdapter?(): ISearchAdapter
}
```

### 3.4 平台切换编译配置

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

## 4. 插件系统设计

### 4.1 注册中心架构

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam classBackgroundColor #0f3460
skinparam classBorderColor #e94560
skinparam arrowColor #e94560

class PluginRegistry {
  - compressionPlugins: Map<string, ICompressionPlugin>
  - parserPlugins: Map<string, IFileParserPlugin>
  + register(plugin: ICompressionPlugin | IFileParserPlugin): void
  + registerAll(manifest: PluginManifest): void
  + getCompression(name: string): ICompressionPlugin | null
  + getParser(ext: string): IFileParserPlugin | null
  + detect(file: FileEntry): IFileParserPlugin | null
  + detectCompression(file: FileEntry): ICompressionPlugin | null
  + enable(name: string): void
  + disable(name: string): void
  + safeDecompress(plugin, data, outDir): Promise<DecompressResult>
  + safeParse(plugin, data, opts): Promise<ParsedContent>
}

interface ICompressionPlugin {
  + name: string
  + supportedExtensions: string[]
  + canHandle(file: FileEntry): boolean
  + decompress(data, outputDir): Promise<DecompressResult>
  + getProgress(): Observable<number>
}

interface IFileParserPlugin {
  + name: string
  + supportedExtensions: string[]
  + canParse(file: FileEntry): boolean
  + parse(data, options): Promise<ParsedContent>
  + getComponent(): Component
  + getConfigSchema(): ConfigSchema
  + getSearchAdapter(): ISearchAdapter
}

class ZipPlugin
class GzipPlugin
class SevenZPlugin
class RarPlugin
class TextPlugin
class CsvPlugin
class JsonPlugin
class XmlPlugin

PluginRegistry o--> ICompressionPlugin
PluginRegistry o--> IFileParserPlugin
ICompressionPlugin <|.. ZipPlugin
ICompressionPlugin <|.. GzipPlugin
ICompressionPlugin <|.. SevenZPlugin
ICompressionPlugin <|.. RarPlugin
IFileParserPlugin <|.. TextPlugin
IFileParserPlugin <|.. CsvPlugin
IFileParserPlugin <|.. JsonPlugin
IFileParserPlugin <|.. XmlPlugin
@enduml
```

### 4.2 插件注册清单

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

### 4.3 插件隔离机制

```
async safeDecompress(plugin, data, outputDir): Promise<DecompressResult> {
  try {
    return await Promise.race([
      plugin.decompress(data, outputDir),
      timeout(PLUGIN_TIMEOUT_MS)
    ])
  } catch (err) {
    this.emit('plugin-error', { plugin: plugin.name, err })
    return { success: false, error: err.message, files: [] }
  }
}
```

### 4.4 插件热更新

运行时 `enable(name)` / `disable(name)` 控制插件启禁用，禁用后对应文件回退到默认十六进制查看器。

## 5. 数据流设计

### 5.1 解压流程

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam activityBackgroundColor #0f3460
skinparam activityBorderColor #e94560
skinparam activityDiamondBackgroundColor #16213e
skinparam activityDiamondBorderColor #e94560
skinparam arrowColor #e94560

|用户|
start
:上传压缩包文件;

|ArchiveManager|
:创建 ArchiveItem\n(status = pending);

|TaskScheduler|
:enqueue(item, priority=0);
:按并发上限（默认 3）出队;

|DecompressService|
:adapter.readFile()\n获取二进制数据;
:registry.detectCompression(file)\n匹配 ICompressionPlugin;

|Plugin|
:plugin.decompress(data, outputDir);

if (包含嵌套压缩包?) then (是)
  :递归解压;
else (否)
endif

|DecompressService|
:构建 FileTreeNode 树;

|ArchiveManager|
:更新 status = completed;

|UI|
:响应式刷新\n文件树渲染;
stop
@enduml
```

### 5.2 文件预览流程

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam sequenceArrowColor #e94560
skinparam sequenceParticipantBackgroundColor #0f3460
skinparam sequenceParticipantBorderColor #e94560
skinparam sequenceLifeLineBorderColor #e94560

actor 用户
participant "FileTree\n组件" as Tree
participant "TabManager\ncomposable" as Tab
participant "ParserEngine" as Parser
participant "PluginRegistry" as Registry
participant "IFileParserPlugin" as Plugin
participant "PlatformAdapter" as Adapter
participant "PropertyPanel" as Prop

用户 -> Tree : 点击文件节点
Tree -> Tab : openTab(file)
Tab -> Parser : resolveFile(file)
Parser -> Adapter : readFile(file.path)
Adapter --> Parser : Uint8Array
Parser -> Registry : detect(file)
Registry --> Parser : IFileParserPlugin
Parser -> Plugin : parse(data, options)
Plugin --> Parser : ParsedContent
Parser --> Tab : { content, component }
Tab -> Tab : <component :is="component"\n:content="content" />
Tab -> Prop : injectConfigSchema()
Prop -> Prop : 渲染配置表单
@enduml
```

### 5.3 全局搜索流程

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam sequenceArrowColor #e94560
skinparam sequenceParticipantBackgroundColor #0f3460
skinparam sequenceParticipantBorderColor #e94560
skinparam sequenceLifeLineBorderColor #e94560

actor 用户
participant "GlobalSearch\n组件" as Search
participant "SearchService" as Svc
participant "PluginRegistry" as Registry
participant "SearchWorker\n(Web Worker /\nRust Thread)" as Worker
participant "TabManager" as Tab

用户 -> Search : 输入关键词
Search -> Svc : search(keyword)
Svc -> Registry : 获取所有已解压文件列表
Svc -> Svc : 按扩展名匹配\ngetSearchAdapter()

par 并行搜索
  Svc -> Worker : 搜索文件组 A
else
  Svc -> Worker : 搜索文件组 B
else
  Svc -> Worker : 搜索文件组 C
end

Worker --> Svc : SearchMatch[]
Svc -> Svc : 结果聚合去重
Svc --> Search : SearchResults
Search -> Search : 列表渲染

用户 -> Search : 点击结果项
Search -> Tab : openTab(file, { line, highlight })
@enduml
```

## 6. 4+1 视图

### 6.1 逻辑视图（Logical View）

描述系统的功能分解，面向最终用户需求。

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #e94560
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "压缩包管理" {
  component "多包上传" as F1
  component "独立文件树" as F2
  component "状态可视化" as F3
  component "递归解压" as F4
}

package "文件预览" {
  component "多标签管理" as F5
  component "动态渲染器" as F6
  component "拆分视图" as F7
  component "预览工具栏" as F8
}

package "搜索与过滤" {
  component "全局关键词搜索" as F9
  component "文件树过滤" as F10
  component "搜索结果跳转" as F11
}

package "属性与配置" {
  component "上下文感知元数据" as F12
  component "插件配置表单" as F13
  component "文件路径追溯" as F14
}

package "平台与扩展" {
  component "Web/EXE 双端构建" as F15
  component "插件热更新" as F16
  component "暗黑/浅色主题" as F17
}

F1 --> F4
F4 --> F2
F2 --> F5
F5 --> F6
F6 --> F8
F9 --> F11
F11 --> F5
F12 --> F13
@enduml
```

### 6.2 开发视图（Development View）

描述代码组织和模块结构，面向开发者。

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #e94560
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "src/" {
  package "adapters/" {
    component "types.ts" as a1
    component "web-adapter.ts" as a2
    component "tauri-adapter.ts" as a3
  }

  package "plugins/" {
    component "types.ts" as p1
    component "registry.ts" as p2
    component "manifest.ts" as p3
    package "compression/" {
      component "zip / gzip / 7z / rar" as pc
    }
    package "parser/" {
      component "text / csv / json / xml" as pp
    }
  }

  package "core/" {
    component "decompress.ts" as c1
    component "parser-engine.ts" as c2
    component "search.ts" as c3
    component "task-scheduler.ts" as c4
    component "file-tree.ts" as c5
  }

  package "composables/" {
    component "use-archives / use-tabs\nuse-plugins / use-search\nuse-platform / use-vfs" as comp
  }

  package "components/" {
    component "layout / public-bar\narchive-panel / workspace\nproperty-panel / shared" as ui
  }

  package "stores/" {
    component "app.ts (Pinia)" as st
  }
}

package "src-tauri/" {
  component "main.rs / commands.rs\nfile_ops.rs / decompress.rs" as rust
}

package "Naive UI" as naive
package "vue-draggable-plus" as drag
package "@vueuse/core" as vueuse

ui --> naive
ui --> drag
comp --> vueuse
ui --> comp
comp --> c1
comp --> c2
comp --> c3
comp --> c4
c1 --> p2
c2 --> p2
c3 --> p2
c1 --> a1
c2 --> a1
a3 --> rust
@enduml
```

### 6.3 进程视图（Process View）

描述运行时并发和同步，面向性能工程师。

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam nodeBackgroundColor #0f3460
skinparam nodeBorderColor #e94560
skinparam arrowColor #e94560
skinparam queueBackgroundColor #16213e
skinparam queueBorderColor #e94560

node "主线程 (UI Thread)" {
  queue "Vue Render" as render
  queue "Composables\n(reactive state)" as comp
  queue "Naive UI\nVirtual Scroll" as vs
}

node "Worker Pool" {
  queue "Search Worker 1" as w1
  queue "Search Worker 2" as w2
  queue "Search Worker N" as wn
}

node "Task Scheduler\n(concurrency = 3)" {
  queue "Decompress Task 1" as d1
  queue "Decompress Task 2" as d2
  queue "Decompress Task 3" as d3
}

node "Tauri Backend\n(Rust Threads)" {
  queue "IPC Handler" as ipc
  queue "mmap Reader" as mmap
  queue "Native Decompress" as nd
}

render --> comp
comp --> d1
comp --> d2
comp --> d3
comp --> w1
comp --> w2
comp --> wn
d1 --> ipc
d2 --> ipc
d3 --> ipc
ipc --> mmap
ipc --> nd
@enduml
```

### 6.4 物理视图（Physical View）

描述部署拓扑，面向运维。

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam nodeBackgroundColor #0f3460
skinparam nodeBorderColor #e94560
skinparam artifactBackgroundColor #16213e
skinparam artifactBorderColor #e94560
skinparam arrowColor #e94560

node "Web 部署" {
  artifact "index.html" as wh
  artifact "app.js (tree-shaken)" as wj
  artifact "wasm-modules/" as ww
  artifact "assets/" as wa
}

node "Windows EXE 部署" {
  artifact "log-parser.exe\n(~8-15 MB)" as exe
  node "WebView2 Runtime" as wv
  node "Tauri Backend\n(Rust)" as tb
}

cloud "CDN / OSS / Nginx" as cdn

node "用户浏览器" as browser
node "Windows 桌面" as desktop

cdn --> wh
cdn --> wj
cdn --> ww
cdn --> wa
browser --> cdn

desktop --> exe
exe --> wv
exe --> tb
@enduml
```

### 6.5 场景视图（Scenarios / Use Cases）

核心用例驱动端到端验证。

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam actorBackgroundColor #0f3460
skinparam actorBorderColor #e94560
skinparam usecaseBackgroundColor #16213e
skinparam usecaseBorderColor #e94560
skinparam arrowColor #e94560

left to right direction

actor "用户" as user

rectangle "日志解析工具" {
  usecase "UC1: 上传并解压\n多个压缩包" as uc1
  usecase "UC2: 浏览文件树\n并预览文件" as uc2
  usecase "UC3: 全局搜索\n关键词" as uc3
  usecase "UC4: 配置解析插件\n参数" as uc4
  usecase "UC5: 导出\n搜索结果" as uc5
  usecase "UC6: 切换\n暗黑/浅色主题" as uc6
}

user --> uc1
user --> uc2
user --> uc3
user --> uc4
user --> uc5
user --> uc6

uc1 ..> uc2 : <<include>>
uc3 ..> uc2 : <<include>>
@enduml
```

## 7. 关键 Composables 设计

| Composable | 职责 | 核心 API |
|---|---|---|
| `useArchiveManager()` | 管理压缩包生命周期 | `addFiles(files[])`, `remove(id)`, `retry(id)`, `archives` (reactive) |
| `useTabManager()` | 标签页 CRUD | `open(file)`, `close(id)`, `tabs`, `activeTab`, `splitView(id, dir)` |
| `usePluginEngine()` | 插件注册中心封装 | `detect(file)`, `getComponent(file)`, `enable/disable(name)` |
| `useSearch()` | 全局搜索 | `search(keyword)`, `results`, `searching`, `jumpTo(result)` |
| `usePlatform()` | 平台适配器单例 | `adapter: IPlatformAdapter`, `isTauri`, `isWeb` |
| `useVirtualFileSystem()` | VFS 抽象 | `readFile(path)`, `listDir(path)`, `getTree(archiveId)` |

## 8. 状态管理策略

| 状态类型 | 存储位置 | 示例 |
|---|---|---|
| UI 局部状态 | 组件 `ref()` | 下拉菜单展开、输入框内容 |
| 跨组件共享状态 | Composable（模块级 reactive） | 当前激活标签页、选中文件 |
| 全局持久状态 | Pinia store | 主题偏好、插件启禁用、面板布局 |

绝大多数状态通过 Composable 管理，Pinia 仅用于极少量全局持久化配置。

## 9. 错误处理设计

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "Platform Adapter" as PA
rectangle "Plugin Registry\n(Sandbox)" as PR
rectangle "Core Service" as CS
rectangle "UI Component\n(ErrorBoundary)" as UI

rectangle "错误处理链" as chain #16213e

PA --> PR : 文件读写失败\nIPC 断连
note right of PA
  Adapter 抛出异常
end note

PR --> CS : 解压失败\n解析异常\n超时
note right of PR
  safeDecompress/safeParse
  Promise.race + timeout
  emit('plugin-error')
end note

CS --> UI : 文件不存在\n格式不支持
note right of CS
  回退到十六进制查看器
  或空状态提示
end note

note right of UI
  ErrorBoundary 捕获
  降级显示错误信息
end note
@enduml
```

| 层级 | 错误类型 | 处理方式 |
|---|---|---|
| 平台层 | 文件读写失败、IPC 断连 | Adapter 抛出 → Composable 捕获 → 状态标记 error |
| 插件层 | 解压失败、解析异常、超时 | Registry 沙箱捕获 → 插件错误事件 → UI 提示 |
| 业务层 | 文件不存在、格式不支持 | 回退到十六进制查看器或空状态提示 |
| UI 层 | 组件渲染异常 | `ErrorBoundary` 包裹，降级显示错误信息 |

## 10. 测试策略

| 类型 | 覆盖目标 | 工具 |
|---|---|---|
| 单元测试 | Composable 逻辑、工具函数、插件解析 | Vitest |
| 组件测试 | UI 组件渲染与交互 | Vitest + Vue Test Utils |
| 插件测试 | 各插件 canHandle / decompress / parse | Vitest + 测试夹具文件 |
| E2E 测试 | 端到端流程（上传→解压→预览→搜索） | Playwright（Web）|
| 性能测试 | 10 万+ 文件树渲染、大文件虚拟滚动 | 手动基准 + CI 阈值 |

## 11. 构建产物

| 平台 | 命令 | 产物 |
|---|---|---|
| Web | `vite build --mode web` | 静态 HTML/JS/CSS + WASM |
| Windows EXE | `tauri build` | 单文件 .exe (~8-15MB) |
| 开发 | `vite dev` + `tauri dev` | HMR + Rust 热重载 |
