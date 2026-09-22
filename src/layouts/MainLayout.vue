<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DataBoard,
  Expand,
  Fold,
  HomeFilled,
  InfoFilled,
  Moon,
  Setting,
  Sunny,
} from '@element-plus/icons-vue'

import { platform } from '@/api'
import { useAppStore } from '@/stores/app'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()

const navItems = [
  { path: '/', title: '概览', icon: HomeFilled },
  { path: '/table', title: '数据管理', icon: DataBoard },
  { path: '/settings', title: '配置', icon: Setting },
  { path: '/about', title: '关于', icon: InfoFilled },
]

const collapsed = computed(() => appStore.settings.sidebarCollapsed)
const activePath = computed(() => route.path)
const currentTitle = computed(() => String(route.meta.title ?? ''))
const platformLabel = computed(() => (platform === 'tauri' ? '桌面模式' : '浏览器模式'))
const themeIcon = computed(() => (appStore.settings.theme === 'dark' ? Sunny : Moon))

function toggleCollapse() {
  appStore.settings.sidebarCollapsed = !collapsed.value
}

function toggleTheme() {
  appStore.settings.theme = appStore.settings.theme === 'dark' ? 'light' : 'dark'
}

function onSelect(path: string) {
  if (path !== route.path) {
    void router.push(path)
  }
}
</script>

<template>
  <el-container class="layout">
    <el-aside class="layout__aside" :width="collapsed ? '64px' : '212px'">
      <div class="layout__brand">
        <span class="layout__logo">HT</span>
        <span v-show="!collapsed" class="layout__brand-text">Hello-Tauri</span>
      </div>
      <el-menu
        class="layout__menu"
        :default-active="activePath"
        :collapse="collapsed"
        :collapse-transition="false"
        @select="onSelect"
      >
        <el-menu-item v-for="item in navItems" :key="item.path" :index="item.path">
          <el-icon><component :is="item.icon" /></el-icon>
          <template #title>{{ item.title }}</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container class="layout__body">
      <el-header class="layout__header">
        <el-icon class="layout__collapse" @click="toggleCollapse">
          <component :is="collapsed ? Expand : Fold" />
        </el-icon>
        <el-breadcrumb separator="/">
          <el-breadcrumb-item :to="{ path: '/' }">首页</el-breadcrumb-item>
          <el-breadcrumb-item v-if="route.path !== '/'" :to="{ path: route.path }">
            {{ currentTitle }}
          </el-breadcrumb-item>
        </el-breadcrumb>
        <div class="layout__spacer" />
        <el-tag size="small" type="info" effect="plain">{{ platformLabel }}</el-tag>
        <el-tooltip :content="themeIcon === Sunny ? '切换到浅色' : '切换到深色'" placement="bottom">
          <el-button text :icon="themeIcon" @click="toggleTheme" />
        </el-tooltip>
      </el-header>

      <el-main class="layout__main">
        <router-view v-slot="{ Component }">
          <keep-alive>
            <component :is="Component" />
          </keep-alive>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.layout__aside {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color);
  transition: width 0.2s ease;
  overflow: hidden;
}

.layout__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 18px;
  flex-shrink: 0;
}

.layout__logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--el-color-primary), var(--el-color-primary-light-3));
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}

.layout__brand-text {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  color: var(--el-text-color-primary);
}

.layout__menu {
  flex: 1;
  border-right: none;
  overflow-x: hidden;
  overflow-y: auto;
}

.layout__body {
  min-width: 0;
}

.layout__header {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color);
}

.layout__header :deep(.el-breadcrumb) {
  flex-shrink: 0;
  white-space: nowrap;
}

.layout__collapse {
  font-size: 18px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  flex-shrink: 0;
}

.layout__collapse:hover {
  color: var(--el-color-primary);
}

.layout__spacer {
  flex: 1;
}

.layout__main {
  padding: 16px;
  background-color: var(--el-bg-color-page);
  overflow: auto;
}
</style>
