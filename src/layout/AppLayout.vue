<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NButton, NTooltip } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useGlobalDrop } from '@/composables/use-global-drop'
import { usePanelLayout } from '@/composables/use-panel-layout'
import PublicBar from '@/components/public-bar/PublicBar.vue'
import ArchivePanel from '@/components/archive-panel/ArchivePanel.vue'
import Workspace from '@/components/workspace/Workspace.vue'
import PropertyPanel from '@/components/property-panel/PropertyPanel.vue'

const store = useAppStore()
const { leftCollapsed, rightCollapsed, collapseLeft, expandLeft, collapseRight, expandRight } = usePanelLayout()

// ── 全局拖放处理 ──
const appShellRef = ref<HTMLElement | null>(null)
const { isDragging, setup: setupDrop, cleanup: cleanupDrop } = useGlobalDrop()

// ── 实时时钟 ──
const now = ref(new Date())
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  timer = setInterval(() => { now.value = new Date() }, 1000)
  if (appShellRef.value) setupDrop(appShellRef.value)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  cleanupDrop()
})

const timeStr = computed(() =>
  now.value.toLocaleTimeString('zh-CN', { hour12: false }),
)
const dateStr = computed(() =>
  now.value.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }),
)
</script>

<template>
  <div ref="appShellRef" class="app-shell" :data-theme="store.isDarkTheme ? 'dark' : 'light'">
    <!-- ── 顶部导航栏 ── -->
    <header class="app-header">
      <div class="header-left">
        <div class="logo-mark">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="2" y="3" width="20" height="18" rx="3" stroke="currentColor" stroke-width="1.5"/>
            <path d="M2 8h20" stroke="currentColor" stroke-width="1.5"/>
            <circle cx="5.5" cy="5.5" r="0.8" fill="currentColor"/>
            <circle cx="8.5" cy="5.5" r="0.8" fill="currentColor"/>
            <circle cx="11.5" cy="5.5" r="0.8" fill="currentColor"/>
            <rect x="5" y="11" width="6" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/>
            <path d="M14 11h5M14 14h5M14 17h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
        </div>
        <span class="app-title">Hello Tauri</span>
        <span class="app-badge">桌面工具</span>
      </div>

      <div class="header-center">
        <PublicBar />
      </div>

      <div class="header-right">
        <div class="clock-group">
          <span class="clock-time">{{ timeStr }}</span>
          <span class="clock-date">{{ dateStr }}</span>
        </div>
        
        <!-- GitHub 仓库链接 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <a href="https://github.com/taoweidong/Hello-Tauri" target="_blank" rel="noopener noreferrer" class="icon-link">
              <svg viewBox="0 0 24 24" fill="currentColor" class="github-icon">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
            </a>
          </template>
          GitHub 仓库
        </NTooltip>
        
        <!-- 问题反馈链接 -->
        <NTooltip trigger="hover">
          <template #trigger>
            <a href="https://github.com/taoweidong/Hello-Tauri/issues/new" target="_blank" rel="noopener noreferrer" class="icon-link">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="issue-icon">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 8v4M12 16h.01"/>
              </svg>
            </a>
          </template>
          问题反馈
        </NTooltip>
        
        <NTooltip trigger="hover">
          <template #trigger>
            <NButton quaternary circle class="theme-btn" @click="store.toggleTheme">
              <Transition name="icon-spin" mode="out-in">
                <span v-if="store.isDarkTheme" key="moon" class="theme-icon">&#9790;</span>
                <span v-else key="sun" class="theme-icon">&#9788;</span>
              </Transition>
            </NButton>
          </template>
          {{ store.isDarkTheme ? '切换浅色模式' : '切换深色模式' }}
        </NTooltip>
      </div>
    </header>

    <!-- ── 主体内容区 ── -->
    <div class="app-body">
      <!-- 左侧面板 -->
      <aside class="panel left-panel" :class="{ collapsed: leftCollapsed }">
        <div class="panel-inner-wrap">
          <ArchivePanel />
        </div>
      </aside>
      <button class="collapse-btn left-collapse-btn" @click="leftCollapsed ? expandLeft() : collapseLeft()"
              :title="leftCollapsed ? '展开面板' : '收起面板'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="!leftCollapsed" points="15 18 9 12 15 6"/>
          <polyline v-else points="9 18 15 12 9 6"/>
        </svg>
      </button>

      <!-- 中间工作区 -->
      <main class="workspace-area">
        <Workspace />
      </main>

      <!-- 右侧面板 -->
      <button class="collapse-btn right-collapse-btn" @click="rightCollapsed ? expandRight() : collapseRight()"
              :title="rightCollapsed ? '展开面板' : '收起面板'">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline v-if="!rightCollapsed" points="9 18 15 12 9 6"/>
          <polyline v-else points="15 18 9 12 15 6"/>
        </svg>
      </button>
      <aside class="panel right-panel" :class="{ collapsed: rightCollapsed }">
        <div class="panel-inner-wrap">
          <PropertyPanel />
        </div>
      </aside>
    </div>

    <!-- ── 底部版权栏 ── -->
    <footer class="app-footer">
      <span>© 2026 Hello Tauri · 保留所有权利</span>
      <span class="footer-divider">|</span>
      <span>跨平台桌面数据工具</span>
    </footer>

    <!-- ── 全局拖拽上传遮罩 ── -->
    <Transition name="drop-overlay">
      <div v-if="isDragging" class="drop-overlay">
        <div class="drop-overlay-content">
          <svg class="drop-overlay-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          <span class="drop-overlay-text">释放以上传压缩包</span>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════
   主题 CSS 变量（深色 / 浅色）
   ══════════════════════════════════════ */
