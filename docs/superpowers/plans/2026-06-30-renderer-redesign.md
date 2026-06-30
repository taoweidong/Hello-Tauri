# 4 渲染页面重新设计 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 4 个文件解析插件（text/csv/json/hex）中内联的解析逻辑与渲染组件拆分，为 csv/json/log/txt 各提供独立 `.vue` 渲染页面 + 纯函数解析层，并新增 `log-plugin` 接管 `.log` 文件实现结构化着色。

**架构：** 解析逻辑抽为纯函数置于 `src/core/parsers/`（无 Vue 依赖、可独立单测）；渲染页面置于 `src/views/renderers/`（仅依赖 `content` prop）；插件文件 `src/plugins/parser/` 改为薄接线层（import 解析函数 + import 渲染组件）。插件接口 `IFileParserPlugin` 不变，`PreviewPane.vue`/`registry.ts`/composables 零改动。

**技术栈：** Vue 3.5 `<script setup lang="ts">` + Composition API、Naive UI（NEmpty）、TypeScript 6、Vitest 4 + @vue/test-utils 2 + jsdom、JetBrains Mono 等宽字体。

**关联规格：** `docs/superpowers/specs/2026-06-30-renderer-redesign-design.md`（已批准）

---

## 文件结构总览

### 新增文件（12 个）

| 文件 | 职责 |
|---|---|
| `src/core/parsers/types.ts` | `LogLevel` / `LogLine` 共享类型 |
| `src/core/parsers/text-parser.ts` | `parseText(data)` → `ParsedResult` |
| `src/core/parsers/csv-parser.ts` | `parseCsv(text, delimiter)` → `ParsedResult` + `CsvData` |
| `src/core/parsers/json-parser.ts` | `parseJson(text)` → `ParsedResult`（兼容 JSONL） |
| `src/core/parsers/log-parser.ts` | `parseLog(data)` → `ParsedResult` |
| `src/core/parsers/index.ts` | 统一导出解析函数与类型 |
| `src/views/renderers/TextRenderer.vue` | 纯文本：行号 + 等宽 + 不换行 |
| `src/views/renderers/CsvRenderer.vue` | 表格：sticky 表头 + 边框 |
| `src/views/renderers/JsonNode.vue` | JSON 递归子组件（语法着色 + 可折叠） |
| `src/views/renderers/JsonRenderer.vue` | JSON 渲染容器（挂载 JsonNode） |
| `src/views/renderers/LogRenderer.vue` | 日志：结构化分列 + 级别着色 |
| `src/views/renderers/index.ts` | 统一导出 4 个渲染器 |

> **注：** 规格文件清单列 11 个新文件，本计划补充 `JsonNode.vue`（规格 5.3 所述"内部 JsonNode 递归组件"），因 SFC 递归需独立组件文件以支持自引用与可折叠交互。总计 12 个新文件。

### 修改文件（5 个 + 2 处类型扩展 + 1 处测试更新）

| 文件 | 改动 |
|---|---|
| `src/plugins/types.ts` | `ParsedResult.type` 增加 `'log'` |
| `src/adapters/types.ts` | `ParsedContent.type` 增加 `'log'` |
| `src/plugins/parser/text-plugin.ts` | 改薄接线层；`supportedExtensions` 移除 `.log` |
| `src/plugins/parser/csv-plugin.ts` | 改薄接线层 |
| `src/plugins/parser/json-plugin.ts` | 改薄接线层 |
| `src/plugins/parser/log-plugin.ts` | **新增**：接管 `.log` |
| `src/plugins/manifest.ts` | 注册 `logPlugin` |
| `src/__tests__/plugins/text-plugin.test.ts` | 更新 `.log` 断言（`.log` 改由 logPlugin 接管） |

### 新增测试文件（5 个）

| 文件 | 重点 |
|---|---|
| `src/__tests__/core/parsers/text-parser.test.ts` | UTF-8 解码、行计数、空文件、CJK |
| `src/__tests__/core/parsers/csv-parser.test.ts` | 分隔符、空行过滤、单行、空文本 |
| `src/__tests__/core/parsers/json-parser.test.ts` | 对象、数组、JSONL、非法 JSON 抛错 |
| `src/__tests__/core/parsers/log-parser.test.ts` | 正常行、不匹配行归 OTHER、空文件、混合行、级别归一 |
| `src/__tests__/views/renderers/LogRenderer.spec.ts` | mount + `LogLine[]` 渲染断言（级别配色） |

### 不动文件

`src/plugins/registry.ts`、`src/plugins/compression/*`、`src/components/workspace/PreviewPane.vue`、`src/composables/*`、`src/stores/*`、`src/adapters/*`（除类型扩展）、`hex-plugin.ts`（兜底不变）。

---

## 任务依赖图

```
任务1(类型) ─┬─→ 任务2(parser types) ─→ 任务6(log-parser)
              ├─→ 任务3(text-parser)
              ├─→ 任务4(csv-parser)
              └─→ 任务5(json-parser)
任务2,3,4,5,6 ─→ 任务7(parser index)
任务7 ─┬─→ 任务8(TextRenderer) ─→ 任务13(接线 text)
        ├─→ 任务9(CsvRenderer) ─→ 任务14(接线 csv)
        ├─→ 任务10(JsonNode+JsonRenderer) ─→ 任务15(接线 json)
        └─→ 任务11(LogRenderer+测试) ─→ 任务16(接线 log+manifest)
任务8-16 ─→ 任务12(renderer index) → 任务17(全量验证)
```

