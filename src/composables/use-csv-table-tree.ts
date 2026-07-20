/**
 * CSV 表格+树形联动公共逻辑
 * 抽取 CsvRenderer 与 TableTreeRenderer 的共享状态与计算逻辑，消除代码重复
 */
import { ref, computed } from 'vue'
import type { DataTableColumns } from 'naive-ui'
import type { CsvData } from '@/types'
import { extractRowTree } from '@/core/csv-row-tree'

/**
 * CSV 表格+树形联动 composable
 * @param content - CSV 数据（响应式 props 传入）
 * @returns 表格列定义、数据、行选择、树形详情等共享状态
 */
export function useCsvTableTree(content: () => CsvData) {
  /** 当前选中行索引（null = 未选中） */
  const selectedIndex = ref<number | null>(null)

  /** 行点击：通过 __rowIndex 反查原始索引，切换选中状态 */
  function handleRowClick(row: any, _index: number): void {
    const originalIndex: number | undefined = row?.__rowIndex
    if (typeof originalIndex !== 'number') return
    selectedIndex.value = selectedIndex.value === originalIndex ? null : originalIndex
  }

  /** 关闭详情面板 */
  function handleCloseDetail(): void {
    selectedIndex.value = null
  }

  /** 行类名：选中行附加高亮类 */
  function rowClassName(row: any, _index: number): string {
    return row?.__rowIndex === selectedIndex.value ? 'csv-row-selected' : ''
  }

  /** 选中行派生出的树形数据 */
  const selectedTree = computed(() => {
    if (selectedIndex.value === null) return null
    const row = content().rows[selectedIndex.value]
    if (!row) return null
    return extractRowTree(content().headers, row)
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
    const csvData = content()
    const filterOpts = extractFilterOptions(csvData.headers, csvData.rows)
    return csvData.headers.map(h => ({
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
   * 附带 __rowIndex 内部字段用于行点击时反查原始索引
   */
  const data = computed(() =>
    content().rows.map((row, idx) => {
      const obj: Record<string, string | number> = {}
      content().headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
      obj.__rowIndex = idx
      return obj
    }),
  )

  return {
    selectedIndex,
    selectedTree,
    columns,
    data,
    handleRowClick,
    handleCloseDetail,
    rowClassName,
  }
}
