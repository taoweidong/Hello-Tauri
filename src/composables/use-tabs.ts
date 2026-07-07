import { ref, computed } from 'vue'
import type { TabItem, FileTreeNode } from '@/types'

/** 所有标签页列表（模块级单例） */
const tabs = ref<TabItem[]>([])
/** 当前激活的标签页 id */
const activeTabId = ref<string | null>(null)

/** 光标位置（行:列），由渲染器更新 */
const cursorPosition = ref<{ line: number; column: number }>({ line: 1, column: 1 })

/** 最近打开的文件路径（去重，最多保留 10 条） */
const recentFiles = ref<string[]>([])

/** 标签页数量上限，超出后按先进先出淘汰最早的非固定标签页 */
const MAX_TABS = 10

/** 下一个标签页 id 计数器 */
let nextTabId = 0

/** 标签页管理 composable，提供标签页的开关、激活、固定等操作 */
export function useTabManager() {
  /** 当前激活的标签页（计算属性） */
  const activeTab = computed(() =>
    tabs.value.find(t => t.id === activeTabId.value) ?? null
  )

  /**
   * 打开文件标签页（已存在则激活）
   * @param node - 文件树节点
   * @param archiveId - 所属归档 id
   */
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

    // 超出上限时淘汰最早的非固定标签页（FIFO）
    while (tabs.value.length > MAX_TABS) {
      const victim = tabs.value.find(t => !t.pinned)
      if (!victim) break // 全是固定标签则不再淘汰
      const victimIdx = tabs.value.indexOf(victim)
      tabs.value.splice(victimIdx, 1)
      // 如果淘汰的恰好是当前激活标签，切换到最后一个
      if (activeTabId.value === victim.id) {
        activeTabId.value = tabs.value[Math.min(victimIdx, tabs.value.length - 1)]?.id ?? null
      }
    }

    // 记录最近文件
    const filePath = node.path || node.label
    recentFiles.value = [filePath, ...recentFiles.value.filter(p => p !== filePath)].slice(0, 10)
  }

  /**
   * 关闭指定标签页
   * @param id - 标签页 id
   */
  function closeTab(id: string) {
    const index = tabs.value.findIndex(t => t.id === id)
    if (index === -1) return
    tabs.value.splice(index, 1)
    if (activeTabId.value === id) {
      activeTabId.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id ?? null
    }
  }

  /**
   * 激活指定标签页
   * @param id - 标签页 id
   */
  function activateTab(id: string) {
    activeTabId.value = id
  }

  /**
   * 切换标签页固定状态
   * @param id - 标签页 id
   */
  function togglePin(id: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.pinned = !tab.pinned
  }

  /**
   * 关闭除指定标签页外的所有非固定标签页
   * @param id - 保留的标签页 id
   */
  function closeOthers(id: string) {
    tabs.value.filter(t => t.id !== id && !t.pinned).forEach(t => closeTab(t.id))
  }

  /**
   * 关闭指定标签页右侧的所有标签页
   * @param id - 标签页 id
   */
  function closeRight(id: string) {
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx === -1) return
    tabs.value.slice(idx + 1).forEach(t => closeTab(t.id))
  }

  /** 关闭所有非固定标签页 */
  function closeAll() {
    tabs.value = tabs.value.filter(t => t.pinned)
    activeTabId.value = tabs.value[0]?.id ?? null
  }

  /**
   * 设置光标位置
   * @param line - 行号
   * @param column - 列号
   */
  function setCursor(line: number, column: number) {
    cursorPosition.value = { line, column }
  }

  /** 重置所有标签页状态（测试用） */
  function reset() {
    tabs.value = []
    activeTabId.value = null
    nextTabId = 0
    cursorPosition.value = { line: 1, column: 1 }
    recentFiles.value = []
  }

  return { tabs, activeTab, activeTabId, cursorPosition, recentFiles, openTab, closeTab, activateTab, togglePin, closeOthers, closeRight, closeAll, setCursor, reset }
}
