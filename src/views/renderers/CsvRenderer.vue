<script setup lang="ts">
import { ref, computed } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import DataTable from '@/components/shared/DataTable.vue'
import SplitView from '@/components/workspace/SplitView.vue'
import CsvTreeDetail from './CsvTreeDetail.vue'
import { extractRowTree } from '@/core/csv-row-tree'
import type { CsvData } from '@/types'

const props = defineProps<{ content: CsvData }>()
const { globalFontSize } = useTabManager()

/** 当前选中行索引（对应 props.content.rows 的原始索引，null = 未选中） */
const selectedIndex = ref<number | null>(null)

/** 行点击：传入的是 DataTable 处理后的 row 对象，通过 __rowIndex 反查原始索引 */
function handleRowClick(row: any, _index: number): void {
  const originalIndex: number | undefined = row?.__rowIndex
  if (typeof originalIndex !== 'number') return
  selectedIndex.value = selectedIndex.value === originalIndex ? null : originalIndex
}

/** 关闭详情面板 */
function handleCloseDetail(): void {
  selectedIndex.value = null
}

/** 行类名：选中行附加高亮类，由 :deep 样式控制 */
function rowClassName(row: any, _index: number): string {
  return row?.__rowIndex === selectedIndex.value ? 'csv-row-selected' : ''
}

/** 选中行派生出的树形数据 */
const selectedTree = computed(() => {
  if (selectedIndex.value === null) return null
  const row = props.content.rows[selectedIndex.value]
  if (!row) return null
  return extractRowTree(props.content.headers, row)
})

/**
 * 提取每列的唯一值作为筛选选项
 * 仅当唯一值 ≤ 50 时提供筛选选项（避免下拉列表过长）
 */
function extractFilterOptions(
  headers: string[],
  rows: string[][],
): Record<string, { label: string; value: string }[]> {
  const result: Record<string, { label: string; value: string }[]> = {}
  headers.forEach((h, ci) => {
    const values = new Set(rows.map(r => r[ci]).filter(Boolean))
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

/**
 * 将 CsvData.rows 转换为对象数组
 * 附带 __rowIndex 内部字段用于行点击时反查原始索引（不出现在 columns 中故不显示）
 */
const data = computed(() =>
  props.content.rows.map((row, idx) => {
    const obj: Record<string, string | number> = {}
    props.content.headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
    obj.__rowIndex = idx
    return obj
  }),
)
</script>

<template>
  <NEmpty
    v-if="content.headers.length === 0 && content.rows.length === 0"
    description="空表格"
    style="margin-top: 40px;"
  />
  <!-- 单栏模式：未选中行时全宽展示 DataTable -->
  <div v-else-if="selectedIndex === null" class="csv-renderer">
    <DataTable
      :columns="columns"
      :data="data"
      :exportable="true"
      export-filename="csv-data"
      :font-size="globalFontSize"
      :on-row-click="handleRowClick"
      :row-class-name="rowClassName"
    />
  </div>
  <!-- 分栏模式：选中行后左表格 + 右树形详情 -->
  <div v-else class="csv-split-container">
    <SplitView>
      <template #left>
        <div class="csv-renderer">
          <DataTable
            :columns="columns"
            :data="data"
            :exportable="true"
            export-filename="csv-data"
            :font-size="globalFontSize"
            :on-row-click="handleRowClick"
            :row-class-name="rowClassName"
          />
        </div>
      </template>
      <template #right>
        <CsvTreeDetail
          v-if="selectedTree"
          :tree="selectedTree"
          @close="handleCloseDetail"
        />
      </template>
    </SplitView>
  </div>
</template>

<style scoped>
.csv-renderer {
  height: 100%;
  overflow: hidden;
}
.csv-split-container {
  height: 100%;
  overflow: hidden;
}
/* 选中行高亮：透传到 NDataTable 的 row-class-name，需用 :deep 穿透 */
:deep(.csv-row-selected td) {
  background: var(--color-primary-soft, rgba(59, 130, 246, 0.18)) !important;
  color: var(--color-primary, #60a5fa) !important;
  font-weight: 500;
}
</style>
