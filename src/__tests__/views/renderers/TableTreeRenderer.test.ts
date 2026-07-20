import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import TableTreeRenderer from '@/views/renderers/TableTreeRenderer.vue'
import type { CsvData } from '@/types'

// mock useTabManager
vi.mock('@/composables/use-tabs', () => ({
  useTabManager: () => ({
    globalFontSize: { value: 13 },
  }),
}))

/** 创建测试用 CSV 数据 */
function createCsvData(): CsvData {
  return {
    headers: ['name', 'age', 'city'],
    rows: [
      ['Alice', '30', '北京'],
      ['Bob', '25', '上海'],
    ],
  }
}

describe('TableTreeRenderer', () => {
  it('渲染空表格提示', async () => {
    const emptyData: CsvData = { headers: [], rows: [] }
    const wrapper = mount(TableTreeRenderer, {
      props: { content: emptyData },
      global: {
        stubs: {
          NEmpty: { template: '<div class="n-empty">空表格</div>' },
          DataTable: true,
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    expect(wrapper.find('.n-empty').exists()).toBe(true)
  })

  it('渲染 DataTable 组件', async () => {
    const wrapper = mount(TableTreeRenderer, {
      props: { content: createCsvData() },
      global: {
        stubs: {
          NEmpty: true,
          DataTable: { template: '<div class="data-table-stub">表格</div>' },
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    expect(wrapper.find('.table-tree-renderer').exists()).toBe(true)
  })

  it('未选中行时显示单栏模式', async () => {
    const wrapper = mount(TableTreeRenderer, {
      props: { content: createCsvData() },
      global: {
        stubs: {
          NEmpty: true,
          DataTable: { template: '<div class="data-table-stub">表格</div>' },
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    // 未选中行时应该显示单栏模式
    expect(wrapper.find('.table-tree-renderer').exists()).toBe(true)
    expect(wrapper.find('.table-tree-split-container').exists()).toBe(false)
  })

  it('有数据时不显示空表格提示', async () => {
    const wrapper = mount(TableTreeRenderer, {
      props: { content: createCsvData() },
      global: {
        stubs: {
          NEmpty: { template: '<div class="n-empty">空表格</div>' },
          DataTable: { template: '<div class="data-table-stub">表格</div>' },
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    expect(wrapper.find('.n-empty').exists()).toBe(false)
  })

  it('正确传递 content prop', async () => {
    const csvData = createCsvData()
    const wrapper = mount(TableTreeRenderer, {
      props: { content: csvData },
      global: {
        stubs: {
          NEmpty: true,
          DataTable: true,
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    expect(wrapper.props('content')).toEqual(csvData)
  })

  it('只有 headers 无 rows 时不显示空提示', async () => {
    const dataWithHeadersOnly: CsvData = { headers: ['a', 'b'], rows: [] }
    const wrapper = mount(TableTreeRenderer, {
      props: { content: dataWithHeadersOnly },
      global: {
        stubs: {
          NEmpty: { template: '<div class="n-empty">空表格</div>' },
          DataTable: { template: '<div class="data-table-stub">表格</div>' },
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    // headers 不为空，不显示空提示
    expect(wrapper.find('.n-empty').exists()).toBe(false)
  })

  it('只有 rows 无 headers 时不显示空提示', async () => {
    const dataWithRowsOnly: CsvData = { headers: [], rows: [['a', 'b']] }
    const wrapper = mount(TableTreeRenderer, {
      props: { content: dataWithRowsOnly },
      global: {
        stubs: {
          NEmpty: { template: '<div class="n-empty">空表格</div>' },
          DataTable: { template: '<div class="data-table-stub">表格</div>' },
          SplitView: true,
          CsvTreeDetail: true,
        },
      },
    })
    await nextTick()
    // rows 不为空，不显示空提示
    expect(wrapper.find('.n-empty').exists()).toBe(false)
  })
})
