# 文件解压与查看详情全流程分析

> 本文档基于 Hello-Tauri 项目源码（Vue 3 + Tauri 2 + TypeScript），梳理文件从上传到预览的完整链路，包含架构图、时序图、模块依赖图等 PlantUML 可视化展示。

---

## 一、总体架构概览

### 1.1 四栏布局

```
┌─────────────────────────────────────────────────────────────┐
│  PublicBar（顶部导航栏，64px）                                 │
├──────────┬────────────────────────────────┬──────────────────┤
│          │                                │                  │
│ Archive  │        Workspace               │   PropertyPanel  │
│ Panel    │  ┌─────── TabBar ───────┐      │   (属性面板)     │
│ (左侧    │  │  标签页栏            │      │                  │
│  侧栏)   │  ├─────────────────────┤      │                  │
│          │  │   PreviewToolbar    │      │                  │
│          │  ├─────────────────────┤      │                  │
│          │  │    PreviewPane      │      │                  │
│          │  │  (渲染器动态挂载)    │      │                  │
│          │  └─────────────────────┘      │                  │
├──────────┴────────────────────────────────┴──────────────────┤
│  StatusBar（底部状态栏，26px）                                 │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 核心模块依赖关系图

```plantuml
@startuml 核心模块依赖关系
skinparam backgroundColor #1a1a2e
skinparam componentStyle rectangle
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #0f3460
skinparam arrowColor #e94560
skinparam borderColor #0f3460

package "视图层 (Vue Components)" {
  [ArchivePanel] as AP
  [UploadZone] as UZ
  [ArchiveCard] as AC
  [FileTree] as FT
  [Workspace] as WS
  [TabBar] as TB
  [PreviewPane] as PP
  [TextRenderer] as TR
  [CsvRenderer] as CR
  [JsonRenderer] as JR
  [LogRenderer] as LR
  [PropertyPanel] as PRP
  [AppLayout] as AL
}

package "组合式函数层 (Composables)" {
  [useArchiveManager] as UAM
  [useDecompress] as UD
  [usePluginEngine] as UPE
  [useCacheManager] as UCM
  [useTabManager] as UTM
  [usePlatform] as UP
  [useSearch] as US
  [useGlobalDrop] as UGD
}

package "核心逻辑层 (Core)" {
  [TaskScheduler] as TS
  [FileTreeBuilder] as FTB
  [ParserEngine] as PE
  [DecompressService] as DS
  [CacheManager] as CM
  [MemoryStore] as MS
  [SearchService] as SS
  [ValidationPipeline] as VP
}

package "插件层 (Plugins)" {
  [PluginRegistry] as PR
  [ZipPlugin] as ZIP
  [GzipPlugin] as GZ
  [TextPlugin] as TP
  [CsvPlugin] as CP
  [JsonPlugin] as JP
  [LogPlugin] as LP
  [HexPlugin] as HP
}

package "适配器层 (Adapters)" {
  [WebAdapter] as WA
  [TauriAdapter] as TA
  [IPlatformAdapter] as IPA
}

package "持久层 (Storage)" {
  [IdbCacheStorage] as IDB
  [FsCacheStorage] as FS
}

AL --> AP : 包含
AL --> WS : 包含
AL --> PRP : 包含

AP --> UZ : 包含
AP --> AC : 包含
AC --> FT : 包含
WS --> TB : 包含
WS --> PP : 包含
PP --> TR : 动态加载
PP --> CR : 动态加载
PP --> JR : 动态加载
PP --> LR : 动态加载

UZ --> UAM : 调用
UZ --> VP : 调用
UGD --> UAM : 调用
UGD --> VP : 调用
UAM --> UCM : 调用
UAM --> UD : 动态 import 调用
UD --> UPE : 调用
UD --> UCM : 调用
UD --> TS : 调用
UD --> FTB : 调用
FT --> UTM : 调用
PP --> UTM : 调用
PP --> UPE : 调用
PP --> PE : 调用
PP --> UP : 调用
PE --> PR : 调用
PE --> IPA : 调用

PR --> ZIP : 注册
PR --> GZ : 注册
PR --> TP : 注册
PR --> CP : 注册
PR --> JP : 注册
PR --> LP : 注册
PR --> HP : 注册

IPA <|.. WA : 实现
IPA <|.. TA : 实现
WA --> MS : 读取
CM --> IDB : 写入/读取
CM --> FS : 写入/读取

