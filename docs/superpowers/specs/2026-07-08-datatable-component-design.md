# 公共 DataTable 表格组件设计规格

## 概述

封装一个基于 Naive UI `NDataTable` 的通用公共表格组件 `DataTable`，支持列排序、列头筛选、高级多条件组合筛选、全局搜索、CSV 导出、分页与虚拟滚动。替换现有 `CsvRenderer` 和 `LogRenderer` 中的手写表格/列表实现，当文件数据为表格类型时统一使用此组件。

## 需求

1. **通用表格组件**：封装为 `src/components/shared/DataTable.vue`，CsvRenderer 和 LogRenderer 均复用
2. **列排序**：点击表头可按升序/降序排序
3. **列头筛选**：枚举型列提供下拉勾选筛选，文本型列提供输入搜索
4. **高级筛选**：多条件组合面板，支持包含/等于/开头/结尾/范围/空值等操作符
5. **全局搜索**：跨所有列的文本搜索，实时过滤
6. **CSV 导出**：导出当前筛选结果（非全量），纯前端 Blob 实现
7. **分页**：数据 ≤ 100 条时隐藏分页器；> 100 条时显示分页器，默认每页 100 条
8. **虚拟滚动**：数据 > 500 条时自动启用 NDataTable `virtual-scroll`，支持万行流畅渲染
9. **行点击回调**：LogRenderer 用于行号跳转
10. **主题适配**：所有颜色通过 Naive UI token 或 CSS 变量获取，深浅主题自动适配

## 架构设计

### 方案：Naive UI NDataTable 封装

基于项目已安装的 Naive UI（^2.44.1），零新增依赖，利用 `NDataTable` 的内置能力（排序/筛选/分页/虚拟滚动）+ 自定义工具栏与筛选面板。

### 数据流

```
原始 data
  → 全局搜索过滤（searchKeyword 匹配任意列）
  → 高级筛选过滤（advancedFilters 多条件 AND）
  → 列头筛选（NDataTable 内置 filterOptions）
  → 排序（NDataTable 内置 sorter）
  → 分页/虚拟滚动
  → 渲染
```

全局搜索与高级筛选在 computed 中链式执行，列头筛选与排序由 NDataTable 内部处理。

## 组件设计

### 1. `DataTable.vue` — 公共表格组件

**文件：** `src/components/shared/DataTable.vue`

**Props 接口：**

```typescript
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
```

**模板结构：**

```
┌─────────────────────────────────────────────────┐
│ [🔍 全局搜索] [▼ 高级筛选] [📥 导出 CSV]  统计   │  ← 工具栏
├─────────────────────────────────────────────────┤
│  高级筛选面板（折叠展开，默认收起）                  │
│  列选择 [操作符 ▼] [值输入]   [+ 添加] [清除]      │
├─────────────────────────────────────────────────┤
│  NDataTable（排序/列头筛选/虚拟滚动/分页）          │
└─────────────────────────────────────────────────┘
```

**关键实现细节：**

- **全局搜索**：NInput + `useDebounceFn`（300ms 防抖，万行场景优化），搜索所有列的字符串值
- **高级筛选面板**：NButton 控制 NCollapse 折叠展开；内部使用 `FilterCondition[]` 数组管理条件
- **导出逻辑**：纯前端拼接 headers + filteredData → Blob → 动态 a 标签下载
- **自适应分页**：computed 判断 `data.length > 100`，动态传入 `pagination` prop
- **虚拟滚动**：computed 判断 `filteredData.length > 500`，动态启用 `virtual-scroll`
- **空数据**：NDataTable 自带空状态渲染

### 2. 高级筛选逻辑

**筛选条件类型：**

```typescript
interface FilterCondition {
  /** 目标列的 key */
  columnKey: string
  /** 操作符 */
  operator: FilterOp
  /** 筛选值 */
  value: string
  /** 范围筛选的结束值（仅 range 操作符） */
  valueEnd?: string
  /** 条件唯一 id */
  id: string
}

type FilterOp =
  | 'contains'    // 包含
  | 'equals'      // 等于
  | 'startsWith'  // 开头
  | 'endsWith'    // 结尾
  | 'range'       // 范围（数值型：value ~ valueEnd）
  | 'empty'       // 空值
  | 'notEmpty'    // 非空
```

**操作符匹配函数：**

```typescript
function matchCondition(cellValue: any, condition: FilterCondition): boolean {
  const str = String(cellValue ?? '').toLowerCase()
  const val = condition.value.toLowerCase()
  switch (condition.operator) {
    case 'contains': return str.includes(val)
    case 'equals': return str === val
    case 'startsWith': return str.startsWith(val)
    case 'endsWith': return str.endsWith(val)
    case 'range': return Number(cellValue) >= Number(condition.value) && Number(cellValue) <= Number(condition.valueEnd)
    case 'empty': return !cellValue && cellValue !== 0
    case 'notEmpty': return !!cellValue || cellValue === 0
    default: return true
  }
}
```

多条件之间为 AND 关系：所有条件必须同时满足。

### 3. CsvRenderer 改造

**文件：** `src/views/renderers/CsvRenderer.vue`

**改造方式：** 移除手写 `<table>` HTML，改用 `DataTable` 组件。

**数据转换：**

```typescript
// 将 CsvData 转换为 NDataTable 格式
const columns = computed(() =>
  props.content.headers.map(h => ({
    title: h,
    key: h,
    sorter: 'default',
    filterOptions: [], // 动态提取唯一值
    filter: (value, row) => row[h] === value,
    resizable: true,
  }))
)

const data = computed(() =>
  props.content.rows.map(row => {
    const obj: Record<string, string> = {}
    props.content.headers.forEach((h, i) => { obj[h] = row[i] })
    return obj
  })
)
```

