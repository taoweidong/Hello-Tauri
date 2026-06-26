# 跨平台日志解析工具 — 系统架构设计

## 1. 总体架构概览

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #16213e
skinparam packageBorderColor #0f3460
skinparam componentBackgroundColor #0f3460
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "前端 (Vue 3 + TypeScript + Naive UI)" #0f3460 {
  component "UI 组件层" as FE_UI
  component "Composables 层" as FE_COMP
  component "Core Services 层" as FE_CORE
  component "插件注册中心" as FE_PLUGIN
}

package "平台适配层" #16213e {
  component "IPlatformAdapter" as ADAPTER
  component "WebAdapter (WASM)" as WEB
  component "TauriAdapter (IPC)" as TAURI_A
  ADAPTER --> WEB
  ADAPTER --> TAURI_A
}

package "后端 (Tauri Rust)" #0f3460 {
  component "IPC 命令层" as BE_CMD
  component "文件操作 (mmap)" as BE_FILE
  component "原生解压" as BE_DEC
  component "Rust 线程池" as BE_THREAD
}

FE_CORE --> ADAPTER
TAURI_A --> BE_CMD
BE_CMD --> BE_FILE
BE_CMD --> BE_DEC
BE_FILE --> BE_THREAD
BE_DEC --> BE_THREAD
@enduml
```

### 1.1 项目目录结构

```
hello-tauri/
├── src/                           # 前端源码
│   ├── adapters/                  # 平台适配层
│   ├── plugins/                   # 插件系统
│   ├── core/                      # 核心业务逻辑
│   ├── composables/               # Vue 组合式函数
│   ├── components/                # UI 组件
│   ├── stores/                    # Pinia 全局状态
│   ├── styles/                    # 主题与样式
│   ├── main.ts
│   └── App.vue
├── src-tauri/                     # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs
│   │   ├── file_ops.rs
│   │   └── decompress.rs
│   └── Cargo.toml
├── vite.config.ts
├── tsconfig.json
├── package.json
└── tauri.conf.json
```

---

# 2. 前端设计

## 2.1 组件库选型

### 2.1.1 选型结论：Naive UI

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

**选型理由**：原生虚拟滚动满足 10 万+ 节点需求；一行代码切换暗黑主题；最佳 tree-shaking 控制 EXE 包体积；100% TypeScript 类型安全。

### 2.1.2 辅助依赖

| 库 | 用途 | 理由 |
|---|---|---|
| `vue-draggable-plus` | 标签页拖拽排序 | 轻量、Vue 3 原生、支持 SortableJS |
| `@vueuse/core` | 通用 composable 工具 | 防抖、节流、响应式断点、鼠标事件等 |
| `splitpanes` | 面板拖拽分隔条 | 轻量、支持水平/垂直拆分 |

### 2.1.3 Naive UI 组件使用映射总表

| UI 区域 | 功能需求 | Naive UI 组件 | 说明 |
|---|---|---|---|
| **全局布局** | 四栏式布局 | `NLayout` + `NLayoutHeader` + `NLayoutSider` + `NLayoutContent` | 嵌套布局，侧栏可折叠 |
| **顶部公共栏 - 统计** | 实时聚合数据 | `NStatistic` + `NTag` + `NSpace` | 总包数/大小/文件数/耗时 |
| **顶部公共栏 - 搜索** | 关键词输入 | `NInput` (search type) + `NButton` | 搜索框 + 按钮 |
| **顶部公共栏 - 批量操作** | 下拉菜单 | `NDropdown` | 清空/导出/重新解压 |
| **左侧 - 压缩包卡片** | 独立卡片容器 | `NCard` + `NCollapse` | 每个压缩包一张卡片 |
| **左侧 - 状态指示** | 状态可视化 | `NTag` (success/info/warning/error) + `NProgress` | 颜色语义化 |
| **左侧 - 文件树** | 虚拟滚动树 | `NTree` (virtual-scroll) | 异步加载、自定义渲染、过滤 |
| **左侧 - 右键菜单** | 上下文菜单 | `NDropdown` (trigger=manual) | 预览/导出/复制路径/元数据 |
| **中间 - 标签栏** | 多标签管理 | `NTabs` (type=card, closable) | 拖拽排序由 vue-draggable-plus 扩展 |
| **中间 - 预览区** | 动态组件渲染 | `NDynamicComponent` + `NScrollbar` | `<component :is>` 挂载插件组件 |
| **中间 - 分屏** | 拆分视图 | `splitpanes` | 左右/上下分屏对比 |
| **中间 - 工具栏** | 预览设置 | `NInputNumber` + `NSwitch` + `NSelect` | 字号/换行/行号/编码 |
| **中间 - CSV 表格** | 大数据表格 | `NDataTable` (virtual-scroll) | 列固定/排序/筛选/表头固定 |
| **中间 - 状态栏** | 性能信息 | `NText` + `NSpace` | 行号/内存/耗时/插件名 |
| **右侧 - 元数据** | 属性展示 | `NDescriptions` + `NDescriptionsItem` | 文件/压缩包级元数据 |
| **右侧 - 配置表单** | 插件配置 | `NForm` + `NFormItem` (动态渲染) | 根据 getConfigSchema 生成 |
| **右侧 - 路径链路** | 嵌套层级 | `NBreadcrumb` + `NBreadcrumbItem` | 压缩包嵌套路径 |
| **通用 - 错误边界** | 异常降级 | 自定义 `ErrorBoundary.vue` | 捕获渲染异常 |
| **通用 - 空状态** | 无数据提示 | `NEmpty` | 无文件/无搜索结果 |
| **通用 - 上传** | 拖拽上传 | `NUpload` (dragger type) | 拖拽高亮边框 |
| **通用 - 通知** | 操作反馈 | `NMessage` + `NNotification` | 成功/失败/进度通知 |
| **通用 - 骨架屏** | 加载态 | `NSkeleton` | 文件树/预览区加载中 |

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560
skinparam packageBackgroundColor #16213e
skinparam packageBorderColor #0f3460

package "App.vue" {
  package "NLayout (全屏)" {
    package "NLayoutHeader (PublicBar)" {
      rectangle "NStatistic x6" as stat
      rectangle "NInput (search)" as search
      rectangle "NDropdown (批量操作)" as batch
    }

    package "NLayout (horizontal)" {
      package "NLayoutSider (左侧, collapsible)" {
        rectangle "NUpload (dragger)" as upload
        rectangle "NCard + NCollapse\n(NTag 状态 + NProgress)" as cards
        rectangle "NTree (virtual-scroll)" as tree
      }

      package "NLayoutContent (中间)" {
        rectangle "NTabs (card, closable)\n+ vue-draggable-plus" as tabs
        rectangle "splitpanes\n(分屏视图)" as split
        rectangle "NDynamicComponent\n(插件渲染器)" as dyn
        rectangle "NDataTable (virtual)\n(CSV 预览)" as table
        rectangle "NText (状态栏)" as statusbar
      }

      package "NLayoutSider (右侧, collapsible)" {
        rectangle "NDescriptions\n(元数据)" as desc
        rectangle "NForm (动态配置)" as form
        rectangle "NBreadcrumb\n(路径链路)" as bread
      }
    }
  }
}
@enduml
```

