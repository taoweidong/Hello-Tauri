import { describe, it, expect, beforeEach } from 'vitest'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/types'

function mockNode(name: string): FileTreeNode {
  return { key: name, label: name, isLeaf: true, path: `/${name}` }
}

describe('useTabManager', () => {
  beforeEach(() => {
    const { reset } = useTabManager()
    reset()
  })

  it('opens a new tab', () => {
    const { tabs, activeTab, openTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    expect(tabs.value).toHaveLength(1)
    expect(activeTab.value?.fileNode.label).toBe('a.txt')
  })

  it('activates existing tab instead of opening duplicate', () => {
    const { tabs, openTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('a.txt'), 'archive1')
    expect(tabs.value).toHaveLength(1)
  })

  it('closes a tab', () => {
    const { tabs, openTab, closeTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    const id = tabs.value[0].id
    closeTab(id)
    expect(tabs.value).toHaveLength(0)
  })

  it('activates next tab when closing active tab', () => {
    const { tabs, activeTab, openTab, closeTab } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('b.txt'), 'archive1')
    const firstId = tabs.value[0].id
    openTab(mockNode('a.txt'), 'archive1')
    closeTab(tabs.value.find(t => t.fileNode.label === 'a.txt')!.id)
    expect(activeTab.value?.fileNode.label).toBe('b.txt')
  })

  it('toggles pin', () => {
    const { tabs, openTab, togglePin } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    const id = tabs.value[0].id
    togglePin(id)
    expect(tabs.value[0].pinned).toBe(true)
    togglePin(id)
    expect(tabs.value[0].pinned).toBe(false)
  })

  it('closeAll keeps pinned tabs and clears activeTabId', () => {
    const { tabs, activeTab, openTab, togglePin, closeAll } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('b.txt'), 'archive1')
    const pinId = tabs.value[0].id
    togglePin(pinId)
    closeAll()
    expect(tabs.value).toHaveLength(1)
    expect(tabs.value[0].id).toBe(pinId)
    expect(activeTab.value).not.toBeNull()
  })

  it('closeAll sets activeTabId to null when no pinned tabs', () => {
    const { tabs, activeTab, openTab, closeAll } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    closeAll()
    expect(tabs.value).toHaveLength(0)
    expect(activeTab.value).toBeNull()
  })

  it('超过 10 个标签页时按 FIFO 淘汰最早的非固定标签页', () => {
    const { tabs, openTab } = useTabManager()
    for (let i = 0; i < 12; i++) {
      openTab(mockNode(`file${i}.txt`), 'archive1')
    }
    expect(tabs.value).toHaveLength(10)
    // 最早的两个应被淘汰
    expect(tabs.value.find(t => t.fileNode.label === 'file0.txt')).toBeUndefined()
    expect(tabs.value.find(t => t.fileNode.label === 'file1.txt')).toBeUndefined()
    // 最新的应在列表中
    expect(tabs.value.find(t => t.fileNode.label === 'file11.txt')).toBeDefined()
  })

  it('FIFO 淘汰时跳过固定标签页', () => {
    const { tabs, openTab, togglePin } = useTabManager()
    for (let i = 0; i < 10; i++) {
      openTab(mockNode(`file${i}.txt`), 'archive1')
    }
    // 固定第一个标签页
    togglePin(tabs.value[0].id)
    // 再打开两个新标签
    openTab(mockNode('file10.txt'), 'archive1')
    openTab(mockNode('file11.txt'), 'archive1')
    expect(tabs.value).toHaveLength(10)
    // 固定的标签应保留
    expect(tabs.value.find(t => t.fileNode.label === 'file0.txt')).toBeDefined()
    // 第二个非固定标签应被淘汰
    expect(tabs.value.find(t => t.fileNode.label === 'file1.txt')).toBeUndefined()
  })

  it('closeOthers 关闭除指定标签外的所有非固定标签', () => {
    const { tabs, openTab, togglePin, closeOthers } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('b.txt'), 'archive1')
    openTab(mockNode('c.txt'), 'archive1')
    // 固定第一个
    togglePin(tabs.value[0].id)
    // 以第二个为基准关闭其他
    closeOthers(tabs.value[1].id)
    expect(tabs.value).toHaveLength(2)
    expect(tabs.value[0].fileNode.label).toBe('a.txt') // 固定的保留
    expect(tabs.value[1].fileNode.label).toBe('b.txt') // 指定的保留
  })

  it('closeRight 关闭指定标签右侧的所有标签', () => {
    const { tabs, openTab, closeRight } = useTabManager()
    openTab(mockNode('a.txt'), 'archive1')
    openTab(mockNode('b.txt'), 'archive1')
    openTab(mockNode('c.txt'), 'archive1')
    openTab(mockNode('d.txt'), 'archive1')
    const firstId = tabs.value[0].id
    closeRight(firstId)
    expect(tabs.value).toHaveLength(1)
    expect(tabs.value[0].fileNode.label).toBe('a.txt')
  })
})
