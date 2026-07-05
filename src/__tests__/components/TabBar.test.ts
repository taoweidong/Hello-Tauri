import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import TabBar from '@/components/workspace/TabBar.vue'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/types'

function mockNode(name: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: `/${name}` }
}

describe('TabBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const { reset } = useTabManager()
    reset()
  })

  it('无标签页时渲染欢迎页', () => {
    const wrapper = mount(TabBar)
    expect(wrapper.findComponent({ name: 'WelcomePage' }).exists()).toBe(true)
  })

  it('有标签页时渲染标签栏', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('test.txt'), 'archive-1')

    const wrapper = mount(TabBar)
    await nextTick()

    expect(wrapper.find('.tab-bar-wrapper').exists()).toBe(true)
    expect(wrapper.find('.tab-item').exists()).toBe(true)
  })

  it('显示标签页文件名', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('data.json'), 'archive-1')

    const wrapper = mount(TabBar)
    await nextTick()

    const tabLabels = wrapper.findAll('.tab-label')
    expect(tabLabels.length).toBe(1)
    expect(tabLabels[0].text()).toBe('data.json')
  })

  it('多个标签页时显示所有标签', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive-1')
    openTab(mockNode('b.csv'), 'archive-1')
    openTab(mockNode('c.json'), 'archive-1')

    const wrapper = mount(TabBar)
    await nextTick()

    const items = wrapper.findAll('.tab-item')
    expect(items.length).toBe(3)
  })

  it('点击标签页切换活动标签', async () => {
    const { openTab, tabs, activeTabId } = useTabManager()
    openTab(mockNode('a.txt'), 'archive-1')
    openTab(mockNode('b.txt'), 'archive-1')

    // 当前活动标签是 b.txt
    expect(tabs.value.find(t => t.id === activeTabId.value)?.fileNode.label).toBe('b.txt')

    const wrapper = mount(TabBar)
    await nextTick()

    // 点击第一个标签（a.txt）
    const tabItems = wrapper.findAll('.tab-item')
    await tabItems[0].trigger('click')

    // 活动标签应切换为 a.txt
    expect(tabs.value.find(t => t.id === activeTabId.value)?.fileNode.label).toBe('a.txt')
  })

  it('活动标签有 active 样式', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('active.txt'), 'archive-1')

    const wrapper = mount(TabBar)
    await nextTick()

    const activeTab = wrapper.find('.tab-active')
    expect(activeTab.exists()).toBe(true)
    expect(activeTab.find('.tab-label').text()).toBe('active.txt')
  })

  it('非固定标签显示关闭按钮', async () => {
    const { openTab } = useTabManager()
    openTab(mockNode('closable.txt'), 'archive-1')

    const wrapper = mount(TabBar)
    await nextTick()

    const closeBtn = wrapper.find('.tab-close-btn')
    expect(closeBtn.exists()).toBe(true)
  })

  it('固定标签不显示关闭按钮', async () => {
    const { openTab, togglePin } = useTabManager()
    openTab(mockNode('pinned.txt'), 'archive-1')
    const tab = useTabManager().tabs.value[0]
    togglePin(tab.id)

    const wrapper = mount(TabBar)
    await nextTick()

    // 固定标签不应有关闭按钮
    const pinnedTab = wrapper.find('.tab-pinned')
    expect(pinnedTab.exists()).toBe(true)
    expect(pinnedTab.find('.tab-close-btn').exists()).toBe(false)
  })

  it('点击关闭按钮关闭标签', async () => {
    const { openTab, tabs } = useTabManager()
    openTab(mockNode('close-me.txt'), 'archive-1')
    expect(tabs.value.length).toBe(1)

    const wrapper = mount(TabBar)
    await nextTick()

    const closeBtn = wrapper.find('.tab-close-btn')
    await closeBtn.trigger('click')

    expect(tabs.value.length).toBe(0)
  })

  it('关闭所有标签后显示欢迎页', async () => {
    const { openTab, closeTab, tabs } = useTabManager()
    openTab(mockNode('temp.txt'), 'archive-1')
    const tabId = tabs.value[0].id
    closeTab(tabId)

    const wrapper = mount(TabBar)
    await nextTick()

    expect(wrapper.findComponent({ name: 'WelcomePage' }).exists()).toBe(true)
  })
})
