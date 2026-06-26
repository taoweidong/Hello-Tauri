# 跨平台日志解析工具 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 构建一个基于 Vue 3 + Tauri 的跨平台日志解析工具，支持多压缩包上传、递归解压、文件预览、全局搜索，同时产出 Web 静态站和 Windows 单文件 EXE。

**架构：** 微内核 + 插件系统。前端 Vue 3 + TypeScript + Naive UI 负责 UI 和核心逻辑；Tauri Rust 后端仅做系统级文件操作（mmap 零拷贝、原生解压）。平台适配层通过编译期 alias 切换 WebAdapter / TauriAdapter。

**技术栈：** Vue 3, TypeScript, Vite, Naive UI, Pinia, Tauri, Rust, Vitest, Vue Test Utils, Playwright

**规格文档：** `docs/superpowers/specs/2026-06-26-system-architecture-design.md`

---

## 文件结构

### 前端 (`src/`)

| 文件 | 职责 |
|------|------|
| `src/adapters/types.ts` | IPlatformAdapter 接口 + 共享类型定义 |
| `src/adapters/web-adapter.ts` | Web 端适配器（WASM / fetch） |
| `src/adapters/tauri-adapter.ts` | Tauri 端适配器（IPC invoke） |
| `src/plugins/types.ts` | ICompressionPlugin + IFileParserPlugin 接口 |
| `src/plugins/registry.ts` | PluginRegistry 注册中心 |
| `src/plugins/manifest.ts` | 内置插件清单注册 |
| `src/plugins/compression/zip-plugin.ts` | ZIP 压缩插件 |
| `src/plugins/compression/gzip-plugin.ts` | Gzip 压缩插件 |
| `src/plugins/parser/text-plugin.ts` | 文本解析插件 + TextRenderer 组件 |
| `src/plugins/parser/csv-plugin.ts` | CSV 解析插件 + CsvRenderer 组件 |
| `src/plugins/parser/json-plugin.ts` | JSON 解析插件 + JsonRenderer 组件 |
| `src/plugins/parser/hex-plugin.ts` | 十六进制回退解析器 |
| `src/core/decompress.ts` | DecompressService 解压服务 |
| `src/core/parser-engine.ts` | ParserEngine 文件解析引擎 |
| `src/core/task-scheduler.ts` | TaskScheduler 并发控制调度器 |
| `src/core/file-tree.ts` | FileTreeNode 构建与操作 |
| `src/core/search.ts` | SearchService 搜索服务 |
| `src/composables/use-archives.ts` | 压缩包生命周期管理 |
| `src/composables/use-tabs.ts` | 标签页 CRUD |
| `src/composables/use-plugins.ts` | 插件引擎封装 |
| `src/composables/use-search.ts` | 全局搜索 |
| `src/composables/use-platform.ts` | 平台适配器单例 |
| `src/composables/use-vfs.ts` | 虚拟文件系统抽象 |
| `src/composables/use-panel-layout.ts` | 面板布局管理 |
| `src/composables/use-decompress.ts` | 解压管道（上传→解压→树构建→UI） |
| `src/components/layout/AppLayout.vue` | 四栏式主布局 |
| `src/components/public-bar/PublicBar.vue` | 顶部公共栏 |
| `src/components/public-bar/GlobalStats.vue` | 聚合统计 |
| `src/components/public-bar/GlobalSearch.vue` | 全局搜索框 |
| `src/components/archive-panel/ArchivePanel.vue` | 左侧面板容器 |
| `src/components/archive-panel/UploadZone.vue` | 拖拽上传区 |
| `src/components/archive-panel/ArchiveCard.vue` | 压缩包卡片 |
| `src/components/archive-panel/StatusIndicator.vue` | 状态可视化 |
| `src/components/archive-panel/FileTree.vue` | 文件树组件 |
| `src/components/workspace/Workspace.vue` | 中间工作区 |
| `src/components/workspace/TabBar.vue` | 标签栏 |
| `src/components/workspace/PreviewPane.vue` | 预览内容区 |
| `src/components/workspace/PreviewToolbar.vue` | 预览工具栏 |
| `src/components/workspace/StatusBar.vue` | 性能状态栏 |
| `src/components/workspace/SplitView.vue` | 分屏视图 |
| `src/components/property-panel/PropertyPanel.vue` | 右侧属性面板 |
| `src/components/property-panel/MetadataView.vue` | 上下文元数据 |
| `src/components/property-panel/ConfigForm.vue` | 插件配置表单 |
| `src/components/property-panel/PathBreadcrumb.vue` | 路径链路 |
| `src/components/shared/ErrorBoundary.vue` | 错误边界 |
| `src/stores/app.ts` | Pinia 全局状态 |
| `src/styles/theme.ts` | Naive UI 主题配置 |
| `src/App.vue` | 根组件 |
| `src/main.ts` | 入口 |
| `vite.config.ts` | Vite 配置（平台切换） |
| `vitest.config.ts` | Vitest 配置 |

### Rust 后端 (`src-tauri/`)

| 文件 | 职责 |
|------|------|
| `src-tauri/src/main.rs` | Tauri 入口，注册命令 |
| `src-tauri/src/commands.rs` | IPC 命令处理 |
| `src-tauri/src/file_ops.rs` | mmap 读取、目录遍历 |
| `src-tauri/src/decompress.rs` | 原生解压实现 |
| `src-tauri/src/error.rs` | 统一错误类型 |
| `src-tauri/Cargo.toml` | Rust 依赖 |
| `tauri.conf.json` | Tauri 配置 |

### 测试

| 文件 | 职责 |
|------|------|
| `src/__tests__/core/task-scheduler.test.ts` | TaskScheduler 单元测试 |
| `src/__tests__/core/file-tree.test.ts` | FileTreeNode 单元测试 |
| `src/__tests__/core/search.test.ts` | SearchService 单元测试 |
| `src/__tests__/plugins/registry.test.ts` | PluginRegistry 单元测试 |
| `src/__tests__/plugins/text-plugin.test.ts` | TextPlugin 单元测试 |
| `src/__tests__/plugins/csv-plugin.test.ts` | CsvPlugin 单元测试 |
| `src/__tests__/composables/use-tabs.test.ts` | useTabManager 单元测试 |
| `src/__tests__/composables/use-archives.test.ts` | useArchiveManager 单元测试 |
| `src/__tests__/components/shared/ErrorBoundary.test.ts` | ErrorBoundary 组件测试 |

---

## Phase 1：项目脚手架

### 任务 1：初始化 Vite + Vue 3 + TypeScript 项目

**文件：**
- 创建：`package.json`
- 创建：`vite.config.ts`
- 创建：`tsconfig.json`
- 创建：`tsconfig.node.json`
- 创建：`index.html`
- 创建：`src/main.ts`
- 创建：`src/App.vue`
- 创建：`src/vite-env.d.ts`
- 创建：`vitest.config.ts`

- [ ] **步骤 1：创建 package.json**

```json
{
  "name": "hello-tauri",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "vue-tsc --noEmit",
    "lint": "eslint src/"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "pinia": "^2.2.0",
    "naive-ui": "^2.44.0",
    "@vueuse/core": "^11.0.0",
    "vue-draggable-plus": "^0.5.0",
    "splitpanes": "^3.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "typescript": "~5.6.0",
    "vite": "^6.0.0",
    "vue-tsc": "^2.0.0",
    "vitest": "^2.0.0",
    "@vue/test-utils": "^2.4.0",
    "jsdom": "^25.0.0"
  }
}
```

- [ ] **步骤 2：安装依赖**

运行：`npm install`
预期：无错误，生成 `node_modules/` 和 `package-lock.json`

- [ ] **步骤 3：创建 vite.config.ts**

```ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

const platform = process.env.VITE_PLATFORM || 'web'

export default defineConfig({
  plugins: [vue()],
  define: {
    __PLATFORM__: JSON.stringify(platform)
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@adapter': platform === 'tauri'
        ? resolve(__dirname, 'src/adapters/tauri-adapter')
        : resolve(__dirname, 'src/adapters/web-adapter')
    }
  },
  build: {
    rollupOptions: {
      external: platform === 'web' ? [/@tauri-apps\/api/] : []
    }
  }
})
```

- [ ] **步骤 4：创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "jsx": "preserve",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    },
    "types": ["vite/client"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "src/**/*.d.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **步骤 5：创建 tsconfig.node.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **步骤 6：创建 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@adapter': resolve(__dirname, 'src/adapters/web-adapter')
    }
  }
})
```

- [ ] **步骤 7：创建 index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>日志解析工具</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **步骤 8：创建 src/vite-env.d.ts**

```ts
/// <reference types="vite/client" />

declare const __PLATFORM__: 'web' | 'tauri'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}
```

- [ ] **步骤 9：创建 src/App.vue**

```vue
<script setup lang="ts">
</script>

<template>
  <div>
    <h1>日志解析工具</h1>
    <p>平台：{{ __PLATFORM__ }}</p>
  </div>
</template>
```

- [ ] **步骤 10：创建 src/main.ts**

```ts
import { createApp } from 'vue'
import App from './App.vue'

const app = createApp(App)
app.mount('#app')
```

- [ ] **步骤 11：验证项目能启动**

运行：`npm run dev`
预期：浏览器显示 "日志解析工具" 和 "平台：web"，按 Ctrl+C 停止

- [ ] **步骤 12：验证类型检查通过**

运行：`npx vue-tsc --noEmit`
预期：无错误输出

- [ ] **步骤 13：验证测试框架工作**

创建临时测试 `src/__tests__/setup.test.ts`：

```ts
import { describe, it, expect } from 'vitest'

describe('setup', () => {
  it('vitest works', () => {
    expect(1 + 1).toBe(2)
  })
})
```

运行：`npm test`
预期：1 test passed

- [ ] **步骤 14：Commit**

```bash
git add -A
git commit -m "chore: initialize vite + vue3 + typescript project"
```

---

### 任务 2：安装并配置 Naive UI + 主题

**文件：**
- 修改：`src/main.ts`
- 创建：`src/styles/theme.ts`
- 创建：`src/App.vue`（重写）

- [ ] **步骤 1：创建 src/styles/theme.ts**

```ts
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

- [ ] **步骤 2：重写 src/App.vue**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme } from 'naive-ui'
import { themeOverrides } from './styles/theme'

const isDark = ref(true)
const theme = computed(() => isDark.value ? darkTheme : lightTheme)
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <div id="app-root">
          <h1>日志解析工具</h1>
          <p>平台：{{ __PLATFORM__ }}</p>
          <button @click="isDark = !isDark">
            {{ isDark ? '切换浅色' : '切换深色' }}
          </button>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
```

- [ ] **步骤 3：验证主题切换**

运行：`npm run dev`
预期：页面显示深色主题，点击按钮切换浅色/深色，无控制台错误

- [ ] **步骤 4：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 5：Commit**

```bash
git add -A
git commit -m "feat: configure naive-ui with dark/light theme toggle"
```

---

### 任务 3：初始化 Tauri 项目

**文件：**
- 创建：`src-tauri/Cargo.toml`
- 创建：`src-tauri/tauri.conf.json`
- 创建：`src-tauri/src/main.rs`
- 创建：`src-tauri/src/commands.rs`
- 创建：`src-tauri/src/error.rs`
- 修改：`package.json`（添加 tauri 脚本）

- [ ] **步骤 1：安装 Tauri CLI**

运行：`npm install -D @tauri-apps/cli@latest`
预期：安装成功

- [ ] **步骤 2：在 package.json 添加 Tauri 脚本**

在 `package.json` 的 `scripts` 中添加：

```json
"tauri": "tauri",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build"
```

- [ ] **步骤 3：创建 src-tauri/Cargo.toml**

```toml
[package]
name = "hello-tauri"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
tokio = { version = "1", features = ["full"] }
memmap2 = "0.9"
zip = "2"
flate2 = "1"
rayon = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "1"

