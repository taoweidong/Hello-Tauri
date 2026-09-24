<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IconGrid, IconTable, IconSliders, IconInfo, IconSun, IconMoon, IconPanelLeft } from '@/components/icons'

import { platform } from '@/api'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const navItems = [
  { path: '/', title: '概览', icon: IconGrid },
  { path: '/table', title: '数据管理', icon: IconTable },
  { path: '/settings', title: '配置', icon: IconSliders },
  { path: '/about', title: '关于', icon: IconInfo },
]

const collapsed = computed(() => appStore.settings.sidebarCollapsed)
const currentTitle = computed(() => String(route.meta.title ?? ''))
const platformLabel = computed(() => (platform === 'tauri' ? '桌面' : 'Web'))
const themeIcon = computed(() => (appStore.settings.theme === 'dark' ? IconSun : IconMoon))
const themeTip = computed(() => (appStore.settings.theme === 'dark' ? '切换到浅色' : '切换到深色'))

function toggleCollapse() {
  appStore.settings.sidebarCollapsed = !collapsed.value
}

function toggleTheme() {
  appStore.settings.theme = appStore.settings.theme === 'dark' ? 'light' : 'dark'
}

function go(path: string) {
  if (path !== route.path) void router.push(path)
}
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': collapsed }">
    <aside class="rail" aria-label="主导航">
      <div class="rail__brand" :title="collapsed ? 'Hello-Tauri' : undefined">
        <span class="rail__logo" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 17V7l8 6 8-6v10" />
          </svg>
        </span>
        <span v-show="!collapsed" class="rail__brand-text">Hello-Tauri</span>
      </div>

      <nav class="rail__nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="rail__item pressable"
          :class="{ 'is-active': route.path === item.path }"
          :title="collapsed ? item.title : undefined"
          :aria-current="route.path === item.path ? 'page' : undefined"
          @click="go(item.path)"
        >
          <component :is="item.icon" class="rail__icon" />
          <span v-show="!collapsed" class="rail__label">{{ item.title }}</span>
          <span v-if="route.path === item.path" class="rail__marker" aria-hidden="true" />
        </button>
      </nav>

      <div class="rail__foot">
        <span v-show="!collapsed" class="rail__env">{{ platformLabel }}模式 · v{{ appStore.info?.version ?? '0.1.0' }}</span>
        <button class="rail__toggle pressable" :title="collapsed ? '展开侧栏' : '收起侧栏'" :aria-label="collapsed ? '展开侧栏' : '收起侧栏'" @click="toggleCollapse">
          <IconPanelLeft class="rail__toggle-icon" :class="{ 'is-flipped': collapsed }" />
        </button>
      </div>
    </aside>

    <div class="stage">
      <header class="topbar">
        <div class="topbar__crumb">
          <span>工作台</span>
          <svg class="topbar__sep" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
          <span class="topbar__page">{{ currentTitle }}</span>
        </div>
        <div class="topbar__spacer" />
        <button class="topbar__theme pressable" :title="themeTip" :aria-label="themeTip" @click="toggleTheme">
          <component :is="themeIcon" class="topbar__theme-icon" />
        </button>
      </header>

      <main class="canvas">
        <router-view v-slot="{ Component }">
          <transition name="route" mode="out-in">
            <keep-alive>
              <component :is="Component" />
            </keep-alive>
          </transition>
        </router-view>
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: 216px 1fr;
  height: 100%;
  transition: grid-template-columns 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.shell--collapsed {
  grid-template-columns: 60px 1fr;
}

.shell--collapsed .rail__brand,
.shell--collapsed .rail__item {
  justify-content: center;
  padding: 0;
}

.shell--collapsed .rail__foot {
  justify-content: center;
}

@media (prefers-reduced-motion: reduce) {
  .shell {
    transition: none;
  }
}

/* —— 深轨侧栏 —— */
.rail {
  display: flex;
  flex-direction: column;
  background: var(--ht-rail-bg);
  border-right: 1px solid var(--ht-rail-line);
  overflow: hidden;
}

.rail__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 14px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ht-rail-line);
  background: var(--ht-rail-bg-deep);
}

.rail__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--ht-primary);
  color: #fff;
  flex-shrink: 0;
}

.rail__brand-text {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ht-rail-text-hi);
  white-space: nowrap;
}

.rail__nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px;
  overflow-y: auto;
}

.rail__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--ht-rail-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.rail__item:hover {
  color: var(--ht-rail-text-hi);
  background: rgb(255 255 255 / 0.05);
}

.rail__item.is-active {
  color: var(--ht-rail-text-hi);
  background: var(--ht-rail-active);
}

.rail__item:focus-visible {
  outline: 2px solid var(--ht-primary);
  outline-offset: -2px;
}

.rail__icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}

.rail__marker {
  position: absolute;
  left: -8px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 3px 3px 0;
  background: var(--ht-primary);
}

.rail__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.rail__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--ht-rail-line);
  flex-shrink: 0;
  min-height: 44px;
}

.rail__env {
  flex: 1;
  font-size: 11px;
  color: var(--ht-rail-text);
  white-space: nowrap;
  overflow: hidden;
  opacity: 0.85;
}

.rail__toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ht-rail-text);
  cursor: pointer;
  flex-shrink: 0;
}

.rail__toggle:hover {
  color: var(--ht-rail-text-hi);
  background: rgb(255 255 255 / 0.07);
}

.rail__toggle-icon {
  width: 16px;
  height: 16px;
  transition: transform 0.22s cubic-bezier(0.22, 0.61, 0.36, 1);
}

.rail__toggle-icon.is-flipped {
  transform: rotate(180deg);
}

/* —— 顶栏与画布 —— */
.stage {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 52px;
  padding: 0 20px;
  flex-shrink: 0;
  background: var(--ht-surface);
  border-bottom: 1px solid var(--ht-line);
}

.topbar__crumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ht-text-3);
}

.topbar__sep {
  color: var(--ht-line-strong);
}

.topbar__page {
  color: var(--ht-text-1);
  font-weight: 600;
}

.topbar__spacer {
  flex: 1;
}

.topbar__theme {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ht-text-2);
  cursor: pointer;
}

.topbar__theme:hover {
  border-color: var(--ht-line);
  background: var(--ht-surface-2);
  color: var(--ht-text-1);
}

.topbar__theme:focus-visible {
  outline: 2px solid var(--ht-primary);
  outline-offset: 1px;
}

.topbar__theme-icon {
  width: 16px;
  height: 16px;
}

.canvas {
  flex: 1;
  position: relative;
  padding: 18px 20px 22px;
  overflow: auto;
  background: var(--ht-canvas);
}
</style>