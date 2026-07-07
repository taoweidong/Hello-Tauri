<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { NDropdown } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'
import WelcomePage from './WelcomePage.vue'

const { tabs, activeTabId, activateTab, closeTab, togglePin, closeOthers, closeRight } = useTabManager()

const tabValue = computed(() => activeTabId.value ?? undefined)

// ── 标签页溢出滚动 ──
const tabsContainerRef = ref<HTMLElement | null>(null)
const showScrollLeft = ref(false)
const showScrollRight = ref(false)

function checkOverflow() {
  const el = tabsContainerRef.value
  if (!el) return
  showScrollLeft.value = el.scrollLeft > 0
  showScrollRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
}

function scrollLeft() {
  tabsContainerRef.value?.scrollBy({ left: -200, behavior: 'smooth' })
}
function scrollRight() {
  tabsContainerRef.value?.scrollBy({ left: 200, behavior: 'smooth' })
}

onMounted(() => {
  checkOverflow()
  window.addEventListener('resize', checkOverflow)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', checkOverflow)
})

// 标签页变化时重新检查溢出状态
watch(tabs, () => nextTick(checkOverflow), { deep: true })

// ── 右键菜单 ──
const contextMenuTabId = ref<string | null>(null)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const showContextMenu = ref(false)

function handleContextMenu(e: MouseEvent, tabId: string) {
  e.preventDefault()
  contextMenuTabId.value = tabId
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
  showContextMenu.value = true
}

function handleContextMenuAction(key: string) {
  const tabId = contextMenuTabId.value
  if (!tabId) return
  switch (key) {
    case 'close':
      closeTab(tabId)
      break
    case 'close-others':
      closeOthers(tabId)
      break
    case 'close-right':
      closeRight(tabId)
      break
    case 'pin':
      togglePin(tabId)
      break
  }
  showContextMenu.value = false
}

const contextMenuOptions: DropdownOption[] = [
  { key: 'close', label: '关闭' },
  { key: 'close-others', label: '关闭其他' },
  { key: 'close-right', label: '关闭右侧' },
  { key: 'pin', label: '固定/取消固定' },
]

// ── 标签页点击关闭按钮时停止冒泡 ──
function handleTabClick(tabId: string) {
  activateTab(tabId)
}

function handleCloseClick(e: MouseEvent, tabId: string) {
  e.stopPropagation()
  closeTab(tabId)
}
</script>

<template>
  <!-- 有标签页时 -->
  <div v-if="tabs.length > 0" class="tab-bar-wrapper">
    <!-- 左滚动箭头 -->
    <button v-if="showScrollLeft" class="tab-scroll-btn tab-scroll-left" @click="scrollLeft">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>

    <!-- 标签页列表 -->
    <div ref="tabsContainerRef" class="tab-list" @scroll="checkOverflow">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        :ref="(el) => { if (tab.id === activeTabId && el) (el as HTMLElement)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }"
        class="tab-item"
        :class="{ 'tab-active': tab.id === activeTabId, 'tab-pinned': tab.pinned }"
        @click="handleTabClick(tab.id)"
        @contextmenu="(e) => handleContextMenu(e, tab.id)"
      >
        <span v-if="tab.pinned" class="tab-pin-icon">📌</span>
        <span class="tab-label">{{ tab.fileNode.label }}</span>
        <button
          v-if="!tab.pinned"
          class="tab-close-btn"
          @click="(e) => handleCloseClick(e, tab.id)"
          title="关闭标签"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>

    <!-- 右滚动箭头 -->
    <button v-if="showScrollRight" class="tab-scroll-btn tab-scroll-right" @click="scrollRight">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  </div>

  <!-- 无标签页时：欢迎页 -->
  <div v-else class="flex-1">
    <WelcomePage />
  </div>

  <!-- 右键菜单（始终挂载，由 show 控制显隐） -->
  <NDropdown
    :show="showContextMenu"
    :x="contextMenuX"
    :y="contextMenuY"
    :options="contextMenuOptions"
    placement="bottom-start"
    trigger="manual"
    @select="handleContextMenuAction"
    @clickoutside="showContextMenu = false"
  />
</template>

<style scoped>
/* ── 标签栏容器 ── */
.tab-bar-wrapper {
  display: flex;
  align-items: stretch;
  height: 36px;
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border);
  user-select: none;
}

/* ── 滚动箭头 ── */
.tab-scroll-btn {
  flex-shrink: 0;
  width: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-surface);
  border: none;
  cursor: pointer;
  color: var(--color-text-secondary);
  transition: color 0.15s, background 0.15s;
}
.tab-scroll-btn:hover {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}
.tab-scroll-left {
  border-right: 1px solid var(--color-border);
}
.tab-scroll-right {
  border-left: 1px solid var(--color-border);
}

/* ── 标签列表 ── */
.tab-list {
  flex: 1;
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  gap: 2px;
}
.tab-list::-webkit-scrollbar {
  display: none;
}

/* ── 单个标签项 ── */
.tab-item {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 12px;
  height: 100%;
  min-width: 0;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  background: var(--color-bg-elevated);
  border-right: 1px solid var(--color-border);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s, color 0.15s;
}
.tab-item:hover {
  color: var(--color-text-primary);
  background: color-mix(in srgb, var(--color-bg-elevated) 92%, var(--color-primary));
}
.tab-item.tab-active {
  color: var(--color-primary);
  background: var(--color-bg-base);
  border-bottom: 2px solid var(--color-primary);
  margin-bottom: -1px;
}
.tab-item.tab-pinned {
  padding-right: 10px;
}

.tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}
.tab-pin-icon {
  font-size: 10px;
  line-height: 1;
}

/* ── 关闭按钮 ── */
.tab-close-btn {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-disabled);
  transition: all 0.15s;
  padding: 0;
}
.tab-close-btn:hover {
  color: var(--color-error);
  background: color-mix(in srgb, var(--color-error) 20%, transparent);
}
</style>
