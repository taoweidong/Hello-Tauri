import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NInputNumber, NSelect, NSwitch } from 'naive-ui'
import PreviewToolbar from '@/components/workspace/PreviewToolbar.vue'

describe('PreviewToolbar', () => {
  it('渲染字号输入框', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'text' },
    })
    expect(wrapper.text()).toContain('字号')
    // 通过组件类查找
    expect(wrapper.findComponent(NInputNumber).exists()).toBe(true)
  })

  it('默认字号为 14', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'text' },
    })
    const numberInput = wrapper.findComponent(NInputNumber)
    expect(numberInput.exists()).toBe(true)
    // NInputNumber 使用 v-model:value，检查传入的 modelValue
    expect(numberInput.props('value')).toBe(14)
  })

  it('text 类型显示换行和行号开关', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'text' },
    })
    expect(wrapper.text()).toContain('换行')
    expect(wrapper.text()).toContain('行号')
    expect(wrapper.text()).toContain('编码')
    // 有两个 NSwitch
    const switches = wrapper.findAllComponents(NSwitch)
    expect(switches.length).toBe(2)
  })

  it('hex 类型显示换行和行号开关', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'hex' },
    })
    expect(wrapper.text()).toContain('换行')
    expect(wrapper.text()).toContain('行号')
  })

  it('csv 类型不显示换行和行号开关', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'csv' },
    })
    expect(wrapper.text()).not.toContain('换行')
    expect(wrapper.text()).not.toContain('行号')
  })

  it('json 类型不显示换行和行号开关', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'json' },
    })
    expect(wrapper.text()).not.toContain('换行')
    expect(wrapper.text()).not.toContain('行号')
  })

  it('log 类型不显示换行和行号开关', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'log' },
    })
    expect(wrapper.text()).not.toContain('换行')
    expect(wrapper.text()).not.toContain('行号')
  })

  it('包含编码选择器', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'text' },
    })
    const select = wrapper.findComponent(NSelect)
    expect(select.exists()).toBe(true)
    expect(select.props('options')).toEqual([
      { label: 'UTF-8', value: 'utf-8' },
      { label: 'GBK', value: 'gbk' },
      { label: 'Shift_JIS', value: 'shift_jis' },
    ])
  })

  it('默认编码为 utf-8', () => {
    const wrapper = mount(PreviewToolbar, {
      props: { type: 'text' },
    })
    const select = wrapper.findComponent(NSelect)
    expect(select.props('value')).toBe('utf-8')
  })
})
