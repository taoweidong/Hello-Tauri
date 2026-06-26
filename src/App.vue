<script setup lang="ts">
import { ref, computed } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, darkTheme, lightTheme } from 'naive-ui'
import { themeOverrides } from './styles/theme'

const platform = __PLATFORM__
const isDark = ref(true)
const theme = computed(() => isDark.value ? darkTheme : lightTheme)
</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="themeOverrides">
    <NMessageProvider>
      <NDialogProvider>
        <div id="app-root">
          <h1>日志解析工具</h1>
          <p>平台：{{ platform }}</p>
          <button @click="isDark = !isDark">
            {{ isDark ? '切换浅色' : '切换深色' }}
          </button>
        </div>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
