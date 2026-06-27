<script setup lang="ts">
import { computed } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme } from 'naive-ui'
import { themeOverrides } from './styles/theme'
import { useAppStore } from './stores/app'
import AppLayout from './components/layout/AppLayout.vue'
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
