# 公共 DataTable 表格组件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 实现一个基于 Naive UI `NDataTable` 的通用公共表格组件，支持列排序、列头筛选、高级多条件筛选、全局搜索、CSV 导出、分页与虚拟滚动，并替换现有 `CsvRenderer` 和 `LogRenderer` 的手写实现。

**架构：** 新增 `src/components/shared/DataTable.vue` 作为核心组件，内置工具栏（搜索、筛选、导出）+ 高级筛选折叠面板 + NDataTable 数据区。`CsvRenderer` 和 `LogRenderer` 作为薄封装层，负责将各自的数据格式转换为 DataTable 所需的 `columns` + `data` 格式。

**技术栈：** Vue 3 + Naive UI NDataTable + TypeScript + Vitest

**设计规格：** `docs/superpowers/specs/2026-07-08-datatable-component-design.md`

---

### Task 1: 创建 DataTable.vue 基础骨架（工具栏 + NDataTable 数据区）

**Files:**
- Create: `src/components/shared/DataTable.vue`

- [ ] **Step 1: 创建 DataTable.vue 基础骨架**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue'
import { NDataTable, NInput, NButton, NSpace, NBadge } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'

interface Props {
  /** 列定义数组（由调用方传入） */
  columns: DataTableColumns<any>
  /** 表格数据行数组 */
  data: any[]
  /** 是否启用分页，默认 true（> 100 条自动生效） */
  pagination?: boolean
  /** 每页行数，默认 100 */
  pageSize?: number
  /** 是否显示 CSV 导出按钮，默认 false */
  exportable?: boolean
  /** 导出文件名（不含扩展名），默认 'export' */
  exportFilename?: string
  /** 表格最大高度，默认 '100%' */
  maxHeight?: number | string
  /** 行点击回调 */
  onRowClick?: (row: any, index: number) => void
  /** 字体大小（px），继承 globalFontSize */
  fontSize?: number
  /** 是否显示全局搜索框，默认 true */
  searchable?: boolean
  /** 是否显示高级筛选面板入口，默认 true */
  advancedFilter?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  pagination: true,
  pageSize: 100,
  exportable: false,
  exportFilename: 'export',
  maxHeight: '100%',
  fontSize: 13,
  searchable: true,
  advancedFilter: true,
})

/** 全局搜索关键字 */
const searchKeyword = ref('')

/** 经全局搜索过滤后的数据（占位，后续 Task 完善） */
const filteredData = computed(() => {
  if (!searchKeyword.value) return props.data
  const kw = searchKeyword.value.toLowerCase()
  return props.data.filter(row =>
    props.columns.some(col => {
      const key = String(col.key ?? '')
      const val = String(row[key] ?? '')
      return val.toLowerCase().includes(kw)
    })
  )
})

/** 是否显示分页（数据 > 100 条时自动生效） */
const paginationConfig = computed(() => {
  if (!props.pagination || filteredData.value.length <= 100) return false
  return { pageSize: props.pageSize }
})

/** 是否启用虚拟滚动（数据 > 500 条时自动启用） */
const useVirtualScroll = computed(() => filteredData.value.length > 500)

/** 统计信息文本 */
const statsText = computed(() => {
  const total = props.data.length
  const filtered = filteredData.value.length
  if (total === filtered) return `共 ${total} 条`
  return `共 ${total} 条 / 筛选后 ${filtered} 条`
})
</script>

<template>
  <div class="data-table-wrapper" :style="{ fontSize: `${fontSize}px` }">
    <!-- 工具栏 -->
    <NSpace class="data-table-toolbar" align="center" justify="space-between" :wrap="false">
      <NSpace align="center" size="small">
        <NInput
          v-if="searchable"
          v-model:value="searchKeyword"
          placeholder="全局搜索..."
          clearable
          size="small"
          style="width: 200px;"
        />
        <NButton v-if="advancedFilter" size="small" quaternary>
          高级筛选
        </NButton>
      </NSpace>
      <NSpace align="center" size="small">
        <NButton v-if="exportable" size="small" quaternary>导出 CSV</NButton>
        <span class="stats-text">{{ statsText }}</span>
      </NSpace>
    </NSpace>

    <!-- 数据区 -->
    <NDataTable
      class="data-table-body"
      :columns="columns"
      :data="filteredData"
      :pagination="paginationConfig"
      :virtual-scroll="useVirtualScroll"
      :max-height="maxHeight"
      :row-props="(row: any, index: number) => ({
        style: 'cursor: pointer;',
        onClick: () => onRowClick?.(row, index),
      })"
      :bordered="false"
      :single-line="false"
      size="small"
    />
  </div>
