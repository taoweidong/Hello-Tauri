import { describe, it, expect, beforeEach } from 'vitest'
import { useCsvTableTree } from '@/composables/use-csv-table-tree'
import type { CsvData } from '@/types'

/** 创建测试用 CSV 数据 */
function createCsvData(): CsvData {
  return {
    headers: ['name', 'age', 'city'],
    rows: [
      ['Alice', '30', '北京'],
      ['Bob', '25', '上海'],
      ['Charlie', '35', '深圳'],
    ],
  }
}

describe('useCsvTableTree', () => {
  let csvData: CsvData

  beforeEach(() => {
    csvData = createCsvData()
  })

  describe('columns', () => {
    it('生成正确的列定义', () => {
      const { columns } = useCsvTableTree(() => csvData)
      expect(columns.value).toHaveLength(3)
      expect(columns.value[0]).toMatchObject({ title: 'name', key: 'name' })
      expect(columns.value[1]).toMatchObject({ title: 'age', key: 'age' })
      expect(columns.value[2]).toMatchObject({ title: 'city', key: 'city' })
    })

    it('列定义包含 sorter', () => {
      const { columns } = useCsvTableTree(() => csvData)
      expect(columns.value[0].sorter).toBe('default')
    })

    it('唯一值 ≤ 50 时生成筛选选项', () => {
      const { columns } = useCsvTableTree(() => csvData)
      // city 列有 3 个唯一值，应该生成筛选选项
      const cityCol = columns.value[2] as any
      expect(cityCol.filterOptions).toBeDefined()
      expect(cityCol.filterOptions.length).toBe(3)
    })
  })

  describe('data', () => {
    it('将行数组转换为对象数组', () => {
      const { data } = useCsvTableTree(() => csvData)
      expect(data.value).toHaveLength(3)
      expect(data.value[0]).toMatchObject({ name: 'Alice', age: '30', city: '北京' })
    })

    it('每行包含 __rowIndex 内部字段', () => {
      const { data } = useCsvTableTree(() => csvData)
      expect(data.value[0].__rowIndex).toBe(0)
      expect(data.value[1].__rowIndex).toBe(1)
      expect(data.value[2].__rowIndex).toBe(2)
    })
  })

  describe('selectedIndex 和 handleRowClick', () => {
    it('初始 selectedIndex 为 null', () => {
      const { selectedIndex } = useCsvTableTree(() => csvData)
      expect(selectedIndex.value).toBeNull()
    })

    it('点击行设置 selectedIndex', () => {
      const { selectedIndex, handleRowClick, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[1], 1)
      expect(selectedIndex.value).toBe(1)
    })

    it('再次点击同一行取消选中', () => {
      const { selectedIndex, handleRowClick, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[1], 1)
      expect(selectedIndex.value).toBe(1)
      handleRowClick(data.value[1], 1)
      expect(selectedIndex.value).toBeNull()
    })

    it('点击不同行切换选中', () => {
      const { selectedIndex, handleRowClick, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[0], 0)
      expect(selectedIndex.value).toBe(0)
      handleRowClick(data.value[2], 2)
      expect(selectedIndex.value).toBe(2)
    })

    it('行无 __rowIndex 时不改变选中状态', () => {
      const { selectedIndex, handleRowClick } = useCsvTableTree(() => csvData)
      handleRowClick({ name: 'Test' }, 0)
      expect(selectedIndex.value).toBeNull()
    })
  })

  describe('handleCloseDetail', () => {
    it('关闭详情面板重置 selectedIndex', () => {
      const { selectedIndex, handleRowClick, handleCloseDetail, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[1], 1)
      expect(selectedIndex.value).toBe(1)
      handleCloseDetail()
      expect(selectedIndex.value).toBeNull()
    })
  })

  describe('rowClassName', () => {
    it('选中行返回高亮类名', () => {
      const { rowClassName, handleRowClick, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[1], 1)
      expect(rowClassName(data.value[1], 1)).toBe('csv-row-selected')
    })

    it('未选中行返回空字符串', () => {
      const { rowClassName, data } = useCsvTableTree(() => csvData)
      expect(rowClassName(data.value[0], 0)).toBe('')
    })
  })

  describe('selectedTree', () => {
    it('未选中时返回 null', () => {
      const { selectedTree } = useCsvTableTree(() => csvData)
      expect(selectedTree.value).toBeNull()
    })

    it('选中行后返回树形数据', () => {
      const { selectedTree, handleRowClick, data } = useCsvTableTree(() => csvData)
      handleRowClick(data.value[0], 0)
      expect(selectedTree.value).not.toBeNull()
      expect(selectedTree.value!.children).toHaveLength(3)
    })

    it('选中索引超出范围时返回 null', () => {
      const emptyData: CsvData = { headers: ['a'], rows: [] }
      const { selectedTree, selectedIndex } = useCsvTableTree(() => emptyData)
      selectedIndex.value = 999
      expect(selectedTree.value).toBeNull()
    })
  })

  describe('空数据处理', () => {
    it('空 CSV 数据生成空列和空数据', () => {
      const emptyData: CsvData = { headers: [], rows: [] }
      const { columns, data } = useCsvTableTree(() => emptyData)
      expect(columns.value).toHaveLength(0)
      expect(data.value).toHaveLength(0)
    })
  })
})
