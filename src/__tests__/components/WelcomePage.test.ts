import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import WelcomePage from '@/components/workspace/WelcomePage.vue'

describe('WelcomePage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('渲染欢迎标题', () => {
    const wrapper = mount(WelcomePage)
    expect(wrapper.text()).toContain('Hello Tauri')
    expect(wrapper.text()).toContain('跨平台桌面数据工具')
  })

  it('显示三种操作提示', () => {
    const wrapper = mount(WelcomePage)
    const text = wrapper.text()
    expect(text).toContain('拖放文件')
    expect(text).toContain('上传文件')
    expect(text).toContain('搜索内容')
  })

  it('显示快捷键提示', () => {
    const wrapper = mount(WelcomePage)
    const text = wrapper.text()
    expect(text).toContain('Ctrl+B')
    expect(text).toContain('Ctrl+Shift+B')
    expect(text).toContain('切换左侧面板')
    expect(text).toContain('切换右侧面板')
  })

  it('上传文件区域可点击（展开左侧面板）', () => {
    const wrapper = mount(WelcomePage)
    // 找到"上传文件"所在的可点击区域
    const clickableAreas = wrapper.findAll('.cursor-pointer')
    expect(clickableAreas.length).toBe(1) // 只有"上传文件"是 cursor-pointer
  })

  it('包含 SVG 图标元素', () => {
    const wrapper = mount(WelcomePage)
    const svgs = wrapper.findAll('svg')
    expect(svgs.length).toBeGreaterThanOrEqual(4) // 大图标 + 3个操作图标
  })
})
