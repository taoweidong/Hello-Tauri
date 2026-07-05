<script setup lang="ts">
import { ref, computed, h, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NTooltip, NDropdown } from 'naive-ui'
import type { DropdownOption } from 'naive-ui'
import { useMagicKeys, whenever } from '@vueuse/core'
import { useAppStore } from '@/stores/app'
import { useGlobalDrop } from '@/composables/use-global-drop'
import { usePanelLayout } from '@/composables/use-panel-layout'
import { themeColors, type ThemeColorKey } from '@/styles/theme'
import {
  MIN_LEFT_PANEL_WIDTH,
  MAX_LEFT_PANEL_WIDTH,
  MIN_RIGHT_PANEL_WIDTH,
  MAX_RIGHT_PANEL_WIDTH,
} from '@/config'
import PublicBar from '@/components/public-bar/PublicBar.vue'
import ArchivePanel from '@/components/archive-panel/ArchivePanel.vue'
import Workspace from '@/components/workspace/Workspace.vue'
import PropertyPanel from '@/components/property-panel/PropertyPanel.vue'
import GlobalStatusBar from '@/components/workspace/StatusBar.vue'

const store = useAppStore()
const { leftCollapsed, rightCollapsed, leftWidth, rightWidth, collapseLeft, expandLeft, collapseRight, expandRight, toggleLeft, toggleRight, setLeftWidth, setRightWidth } = usePanelLayout()

// ── 键盘快捷键（必须在组件 setup 中注册，useMagicKeys 需要事件上下文） ──
const keys = useMagicKeys()
whenever(keys['Ctrl+B'], (v) => {
  if (v) toggleLeft()
})
whenever(keys['Ctrl+Shift+B'], (v) => {
  if (v) toggleRight()
})

// ── 面板拖拽调整宽度 ──
const draggingLeft = ref(false)
const draggingRight = ref(false)

function startDragLeft(e: MouseEvent) {
  if (leftCollapsed.value) return
  draggingLeft.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function startDragRight(e: MouseEvent) {
  if (rightCollapsed.value) return
  draggingRight.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function onMouseMove(e: MouseEvent) {
  if (draggingLeft.value) {
    const newWidth = Math.max(MIN_LEFT_PANEL_WIDTH, Math.min(MAX_LEFT_PANEL_WIDTH, e.clientX))
    setLeftWidth(newWidth)
  }
  if (draggingRight.value) {
    const newWidth = Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, window.innerWidth - e.clientX))
    setRightWidth(newWidth)
  }
}

function stopDrag() {
  if (draggingLeft.value || draggingRight.value) {
    draggingLeft.value = false
    draggingRight.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
}

// 全局拖拽事件
onMounted(() => {
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', stopDrag)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', stopDrag)
})

// ── 全局拖放处理 ──
const appShellRef = ref<HTMLElement | null>(null)
const { isDragging, setup: setupDrop, cleanup: cleanupDrop } = useGlobalDrop()

onMounted(() => {
  if (appShellRef.value) setupDrop(appShellRef.value)
})
onBeforeUnmount(() => {
  cleanupDrop()
})

// ── 帮助菜单 ──
const helpOptions: DropdownOption[] = [
  {
    key: 'github',
    label: () =>
      h('a', {
        href: 'https://github.com/taoweidong/Hello-Tauri',
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'flex items-center gap-2 text-text-primary no-underline hover:text-primary transition-colors'
      }, [
        h('svg', { viewBox: '0 0 24 24', fill: 'currentColor', class: 'w-4 h-4', innerHTML: '<path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>' }),
        h('span', 'GitHub 仓库')
      ])
  },
  {
    key: 'issue',
    label: () =>
      h('a', {
        href: 'https://github.com/taoweidong/Hello-Tauri/issues/new',
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'flex items-center gap-2 text-text-primary noopener noreferrer hover:text-primary transition-colors'
      }, [
        h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'w-4 h-4', innerHTML: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>' }),
        h('span', '问题反馈')
      ])
  }
]

// ── 主题色切换 ──
const currentThemeColor = ref<ThemeColorKey>('blue')
const themeColorOptions: DropdownOption[] = [
  { key: 'blue', label: '蓝色' },
  { key: 'green', label: '绿色' },
  { key: 'purple', label: '紫色' },
  { key: 'orange', label: '橙色' },
]
function handleThemeColorSelect(key: string) {
  currentThemeColor.value = key as ThemeColorKey
  document.documentElement.style.setProperty('--color-primary', themeColors[key as ThemeColorKey])
  document.documentElement.style.setProperty('--color-primary-soft', `color-mix(in srgb, ${themeColors[key as ThemeColorKey]} 14%, transparent)`)
  document.documentElement.style.setProperty('--color-primary-hover', themeColors[key as ThemeColorKey])
}
</script>