[build-dependencies]
tauri-build = { version = "2", features = [] }
```

- [ ] **步骤 4：创建 src-tauri/build.rs**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **步骤 5：创建 src-tauri/tauri.conf.json**

```json
{
  "$schema": "https://raw.githubusercontent.com/nicegui/nicegui/main/tauri/schema.json",
  "productName": "日志解析工具",
  "version": "0.1.0",
  "identifier": "com.hellotauri.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "日志解析工具",
        "width": 1400,
        "height": 900,
        "minWidth": 800,
        "minHeight": 600
      }
    ]
  }
}
```

- [ ] **步骤 6：创建 src-tauri/src/error.rs**

```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Decompress error: {0}")]
    Decompress(String),
    #[error("Not found: {0}")]
    NotFound(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
```

- [ ] **步骤 7：创建 src-tauri/src/commands.rs**

```rust
use crate::error::AppError;

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, AppError> {
    tokio::fs::read(&path).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn get_temp_dir() -> Result<String, AppError> {
    let dir = std::env::temp_dir();
    Ok(dir.to_string_lossy().to_string())
}
```

- [ ] **步骤 8：创建 src-tauri/src/main.rs**

```rust
mod commands;
mod error;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::get_temp_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **步骤 9：验证 Rust 编译**

运行：`cd src-tauri && cargo check`（需要 Rust 工具链已安装）
预期：编译检查通过，无错误

- [ ] **步骤 10：Commit**

```bash
git add -A
git commit -m "feat: initialize tauri project with basic ipc commands"
```

---

### 任务 4：创建项目目录结构 + Pinia Store

**文件：**
- 创建：所有空目录的 `.gitkeep` 文件
- 创建：`src/stores/app.ts`
- 修改：`src/main.ts`

- [ ] **步骤 1：创建目录结构**

```bash
mkdir -p src/adapters src/plugins/compression src/plugins/parser
mkdir -p src/core src/composables src/stores
mkdir -p src/components/layout src/components/public-bar
mkdir -p src/components/archive-panel src/components/workspace
mkdir -p src/components/property-panel src/components/shared
mkdir -p src/__tests__/core src/__tests__/plugins src/__tests__/composables src/__tests__/components
```

- [ ] **步骤 2：创建 src/stores/app.ts**

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useAppStore = defineStore('app', () => {
  const isDarkTheme = ref(true)
  const disabledPlugins = ref<Set<string>>(new Set())
  const leftPanelWidth = ref(280)
  const rightPanelWidth = ref(300)

  function toggleTheme() {
    isDarkTheme.value = !isDarkTheme.value
  }

  function setLeftPanelWidth(w: number) {
    leftPanelWidth.value = Math.max(200, Math.min(400, w))
  }

  function setRightPanelWidth(w: number) {
    rightPanelWidth.value = Math.max(240, Math.min(500, w))
  }

  return {
    isDarkTheme,
    disabledPlugins,
    leftPanelWidth,
    rightPanelWidth,
    toggleTheme,
    setLeftPanelWidth,
    setRightPanelWidth,
  }
})
```

- [ ] **步骤 3：修改 src/main.ts 注册 Pinia**

```ts
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
```

- [ ] **步骤 4：编写 Pinia store 测试**

创建 `src/__tests__/stores/app.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAppStore } from '@/stores/app'

describe('useAppStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('toggles theme', () => {
    const store = useAppStore()
    expect(store.isDarkTheme).toBe(true)
    store.toggleTheme()
    expect(store.isDarkTheme).toBe(false)
  })

  it('clamps left panel width', () => {
    const store = useAppStore()
    store.setLeftPanelWidth(100)
    expect(store.leftPanelWidth).toBe(200)
    store.setLeftPanelWidth(500)
    expect(store.leftPanelWidth).toBe(400)
    store.setLeftPanelWidth(300)
    expect(store.leftPanelWidth).toBe(300)
  })
})
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npm test`
预期：所有测试通过

- [ ] **步骤 6：Commit**

```bash
git add -A
git commit -m "feat: create directory structure and pinia app store"
```

---

## Phase 2：类型系统 + 平台适配层

### 任务 5：定义核心类型 + IPlatformAdapter 接口

**文件：**
- 创建：`src/adapters/types.ts`

- [ ] **步骤 1：创建 src/adapters/types.ts**

```ts
export interface FileEntry {
  name: string
  path: string
  size: number
  isDirectory: boolean
  lastModified?: number
}

export interface DecompressResult {
  success: boolean
  files: FileEntry[]
  error?: string
}

export type ArchiveStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface ArchiveItem {
  id: string
  name: string
  file: File
  status: ArchiveStatus
  progress: number
  files: FileTreeNode[]
  error?: string
  startTime?: number
  endTime?: number
  originalSize: number
  compressedSize: number
}

export interface FileTreeNode {
  key: string
  label: string
  isLeaf: boolean
  path: string
  size?: number
  children?: FileTreeNode[]
}

export interface TabItem {
  id: string
  fileNode: FileTreeNode
  archiveId: string
  pinned: boolean
  content?: ParsedContent
}

export interface ParsedContent {
  type: 'text' | 'csv' | 'json' | 'hex'
  data: any
  lineCount?: number
  loadTimeMs?: number
  pluginName: string
}

export interface SearchMatch {
  archiveId: string
  filePath: string
  fileName: string
  lineNumber: number
  lineContent: string
  matchStart: number
  matchEnd: number
}

export interface SearchResults {
  keyword: string
  matches: SearchMatch[]
  searchTimeMs: number
}

export interface IPlatformAdapter {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  listFiles(dir: string): Promise<FileEntry[]>
  getTempDir(): Promise<string>
  decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult>
  mmapRead(path: string, offset: number, length: number): Promise<Uint8Array>
  streamRead(path: string): ReadableStream<Uint8Array>
}
```

- [ ] **步骤 2：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 3：Commit**

```bash
git add src/adapters/types.ts
git commit -m "feat: define core types and IPlatformAdapter interface"
```

---

### 任务 6：实现 WebAdapter + TauriAdapter + usePlatform

**文件：**
- 创建：`src/adapters/web-adapter.ts`
- 创建：`src/adapters/tauri-adapter.ts`
- 创建：`src/composables/use-platform.ts`

- [ ] **步骤 1：创建 src/adapters/web-adapter.ts**

```ts
import type { IPlatformAdapter, FileEntry, DecompressResult } from './types'