### 2.1.4 主题配置

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

## 2.2 页面布局设计

### 2.2.1 整体布局结构

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "浏览器窗口 / WebView2 (100vw x 100vh)" #16213e {

  rectangle "顶部全局公共信息栏 (固定高度 48-64px)" #0f3460 {
    rectangle "[聚合统计] 总包数 | 总大小 | 总文件数 | 已解压 | 耗时" as stats
    rectangle "[全局搜索] NInput + NButton" as gsearch
    rectangle "[批量操作] NDropdown" as gbatch
  }

  rectangle "主体区域 (flex: 1, 剩余高度)" #16213e {

    rectangle "左侧面板\nNLayoutSider\n宽度: 280px\n可折叠/拖拽调整\n最小: 200px" as left #0f3460 {
      rectangle "上传区 (拖拽区域)" as upload_zone
      rectangle "压缩包卡片列表\n(纵向滚动)" as card_list
      rectangle "  └ 文件树 NTree\n     (虚拟滚动)" as file_tree
    }

    rectangle "中间工作区\nNLayoutContent\nflex: 1\n自适应宽度" as center #0f3460 {
      rectangle "标签栏 NTabs\n(拖拽排序/关闭/固定)" as tab_bar
      rectangle "预览内容区\n<component :is>\n动态渲染器" as preview
      rectangle "性能状态栏\n(固定底部 24px)" as perf_bar
    }

    rectangle "右侧属性面板\nNLayoutSider\n宽度: 300px\n可折叠/拖拽调整\n小屏自动隐藏" as right #0f3460 {
      rectangle "上下文元数据\nNDescriptions" as meta
      rectangle "插件配置表单\nNForm (动态)" as config
      rectangle "路径链路\nNBreadcrumb" as path
    }
  }
}

