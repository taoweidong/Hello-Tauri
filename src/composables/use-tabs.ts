import { ref, computed } from 'vue'
import type { TabItem, FileTreeNode } from '@/types'

const tabs = ref<TabItem[]>([])
const activeTabId = ref<string | null>(null)

/** 光标位置（行:列），由渲染器更新 */
const cursorPosition = ref<{ line: number; column: number }>({ line: 1, column: 1 })

/** 最近打开的文件路径（去重，最多保留 10 条） */
const recentFiles = ref<string[]>([])

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

    // 记录最近文件
    const filePath = node.path || node.label
    recentFiles.value = [filePath, ...recentFiles.value.filter(p => p !== filePath)].slice(0, 10)
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

  function setCursor(line: number, column: number) {
    cursorPosition.value = { line, column }
  }

  function reset() {
    tabs.value = []
    activeTabId.value = null
    nextTabId = 0
    cursorPosition.value = { line: 1, column: 1 }
    recentFiles.value = []
  }

  return { tabs, activeTab, activeTabId, cursorPosition, recentFiles, openTab, closeTab, activateTab, togglePin, closeAll, setCursor, reset }
}
