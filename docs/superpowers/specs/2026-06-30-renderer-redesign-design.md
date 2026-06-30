# 4 渲染页面重新设计规格

> 日期：2026-06-30
> 状态：已批准（待实现）
> 关联：`docs/design.md` 4.2.3、`docs/superpowers/specs/2026-06-26-system-architecture-design.md`

## 1. 概述与目标

现有 4 个文件解析插件（text/csv/json/hex）将解析逻辑与渲染组件（`defineComponent + h`）内联在同一个 `.ts` 文件中，且 `.log` 文件被 `textPlugin` 兜底处理，缺少日志特化展示。本规格重新设计 csv/json/log/txt 四个**独立渲染页面**，将解析逻辑与渲染页面分离为独立文件，按新目录结构组织，便于后续维护与扩展。

**目标：**

1. 为 csv/json/log/txt 各提供一个独立的 `.vue` 渲染页面，职责单一。
2. 将解析逻辑抽为纯函数，置于 `src/core/parsers/`，无 Vue 依赖、可独立单测。
3. `.log` 从 `textPlugin` 分离，新增 `log-plugin` + `LogRenderer`，提供结构化着色展示。
4. 现有插件接口 `IFileParserPlugin` 保留不变；插件文件改为薄接线层（import 解析函数 + import 渲染组件）。
5. 新增文件格式时，只需新增 parser + renderer + plugin 接线 + manifest 注册，核心零修改。

## 2. 范围与非目标

**范围内：**

- 新增 `src/views/renderers/` 下 4 个渲染页面 `.vue`。
- 新增 `src/core/parsers/` 下 4 个解析函数 `.ts` + 共享类型。
- 改造 `src/plugins/parser/{text,csv,json}-plugin.ts` 为接线层；新增 `log-plugin.ts`。
- `ParsedResult.type` / `ParsedContent.type` 增加 `'log'`。
- `manifest.ts` 注册 `logPlugin`；`textPlugin.supportedExtensions` 移除 `.log`。
- 解析层单测 + `LogRenderer` 组件测试。

**非目标（明确排除）：**

- 不迁移现有目录（`src/components/`、`src/plugins/` 原地保留）。
- 不做预览工具栏、底部状态栏、属性面板配置表单注入（`getConfigSchema` 暂不接入）。
- 不改 `registry.ts`、`PreviewPane.vue`、composables、压缩插件、适配器。
- 不引入虚拟滚动（本次样本为小文件）。
- 不改 `src/layout/`、`src/styles/` 现有内容。

## 3. 目录结构与文件清单

### 3.1 目录规划原则

- `src/views/` — 页面相关代码（渲染页面 `.vue`）。
- `src/core/` — 解析等核心逻辑（纯函数，无 Vue 依赖）。
- `src/layout/` — 布局页面（本次不新增，现有布局不动）。
- `src/style/` — 样式文件（本次渲染器用 SFC `<style scoped>`，不新增独立样式文件）。

本次新代码仅落 `views/` 与 `core/`，采用**扁平分离**组织：渲染器扁平放 `views/renderers/`，解析函数扁平放 `core/parsers/`。层级浅、查找直接；`views`/`core` 职责分离即隔离边界。

### 3.2 新增文件（11 个）

| 文件 | 职责 |
|---|---|
| `src/views/renderers/TextRenderer.vue` | 纯文本渲染：行号 + 等宽 + 不换行横向滚动 |
| `src/views/renderers/CsvRenderer.vue` | 表格渲染：表头固定 + 边框 + 等宽 |
| `src/views/renderers/JsonRenderer.vue` | JSON 渲染：递归组件 + 语法着色 + 可折叠节点 |
| `src/views/renderers/LogRenderer.vue` | 日志渲染：结构化分列 + 级别着色 |
| `src/views/renderers/index.ts` | 统一导出 4 个渲染器 |
| `src/core/parsers/text-parser.ts` | `parseText(data)` → UTF-8 解码 + 行计数 |
| `src/core/parsers/csv-parser.ts` | `parseCsv(text, delimiter)` → `{headers, rows}` |
| `src/core/parsers/json-parser.ts` | `parseJson(text)` → 对象（兼容 JSONL） |
| `src/core/parsers/log-parser.ts` | `parseLog(text)` → `LogLine[]` |
| `src/core/parsers/types.ts` | `LogLine` / `LogLevel` 等共享类型 |
| `src/core/parsers/index.ts` | 统一导出解析函数 |

### 3.3 修改现有文件（接线，5 个 + 2 处类型扩展）