note bottom of left
  collapsed-width: 0
  collapse-mode: width
  trigger: 自定义折叠按钮
end note

note bottom of right
  collapsed-width: 0
  collapse-mode: width
  breakpoint: 1200px 自动折叠
end note
@enduml
```

### 2.2.2 左侧面板详细设计

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "左侧面板 (280px)" #16213e {

  rectangle "上传区域\nNUpload dragger\n高度: 80px\n拖拽高亮边框" as upload #0f3460

  rectangle "压缩包卡片列表\n(overflow-y: auto)" #0f3460 {

    rectangle "ArchiveCard #1" #16213e {
      rectangle "卡片头部\nNCard header\n文件名 + NTag(状态)" as card_h1
      rectangle "状态区\nNProgress (解压中)\n或 NTag (完成/失败)" as card_s1
      rectangle "文件树\nNTree (virtual-scroll)\n独立折叠/展开\n独立搜索过滤" as card_t1
    }

    rectangle "ArchiveCard #2" #16213e {
      rectangle "卡片头部" as card_h2
      rectangle "状态区" as card_s2
      rectangle "文件树" as card_t2
    }

    rectangle "... (更多卡片)" as more
  }
}

note right of card_s1
  状态可视化:
  completed: NTag success "已完成"
  running:   NProgress + NTag info "解压中"
  pending:   NTag warning "排队中"
  failed:    NTag error "失败" + 错误摘要
end note

note right of card_t1
  交互:
  - 点击文件节点 → 中间新开/激活标签页
  - 右键 → NDropdown 上下文菜单
    (预览/导出/复制路径/查看元数据)
  - NTree pattern 属性过滤节点
end note
@enduml
```

### 2.2.3 中间工作区详细设计

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "中间工作区 (flex: 1)" #16213e {

  rectangle "标签栏 (固定顶部 40px)" #0f3460 {
    rectangle "Tab1 [x]" as t1
    rectangle "Tab2 [pin][x]" as t2
    rectangle "Tab3 [x]" as t3
    rectangle "+" as t_add
    note right of t2: 拖拽排序\nvue-draggable-plus
  }

  rectangle "预览工具栏 (固定 36px)" #0f3460 {
    rectangle "文本: NInputNumber(字号)\nNSwitch(换行) NSwitch(行号)\nNSelect(编码)" as text_toolbar
    rectangle "CSV: NInput(分隔符)\nNSwitch(表头固定)\n列排序/筛选" as csv_toolbar
    rectangle "通用: NInput(高亮正则)\n上/下导航按钮" as common_toolbar
  }

  rectangle "预览内容区 (flex: 1)" #0f3460 {
    rectangle "单视图模式:\n<component :is='pluginComponent'\n:content='parsedContent' />" as single
    rectangle "分屏模式 (splitpanes):\n左右或上下分屏对比" as split
  }

  rectangle "性能状态栏 (固定底部 24px)" #0f3460 {
    rectangle "当前行/总行数 | 可视区内存占用 | 加载耗时 | 所用解析插件" as perf
  }
}
@enduml
```

### 2.2.4 右侧属性面板详细设计

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "右侧属性面板 (300px)" #16213e {

  rectangle "上下文感知切换" #0f3460 {

    rectangle "选中压缩包时:\nNDescriptions\n  - 文件名\n  - 原始大小\n  - 压缩后大小\n  - 压缩格式\n  - 文件数量\n  - 解压耗时" as archive_meta

    rectangle "选中文件时:\nNDescriptions\n  - 文件名\n  - 大小\n  - 扩展名\n  - 编码\n  - 行数\n  - 修改时间" as file_meta
  }

  rectangle "插件配置表单 (动态)\nNForm + NFormItem\n根据 getConfigSchema() 生成" #0f3460 {
    rectangle "NInput / NSelect\nNSwitch / NInputNumber\n等控件自动渲染" as config_form
  }

  rectangle "路径链路\nNBreadcrumb\n显示文件在压缩包内\n完整路径和嵌套层级" #0f3460 {
    rectangle "root.zip > inner.tar.gz > data > log.txt" as path_chain
  }
}

archive_meta -[hidden]down-> file_meta
@enduml
```