@enduml
```

---

## 二、文件上传与解压全流程

### 2.1 入口：拖拽 / 文件选择

用户通过两种方式触发：

| 方式 | 组件 | 处理函数 |
|------|------|---------|
| 全局拖拽 | `AppLayout.vue` → `useGlobalDrop` | `onDrop()` |
| 面板上传 | `UploadZone.vue` | `processFiles()` |

### 2.2 完整解压流程时序图

```plantuml
@startuml 文件解压流程时序
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam actorBackgroundColor #0f3460
skinparam participantBackgroundColor #16213e
skinparam participantBorderColor #0f3460
skinparam sequenceArrowColor #e94560
skinparam sequenceGroupBackgroundColor #0f3460
skinparam sequenceGroupBorderColor #e94560
skinparam sequenceBoxBackgroundColor #1a1a2e
skinparam sequenceBoxBorderColor #0f3460
skinparam noteBackgroundColor #16213e
skinparam noteBorderColor #0f3460

actor 用户 as User
participant UploadZone as UZ
participant useGlobalDrop as UGD
participant useArchiveManager as UAM
participant CacheManager as CM
participant CacheStorage as CS
participant useDecompress as UD
participant TaskScheduler as TS
participant PluginRegistry as PR
participant ZipPlugin as ZIP
participant MemoryStore as MS
participant FileTreeBuilder as FTB

== 文件上传阶段 ==

User -> UZ: 拖拽/选择文件
UZ -> UZ: filterArchiveFiles()\n过滤出压缩包
UZ -> VP: validateArchiveFiles()\n文件完整性验证
UZ -> UAM: addFiles(files)

activate UAM
UAM -> UAM: 创建 ArchiveItem\n(status='pending')
UAM -> CM: cacheArchive(archive, file)
activate CM
CM -> CS: saveMeta(id, meta)
CM -> CS: saveFileData(id, data)
CM -> CM: accessMap.set(id, now)
deactivate CM
UAM -> UD: triggerDecompress()\n(动态 import)
deactivate UAM

== 解压调度阶段 ==

activate UD
UD -> UD: startDecompress(archive)
UD -> UAM: updateStatus(id, 'running', 0)
UD -> TS: enqueue(taskFn)
activate TS
TS -> TS: 并发控制 (maxConcurrency=3)
Note right of TS: 排队等待或立即执行
deactivate TS

== 数据读取阶段 ==

UD -> UD: archive.file 是否存在?
alt 当次会话上传
  UD -> UD: archive.file.arrayBuffer()\n→ Uint8Array
else 缓存恢复
  UD -> CM: getFileData(cacheId)
  activate CM
  CM -> CS: loadFileData(id)
  CM -> CM: touch(id) → 更新 LRU
  deactivate CM
end

== 压缩检测与解压阶段 ==

UD -> UD: 构造 FileEntry
UD -> PR: detectCompression(fileEntry)
activate PR
PR --> UD: ZipPlugin
deactivate PR
UD -> UD: updateStatus(id, 'running', 30)
UD -> PR: safeDecompress(ZipPlugin, data, '')
activate PR
PR -> ZIP: plugin.decompress(data, '')
activate ZIP

alt Tauri 平台
  ZIP -> TA: adapter.decompress(data, 'zip', '')
  TA -> Rust: invoke('decompress', ...)
  Rust --> TA: DecompressResult
  TA --> ZIP: result
else Web 平台
  ZIP -> ZIP: unzipSync(data) from fflate
  ZIP -> MS: memoryStore.write(name, content)
end

ZIP --> PR: DecompressResult
deactivate ZIP
PR --> UD: DecompressResult
deactivate PR

== 文件树构建与完成阶段 ==

UD -> UD: updateStatus(id, 'running', 80)
UD -> FTB: build(result.files, '')
activate FTB
FTB -> FTB: 遍历 files 构建节点\n建立父子关系
FTB --> UD: FileTreeNode[]
deactivate FTB
UD -> UAM: archive.files = tree
UD -> UAM: archive.originalSize = sum
UD -> UAM: updateStatus(id, 'completed', 100)
UAM -> CM: updateMeta(archive)
deactivate UD

@enduml
```

### 2.3 解压管道数据处理流程

```plantuml
@startuml 解压管道数据流
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam activityBorderColor #0f3460
skinparam activityBackgroundColor #16213e
skinparam partitionBackgroundColor #16213e
skinparam partitionBorderColor #0f3460

partition "Step 1: 文件接收" {
  :用户拖拽/选择文件;
  :filterArchiveFiles()\n根据扩展名过滤;
  :validateArchiveFiles()\n检查 VERSION.txt 等;
  :addFiles() 创建 ArchiveItem;
}

