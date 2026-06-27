import { ref, computed } from 'vue'
import type { TabItem, FileTreeNode } from '@/adapters/types'

const tabs = ref<TabItem[]>([])
const activeTabId = ref<string | null>(null)

let nextTabId = 0

export function useTabManager() {
  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value) ?? null
  )

  function openTab(node: FileTreeNode, archiveId: string) {
    const existing = tabs.value.find(
      t => t.fileNode.key === node.key && t.archiveId === archiveId
    )
    if (existing) {
      activeTabId.value = existing.id
      return
    }

    const tab: TabItem = {
      id: `tab_${nextTabId++}`,
      fileNode: node,
      archiveId,
      pinned: false,
    }
    tabs.value.push(tab)
    activeTabId.value = tab.id
  }

  function closeTab(id: string) {
    const index = tabs.value.findIndex(t => t.id === id)
    if (index === -1) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id ?? null
    }
  }

  function activateTab(id: string) {
    activeTabId.value = id
  }

  function togglePin(id: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.pinned = !tab.pinned
  }

  function closeAll() {
    tabs.value = tabs.value.filter(t => t.pinned)
    activeTabId.value = tabs.value[0]?.id ?? null
  }

  function reset() {
    tabs.value = []
    activeTabId.value = null
    nextTabId = 0
  }

  return { tabs, activeTab, activeTabId, openTab, closeTab, activateTab, togglePin, closeAll, reset }
}
