<script setup lang="ts">
/**
 * DataTable — 通用公共表格组件
 *
 * 基于 Naive UI NDataTable 封装，提供：
 * - 全局搜索（300ms 防抖）
 * - 高级筛选面板（多条件 AND）
 * - CSV 导出（BOM + UTF-8）
 * - 自适应分页（≤100 条隐藏）
 * - 虚拟滚动（>500 条自动启用）
 * - 统计信息（总数 / 筛选后数量）
 *
 * 数据流水线：
 * 原始 data → 全局搜索 → 高级筛选 → 列头筛选 → 排序 → 分页/虚拟滚动 → 渲染
 */
import { computed, ref, reactive } from 'vue'
import {
  NDataTable,
  NInput,
  NButton,
  NSelect,
  type DataTableColumns,
  type DataTableColumn,
  type SelectOption,
} from 'naive-ui'

/** 内部辅助类型：具有 key 的普通数据列（排除 selection / expand / group 列） */
interface DataColumn {
  key: string
  title?: string
  sorter?: boolean | ((a: any, b: any) => number)
  [k: string]: unknown
}
import { useDebounceFn } from '@vueuse/core'

/* ========== Props ========== */

/** 筛选操作符类型 */
type FilterOp = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'range' | 'empty' | 'notEmpty'

/** 单条筛选条件 */
interface FilterCondition {
  id: string
  columnKey: string
  operator: FilterOp
  value: string
  valueEnd?: string
}