### 2.2.5 响应式行为

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam rectangleBackgroundColor #0f3460
skinparam rectangleBorderColor #e94560
skinparam arrowColor #e94560

rectangle "响应式断点与面板行为" #16213e {

  rectangle ">= 1400px (宽屏)" #0f3460 {
    rectangle "左侧 280px | 中间 flex | 右侧 300px\n三栏全部展开" as wide
  }

  rectangle "1200-1399px (标准)" #0f3460 {
    rectangle "左侧 280px | 中间 flex\n右侧面板自动折叠" as normal
  }

  rectangle "< 1200px (窄屏)" #0f3460 {
    rectangle "左侧折叠为图标栏\n中间 flex 占满\n右侧隐藏" as narrow
  }
}

note bottom of wide
  所有面板可通过
  splitpanes 拖拽调整宽度
  最小宽度: 左 200px, 右 240px
end note

note bottom of normal
  右侧面板可通过
  折叠按钮手动展开
end note
@enduml
```

### 2.2.6 视觉与交互规范

| 维度 | 规范 |
|---|---|
| **主题** | 默认深色模式，支持浅色切换；Naive UI `darkTheme` 一键切换 |
| **色彩语义** | ERROR=#EF4444, WARN=#F59E0B, INFO=#3B82F6, SUCCESS=#10B981 |
| **字体** | 预览区使用等宽字体 (JetBrains Mono / Fira Code)，UI 使用系统无衬线字体 |
| **虚拟滚动** | 文件树 (`NTree`) 与预览区均启用，保证 10 万+ 节点/行流畅渲染 |
| **反馈** | 拖拽上传高亮边框；解压进度平滑过渡；搜索匹配高亮闪烁；加载态 `NSkeleton` 骨架屏 |
| **面板交互** | 左右面板可折叠/拖拽调整宽度；小屏自动隐藏右侧面板 |

## 2.3 前端组件树

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam componentBackgroundColor #0f3460
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

component "App.vue" as App

App --> "AppLayout" as Layout

Layout --> "PublicBar" as PB
Layout --> "ArchivePanel" as AP
Layout --> "Workspace" as WS
Layout --> "PropertyPanel" as PP

PB --> "GlobalStats" as GS
PB --> "GlobalSearch" as GSch

AP --> "UploadZone" as UZ
AP --> "ArchiveCard" as AC

AC --> "StatusIndicator" as SI
AC --> "FileTree" as FT

FT --> "TreeNode (NTree)" as TN

WS --> "TabBar" as TB
WS --> "PreviewPane" as PV
WS --> "PreviewToolbar" as PT
WS --> "StatusBar" as SB
WS --> "SplitView" as SV

PV --> "TextRenderer" as TR
PV --> "CsvRenderer" as CR
PV --> "JsonRenderer" as JR
PV --> "HexRenderer" as HR

PP --> "MetadataView" as MV
PP --> "ConfigForm" as CF
PP --> "PathBreadcrumb" as PBr
@enduml
```

## 2.4 前端状态管理

| 状态类型 | 存储位置 | 示例 |
|---|---|---|
| UI 局部状态 | 组件 `ref()` | 下拉菜单展开、输入框内容、面板折叠状态 |
| 跨组件共享状态 | Composable（模块级 reactive） | 当前激活标签页、选中文件、搜索关键词 |
| 全局持久状态 | Pinia store | 主题偏好、插件启禁用、面板宽度 |

### 2.4.1 关键 Composables

| Composable | 职责 | 核心 API |
|---|---|---|
| `useArchiveManager()` | 管理压缩包生命周期 | `addFiles(files[])`, `remove(id)`, `retry(id)`, `archives` |
| `useTabManager()` | 标签页 CRUD | `open(file)`, `close(id)`, `tabs`, `activeTab`, `splitView(id, dir)` |
| `usePluginEngine()` | 插件注册中心封装 | `detect(file)`, `getComponent(file)`, `enable/disable(name)` |
| `useSearch()` | 全局搜索 | `search(keyword)`, `results`, `searching`, `jumpTo(result)` |
| `usePlatform()` | 平台适配器单例 | `adapter`, `isTauri`, `isWeb` |
| `useVirtualFileSystem()` | VFS 抽象 | `readFile(path)`, `listDir(path)`, `getTree(archiveId)` |
| `usePanelLayout()` | 面板布局管理 | `leftWidth`, `rightWidth`, `collapseLeft()`, `collapseRight()` |