.app-shell[data-theme='dark'] {
  --bg-base: #18181c;
  --bg-surface: #1e1e24;
  --bg-elevated: #26262e;
  --text-primary: #ffffffde;
  --text-secondary: #ffffff8c;
  --border: #ffffff1a;
  --border-strong: #ffffff2e;
  --primary: #3B82F6;
  --primary-soft: #3b82f624;
  --scrollbar: #ffffff26;
  --scrollbar-hover: #ffffff40;
}

.app-shell[data-theme='light'] {
  --bg-base: #f5f5f7;
  --bg-surface: #ffffff;
  --bg-elevated: #f0f0f3;
  --text-primary: #1a1a1a;
  --text-secondary: #666666;
  --border: #0000000f;
  --border-strong: #00000020;
  --primary: #3B82F6;
  --primary-soft: #3b82f61a;
  --scrollbar: #00000018;
  --scrollbar-hover: #00000030;
}

/* ══════════════════════════════════════
   应用外壳（CSS Grid 三行布局）
   ══════════════════════════════════════ */
.app-shell {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-rows: 52px 1fr 28px;
  background: var(--bg-base);
  color: var(--text-primary);
  overflow: hidden;
}

/* ══════════════════════════════════════
   顶部导航栏
   ══════════════════════════════════════ */
.app-header {
  display: flex;
  align-items: center;
  padding: 0 16px;
  gap: 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border);
  z-index: 10;
  user-select: none;
  -webkit-user-select: none;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.logo-mark {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--primary) 40%, transparent));
}
.logo-mark svg {
  width: 100%;
  height: 100%;
}

