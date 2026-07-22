<script setup lang="ts">
/**
 * 欢迎页组件
 * 无标签页打开时展示应用引导信息、操作提示、最近文件与快捷键说明
 */
import { computed } from 'vue'
import { NButton } from 'naive-ui'
import { usePanelLayout } from '@/composables/use-panel-layout'
import { useTabManager } from '@/composables/use-tabs'
import { APP_NAME, APP_DESCRIPTION } from '@/config'
import AppLogo from '@/components/shared/AppLogo.vue'

const { leftCollapsed, expandLeft } = usePanelLayout()
const { recentFiles } = useTabManager()

/** 截取前 5 条最近文件，只显示文件名 */
const displayRecentFiles = computed(() => {
  return recentFiles.value.slice(0, 5).map(path => {
    const parts = path.split(/[\\/]/)
    return parts[parts.length - 1] || path
  })
})
</script>

<template>
  <div class="flex-1 flex items-center justify-center bg-bg-base">
    <div class="flex flex-col items-center gap-6 px-8 py-12">
      <!-- 图标 -->
      <div class="w-20 h-20 rounded-2xl bg-primary-soft flex items-center justify-center text-primary">
        <AppLogo class="w-10 h-10" />
      </div>

      <!-- 标题 -->
      <div class="text-center">
        <h2 class="text-[15px] font-bold text-text-primary mb-1">{{ APP_NAME }}</h2>
        <p class="text-[13px] text-text-secondary">{{ APP_DESCRIPTION }}</p>
      </div>

      <!-- 操作提示 -->
      <div class="flex flex-col gap-3 w-64">
        <div class="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated border border-border hover:border-primary/30 transition-colors cursor-default">
          <div class="w-8 h-8 rounded-lg bg-primary-soft flex items-center justify-center text-primary shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div>
            <p class="text-[13px] font-medium text-text-primary">拖放文件</p>
            <p class="text-[12px] text-text-secondary">将压缩包拖放到窗口任意位置</p>
          </div>
        </div>

        <div class="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated border border-border hover:border-primary/30 transition-colors cursor-pointer" @click="leftCollapsed ? expandLeft() : undefined">
          <div class="w-8 h-8 rounded-lg bg-primary-soft flex items-center justify-center text-primary shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div>
            <p class="text-[13px] font-medium text-text-primary">上传文件</p>
            <p class="text-[12px] text-text-secondary">点击左侧面板上传区域选择文件</p>
          </div>
        </div>

        <div class="flex items-center gap-3 p-3 rounded-lg bg-bg-elevated border border-border hover:border-primary/30 transition-colors cursor-default">
          <div class="w-8 h-8 rounded-lg bg-primary-soft flex items-center justify-center text-primary shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
          </div>
          <div>
            <p class="text-[13px] font-medium text-text-primary">搜索内容</p>
            <p class="text-[12px] text-text-secondary">使用顶部搜索栏或快捷键 Ctrl+K</p>
          </div>
        </div>

        <!-- 最近文件 -->
        <div v-if="displayRecentFiles.length > 0" class="flex items-start gap-3 p-3 rounded-lg bg-bg-elevated border border-border cursor-default">
          <div class="w-8 h-8 rounded-lg bg-primary-soft flex items-center justify-center text-primary shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-4 h-4">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-medium text-text-primary mb-1">最近文件</p>
            <div class="flex flex-col gap-0.5">
              <span v-for="(file, idx) in displayRecentFiles" :key="idx" class="text-[12px] text-text-secondary truncate">
                {{ file }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 快捷键提示 -->
      <div class="flex flex-wrap justify-center gap-2 text-[11px] text-text-disabled">
        <kbd class="px-1.5 py-0.5 rounded bg-bg-elevated border border-border">Ctrl+B</kbd>
        <span>切换左侧面板</span>
        <kbd class="px-1.5 py-0.5 rounded bg-bg-elevated border border-border">Ctrl+Shift+B</kbd>
        <span>切换右侧面板</span>
      </div>
    </div>
  </div>
</template>