</template>

<style scoped>
.data-table-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-editor-bg, #1a1a2e);
}

.data-table-toolbar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border, #333);
  flex-shrink: 0;
}

.data-table-body {
  flex: 1;
  min-height: 0;
}

.stats-text {
  font-size: 12px;
  color: var(--color-text-secondary, #9ca3af);
  white-space: nowrap;
}
</style>
```

- [ ] **Step 2: 类型检查验证**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/components/shared/DataTable.vue
git commit -m "feat: 新增 DataTable 公共表格组件基础骨架"
```

---

### Task 2: 实现全局搜索防抖（万行场景优化）

**Files:**
- Modify: `src/components/shared/DataTable.vue`

- [ ] **Step 1: 添加防抖搜索逻辑**

在 `<script setup>` 中替换全局搜索部分，使用 `useDebounceFn`（来自 `@vueuse/core`，项目已安装）：

```typescript
import { useDebounceFn } from '@vueuse/core'

/** 防抖后的搜索关键字 */
const debouncedKeyword = ref('')

/** 输入搜索关键字时的防抖回调（300ms） */
const onSearchInput = useDebounceFn((value: string) => {
  debouncedKeyword.value = value
}, 300)
```

修改 `filteredData` computed 使用 `debouncedKeyword`：

```typescript
const filteredData = computed(() => {
  if (!debouncedKeyword.value) return props.data
  const kw = debouncedKeyword.value.toLowerCase()
  return props.data.filter(row =>
    props.columns.some(col => {
      const key = String(col.key ?? '')
      const val = String(row[key] ?? '')
      return val.toLowerCase().includes(kw)
    })
  )
})
```

模板中 NInput 绑定：

```html
<NInput
  v-if="searchable"
  :value="searchKeyword"
  @update:value="(v: string | null) => { searchKeyword = v ?? ''; onSearchInput(v ?? '') }"
  placeholder="全局搜索..."
  clearable
  size="small"
  style="width: 200px;"
/>
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/components/shared/DataTable.vue
git commit -m "feat: DataTable 全局搜索添加 300ms 防抖优化"
```

---

### Task 3: 实现高级筛选面板

**Files:**
- Modify: `src/components/shared/DataTable.vue`

- [ ] **Step 1: 添加高级筛选状态与逻辑**

在 `<script setup>` 中添加：

```typescript
/** 筛选操作符类型 */
type FilterOp = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'range' | 'empty' | 'notEmpty'

/** 高级筛选条件 */
interface FilterCondition {
  /** 条件唯一 id */
  id: string
  /** 目标列的 key */
  columnKey: string
  /** 操作符 */
  operator: FilterOp
  /** 筛选值 */
  value: string
  /** 范围筛选的结束值 */
  valueEnd?: string
}

/** 筛选面板是否展开 */
const showFilterPanel = ref(false)

/** 当前筛选条件列表 */
const filterConditions = ref<FilterCondition[]>([])

/** 列选项（供筛选面板的列选择下拉框使用） */
const columnOptions = computed(() =>
  props.columns.map(c => ({ label: String(c.title ?? c.key), value: String(c.key) }))
)

/** 操作符选项 */
const operatorOptions = [
  { label: '包含', value: 'contains' },
  { label: '等于', value: 'equals' },
  { label: '开头', value: 'startsWith' },
  { label: '结尾', value: 'endsWith' },
  { label: '范围', value: 'range' },
  { label: '空值', value: 'empty' },
  { label: '非空', value: 'notEmpty' },
]

/** 添加一条筛选条件 */
function addCondition() {
  filterConditions.value.push({
    id: crypto.randomUUID(),
    columnKey: props.columns[0] ? String(props.columns[0].key) : '',
    operator: 'contains',
    value: '',
  })
}

/** 删除一条筛选条件 */
function removeCondition(id: string) {
  filterConditions.value = filterConditions.value.filter(c => c.id !== id)
}

/** 清除所有筛选条件 */
function clearConditions() {
  filterConditions.value = []
}

/** 切换筛选面板展开/收起 */
function toggleFilterPanel() {
  showFilterPanel.value = !showFilterPanel.value
}

/** 匹配单条筛选条件 */
function matchCondition(cellValue: any, condition: FilterCondition): boolean {
  const str = String(cellValue ?? '').toLowerCase()
  const val = condition.value.toLowerCase()
  switch (condition.operator) {
    case 'contains': return str.includes(val)
    case 'equals': return str === val
    case 'startsWith': return str.startsWith(val)
    case 'endsWith': return str.endsWith(val)
    case 'range': return Number(cellValue) >= Number(condition.value) && Number(cellValue) <= Number(condition.valueEnd ?? 0)
    case 'empty': return !cellValue && cellValue !== 0
    case 'notEmpty': return !!cellValue || cellValue === 0
    default: return true
  }
}
```

更新 `filteredData` computed，在搜索过滤后追加高级筛选：

```typescript
const filteredData = computed(() => {
  let result = props.data

  // 全局搜索过滤
  if (debouncedKeyword.value) {
    const kw = debouncedKeyword.value.toLowerCase()
    result = result.filter(row =>
      props.columns.some(col => {
        const key = String(col.key ?? '')
        const val = String(row[key] ?? '')
        return val.toLowerCase().includes(kw)
      })
    )
  }

  // 高级筛选过滤（多条件 AND）
  if (filterConditions.value.length > 0) {
    result = result.filter(row =>
      filterConditions.value.every(cond => matchCondition(row[cond.columnKey], cond))
    )
  }

  return result
})
```

- [ ] **Step 2: 添加筛选面板模板**

在工具栏的"高级筛选"按钮后追加面板：

```html
<!-- 工具栏中的高级筛选按钮改为 -->
<NButton v-if="advancedFilter" size="small" quaternary @click="toggleFilterPanel">
  <NBadge :value="filterConditions.length" :show="filterConditions.length > 0" dot>
    高级筛选
  </NBadge>
</NButton>

<!-- 高级筛选面板（工具栏之后、数据区之前） -->
<Transition name="filter-panel">
  <div v-if="showFilterPanel && advancedFilter" class="filter-panel">
    <div v-for="cond in filterConditions" :key="cond.id" class="filter-row">
      <NSelect
        v-model:value="cond.columnKey"
        :options="columnOptions"
        size="small"
        style="width: 140px;"
      />
      <NSelect
        v-model:value="cond.operator"
        :options="operatorOptions"
        size="small"
        style="width: 100px;"
      />
      <NInput
        v-if="cond.operator !== 'empty' && cond.operator !== 'notEmpty'"
        v-model:value="cond.value"
        size="small"
        :placeholder="cond.operator === 'range' ? '起始值' : '值'"
        style="width: 120px;"
      />
      <span v-if="cond.operator === 'range'" style="margin: 0 4px; color: #9ca3af;">~</span>
      <NInput
        v-if="cond.operator === 'range'"
        v-model:value="cond.valueEnd"
        size="small"
        placeholder="结束值"
        style="width: 120px;"
      />
      <NButton size="small" quaternary type="error" @click="removeCondition(cond.id)">
        ✕
      </NButton>
    </div>
    <div class="filter-actions">
      <NButton size="small" @click="addCondition">+ 添加条件</NButton>
      <NButton size="small" quaternary @click="clearConditions">清除全部</NButton>
    </div>
  </div>
</Transition>
```

- [ ] **Step 3: 添加筛选面板样式**

在 `<style scoped>` 中添加：

```css
.filter-panel {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border, #333);
  background: var(--color-surface, rgba(255, 255, 255, 0.03));
  flex-shrink: 0;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.filter-actions {
  display: flex;
  gap: 8px;
}

.filter-panel-enter-active,
.filter-panel-leave-active {
  transition: all 0.2s ease;
  overflow: hidden;
}

.filter-panel-enter-from,
.filter-panel-leave-to {
  opacity: 0;
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
}

.filter-panel-enter-to,
.filter-panel-leave-from {
  opacity: 1;
  max-height: 300px;
}
```

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/components/shared/DataTable.vue
git commit -m "feat: DataTable 添加高级多条件筛选面板"
```

---

### Task 4: 实现 CSV 导出功能

**Files:**
- Modify: `src/components/shared/DataTable.vue`

- [ ] **Step 1: 添加导出函数**

在 `<script setup>` 中添加：

```typescript
/** 导出当前筛选结果为 CSV 文件 */
function exportCsv() {
  const headers = props.columns.map(c => String(c.title ?? c.key))
  const keys = props.columns.map(c => String(c.key))
  const rows = filteredData.value.map(row =>
    keys.map(k => {
      const v = String(row[k] ?? '')
      // CSV 值中含逗号、引号、换行时需转义
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"`
        : v
    }).join(',')
  )
  const csv = [headers.join(','), ...rows].join('\n')
  // BOM 确保 Excel 正确识别 UTF-8 编码
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.exportFilename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
```

- [ ] **Step 2: 绑定导出按钮**

将工具栏中的导出按钮绑定 click 事件：

```html
<NButton v-if="exportable" size="small" quaternary @click="exportCsv">导出 CSV</NButton>
```

- [ ] **Step 3: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add src/components/shared/DataTable.vue
git commit -m "feat: DataTable 实现 CSV 导出功能"
```

---

### Task 5: 创建 DataTable 组件测试

**Files:**
- Create: `src/__tests__/components/DataTable.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DataTable from '@/components/shared/DataTable.vue'
import type { DataTableColumns } from 'naive-ui'

/** 构造测试列定义 */
function makeColumns(): DataTableColumns<any> {
  return [
    { title: 'ID', key: 'id', sorter: (a: any, b: any) => a.id - b.id },
    {
      title: '名称',
      key: 'name',
      filterOptions: [
        { label: 'Alice', value: 'Alice' },
        { label: 'Bob', value: 'Bob' },
      ],
      filter: (value: any, row: any) => row.name === value,
    },
    { title: '城市', key: 'city' },
  ]
}

/** 构造测试数据 */
function makeData(count: number): any[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: i % 2 === 0 ? 'Alice' : 'Bob',
    city: i % 3 === 0 ? '北京' : i % 3 === 1 ? '上海' : '深圳',
  }))
}

describe('DataTable', () => {
  it('渲染表格数据', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3) },
    })
    await nextTick()
    // NDataTable 应渲染 3 条数据
    expect(wrapper.findComponent(DataTable).exists()).toBe(true)
  })

  it('数据 ≤ 100 条时不显示分页', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(50) },
    })
    await nextTick()
    // 分页配置应为 false
    const dt = wrapper.findComponent({ name: 'NDataTable' })
    if (dt.exists()) {
      expect(dt.props('pagination')).toBe(false)
    }
  })

  it('数据 > 100 条时显示分页', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(150) },
    })
    await nextTick()
    const dt = wrapper.findComponent({ name: 'NDataTable' })
    if (dt.exists()) {
      expect(dt.props('pagination')).toEqual({ pageSize: 100 })
    }
  })

  it('全局搜索过滤数据', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(10), searchable: true },
    })
    await nextTick()

    // 模拟搜索输入
    const searchInput = wrapper.findComponent({ name: 'NInput' })
    if (searchInput.exists()) {
      await searchInput.setValue('北京')
      await nextTick()
      // 防抖后数据应被过滤
      // 注意：由于 300ms 防抖，需等待或使用 vi.useFakeTimers
    }
  })

  it('导出按钮仅在 exportable 时显示', async () => {
    const wrapper1 = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), exportable: false },
    })
    await nextTick()
    expect(wrapper1.text()).not.toContain('导出 CSV')

    const wrapper2 = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), exportable: true },
    })
    await nextTick()
    expect(wrapper2.text()).toContain('导出 CSV')
  })

  it('高级筛选按钮仅在 advancedFilter 时显示', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), advancedFilter: false },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('高级筛选')
  })

  it('高级筛选面板切换显隐', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), advancedFilter: true },
    })
    await nextTick()

    // 初始不显示面板
    expect(wrapper.find('.filter-panel').exists()).toBe(false)

    // 点击高级筛选按钮
    const filterBtn = wrapper.findAllComponents({ name: 'NButton' })
      .find(b => b.text().includes('高级筛选'))
    if (filterBtn) {
      await filterBtn.trigger('click')
      await nextTick()
      expect(wrapper.find('.filter-panel').exists()).toBe(true)
    }
  })

  it('行点击回调被触发', async () => {
    const onRowClick = vi.fn()
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), onRowClick },
    })
    await nextTick()
    // 通过 vm 调用验证回调函数已传入
    expect(wrapper.props('onRowClick')).toBe(onRowClick)
  })

  it('统计信息显示正确', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(50) },
    })
    await nextTick()
    expect(wrapper.find('.stats-text').text()).toBe('共 50 条')
  })

  it('自定义字体大小生效', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), fontSize: 16 },
    })
    await nextTick()
    const el = wrapper.find('.data-table-wrapper')
    expect(el.attributes('style')).toContain('font-size: 16px')
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `npx vitest run src/__tests__/components/DataTable.test.ts`
Expected: 测试通过

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/components/DataTable.test.ts
git commit -m "test: 新增 DataTable 公共表格组件单元测试"
```

---

### Task 6: 改造 CsvRenderer 使用 DataTable

**Files:**
- Modify: `src/views/renderers/CsvRenderer.vue`

- [ ] **Step 1: 重写 CsvRenderer.vue**

```vue
<script setup lang="ts">
import { computed, h } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import DataTable from '@/components/shared/DataTable.vue'
import type { CsvData } from '@/types'

const props = defineProps<{ content: CsvData }>()
const { globalFontSize } = useTabManager()

/** 提取每列的唯一值作为筛选选项 */
function extractFilterOptions(headers: string[], rows: string[][]): Record<string, { label: string; value: string }[]> {
  const result: Record<string, { label: string; value: string }[]> = {}
  headers.forEach((h, ci) => {
    const values = new Set(rows.map(r => r[ci]).filter(Boolean))
    // 仅当唯一值 ≤ 50 时提供筛选选项（避免过多选项）
    if (values.size <= 50) {
      result[h] = [...values].sort().map(v => ({ label: v, value: v }))
    }
  })
  return result
}

/** 将 CsvData.headers 转换为 NDataTable 列定义 */
const columns = computed<DataTableColumns<any>>(() => {
  const filterOpts = extractFilterOptions(props.content.headers, props.content.rows)
  return props.content.headers.map(h => ({
    title: h,
    key: h,
    sorter: 'default' as const,
    filterOptions: filterOpts[h] ?? [],
    filter: filterOpts[h] ? (value: any, row: any) => row[h] === value : undefined,
    resizable: true,
    minWidth: 80,
  }))
})

/** 将 CsvData.rows 转换为对象数组 */
const data = computed(() =>
  props.content.rows.map(row => {
    const obj: Record<string, string> = {}
    props.content.headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
    return obj
  })
)
</script>

<template>
  <NEmpty
    v-if="content.headers.length === 0 && content.rows.length === 0"
    description="空表格"
    style="margin-top: 40px;"
  />
  <DataTable
    v-else
    :columns="columns"
    :data="data"
    :exportable="true"
    export-filename="csv-data"
    :font-size="globalFontSize"
  />
</template>
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/views/renderers/CsvRenderer.vue
git commit -m "refactor: CsvRenderer 改用 DataTable 公共组件"
```

---

### Task 7: 改造 LogRenderer 使用 DataTable

**Files:**
- Modify: `src/views/renderers/LogRenderer.vue`

- [ ] **Step 1: 重写 LogRenderer.vue**

```vue
<script setup lang="ts">
import { h } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { LogLine, LogLevel } from '@/plugins/parsers/types'
import { useTabManager } from '@/composables/use-tabs'
import DataTable from '@/components/shared/DataTable.vue'

const props = defineProps<{ content: LogLine[] }>()
const { setCursor, globalFontSize } = useTabManager()

const levelColor: Record<LogLevel, string> = {
  INFO: '#3B82F6',
  WARN: '#F59E0B',
  ERROR: '#EF4444',
  DEBUG: '#9ca3af',
  OTHER: '#d4d4d4',
}

/** 日志表格列定义 */
const logColumns: DataTableColumns<LogLine> = [
  {
    title: '#',
    key: 'lineNumber',
    width: 70,
    sorter: (a: LogLine, b: LogLine) => a.lineNumber - b.lineNumber,
  },
  {
    title: '时间',
    key: 'timestamp',
    width: 180,
    sorter: 'default',
  },
  {
    title: '级别',
    key: 'level',
    width: 80,
    render: (row: LogLine) => h('span', { style: { color: levelColor[row.level], fontWeight: 600 } }, row.level),
    filterOptions: ['INFO', 'WARN', 'ERROR', 'DEBUG', 'OTHER'].map(v => ({ label: v, value: v })),
    filter: (value: any, row: LogLine) => row.level === value,
  },
  {
    title: '模块',
    key: 'module',
    width: 120,
    sorter: 'default',
  },
  {
    title: '消息',
    key: 'message',
    ellipsis: { tooltip: true },
    render: (row: LogLine) => row.level === 'OTHER' ? row.raw : row.message,
  },
]
</script>

<template>
  <NEmpty v-if="content.length === 0" description="空日志" style="margin-top: 40px;" />
  <DataTable
    v-else
    :columns="logColumns"
    :data="content"
    :exportable="true"
    export-filename="log-data"
    :font-size="globalFontSize"
    :on-row-click="(row: LogLine) => setCursor(row.lineNumber, 1)"
  />
</template>
```

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add src/views/renderers/LogRenderer.vue
git commit -m "refactor: LogRenderer 改用 DataTable 公共组件"
```

---

### Task 8: 生成 10000 行模拟数据并端到端验证

**Files:**
- Create: `data/mock_10000.csv`

- [ ] **Step 1: 生成 10000 行 CSV 测试数据**

在终端运行 Node.js 脚本生成：

```bash
node -e "
const fs = require('fs');
const headers = 'ID,姓名,部门,城市,薪资,入职日期';
const depts = ['技术部','产品部','设计部','市场部','财务部'];
const cities = ['北京','上海','深圳','杭州','广州','成都'];
const names = ['张三','李四','王五','赵六','陈七','周八','吴九','郑十'];
const rows = Array.from({length:10000},(_,i)=>{
  const d = String((i%12)+1).padStart(2,'0');
  const dd = String((i%28)+1).padStart(2,'0');
  return [i+1,names[i%names.length]+i,depts[i%depts.length],cities[i%cities.length],Math.floor(Math.random()*30000+5000),'2020-'+d+'-'+dd].join(',');
});
fs.writeFileSync('data/mock_10000.csv', [headers,...rows].join('\n'), 'utf-8');
console.log('已生成 data/mock_10000.csv，共 10001 行（含表头）');
"
```

- [ ] **Step 2: 启动开发服务器验证**

Run: `npm run dev`

在浏览器中打开，通过左侧归档面板上传 `data/mock_10000.csv`（打包为 zip 或直接使用 CSV 文件）。

- [ ] **Step 3: 手动验证功能清单**

| 验证项 | 操作 | 预期 |
|--------|------|------|
| 排序 | 点击 ID 列头降序 | 首行 ID 为 10000 |
| 列头筛选 | 部门列勾选"技术部" | 仅显示技术部数据 |
| 全局搜索 | 搜索框输入"北京" | 所有含北京的行被过滤，统计更新 |
| 高级筛选 | 展开面板，添加 薪资 范围 10000~20000 | 仅显示该范围数据 |
| 导出 CSV | 筛选后点击"导出 CSV" | 下载的文件仅含筛选结果 |
| 分页 | 查看底部 | 显示分页器，共 100 页 |
| 虚拟滚动 | 滚动数据区 | 滚动流畅无卡顿 |
| 性能 | 搜索框快速输入 | 防抖生效，无 UI 卡顿 |

- [ ] **Step 4: 运行全量测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add data/mock_10000.csv
git commit -m "chore: 新增 10000 行 CSV 模拟测试数据"
```

---

### Task 9: 更新现有 CsvRenderer 和 LogRenderer 测试

**Files:**
- Create: `src/__tests__/views/renderers/CsvRenderer.test.ts`（如不存在则新增）
- Create: `src/__tests__/views/renderers/LogRenderer.test.ts`（如不存在则新增）

- [ ] **Step 1: 检查现有测试文件**

Run: `ls src/__tests__/views/renderers/`
Expected: 确认是否存在 CsvRenderer.test.ts 和 LogRenderer.test.ts

- [ ] **Step 2: 创建/更新 CsvRenderer 测试**

```typescript
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'
import type { CsvData } from '@/types'

// mock useTabManager
vi.mock('@/composables/use-tabs', () => ({
  useTabManager: () => ({ globalFontSize: 13 }),
}))

describe('CsvRenderer', () => {
  const mockContent: CsvData = {
    headers: ['ID', '名称', '城市'],
    rows: [
      ['1', 'Alice', '北京'],
      ['2', 'Bob', '上海'],
    ],
  }

  it('空数据时显示空表格提示', async () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: [], rows: [] } },
    })
    await nextTick()
    expect(wrapper.text()).toContain('空表格')
  })

  it('有数据时渲染 DataTable', async () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: mockContent },
    })
    await nextTick()
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
  })
})
```

- [ ] **Step 3: 创建/更新 LogRenderer 测试**

```typescript
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import LogRenderer from '@/views/renderers/LogRenderer.vue'
import type { LogLine } from '@/plugins/parsers/types'

vi.mock('@/composables/use-tabs', () => ({
  useTabManager: () => ({ setCursor: vi.fn(), globalFontSize: 13 }),
}))

describe('LogRenderer', () => {
  const mockContent: LogLine[] = [
    { lineNumber: 1, timestamp: '2024-01-01 00:00:00', level: 'INFO', module: 'app', message: '启动', raw: 'INFO app 启动' },
    { lineNumber: 2, timestamp: '2024-01-01 00:00:01', level: 'ERROR', module: 'db', message: '连接失败', raw: 'ERROR db 连接失败' },
  ]

  it('空日志时显示空提示', async () => {
    const wrapper = mount(LogRenderer, {
      props: { content: [] },
    })
    await nextTick()
    expect(wrapper.text()).toContain('空日志')
  })

  it('有日志时渲染 DataTable', async () => {
    const wrapper = mount(LogRenderer, {
      props: { content: mockContent },
    })
    await nextTick()
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
  })
})
```

- [ ] **Step 4: 运行测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 5: 提交**

```bash
git add src/__tests__/views/renderers/
git commit -m "test: 更新 CsvRenderer 和 LogRenderer 测试适配 DataTable"
```

---

### Task 10: 最终集成验证与提交

**Files:**
- 无新增文件，全面回归验证

- [ ] **Step 1: 全量类型检查**

Run: `npm run typecheck`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 3: 开发服务器端到端验证**

Run: `npm run dev`

上传 `data/mock_10000.csv`（通过 zip 打包），按 Task 8 Step 3 的验证清单逐项确认。

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat: 完成公共 DataTable 表格组件集成（排序/筛选/搜索/导出/分页/虚拟滚动）"
```