### 4. LogRenderer 改造

**文件：** `src/views/renderers/LogRenderer.vue`

**改造方式：** 移除手写 `<div>` 列表，改用 `DataTable` 组件。

**列定义：**

```typescript
const logColumns: DataTableColumns<LogLine> = [
  { title: '#', key: 'lineNumber', width: 60, sorter: (a, b) => a.lineNumber - b.lineNumber },
  { title: '时间', key: 'timestamp', width: 180, sorter: 'default' },
  {
    title: '级别', key: 'level', width: 80,
    render: (row) => h('span', { style: { color: levelColor[row.level] } }, row.level),
    filterOptions: ['INFO', 'WARN', 'ERROR', 'DEBUG', 'OTHER'].map(v => ({ label: v, value: v })),
    filter: (value, row) => row.level === value,
  },
  { title: '模块', key: 'module', width: 120 },
  { title: '消息', key: 'message', ellipsis: { tooltip: true } },
]
```

通过 `onRowClick` 回调传递行号跳转：

```typescript
:on-row-click="(row) => setCursor(row.lineNumber, 1)"
```

### 5. CSV 导出逻辑

**文件：** 内嵌于 `DataTable.vue`

```typescript
function exportCsv() {
  const headers = props.columns.map(c => String(c.title ?? c.key))
  const keys = props.columns.map(c => String(c.key))
  const rows = filteredData.value.map(row =>
    keys.map(k => {
      const v = String(row[k] ?? '')
      return v.includes(',') || v.includes('"') || v.includes('\n')
        ? `"${v.replace(/"/g, '""')}"`
        : v
    }).join(',')
  )
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.exportFilename}.csv`
  a.click()
  URL.revokeObjectURL(url)
}
```

注意 BOM（`\uFEFF`）确保 Excel 正确识别 UTF-8 编码；CSV 值中的逗号、引号、换行需转义。

## UI 设计

### 工具栏

- **布局**：`NSpace` 横向排列，`justify="space-between"`
- **左侧**：全局搜索输入框（NInput，带搜索图标）+ 高级筛选按钮（NButton，带计数 badge）
- **右侧**：导出按钮 + 数据统计文本（"共 X 条 / 筛选后 Y 条"）
- **间距**：`size="small"`，工具栏高度约 40px

### 高级筛选面板

- **折叠**：默认收起，点击"筛选"按钮展开
- **每行条件**：列选择（NSelect）+ 操作符（NSelect）+ 值输入（NInput 或 NInputNumber）+ 删除按钮（NButton）
- **底部操作**：添加条件按钮 + 清除全部按钮
- **视觉**：浅灰色背景区分于数据区，折叠动画使用 NTransition

### 数据区

- **占满剩余高度**：flex 布局，工具栏固定高度，NDataTable `flex-grow: 1`
- **无外部滚动条**：NDataTable 内部管理滚动，避免双滚动条
- **列头**：排序图标 ▲▼、筛选漏斗图标由 NDataTable 内置渲染

## 性能策略

| 数据量 | 策略 |
|--------|------|
| ≤ 100 条 | 无分页、无虚拟滚动，直接渲染 |
| 101 ~ 500 条 | 启用分页（每页 100），无虚拟滚动 |
| > 500 条 | 分页 + 虚拟滚动（NDataTable `virtual-scroll`） |
| 10000+ 条 | 分页 + 虚拟滚动 + 搜索防抖（300ms）+ computed 链式过滤 |

## 测试验证

### 模拟 10000 行数据

新增测试页面或开发模式入口，生成 10000 行 CSV 模拟数据：

```typescript
function generateMockData(rows: number): CsvData {
  const headers = ['ID', '姓名', '部门', '城市', '薪资', '入职日期']
  const departments = ['技术部', '产品部', '设计部', '市场部', '财务部']
  const cities = ['北京', '上海', '深圳', '杭州', '广州', '成都']
  const data = Array.from({ length: rows }, (_, i) => [
    String(i + 1),
    `员工${i + 1}`,
    departments[i % departments.length],
    cities[i % cities.length],
    String(Math.floor(Math.random() * 30000 + 5000)),
    `2020-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
  ])
  return { headers, rows: data }
}
```

### 功能验证清单

1. **排序**：点击 ID 列降序 → 验证首行为 10000
2. **列头筛选**：部门列勾选"技术部" → 验证仅显示技术部数据
3. **全局搜索**：搜索"北京" → 验证所有含北京的行被过滤
4. **高级筛选**：添加条件 薪资 range 10000~20000 → 验证范围正确
5. **导出 CSV**：筛选后导出 → 验证导出文件仅含筛选结果
6. **分页**：10000 条 → 验证分页器显示 100 页
7. **虚拟滚动**：10000 条 → 验证滚动流畅、DOM 节点数量可控
8. **性能**：10000 条搜索 → 验证防抖生效、无卡顿

## 文件变更清单

| 文件 | 变更类型 |
|------|----------|
| `src/components/shared/DataTable.vue` | 新增 |
| `src/views/renderers/CsvRenderer.vue` | 重构（替换为 DataTable） |
| `src/views/renderers/LogRenderer.vue` | 重构（替换为 DataTable） |
| `data/mock_10000.csv` | 新增（测试数据） |
| `src/__tests__/components/shared/DataTable.test.ts` | 新增（组件测试） |