---

## 阶段 A：类型与解析层（纯函数）

### 任务 1：扩展 ParsedResult 与 ParsedContent 类型

**文件：**
- 修改：`src/plugins/types.ts:33`
- 修改：`src/adapters/types.ts:49`

- [ ] **步骤 1：扩展 `ParsedResult.type`**

`src/plugins/types.ts:32-36` 改为：

```ts
export interface ParsedResult {
  type: 'text' | 'csv' | 'json' | 'hex' | 'log'
  data: any
  lineCount?: number
}
```

- [ ] **步骤 2：扩展 `ParsedContent.type`**

`src/adapters/types.ts:48-54` 改为：

```ts
export interface ParsedContent {
  type: 'text' | 'csv' | 'json' | 'hex' | 'log'
  data: any
  lineCount?: number
  loadTimeMs?: number
  pluginName: string
}
```

- [ ] **步骤 3：typecheck 验证**

运行：`npm run typecheck`
预期：PASS（仅扩展联合类型，不破坏现有赋值）

- [ ] **步骤 4：Commit**

```bash
git add src/plugins/types.ts src/adapters/types.ts
git commit -m "refactor: ParsedResult/ParsedContent 类型扩展增加 log"
```

---

### 任务 2：创建 core/parsers/types.ts（LogLine / LogLevel）

**文件：**
- 创建：`src/core/parsers/types.ts`

- [ ] **步骤 1：编写类型文件**

```ts
export type LogLevel = 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'OTHER'

export interface LogLine {
  lineNumber: number
  timestamp: string
  level: LogLevel
  module: string
  message: string
  raw: string
}
```

- [ ] **步骤 2：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/core/parsers/types.ts
git commit -m "feat(core): 新增 LogLine/LogLevel 共享类型"
```

---

### 任务 3：text-parser + 测试（TDD）

**文件：**
- 创建：`src/core/parsers/text-parser.ts`
- 测试：`src/__tests__/core/parsers/text-parser.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/__tests__/core/parsers/text-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseText } from '@/core/parsers/text-parser'

