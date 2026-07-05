import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NScrollbar } from 'naive-ui'
import PropertyPanel from '@/components/property-panel/PropertyPanel.vue'

describe('PropertyPanel', () => {
  it('渲染压缩包信息区域', () => {
    const wrapper = mount(PropertyPanel)
    expect(wrapper.findComponent({ name: 'ArchiveInfo' }).exists()).toBe(true)
  })

  it('渲染文件信息区域', () => {
    const wrapper = mount(PropertyPanel)
    expect(wrapper.text()).toContain('文件信息')
  })

  it('包含 MetadataView 组件', () => {
    const wrapper = mount(PropertyPanel)
    expect(wrapper.findComponent({ name: 'MetadataView' }).exists()).toBe(true)
  })

  it('包含 PathBreadcrumb 组件', () => {
    const wrapper = mount(PropertyPanel)
    expect(wrapper.findComponent({ name: 'PathBreadcrumb' }).exists()).toBe(true)
  })

  it('使用 NScrollbar 包裹内容', () => {
    const wrapper = mount(PropertyPanel)
    expect(wrapper.findComponent(NScrollbar).exists()).toBe(true)
  })
})