partition "Step 2: 数据加载" {
  :File 对象存在?;
  if (是) then
    :archive.file.arrayBuffer();
  else
    :cacheManager.getFileData(cacheId);
  endif
  :转换为 Uint8Array;
}

partition "Step 3: 压缩检测" {
  :构造 FileEntry;
  :registry.detectCompression(fileEntry);
  if (找到插件) then (是)
    :获取 ICompressionPlugin;
  else (否)
    :标记失败\n"No plugin";
    stop
  endif
}

partition "Step 4: 解压执行" {
  :safeDecompress(plugin, data, '');
  if (Tauri 平台) then
    :TauriAdapter.decompress()\n→ Tauri IPC invoke('decompress');
    :Rust 端 mmap 零拷贝读取;
  else (Web 平台)
    if (ZIP) then
      :fflate.unzipSync(data)\n纯 JS 解压;
    else (GZIP)
      :DecompressionStream('gzip')\n浏览器原生解压;
    endif
    :写入 MemoryStore;
  endif
  :返回 DecompressResult;
}

partition "Step 5: 文件树构建" {
  :FileTreeBuilder.build(files, '');
  :为每个文件创建 FileTreeNode;
  :根据 path 建立父子关系;
  :返回根节点列表;
}

partition "Step 6: 完成更新" {
  :archive.files = tree;
  :archive.originalSize = sum;
  :updateStatus('completed');
  :cacheManager.updateMeta();
}

@enduml
```

---

## 三、文件预览查看流程

### 3.1 完整预览时序图

```plantuml
@startuml 文件预览时序
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam actorBackgroundColor #0f3460
skinparam participantBackgroundColor #16213e
skinparam participantBorderColor #0f3460
skinparam sequenceArrowColor #e94560
skinparam sequenceGroupBackgroundColor #0f3460
skinparam sequenceGroupBorderColor #e94560
skinparam noteBackgroundColor #16213e
skinparam noteBorderColor #0f3460

actor 用户 as User
participant FileTree as FT
participant useTabManager as UTM
participant TabBar as TB
participant Workspace as WS
participant PreviewPane as PP
participant usePlatform as UP
participant ParserEngine as PE
participant PlatformAdapter as PA
participant MemoryStore as MS
participant PluginRegistry as PR
participant TextPlugin as TPlugin
participant ErrorBoundary as EB

== 用户选择文件 ==

User -> FT: 点击文件树节点
FT -> FT: handleSelect(keys)
FT -> FTB: FileTreeBuilder.findNode(data, key)\n查找选中节点
FT -> UTM: openTab(node, archiveId)
activate UTM
UTM -> UTM: 检查是否已打开\n(按 fileNode.key + archiveId 去重)
UTM -> UTM: 创建 TabItem
UTM -> TB: tabs.value 响应式更新
deactivate UTM

== 标签页激活 ==

TB -> TB: 高亮激活的标签
TB -> WS: activeTab 响应式更新

== 文件解析阶段 ==

PP -> PP: watch(activeTab, { immediate: true })
PP -> UP: getAdapter()
UP -> UP: lazy import Adapter\n(WebAdapter / TauriAdapter)
PP -> PP: new ParserEngine(adapter, registry)
PP -> PE: resolveFile(node, '', encoding)
activate PE

PE -> PA: readFile(node.path)
activate PA

alt Web 平台 (WebAdapter)
  PA -> MS: memoryStore.read(path)
  alt 缓存命中
    MS --> PA: Uint8Array
  else 未命中
    PA -> PA: fetch(path) HTTP GET
    PA --> PE: Uint8Array
  end
else Tauri 平台 (TauriAdapter)
  PA -> PA: invoke('read_file', { path })
  PA --> PE: Uint8Array
end

deactivate PA

PE -> PE: 提取文件扩展名
PE -> PR: getParser(ext)
activate PR
PR --> PE: IFileParserPlugin (如 TextPlugin)
deactivate PR

PE -> PR: safeParse(plugin, data, { encoding })
activate PR
PR -> TPlugin: plugin.parse(data, { encoding })
activate TPlugin
TPlugin -> TPlugin: TextDecoder(encoding).decode(data)
TPlugin --> PR: ParsedResult
deactivate TPlugin
PR --> PE: ParsedResult
deactivate PR

PE --> PP: ParsedContent\n(type, data, lineCount, loadTimeMs, pluginName)
deactivate PE

== 渲染阶段 ==

PP -> PP: tab.content = ParsedContent
PP -> PP: rendererComponent = computed()
PP -> PR: registry.getParser(ext)
PR --> PP: IFileParserPlugin
PP -> PP: plugin.getComponent()\n→ TextRenderer / CsvRenderer / 等
PP -> EB: ErrorBoundary 包裹渲染器
EB -> TR: <component :is="renderer"\n:content="content.data" />
TR --> User: 显示行号 + 文本内容

