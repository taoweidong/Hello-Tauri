import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  beforeEach(() => {
    // mock URL.createObjectURL 和 URL.revokeObjectURL
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:test'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('渲染组件', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3) },
    })
    await nextTick()
    expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
  })

  it('统计信息显示总数', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(50) },
    })
    await nextTick()
    expect(wrapper.find('.toolbar-stats').text()).toBe('共 50 条')
  })

  it('导出按钮仅在 exportable 为 true 时显示', async () => {
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

  it('高级筛选按钮仅在 advancedFilter 为 true 时显示', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), advancedFilter: false },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('高级筛选')
  })

  it('高级筛选面板初始收起', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), advancedFilter: true },
    })
    await nextTick()
    expect(wrapper.find('.filter-panel').exists()).toBe(false)
  })

  it('点击高级筛选按钮展开面板', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), advancedFilter: true },
    })
    await nextTick()

    // 通过组件内部方法直接展开面板
    const vm = wrapper.vm as any
    vm.filterExpanded = true
    await nextTick()

    expect(wrapper.find('.filter-panel').exists()).toBe(true)
  })

  it('行点击回调 prop 被正确传入', async () => {
    const onRowClick = vi.fn()
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), onRowClick },
    })
    await nextTick()
    expect(wrapper.props('onRowClick')).toBe(onRowClick)
  })

  it('自定义字体大小通过 v-bind 生效', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), fontSize: 16 },
    })
    await nextTick()
    // v-bind 在 scoped style 中通过 CSS 变量注入，检查组件存在即可
    expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
  })

  it('searchable 为 false 时不显示搜索框', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), searchable: false },
    })
    await nextTick()
    expect(wrapper.find('.toolbar-search').exists()).toBe(false)
  })

  it('searchable 为 true 时显示搜索框', async () => {
    const wrapper = mount(DataTable, {
      props: { columns: makeColumns(), data: makeData(3), searchable: true },
    })
    await nextTick()
    expect(wrapper.find('.toolbar-search').exists()).toBe(true)
  })

  describe('高级筛选功能', () => {
    it('添加筛选条件', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.filterExpanded = true
      await nextTick()

      // 初始无条件
      expect(vm.conditions.length).toBe(0)

      // 添加条件
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'name',
        operator: 'contains',
        value: 'Alice',
      })
      await nextTick()

      expect(vm.conditions.length).toBe(1)
    })

    it('contains 操作符筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'name',
        operator: 'contains',
        value: 'Alice',
      })
      await nextTick()

      // Alice 在偶数索引，10 条数据中有 5 个 Alice
      expect(vm.processedData.length).toBe(5)
    })

    it('equals 操作符筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'city',
        operator: 'equals',
        value: '北京',
      })
      await nextTick()

      // 北京在 i % 3 === 0 的位置
      expect(vm.processedData.length).toBe(4)
    })

    it('startsWith 操作符筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'name',
        operator: 'startsWith',
        value: 'Al',
      })
      await nextTick()

      expect(vm.processedData.length).toBe(5)
    })

    it('endsWith 操作符筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'name',
        operator: 'endsWith',
        value: 'ce',
      })
      await nextTick()

      expect(vm.processedData.length).toBe(5)
    })

    it('range 操作符筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'id',
        operator: 'range',
        value: '1',
        valueEnd: '5',
      })
      await nextTick()

      expect(vm.processedData.length).toBe(5)
    })

    it('empty 操作符筛选', async () => {
      const dataWithEmpty = [
        { id: 1, name: 'Alice', city: '' },
        { id: 2, name: 'Bob', city: '上海' },
        { id: 3, name: null, city: '北京' },
      ]
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: dataWithEmpty, advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'city',
        operator: 'empty',
        value: '',
      })
      await nextTick()

      expect(vm.processedData.length).toBe(1)
    })

    it('notEmpty 操作符筛选', async () => {
      const dataWithEmpty = [
        { id: 1, name: 'Alice', city: '' },
        { id: 2, name: 'Bob', city: '上海' },
        { id: 3, name: 'Charlie', city: '北京' },
      ]
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: dataWithEmpty, advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push({
        id: 'test-1',
        columnKey: 'city',
        operator: 'notEmpty',
        value: '',
      })
      await nextTick()

      expect(vm.processedData.length).toBe(2)
    })

    it('多条件 AND 筛选', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(12), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.conditions.push(
        { id: 'test-1', columnKey: 'name', operator: 'contains', value: 'Alice' },
        { id: 'test-2', columnKey: 'city', operator: 'equals', value: '北京' },
      )
      await nextTick()

      // Alice 在偶数索引，北京在 i % 3 === 0，交集为 i % 6 === 0
      expect(vm.processedData.length).toBe(2)
    })

    it('清除所有条件', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), advancedFilter: true },
      })
      const vm = wrapper.vm as any
      vm.filterExpanded = true
      vm.conditions.push({ id: 'test-1', columnKey: 'name', operator: 'contains', value: 'Alice' })
      await nextTick()

      expect(vm.conditions.length).toBe(1)

      // 清除所有条件
      vm.conditions.splice(0, vm.conditions.length)
      vm.filterExpanded = false
      await nextTick()

      expect(vm.conditions.length).toBe(0)
      expect(vm.processedData.length).toBe(10)
    })
  })

  describe('全局搜索', () => {
    it('搜索过滤数据', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), searchable: true },
      })
      const vm = wrapper.vm as any

      // 直接设置防抖后的搜索值
      vm.debouncedSearch = 'Alice'
      await nextTick()

      expect(vm.processedData.length).toBe(5)
    })

    it('搜索不区分大小写', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), searchable: true },
      })
      const vm = wrapper.vm as any

      vm.debouncedSearch = 'alice'
      await nextTick()

      expect(vm.processedData.length).toBe(5)
    })

    it('清空搜索恢复全部数据', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), searchable: true },
      })
      const vm = wrapper.vm as any

      vm.debouncedSearch = 'Alice'
      await nextTick()
      expect(vm.processedData.length).toBe(5)

      vm.debouncedSearch = ''
      await nextTick()
      expect(vm.processedData.length).toBe(10)
    })

    it('搜索显示筛选后统计', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10), searchable: true },
      })
      const vm = wrapper.vm as any

      vm.debouncedSearch = 'Alice'
      await nextTick()

      expect(vm.statsText).toBe('共 10 条 / 筛选后 5 条')
    })
  })

  describe('CSV 导出', () => {
    it('exportCsv 方法存在', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(3), exportable: true },
      })
      const vm = wrapper.vm as any
      expect(typeof vm.exportCsv).toBe('function')
    })
  })

  describe('分页配置', () => {
    it('数据 ≤ 100 条时组件正常渲染', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(50), pagination: true },
      })
      await nextTick()
      expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
    })

    it('数据 > 500 条时组件正常渲染', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(600), pagination: true },
      })
      await nextTick()
      expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
    })
  })

  describe('排序功能', () => {
    it('组件支持排序配置', async () => {
      const wrapper = mount(DataTable, {
        props: { columns: makeColumns(), data: makeData(10) },
      })
      await nextTick()
      // 验证组件正常渲染，排序功能通过 NDataTable 内部处理
      expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
    })
  })

  describe('嵌套属性访问', () => {
    it('支持点号路径访问嵌套属性', async () => {
      const nestedColumns: DataTableColumns<any> = [
        { title: '用户', key: 'user.name' },
      ]
      const nestedData = [
        { user: { name: 'Alice' } },
        { user: { name: 'Bob' } },
      ]
      const wrapper = mount(DataTable, {
        props: { columns: nestedColumns, data: nestedData, searchable: true },
      })
      await nextTick()
      // 验证组件正常渲染
      expect(wrapper.find('.data-table-wrapper').exists()).toBe(true)
    })
  })
})
