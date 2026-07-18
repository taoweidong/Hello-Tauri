import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'
import DataTable from '@/components/shared/DataTable.vue'

describe('CsvRenderer', () => {
  it('空数据时渲染 NEmpty', () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: [], rows: [] } },
    })
    expect(wrapper.text()).toContain('空表格')
  })

  it('有数据时单栏模式渲染 DataTable', async () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['姓名', '年龄'],
          rows: [['Alice', '30']],
        },
      },
    })
    await nextTick()
    // 单栏模式：.csv-renderer 存在，DataTable 组件被使用
    expect(wrapper.find('.csv-renderer').exists()).toBe(true)
    expect(wrapper.findComponent(DataTable).exists()).toBe(true)
    // 不应出现分栏容器
    expect(wrapper.find('.csv-split-container').exists()).toBe(false)
  })

  it('有数据时不显示空表格提示', async () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['a', 'b'],
          rows: [['1', '2'], ['3', '4']],
        },
      },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('空表格')
  })

  it('仅有表头无数据行时仍渲染 DataTable', async () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: ['col1'], rows: [] } },
    })
    await nextTick()
    expect(wrapper.text()).not.toContain('空表格')
    expect(wrapper.findComponent(DataTable).exists()).toBe(true)
  })

  it('选中行后切换为分栏模式并渲染树形详情', async () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['姓名', '年龄'],
          rows: [['Alice', '30'], ['Bob', '25']],
        },
      },
    })
    await nextTick()
    // 初始为单栏模式
    expect(wrapper.find('.csv-split-container').exists()).toBe(false)
    // 通过组件内部状态切换到分栏模式（避免依赖 NDataTable 行 DOM）
    const vm = wrapper.vm as any
    vm.selectedIndex = 0
    await nextTick()
    // 进入分栏模式
    expect(wrapper.find('.csv-split-container').exists()).toBe(true)
    // 树形详情面板渲染
    expect(wrapper.find('.csv-tree-detail').exists()).toBe(true)
  })

  it('关闭详情面板后回到单栏模式', async () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['姓名'],
          rows: [['Alice']],
        },
      },
    })
    await nextTick()
    // 先进入分栏模式
    const vm = wrapper.vm as any
    vm.selectedIndex = 0
    await nextTick()
    expect(wrapper.find('.csv-split-container').exists()).toBe(true)
    // 模拟点击详情面板关闭按钮
    const closeBtn = wrapper.find('button[aria-label="关闭"]')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    await nextTick()
    // 回到单栏模式
    expect(wrapper.find('.csv-split-container').exists()).toBe(false)
    expect(wrapper.find('.csv-renderer').exists()).toBe(true)
  })
})