## 2.5 前端数据流

### 2.5.1 文件预览调用链

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam sequenceArrowColor #e94560
skinparam sequenceParticipantBackgroundColor #0f3460
skinparam sequenceParticipantBorderColor #e94560
skinparam sequenceLifeLineBorderColor #e94560

actor 用户
participant "FileTree" as Tree
participant "useTabManager" as Tab
participant "ParserEngine" as Parser
participant "PluginRegistry" as Registry
participant "IFileParserPlugin" as Plugin
participant "IPlatformAdapter" as Adapter

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
Tab -> Tab : <component :is> 动态挂载
@enduml
```

### 2.5.2 全局搜索调用链

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam sequenceArrowColor #e94560
skinparam sequenceParticipantBackgroundColor #0f3460
skinparam sequenceParticipantBorderColor #e94560
skinparam sequenceLifeLineBorderColor #e94560

actor 用户
participant "GlobalSearch" as Search
participant "useSearch" as Hook
participant "SearchService" as Svc
participant "SearchWorker" as Worker
participant "useTabManager" as Tab

用户 -> Search : 输入关键词
Search -> Hook : search(keyword)
Hook -> Svc : search(keyword)

par 并行分发到 Worker
  Svc -> Worker : 搜索文件组 A
else
  Svc -> Worker : 搜索文件组 B
else
  Svc -> Worker : 搜索文件组 N
end

Worker --> Svc : SearchMatch[]
Svc -> Svc : 结果聚合去重
Svc --> Hook : SearchResults
Hook --> Search : 列表渲染

用户 -> Search : 点击结果项
Search -> Tab : openTab(file, { line, highlight })
@enduml
```

---

# 3. 后端设计

## 3.1 后端整体架构

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #e94560
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "Tauri Rust 后端 (src-tauri/)" {

  package "IPC 命令层 (commands.rs)" {
    component "read_file_cmd" as cmd1
    component "write_file_cmd" as cmd2
    component "list_files_cmd" as cmd3
    component "mmap_read_cmd" as cmd4
    component "decompress_cmd" as cmd5
    component "get_temp_dir_cmd" as cmd6
  }

  package "文件操作 (file_ops.rs)" {
    component "MmapReader\n零拷贝文件读取" as mmap
    component "FileStream\n流式读取" as stream
    component "FileWalker\n目录遍历" as walker
  }

  package "原生解压 (decompress.rs)" {
    component "ZipDecompressor" as zip
    component "GzipDecompressor" as gzip
    component "SevenZDecompressor" as sevenz
    component "RarDecompressor" as rar
  }

  package "线程管理" {
    component "tokio::spawn\n异步任务池" as pool
    component "rayon\nCPU 密集型并行" as rayon
  }
}

cmd1 --> mmap
cmd4 --> mmap
cmd3 --> walker
cmd5 --> zip
cmd5 --> gzip
cmd5 --> sevenz
cmd5 --> rar
zip --> pool
gzip --> pool
sevenz --> pool
rar --> pool
mmap --> rayon
@enduml
```

### 3.1.1 Rust 模块结构

```
src-tauri/src/
├── main.rs              # Tauri 入口，注册所有命令
├── commands.rs          # IPC 命令处理函数（#[tauri::command]）
├── file_ops.rs          # mmap 读取、流式读取、目录遍历
├── decompress.rs        # 原生解压实现（zip/gzip/7z/rar）
└── error.rs             # 统一错误类型
```

### 3.1.2 Cargo 依赖

| crate | 用途 |
|---|---|
| `tauri` | 桌面框架核心 |
| `tokio` | 异步运行时 |
| `memmap2` | mmap 零拷贝文件读取 |
| `zip` | ZIP 解压 |
| `flate2` | Gzip 解压 |
| `sevenz-rust` | 7z 解压 |
| `unrar` | RAR 解压 |
| `rayon` | CPU 密集型并行（大文件搜索） |
| `serde` / `serde_json` | 序列化 |

## 3.2 平台适配层设计

### 3.2.1 IPlatformAdapter 接口

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

### 3.2.2 Web 端 vs Tauri 端实现对比

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam classBackgroundColor #0f3460
skinparam classBorderColor #e94560
skinparam arrowColor #e94560

interface IPlatformAdapter {
  + readFile(path): Promise<Uint8Array>
  + writeFile(path, data): Promise<void>
  + listFiles(dir): Promise<FileEntry[]>
  + getTempDir(): Promise<string>
  + decompress(data, fmt, outDir): Promise<DecompressResult>
  + mmapRead(path, offset, len): Promise<Uint8Array>
  + streamRead(path): ReadableStream<Uint8Array>
}

class WebAdapter {
  - wasmModules: Map
  + readFile(): fetch + ArrayBuffer
  + mmapRead(): WASM mmap 模拟
  + streamRead(): TransformStream
  + decompress(): WASM 解压模块
}

class TauriAdapter {
  + readFile(): invoke('read_file_cmd')
  + mmapRead(): invoke('mmap_read_cmd')
  + streamRead(): Tauri Event 流
  + decompress(): invoke('decompress_cmd')
}

IPlatformAdapter <|.. WebAdapter
IPlatformAdapter <|.. TauriAdapter
@enduml
```

