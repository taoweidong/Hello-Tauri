# Hello-Tauri 新手开发指南

> 面向新开发者的项目入门指南，帮助你快速了解项目结构、核心模块与运行方式。

---

## 1. 项目概述

Hello-Tauri 是一款**跨平台桌面数据工具**，采用单仓库（Monorepo）结构，同时产出 Web 端与桌面端两套应用：

- **前端**：Vue 3 + TypeScript + Naive UI + Pinia，使用 Vite 8 构建
- **桌面端**：Tauri 2（Rust），通过 IPC 调用原生文件/解压能力
- **测试**：Vitest + @vue/test-utils + jsdom

核心功能：上传 ZIP/GZIP 压缩包 → 自动解压 → 文件树浏览 → 多格式解析预览（文本、CSV、JSON、日志、Hex）→ 全文搜索。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                        App.vue                              │
│   NConfigProvider → ErrorBoundary → AppLayout.vue           │
│   ┌──────────┬──────────────────┬──────────────────┐        │
│   │ ArchivePanel │   Workspace   │  PropertyPanel   │        │
│   │ (左侧栏)    │  (标签页+预览)  │   (右侧栏)       │        │
│   └──────────┴──────────────────┴──────────────────┘        │
└─────────────────────────────────────────────────────────────┘
            │                    │
    ┌───────▼────────┐   ┌──────▼──────────┐
    │  Composables   │   │  Plugin System  │
    │ (模块级单例状态)  │   │ (解析+压缩插件)  │
    └───────┬────────┘   └──────┬──────────┘
            │                   │
    ┌───────▼───────────────────▼──────┐
    │       Adapter Layer               │
    │  @adapter → WebAdapter           │
    │         or TauriAdapter          │
    └──────────────┬───────────────────┘
                   │ (仅 Tauri 模式)
    ┌──────────────▼───────────────────┐
    │         Tauri Rust 后端           │
    │  commands.rs → file_ops.rs       │
    │               → decompress.rs    │
    └──────────────────────────────────┘