<template>
  <div ref="appShellRef" class="absolute inset-0 grid grid-rows-[var(--spacing-header)_1fr_var(--spacing-statusbar)] bg-bg-base text-text-primary overflow-hidden" :data-theme="store.isDarkTheme ? 'dark' : 'light'">
    
    <!-- ═══════════ 顶部导航栏 48px ═══════════ -->
    <header class="flex items-center gap-4 px-4 h-header bg-bg-surface/85 backdrop-blur-md border-b border-border z-10 select-none">
      <!-- 左侧：Logo + 名称 + 徽章 -->
      <div class="flex items-center gap-2.5 shrink-0">
        <div class="w-[26px] h-[26px] flex items-center justify-center text-primary" style="filter: drop-shadow(0 0 6px color-mix(in srgb, var(--color-primary) 40%, transparent))">
          <svg viewBox="0 0 24 24" fill="none" class="w-full h-full">
            <rect x="2" y="3" width="20" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
            <path d="M2 8h20" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="5.5" cy="5.5" r="0.8" fill="currentColor"/>
            <circle cx="8.5" cy="5.5" r="0.8" fill="currentColor"/>
            <circle cx="11.5" cy="5.5" r="0.8" fill="currentColor"/>
            <rect x="5" y="11" width="6" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/>
            <path d="M14 11h5M14 14h5M14 17h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </div>
        <span class="text-[15px] font-bold tracking-[0.3px] bg-gradient-to-r from-primary to-[color-mix(in_srgb,var(--color-primary)_65%,#a855f7)] bg-clip-text text-transparent">Hello Tauri</span>
        <span class="text-[10px] px-2 py-0.5 rounded-[10px] bg-primary-soft text-primary font-medium tracking-[0.2px]">桌面工具</span>
      </div>

      <!-- 中央：PublicBar -->
      <div class="flex-1 min-w-0 h-full flex items-center">
        <PublicBar />
      </div>

      <!-- 右侧：帮助 + 主题色 + 主题切换 -->
      <div class="flex items-center gap-3 shrink-0">

        <!-- 帮助下拉菜单 -->
        <NDropdown trigger="hover" :options="helpOptions" placement="bottom-end">
          <NButton quaternary circle class="!w-8 !h-8" aria-label="帮助">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-[18px] h-[18px]">
              <circle cx="12" cy="12" r="10"/>
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
          </NButton>
        </NDropdown>

        <!-- 主题色选择器 -->
        <NDropdown trigger="click" :options="themeColorOptions" placement="bottom-end" @select="handleThemeColorSelect">
          <NButton quaternary circle class="!w-8 !h-8" aria-label="主题色">
            <span class="inline-block w-3.5 h-3.5 rounded-full" :style="{ background: themeColors[currentThemeColor] }"></span>
          </NButton>
        </NDropdown>

        <!-- 主题切换按钮 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary circle class="!w-8 !h-8" @click="store.toggleTheme">
              <Transition name="icon-spin" mode="out-in">
                <span v-if="store.isDarkTheme" key="moon" class="inline-block text-[15px] leading-none">☽</span>
                <span v-else key="sun" class="inline-block text-[15px] leading-none">☼</span>
              </Transition>
            </NButton>
          </template>
          {{ store.isDarkTheme ? '切换浅色模式' : '切换深色模式' }}
        </NTooltip>
      </div>
    </header>

    <!-- ═══════════ 主体区域：flex 三栏 + 折叠按钮 ═══════════ -->
    <div class="flex w-full box-border overflow-hidden relative">
      <!-- 左侧面板 -->
      <aside class="relative shrink-0 bg-bg-surface overflow-hidden border-r border-border transition-[width,border-color] duration-320 ease-[cubic-bezier(0.4,0,0.2,1)] box-border" :style="{ width: leftCollapsed ? '0px' : `${leftWidth}px` }">
        <div class="h-full w-full overflow-y-auto overflow-x-hidden py-2.5 px-3" :style="{ width: leftCollapsed ? '0px' : '100%' }">
          <ArchivePanel />
        </div>
      </aside>

      <!-- 左侧拖拽手柄 -->
      <div
        v-if="!leftCollapsed"
        class="shrink-0 w-[4px] h-full cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors duration-200 relative z-[4]"
        @mousedown="startDragLeft"
      >
        <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border-strong/30 group-hover:bg-primary/40"></div>
      </div>

      <!-- 左侧折叠按钮 -->
      <button
        class="shrink-0 w-[18px] h-[52px] flex items-center justify-center bg-bg-surface border border-border-strong cursor-pointer p-0 outline-none text-text-secondary self-center opacity-60 hover:opacity-100 hover:text-primary hover:bg-primary-soft transition-all duration-200 rounded-r-md border-l-0 z-[5]"
        @click="leftCollapsed ? expandLeft() : collapseLeft()"
        :title="leftCollapsed ? '展开面板 (Ctrl+B)' : '收起面板 (Ctrl+B)'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 shrink-0">
          <polyline v-if="!leftCollapsed" points="15 18 9 12 15 6"/>
          <polyline v-else points="9 18 15 12 9 6"/>
        </svg>
      </button>

      <!-- 中央工作区 -->
      <main class="flex-1 min-w-0 w-full overflow-hidden flex flex-col">
        <Workspace />
      </main>

      <!-- 右侧拖拽手柄 -->
      <div
        v-if="!rightCollapsed"
        class="shrink-0 w-[4px] h-full cursor-col-resize bg-transparent hover:bg-primary/30 transition-colors duration-200 relative z-[4]"
        @mousedown="startDragRight"
      >
        <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border-strong/30"></div>
      </div>

      <!-- 右侧折叠按钮 -->
      <button
        class="shrink-0 w-[18px] h-[52px] flex items-center justify-center bg-bg-surface border border-border-strong cursor-pointer p-0 outline-none text-text-secondary self-center opacity-60 hover:opacity-100 hover:text-primary hover:bg-primary-soft transition-all duration-200 rounded-l-md border-r-0 z-[5]"
        @click="rightCollapsed ? expandRight() : collapseRight()"
        :title="rightCollapsed ? '展开面板 (Ctrl+Shift+B)' : '收起面板 (Ctrl+Shift+B)'"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3 h-3 shrink-0">
          <polyline v-if="!rightCollapsed" points="9 18 15 12 9 6"/>
          <polyline v-else points="15 18 9 12 15 6"/>
        </svg>
      </button>

      <!-- 右侧面板 -->
      <aside class="relative shrink-0 bg-bg-surface overflow-hidden border-l border-border transition-[width,border-color] duration-320 ease-[cubic-bezier(0.4,0,0.2,1)] box-border" :style="{ width: rightCollapsed ? '0px' : `${rightWidth}px` }">
        <div class="h-full w-full overflow-y-auto overflow-x-hidden py-2.5 px-3" :style="{ width: rightCollapsed ? '0px' : '100%' }">
          <PropertyPanel />
        </div>
      </aside>
    </div>

    <!-- ═══════════ 全局状态栏 26px ═══════════ -->
    <footer class="flex items-center justify-between px-2 h-statusbar bg-bg-surface border-t border-border select-none text-[11px] text-text-secondary tracking-[0.2px]">
      <GlobalStatusBar />
    </footer>

    <!-- ═══════════ 全局拖拽上传遮罩 ═══════════ -->
    <Transition name="drop-overlay">
      <div v-if="isDragging" class="absolute inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm pointer-events-none">
        <div class="flex flex-col items-center gap-4 px-14 py-10 border-2 border-dashed border-primary rounded-2xl bg-primary-soft text-primary">
          <svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span class="text-base font-semibold tracking-[0.5px]">释放以上传压缩包</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ═══════════ 保留样式 ═══════════ */

/* 主题图标切换动画 */
.icon-spin-enter-active,
.icon-spin-leave-active {
  transition: transform 0.28s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.28s ease;
}
.icon-spin-enter-from {
  transform: rotate(-90deg) scale(0.4);
  opacity: 0;
}
.icon-spin-leave-to {
  transform: rotate(90deg) scale(0.4);
  opacity: 0;
}

/* 遮罩淡入淡出 */
.drop-overlay-enter-active,
.drop-overlay-leave-active {
  transition: opacity 0.2s ease;
}
.drop-overlay-enter-from,
.drop-overlay-leave-to {
  opacity: 0;
}

/* 面板内滚动条 */
aside div::-webkit-scrollbar {
  width: 5px;
}
aside div::-webkit-scrollbar-track {
  background: transparent;
}
aside div::-webkit-scrollbar-thumb {
  background: var(--color-border-strong);
  border-radius: 3px;
}
aside div::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-secondary);
}
</style>