@enduml
```

### 3.2 解析引擎与渲染器选择流程

```plantuml
@startuml 解析与渲染选择流程
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam activityBorderColor #0f3460
skinparam activityBackgroundColor #16213e
skinparam partitionBackgroundColor #16213e
skinparam partitionBorderColor #0f3460
skinparam decisionBackgroundColor #0f3460
skinparam decisionBorderColor #e94560
skinparam arrowColor #e94560

start
:用户点击文件树叶子节点;
:openTab → 创建 TabItem;
:activeTab 变化;

:获取 IPlatformAdapter;
:创建 ParserEngine 实例;
:调用 engine.resolveFile(node, path, encoding);

:adapter.readFile(node.path);
:获取 Uint8Array 原始数据;

:提取文件扩展名;
:registry.getParser(ext);

if (找到解析插件?) then (是)
else (否)
  :回退到 hex 插件;
  :registry.getParser('');
endif

:safeParse(plugin, data, { encoding });

switch (解析结果类型)
case (text)
  :TextRenderer 渲染\n(v-for 行号 + 文本内容);
case (csv)
  :CsvRenderer 渲染\n(<table> 表头 + 行数据);
case (json)
  :JsonRenderer 渲染\n(JsonNode 递归树组件);
case (log)
  :LogRenderer 渲染\n(时间戳 + 级别 + 模块 + 消息);
case (hex)
  :HexRenderer 渲染\n(偏移量 + HEX + ASCII);
endswitch

:ErrorBoundary 包裹\n捕获子组件渲染异常;
stop

@enduml
```

---

## 四、插件系统架构

### 4.1 插件注册与加载

```plantuml
@startuml 插件系统架构
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam packageBackgroundColor #16213e
skinparam packageBorderColor #0f3460
skinparam interfaceBackgroundColor #0f3460
skinparam interfaceBorderColor #e94560
skinparam classBackgroundColor #16213e
skinparam classBorderColor #0f3460
skinparam arrowColor #e94560

interface "ICompressionPlugin" as ICP {
  +name: string
  +supportedExtensions: string[]
  +canHandle(file): boolean
  +decompress(data, outputDir): DecompressResult
}

interface "IFileParserPlugin" as IFP {
  +name: string
  +supportedExtensions: string[]
  +canParse(file): boolean
  +parse(data, options): ParsedResult
  +getComponent(): Component
  +getConfigSchema?(): ConfigSchema
}

class PluginRegistry {
  -compressionPlugins: Map
  -parserPlugins: Map
  -extToParser: Map
  -extToCompression: Map
  -disabled: Set
  +registerParser(plugin): void
  +registerCompression(plugin): void
  +getParser(ext): IFileParserPlugin
  +getCompression(ext): ICompressionPlugin
  +detectCompression(file): ICompressionPlugin
  +safeParse(plugin, data, options): ParsedResult
  +safeDecompress(plugin, data, dir): DecompressResult
}

class registerBuiltinPlugins {
  +注册 2 个压缩插件
  +注册 5 个解析插件
}

ICP <|.. ZipPlugin : 实现
ICP <|.. GzipPlugin : 实现

IFP <|.. TextPlugin : 实现
IFP <|.. CsvPlugin : 实现
IFP <|.. JsonPlugin : 实现
IFP <|.. LogPlugin : 实现
IFP <|.. HexPlugin : 实现

PluginRegistry --> registerBuiltinPlugins : 调用填充
PluginRegistry o--> ICP : 管理
PluginRegistry o--> IFP : 管理

@enduml
```

### 4.2 插件类型与文件扩展名对照

| 插件名称 | 类型 | 支持扩展名 | 渲染器 | 引擎回退 |
|---------|------|-----------|--------|---------|
| `zip` | 压缩 | `.zip` | — | fflate / Tauri IPC |
| `gzip` | 压缩 | `.gz .gzip .tgz` | — | DecompressionStream / Tauri IPC |
| `text` | 解析 | `.txt .md .cfg .ini .env .yaml .yml .toml` | `TextRenderer` | — |
| `csv` | 解析 | `.csv .tsv` | `CsvRenderer` | — |
| `json` | 解析 | `.json .jsonl` | `JsonRenderer` | — |
| `log` | 解析 | `.log` | `LogRenderer` | — |
| `hex` | 解析 | 空（兜底） | `HexRenderer` | 所有未知格式回退到此 |

---

## 五、适配器模式

### 5.1 平台适配分离

```plantuml
@startuml 适配器模式
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam interfaceBackgroundColor #0f3460
skinparam interfaceBorderColor #e94560
skinparam classBackgroundColor #16213e
skinparam classBorderColor #0f3460
skinparam arrowColor #e94560

