import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

describe('CsvRenderer', () => {
  it('空数据时渲染 NEmpty', () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: [], rows: [] } },
    })
    expect(wrapper.text()).toContain('空表格')
  })

  it('有数据时渲染 DataTable 组件', async () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['姓名', '年龄'],
          rows: [['Alice', '30']],
        },
      },
    })
    await nextTick()
    // 不再渲染 .csv-renderer，而是使用 DataTable 组件
    expect(wrapper.find('.csv-renderer').exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
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
    // headers 存在就不算空表格
    expect(wrapper.text()).not.toContain('空表格')
    expect(wrapper.findComponent({ name: 'DataTable' }).exists()).toBe(true)
  })
})
