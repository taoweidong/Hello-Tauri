import { describe, it, expect, beforeEach } from 'vitest'
import { useTabManager } from '@/composables/use-tabs'
import type { FileTreeNode } from '@/adapters/types'

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
})