interface "IPlatformAdapter" as IPA {
  +readFile(path): Uint8Array
  +writeFile(path, data): void
  +listFiles(dir): FileEntry[]
  +getTempDir(): string
  +decompress(data, format, dir): DecompressResult
  +mmapRead(path, offset, length): Uint8Array
  +streamRead(path): ReadableStream
}

class WebAdapter {
  +readFile: fetch / memoryStore
  +mmapRead: Range Request
  +streamRead: fetch + ReadableStream
  +decompress: unsupported
}

class TauriAdapter {
  +readFile: invoke('read_file')
  +mmapRead: invoke('mmap_read')
  +streamRead: invoke → ReadableStream
  +decompress: invoke('decompress')
}

class usePlatform {
  +getAdapter(): IPlatformAdapter
  +isTauri: boolean
  +isWeb: boolean
}

class ParserEngine {
  -adapter: IPlatformAdapter
  -registry: PluginRegistry
  +resolveFile(): ParsedContent
}

IPA <|.. WebAdapter : 实现
IPA <|.. TauriAdapter : 实现
ParserEngine --> IPA : 依赖注入
usePlatform --> WebAdapter : 编译时常量选择
usePlatform --> TauriAdapter : 编译时常量选择

note right of usePlatform
  __PLATFORM__ 编译时替换
  VITE_PLATFORM=web|tauri
  测试环境始终解析为 web-adapter
end note

@enduml
```

---

## 六、缓存系统

### 6.1 缓存分层结构

```plantuml
@startuml 缓存系统
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam interfaceBackgroundColor #0f3460
skinparam interfaceBorderColor #e94560
skinparam classBackgroundColor #16213e
skinparam classBorderColor #0f3460
skinparam arrowColor #e94560

interface "ICacheStorage" as ICS {
  +init(): void
  +saveMeta(id, meta): void
  +loadMeta(id): CacheMeta
  +loadAllMeta(): CacheMeta[]
  +deleteMeta(id): void
  +saveFileData(id, data): void
  +loadFileData(id): Uint8Array
  +deleteFileData(id): void
}

class CacheManager {
  -storage: ICacheStorage
  -maxItems: number
  -accessMap: Map
  +init(): void
  +cacheArchive(archive, file): void
  +updateMeta(archive): void
  +getFileData(id): Uint8Array
  +restoreAll(): CacheMeta[]
  +remove(id): void
  -evict(): void  // LRU 淘汰
}

class IdbCacheStorage {
  // Web 端: IndexedDB
  -dbName: 'hello-tauri-cache'
  -storeName: 'archives'
}

class FsCacheStorage {
  // Tauri 端: 文件系统
  -baseDir: appDataDir
}

class MemoryStore {
  // 解压后内容内存缓存
  -store: Map<string, Uint8Array>
  -maxBytes: 256MB
  +write(path, data): void
  +read(path): Uint8Array
  -evict(neededBytes): void
}

ICS <|.. IdbCacheStorage : 实现
ICS <|.. FsCacheStorage : 实现
CacheManager --> ICS : 依赖
useCacheManager --> IdbCacheStorage : platform='web'
useCacheManager --> FsCacheStorage : platform='tauri'
MemoryStore <-- WebAdapter : 解压数据写入
MemoryStore <-- ZipPlugin : unzipSync 写入

note top of CacheManager
  启动时 initCache() → restoreFromCache()
  恢复上次会话的归档列表
  LRU 淘汰: maxItems=20
end note

@enduml
```

---

## 七、关键函数调用关系图

### 7.1 文件上传 → 解压完成调用链

```plantuml
@startuml 解压调用链
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam classBackgroundColor #16213e
skinparam classBorderColor #0f3460
skinparam arrowColor #e94560
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #0f3460

