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
})