| 文件 | 改动 |
|---|---|
| `src/plugins/parser/text-plugin.ts` | 改为 `import { parseText }` + `import TextRenderer`；`supportedExtensions` 移除 `.log` |
| `src/plugins/parser/csv-plugin.ts` | 改为 `import { parseCsv }` + `import CsvRenderer` |
| `src/plugins/parser/json-plugin.ts` | 改为 `import { parseJson }` + `import JsonRenderer` |
| `src/plugins/parser/log-plugin.ts` | **新增**：`import { parseLog }` + `import LogRenderer`，接管 `.log` |
| `src/plugins/manifest.ts` | 注册 `logPlugin` |
| `src/plugins/types.ts` | `ParsedResult.type` 增加 `'log'` |
| `src/adapters/types.ts` | `ParsedContent.type` 增加 `'log'` |

### 3.4 不动文件

- `src/plugins/registry.ts`（接口不变）
- `src/plugins/compression/*`
- `src/components/workspace/PreviewPane.vue`（已用 `getComponent()` 动态挂载，接口兼容）
- `src/composables/*`、`src/stores/*`、`src/adapters/*`（除类型扩展）

## 4. 数据流与接口契约

### 4.1 数据流（上游不变）

点击文件树节点 → `openTab` → 异步读取文件字节 → `registry.getParser(ext).parse(bytes)` → `ParsedResult` 存入 `tab.content` → `PreviewPane.vue:24` 执行：

```vue
<component :is="plugin.getComponent()" :content="tab.content.data" />
```

新渲染器**只依赖 `content` prop**，其余配置（字号、换行、表头固定等）内置默认值，符合"仅渲染区、无工具栏传参"。

### 4.2 类型扩展

```ts
// src/plugins/types.ts — ParsedResult
{ type: 'text' | 'csv' | 'json' | 'hex' | 'log', data: any, lineCount?: number }

// src/adapters/types.ts — ParsedContent 同步增加 'log'
```

### 4.3 LogLine 类型（`src/core/parsers/types.ts`）

基于 `data/sample.log` 的 `时间戳 [级别] [模块] 消息` 格式：

```ts
export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'
export interface LogLine {
  lineNumber: number
  timestamp: string    // "2026-06-30 12:00:00"
  level: LogLevel
  module: string       // "main"
  message: string      // "应用启动，版本 v1.0.0"
  raw: string          // 原始行（解析失败兜底）
}
```

### 4.4 各渲染器 props 契约

| 渲染器 | `content` 类型 | 说明 |
|---|---|---|
| `TextRenderer` | `string` | UTF-8 文本 |
| `CsvRenderer` | `{ headers: string[]; rows: string[][] }` | 表格数据 |
| `JsonRenderer` | `unknown` | 已解析 JS 对象 |
| `LogRenderer` | `LogLine[]` | 解析后的日志行 |

### 4.5 兜底机制

- `log-parser` 单行解析失败不抛异常，归 `level='OTHER'`、`timestamp/module` 置空、`raw` 保留原文。
- 整体 `parse` 抛异常时复用 `registry.safeParse`（`registry.ts:77`）回退 `hex`。

## 5. 渲染器展示设计

**通用规范（4 个共享）：** 等宽字体 JetBrains Mono、14px、深色背景、横向滚动、`content` 为空时用 `NEmpty`、遵循 `design.md` 色彩语义（ERROR=#EF4444、WARN=#F59E0B、INFO=#3B82F6、SUCCESS=#10B981）。

### 5.1 TextRenderer

- 行号列（右对齐、灰色、`user-select:none`）。
- `white-space: pre` 默认不换行，横向滚动。
- 纯静态，无交互。

### 5.2 CsvRenderer

- `<table>` 表头 `position: sticky; top: 0` 固定、`border-collapse`、边框。
- 表头深色背景、等宽字体。
- 横向 + 纵向滚动。
- 纯静态。

### 5.3 JsonRenderer

- 递归组件渲染（内部 `JsonNode`），不直接 `JSON.stringify` 成 pre。
- 语法着色：键名浅蓝、字符串绿、数字橙、布尔紫、`null` 灰。
- 节点可折叠（点击 `▾/▸` 切换，渲染区内交互，默认全展开）。
- 对象/数组显示子项计数。

### 5.4 LogRenderer（核心新增）

- 分列布局：`行号 | 时间戳 | 级别标签 | 模块 | 消息`。
- 级别标签按 `design.md` 配色：

| 级别 | 色值 |
|---|---|
| INFO | `#3B82F6` 蓝 |
| WARN | `#F59E0B` 黄 |
| ERROR | `#EF4444` 红 |
| DEBUG | 灰 |
| OTHER | 默认 |