rectangle "AppLayout.vue" as AL
rectangle "useGlobalDrop" as UGD {
  rectangle "onDrop()" as D1
  rectangle "setup()" as D2
}
rectangle "UploadZone.vue" as UZ {
  rectangle "processFiles()" as P1
  rectangle "handleDrop()" as P2
  rectangle "handleInputChange()" as P3
}
rectangle "core/archive-utils.ts" as AU {
  rectangle "filterArchiveFiles()" as F1
  rectangle "validateArchiveFiles()" as F2
}
rectangle "core/file-validator.ts" as FV {
  rectangle "getFileValidator()" as G1
  rectangle "ValidationPipeline.validate()" as V1
  rectangle "ZipExtensionValidator" as Z1
  rectangle "ZipContentValidator" as Z2
}
rectangle "useArchiveManager" as UAM {
  rectangle "addFiles()" as A1
  rectangle "triggerDecompress()" as A2
  rectangle "updateStatus()" as A3
  rectangle "remove()" as A4
  rectangle "restoreFromCache()" as A5
}
rectangle "useDecompress" as UD {
  rectangle "startDecompress()" as S1
  rectangle "decompressAll()" as S2
}
rectangle "core/task-scheduler.ts" as TS {
  rectangle "enqueue()" as E1
  rectangle "processNext()" as E2
}
rectangle "plugins/registry.ts" as PR {
  rectangle "detectCompression()" as DC
  rectangle "safeDecompress()" as SD
}
rectangle "core/file-tree.ts" as FT {
  rectangle "build()" as B1
  rectangle "findNode()" as F3
  rectangle "flattenTree()" as F4
}
rectangle "composables/use-cache.ts" as UC {
  rectangle "useCacheManager()" as UC1
  rectangle "initCache()" as UC2
}
rectangle "core/cache-manager.ts" as CM {
  rectangle "cacheArchive()" as C1
  rectangle "updateMeta()" as C2
  rectangle "getFileData()" as C3
  rectangle "restoreAll()" as C4
  rectangle "remove()" as C5
}

AL --> D1 : 全局拖拽
AL --> D2 : onMounted 注册

UZ --> P1, P2, P3 : 面板上传
P1 --> F1 : 过滤
P1 --> F2 : 验证
D1 --> F1, F2 : 同上

F2 --> G1 : 获取验证管线
V1 --> Z1 : 扩展名检查
V1 --> Z2 : 内容检查(VERSION.txt)

P1 --> A1 : 添加文件
D1 --> A1 : 添加文件
A1 --> C1 : 异步持久化
A1 --> A2 : 触发解压

A2 --> UD : 动态 import
S1 --> A3 : 更新状态
S1 --> E1 : 加入任务队列
E1 --> E2 : 执行任务
S1 --> C3 : 缓存恢复时读取
S1 --> DC : 检测压缩插件
DC --> SD : 安全解压(30s 超时)
SD --> B1 : 构建文件树
S1 --> C2 : 更新元数据

@enduml
```

### 7.2 文件选择 → 预览渲染调用链

```plantuml
@startuml 预览调用链
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam classBackgroundColor #16213e
skinparam classBorderColor #0f3460
skinparam arrowColor #e94560
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #0f3460

rectangle "ArchiveCard.vue" as AC
rectangle "FileTree.vue" as FT {
  rectangle "handleSelect()" as H1
}
rectangle "composables/use-tabs.ts" as UT {
  rectangle "openTab()" as O1
  rectangle "closeTab()" as C1
  rectangle "activateTab()" as A1
  rectangle "togglePin()" as T1
  rectangle "closeAll()" as R1
}
rectangle "Workspace.vue" as WS {
  rectangle "TabBar" as TB
  rectangle "PreviewPane" as PP
}
rectangle "PreviewPane.vue" as PV {
  rectangle "watch(activeTab)" as W1
  rectangle "getEngine()" as GE
  rectangle "rendererComponent" as RC
}
rectangle "usePlatform" as UP {
  rectangle "getAdapter()" as GA
}
rectangle "core/parser-engine.ts" as PE {
  rectangle "resolveFile()" as RF
}
rectangle "plugins/registry.ts" as PR2 {
  rectangle "getParser()" as GP
  rectangle "safeParse()" as SP
}
rectangle "plugins/parser/text-plugin.ts" as TEXTP {
  rectangle "parse()" as TP1
}
rectangle "views/renderers/" as RENDERS {
  rectangle "TextRenderer" as TR
  rectangle "CsvRenderer" as CR
  rectangle "JsonRenderer" as JR
  rectangle "LogRenderer" as LR
}
rectangle "components/shared/ErrorBoundary.vue" as EB

AC --> FT : 包含 FileTree
H1 --> FTB : findNode 查找节点
H1 --> O1 : 打开标签
O1 --> A1 : 自动激活
PP --> TB : 响应式更新标签栏
W1 --> GE : 获取 ParserEngine
GE --> GA : 获取平台适配器
W1 --> RF : 解析文件

RF --> GA : adapter.readFile(path)
RF --> GP : 按扩展名找解析插件
GP --> SP : 安全解析(30s 超时)
SP --> TP1 : 调用具体解析函数
TP1 --> TextDecoder : 解码 Uint8Array
TP1 --> SP : ParsedResult