```

**关键分层**：
1. **视图层**（Vue 组件）—— 纯 UI，不含业务逻辑
2. **Composable 层**（`use-*.ts`）—— 业务逻辑入口，模块级 ref 单例
3. **插件系统**（`src/plugins/`）—— 可扩展的解析与压缩能力
4. **适配器层**（`src/adapters/`）—— 屏蔽 Web/Tauri 平台差异
5. **Rust 后端**（`src-tauri/`）—— 原生文件操作与解压

---

## 3. 目录结构

```
Hello-Tauri/
├── src/                      # 前端源码
│   ├── adapters/             # 平台适配器（Web / Tauri）
│   │   ├── types.ts          # IPlatformAdapter 接口定义
│   │   ├── web-adapter.ts    # Web 端实现（fetch/Range/ReadableStream）
│   │   └── tauri-adapter.ts  # Tauri 端实现（invoke IPC）
│   ├── components/           # Vue 组件（按功能分子目录）
│   │   ├── archive-panel/    # 左侧归档面板
│   │   ├── property-panel/   # 右侧属性面板
│   │   ├── public-bar/       # 顶部工具栏
│   │   ├── workspace/        # 中央工作区（标签页 + 预览）
│   │   └── shared/           # 通用组件（ErrorBoundary 等）
│   ├── composables/          # 公共组合式函数（模块级单例）
│   │   ├── use-archives.ts   # 归档管理（上传、列表、状态）
│   │   ├── use-cache.ts      # 缓存系统（IndexedDB）
│   │   ├── use-decompress.ts # 解压管道（TaskScheduler 并发控制）
│   │   ├── use-global-drop.ts# 全局拖放上传
│   │   ├── use-panel-layout.ts# 面板折叠/宽度
│   │   ├── use-platform.ts   # 平台适配器加载
│   │   ├── use-plugins.ts    # 插件引擎
│   │   ├── use-search.ts     # 全文搜索
│   │   ├── use-tabs.ts       # 标签页管理
│   │   └── use-vfs.ts        # 虚拟文件系统
│   ├── config/               # 应用常量配置
│   │   ├── index.ts          # 统一导出
│   │   ├── layout.ts         # 面板宽度默认值与边界
│   │   └── site.ts           # 站点名称、链接、Logo SVG
│   ├── core/                 # 核心纯 TS 逻辑
│   │   ├── cache-fs.ts       # 文件系统缓存实现
│   │   ├── cache-idb.ts      # IndexedDB 缓存实现
│   │   ├── cache-manager.ts  # 缓存管理器
│   │   ├── decompress.ts     # 解压逻辑
│   │   ├── file-tree.ts      # 文件树构建
│   │   ├── file-validator.ts # 文件校验
│   │   ├── format.ts         # 格式化工具
│   │   ├── memory-store.ts   # 内存存储
│   │   ├── parser-engine.ts  # 解析引擎
│   │   ├── search.ts         # 搜索算法
│   │   └── task-scheduler.ts # 任务调度器（并发限制）
│   ├── layout/               # 整体布局
│   │   └── AppLayout.vue     # 四栏布局主容器
│   ├── plugins/              # 插件系统（★ 新增文件类型在此）
│   │   ├── types.ts          # IFileParserPlugin / ICompressionPlugin 接口
│   │   ├── registry.ts       # PluginRegistry 类（注册、检测、安全执行）
│   │   ├── manifest.ts       # 内置插件注册入口
│   │   ├── parser/           # 解析插件包装层（实现接口 + 关联渲染器）
│   │   ├── parsers/          # 纯 TS 解析函数（text/csv/json/log/hex）
│   │   └── compression/      # 压缩插件（zip/gzip）
│   ├── stores/               # Pinia 状态管理
│   │   └── app.ts            # 全局 UI 状态（主题、面板宽度、插件启停）
│   ├── styles/               # 样式
│   │   ├── main.css          # 全局 CSS（Tailwind + CSS 变量）
│   │   └── theme.ts          # Naive UI 主题覆写
│   ├── types/                # 共享领域类型
│   │   └── index.ts          # FileEntry、TabItem、ParsedContent 等
│   ├── views/renderers/      # 文件渲染器 Vue 组件
│   │   ├── TextRenderer.vue
│   │   ├── CsvRenderer.vue
│   │   ├── JsonRenderer.vue
│   │   ├── LogRenderer.vue
│   │   └── index.ts          # 统一导出
│   ├── App.vue               # 根组件（主题 Provider 包裹）
│   └── main.ts               # 入口（Pinia + 缓存初始化）
│
├── src-tauri/                # Tauri Rust 后端
│   ├── src/
│   │   ├── main.rs           # 二进制入口（仅调用 run()）
│   │   ├── lib.rs            # Tauri 构建器，注册所有 IPC 命令
│   │   ├── commands.rs       # 命令门面（路径校验 + 转发）
│   │   ├── file_ops.rs       # 文件读写、mmap、目录遍历
│   │   ├── decompress.rs     # ZIP/GZIP 解压
│   │   └── error.rs          # 统一 AppError（thiserror）
│   ├── capabilities/         # Tauri 2 IPC 权限声明
│   │   └── default.json
│   ├── Cargo.toml            # Rust 依赖
│   └── tauri.conf.json       # Tauri 配置
│
├── docs/                     # 项目文档
├── data/                     # 测试用数据文件
├── vite.config.ts            # Vite 构建配置（平台切换核心）
├── vitest.config.ts          # 测试配置
├── tsconfig.json             # TypeScript 配置
└── package.json              # Node 依赖与脚本
```

---

## 4. 主要模块详解

### 4.1 插件系统

插件系统是项目扩展性的核心，位于 `src/plugins/`，分为两类插件：

**解析插件（`IFileParserPlugin`）**：将文件字节数据解析为结构化内容，并关联一个 Vue 渲染组件。

```typescript
// src/plugins/types.ts
interface IFileParserPlugin {
  name: string                    // 插件唯一标识
  supportedExtensions: string[]   // 支持的扩展名（如 ['.txt', '.md']）
  canParse(file: FileEntry): boolean
  parse(data: Uint8Array, options?): Promise<ParsedContent>
  getComponent(): Component       // 返回对应的 Vue 渲染组件
}
```

**压缩插件（`ICompressionPlugin`）**：处理压缩包的解压操作。

```typescript
interface ICompressionPlugin {
  name: string
  supportedExtensions: string[]   // 如 ['.zip']
  canHandle(file: FileEntry): boolean
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
}
```

**当前内置插件**：

| 类型 | 插件名 | 支持格式 | 渲染组件 |
|------|--------|---------|---------|
| 解析 | text | .txt .md .cfg .ini .env .yaml .yml .toml | TextRenderer |
| 解析 | csv | .csv | CsvRenderer |
| 解析 | json | .json | JsonRenderer |
| 解析 | log | .log | LogRenderer |
| 解析 | hex | 任意二进制 | HexRenderer |
| 压缩 | zip | .zip | — |
| 压缩 | gzip | .gz .gzip | — |

**注册表（`PluginRegistry`）**：管理所有插件的注册、查找、启停，并提供 `safeParse`/`safeDecompress`（带 30 秒超时保护）。

---

### 4.2 适配器模式

`src/adapters/types.ts` 定义了 `IPlatformAdapter` 接口，共 7 个方法：

```typescript
interface IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>
  streamRead(path: string): ReadableStream<Uint8Array>
}
```

- **WebAdapter**：使用 `fetch` + `Range` 请求 + `ReadableStream` 实现，无需 Tauri 环境
- **TauriAdapter**：懒加载 `@tauri-apps/api` 的 `invoke` 调用 Rust 命令

`usePlatform()` composable 根据 `__PLATFORM__` 编译时常量自动选择适配器，并通过 Promise 缓存实现单例。

---

### 4.3 Composable 单例模式

项目中大多数业务逻辑以 Composable 形式组织，**状态保存在模块级 `ref` 中**（而非 Pinia store），函数仅返回访问器：

```typescript
// src/composables/use-plugins.ts（示例）
const registry = new PluginRegistry()  // 模块级单例
registerBuiltinPlugins(registry)

