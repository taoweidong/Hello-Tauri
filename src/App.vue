<script setup lang="ts">
/**
 * 应用根组件
 * 提供全局主题配置（Naive UI NConfigProvider）、消息/对话框 Provider 及错误边界
 */
import { computed } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme } from 'naive-ui'
import { themeOverrides } from './styles/theme'
import { useAppStore } from './stores/app'
import AppLayout from './layout/AppLayout.vue'
import ErrorBoundary from './components/shared/ErrorBoundary.vue'

const store = useAppStore()
const theme = computed(() => store.isDarkTheme ? darkTheme : lightTheme)
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <ErrorBoundary>
          <AppLayout />
        </ErrorBoundary>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