W1 --> PV : tab.content = result
RC --> GP : 再次获取插件
RC --> TR : plugin.getComponent()
PV --> EB : ErrorBoundary 包裹
EB --> TR/CR/JR/LR : 动态渲染 :is="component"

@enduml
```

---

## 八、Tauri 后端 Rust 侧处理

### 8.1 Rust 命令与前端对应

```plantuml
@startuml Rust 后端
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #0f3460
skinparam arrowColor #e94560
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #0f3460

package "前端 TypeScript" {
  [TauriAdapter] as TA
  [useCacheManager] as UCM
}

package "Tauri IPC invoke" {
  [invoke('read_file')] as R1
  [invoke('write_file')] as W1
  [invoke('list_files')] as L1
  [invoke('get_temp_dir')] as G1
  [invoke('decompress')] as D1
  [invoke('mmap_read')] as M1
}

package "Rust 后端" {
  [lib.rs] as LIB {
    [run() 启动函数] as RUN
  }
  [commands.rs] as CMD {
    [read_file] as RF
    [write_file] as WF
    [list_files] as LF
    [get_temp_dir] as GF
    [decompress] as DF
    [mmap_read] as MR
  }
  [file_ops.rs] as FO {
    [read_file_bytes()] as RFB
    [write_file_bytes()] as WFB
  }
  [decompress.rs] as DECOMP {
    [decompress_file()] as DCF
    [decompress_zip()] as DZ
    [decompress_gzip()] as DGZ
  }
  [error.rs] as ERR {
    [AppError 枚举] as AE
  }
}

TA --> R1, W1, L1, G1, D1, M1
R1 --> RF
RF --> FO : read_file_bytes
WF --> FO : write_file_bytes
D1 --> DF
DF --> DECOMP : decompress_file
DECOMP --> DZ : zip
DECOMP --> DGZ : gzip
RF/BF/DZ/DGZ --> ERR : 错误处理
CMD --> LIB : #[tauri::command] 注册

note right of TA
  前端 invoke 时通过
  __PLATFORM__=== 'tauri'
  编译期选择 TauriAdapter
end note

note right of ERR
  #[serde(rename_all = "camelCase")]
  thiserror 派生
  AppError → Result 传播
end note

@enduml
```

---

## 九、完整数据流汇总

### 9.1 端到端数据流转

```plantuml
@startuml 端到端数据流转
skinparam backgroundColor #1a1a2e
skinparam defaultFontName Microsoft YaHei
skinparam defaultFontColor #d4d4d4
skinparam activityBorderColor #0f3460
skinparam activityBackgroundColor #16213e
skinparam partitionBackgroundColor #16213e
skinparam partitionBorderColor #0f3460
skinparam arrowColor #e94560

partition "用户操作" {
  :File (浏览器 File 对象);
  note right
    name, size, lastModified
    arrayBuffer() 可读取
  end note
}

partition "上传/验证" {
  :filterArchiveFiles() → File[];
  :validateArchiveFiles() → File[];
  :addFiles() → ArchiveItem;
  :cacheManager.cacheArchive() → CacheMeta;
  note right
    去重: name + size + lastModified
    缓存: IndexedDB / 文件系统
  end note
}

partition "解压调度" {
  :TaskScheduler.enqueue() → task;
  note right
    最大并发: 3
    最大队列: 100
  end note
  :读取 Uint8Array (File / Cache);
  :detectCompression → ICompressionPlugin;
  :safeDecompress() → DecompressResult;
  note right
    { success, files[], error? }
  end note
}

partition "文件树" {
  :FileTreeBuilder.build() → FileTreeNode[];
  note right
    树形嵌套结构
    key: path
    label: name
    children?: 目录
  end note
  :archive.files = tree;
  :status = 'completed';
}

partition "文件预览" {
  :用户点击叶子节点;
  :openTab(node, archiveId) → TabItem;
  :ParserEngine.resolveFile() → ParsedContent;
  note right
    { type, data, lineCount,
      loadTimeMs, pluginName }
  end note
  :adapter.readFile(node.path);
  :getParser(ext) → IFileParserPlugin;
  :safeParse() → ParsedResult;
  :plugin.getComponent() → Renderer;
  :ErrorBoundary + <component :is>;
}

partition "渲染展示" {
  :TextRenderer → 带行号文本;
  :CsvRenderer → HTML 表格;
  :JsonRenderer → 可折叠树;
  :LogRenderer → 颜色标记日志;
  :HexRenderer → HEX + ASCII;
}