describe('parseText', () => {
  it('解码 UTF-8 并计数行数', () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = parseText(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('处理空文件', () => {
    const result = parseText(new Uint8Array(0))
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })

  it('处理中文字符', () => {
    const data = new TextEncoder().encode('你好\n世界')
    const result = parseText(data)
    expect(result.data).toBe('你好\n世界')
    expect(result.lineCount).toBe(2)
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/parsers/text-parser.test.ts`
预期：FAIL，报错 `Failed to resolve import "@/core/parsers/text-parser"`

- [ ] **步骤 3：编写实现**

```ts
// src/core/parsers/text-parser.ts
import type { ParsedResult } from '@/plugins/types'

export function parseText(data: Uint8Array): ParsedResult {
  const text = new TextDecoder('utf-8').decode(data)
  const lineCount = text.length === 0 ? 0 : text.split('\n').length
  return { type: 'text', data: text, lineCount }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/parsers/text-parser.test.ts`
预期：PASS（3 个用例全过）

- [ ] **步骤 5：Commit**

```bash
git add src/core/parsers/text-parser.ts src/__tests__/core/parsers/text-parser.test.ts
git commit -m "feat(core): text-parser 纯函数 + 单测"
```

---

### 任务 4：csv-parser + 测试（TDD）

**文件：**
- 创建：`src/core/parsers/csv-parser.ts`
- 测试：`src/__tests__/core/parsers/csv-parser.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/__tests__/core/parsers/csv-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseCsv } from '@/core/parsers/csv-parser'

describe('parseCsv', () => {
  it('解析表头与数据行', () => {
    const result = parseCsv('name,age\nAlice,30\nBob,25')
    expect(result.type).toBe('csv')
    expect(result.data.headers).toEqual(['name', 'age'])
    expect(result.data.rows).toEqual([['Alice', '30'], ['Bob', '25']])
    expect(result.lineCount).toBe(3)
  })

  it('支持自定义分隔符', () => {
    const result = parseCsv('name\tage\nAlice\t30', '\t')
    expect(result.data.headers).toEqual(['name', 'age'])
  })

  it('过滤空行', () => {
    const result = parseCsv('a,b\n\n1,2')
    expect(result.data.rows).toEqual([['1', '2']])
  })

  it('单行（仅表头）', () => {
    const result = parseCsv('a,b,c')
    expect(result.data.headers).toEqual(['a', 'b', 'c'])
    expect(result.data.rows).toEqual([])
  })

  it('空文本返回空结构', () => {
    const result = parseCsv('')
    expect(result.data.headers).toEqual([])
    expect(result.data.rows).toEqual([])
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/parsers/csv-parser.test.ts`
预期：FAIL，报错 `Failed to resolve import "@/core/parsers/csv-parser"`

- [ ] **步骤 3：编写实现**

```ts
// src/core/parsers/csv-parser.ts
import type { ParsedResult } from '@/plugins/types'

export interface CsvData {
  headers: string[]
  rows: string[][]
}

export function parseCsv(text: string, delimiter = ','): ParsedResult {
  const lines = text.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) {
    return { type: 'csv', data: { headers: [], rows: [] }, lineCount: 1 }
  }
  const headers = lines[0].split(delimiter).map(s => s.trim())
  const rows = lines.slice(1).map(line => line.split(delimiter).map(s => s.trim()))
  return { type: 'csv', data: { headers, rows }, lineCount: rows.length + 1 }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/parsers/csv-parser.test.ts`
预期：PASS（5 个用例全过）

- [ ] **步骤 5：Commit**

```bash
git add src/core/parsers/csv-parser.ts src/__tests__/core/parsers/csv-parser.test.ts
git commit -m "feat(core): csv-parser 纯函数 + 单测"
```

---

### 任务 5：json-parser + 测试（TDD）

**文件：**
- 创建：`src/core/parsers/json-parser.ts`
- 测试：`src/__tests__/core/parsers/json-parser.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/__tests__/core/parsers/json-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseJson } from '@/core/parsers/json-parser'

describe('parseJson', () => {
  it('解析对象', () => {
    const result = parseJson('{"name":"Alice","age":30}')
    expect(result.type).toBe('json')
    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.lineCount).toBeGreaterThan(0)
  })

  it('解析数组', () => {
    const result = parseJson('[1, 2, 3]')
    expect(result.data).toEqual([1, 2, 3])
  })

  it('解析 JSONL（换行分隔对象）', () => {
    const result = parseJson('{"a":1}\n{"b":2}')
    expect(result.data).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('非法 JSON 抛错', () => {
    expect(() => parseJson('{invalid}')).toThrow()
  })

  it('抛错信息含原因', () => {
    try {
      parseJson('{invalid}')
      throw new Error('应抛错')
    } catch (err) {
      expect((err as Error).message).toContain('Invalid JSON')
    }
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/parsers/json-parser.test.ts`
预期：FAIL，报错 `Failed to resolve import "@/core/parsers/json-parser"`

- [ ] **步骤 3：编写实现**

```ts
// src/core/parsers/json-parser.ts
import type { ParsedResult } from '@/plugins/types'

export function parseJson(text: string): ParsedResult {
  const isJsonl = text.trimStart().startsWith('{') && text.includes('\n')
  let parsed: unknown
  try {
    if (isJsonl) {
      parsed = text.split('\n').filter(l => l.trim()).map(line => JSON.parse(line))
    } else {
      parsed = JSON.parse(text)
    }
  } catch (err) {
    throw new Error(`Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`)
  }
  const formatted = JSON.stringify(parsed, null, 2)
  return { type: 'json', data: parsed, lineCount: formatted.split('\n').length }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/parsers/json-parser.test.ts`
预期：PASS（5 个用例全过）

- [ ] **步骤 5：Commit**

```bash
git add src/core/parsers/json-parser.ts src/__tests__/core/parsers/json-parser.test.ts
git commit -m "feat(core): json-parser 纯函数 + 单测（兼容 JSONL）"
```

---

### 任务 6：log-parser + 测试（TDD）

**文件：**
- 创建：`src/core/parsers/log-parser.ts`
- 测试：`src/__tests__/core/parsers/log-parser.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/__tests__/core/parsers/log-parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseLog } from '@/core/parsers/log-parser'

describe('parseLog', () => {
  it('解析正常日志行', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [INFO] [main] 应用启动')
    const result = parseLog(data)
    expect(result.type).toBe('log')
    expect(result.data).toHaveLength(1)
    expect(result.data[0]).toEqual({
      lineNumber: 1,
      timestamp: '2026-06-30 12:00:00',
      level: 'INFO',
      module: 'main',
      message: '应用启动',
      raw: '2026-06-30 12:00:00 [INFO] [main] 应用启动',
    })
    expect(result.lineCount).toBe(1)
  })

  it('不匹配行归 OTHER 并保留 raw', () => {
    const data = new TextEncoder().encode('这不是日志格式')
    const result = parseLog(data)
    expect(result.data[0].level).toBe('OTHER')
    expect(result.data[0].timestamp).toBe('')
    expect(result.data[0].module).toBe('')
    expect(result.data[0].raw).toBe('这不是日志格式')
  })

  it('空文件返回空数组', () => {
    const result = parseLog(new Uint8Array(0))
    expect(result.data).toEqual([])
    expect(result.lineCount).toBe(0)
  })

  it('混合行（正常 + 异常）', () => {
    const text = '2026-06-30 12:00:00 [ERROR] [api] 404\n乱码行\n2026-06-30 12:00:01 [WARN] [auth] 失败'
    const result = parseLog(new TextEncoder().encode(text))
    expect(result.data).toHaveLength(3)
    expect(result.data[0].level).toBe('ERROR')
    expect(result.data[1].level).toBe('OTHER')
    expect(result.data[2].level).toBe('WARN')
    expect(result.data[1].lineNumber).toBe(2)
  })

  it('未知级别归 OTHER', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [TRACE] [x] y')
    const result = parseLog(data)
    expect(result.data[0].level).toBe('OTHER')
  })

  it('模块名含连字符', () => {
    const data = new TextEncoder().encode('2026-06-30 12:00:00 [INFO] [user-service] ok')
    const result = parseLog(data)
    expect(result.data[0].module).toBe('user-service')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/core/parsers/log-parser.test.ts`
预期：FAIL，报错 `Failed to resolve import "@/core/parsers/log-parser"`

- [ ] **步骤 3：编写实现**

```ts
// src/core/parsers/log-parser.ts
import type { ParsedResult } from '@/plugins/types'
import type { LogLine, LogLevel } from './types'

const LOG_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s*\[([\w-]+)\]\s*(.*)$/

function normalizeLevel(s: string): LogLevel {
  if (s === 'INFO' || s === 'DEBUG' || s === 'WARN' || s === 'ERROR') return s
  return 'OTHER'
}

export function parseLog(data: Uint8Array): ParsedResult {
  const text = new TextDecoder('utf-8').decode(data)
  const lines = text.length === 0 ? [] : text.split('\n')
  const result: LogLine[] = lines.map((line, i) => {
    const m = line.match(LOG_RE)
    if (m) {
      return {
        lineNumber: i + 1,
        timestamp: m[1],
        level: normalizeLevel(m[2]),
        module: m[3],
        message: m[4],
        raw: line,
      }
    }
    return {
      lineNumber: i + 1,
      timestamp: '',
      level: 'OTHER',
      module: '',
      message: '',
      raw: line,
    }
  })
  return { type: 'log', data: result, lineCount: lines.length }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/core/parsers/log-parser.test.ts`
预期：PASS（6 个用例全过）

- [ ] **步骤 5：Commit**

```bash
git add src/core/parsers/log-parser.ts src/__tests__/core/parsers/log-parser.test.ts
git commit -m "feat(core): log-parser 纯函数 + 单测（结构化日志解析）"
```

---

### 任务 7：core/parsers/index.ts 汇总导出

**文件：**
- 创建：`src/core/parsers/index.ts`

- [ ] **步骤 1：编写导出文件**

```ts
// src/core/parsers/index.ts
export { parseText } from './text-parser'
export { parseCsv } from './csv-parser'
export type { CsvData } from './csv-parser'
export { parseJson } from './json-parser'
export { parseLog } from './log-parser'
export type { LogLine, LogLevel } from './types'
```

- [ ] **步骤 2：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/core/parsers/index.ts
git commit -m "feat(core): parsers 模块统一导出"
```

---

## 阶段 B：渲染层

### 任务 8：TextRenderer.vue

**文件：**
- 创建：`src/views/renderers/TextRenderer.vue`

- [ ] **步骤 1：编写渲染组件**

```vue
<!-- src/views/renderers/TextRenderer.vue -->
<script setup lang="ts">
import { NEmpty } from 'naive-ui'

defineProps<{ content: string }>()
</script>

<template>
  <NEmpty v-if="!content" description="空文件" style="margin-top: 40px;" />
  <div v-else class="text-renderer">
    <div v-for="(line, i) in content.split('\n')" :key="i" class="line">
      <span class="line-no">{{ i + 1 }}</span>
      <span class="line-text">{{ line }}</span>
    </div>
  </div>
</template>

<style scoped>
.text-renderer {
  font-family: "JetBrains Mono", "Fira Code", monospace;
  font-size: 14px;
  white-space: pre;
  overflow: auto;
  height: 100%;
  padding: 8px;
  background: #1a1a2e;
  color: #d4d4d4;
}
.line { display: flex; }
.line-no {
  color: #666;
  min-width: 3em;
  text-align: right;
  padding-right: 1em;
  user-select: none;
}
.line-text { white-space: pre; }
</style>
```

- [ ] **步骤 2：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/views/renderers/TextRenderer.vue
git commit -m "feat(views): TextRenderer 渲染页面"
```

---

### 任务 9：CsvRenderer.vue

**文件：**
- 创建：`src/views/renderers/CsvRenderer.vue`

- [ ] **步骤 1：编写渲染组件**

```vue
<!-- src/views/renderers/CsvRenderer.vue -->
<script setup lang="ts">
import { NEmpty } from 'naive-ui'

defineProps<{ content: { headers: string[]; rows: string[][] } }>()
</script>

<template>
  <NEmpty
    v-if="content.headers.length === 0 && content.rows.length === 0"
    description="空表格"
    style="margin-top: 40px;"
  />
  <div v-else class="csv-renderer">
    <table>
      <thead>
        <tr>
          <th v-for="(h, i) in content.headers" :key="i">{{ h }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in content.rows" :key="ri">
          <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.csv-renderer {
  overflow: auto;
  height: 100%;
  background: #1a1a2e;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 14px;
  font-family: "JetBrains Mono", monospace;
}
th, td {
  border: 1px solid #333;
  padding: 4px 8px;
  color: #d4d4d4;
}
th {
  position: sticky;
  top: 0;
  background: #16213e;
}
</style>
```

- [ ] **步骤 2：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/views/renderers/CsvRenderer.vue
git commit -m "feat(views): CsvRenderer 渲染页面"
```

---

### 任务 10：JsonNode.vue + JsonRenderer.vue

**文件：**
- 创建：`src/views/renderers/JsonNode.vue`（递归子组件）
- 创建：`src/views/renderers/JsonRenderer.vue`（容器）

- [ ] **步骤 1：编写 JsonNode 递归子组件**

```vue
<!-- src/views/renderers/JsonNode.vue -->
<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  node: unknown
  name?: string
  defaultOpen?: boolean
}>()

const open = ref(props.defaultOpen ?? true)

function toggle() {
  open.value = !open.value
}

function typeOf(v: unknown): 'array' | 'object' | 'string' | 'number' | 'boolean' | 'null' | 'other' {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  const t = typeof v
  if (t === 'string' || t === 'number' || t === 'boolean') return t
  if (t === 'object') return 'object'
  return 'other'
}

function entries(v: object): Array<readonly [string, unknown]> {
  if (Array.isArray(v)) return v.map((val, i) => [String(i), val] as const)
  return Object.entries(v).map(([k, val]) => [k, val] as const)
}

function count(v: unknown): number {
  if (Array.isArray(v)) return v.length
  if (v && typeof v === 'object') return Object.keys(v).length
  return 0
}
</script>

<template>
  <div class="json-node">
    <span v-if="name !== undefined" class="json-key">"{{ name }}"</span>
    <span v-if="name !== undefined" class="json-punct">: </span>
    <span v-if="typeOf(node) === 'array'" class="json-punct">[</span>
    <span v-else-if="typeOf(node) === 'object'" class="json-punct">{</span>
    <span
      v-if="typeOf(node) === 'array' || typeOf(node) === 'object'"
      class="toggle"
      @click="toggle"
    >{{ open ? '▾' : '▸' }}</span>
    <span
      v-if="typeOf(node) === 'array' || typeOf(node) === 'object'"
      class="json-count"
    >{{ count(node) }} 项</span>
    <div
      v-if="(typeOf(node) === 'array' || typeOf(node) === 'object') && open"
      class="children"
    >
      <JsonNode
        v-for="[k, v] in entries(node as object)"
        :key="k"
        :name="k"
        :node="v"
        :default-open="defaultOpen"
      />
    </div>
    <span
      v-if="(typeOf(node) === 'array' || typeOf(node) === 'object') && !open"
      class="json-punct"
    >...</span>
    <span v-if="typeOf(node) === 'array'" class="json-punct">]</span>
    <span v-else-if="typeOf(node) === 'object'" class="json-punct">}</span>
    <span v-else-if="typeOf(node) === 'string'" class="json-string">"{{ node }}"</span>
    <span v-else-if="typeOf(node) === 'number'" class="json-number">{{ node }}</span>
    <span v-else-if="typeOf(node) === 'boolean'" class="json-boolean">{{ node }}</span>
    <span v-else-if="typeOf(node) === 'null'" class="json-null">null</span>
  </div>
</template>

<style scoped>
.json-node { padding-left: 1.2em; }
.json-key { color: #93c5fd; }
.json-string { color: #86efac; }
.json-number { color: #fdba74; }
.json-boolean { color: #c4b5fd; }
.json-null { color: #9ca3af; }
.json-punct { color: #d4d4d4; }
.json-count { color: #6b7280; font-size: 0.85em; margin-left: 0.3em; }
.toggle { cursor: pointer; user-select: none; margin: 0 0.2em; }
.children { border-left: 1px dashed #333; margin-left: 0.4em; }
</style>
```

- [ ] **步骤 2：编写 JsonRenderer 容器**

```vue
<!-- src/views/renderers/JsonRenderer.vue -->
<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import JsonNode from './JsonNode.vue'

defineProps<{ content: unknown }>()
</script>

<template>
  <NEmpty
    v-if="content === null || content === undefined"
    description="空内容"
    style="margin-top: 40px;"
  />
  <div v-else class="json-renderer">
    <JsonNode :node="content" :default-open="true" />
  </div>
</template>

<style scoped>
.json-renderer {
  font-family: "JetBrains Mono", monospace;
  font-size: 14px;
  padding: 8px;
  overflow: auto;
  height: 100%;
  background: #1a1a2e;
  color: #d4d4d4;
}
</style>
```

- [ ] **步骤 3：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/views/renderers/JsonNode.vue src/views/renderers/JsonRenderer.vue
git commit -m "feat(views): JsonRenderer + JsonNode 递归渲染（语法着色 + 可折叠）"
```

---

### 任务 11：LogRenderer.vue + 组件测试（TDD）

**文件：**
- 创建：`src/views/renderers/LogRenderer.vue`
- 测试：`src/__tests__/views/renderers/LogRenderer.spec.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
// src/__tests__/views/renderers/LogRenderer.spec.ts
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LogRenderer from '@/views/renderers/LogRenderer.vue'
import type { LogLine } from '@/core/parsers/types'

describe('LogRenderer', () => {
  const lines: LogLine[] = [
    { lineNumber: 1, timestamp: '2026-06-30 12:00:00', level: 'INFO', module: 'main', message: '应用启动', raw: '原始1' },
    { lineNumber: 2, timestamp: '2026-06-30 12:00:10', level: 'WARN', module: 'auth', message: '登录失败', raw: '原始2' },
    { lineNumber: 3, timestamp: '2026-06-30 12:00:30', level: 'ERROR', module: 'api', message: '404', raw: '原始3' },
    { lineNumber: 4, timestamp: '', level: 'OTHER', module: '', message: '', raw: '乱码行' },
  ]

  it('渲染所有日志行', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    expect(wrapper.findAll('.log-line')).toHaveLength(4)
  })

  it('显示行号', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const nos = wrapper.findAll('.col-no').map(n => n.text())
    expect(nos).toEqual(['1', '2', '3', '4'])
  })

  it('INFO 级别应用蓝色', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const level = wrapper.findAll('.col-level')[0]
    expect(level.text()).toBe('INFO')
    expect(level.attributes('style')).toContain('color: rgb(59, 130, 246)')
  })

  it('ERROR 级别应用红色', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const level = wrapper.findAll('.col-level')[2]
    expect(level.text()).toBe('ERROR')
    expect(level.attributes('style')).toContain('color: rgb(239, 68, 68)')
  })

  it('OTHER 行显示 raw 而非 message', () => {
    const wrapper = mount(LogRenderer, { props: { content: lines } })
    const msg = wrapper.findAll('.col-msg')[3]
    expect(msg.text()).toBe('乱码行')
  })

  it('空日志显示 NEmpty', () => {
    const wrapper = mount(LogRenderer, { props: { content: [] } })
    expect(wrapper.text()).toContain('空日志')
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npx vitest run src/__tests__/views/renderers/LogRenderer.spec.ts`
预期：FAIL，报错 `Failed to resolve import "@/views/renderers/LogRenderer.vue"`

- [ ] **步骤 3：编写实现**

```vue
<!-- src/views/renderers/LogRenderer.vue -->
<script setup lang="ts">
import { NEmpty } from 'naive-ui'
import type { LogLine, LogLevel } from '@/core/parsers/types'

defineProps<{ content: LogLine[] }>()

const levelColor: Record<LogLevel, string> = {
  INFO: '#3B82F6',
  WARN: '#F59E0B',
  ERROR: '#EF4444',
  DEBUG: '#9ca3af',
  OTHER: '#d4d4d4',
}
</script>

<template>
  <NEmpty v-if="content.length === 0" description="空日志" style="margin-top: 40px;" />
  <div v-else class="log-renderer">
    <div v-for="line in content" :key="line.lineNumber" class="log-line">
      <span class="col-no">{{ line.lineNumber }}</span>
      <span class="col-ts">{{ line.timestamp }}</span>
      <span class="col-level" :style="{ color: levelColor[line.level] }">{{ line.level }}</span>
      <span class="col-mod">{{ line.module }}</span>
      <span v-if="line.level === 'OTHER'" class="col-msg">{{ line.raw }}</span>
      <span v-else class="col-msg">{{ line.message }}</span>
    </div>
  </div>
</template>

<style scoped>
.log-renderer {
  font-family: "JetBrains Mono", monospace;
  font-size: 14px;
  padding: 8px;
  overflow: auto;
  height: 100%;
  background: #1a1a2e;
  color: #d4d4d4;
}
.log-line {
  display: flex;
  gap: 1em;
  padding: 1px 0;
  white-space: pre;
}
.col-no {
  color: #666;
  min-width: 3em;
  text-align: right;
  user-select: none;
}
.col-ts { color: #6b7280; }
.col-level { font-weight: 600; min-width: 5em; }
.col-mod { color: #93c5fd; min-width: 8em; }
.col-msg { flex: 1; }
</style>
```

- [ ] **步骤 4：运行测试验证通过**

运行：`npx vitest run src/__tests__/views/renderers/LogRenderer.spec.ts`
预期：PASS（6 个用例全过）

> **若颜色断言失败：** jsdom 可能将 `#3B82F6` 序列化为 `rgb(59, 130, 246)` 或保留 `#3B82F6`。若断言不匹配，改用 `expect(level.attributes('style')).toMatch(/#3B82F6|rgb\(59, 130, 246\)/)`。

- [ ] **步骤 5：Commit**

```bash
git add src/views/renderers/LogRenderer.vue src/__tests__/views/renderers/LogRenderer.spec.ts
git commit -m "feat(views): LogRenderer 渲染页面 + 组件测试（级别配色）"
```

---

### 任务 12：views/renderers/index.ts 汇总导出

**文件：**
- 创建：`src/views/renderers/index.ts`

- [ ] **步骤 1：编写导出文件**

```ts
// src/views/renderers/index.ts
export { default as TextRenderer } from './TextRenderer.vue'
export { default as CsvRenderer } from './CsvRenderer.vue'
export { default as JsonRenderer } from './JsonRenderer.vue'
export { default as LogRenderer } from './LogRenderer.vue'
```

- [ ] **步骤 2：typecheck 验证**

运行：`npm run typecheck`
预期：PASS

- [ ] **步骤 3：Commit**

```bash
git add src/views/renderers/index.ts
git commit -m "feat(views): renderers 模块统一导出"
```

---

## 阶段 C：接线层

### 任务 13：改造 text-plugin + 更新现有测试

**文件：**
- 修改：`src/plugins/parser/text-plugin.ts`（整体替换为薄接线层）
- 修改：`src/__tests__/plugins/text-plugin.test.ts`（`.log` 断言更新）

- [ ] **步骤 1：改造 text-plugin.ts 为薄接线层**

```ts
// src/plugins/parser/text-plugin.ts
import type { IFileParserPlugin } from '../types'
import { parseText } from '@/core/parsers/text-parser'
import TextRenderer from '@/views/renderers/TextRenderer.vue'

export const textPlugin: IFileParserPlugin = {
  name: 'text',
  supportedExtensions: ['.txt', '.md', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    return parseText(data)
  },
  getComponent() {
    return TextRenderer
  },
}
```

> **关键：** `supportedExtensions` 移除 `.log`（改由任务 16 的 logPlugin 接管）。

- [ ] **步骤 2：更新 text-plugin.test.ts（.log 不再属于 textPlugin）**

```ts
// src/__tests__/plugins/text-plugin.test.ts
import { describe, it, expect } from 'vitest'
import { textPlugin } from '@/plugins/parser/text-plugin'
import type { FileEntry } from '@/adapters/types'

describe('textPlugin', () => {
  const file: FileEntry = { name: 'notes.txt', path: '/notes.txt', size: 100, isDirectory: false }

  it('canParse 对 .txt 返回 true，对 .log 返回 false（已交由 logPlugin）', () => {
    expect(textPlugin.canParse(file)).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'app.log' })).toBe(false)
    expect(textPlugin.canParse({ ...file, name: 'image.png' })).toBe(false)
  })

  it('parse 返回文本内容与行数', async () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('parse 处理空文件', async () => {
    const data = new Uint8Array(0)
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })
})
```

- [ ] **步骤 3：运行测试验证通过**

运行：`npx vitest run src/__tests__/plugins/text-plugin.test.ts`
预期：PASS（3 个用例全过，`.log` 现返回 false）

- [ ] **步骤 4：Commit**

```bash
git add src/plugins/parser/text-plugin.ts src/__tests__/plugins/text-plugin.test.ts
git commit -m "refactor(plugins): text-plugin 改为薄接线层，移除 .log 支持"
```

---

### 任务 14：改造 csv-plugin

**文件：**
- 修改：`src/plugins/parser/csv-plugin.ts`（整体替换）

- [ ] **步骤 1：改造 csv-plugin.ts 为薄接线层**

```ts
// src/plugins/parser/csv-plugin.ts
import type { IFileParserPlugin, ConfigSchema } from '../types'
import { parseCsv } from '@/core/parsers/csv-parser'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

export const csvPlugin: IFileParserPlugin = {
  name: 'csv',
  supportedExtensions: ['.csv', '.tsv'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array, options?: Record<string, any>) {
    const text = new TextDecoder('utf-8').decode(data)
    const delimiter = options?.delimiter ?? ','
    return parseCsv(text, delimiter)
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

- [ ] **步骤 2：运行现有 csv-plugin 测试验证不破坏**

运行：`npx vitest run src/__tests__/plugins/csv-plugin.test.ts`
预期：PASS（4 个现有用例全过；行为不变）

- [ ] **步骤 3：Commit**

```bash
git add src/plugins/parser/csv-plugin.ts
git commit -m "refactor(plugins): csv-plugin 改为薄接线层"
```

---

### 任务 15：改造 json-plugin

**文件：**
- 修改：`src/plugins/parser/json-plugin.ts`（整体替换）

- [ ] **步骤 1：改造 json-plugin.ts 为薄接线层**

```ts
// src/plugins/parser/json-plugin.ts
import type { IFileParserPlugin } from '../types'
import { parseJson } from '@/core/parsers/json-parser'
import JsonRenderer from '@/views/renderers/JsonRenderer.vue'

export const jsonPlugin: IFileParserPlugin = {
  name: 'json',
  supportedExtensions: ['.json', '.jsonl'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    const text = new TextDecoder('utf-8').decode(data)
    return parseJson(text)
  },
  getComponent() {
    return JsonRenderer
  },
}
```

- [ ] **步骤 2：运行现有 json-plugin 测试验证不破坏**

运行：`npx vitest run src/__tests__/plugins/json-plugin.test.ts`
预期：PASS（4 个现有用例全过；行为不变）

- [ ] **步骤 3：Commit**

```bash
git add src/plugins/parser/json-plugin.ts
git commit -m "refactor(plugins): json-plugin 改为薄接线层"
```

---

### 任务 16：新增 log-plugin + manifest 注册

**文件：**
- 创建：`src/plugins/parser/log-plugin.ts`
- 修改：`src/plugins/manifest.ts`

- [ ] **步骤 1：编写 log-plugin.ts**

```ts
// src/plugins/parser/log-plugin.ts
import type { IFileParserPlugin } from '../types'
import { parseLog } from '@/core/parsers/log-parser'
import LogRenderer from '@/views/renderers/LogRenderer.vue'

export const logPlugin: IFileParserPlugin = {
  name: 'log',
  supportedExtensions: ['.log'],
  canParse(file) {
    return this.supportedExtensions.some(ext => file.name.endsWith(ext))
  },
  async parse(data: Uint8Array) {
    return parseLog(data)
  },
  getComponent() {
    return LogRenderer
  },
}
```

- [ ] **步骤 2：在 manifest.ts 注册 logPlugin**

`src/plugins/manifest.ts` 整体替换为：

```ts
// src/plugins/manifest.ts
import type { PluginRegistry } from './registry'
import { zipPlugin } from './compression/zip-plugin'
import { gzipPlugin } from './compression/gzip-plugin'
import { textPlugin } from './parser/text-plugin'
import { csvPlugin } from './parser/csv-plugin'
import { jsonPlugin } from './parser/json-plugin'
import { hexPlugin } from './parser/hex-plugin'
import { logPlugin } from './parser/log-plugin'

export function registerBuiltinPlugins(registry: PluginRegistry): void {
  registry.registerCompression(zipPlugin)
  registry.registerCompression(gzipPlugin)

  registry.registerParser(textPlugin)
  registry.registerParser(csvPlugin)
  registry.registerParser(jsonPlugin)
  registry.registerParser(logPlugin)
  registry.registerParser(hexPlugin)
}
```

> **注册顺序：** `logPlugin` 在 `hexPlugin` 之前（hexPlugin.canParse 兜底所有文件，应最后注册；logPlugin 精确匹配 `.log` 优先）。

- [ ] **步骤 3：运行 registry 测试验证不破坏**

运行：`npx vitest run src/__tests__/plugins/registry.test.ts`
预期：PASS

- [ ] **步骤 4：Commit**

```bash
git add src/plugins/parser/log-plugin.ts src/plugins/manifest.ts
git commit -m "feat(plugins): 新增 log-plugin 接管 .log + manifest 注册"
```

---

## 阶段 D：全量验证

### 任务 17：typecheck + 全量测试 + 验收

- [ ] **步骤 1：类型检查**

运行：`npm run typecheck`
预期：PASS，无错误

- [ ] **步骤 2：全量测试**

运行：`npm test`
预期：PASS，所有测试套件通过，包括：
- 新增 `src/__tests__/core/parsers/{text,csv,json,log}-parser.test.ts`
- 新增 `src/__tests__/views/renderers/LogRenderer.spec.ts`
- 现有 `src/__tests__/plugins/{text,csv,json,hex,registry}-plugin.test.ts`（text-plugin 测试已更新）
- 其余现有测试不受影响

- [ ] **步骤 3：手动验收（桌面端）**

运行：`npm run tauri:dev`
验收清单（对照规格 §10）：
1. 拖拽 `data.zip` 上传 → 解压 → 文件树显示 4 个 sample 文件
2. 点击 `sample.csv` → 表格渲染（表头 sticky 固定）
3. 点击 `sample.json` → 递归渲染 + 语法着色 + 节点可点击折叠
4. 点击 `sample.log` → 结构化分列 + 级别着色（INFO 蓝/WARN 黄/ERROR 红/DEBUG 灰）
5. 点击 `sample.txt` → 行号 + 等宽纯文本
6. 无 console 报错

- [ ] **步骤 4：确认未动文件**

运行：`git diff --stat main -- src/plugins/registry.ts src/components/workspace/PreviewPane.vue src/composables/ src/stores/ src/adapters/`
预期：无输出（这些文件零改动）

- [ ] **步骤 5：最终 Commit（若有遗漏修复）**

若步骤 1-4 发现任何问题需修复，修复后 commit；若全部通过则无需额外 commit。

---

## 自检结果

### 1. 规格覆盖度

逐节对照规格 `2026-06-30-renderer-redesign-design.md`：

| 规格章节 | 覆盖任务 |
|---|---|
| §1 概述（4 渲染页面 + 解析分离 + log 特化 + 接口不变 + 易扩展） | 任务 3-16 |
| §2 范围（新增 views/core、改造插件、类型扩展、测试；排除工具栏/迁移/虚拟滚动） | 全部任务，无非目标项 |
| §3.1 目录规划（views/core 扁平分离） | 任务 7、12 |
| §3.2 新增 11 文件 | 任务 2-12（补充 JsonNode.vue 共 12 文件，已在文件结构总览注明） |
| §3.3 修改 5 文件 + 2 类型扩展 | 任务 1、13-16 |
| §3.4 不动文件 | 任务 17 步骤 4 验证 |
| §4.1 数据流（content prop 单一依赖） | 任务 8-11 渲染器均仅 defineProps content |
| §4.2 类型扩展 | 任务 1 |
| §4.3 LogLine 类型 | 任务 2 |
| §4.4 props 契约 | 任务 8-11 |
| §4.5 兜底（单行 OTHER / 整体 safeParse 回退 hex） | 任务 6（OTHER）；safeParse 不动（registry 未改） |
| §5.1-5.4 渲染器设计 | 任务 8-11 |
| §6 log-parser 正则/算法/返回 | 任务 6 |
| §7 接线模式 | 任务 13-16 |
| §8 测试策略 | 任务 3-6、11 |
| §9 扩展流程 | 文件结构总览已体现模式 |
| §10 验收标准 | 任务 17 |

**遗漏补丁：** 规格第 8 节测试策略未提及现有 `text-plugin.test.ts` 因 `.log` 移除而破坏。本计划任务 13 步骤 2 显式更新该测试（`.log` 断言由 true 改 false），填补规格缺口。

### 2. 占位符扫描

- 无 "TODO/待定/后续实现"
- 无 "添加适当错误处理" 等模糊描述
- 所有代码步骤均含完整代码块
- 无 "类似任务 N" 引用

### 3. 类型一致性

- `LogLevel` 在任务 2（types.ts）、任务 6（log-parser import）、任务 11（LogRenderer import）一致
- `LogLine` 字段（lineNumber/timestamp/level/module/message/raw）在任务 2、6、11 一致
- `ParsedResult.type` 联合 `'log'` 在任务 1 扩展，任务 3-6 返回值使用，一致
- `parseCsv` 返回 `CsvData` 在任务 4 定义、任务 14 接线使用，`content: { headers, rows }` 在任务 9 CsvRenderer 一致
- `parseJson` 返回 `unknown` → 任务 10 JsonRenderer `content: unknown` 一致
- `parseText` 返回 `data: string` → 任务 8 TextRenderer `content: string` 一致
- `parseLog` 返回 `data: LogLine[]` → 任务 11 LogRenderer `content: LogLine[]` 一致
- `levelColor` 键为 LogLevel 五值，与任务 2 定义一致
- 颜色值：INFO=#3B82F6、WARN=#F59E0B、ERROR=#EF4444（规格 §5.4），任务 11 一致；DEBUG=灰 #9ca3af、OTHER=#d4d4d4

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-30-renderer-redesign.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

**选哪种方式？**