export class WebAdapter implements IPlatformAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const response = await fetch(path)
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    throw new Error('writeFile is not supported in Web mode')
  }

  async listFiles(_dir: string): Promise<FileEntry[]> {
    throw new Error('listFiles is not supported in Web mode')
  }

  async getTempDir(): Promise<string> {
    return '/tmp/web'
  }

  async decompress(_data: Uint8Array, _format: string, _outputDir: string): Promise<DecompressResult> {
    throw new Error('decompress is not supported in Web mode without WASM')
  }

  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const response = await fetch(path, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` }
    })
    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  }

  streamRead(path: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const response = await fetch(path)
        const reader = response.body?.getReader()
        if (!reader) { controller.close(); return }
        while (true) {
          const { done, value } = await reader.read()
          if (done) { controller.close(); break }
          controller.enqueue(value)
        }
      }
    })
  }
}

export default new WebAdapter()
```

- [ ] **步骤 2：创建 src/adapters/tauri-adapter.ts**

```ts
import type { IPlatformAdapter, FileEntry, DecompressResult } from './types'

let invoke: (cmd: string, args?: Record<string, unknown>) => Promise<any>

async function getInvoke() {
  if (!invoke) {
    const tauri = await import('@tauri-apps/api/core')
    invoke = tauri.invoke
  }
  return invoke
}

export class TauriAdapter implements IPlatformAdapter {
  async readFile(path: string): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('read_file', { path })
    return new Uint8Array(data)
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const fn = await getInvoke()
    await fn('write_file', { path, data: Array.from(data) })
  }

  async listFiles(dir: string): Promise<FileEntry[]> {
    const fn = await getInvoke()
    return fn('list_files', { dir })
  }

  async getTempDir(): Promise<string> {
    const fn = await getInvoke()
    return fn('get_temp_dir')
  }

  async decompress(data: Uint8Array, format: string, outputDir: string): Promise<DecompressResult> {
    const fn = await getInvoke()
    return fn('decompress', { data: Array.from(data), format, outputDir })
  }

  async mmapRead(path: string, offset: number, length: number): Promise<Uint8Array> {
    const fn = await getInvoke()
    const data = await fn('mmap_read', { path, offset, length })
    return new Uint8Array(data)
  }

  streamRead(path: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const fn = await getInvoke()
        const data: number[] = await fn('read_file', { path })
        controller.enqueue(new Uint8Array(data))
        controller.close()
      }
    })
  }
}

export default new TauriAdapter()
```

- [ ] **步骤 3：创建 src/composables/use-platform.ts**

```ts
import type { IPlatformAdapter } from '@/adapters/types'

let adapterInstance: IPlatformAdapter | null = null

function createAdapter(): IPlatformAdapter {
  if (adapterInstance) return adapterInstance
  if (__PLATFORM__ === 'tauri') {
    const { default: adapter } = await import('@/adapters/tauri-adapter')
    adapterInstance = adapter
  } else {
    const { default: adapter } = await import('@/adapters/web-adapter')
    adapterInstance = adapter
  }
  return adapterInstance!
}

let adapterPromise: Promise<IPlatformAdapter> | null = null

export function usePlatform() {
  if (!adapterPromise) {
    adapterPromise = (async () => createAdapter())()
  }

  return {
    getAdapter: () => adapterPromise!,
    isTauri: __PLATFORM__ === 'tauri',
    isWeb: __PLATFORM__ === 'web',
  }
}
```

等等，`createAdapter` 用了 `await` 在非 async 函数中。让我修正：

- [ ] **步骤 3（修正）：创建 src/composables/use-platform.ts**

```ts
import type { IPlatformAdapter } from '@/adapters/types'

let adapterPromise: Promise<IPlatformAdapter> | null = null

async function getAdapter(): Promise<IPlatformAdapter> {
  if (!adapterPromise) {
    if (__PLATFORM__ === 'tauri') {
      const mod = await import('@/adapters/tauri-adapter')
      adapterPromise = Promise.resolve(mod.default)
    } else {
      const mod = await import('@/adapters/web-adapter')
      adapterPromise = Promise.resolve(mod.default)
    }
  }
  return adapterPromise
}

export function usePlatform() {
  return {
    getAdapter,
    isTauri: __PLATFORM__ === 'tauri',
    isWeb: __PLATFORM__ === 'web',
  }
}
```

- [ ] **步骤 4：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 5：Commit**

```bash
git add src/adapters/web-adapter.ts src/adapters/tauri-adapter.ts src/composables/use-platform.ts
git commit -m "feat: implement WebAdapter, TauriAdapter, and usePlatform composable"
```

---

## Phase 3：插件系统

### 任务 7：定义插件接口 + PluginRegistry

**文件：**
- 创建：`src/plugins/types.ts`
- 创建：`src/plugins/registry.ts`
- 测试：`src/__tests__/plugins/registry.test.ts`

- [ ] **步骤 1：创建 src/plugins/types.ts**

```ts
import type { Component } from 'vue'
import type { DecompressResult, FileEntry } from '@/adapters/types'

export interface ConfigField {
  key: string
  label: string
  type: 'input' | 'select' | 'switch' | 'number'
  default: any
  options?: { label: string; value: any }[]
}

export interface ConfigSchema {
  fields: ConfigField[]
}

export interface ICompressionPlugin {
  name: string
  supportedExtensions: string[]
  canHandle(file: FileEntry): boolean
  decompress(data: Uint8Array, outputDir: string): Promise<DecompressResult>
}

export interface IFileParserPlugin {
  name: string
  supportedExtensions: string[]
  canParse(file: FileEntry): boolean
  parse(data: Uint8Array, options?: Record<string, any>): Promise<ParsedResult>
  getComponent(): Component
  getConfigSchema?(): ConfigSchema
}

export interface ParsedResult {
  type: 'text' | 'csv' | 'json' | 'hex'
  data: any
  lineCount?: number
}
```

- [ ] **步骤 2：编写 PluginRegistry 测试**

创建 `src/__tests__/plugins/registry.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { PluginRegistry } from '@/plugins/registry'
import type { IFileParserPlugin, ICompressionPlugin } from '@/plugins/types'
import type { FileEntry } from '@/adapters/types'
import { defineComponent } from 'vue'

const DummyComponent = defineComponent({ template: '<div>dummy</div>' })

function createMockParser(name: string, exts: string[]): IFileParserPlugin {
  return {
    name,
    supportedExtensions: exts,
    canParse: (file: FileEntry) => exts.some(e => file.name.endsWith(e)),
    parse: async () => ({ type: 'text', data: 'mock' }),
    getComponent: () => DummyComponent,
  }
}

function createMockCompression(name: string, exts: string[]): ICompressionPlugin {
  return {
    name,
    supportedExtensions: exts,
    canHandle: (file: FileEntry) => exts.some(e => file.name.endsWith(e)),
    decompress: async () => ({ success: true, files: [] }),
  }
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

  it('registers and retrieves parser plugin by extension', () => {
    const plugin = createMockParser('text', ['.txt', '.log'])
    registry.registerParser(plugin)
    expect(registry.getParser('.txt')).toBe(plugin)
    expect(registry.getParser('.log')).toBe(plugin)
    expect(registry.getParser('.xyz')).toBeNull()
  })

  it('registers and retrieves compression plugin by extension', () => {
    const plugin = createMockCompression('zip', ['.zip'])
    registry.registerCompression(plugin)
    expect(registry.getCompression('.zip')).toBe(plugin)
    expect(registry.getCompression('.rar')).toBeNull()
  })

  it('detects parser plugin for a file', () => {
    const plugin = createMockParser('csv', ['.csv'])
    registry.registerParser(plugin)
    const file: FileEntry = { name: 'data.csv', path: '/data.csv', size: 100, isDirectory: false }
    expect(registry.detect(file)).toBe(plugin)
  })

  it('returns null when no plugin matches', () => {
    const file: FileEntry = { name: 'file.bin', path: '/file.bin', size: 100, isDirectory: false }
    expect(registry.detect(file)).toBeNull()
  })

  it('enables and disables plugins', () => {
    const plugin = createMockParser('text', ['.txt'])
    registry.registerParser(plugin)
    registry.disable('text')
    expect(registry.getParser('.txt')).toBeNull()
    registry.enable('text')
    expect(registry.getParser('.txt')).toBe(plugin)
  })

  it('safeParse catches errors and returns fallback', async () => {
    const failingPlugin: IFileParserPlugin = {
      name: 'failing',
      supportedExtensions: ['.txt'],
      canParse: () => true,
      parse: async () => { throw new Error('parse failed') },
      getComponent: () => DummyComponent,
    }
    registry.registerParser(failingPlugin)
    const result = await registry.safeParse(failingPlugin, new Uint8Array(0))
    expect(result).not.toBeNull()
    expect(result!.type).toBe('hex')
  })
})
```

- [ ] **步骤 3：运行测试验证失败**

运行：`npx vitest run src/__tests__/plugins/registry.test.ts`
预期：FAIL，`Cannot find module '@/plugins/registry'`

- [ ] **步骤 4：实现 src/plugins/registry.ts**

```ts
import type { ICompressionPlugin, IFileParserPlugin, ParsedResult } from './types'
import type { FileEntry } from '@/adapters/types'

const PLUGIN_TIMEOUT_MS = 30000

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('Plugin timeout')), ms))
}

export class PluginRegistry {
  private compressionPlugins = new Map<string, ICompressionPlugin>()
  private parserPlugins = new Map<string, IFileParserPlugin>()
  private extToParser = new Map<string, string>()
  private extToCompression = new Map<string, string>()
  private disabled = new Set<string>()

  registerParser(plugin: IFileParserPlugin): void {
    this.parserPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToParser.set(ext, plugin.name)
    }
  }

  registerCompression(plugin: ICompressionPlugin): void {
    this.compressionPlugins.set(plugin.name, plugin)
    for (const ext of plugin.supportedExtensions) {
      this.extToCompression.set(ext, plugin.name)
    }
  }

  getParser(ext: string): IFileParserPlugin | null {
    const name = this.extToParser.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.parserPlugins.get(name) ?? null
  }

  getCompression(ext: string): ICompressionPlugin | null {
    const name = this.extToCompression.get(ext)
    if (!name || this.disabled.has(name)) return null
    return this.compressionPlugins.get(name) ?? null
  }

  detect(file: FileEntry): IFileParserPlugin | null {
    for (const [ext, name] of this.extToParser) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.parserPlugins.get(name) ?? null
      }
    }
    return null
  }

  detectCompression(file: FileEntry): ICompressionPlugin | null {
    for (const [ext, name] of this.extToCompression) {
      if (file.name.endsWith(ext) && !this.disabled.has(name)) {
        return this.compressionPlugins.get(name) ?? null
      }
    }
    return null
  }

  enable(name: string): void {
    this.disabled.delete(name)
  }

  disable(name: string): void {
    this.disabled.add(name)
  }

  async safeParse(plugin: IFileParserPlugin, data: Uint8Array, options?: Record<string, any>): Promise<ParsedResult | null> {
    try {
      return await Promise.race([
        plugin.parse(data, options),
        timeout(PLUGIN_TIMEOUT_MS),
      ])
    } catch {
      return { type: 'hex', data: data }
    }
  }

  async safeDecompress(plugin: ICompressionPlugin, data: Uint8Array, outputDir: string) {
    try {
      return await Promise.race([
        plugin.decompress(data, outputDir),
        timeout(PLUGIN_TIMEOUT_MS),
      ])
    } catch (err) {
      return {
        success: false,
        files: [],
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  }
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`npx vitest run src/__tests__/plugins/registry.test.ts`
预期：6 tests passed

- [ ] **步骤 6：Commit**

```bash
git add src/plugins/types.ts src/plugins/registry.ts src/__tests__/plugins/registry.test.ts
git commit -m "feat: implement PluginRegistry with safe execution and timeout"
```

---

### 任务 8：创建内置解析插件（Text / CSV / JSON / Hex）

**文件：**
- 创建：`src/plugins/parser/text-plugin.ts`
- 创建：`src/plugins/parser/csv-plugin.ts`
- 创建：`src/plugins/parser/json-plugin.ts`
- 创建：`src/plugins/parser/hex-plugin.ts`
- 测试：`src/__tests__/plugins/text-plugin.test.ts`
- 测试：`src/__tests__/plugins/csv-plugin.test.ts`

- [ ] **步骤 1：编写 TextPlugin 测试**

创建 `src/__tests__/plugins/text-plugin.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { textPlugin } from '@/plugins/parser/text-plugin'
import type { FileEntry } from '@/adapters/types'

describe('textPlugin', () => {
  const file: FileEntry = { name: 'app.log', path: '/app.log', size: 100, isDirectory: false }

  it('canParse returns true for .txt/.log files', () => {
    expect(textPlugin.canParse(file)).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'data.txt' })).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'image.png' })).toBe(false)
  })

  it('parse returns text content with line count', async () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('parse handles empty file', async () => {
    const data = new Uint8Array(0)
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/plugins/text-plugin.test.ts`
预期：FAIL

- [ ] **步骤 3：创建 src/plugins/parser/text-plugin.ts**

```ts
import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'

const TextRenderer = defineComponent({
  name: 'TextRenderer',
  props: {
    content: { type: String, required: true },
    showLineNumbers: { type: Boolean, default: true },
    wrap: { type: Boolean, default: false },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const lines = props.content.split('\n')
      return h('div', {
        style: {
          fontFamily: '"JetBrains Mono", "Fira Code", monospace',
          fontSize: `${props.fontSize}px`,
          whiteSpace: props.wrap ? 'pre-wrap' : 'pre',
          overflow: 'auto',
          height: '100%',
          padding: '8px',
        }
      }, lines.map((line, i) =>
        h('div', { key: i, style: { display: 'flex' } }, [
          props.showLineNumbers
            ? h('span', {
                style: {
                  color: '#666',
                  minWidth: '3em',
                  textAlign: 'right',
                  paddingRight: '1em',
                  userSelect: 'none',
                }
              }, String(i + 1))
            : null,
          h('span', line),
        ])
      ))
    }
  }
})

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.log', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    const lineCount = text.length === 0 ? 0 : text.split('\n').length
    return { type: 'text' as const, data: text, lineCount }
  },
  getComponent() {
    return TextRenderer
  },
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/plugins/text-plugin.test.ts`
预期：3 tests passed

- [ ] **步骤 5：创建 src/plugins/parser/csv-plugin.ts**

```ts
import { defineComponent, h } from 'vue'
import type { IFileParserPlugin, ConfigSchema } from '../types'

const CsvRenderer = defineComponent({
  name: 'CsvRenderer',
  props: {
    content: { type: Object, required: true },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const { headers, rows } = props.content as { headers: string[]; rows: string[][] }
      return h('div', { style: { overflow: 'auto', height: '100%' } }, [
        h('table', {
          style: {
            borderCollapse: 'collapse',
            width: '100%',
            fontSize: `${props.fontSize}px`,
            fontFamily: '"JetBrains Mono", monospace',
          }
        }, [
          h('thead', h('tr', headers.map((header, i) =>
            h('th', {
              key: i,
              style: {
                border: '1px solid #333',
                padding: '4px 8px',
                position: 'sticky',
                top: 0,
                background: '#1a1a2e',
              }
            }, header)
          ))),
          h('tbody', rows.map((row, ri) =>
            h('tr', { key: ri }, row.map((cell, ci) =>
              h('td', {
                key: ci,
                style: { border: '1px solid #333', padding: '4px 8px' }
              }, cell)
            ))
          )),
        ])
      ])
    }
  }
})

function parseCsv(text: string, delimiter: string): { headers: string[]; rows: string[][] } {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) return { headers: [], rows: [] }
  const headers = lines[0].split(delimiter).map(s => s.trim())
  const rows = lines.slice(1).map(line => line.split(delimiter).map(s => s.trim()))
  return { headers, rows }
}

export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: ['.csv', '.tsv'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const text = new TextDecoder('utf-8').decode(data)
    const delimiter = options?.delimiter ?? ','
    const parsed = parseCsv(text, delimiter)
    return {
      type: 'csv' as const,
      data: parsed,
      lineCount: parsed.rows.length + 1,
    }
  },
  getComponent() {
    return CsvRenderer
  },
  getConfigSchema(): ConfigSchema {
    return {
      fields: [
        { key: 'delimiter', label: '分隔符', type: 'input', default: ',' },
        { key: 'fixedHeader', label: '固定表头', type: 'switch', default: true },
      ]
    }
  },
}
```

- [ ] **步骤 6：创建 src/plugins/parser/json-plugin.ts**

```ts
import { defineComponent, h, pre } from 'vue'
import type { IFileParserPlugin } from '../types'

const JsonRenderer = defineComponent({
  name: 'JsonRenderer',
  props: {
    content: { required: true },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const formatted = typeof props.content === 'string'
        ? props.content
        : JSON.stringify(props.content, null, 2)
      return h('pre', {
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: `${props.fontSize}px`,
          padding: '8px',
          overflow: 'auto',
          height: '100%',
          margin: 0,
          whiteSpace: 'pre-wrap',
        }
      }, formatted)
    }
  }
})

export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: ['.json', '.jsonl'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    const parsed = JSON.parse(text)
    const formatted = JSON.stringify(parsed, null, 2)
    return {
      type: 'json' as const,
      data: parsed,
      lineCount: formatted.split('\n').length,
    }
  },
  getComponent() {
    return JsonRenderer
  },
}
```

- [ ] **步骤 7：创建 src/plugins/parser/hex-plugin.ts**

```ts
import { defineComponent, h } from 'vue'
import type { IFileParserPlugin } from '../types'

const HexRenderer = defineComponent({
  name: 'HexRenderer',
  props: {
    content: { required: true },
    fontSize: { type: Number, default: 14 },
  },
  setup(props) {
    return () => {
      const data = props.content as Uint8Array
      const lines: string[] = []
      const bytesPerLine = 16
      for (let i = 0; i < data.length; i += bytesPerLine) {
        const slice = data.slice(i, i + bytesPerLine)
        const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ')
        const ascii = Array.from(slice).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('')
        const offset = i.toString(16).padStart(8, '0')
        lines.push(`${offset}  ${hex.padEnd(47)}  ${ascii}`)
      }
      return h('pre', {
        style: {
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: `${props.fontSize}px`,
          padding: '8px',
          overflow: 'auto',
          height: '100%',
          margin: 0,
        }
      }, lines.join('\n'))
    }
  }
})

export const hexPlugin: IFileParserPlugin = {
  name: 'hex',
  supportedExtensions: [],
  canParse() {
    return true
  },
  async parse(data: Uint8Array) {
    return {
      type: 'hex' as const,
      data: data,
      lineCount: Math.ceil(data.length / 16),
    }
  },
  getComponent() {
    return HexRenderer
  },
}
```

- [ ] **步骤 8：编写 CsvPlugin 测试**

创建 `src/__tests__/plugins/csv-plugin.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { csvPlugin } from '@/plugins/parser/csv-plugin'

