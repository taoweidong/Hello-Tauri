import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import MetadataView from '@/components/property-panel/MetadataView.vue'
import PathBreadcrumb from '@/components/property-panel/PathBreadcrumb.vue'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/types'

function mockNode(name: string, path?: string, size?: number): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: path || `/${name}`, size }
}

describe('MetadataView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
  })

  it('无活动标签时显示"选择文件查看详情"', () => {
    const wrapper = mount(MetadataView)
    expect(wrapper.text()).toContain('选择文件查看详情')
  })

  it('有活动标签时渲染文件信息', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('data.csv', '/root/data.csv', 1024), 'archive-1')
    await nextTick()

    const wrapper = mount(MetadataView)
    await nextTick()
    // 应显示文件名
    expect(wrapper.text()).toContain('data.csv')
    // 应显示路径
    expect(wrapper.text()).toContain('/root/data.csv')
    // 应显示大小
    expect(wrapper.text()).toContain('1024 B')
  })

  it('有内容时显示类型和插件名', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('test.txt'), 'archive-1')
    // 模拟设置内容
    const tab = tabs.value[0]
    tab.content = {
      type: 'text',
      data: 'hello',
      pluginName: 'text',
      lineCount: 1,
      loadTimeMs: 5.5,
    }
    await nextTick()

    const wrapper = mount(MetadataView)
    await nextTick()
    expect(wrapper.text()).toContain('text')
    expect(wrapper.text()).toContain('5.5')
  })
})

describe('PathBreadcrumb', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
  })

  it('无活动标签时不渲染面包屑', () => {
    const wrapper = mount(PathBreadcrumb)
    expect(wrapper.findComponent({ name: 'Breadcrumb' }).exists()).toBe(false)
  })

  it('有活动标签时渲染面包屑', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('file.txt', '/a/b/file.txt'), 'archive-1')
    await nextTick()

    const wrapper = mount(PathBreadcrumb)
    await nextTick()
    expect(wrapper.findComponent({ name: 'Breadcrumb' }).exists()).toBe(true)
    // 应包含路径段
    expect(wrapper.text()).toContain('a')
    expect(wrapper.text()).toContain('b')
    expect(wrapper.text()).toContain('file.txt')
  })
})
