<script setup lang="ts">
import { computed } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import DataTable from '@/components/shared/DataTable.vue'
import type { CsvData } from '@/types'

const props = defineProps<{ content: CsvData }>()
const { globalFontSize } = useTabManager()

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

/** 将 CsvData.rows 转换为对象数组 */
const data = computed(() =>
  props.content.rows.map(row => {
    const obj: Record<string, string> = {}
    props.content.headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
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
  <DataTable
    v-else
    :columns="columns"
    :data="data"
    :exportable="true"
    export-filename="csv-data"
    :font-size="globalFontSize"
  />
</template>