export function usePluginEngine() {
  return { registry, detect: ..., getParser: ... }
}
```

| Composable | 职责 |
|-----------|------|
| `use-archives` | 归档文件列表管理、上传、状态追踪 |
| `use-cache` | IndexedDB 缓存初始化与恢复 |
| `use-decompress` | 解压管道（TaskScheduler(3) 并发控制） |
| `use-global-drop` | 全局文件拖放上传 |
| `use-panel-layout` | 左右面板折叠与宽度 |
| `use-platform` | 平台适配器访问 |
| `use-plugins` | 插件注册表与检测 |
| `use-search` | 全文搜索 |
| `use-tabs` | 标签页管理 |
| `use-vfs` | 虚拟文件系统 |

> **测试约定**：每个 composable 提供 `reset()` 方法，测试中在 `beforeEach` 调用以隔离状态。

---

### 4.4 Pinia Store

项目中仅有一个 Pinia store —— `src/stores/app.ts`，专门管理**纯 UI 状态**：

```typescript
const useAppStore = defineStore('app', () => {
  const isDarkTheme = ref(true)           // 暗色/亮色主题
  const disabledPlugins = ref<string[]>([]) // 已禁用插件列表
  const leftPanelWidth = ref(280)          // 左侧面板宽度
  const rightPanelWidth = ref(300)         // 右侧面板宽度
  const themeColor = ref<ThemeColorKey>('blue') // 主题色
  // ...
})
```

面板宽度的默认值与边界常量集中在 `src/config/layout.ts`。

---

### 4.5 页面布局

`AppLayout.vue` 实现三栏可折叠布局：

```
┌─────────────────────────────────────────────┐
│  顶部导航栏（PublicBar + Logo + 主题切换）    │
├─────────┬──────────────────┬────────────────┤
│  左侧    │    中央工作区      │     右侧      │
│ ArchivePanel │  Workspace   │ PropertyPanel  │
│ (可折叠)   │ (标签页+预览)   │   (可折叠)     │
├─────────┴──────────────────┴────────────────┤
│  底部状态栏（StatusBar）                      │
└─────────────────────────────────────────────┘
```

- **快捷键**：`Ctrl+B` 折叠左侧，`Ctrl+Shift+B` 折叠右侧，`Ctrl+K` 搜索
- **全局拖放**：支持直接拖拽压缩包文件到应用窗口上传

---

## 5. 运行方式

### 5.1 环境要求

| 依赖 | 版本要求 |
|------|---------|
| Node.js | >= 20 |
| Rust | 最新稳定版（Tauri 模式需要） |

### 5.2 安装依赖

```bash
npm install
```

### 5.3 常用命令

| 任务 | 命令 | 说明 |
|------|------|------|
| 开发（Web） | `npm run dev` | 启动 Vite 开发服务器，浏览器访问 |
| 开发（桌面） | `npm run tauri:dev` | 启动 Tauri 桌面窗口（需要 Rust 环境） |
| 类型检查 | `npm run typecheck` | vue-tsc 无输出模式检查 |
| 运行测试 | `npm test` | Vitest 单次运行所有测试 |
| 测试（watch） | `npm run test:watch` | Vitest 监听模式 |
| 单个测试 | `npx vitest run src/__tests__/core/search.test.ts` | 运行指定测试文件 |
| 构建（Web） | `npm run build` | vue-tsc 编译 + Vite 打包到 `build/web/` |
| 构建（桌面） | `npm run tauri:build` | 打包桌面应用 |
| Rust 检查 | `cargo check`（在 `src-tauri/` 目录） | 检查 Rust 代码 |

### 5.4 Rust 工具链（Windows）

在 PowerShell 中运行 Tauri 命令前，确保 Cargo 在 PATH 中：

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:https_proxy = ""; $env:no_proxy = "*"
```