.app-title {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.3px;
  background: linear-gradient(135deg, var(--primary), color-mix(in srgb, var(--primary) 65%, #a855f7));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.app-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary);
  font-weight: 500;
  letter-spacing: 0.2px;
}

.header-center {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* 图标链接样式 */
.icon-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--text-secondary);
  transition: all 0.2s ease;
  text-decoration: none;
}

.icon-link:hover {
  color: var(--text-primary);
  background: var(--primary-soft);
}

.github-icon {
  width: 18px;
  height: 18px;
}

.issue-icon {
  width: 18px;
  height: 18px;
}

.clock-group {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  line-height: 1.25;
}
.clock-time {
  font-size: 13px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.6px;
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
}
.clock-date {
  font-size: 10px;
  color: var(--text-secondary);
  letter-spacing: 0.2px;
}

.theme-btn {
  width: 32px !important;
  height: 32px !important;
}
.theme-icon {
  display: inline-block;
  font-size: 15px;
  line-height: 1;
}

/* 主题图标切换动效 */
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

/* ══════════════════════════════════════
   主体内容区（flex 三栏 + 折叠按钮）
   ══════════════════════════════════════ */
.app-body {
  display: flex;
  overflow: hidden;
  position: relative;
}

/* ══════════════════════════════════════
   侧面板
   ══════════════════════════════════════ */
.panel {
  position: relative;
  flex-shrink: 0;
  background: var(--bg-surface);
  overflow: hidden;
  transition:
    width 0.32s cubic-bezier(0.4, 0, 0.2, 1),
    border-color 0.32s ease;
}

.left-panel {
  width: 280px;
  border-right: 1px solid var(--border);
}
.left-panel.collapsed {
  width: 0;
  border-right-color: transparent;
}

.right-panel {
  width: 300px;
  border-left: 1px solid var(--border);
}
.right-panel.collapsed {
  width: 0;
  border-left-color: transparent;
}

/* 面板内容包裹层（固定宽度，防折叠时内容挤压） */
.panel-inner-wrap {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 12px;
}
.left-panel .panel-inner-wrap {
  width: 280px;
}
.right-panel .panel-inner-wrap {
  width: 300px;
}

/* ══════════════════════════════════════
   折叠触发器按钮
   （flex 兄弟元素，不受面板 overflow:hidden 影响）
   ══════════════════════════════════════ */
.collapse-btn {
  flex-shrink: 0;
  width: 18px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  padding: 0;
  outline: none;
  color: var(--text-secondary);
  align-self: center;
  opacity: 0;
  z-index: 5;
  transition:
    opacity 0.2s ease,
    background 0.2s ease,
    color 0.2s ease;
}
.collapse-btn svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.left-collapse-btn {
  border-radius: 0 6px 6px 0;
  border-left: none;
}
.right-collapse-btn {
  border-radius: 6px 0 0 6px;
  border-right: none;
}

/* 悬停主体区域时显示折叠按钮 */
.app-body:hover .collapse-btn {
  opacity: 0.6;
}
.collapse-btn:hover {
  opacity: 1 !important;
  color: var(--primary);
  background: var(--primary-soft);
}

/* ══════════════════════════════════════
   工作区
   ══════════════════════════════════════ */
.workspace-area {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ══════════════════════════════════════
   底部版权栏
   ══════════════════════════════════════ */
.app-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px;
  font-size: 11px;
  letter-spacing: 0.2px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-top: 1px solid var(--border);
  user-select: none;
  -webkit-user-select: none;
}
.footer-divider {
  opacity: 0.4;
}

/* ══════════════════════════════════════
   滚动条美化
   ══════════════════════════════════════ */
.panel-inner-wrap::-webkit-scrollbar {
  width: 5px;
}
.panel-inner-wrap::-webkit-scrollbar-track {
  background: transparent;
}
.panel-inner-wrap::-webkit-scrollbar-thumb {
  background: var(--scrollbar);
  border-radius: 3px;
}
.panel-inner-wrap::-webkit-scrollbar-thumb:hover {
  background: var(--scrollbar-hover);
}

/* ══════════════════════════════════════
   全局拖拽上传遮罩
   ══════════════════════════════════════ */
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  pointer-events: none;
}

.drop-overlay-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 40px 56px;
  border: 2px dashed var(--primary);
  border-radius: 16px;
  background: var(--primary-soft);
  color: var(--primary);
}

.drop-overlay-icon {
  width: 48px;
  height: 48px;
}

.drop-overlay-text {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.5px;
}

/* 遮罩淡入淡出动画 */
.drop-overlay-enter-active,
.drop-overlay-leave-active {
  transition: opacity 0.2s ease;
}
.drop-overlay-enter-from,
.drop-overlay-leave-to {
  opacity: 0;
}
</style>