@enduml
```

---

## 十、文件清单与功能对照

| 文件路径 | 职责 | 关键导出 |
|---------|------|---------|
| `src/components/archive-panel/UploadZone.vue` | 面板文件上传（拖拽+点击） | `UploadZone` |
| `src/components/archive-panel/ArchiveCard.vue` | 压缩包卡片（状态+文件树） | `ArchiveCard` |
| `src/components/archive-panel/FileTree.vue` | 文件树选择器（NTree） | `FileTree` |
| `src/components/workspace/Workspace.vue` | 工作区容器（标签页+预览） | `Workspace` |
| `src/components/workspace/PreviewPane.vue` | 预览面板（解析+渲染） | `PreviewPane` |
| `src/components/workspace/TabBar.vue` | 标签页栏（滚动+右键菜单） | `TabBar` |
| `src/composables/use-archives.ts` | 归档列表管理（CRUD+去重） | `useArchiveManager` |
| `src/composables/use-decompress.ts` | 解压调度（TaskScheduler） | `useDecompress` |
| `src/composables/use-tabs.ts` | 标签页状态管理 | `useTabManager` |
| `src/composables/use-plugins.ts` | 插件注册表单例 | `usePluginEngine` |
| `src/composables/use-cache.ts` | 缓存管理器（平台选择） | `useCacheManager` |
| `src/composables/use-platform.ts` | 平台适配器（懒加载） | `usePlatform` |
| `src/composables/use-global-drop.ts` | 全局拖拽上传 | `useGlobalDrop` |
| `src/plugins/registry.ts` | 插件注册表（注册/检测/安全调用） | `PluginRegistry` |
| `src/plugins/manifest.ts` | 内置插件注册清单 | `registerBuiltinPlugins` |
| `src/plugins/types.ts` | 插件接口定义 | `ICompressionPlugin`, `IFileParserPlugin` |
| `src/plugins/compression/zip-plugin.ts` | ZIP 解压插件（fflate/Tauri） | `zipPlugin` |
| `src/plugins/compression/gzip-plugin.ts` | GZIP 解压插件（DecompressionStream/Tauri） | `gzipPlugin` |
| `src/plugins/parser/text-plugin.ts` | 文本解析插件 | `textPlugin` |
| `src/plugins/parser/csv-plugin.ts` | CSV 解析插件 | `csvPlugin` |
| `src/plugins/parser/json-plugin.ts` | JSON 解析插件 | `jsonPlugin` |
| `src/plugins/parser/log-plugin.ts` | 日志解析插件 | `logPlugin` |
| `src/plugins/parser/hex-plugin.ts` | HEX 兜底解析插件 | `hexPlugin` |
| `src/plugins/parsers/text-parser.ts` | 文本解析纯函数 | `parseText` |
| `src/plugins/parsers/csv-parser.ts` | CSV 解析纯函数 | `parseCsv` |
| `src/plugins/parsers/json-parser.ts` | JSON 解析纯函数 | `parseJson` |
| `src/plugins/parsers/log-parser.ts` | 日志解析纯函数 | `parseLog` |
| `src/core/parser-engine.ts` | 解析引擎（适配器+插件） | `ParserEngine` |
| `src/core/decompress.ts` | 解压服务 | `DecompressService` |
| `src/core/file-tree.ts` | 文件树构建器 | `FileTreeBuilder` |
| `src/core/task-scheduler.ts` | 并发任务调度器 | `TaskScheduler` |
| `src/core/cache-manager.ts` | LRU 缓存管理器 | `CacheManager` |
| `src/core/memory-store.ts` | 内存存储（256MB 上限） | `MemoryStore` |
| `src/core/archive-utils.ts` | 压缩包过滤/验证工具 | `filterArchiveFiles`, `validateArchiveFiles` |
| `src/core/file-validator.ts` | 文件验证管线（策略链） | `ValidationPipeline` |
| `src/core/search.ts` | 文本搜索服务 | `SearchService` |
| `src/adapters/web-adapter.ts` | Web 平台适配器 | `WebAdapter` |
| `src/adapters/tauri-adapter.ts` | Tauri 平台适配器 | `TauriAdapter` |
| `src/adapters/types.ts` | 适配器接口定义 | `IPlatformAdapter` |
| `src/types/index.ts` | 共享领域类型 | `FileEntry`, `ArchiveItem`, `FileTreeNode`, `ParsedContent`, `TabItem` |
| `src/stores/app.ts` | Pinia UI 状态 | `useAppStore` |
| `src/main.ts` | 应用入口（缓存初始化+恢复） | — |