### 3.2.3 编译期平台切换

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
      external: platform === 'web' ? ['@tauri-apps/api/**'] : []
    }
  }
})
```

## 3.3 插件系统设计

### 3.3.1 核心接口

```
ICompressionPlugin {
  name: string
  supportedExtensions: string[]
  canHandle(file: FileEntry): boolean   // 魔数检测
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
  getProgress?(): Observable<number>
}

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

### 3.3.2 插件注册中心

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
  + register(plugin): void
  + registerAll(manifest): void
  + getCompression(name): ICompressionPlugin | null
  + getParser(ext): IFileParserPlugin | null
  + detect(file): IFileParserPlugin | null
  + detectCompression(file): ICompressionPlugin | null
  + enable(name): void
  + disable(name): void
  + safeDecompress(plugin, data, outDir): Promise<DecompressResult>
  + safeParse(plugin, data, opts): Promise<ParsedContent>
}

class ZipPlugin
class GzipPlugin
class SevenZPlugin
class RarPlugin
class TextPlugin
class CsvPlugin
class JsonPlugin
class XmlPlugin

PluginRegistry o--> "compression" ICompressionPlugin
PluginRegistry o--> "parser" IFileParserPlugin
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

### 3.3.3 插件隔离与安全

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

- 每个插件运行在独立作用域，异常不影响核心引擎
- 插件通过白名单 API 访问系统资源
- 支持运行时启用/禁用插件，禁用后回退到默认查看器

### 3.3.4 扩展新插件流程

| 扩展类型 | 步骤 | 核心改动 |
|---|---|---|
| 新增压缩格式 | 1. 新建 TS 模块实现 `ICompressionPlugin` 2. 若需原生能力，编写 WASM/Rust 3. 在 `manifest.ts` 注册 | **核心代码零修改** |
| 新增文件格式 | 1. 新建 Vue 组件作为渲染器 2. 新建 TS 模块实现 `IFileParserPlugin` 3. 可选声明 `getConfigSchema()` 4. 在 `manifest.ts` 注册 | **核心代码零修改** |

## 3.4 核心服务设计

### 3.4.1 解压调度流程

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

### 3.4.2 TaskScheduler 并发控制

```
TaskScheduler {
  - queue: PriorityQueue<ArchiveItem>
  - running: number (max = 3)
  + enqueue(item, priority): void
  + retry(id): void
  + cancel(id): void
}
```

- 优先级队列，支持优先级调整
- 并发上限默认 3，可配置
- 支持取消和重试

## 3.5 错误处理设计

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

PA --> PR : 文件读写失败 / IPC 断连
note right of PA: Adapter 抛出异常

PR --> CS : 解压失败 / 解析异常 / 超时
note right of PR
  safeDecompress / safeParse
  Promise.race + timeout
  emit('plugin-error')
end note

CS --> UI : 文件不存在 / 格式不支持
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

---

# 4. 4+1 架构视图

## 4.1 逻辑视图

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

## 4.2 开发视图

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam packageBackgroundColor #0f3460
skinparam packageBorderColor #e94560
skinparam componentBackgroundColor #16213e
skinparam componentBorderColor #e94560
skinparam arrowColor #e94560