---

## 6. 平台切换机制

项目通过环境变量 `VITE_PLATFORM` 在构建时决定目标平台，核心逻辑在 `vite.config.ts`：

```typescript
const platform = process.env.VITE_PLATFORM || 'web'  // 默认 web

// 1. 编译时常量替换：代码中的 __PLATFORM__ 被替换为 'web' 或 'tauri'
define: {
  __PLATFORM__: JSON.stringify(platform)
}

// 2. 路径别名切换：@adapter 指向不同实现
resolve: {
  alias: {
    '@adapter': platform === 'tauri'
      ? 'src/adapters/tauri-adapter'
      : 'src/adapters/web-adapter'
  }
}

// 3. Web 模式下外部化 @tauri-apps/api（避免打包 Tauri SDK）
build: {
  rolldownOptions: {
    external: platform === 'web' ? [/@tauri-apps\/api/] : []
  }
}
```

**在 Vue SFC 中使用平台常量**：

```vue
<script setup lang="ts">
// 必须赋值给局部变量，模板无法直接访问全局 declare const
const platform = __PLATFORM__
</script>

<template>
  <div v-if="platform === 'tauri'">桌面端专属功能</div>
</template>
```

**运行指定平台**：

```bash
# Web 模式（默认）
npm run dev

# Tauri 桌面模式
VITE_PLATFORM=tauri npm run dev
# 或直接使用
npm run tauri:dev
```

---

## 7. 如何添加新的文件类型解析插件

添加新格式只需 **3 个文件 + 1 行注册**，无需修改核心代码。

### 第一步：编写解析函数（`src/plugins/parsers/`）

创建纯 TS 解析函数，不含任何 Vue 依赖：

