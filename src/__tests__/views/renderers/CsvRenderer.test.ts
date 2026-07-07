import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CsvRenderer from '@/views/renderers/CsvRenderer.vue'

describe('CsvRenderer', () => {
  it('空数据时渲染 NEmpty', () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: [], rows: [] } },
    })
    expect(wrapper.text()).toContain('空表格')
  })

  it('有数据时渲染表头', () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: ['姓名', '年龄'], rows: [['Alice', '30']] } },
    })
    const ths = wrapper.findAll('th')
    expect(ths.length).toBe(2)
    expect(ths[0].text()).toBe('姓名')
    expect(ths[1].text()).toBe('年龄')
  })

  it('有数据时渲染数据行', () => {
    const wrapper = mount(CsvRenderer, {
      props: {
        content: {
          headers: ['a', 'b'],
          rows: [['1', '2'], ['3', '4']],
        },
      },
    })
    const trs = wrapper.findAll('tbody tr')
    expect(trs.length).toBe(2)
    const tds = wrapper.findAll('td')
    expect(tds.length).toBe(4)
    expect(tds[0].text()).toBe('1')
  })

  it('仅有表头无数据行时正常渲染', () => {
    const wrapper = mount(CsvRenderer, {
      props: { content: { headers: ['col1'], rows: [] } },
    })
    // 有表头就不应显示空表格提示
    expect(wrapper.find('.csv-renderer').exists()).toBe(true)
    expect(wrapper.findAll('th').length).toBe(1)
    expect(wrapper.findAll('tbody tr').length).toBe(0)
  })
})