package "src/ (前端)" {
  package "adapters/" {
    component "types.ts\nweb-adapter.ts\ntauri-adapter.ts" as adapters
  }

  package "plugins/" {
    component "types.ts\nregistry.ts\nmanifest.ts" as plugins
    component "compression/\n(zip/gzip/7z/rar)" as comp_plugins
    component "parser/\n(text/csv/json/xml)" as parse_plugins
  }

  package "core/" {
    component "decompress.ts\nparser-engine.ts\nsearch.ts\ntask-scheduler.ts\nfile-tree.ts" as core
  }

  package "composables/" {
    component "use-archives.ts\nuse-tabs.ts\nuse-plugins.ts\nuse-search.ts\nuse-platform.ts\nuse-vfs.ts\nuse-panel-layout.ts" as composables
  }

  package "components/" {
    component "layout/ (AppLayout)\npublic-bar/ (PublicBar, GlobalStats, GlobalSearch)\narchive-panel/ (ArchivePanel, ArchiveCard, FileTree)\nworkspace/ (Workspace, TabBar, PreviewPane, SplitView)\nproperty-panel/ (PropertyPanel, ConfigForm)\nshared/ (ErrorBoundary, VirtualScroll)" as ui_components
  }

  package "stores/" {
    component "app.ts (Pinia)" as stores
  }
}

package "src-tauri/ (后端)" {
  component "main.rs\ncommands.rs\nfile_ops.rs\ndecompress.rs\nerror.rs" as rust
}

package "外部依赖" {
  rectangle "Naive UI" as naive
  rectangle "vue-draggable-plus" as drag
  rectangle "@vueuse/core" as vueuse
  rectangle "splitpanes" as split
}

ui_components --> naive
ui_components --> drag
ui_components --> split
composables --> vueuse
ui_components --> composables
composables --> core
core --> plugins
core --> adapters
adapters --> rust
@enduml
```

## 4.3 进程视图

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
  queue "Vue Render\n(Naive UI 虚拟滚动)" as render
  queue "Composables\n(reactive state)" as comp
}

node "Worker Pool (Web)" {
  queue "Search Worker 1" as w1
  queue "Search Worker 2" as w2
  queue "Search Worker N" as wn
}

node "Task Scheduler\n(concurrency = 3)" {
  queue "Decompress Task 1" as d1
  queue "Decompress Task 2" as d2
  queue "Decompress Task 3" as d3
}

node "Tauri Backend\n(Rust tokio + rayon)" {
  queue "IPC Handler" as ipc
  queue "mmap Reader" as mmap
  queue "Native Decompress" as nd
  queue "Parallel Search" as ps
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
ipc --> ps
@enduml
```

## 4.4 物理视图

```plantuml
@startuml
skinparam backgroundColor #1a1a2e
skinparam defaultTextColor #e0e0e0
skinparam nodeBackgroundColor #0f3460
skinparam nodeBorderColor #e94560
skinparam artifactBackgroundColor #16213e
skinparam artifactBorderColor #e94560
skinparam arrowColor #e94560

node "Web 部署产物" {
  artifact "index.html" as wh
  artifact "app.[hash].js\n(tree-shaken)" as wj
  artifact "wasm-modules/" as ww
  artifact "assets/" as wa
}

node "Windows EXE 部署产物" {
  artifact "log-parser.exe\n(~8-15 MB)" as exe
  node "WebView2 Runtime\n(系统级)" as wv
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

## 4.5 场景视图

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

---

# 5. 测试策略

| 类型 | 覆盖目标 | 工具 |
|---|---|---|
| 单元测试 | Composable 逻辑、工具函数、插件解析 | Vitest |
| 组件测试 | UI 组件渲染与交互 | Vitest + Vue Test Utils |
| 插件测试 | 各插件 canHandle / decompress / parse | Vitest + 测试夹具文件 |
| E2E 测试 | 端到端流程（上传→解压→预览→搜索） | Playwright（Web）|
| 性能测试 | 10 万+ 文件树渲染、大文件虚拟滚动 | 手动基准 + CI 阈值 |
| Rust 测试 | 文件操作、解压正确性、IPC 命令 | `cargo test` |

# 6. 构建产物

| 平台 | 命令 | 产物 |
|---|---|---|
| Web | `vite build --mode web` | 静态 HTML/JS/CSS + WASM |
| Windows EXE | `tauri build` | 单文件 .exe (~8-15MB) |
| 开发 | `vite dev` + `tauri dev` | HMR + Rust 热重载 |