- 时间戳灰色、模块名稍亮、消息默认色。
- `OTHER` 行（无法解析）合并显示 `raw`。
- 纯静态。

## 6. log-parser 解析逻辑

基于 `data/sample.log` 的统一格式 `时间戳 [级别] [模块] 消息`。

### 6.1 正则

```ts
const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*\[([\w-]+)\]\s*(.*)$/
```

### 6.2 算法

1. `new TextDecoder('utf-8').decode(data)` → 文本。
2. `split('\n')` 逐行处理，记录 `lineNumber`（从 1 起）。
3. 每行 `match(LOG_RE)`：
   - 成功 → `{ lineNumber, timestamp: m[1], level: normalizeLevel(m[2]), module: m[3], message: m[4], raw: 原行 }`。
   - 失败 → `{ lineNumber, timestamp: '', level: 'OTHER', module: '', message: '', raw: 原行 }`。
4. `normalizeLevel(s)`: `s` ∈ `{INFO, DEBUG, WARN, ERROR}` 原样返回，否则 → `'OTHER'`。

### 6.3 返回

```ts
{ type: 'log', data: LogLine[], lineCount: lines.length }
```

## 7. 接线模式

插件文件改为薄接线层，以 `text-plugin.ts` 与新增 `log-plugin.ts` 为模板，csv/json 同理：

```ts
// src/plugins/parser/text-plugin.ts（改造后）
import type { IFileParserPlugin } from '../types'
import { parseText } from '@/core/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'], // 移除 .log
  canParse(file) { return this.supportedExtensions.some(ext => file.name.endsWith(ext)) },
  async parse(data) { return parseText(data) },
  getComponent() { return TextRenderer },
}
```

```ts
// src/plugins/parser/log-plugin.ts（新增）
import type { IFileParserPlugin } from '../types'
import { parseLog } from '@/core/parsers/log-parser'
import LogRenderer from '@/views/renderers/LogRenderer.vue'

export const logPlugin: IFileParserPlugin = {
  name: 'log',
  supportedExtensions: ['.log'],
  canParse(file) { return this.supportedExtensions.some(ext => file.name.endsWith(ext)) },
  async parse(data) { return parseLog(data) },
  getComponent() { return LogRenderer },
}
```

`manifest.ts` 增加 `registry.registerParser(logPlugin)`。`getConfigSchema()` 暂不接入（符合"仅渲染区"）。

## 8. 测试策略

遵循现有 `src/__tests__/` + vitest 风格。解析层为纯函数，覆盖率高；渲染层至少覆盖 `LogRenderer`。

| 测试文件 | 重点用例 |
|---|---|
| `src/__tests__/core/parsers/text-parser.test.ts` | UTF-8 解码、行计数、空文件 |
| `src/__tests__/core/parsers/csv-parser.test.ts` | 分隔符、空行过滤、单行 |
| `src/__tests__/core/parsers/json-parser.test.ts` | 对象、JSONL、非法 JSON 抛错 |
| `src/__tests__/core/parsers/log-parser.test.ts` | 正常行解析、不匹配行归 `OTHER`、空文件、混合行、级别归一 |
| `src/__tests__/views/renderers/LogRenderer.spec.ts` | mount + `LogLine[]` 渲染断言（级别配色） |

命令：`npm test` 或 `npx vitest run <file>`。

## 9. 扩展流程（新增文件格式）

新增一种文件格式（如 `.xml`）的完整步骤：

1. 在 `src/core/parsers/` 新增 `xml-parser.ts`（纯解析函数）。
2. 在 `src/views/renderers/` 新增 `XmlRenderer.vue`（接收 `content` prop）。
3. 在 `src/plugins/parser/` 新增 `xml-plugin.ts`（import 上述两者，实现 `IFileParserPlugin`）。
4. 在 `src/plugins/manifest.ts` 注册。
5. 若需新类型，扩展 `ParsedResult.type` / `ParsedContent.type` 与 `core/parsers/types.ts`。
6. **核心代码零修改。**

## 10. 验收标准

1. 拖拽 `data.zip` 上传 → 解压 → 文件树显示 4 个 sample 文件。
2. 点击 `sample.csv` → 表格渲染（表头固定）。
3. 点击 `sample.json` → 递归渲染 + 语法着色 + 节点可折叠。
4. 点击 `sample.log` → 结构化分列 + 级别着色（INFO/WARN/ERROR/DEBUG 各色）。
5. 点击 `sample.txt` → 行号 + 等宽纯文本。
6. `npm run typecheck` 通过。
7. `npm test` 全部通过，新增测试覆盖解析层与 `LogRenderer`。
8. 现有 `PreviewPane.vue`、`registry.ts`、composables 无改动。