interface Props {
  /** 列定义数组 */
  columns: DataTableColumns<any>
  /** 表格数据行数组 */
  data: any[]
  /** 是否启用分页，默认 true */
  pagination?: boolean
  /** 每页行数，默认 100 */
  pageSize?: number
  /** 是否显示 CSV 导出按钮，默认 false */
  exportable?: boolean
  /** 导出文件名，默认 'export' */
  exportFilename?: string
  /** 表格最大高度，默认 '100%' */
  maxHeight?: number | string
  /** 行点击回调 */
  onRowClick?: (row: any, index: number) => void
  /** 字体大小（px），默认 13 */
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

/* ========== 常量 ========== */

/** 筛选操作符选项列表 */
const opOptions: Array<{ label: string; value: FilterOp }> = [
  { label: '包含', value: 'contains' },
  { label: '等于', value: 'equals' },
  { label: '开头', value: 'startsWith' },
  { label: '结尾', value: 'endsWith' },
  { label: '范围', value: 'range' },
  { label: '空值', value: 'empty' },
  { label: '非空', value: 'notEmpty' },
]

/* ========== 响应式状态 ========== */

/** 搜索输入（原始，立即更新） */
const searchQuery = ref('')
/** 防抖后的搜索关键词 */
const debouncedSearch = ref('')
/** 高级筛选面板是否展开 */
const filterExpanded = ref(false)
/** 筛选条件列表 */
const conditions = reactive<FilterCondition[]>([])
/** 列头筛选状态（NDataTable 回调填充） */
const activeFilters = ref<Record<string, Array<string | number> | null>>({})
/** 当前排序状态 */
const activeSorter = ref<{ columnKey: string; order: 'ascend' | 'descend' } | null>(null)

/** 防抖更新搜索关键词（300ms） */
const onSearchInput = useDebounceFn((val: string) => {
  debouncedSearch.value = val
}, 300)

/* ========== 列选项（供高级筛选下拉使用） ========== */

const columnOptions = computed<Array<{ label: string; value: string }>>(() =>
  props.columns
    .filter((c: DataTableColumn<any>) => 'key' in c && (c as DataColumn).key)
    .map((c: DataTableColumn<any>) => {
      const dc = c as DataColumn
      return { label: String(dc.title ?? dc.key), value: String(dc.key) }
    }),
)

/* ========== 筛选条件操作 ========== */

/** 添加一条空筛选条件 */
function addCondition(): void {
  const firstKey = columnOptions.value[0]?.value ?? ''
  conditions.push({
    id: crypto.randomUUID(),
    columnKey: firstKey,
    operator: 'contains',
    value: '',
  })
}

/** 删除指定条件 */
function removeCondition(id: string): void {
  const idx = conditions.findIndex(c => c.id === id)
  if (idx >= 0) conditions.splice(idx, 1)
}

/** 清除所有条件并关闭面板 */
function clearConditions(): void {
  conditions.splice(0, conditions.length)
  filterExpanded.value = false
}

/* ========== 工具函数 ========== */

/** 安全访问嵌套属性（支持点号路径，如 'a.b.c'） */
function getVal(row: any, key: string): any {
  if (!key.includes('.')) return row?.[key]
  return key.split('.').reduce((o, k) => o?.[k], row)
}

/** CSV 单元格转义：包含逗号 / 引号 / 换行时用双引号包裹 */
function csvEscape(val: unknown): string {
  const str = String(val ?? '')
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

/* ========== 数据处理流水线 ========== */

/**
 * 第一步：全局搜索过滤
 * 跨所有列进行文本包含匹配（不区分大小写）
 */
const searchedData = computed(() => {
  const q = debouncedSearch.value.trim().toLowerCase()
  if (!q) return props.data
  return props.data.filter(row =>
    props.columns.some((col: DataTableColumn<any>) => {
      if (!('key' in col)) return false
      const v = getVal(row, String((col as DataColumn).key))
      return String(v ?? '').toLowerCase().includes(q)
    }),
  )
})

/**
 * 第二步：高级筛选过滤（多条件 AND 关系）
 */
const advancedFilteredData = computed(() => {
  if (conditions.length === 0) return searchedData.value
  return searchedData.value.filter(row =>
    conditions.every(c => {
      if (!c.columnKey) return true
      const val = getVal(row, c.columnKey)
      const str = String(val ?? '')
      const target = c.value

      switch (c.operator) {
        case 'contains':
          return str.toLowerCase().includes(target.toLowerCase())
        case 'equals':
          return str === target
        case 'startsWith':
          return str.toLowerCase().startsWith(target.toLowerCase())
        case 'endsWith':
          return str.toLowerCase().endsWith(target.toLowerCase())
        case 'range': {
          const num = Number(str)
          const lo = Number(c.value)
          const hi = Number(c.valueEnd ?? c.value)
          return !Number.isNaN(num) && num >= lo && num <= hi
        }
        case 'empty':
          return val == null || val === ''
        case 'notEmpty':
          return val != null && val !== ''
        default:
          return true
      }
    }),
  )
})

/**
 * 第三步：列头筛选（NDataTable 内置 filter 回调结果）
 */
const columnFilteredData = computed(() => {
  let result = advancedFilteredData.value
  for (const [key, values] of Object.entries(activeFilters.value)) {
    if (!values || values.length === 0) continue
    result = result.filter(row => values.includes(getVal(row, key)))
  }
  return result
})

/**
 * 第四步：排序（NDataTable 内置 sorter 回调结果）
 */
const processedData = computed(() => {
  const result = [...columnFilteredData.value]
  const s = activeSorter.value
  if (!s) return result

  const col = props.columns.find(
    (c: DataTableColumn<any>) => 'key' in c && (c as DataColumn).key === s.columnKey,
  ) as DataColumn | undefined
  const sorterFn = col?.sorter
  if (!sorterFn || typeof sorterFn !== 'function') return result

  result.sort((a, b) => {
    const r = sorterFn(a, b)
    return s.order === 'descend' ? -r : r
  })
  return result
})

/* ========== 导出用完整过滤数据（与 processedData 一致） ========== */

/* ========== 分页配置 ========== */

/**
 * 自适应分页：
 * - 数据 ≤ 100 条时隐藏分页器
 * - 数据 > 100 条且 pagination prop 为 true 时显示
 */
const tablePagination = computed(() => {
  if (!props.pagination || processedData.value.length <= 100) return false as const
  return { pageSize: props.pageSize }
})

/** 数据 > 500 条时自动启用虚拟滚动 */
const useVirtualScroll = computed(() => processedData.value.length > 500)

/** 统计信息文本 */
const statsText = computed(() => {
  const total = props.data.length
  const filtered = processedData.value.length
  return filtered === total ? `共 ${total} 条` : `共 ${total} 条 / 筛选后 ${filtered} 条`
})

/* ========== CSV 导出 ========== */

/** 导出当前筛选结果为 CSV 文件（Blob + BOM 前缀确保 Excel UTF-8 兼容） */
function exportCsv(): void {
  const cols = props.columns.filter((c: DataTableColumn<any>) => 'key' in c && (c as DataColumn).key) as DataColumn[]
  const header = cols.map(c => csvEscape(c.title ?? c.key))
  const rows = processedData.value.map(row =>
    cols.map(c => csvEscape(getVal(row, c.key))),
  )
  const csv = [header.join(','), ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.exportFilename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/* ========== NDataTable 事件处理 ========== */

/** 列头筛选变化回调 */
function handleFilterChange(filters: Record<string, unknown>): void {
  activeFilters.value = filters as Record<string, Array<string | number> | null>
}

/** 排序变化回调 */
function handleSorterChange(
  options: { columnKey: string; order: 'ascend' | 'descend' } | null,
): void {
  activeSorter.value = options
}

/** 行属性生成器（注入点击事件和光标样式） */
function rowProps(row: any, index: number): Record<string, unknown> {
  if (!props.onRowClick) return {}
  return {
    style: 'cursor: pointer',
    onClick: () => props.onRowClick!(row, index),
  }
}

/* ========== 暴露内部状态（供测试使用） ========== */
defineExpose({
  filterExpanded,
  conditions,
  debouncedSearch,
  processedData,
  statsText,
  exportCsv,
})
</script>

<template>
  <div class="data-table-wrapper">
    <!-- 工具栏 -->
    <div
      v-if="searchable || advancedFilter || exportable"
      class="data-table-toolbar"
    >
      <div class="toolbar-left">
        <NInput
          v-if="searchable"
          :value="searchQuery"
          placeholder="全局搜索…"
          clearable
          size="small"
          class="toolbar-search"
          @update:value="(v: string | null) => { searchQuery = v ?? ''; onSearchInput(v ?? '') }"
        >
          <template #prefix>
            <span class="search-icon">🔍</span>
          </template>
        </NInput>

        <NButton
          v-if="advancedFilter"
          :type="filterExpanded ? 'primary' : 'default'"
          size="small"
          secondary
          @click="filterExpanded = !filterExpanded"
        >
          {{ filterExpanded ? '▲ 收起筛选' : '▼ 高级筛选' }}
          <NBadge
            v-if="conditions.length > 0"
            :value="conditions.length"
            :max="9"
            style="margin-left: 6px"
          />
        </NButton>

        <NButton
          v-if="exportable"
          size="small"
          secondary
          @click="exportCsv"
        >
          📥 导出 CSV
        </NButton>
      </div>

      <div class="toolbar-stats">{{ statsText }}</div>
    </div>

    <!-- 高级筛选面板（折叠展开） -->
    <Transition name="filter-panel">
      <div v-if="filterExpanded" class="filter-panel">
        <div
          v-for="c in conditions"
          :key="c.id"
          class="filter-row"
        >
          <NSelect
            :value="c.columnKey"
            :options="(columnOptions as SelectOption[])"
            size="small"
            class="filter-col-select"
            @update:value="(v: string | number | null) => { c.columnKey = String(v ?? '') }"
          />

          <NSelect
            :value="c.operator"
            :options="(opOptions as SelectOption[])"
            size="small"
            class="filter-op-select"
            @update:value="(v: string | number | null) => { c.operator = v as FilterOp }"
          />

          <template v-if="c.operator === 'range'">
            <NInput
              :value="c.value"
              placeholder="最小值"
              size="small"
              class="filter-range-input"
              @update:value="(v: string | null) => { c.value = v ?? '' }"
            />
            <span class="range-separator">—</span>
            <NInput
              :value="c.valueEnd"
              placeholder="最大值"
              size="small"
              class="filter-range-input"
              @update:value="(v: string | null) => { c.valueEnd = v ?? '' }"
            />
          </template>
          <NInput
            v-else-if="c.operator !== 'empty' && c.operator !== 'notEmpty'"
            :value="c.value"
            placeholder="筛选值"
            size="small"
            class="filter-value-input"
            @update:value="(v: string | null) => { c.value = v ?? '' }"
          />

          <NButton
            size="small"
            quaternary
            type="error"
            class="filter-remove-btn"
            @click="removeCondition(c.id)"
          >
            ✕
          </NButton>
        </div>

        <div class="filter-actions">
          <NButton size="small" dashed @click="addCondition">
            + 添加条件
          </NButton>
          <NButton size="small" quaternary @click="clearConditions">
            清除全部
          </NButton>
        </div>
      </div>
    </Transition>

    <!-- 数据表格区域 -->
    <div class="data-table-main">
      <NDataTable
        :columns="columns"
        :data="processedData"
        :pagination="tablePagination"
        :virtual-scroll="useVirtualScroll"
        :max-height="useVirtualScroll ? maxHeight : undefined"
        :row-props="rowProps"
        :bordered="false"
        size="small"
        remote
        striped
        @update:filters="handleFilterChange"
        @update:sorter="handleSorterChange"
      />
    </div>
  </div>
</template>

<style scoped>
.data-table-wrapper {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  background: var(--color-bg-surface, #1e1e24);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: var(--radius-panel, 8px);
  overflow: hidden;
  font-size: v-bind("fontSize + 'px'");
}

/* ===== 工具栏 ===== */
.data-table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  gap: 8px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  flex-shrink: 0;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.toolbar-search {
  width: 220px;
  flex-shrink: 0;
}

.search-icon {
  font-size: 13px;
  line-height: 1;
}

.toolbar-stats {
  font-size: 12px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
  flex-shrink: 0;
}

/* ===== 高级筛选面板 ===== */
.filter-panel {
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  background: var(--color-bg-elevated, #26262e);
  flex-shrink: 0;
}

.filter-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.filter-col-select {
  width: 140px;
  flex-shrink: 0;
}

.filter-op-select {
  width: 100px;
  flex-shrink: 0;
}

.filter-value-input {
  flex: 1;
  min-width: 80px;
}

.filter-range-input {
  width: 100px;
  flex-shrink: 0;
}

.range-separator {
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.55));
  flex-shrink: 0;
}

.filter-remove-btn {
  flex-shrink: 0;
}

.filter-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* ===== 数据表格主区域 ===== */
.data-table-main {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ===== 筛选面板折叠动画 ===== */
.filter-panel-enter-active,
.filter-panel-leave-active {
  transition: all 0.25s ease;
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
  max-height: 400px;
}
</style>