```typescript
// src/plugins/parsers/xml-parser.ts
import type { ParsedContent } from '@/types'

/**
 * 解析 XML 文件内容
 * @param data - 文件字节数据
 * @returns 解析结果
 */
export async function parseXml(data: Uint8Array): Promise<ParsedContent> {
  const text = new TextDecoder('utf-8').decode(data)
  // ... 解析逻辑
  return { type: 'text', data: text, pluginName: 'xml' }
}
```

### 第二步：创建 Vue 渲染组件（`src/views/renderers/`）

```vue
<!-- src/views/renderers/XmlRenderer.vue -->
<script setup lang="ts">
import type { ParsedContent } from '@/types'

const props = defineProps<{ content: ParsedContent }>()
</script>

<template>
  <div class="xml-renderer">
    <!-- 渲染 XML 内容 -->
    <pre>{{ content.data }}</pre>
  </div>
</template>

<style scoped>
.xml-renderer { padding: 1rem; overflow: auto; }
</style>
```

### 第三步：创建插件包装（`src/plugins/parser/`）

```typescript
// src/plugins/parser/xml-plugin.ts
import type { IFileParserPlugin } from '../types'
import { matchesAnyExtension } from '../types'
import { parseXml } from '@/plugins/parsers/xml-parser'
import XmlRenderer from '@/views/renderers/XmlRenderer.vue'

/** XML 解析插件，支持 .xml 格式 */
export const xmlPlugin: IFileParserPlugin = {
  name: 'xml',
  supportedExtensions: ['.xml'],
  canParse(file) {
    return matchesAnyExtension(file.name, this.supportedExtensions)
  },
  async parse(data: Uint8Array) {
    return parseXml(data)
  },
  getComponent() {
    return XmlRenderer
  },
}
```

### 第四步：注册插件（`src/plugins/manifest.ts`）

```typescript
import { xmlPlugin } from './parser/xml-plugin'

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  // ... 其他插件
  registry.registerParser(xmlPlugin)  // ← 新增这一行
}
```

完成！新格式已接入，上传 `.xml` 文件即可自动解析并渲染。

---

## 8. 共享领域类型

所有跨模块使用的领域类型集中在 `src/types/index.ts`：

| 类型 | 说明 |
|------|------|
| `FileEntry` | 压缩包内文件条目 |
| `DecompressResult` | 解压操作结果 |
| `ArchiveStatus` | 压缩包处理状态枚举 |
| `FileTreeNode` | 文件树节点（UI 展示） |
| `LogLine` | 单行日志数据 |
| `CsvData` | CSV 表格数据 |
| `ParsedContent` | 解析结果联合类型（text/csv/json/hex/log） |
| `ArchiveItem` | 归档项（含状态、进度、文件树） |
| `TabItem` | 标签页项 |
| `SearchMatch` | 搜索结果匹配项 |
| `SearchResults` | 搜索结果集合 |

---

## 9. 测试约定

- **测试框架**：Vitest + @vue/test-utils + jsdom
- **测试文件位置**：与被测文件同结构的 `src/__tests__/` 目录
- **路径别名**：测试中使用 `@/composables/...` 而非相对路径
- **适配器**：Vitest 配置中 `@adapter` 始终解析为 `web-adapter`（测试环境无 Tauri）
- **Composable 测试**：在 `beforeEach` 中调用 `reset()` 隔离模块级状态

```bash
# 运行所有测试
npm test

# 运行指定测试
npx vitest run src/__tests__/core/search.test.ts

# 监听模式（开发时实时反馈）
npm run test:watch
```

---

## 10. 开发流程建议

1. **新功能开发前**：先确认是否可以通过插件系统实现（新增文件类型 = 插件，新增压缩格式 = 压缩插件）
2. **修改共享类型时**：优先检查 `src/types/index.ts`，避免在组件内定义领域类型
3. **修改 UI 颜色/主题**：统一修改 `src/styles/theme.ts`，不要在组件中硬编码颜色值
4. **跨平台功能**：通过 `usePlatform()` 获取适配器，不要直接 import `@tauri-apps/api`
5. **提交前**：运行 `npm run typecheck` 确保类型正确，运行 `npm test` 确保测试通过