describe('csvPlugin', () => {
  it('canParse returns true for .csv files', () => {
    expect(csvPlugin.canParse({ name: 'data.csv', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(csvPlugin.canParse({ name: 'data.tsv', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(csvPlugin.canParse({ name: 'data.txt', path: '/', size: 0, isDirectory: false })).toBe(false)
  })

  it('parse returns headers and rows', async () => {
    const data = new TextEncoder().encode('name,age\nAlice,30\nBob,25')
    const result = await csvPlugin.parse(data)
    expect(result.type).toBe('csv')
    expect(result.data.headers).toEqual(['name', 'age'])
    expect(result.data.rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(result.lineCount).toBe(3)
  })

  it('parse respects custom delimiter', async () => {
    const data = new TextEncoder().encode('name\tage\nAlice\t30')
    const result = await csvPlugin.parse(data, { delimiter: '\t' })
    expect(result.data.headers).toEqual(['name', 'age'])
  })

  it('parse handles empty file', async () => {
    const data = new Uint8Array(0)
    const result = await csvPlugin.parse(data)
    expect(result.data.headers).toEqual([])
    expect(result.data.rows).toEqual([])
  })
})
```

- [ ] **步骤 9：运行所有插件测试**

运行：`npx vitest run src/__tests__/plugins/`
预期：所有测试通过（7+ tests）

- [ ] **步骤 10：Commit**

```bash
git add src/plugins/parser/ src/__tests__/plugins/
git commit -m "feat: add built-in parser plugins (text, csv, json, hex)"
```

---

### 任务 9：创建内置压缩插件 + 插件清单

**文件：**
- 创建：`src/plugins/compression/zip-plugin.ts`
- 创建：`src/plugins/compression/gzip-plugin.ts`
- 创建：`src/plugins/manifest.ts`

- [ ] **步骤 1：创建 src/plugins/compression/zip-plugin.ts**

```ts
import type { ICompressionPlugin } from '../types'
import type { FileEntry } from '@/adapters/types'

export const zipPlugin: ICompressionPlugin = {
  name: 'zip',
  supportedExtensions: ['.zip'],
  canHandle(file: FileEntry): boolean {
    return file.name.endsWith('.zip')
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'zip', _outputDir)
    }
    return { success: false, files: [], error: 'ZIP decompression requires Tauri backend or WASM module' }
  },
}
```

- [ ] **步骤 2：创建 src/plugins/compression/gzip-plugin.ts**

```ts
import type { ICompressionPlugin } from '../types'
import type { FileEntry } from '@/adapters/types'

export const gzipPlugin: ICompressionPlugin = {
  name: 'gzip',
  supportedExtensions: ['.gz', '.gzip', '.tgz'],
  canHandle(file: FileEntry): boolean {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async decompress(data: Uint8Array, _outputDir: string) {
    if (__PLATFORM__ === 'tauri') {
      const { usePlatform } = await import('@/composables/use-platform')
      const { getAdapter } = usePlatform()
      const adapter = await getAdapter()
      return adapter.decompress(data, 'gzip', _outputDir)
    }
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip')
      const writer = ds.writable.getWriter()
      const reader = ds.readable.getReader()
      writer.write(data)
      writer.close()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0)
      const result = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      return {
        success: true,
        files: [{ name: 'decompressed', path: '/decompressed', size: result.length, isDirectory: false }],
      }
    }
    return { success: false, files: [], error: 'Gzip decompression not available' }
  },
}
```

- [ ] **步骤 3：创建 src/plugins/manifest.ts**

```ts
import type { PluginRegistry } from './registry'
import { zipPlugin } from './compression/zip-plugin'
import { gzipPlugin } from './compression/gzip-plugin'
import { textPlugin } from './parser/text-plugin'
import { csvPlugin } from './parser/csv-plugin'
import { jsonPlugin } from './parser/json-plugin'
import { hexPlugin } from './parser/hex-plugin'

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  registry.registerCompression(zipPlugin)
  registry.registerCompression(gzipPlugin)

  registry.registerParser(textPlugin)
  registry.registerParser(csvPlugin)
  registry.registerParser(jsonPlugin)
  registry.registerParser(hexPlugin)
}
```

- [ ] **步骤 4：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 5：Commit**

```bash
git add src/plugins/compression/ src/plugins/manifest.ts
git commit -m "feat: add zip/gzip compression plugins and plugin manifest"
```

---

## Phase 4：核心服务

### 任务 10：FileTreeNode 构建

**文件：**
- 创建：`src/core/file-tree.ts`
- 测试：`src/__tests__/core/file-tree.test.ts`

- [ ] **步骤 1：编写测试**

创建 `src/__tests__/core/file-tree.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { buildFileTree, flattenTree, findNode } from '@/core/file-tree'
import type { FileEntry } from '@/adapters/types'

describe('buildFileTree', () => {
  it('builds tree from flat file list', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    expect(tree).toHaveLength(1)
    expect(tree[0].key).toBe('root')
    expect(tree[0].children).toHaveLength(2)
  })

  it('handles empty file list', () => {
    expect(buildFileTree([], 'root')).toEqual([])
  })
})

describe('findNode', () => {
  it('finds node by key', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    const node = findNode(tree, 'root/a.txt')
    expect(node).not.toBeNull()
    expect(node!.label).toBe('a.txt')
  })

  it('returns null for missing key', () => {
    expect(findNode([], 'missing')).toBeNull()
  })
})

describe('flattenTree', () => {
  it('flattens tree to array of leaf nodes', () => {
    const files: FileEntry[] = [
      { name: 'root', path: 'root', size: 0, isDirectory: true },
      { name: 'a.txt', path: 'root/a.txt', size: 100, isDirectory: false },
      { name: 'sub', path: 'root/sub', size: 0, isDirectory: true },
      { name: 'b.log', path: 'root/sub/b.log', size: 200, isDirectory: false },
    ]
    const tree = buildFileTree(files, 'root')
    const leaves = flattenTree(tree).filter(n => n.isLeaf)
    expect(leaves).toHaveLength(2)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/file-tree.test.ts`
预期：FAIL

- [ ] **步骤 3：创建 src/core/file-tree.ts**

```ts
import type { FileTreeNode } from '@/adapters/types'
import type { FileEntry } from '@/adapters/types'

export function buildFileTree(files: FileEntry[], rootPath: string): FileTreeNode[] {
  if (files.length === 0) return []

  const nodeMap = new Map<string, FileTreeNode>()
  const placed = new Set<string>()

  for (const file of files) {
    const node: FileTreeNode = {
      key: file.path,
      label: file.name,
      isLeaf: !file.isDirectory,
      path: file.path,
      size: file.size,
      children: file.isDirectory ? [] : undefined,
    }
    nodeMap.set(file.path, node)
  }

  const rootNodes: FileTreeNode[] = []

  for (const file of files) {
    const node = nodeMap.get(file.path)!
    if (placed.has(file.path)) continue

    const parentPath = file.path === rootPath
      ? ''
      : file.path.substring(0, file.path.lastIndexOf('/'))

    if (parentPath && nodeMap.has(parentPath)) {
      nodeMap.get(parentPath)!.children!.push(node)
    } else {
      rootNodes.push(node)
    }
    placed.add(file.path)
  }

  return rootNodes
}

export function findNode(nodes: FileTreeNode[], key: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.children) {
      const found = findNode(node.children, key)
      if (found) return found
    }
  }
  return null
}

export function flattenTree(nodes: FileTreeNode[]): FileTreeNode[] {
  const result: FileTreeNode[] = []
  function walk(nodeList: FileTreeNode[]) {
    for (const node of nodeList) {
      result.push(node)
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/file-tree.test.ts`
预期：5 tests passed

- [ ] **步骤 5：Commit**

```bash
git add src/core/file-tree.ts src/__tests__/core/file-tree.test.ts
git commit -m "feat: implement FileTreeNode build, find, and flatten"
```

---

### 任务 11：TaskScheduler 并发控制

**文件：**
- 创建：`src/core/task-scheduler.ts`
- 测试：`src/__tests__/core/task-scheduler.test.ts`

- [ ] **步骤 1：编写测试**

创建 `src/__tests__/core/task-scheduler.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { TaskScheduler } from '@/core/task-scheduler'

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('TaskScheduler', () => {
  it('executes tasks with concurrency limit', async () => {
    const scheduler = new TaskScheduler(2)
    let running = 0
    let maxRunning = 0

    const task = async () => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await delay(50)
      running--
    }

    await Promise.all([
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
      scheduler.enqueue(task),
    ])

    expect(maxRunning).toBeLessThanOrEqual(2)
  })

  it('supports retry', async () => {
    const scheduler = new TaskScheduler(1)
    let attempts = 0

    const failingTask = async () => {
      attempts++
      if (attempts < 2) throw new Error('fail')
    }

    const id = scheduler.enqueue(failingTask)
    await expect(scheduler.getPromise(id!)).rejects.toThrow('fail')

    const retryId = scheduler.retry(id!)
    await expect(scheduler.getPromise(retryId!)).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('returns null when max concurrency reached and queue full', () => {
    const scheduler = new TaskScheduler(1, 1)
    const slowTask = () => delay(1000)
    scheduler.enqueue(slowTask)
    scheduler.enqueue(slowTask)
    const third = scheduler.enqueue(slowTask)
    expect(third).toBeNull()
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/task-scheduler.test.ts`
预期：FAIL

- [ ] **步骤 3：创建 src/core/task-scheduler.ts**

```ts
type TaskFn = () => Promise<any>

interface QueuedTask {
  id: string
  fn: TaskFn
  resolve: (value: any) => void
  reject: (reason: any) => void
  promise: Promise<any>
}

let nextId = 0

export class TaskScheduler {
  private maxConcurrency: number
  private maxQueueSize: number
  private running = 0
  private queue: QueuedTask[] = []
  private promises = new Map<string, Promise<any>>()
  private taskFns = new Map<string, TaskFn>()

  constructor(maxConcurrency = 3, maxQueueSize = 100) {
    this.maxConcurrency = maxConcurrency
    this.maxQueueSize = maxQueueSize
  }

  enqueue(fn: TaskFn): string | null {
    if (this.queue.length >= this.maxQueueSize) return null

    const id = `task_${nextId++}`
    let resolve!: (value: any) => void
    let reject!: (reason: any) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })

    const task: QueuedTask = { id, fn, resolve, reject, promise }
    this.queue.push(task)
    this.promises.set(id, promise)
    this.taskFns.set(id, fn)
    this.processNext()
    return id
  }

  getPromise(id: string): Promise<any> | undefined {
    return this.promises.get(id)
  }

  retry(id: string): string | null {
    const fn = this.taskFns.get(id)
    if (!fn) return null
    this.promises.delete(id)
    this.taskFns.delete(id)
    return this.enqueue(fn)
  }

  private processNext() {
    while (this.running < this.maxConcurrency && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.running++
      task.fn()
        .then(result => {
          task.resolve(result)
          this.promises.delete(task.id)
          this.taskFns.delete(task.id)
        })
        .catch(err => {
          task.reject(err)
        })
        .finally(() => {
          this.running--
          this.processNext()
        })
    }
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/task-scheduler.test.ts`
预期：3 tests passed

- [ ] **步骤 5：Commit**

```bash
git add src/core/task-scheduler.ts src/__tests__/core/task-scheduler.test.ts
git commit -m "feat: implement TaskScheduler with concurrency control"
```

---

### 任务 12：SearchService + DecompressService + ParserEngine

**文件：**
- 创建：`src/core/search.ts`
- 创建：`src/core/decompress.ts`
- 创建：`src/core/parser-engine.ts`

- [ ] **步骤 1：创建 src/core/search.ts**

```ts
import type { SearchMatch, SearchResults } from '@/adapters/types'

export class SearchService {
  searchInText(text: string, keyword: string, filePath: string, archiveId: string): SearchMatch[] {
    if (!keyword) return []
    const matches: SearchMatch[] = []
    const lines = text.split('\n')
    const lowerKeyword = keyword.toLowerCase()

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lowerLine = line.toLowerCase()
      let pos = 0
      while ((pos = lowerLine.indexOf(lowerKeyword, pos)) !== -1) {
        matches.push({
          archiveId,
          filePath,
          fileName: filePath.split('/').pop() ?? filePath,
          lineNumber: i + 1,
          lineContent: line,
          matchStart: pos,
          matchEnd: pos + keyword.length,
        })
        pos += keyword.length
      }
    }
    return matches
  }

  async searchAll(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ): Promise<SearchResults> {
    const start = performance.now()
    const allMatches: SearchMatch[] = []

    for (const file of files) {
      const matches = this.searchInText(file.content, keyword, file.filePath, file.archiveId)
      allMatches.push(...matches)
    }

    return {
      keyword,
      matches: allMatches,
      searchTimeMs: performance.now() - start,
    }
  }
}
```

- [ ] **步骤 2：编写 SearchService 测试**

创建 `src/__tests__/core/search.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { SearchService } from '@/core/search'

describe('SearchService', () => {
  const svc = new SearchService()

  it('finds all occurrences in text', () => {
    const text = 'hello world\nhello again\nbye'
    const matches = svc.searchInText(text, 'hello', '/test.txt', 'a1')
    expect(matches).toHaveLength(2)
    expect(matches[0].lineNumber).toBe(1)
    expect(matches[1].lineNumber).toBe(2)
  })

  it('is case insensitive', () => {
    const text = 'Hello HELLO hello'
    const matches = svc.searchInText(text, 'hello', '/test.txt', 'a1')
    expect(matches).toHaveLength(3)
  })

  it('returns empty for no keyword', () => {
    expect(svc.searchInText('hello', '', '/test.txt', 'a1')).toEqual([])
  })

  it('searchAll aggregates results from multiple files', async () => {
    const files = [
      { archiveId: 'a1', filePath: '/a.txt', content: 'hello world' },
      { archiveId: 'a1', filePath: '/b.txt', content: 'hello again' },
    ]
    const results = await svc.searchAll(files, 'hello')
    expect(results.matches).toHaveLength(2)
    expect(results.keyword).toBe('hello')
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/search.test.ts`
预期：4 tests passed

- [ ] **步骤 4：创建 src/core/decompress.ts**

```ts
import type { IPlatformAdapter, ArchiveItem, DecompressResult } from '@/adapters/types'
import type { PluginRegistry } from '@/plugins/registry'
import type { FileEntry } from '@/adapters/types'

export class DecompressService {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  async decompress(data: Uint8Array, fileName: string, outputDir: string): Promise<DecompressResult> {
    const fileEntry: FileEntry = {
      name: fileName,
      path: fileName,
      size: data.length,
      isDirectory: false,
    }

    const plugin = this.registry.detectCompression(fileEntry)
    if (!plugin) {
      return { success: false, files: [], error: `No compression plugin for: ${fileName}` }
    }

    return this.registry.safeDecompress(plugin, data, outputDir)
  }
}
```

- [ ] **步骤 5：创建 src/core/parser-engine.ts**

```ts
import type { IPlatformAdapter, ParsedContent, FileTreeNode } from '@/adapters/types'
import type { PluginRegistry } from '@/plugins/registry'

export class ParserEngine {
  constructor(
    private adapter: IPlatformAdapter,
    private registry: PluginRegistry
  ) {}

  async resolveFile(node: FileTreeNode, archivePath: string): Promise<ParsedContent | null> {
    const start = performance.now()

    try {
      const data = await this.adapter.readFile(archivePath + '/' + node.path)
      const ext = '.' + node.label.split('.').pop()
      const plugin = this.registry.getParser(ext) ?? this.registry.getParser('')
      if (!plugin) return null

      const result = await this.registry.safeParse(plugin, data)
      if (!result) return null

      return {
        type: result.type,
        data: result.data,
        lineCount: result.lineCount,
        loadTimeMs: performance.now() - start,
        pluginName: plugin.name,
      }
    } catch {
      return null
    }
  }
}
```

- [ ] **步骤 6：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 7：运行所有测试**

运行：`npm test`
预期：所有测试通过

- [ ] **步骤 8：Commit**

```bash
git add src/core/search.ts src/core/decompress.ts src/core/parser-engine.ts src/__tests__/core/search.test.ts
git commit -m "feat: implement SearchService, DecompressService, ParserEngine"
```

---

## Phase 5：Composables

### 任务 13：useArchiveManager + useTabManager

**文件：**
- 创建：`src/composables/use-archives.ts`
- 创建：`src/composables/use-tabs.ts`
- 测试：`src/__tests__/composables/use-archives.test.ts`
- 测试：`src/__tests__/composables/use-tabs.test.ts`

- [ ] **步骤 1：编写 useArchiveManager 测试**

创建 `src/__tests__/composables/use-archives.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { useArchiveManager } from '@/composables/use-archives'

describe('useArchiveManager', () => {
  it('adds files and creates archive items', () => {
    const { archives, addFiles } = useArchiveManager()
    const files = [
      new File(['test'], 'test.zip', { type: 'application/zip' }),
    ]
    addFiles(files)
    expect(archives.value).toHaveLength(1)
    expect(archives.value[0].name).toBe('test.zip')
    expect(archives.value[0].status).toBe('pending')
  })

  it('removes archive by id', () => {
    const { archives, addFiles, remove } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    remove(id)
    expect(archives.value).toHaveLength(0)
  })

  it('computes aggregate stats', () => {
    const { archives, addFiles, stats } = useArchiveManager()
    addFiles([
      new File(['abc'], 'a.zip'),
      new File(['defgh'], 'b.zip'),
    ])
    expect(stats.value.totalCount).toBe(2)
    expect(stats.value.totalCompressedSize).toBe(8)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/composables/use-archives.test.ts`
预期：FAIL

- [ ] **步骤 3：创建 src/composables/use-archives.ts**

```ts
import { ref, computed } from 'vue'
import type { ArchiveItem } from '@/adapters/types'

const archives = ref<ArchiveItem[]>([])

let nextArchiveId = 0

export function useArchiveManager() {
  function addFiles(files: File[]) {
    for (const file of files) {
      archives.value.push({
        id: `archive_${nextArchiveId++}`,
        name: file.name,
        file,
        status: 'pending',
        progress: 0,
        files: [],
        originalSize: 0,
        compressedSize: file.size,
      })
    }
  }

  function remove(id: string) {
    archives.value = archives.value.filter(a => a.id !== id)
  }

  function updateStatus(id: string, status: ArchiveItem['status'], progress?: number) {
    const archive = archives.value.find(a => a.id === id)
    if (archive) {
      archive.status = status
      if (progress !== undefined) archive.progress = progress
      if (status === 'running' && !archive.startTime) archive.startTime = Date.now()
      if (status === 'completed') archive.endTime = Date.now()
    }
  }

  const stats = computed(() => ({
    totalCount: archives.value.length,
    totalCompressedSize: archives.value.reduce((sum, a) => sum + a.compressedSize, 0),
    totalOriginalSize: archives.value.reduce((sum, a) => sum + a.originalSize, 0),
    totalFiles: archives.value.reduce((sum, a) => sum + a.files.length, 0),
    decompressedCount: archives.value.filter(a => a.status === 'completed').length,
  }))

  return { archives, addFiles, remove, updateStatus, stats }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/composables/use-archives.test.ts`
预期：3 tests passed

- [ ] **步骤 5：编写 useTabManager 测试**

创建 `src/__tests__/composables/use-tabs.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/adapters/types'

function mockNode(name: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: `/${name}` }
}

describe('useTabManager', () => {
  it('opens a new tab', () => {
    const { tabs, activeTab, openTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    expect(tabs.value).toHaveLength(1)
    expect(activeTab.value?.fileNode.label).toBe('a.txt')
  })

  it('activates existing tab instead of opening duplicate', () => {
    const { tabs, openTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('a.txt'), 'archive1')
    expect(tabs.value).toHaveLength(1)
  })

  it('closes a tab', () => {
    const { tabs, openTab, closeTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    const id = tabs.value[0].id
    closeTab(id)
    expect(tabs.value).toHaveLength(0)
  })

  it('activates next tab when closing active tab', () => {
    const { tabs, activeTab, openTab, closeTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('b.txt'), 'archive1')
    const firstId = tabs.value[0].id
    openTab(mockNode('a.txt'), 'archive1')
    closeTab(tabs.value.find(t => t.fileNode.label === 'a.txt')!.id)
    expect(activeTab.value?.fileNode.label).toBe('b.txt')
  })

  it('toggles pin', () => {
    const { tabs, openTab, togglePin } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    const id = tabs.value[0].id
    togglePin(id)
    expect(tabs.value[0].pinned).toBe(true)
    togglePin(id)
    expect(tabs.value[0].pinned).toBe(false)
  })
})
```

- [ ] **步骤 6：运行测试验证失败**

运行：`npx vitest run src/__tests__/composables/use-tabs.test.ts`
预期：FAIL

- [ ] **步骤 7：创建 src/composables/use-tabs.ts**

```ts
import { ref, computed } from 'vue'
import type { TabItem, FileTreeNode } from '@/adapters/types'

const tabs = ref<TabItem[]>([])
const activeTabId = ref<string | null>(null)

let nextTabId = 0

export function useTabManager() {
  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value) ?? null
  )

  function openTab(node: FileTreeNode, archiveId: string) {
    const existing = tabs.value.find(
      t => t.fileNode.key === node.key && t.archiveId === archiveId
    )
    if (existing) {
      activeTabId.value = existing.id
      return
    }

    const tab: TabItem = {
      id: `tab_${nextTabId++}`,
      fileNode: node,
      archiveId,
      pinned: false,
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
  }

  function closeTab(id: string) {
    const index = tabs.value.findIndex(t => t.id === id)
    if (index === -1) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id ?? null
    }
  }

  function activateTab(id: string) {
    activeTabId.value = id
  }

  function togglePin(id: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.pinned = !tab.pinned
  }

  function closeAll() {
    tabs.value = tabs.value.filter(t => t.pinned)
    activeTabId.value = tabs.value[0]?.id ?? null
  }

  return { tabs, activeTab, activeTabId, openTab, closeTab, activateTab, togglePin, closeAll }
}
```

- [ ] **步骤 8：运行测试验证通过**

运行：`npx vitest run src/__tests__/composables/use-tabs.test.ts`
预期：5 tests passed

- [ ] **步骤 9：Commit**

```bash
git add src/composables/use-archives.ts src/composables/use-tabs.ts src/__tests__/composables/
git commit -m "feat: implement useArchiveManager and useTabManager composables"
```

---

### 任务 14：useSearch + usePluginEngine + useVfs + usePanelLayout

**文件：**
- 创建：`src/composables/use-search.ts`
- 创建：`src/composables/use-plugins.ts`
- 创建：`src/composables/use-vfs.ts`
- 创建：`src/composables/use-panel-layout.ts`

- [ ] **步骤 1：创建 src/composables/use-plugins.ts**

```ts
import { shallowRef } from 'vue'
import { PluginRegistry } from '@/plugins/registry'
import { registerBuiltinPlugins } from '@/plugins/manifest'

const registry = new PluginRegistry()
registerBuiltinPlugins(registry)

export function usePluginEngine() {
  return {
    registry,
    detect: (file: any) => registry.detect(file),
    getParser: (ext: string) => registry.getParser(ext),
    getCompression: (ext: string) => registry.getCompression(ext),
    enable: (name: string) => registry.enable(name),
    disable: (name: string) => registry.disable(name),
  }
}
```

- [ ] **步骤 2：创建 src/composables/use-search.ts**

```ts
import { ref } from 'vue'
import { SearchService } from '@/core/search'
import type { SearchResults } from '@/adapters/types'

const searchService = new SearchService()
const results = ref<SearchResults | null>(null)
const searching = ref(false)

export function useSearch() {
  async function search(
    files: { archiveId: string; filePath: string; content: string }[],
    keyword: string
  ) {
    searching.value = true
    try {
      results.value = await searchService.searchAll(files, keyword)
    } finally {
      searching.value = false
    }
  }

  function clear() {
    results.value = null
  }

  return { results, searching, search, clear }
}
```

- [ ] **步骤 3：创建 src/composables/use-vfs.ts**

```ts
import { usePlatform } from './use-platform'
import type { FileTreeNode } from '@/adapters/types'

export function useVirtualFileSystem() {
  const { getAdapter } = usePlatform()

  async function readFile(path: string): Promise<Uint8Array> {
    const adapter = await getAdapter()
    return adapter.readFile(path)
  }

  async function listDir(dir: string) {
    const adapter = await getAdapter()
    return adapter.listFiles(dir)
  }

  return { readFile, listDir }
}
```

- [ ] **步骤 4：创建 src/composables/use-panel-layout.ts**

```ts
import { ref, computed } from 'vue'
import { useBreakpoints } from '@vueuse/core'

const leftCollapsed = ref(false)
const rightCollapsed = ref(false)
const leftWidth = ref(280)
const rightWidth = ref(300)

const breakpoints = useBreakpoints({
  narrow: 0,
  standard: 1200,
  wide: 1400,
})

const isNarrow = breakpoints.smaller('standard')
const isStandard = breakpoints.between('standard', 'wide')

export function usePanelLayout() {
  function collapseLeft() { leftCollapsed.value = true }
  function expandLeft() { leftCollapsed.value = false }
  function collapseRight() { rightCollapsed.value = true }
  function expandRight() { rightCollapsed.value = false }
  function setLeftWidth(w: number) { leftWidth.value = Math.max(200, Math.min(400, w)) }
  function setRightWidth(w: number) { rightWidth.value = Math.max(240, Math.min(500, w)) }

  const autoCollapseRight = computed(() => isNarrow.value || isStandard.value)

  return {
    leftCollapsed, rightCollapsed,
    leftWidth, rightWidth,
    isNarrow, isStandard,
    autoCollapseRight,
    collapseLeft, expandLeft,
    collapseRight, expandRight,
    setLeftWidth, setRightWidth,
  }
}
```

- [ ] **步骤 5：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 6：运行所有测试**

运行：`npm test`
预期：所有测试通过

- [ ] **步骤 7：Commit**

```bash
git add src/composables/
git commit -m "feat: implement useSearch, usePluginEngine, useVfs, usePanelLayout"
```

---

## Phase 6：解压管道接线

### 任务 15：解压管道（上传→解压→树构建→UI）

**文件：**
- 创建：`src/composables/use-decompress.ts`
- 修改：`src/composables/use-archives.ts`

- [ ] **步骤 1：创建 src/composables/use-decompress.ts**

```ts
import { useArchiveManager } from './use-archives'
import { usePluginEngine } from './use-plugins'
import { TaskScheduler } from '@/core/task-scheduler'
import { buildFileTree } from '@/core/file-tree'
import type { ArchiveItem, FileTreeNode } from '@/adapters/types'

const scheduler = new TaskScheduler(3)

export function useDecompress() {
  const { archives, updateStatus } = useArchiveManager()
  const { registry } = usePluginEngine()

  function startDecompress(archive: ArchiveItem) {
    updateStatus(archive.id, 'running', 0)

    scheduler.enqueue(async () => {
      const data = new Uint8Array(await archive.file.arrayBuffer())

      const fileEntry = {
        name: archive.name,
        path: archive.name,
        size: data.length,
        isDirectory: false,
      }

      const plugin = registry.detectCompression(fileEntry)
      if (!plugin) {
        updateStatus(archive.id, 'failed')
        archive.error = `No plugin for: ${archive.name}`
        return
      }

      updateStatus(archive.id, 'running', 30)

      const result = await registry.safeDecompress(plugin, data, '')

      if (!result.success) {
        updateStatus(archive.id, 'failed')
        archive.error = result.error ?? 'Unknown error'
        return
      }

      updateStatus(archive.id, 'running', 80)

      const tree = buildFileTree(result.files, '')
      archive.files = tree
      archive.originalSize = result.files.reduce((sum, f) => sum + f.size, 0)

      updateStatus(archive.id, 'completed', 100)
    })
  }

  function decompressAll() {
    for (const archive of archives.value) {
      if (archive.status === 'pending') {
        startDecompress(archive)
      }
    }
  }

  return { startDecompress, decompressAll }
}
```

- [ ] **步骤 2：修改 useArchiveManager 在 addFiles 后自动触发解压**

更新 `src/composables/use-archives.ts`，在 `addFiles` 末尾添加自动触发逻辑：

```ts
import { ref, computed } from 'vue'
import type { ArchiveItem } from '@/adapters/types'

const archives = ref<ArchiveItem[]>([])

let nextArchiveId = 0

export function useArchiveManager() {
  function addFiles(files: File[]) {
    for (const file of files) {
      archives.value.push({
        id: `archive_${nextArchiveId++}`,
        name: file.name,
        file,
        status: 'pending',
        progress: 0,
        files: [],
        originalSize: 0,
        compressedSize: file.size,
      })
    }
    triggerDecompress()
  }

  async function triggerDecompress() {
    const { useDecompress } = await import('./use-decompress')
    const { decompressAll } = useDecompress()
    decompressAll()
  }

  function remove(id: string) {
    archives.value = archives.value.filter(a => a.id !== id)
  }

  function updateStatus(id: string, status: ArchiveItem['status'], progress?: number) {
    const archive = archives.value.find(a => a.id === id)
    if (archive) {
      archive.status = status
      if (progress !== undefined) archive.progress = progress
      if (status === 'running' && !archive.startTime) archive.startTime = Date.now()
      if (status === 'completed') archive.endTime = Date.now()
    }
  }

  const stats = computed(() => ({
    totalCount: archives.value.length,
    totalCompressedSize: archives.value.reduce((sum, a) => sum + a.compressedSize, 0),
    totalOriginalSize: archives.value.reduce((sum, a) => sum + a.originalSize, 0),
    totalFiles: archives.value.reduce((sum, a) => sum + a.files.length, 0),
    decompressedCount: archives.value.filter(a => a.status === 'completed').length,
  }))

  return { archives, addFiles, remove, updateStatus, stats }
}
```

注意：`triggerDecompress` 使用动态 import 避免循环依赖（`use-decompress` 依赖 `use-archives`）。

- [ ] **步骤 3：在 ArchivePanel 中添加重试支持**

更新 `src/components/archive-panel/ArchivePanel.vue` 的重试回调：

```vue
<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { useDecompress } from '@/composables/use-decompress'
import UploadZone from './UploadZone.vue'
import ArchiveCard from './ArchiveCard.vue'

const { archives, remove } = useArchiveManager()
const { startDecompress } = useDecompress()

function handleRetry(id: string) {
  const archive = archives.value.find(a => a.id === id)
  if (archive) {
    archive.status = 'pending'
    archive.error = undefined
    archive.progress = 0
    startDecompress(archive)
  }
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <UploadZone />
    <NScrollbar style="flex: 1; margin-top: 8px;">
      <ArchiveCard
        v-for="archive in archives"
        :key="archive.id"
        :archive="archive"
        @remove="remove"
        @retry="handleRetry"
      />
    </NScrollbar>
  </div>
</template>
```

- [ ] **步骤 4：验证类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误

- [ ] **步骤 5：验证解压流程**

运行：`npm run dev`
预期：上传 .zip 文件后，状态从 "排队中" → "解压中" → "已完成"，文件树出现（在 Tauri 模式下）

- [ ] **步骤 6：Commit**

```bash
git add src/composables/use-decompress.ts src/composables/use-archives.ts src/components/archive-panel/ArchivePanel.vue
git commit -m "feat: wire decompress pipeline (upload → decompress → tree → UI)"
```

---

## Phase 7：UI 组件

### 任务 16：AppLayout 四栏布局 + ErrorBoundary

**文件：**
- 创建：`src/components/shared/ErrorBoundary.vue`
- 创建：`src/components/layout/AppLayout.vue`
- 修改：`src/App.vue`

- [ ] **步骤 1：创建 src/components/shared/ErrorBoundary.vue**

```vue
<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue'
import { NResult } from 'naive-ui'

const error = ref<Error | null>(null)

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err))
  return false
})

function reset() {
  error.value = null
}
</script>

<template>
  <NResult
    v-if="error"
    status="error"
    :title="'渲染异常'"
    :description="error.message"
  >
    <template #footer>
      <n-button @click="reset">重试</n-button>
    </template>
  </NResult>
  <slot v-else />
</template>
```

- [ ] **步骤 2：创建 src/components/layout/AppLayout.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import {
  NLayout, NLayoutHeader, NLayoutSider, NLayoutContent,
} from 'naive-ui'
import { useAppStore } from '@/stores/app'
import PublicBar from '@/components/public-bar/PublicBar.vue'
import ArchivePanel from '@/components/archive-panel/ArchivePanel.vue'
import Workspace from '@/components/workspace/Workspace.vue'
import PropertyPanel from '@/components/property-panel/PropertyPanel.vue'

const store = useAppStore()
</script>

<template>
  <NLayout position="absolute" has-sider>
    <NLayoutHeader bordered style="height: 64px; padding: 0 16px;">
      <PublicBar />
    </NLayoutHeader>

    <NLayout has-sider position="absolute" style="top: 64px;">
      <NLayoutSider
        bordered
        :width="store.leftPanelWidth"
        :collapsed-width="0"
        collapse-mode="width"
        :collapsed="false"
        show-trigger="bar"
        content-style="padding: 8px;"
      >
        <ArchivePanel />
      </NLayoutSider>

      <NLayoutContent content-style="padding: 0;">
        <Workspace />
      </NLayoutContent>

      <NLayoutSider
        bordered
        :width="store.rightPanelWidth"
        :collapsed-width="0"
        collapse-mode="width"
        :collapsed="false"
        show-trigger="bar"
        content-style="padding: 8px;"
      >
        <PropertyPanel />
      </NLayoutSider>
    </NLayout>
  </NLayout>
</template>
```

- [ ] **步骤 3：创建占位组件**

创建 `src/components/public-bar/PublicBar.vue`：

```vue
<template>
  <div style="display: flex; align-items: center; height: 100%;">
    <span>PublicBar</span>
  </div>
</template>
```

创建 `src/components/archive-panel/ArchivePanel.vue`：

```vue
<template>
  <div>ArchivePanel</div>
</template>
```

创建 `src/components/workspace/Workspace.vue`：

```vue
<template>
  <div style="height: 100%;">Workspace</div>
</template>
```

创建 `src/components/property-panel/PropertyPanel.vue`：

```vue
<template>
  <div>PropertyPanel</div>
</template>
```

- [ ] **步骤 4：修改 src/App.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme } from 'naive-ui'
import { themeOverrides } from './styles/theme'
import { useAppStore } from './stores/app'
import AppLayout from './components/layout/AppLayout.vue'

const store = useAppStore()
const theme = computed(() => store.isDarkTheme ? darkTheme : lightTheme)
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <AppLayout />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
```

- [ ] **步骤 5：验证页面渲染**

运行：`npm run dev`
预期：页面显示四栏布局（顶部栏 + 左侧面板 + 中间工作区 + 右侧面板），无控制台错误

- [ ] **步骤 6：Commit**

```bash
git add src/components/ src/App.vue
git commit -m "feat: implement AppLayout with 4-panel structure and ErrorBoundary"
```

---

### 任务 17：PublicBar（GlobalStats + GlobalSearch）

**文件：**
- 创建：`src/components/public-bar/GlobalStats.vue`
- 创建：`src/components/public-bar/GlobalSearch.vue`
- 重写：`src/components/public-bar/PublicBar.vue`

- [ ] **步骤 1：创建 src/components/public-bar/GlobalStats.vue**

```vue
<script setup lang="ts">
import { NStatistic, NTag, NSpace } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

const { stats } = useArchiveManager()
</script>

<template>
  <NSpace :size="16" align="center">
    <NStatistic label="总包数" :value="stats.totalCount">
      <template #suffix><NTag size="small">个</NTag></template>
    </NStatistic>
    <NStatistic label="压缩大小" :value="stats.totalCompressedSize">
      <template #suffix><NTag size="small">B</NTag></template>
    </NStatistic>
    <NStatistic label="已解压" :value="stats.decompressedCount">
      <template #suffix><NTag size="small" type="success">个</NTag></template>
    </NStatistic>
    <NStatistic label="总文件" :value="stats.totalFiles">
      <template #suffix><NTag size="small">个</NTag></template>
    </NStatistic>
  </NSpace>
</template>
```

- [ ] **步骤 2：创建 src/components/public-bar/GlobalSearch.vue**

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { NInput, NButton, NSpace } from 'naive-ui'
import { useSearch } from '@/composables/use-search'

const keyword = ref('')
const { search, searching } = useSearch()

function handleSearch() {
  if (keyword.value.trim()) {
    search([], keyword.value.trim())
  }
}
</script>

<template>
  <NSpace align="center" :size="8">
    <NInput
      v-model:value="keyword"
      type="text"
      placeholder="全局搜索..."
      clearable
      style="width: 240px;"
      @keyup.enter="handleSearch"
    />
    <NButton type="primary" :loading="searching" @click="handleSearch">
      搜索
    </NButton>
  </NSpace>
</template>
```

- [ ] **步骤 3：重写 src/components/public-bar/PublicBar.vue**

```vue
<script setup lang="ts">
import { NSpace, NButton, NDropdown } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import GlobalStats from './GlobalStats.vue'
import GlobalSearch from './GlobalSearch.vue'

const store = useAppStore()

const batchOptions = [
  { label: '一键清空', key: 'clear' },
  { label: '全部导出', key: 'export' },
  { label: '批量重新解压', key: 'reDecompress' },
]

function handleBatch(key: string) {
  if (key === 'clear') {
    const { archives } = await import('@/composables/use-archives').then(m => m.useArchiveManager())
    archives.value = []
  }
}
</script>

<template>
  <NSpace align="center" justify="space-between" style="height: 100%;">
    <GlobalStats />
    <NSpace align="center" :size="16">
      <GlobalSearch />
      <NDropdown :options="batchOptions" @select="handleBatch">
        <NButton>批量操作</NButton>
      </NDropdown>
      <NButton @click="store.toggleTheme">
        {{ store.isDarkTheme ? '浅色' : '深色' }}
      </NButton>
    </NSpace>
  </NSpace>
</template>
```

等等，`handleBatch` 里有 `await` 在非 async 函数中。修正：

- [ ] **步骤 3（修正）：重写 src/components/public-bar/PublicBar.vue**

```vue
<script setup lang="ts">
import { NSpace, NButton, NDropdown } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useArchiveManager } from '@/composables/use-archives'
import GlobalStats from './GlobalStats.vue'
import GlobalSearch from './GlobalSearch.vue'

const store = useAppStore()
const { archives } = useArchiveManager()

const batchOptions = [
  { label: '一键清空', key: 'clear' },
  { label: '全部导出', key: 'export' },
  { label: '批量重新解压', key: 'reDecompress' },
]

function handleBatch(key: string) {
  if (key === 'clear') {
    archives.value = []
  }
}
</script>

<template>
  <NSpace align="center" justify="space-between" style="height: 100%;">
    <GlobalStats />
    <NSpace align="center" :size="16">
      <GlobalSearch />
      <NDropdown :options="batchOptions" @select="handleBatch">
        <NButton>批量操作</NButton>
      </NDropdown>
      <NButton @click="store.toggleTheme">
        {{ store.isDarkTheme ? '浅色' : '深色' }}
      </NButton>
    </NSpace>
  </NSpace>
</template>
```

- [ ] **步骤 4：验证页面渲染**

运行：`npm run dev`
预期：顶部栏显示统计数字、搜索框、批量操作按钮和主题切换按钮

- [ ] **步骤 5：Commit**

```bash
git add src/components/public-bar/
git commit -m "feat: implement PublicBar with GlobalStats and GlobalSearch"
```

---

### 任务 18：ArchivePanel（UploadZone + ArchiveCard + FileTree）

**文件：**
- 创建：`src/components/archive-panel/UploadZone.vue`
- 创建：`src/components/archive-panel/StatusIndicator.vue`
- 创建：`src/components/archive-panel/ArchiveCard.vue`
- 创建：`src/components/archive-panel/FileTree.vue`
- 重写：`src/components/archive-panel/ArchivePanel.vue`

- [ ] **步骤 1：创建 src/components/archive-panel/UploadZone.vue**

```vue
<script setup lang="ts">
import { NUpload, NUploadDragger, NIcon, NP, NText } from 'naive-ui'
import { ArchiveOutline } from '@vicons/ionicons5'
import { useArchiveManager } from '@/composables/use-archives'

const { addFiles } = useArchiveManager()

function handleUpload({ file }: { file: { file: File | null } }) {
  if (file.file) {
    addFiles([file.file])
  }
  return false
}
</script>

<template>
  <NUpload
    multiple
    :show-file-list="false"
    :custom-request="handleUpload"
    accept=".zip,.gz,.gzip,.tgz,.7z,.rar,.tar"
  >
    <NUploadDragger>
      <div style="padding: 16px; text-align: center;">
        <NText depth="3">拖拽压缩包到此处，或点击上传</NText>
      </div>
    </NUploadDragger>
  </NUpload>
</template>
```

注意：`@vicons/ionicons5` 需要安装，但为简化我们可以移除图标引用。修正：

- [ ] **步骤 1（修正）：创建 src/components/archive-panel/UploadZone.vue**

```vue
<script setup lang="ts">
import { NUpload, NUploadDragger, NText } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

const { addFiles } = useArchiveManager()

function handleUpload({ file }: { file: { file: File | null } }) {
  if (file.file) {
    addFiles([file.file])
  }
  return false
}
</script>

<template>
  <NUpload
    multiple
    :show-file-list="false"
    :custom-request="handleUpload"
    accept=".zip,.gz,.gzip,.tgz,.7z,.rar,.tar"
  >
    <NUploadDragger>
      <div style="padding: 16px; text-align: center;">
        <NText depth="3">拖拽压缩包到此处，或点击上传</NText>
      </div>
    </NUploadDragger>
  </NUpload>
</template>
```

- [ ] **步骤 2：创建 src/components/archive-panel/StatusIndicator.vue**

```vue
<script setup lang="ts">
import { NTag, NProgress, NSpace } from 'naive-ui'
import type { ArchiveStatus } from '@/adapters/types'

defineProps<{
  status: ArchiveStatus
  progress: number
}>()
</script>

<template>
  <NSpace align="center" :size="4">
    <template v-if="status === 'completed'">
      <NTag type="success" size="small">已完成</NTag>
    </template>
    <template v-else-if="status === 'running'">
      <NTag type="info" size="small">解压中</NTag>
      <NProgress type="line" :percentage="progress" :show-indicator="false" style="width: 60px;" />
    </template>
    <template v-else-if="status === 'pending'">
      <NTag type="warning" size="small">排队中</NTag>
    </template>
    <template v-else-if="status === 'failed'">
      <NTag type="error" size="small">失败</NTag>
    </template>
  </NSpace>
</template>
```

- [ ] **步骤 3：创建 src/components/archive-panel/FileTree.vue**

```vue
<script setup lang="ts">
import { ref, h } from 'vue'
import { NTree, NInput } from 'naive-ui'
import type { TreeOption } from 'naive-ui'
import type { FileTreeNode } from '@/adapters/types'
import { useTabManager } from '@/composables/use-tabs'

const props = defineProps<{
  data: FileTreeNode[]
  archiveId: string
}>()

const { openTab } = useTabManager()
const pattern = ref('')

function handleSelect(keys: string[]) {
  if (keys.length === 0) return
  const key = keys[0]
  const node = findNode(props.data, key)
  if (node?.isLeaf) {
    openTab(node, props.archiveId)
  }
}

function findNode(nodes: FileTreeNode[], key: string): FileTreeNode | null {
  for (const node of nodes) {
    if (node.key === key) return node
    if (node.children) {
      const found = findNode(node.children, key)
      if (found) return found
    }
  }
  return null
}

const treeData = ref<TreeOption[]>(props.data as any)
</script>

<template>
  <div>
    <NInput v-model:value="pattern" placeholder="过滤文件..." size="small" clearable style="margin-bottom: 4px;" />
    <NTree
      :data="data as any"
      :pattern="pattern"
      :show-irrelevant-nodes="false"
      virtual-scroll
      style="max-height: 300px;"
      selectable
      :default-expand-all="false"
      @update:selected-keys="handleSelect"
      block-line
    />
  </div>
</template>
```

- [ ] **步骤 4：创建 src/components/archive-panel/ArchiveCard.vue**

```vue
<script setup lang="ts">
import { NCard, NSpace, NButton } from 'naive-ui'
import type { ArchiveItem } from '@/adapters/types'
import StatusIndicator from './StatusIndicator.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  archive: ArchiveItem
}>()

const emit = defineEmits<{
  remove: [id: string]
  retry: [id: string]
}>()
</script>

<template>
  <NCard
    :title="archive.name"
    size="small"
    closable
    style="margin-bottom: 8px;"
    @close="emit('remove', archive.id)"
  >
    <template #header-extra>
      <StatusIndicator :status="archive.status" :progress="archive.progress" />
    </template>

    <div v-if="archive.status === 'failed'" style="color: #EF4444; margin-bottom: 8px;">
      {{ archive.error }}
      <NButton size="tiny" @click="emit('retry', archive.id)">重试</NButton>
    </div>

    <FileTree
      v-if="archive.files.length > 0"
      :data="archive.files"
      :archive-id="archive.id"
    />
  </NCard>
</template>
```

- [ ] **步骤 5：重写 src/components/archive-panel/ArchivePanel.vue**

```vue
<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import UploadZone from './UploadZone.vue'
import ArchiveCard from './ArchiveCard.vue'

const { archives, remove } = useArchiveManager()
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <UploadZone />
    <NScrollbar style="flex: 1; margin-top: 8px;">
      <ArchiveCard
        v-for="archive in archives"
        :key="archive.id"
        :archive="archive"
        @remove="remove"
        @retry="() => {}"
      />
    </NScrollbar>
  </div>
</template>
```

- [ ] **步骤 6：验证页面渲染**

运行：`npm run dev`
预期：左侧面板显示上传区域，上传文件后显示卡片

- [ ] **步骤 7：Commit**

```bash
git add src/components/archive-panel/
git commit -m "feat: implement ArchivePanel with upload, cards, file tree"
```

---

### 任务 19：Workspace（TabBar + PreviewPane + PreviewToolbar + StatusBar）

**文件：**
- 创建：`src/components/workspace/TabBar.vue`
- 创建：`src/components/workspace/PreviewPane.vue`
- 创建：`src/components/workspace/PreviewToolbar.vue`
- 创建：`src/components/workspace/StatusBar.vue`
- 创建：`src/components/workspace/SplitView.vue`
- 重写：`src/components/workspace/Workspace.vue`

- [ ] **步骤 1：创建 src/components/workspace/TabBar.vue**

```vue
<script setup lang="ts">
import { NTabs, NTab } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { tabs, activeTabId, activateTab, closeTab, togglePin } = useTabManager()
</script>

<template>
  <NTabs
    v-if="tabs.length > 0"
    type="card"
    :value="activeTabId"
    closable
    @update:value="activateTab"
    @close="closeTab"
  >
    <NTab
      v-for="tab in tabs"
      :key="tab.id"
      :name="tab.id"
      :closable="!tab.pinned"
    >
      {{ tab.pinned ? '📌 ' : '' }}{{ tab.fileNode.label }}
    </NTab>
  </NTabs>
  <div v-else style="display: flex; align-items: center; justify-content: center; height: 40px; color: #666;">
    点击左侧文件树中的文件以预览
  </div>
</template>
```

- [ ] **步骤 2：创建 src/components/workspace/PreviewToolbar.vue**

```vue
<script setup lang="ts">
import { NInputNumber, NSwitch, NSelect, NSpace, NText } from 'naive-ui'

defineProps<{
  type: 'text' | 'csv' | 'json' | 'hex'
}>()

const fontSize = defineModel<number>('fontSize', { default: 14 })
const wrap = defineModel<boolean>('wrap', { default: false })
const showLineNumbers = defineModel<boolean>('showLineNumbers', { default: true })

const encodingOptions = [
  { label: 'UTF-8', value: 'utf-8' },
  { label: 'GBK', value: 'gbk' },
  { label: 'Shift_JIS', value: 'shift_jis' },
]
const encoding = defineModel<string>('encoding', { default: 'utf-8' })
</script>

<template>
  <NSpace align="center" :size="12" style="padding: 4px 8px; border-bottom: 1px solid #333;">
    <NSpace align="center" :size="4">
      <NText depth="3" style="font-size: 12px;">字号</NText>
      <NInputNumber v-model:value="fontSize" :min="10" :max="24" size="small" style="width: 70px;" />
    </NSpace>

    <template v-if="type === 'text' || type === 'hex'">
      <NSpace align="center" :size="4">
        <NText depth="3" style="font-size: 12px;">换行</NText>
        <NSwitch v-model:value="wrap" size="small" />
      </NSpace>
      <NSpace align="center" :size="4">
        <NText depth="3" style="font-size: 12px;">行号</NText>
        <NSwitch v-model:value="showLineNumbers" size="small" />
      </NSpace>
    </template>

    <NSpace align="center" :size="4">
      <NText depth="3" style="font-size: 12px;">编码</NText>
      <NSelect v-model:value="encoding" :options="encodingOptions" size="small" style="width: 100px;" />
    </NSpace>
  </NSpace>
</template>
```

- [ ] **步骤 3：创建 src/components/workspace/PreviewPane.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NEmpty, NScrollbar } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'
import ErrorBoundary from '@/components/shared/ErrorBoundary.vue'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()

const rendererComponent = computed(() => {
  if (!activeTab.value?.content) return null
  const ext = '.' + (activeTab.value.fileNode.label.split('.').pop() ?? '')
  const plugin = registry.getParser(ext)
  return plugin?.getComponent() ?? null
})
</script>

<template>
  <NEmpty v-if="!activeTab" description="选择一个文件以预览" style="margin-top: 40px;" />
  <NEmpty v-else-if="!activeTab.content" description="加载中..." style="margin-top: 40px;" />
  <NScrollbar v-else style="flex: 1;">
    <ErrorBoundary>
      <component
        :is="rendererComponent"
        :content="activeTab.content.data"
        v-if="rendererComponent"
      />
    </ErrorBoundary>
  </NScrollbar>
</template>
```

- [ ] **步骤 4：创建 src/components/workspace/StatusBar.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NText, NSpace } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const statusText = computed(() => {
  if (!activeTab.value?.content) return '无内容'
  const c = activeTab.value.content
  const parts: string[] = []
  if (c.lineCount !== undefined) parts.push(`${c.lineCount} 行`)
  if (c.loadTimeMs !== undefined) parts.push(`${c.loadTimeMs.toFixed(1)} ms`)
  parts.push(`插件: ${c.pluginName}`)
  return parts.join(' | ')
})
</script>

<template>
  <div style="height: 24px; padding: 0 8px; display: flex; align-items: center; border-top: 1px solid #333;">
    <NText depth="3" style="font-size: 12px;">{{ statusText }}</NText>
  </div>
</template>
```

- [ ] **步骤 5：创建 src/components/workspace/SplitView.vue**

```vue
<script setup lang="ts">
import { Splitpanes, Pane } from 'splitpanes'
</script>

<template>
  <Splitpanes style="height: 100%;">
    <Pane min-size="20">
      <slot name="left" />
    </Pane>
    <Pane min-size="20">
      <slot name="right" />
    </Pane>
  </Splitpanes>
</template>
```

- [ ] **步骤 6：重写 src/components/workspace/Workspace.vue**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import TabBar from './TabBar.vue'
import PreviewToolbar from './PreviewToolbar.vue'
import PreviewPane from './PreviewPane.vue'
import StatusBar from './StatusBar.vue'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const fontSize = ref(14)
const wrap = ref(false)
const showLineNumbers = ref(true)
const encoding = ref('utf-8')

const contentType = computed<'text' | 'csv' | 'json' | 'hex'>(
  () => activeTab.value?.content?.type ?? 'text'
)
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <TabBar />
    <PreviewToolbar
      v-if="activeTab?.content"
      :type="contentType"
      v-model:fontSize="fontSize"
      v-model:wrap="wrap"
      v-model:showLineNumbers="showLineNumbers"
      v-model:encoding="encoding"
    />
    <PreviewPane />
    <StatusBar />
  </div>
</template>
```

- [ ] **步骤 7：验证页面渲染**

运行：`npm run dev`
预期：中间工作区显示标签栏（空状态提示）和状态栏

- [ ] **步骤 8：Commit**

```bash
git add src/components/workspace/
git commit -m "feat: implement Workspace with TabBar, PreviewPane, toolbar, status bar"
```

---

### 任务 20：PropertyPanel（MetadataView + ConfigForm + PathBreadcrumb）

**文件：**
- 创建：`src/components/property-panel/MetadataView.vue`
- 创建：`src/components/property-panel/ConfigForm.vue`
- 创建：`src/components/property-panel/PathBreadcrumb.vue`
- 重写：`src/components/property-panel/PropertyPanel.vue`

- [ ] **步骤 1：创建 src/components/property-panel/MetadataView.vue**

```vue
<script setup lang="ts">
import { NDescriptions, NDescriptionsItem } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()
</script>

<template>
  <div v-if="activeTab">
    <NDescriptions label-placement="left" size="small" bordered>
      <NDescriptionsItem label="文件名">
        {{ activeTab.fileNode.label }}
      </NDescriptionsItem>
      <NDescriptionsItem label="路径">
        {{ activeTab.fileNode.path }}
      </NDescriptionsItem>
      <NDescriptionsItem label="大小">
        {{ activeTab.fileNode.size ?? '-' }} B
      </NDescriptionsItem>
      <NDescriptionsItem label="类型" v-if="activeTab.content">
        {{ activeTab.content.type }}
      </NDescriptionsItem>
      <NDescriptionsItem label="行数" v-if="activeTab.content?.lineCount">
        {{ activeTab.content.lineCount }}
      </NDescriptionsItem>
      <NDescriptionsItem label="解析插件" v-if="activeTab.content">
        {{ activeTab.content.pluginName }}
      </NDescriptionsItem>
    </NDescriptions>
  </div>
  <div v-else style="color: #666; text-align: center; margin-top: 20px;">
    选择文件查看属性
  </div>
</template>
```

- [ ] **步骤 2：创建 src/components/property-panel/ConfigForm.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NForm, NFormItem, NInput, NSelect, NSwitch, NInputNumber, NText } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import { usePluginEngine } from '@/composables/use-plugins'

const { activeTab } = useTabManager()
const { registry } = usePluginEngine()

const configSchema = computed(() => {
  if (!activeTab.value) return null
  const ext = '.' + (activeTab.value.fileNode.label.split('.').pop() ?? '')
  const plugin = registry.getParser(ext)
  return plugin?.getConfigSchema?.() ?? null
})
</script>

<template>
  <div v-if="configSchema" style="margin-top: 12px;">
    <NText strong depth="2" style="font-size: 12px; display: block; margin-bottom: 8px;">
      插件配置
    </NText>
    <NForm label-placement="left" size="small">
      <NFormItem
        v-for="field in configSchema.fields"
        :key="field.key"
        :label="field.label"
      >
        <NInput v-if="field.type === 'input'" :default-value="field.default" size="small" />
        <NSelect v-else-if="field.type === 'select'" :options="field.options" :default-value="field.default" size="small" />
        <NSwitch v-else-if="field.type === 'switch'" :default-value="field.default" />
        <NInputNumber v-else-if="field.type === 'number'" :default-value="field.default" size="small" />
      </NFormItem>
    </NForm>
  </div>
</template>
```

- [ ] **步骤 3：创建 src/components/property-panel/PathBreadcrumb.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue'
import { NBreadcrumb, NBreadcrumbItem } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const pathSegments = computed(() => {
  if (!activeTab.value) return []
  return activeTab.value.fileNode.path.split('/').filter(Boolean)
})
</script>

<template>
  <NBreadcrumb v-if="pathSegments.length > 0" style="margin-top: 12px;">
    <NBreadcrumbItem v-for="(seg, i) in pathSegments" :key="i">
      {{ seg }}
    </NBreadcrumbItem>
  </NBreadcrumb>
</template>
```

- [ ] **步骤 4：重写 src/components/property-panel/PropertyPanel.vue**

```vue
<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import MetadataView from './MetadataView.vue'
import ConfigForm from './ConfigForm.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
</script>

<template>
  <NScrollbar>
    <MetadataView />
    <ConfigForm />
    <PathBreadcrumb />
  </NScrollbar>
</template>
```

- [ ] **步骤 5：验证页面渲染**

运行：`npm run dev`
预期：右侧面板显示 "选择文件查看属性" 空状态

- [ ] **步骤 6：Commit**

```bash
git add src/components/property-panel/
git commit -m "feat: implement PropertyPanel with metadata, config form, breadcrumb"
```

---

## Phase 8：Rust 后端完善

### 任务 21：完善 Rust 文件操作 + 解压命令

**文件：**
- 修改：`src-tauri/src/file_ops.rs`（创建）
- 修改：`src-tauri/src/decompress.rs`（创建）
- 修改：`src-tauri/src/commands.rs`
- 修改：`src-tauri/src/main.rs`

- [ ] **步骤 1：创建 src-tauri/src/file_ops.rs**

```rust
use crate::error::AppError;
use memmap2::Mmap;
use std::fs::File;
use std::path::Path;

pub fn mmap_read(path: &str, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    let file = File::open(path)?;
    let mmap = unsafe { Mmap::map(&file)? };
    let start = offset as usize;
    let end = (offset + length) as usize;
    if end > mmap.len() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Read range exceeds file size",
        )));
    }
    Ok(mmap[start..end].to_vec())
}

pub fn list_files(dir: &str) -> Result<Vec<FileMeta>, AppError> {
    let mut results = Vec::new();
    walk_dir(Path::new(dir), &mut results)?;
    Ok(results)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

fn walk_dir(dir: &Path, results: &mut Vec<FileMeta>) -> Result<(), AppError> {
    if dir.is_dir() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            results.push(FileMeta {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                is_directory: meta.is_dir(),
            });
            if meta.is_dir() {
                walk_dir(&path, results)?;
            }
        }
    }
    Ok(())
}
```

- [ ] **步骤 2：创建 src-tauri/src/decompress.rs**

```rust
use crate::error::AppError;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompressedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_directory: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompressResult {
    pub success: bool,
    pub files: Vec<DecompressedFile>,
    pub error: Option<String>,
}

pub fn decompress_zip(data: &[u8], output_dir: &str) -> Result<Vec<DecompressedFile>, AppError> {
    let reader = io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|e| AppError::Decompress(e.to_string()))?;

    let out = Path::new(output_dir);
    fs::create_dir_all(out)?;

    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|e| AppError::Decompress(e.to_string()))?;

        let outpath = out.join(file.name());

        if file.is_dir() {
            fs::create_dir_all(&outpath)?;
            files.push(DecompressedFile {
                name: file.name().to_string(),
                path: outpath.to_string_lossy().to_string(),
                size: 0,
                is_directory: true,
            });
        } else {
            if let Some(parent) = outpath.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut outfile = File::create(&outpath)?;
            io::copy(&mut file, &mut outfile)?;
            files.push(DecompressedFile {
                name: file.name().to_string(),
                path: outpath.to_string_lossy().to_string(),
                size: file.size(),
                is_directory: false,
            });
        }
    }
    Ok(files)
}

pub fn decompress_gzip(data: &[u8], output_dir: &str) -> Result<Vec<DecompressedFile>, AppError> {
    let out = Path::new(output_dir);
    fs::create_dir_all(out)?;

    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut buffer = Vec::new();
    decoder.read_to_end(&mut buffer)
        .map_err(|e| AppError::Decompress(e.to_string()))?;

    let outpath = out.join("decompressed");
    fs::write(&outpath, &buffer)?;

    Ok(vec![DecompressedFile {
        name: "decompressed".to_string(),
        path: outpath.to_string_lossy().to_string(),
        size: buffer.len() as u64,
        is_directory: false,
    }])
}
```

- [ ] **步骤 3：更新 src-tauri/src/commands.rs**

```rust
use crate::error::AppError;
use crate::file_ops;
use crate::decompress;

#[tauri::command]
pub async fn read_file(path: String) -> Result<Vec<u8>, AppError> {
    tokio::fs::read(&path).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn write_file(path: String, data: Vec<u8>) -> Result<(), AppError> {
    tokio::fs::write(&path, &data).await.map_err(AppError::Io)
}

#[tauri::command]
pub async fn get_temp_dir() -> Result<String, AppError> {
    let dir = std::env::temp_dir();
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn mmap_read(path: String, offset: u64, length: u64) -> Result<Vec<u8>, AppError> {
    file_ops::mmap_read(&path, offset, length)
}

#[tauri::command]
pub fn list_files(dir: String) -> Result<Vec<file_ops::FileMeta>, AppError> {
    file_ops::list_files(&dir)
}

#[tauri::command]
pub fn decompress(data: Vec<u8>, format: String, output_dir: String) -> Result<decompress::DecompressResult, AppError> {
    let result = match format.as_str() {
        "zip" => decompress::decompress_zip(&data, &output_dir),
        "gzip" => decompress::decompress_gzip(&data, &output_dir),
        _ => return Ok(decompress::DecompressResult {
            success: false,
            files: vec![],
            error: Some(format!("Unsupported format: {}", format)),
        }),
    };
    match result {
        Ok(files) => Ok(decompress::DecompressResult { success: true, files, error: None }),
        Err(e) => Ok(decompress::DecompressResult { success: false, files: vec![], error: Some(e.to_string()) }),
    }
}
```

- [ ] **步骤 4：更新 src-tauri/src/main.rs**

```rust
mod commands;
mod error;
mod file_ops;
mod decompress;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::get_temp_dir,
            commands::mmap_read,
            commands::list_files,
            commands::decompress,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **步骤 5：验证 Rust 编译**

运行：`cd src-tauri && cargo check`
预期：编译检查通过

- [ ] **步骤 6：编写 Rust 单元测试**

在 `src-tauri/src/file_ops.rs` 末尾添加：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_mmap_read() {
        let dir = std::env::temp_dir().join("test_mmap");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.txt");
        let mut f = File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let result = mmap_read(path.to_str().unwrap(), 0, 5).unwrap();
        assert_eq!(result, b"hello");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_list_files() {
        let dir = std::env::temp_dir().join("test_list");
        std::fs::create_dir_all(&dir).unwrap();
        File::create(dir.join("a.txt")).unwrap();
        File::create(dir.join("b.txt")).unwrap();

        let files = list_files(dir.to_str().unwrap()).unwrap();
        assert_eq!(files.len(), 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
```

- [ ] **步骤 7：运行 Rust 测试**

运行：`cd src-tauri && cargo test`
预期：2 tests passed

- [ ] **步骤 8：Commit**

```bash
git add src-tauri/
git commit -m "feat: implement Rust file_ops (mmap, list) and decompress (zip, gzip)"
```

---

## Phase 9：集成 + 构建

### 任务 22：端到端集成 + 构建验证

**文件：**
- 修改：`src/App.vue`（如需要微调）
- 修改：`vite.config.ts`（如需要调整）

- [ ] **步骤 1：运行完整类型检查**

运行：`npx vue-tsc --noEmit`
预期：无错误（修复所有类型错误）

- [ ] **步骤 2：运行所有测试**

运行：`npm test`
预期：所有测试通过

- [ ] **步骤 3：运行 Rust 测试**

运行：`cd src-tauri && cargo test`
预期：所有测试通过

- [ ] **步骤 4：验证 Web 构建**

运行：`npm run build`
预期：成功输出 `dist/` 目录

- [ ] **步骤 5：验证 Web 预览**

运行：`npm run preview`
预期：浏览器打开后显示完整四栏布局

- [ ] **步骤 6：验证 Tauri 开发模式**（需要 Rust 工具链）

运行：`npm run tauri:dev`
预期：桌面窗口启动，显示完整 UI

- [ ] **步骤 7：最终 Commit**

```bash
git add -A
git commit -m "feat: end-to-end integration and build verification"
```

---

## 检查清单

| 规格需求 | 对应任务 |
|---|---|
| Vue 3 + TS + Vite + Naive UI | 任务 1, 2 |
| Tauri Rust 后端 | 任务 3, 21 |
| 双端构建 (Web / EXE) | 任务 1 (vite.config.ts), 任务 3 (tauri.conf.json) |
| IPlatformAdapter 接口 | 任务 5 |
| WebAdapter / TauriAdapter | 任务 6 |
| 编译期平台切换 | 任务 1 (vite.config.ts alias) |
| ICompressionPlugin / IFileParserPlugin | 任务 7 |
| PluginRegistry + 安全沙箱 | 任务 7 |
| 内置插件 (text/csv/json/hex/zip/gzip) | 任务 8, 9 |
| 插件清单注册 | 任务 9 (manifest.ts) |
| TaskScheduler 并发控制 | 任务 11 |
| FileTreeNode 构建 | 任务 10 |
| SearchService | 任务 12 |
| DecompressService / ParserEngine | 任务 12 |
| useArchiveManager | 任务 13 |
| useTabManager | 任务 13 |
| useSearch / usePluginEngine / useVfs / usePanelLayout | 任务 14 |
| 解压管道（上传→解压→树构建→UI） | 任务 15 |
| AppLayout 四栏布局 | 任务 16 |
| PublicBar (统计/搜索/批量) | 任务 17 |
| ArchivePanel (上传/卡片/文件树) | 任务 18 |
| Workspace (标签栏/预览/工具栏/状态栏) | 任务 19 |
| PropertyPanel (元数据/配置/路径) | 任务 20 |
| ErrorBoundary | 任务 16 |
| 暗黑/浅色主题 | 任务 2, 17 |
| Rust mmap 零拷贝 | 任务 21 (file_ops.rs) |
| Rust 原生解压 (zip/gzip) | 任务 21 (decompress.rs) |
| Pinia Store | 任务 4 |
| 测试策略 (Vitest) | 贯穿各任务 |
