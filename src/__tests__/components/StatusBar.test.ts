import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import StatusBar from '@/components/workspace/StatusBar.vue'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/types'

function mockNode(name: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: `/${name}` }
}

describe('StatusBar', () => {
  beforeEach(() => {
    const { reset } = useTabManager()
    reset()
  })

  it('无打开文件时显示"无文件打开"', () => {
    const wrapper = mount(StatusBar)
    expect(wrapper.text()).toContain('无文件打开')
  })

  it('显示活动标签页的文件信息', () => {
    const { openTab } = useTabManager()
    openTab(mockNode('test.txt'), 'archive-1')

    const wrapper = mount(StatusBar)
    // 有插件名等信息
    expect(wrapper.text()).not.toBe('无文件打开')
  })

  it('显示文件大小（当有 content.size 时）', () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('large.csv'), 'archive-1')
    // 模拟设置 content
    const tab = tabs.value[0]
    if (tab) {
      tab.content = {
        type: 'csv',
        data: { headers: [], rows: [] },
        lineCount: 100,
        pluginName: 'CSV解析器',
        size: 2048,
      }
    }

    const wrapper = mount(StatusBar)
    // formatSize(2048) 输出 '2 KB'（parseFloat 去掉尾随零）
    expect(wrapper.text()).toContain('2 KB')
  })

  it('包含字体缩放滑块', () => {
    const wrapper = mount(StatusBar)
    const rangeInput = wrapper.find('input[type="range"]')
    expect(rangeInput.exists()).toBe(true)
    expect(rangeInput.attributes('min')).toBe('10')
    expect(rangeInput.attributes('max')).toBe('24')
  })

  it('文件大小小于 1KB 时显示 B', () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('tiny.txt'), 'archive-1')
    const tab = tabs.value[0]
    if (tab) {
      tab.content = {
        type: 'text',
        data: '',
        lineCount: 1,
        pluginName: '文本解析器',
        size: 512,
      }
    }

    const wrapper = mount(StatusBar)
    expect(wrapper.text()).toContain('512 B')
  })

  it('文件大小大于 1MB 时显示 MB', () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('big.json'), 'archive-1')
    const tab = tabs.value[0]
    if (tab) {
      tab.content = {
        type: 'json',
        data: {},
        lineCount: 5000,
        pluginName: 'JSON解析器',
        size: 2.5 * 1024 * 1024,
      }
    }

    const wrapper = mount(StatusBar)
    expect(wrapper.text()).toContain('2.5 MB')
  })
})
