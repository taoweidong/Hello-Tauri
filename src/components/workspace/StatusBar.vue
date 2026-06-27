<script setup lang="ts">
import { computed } from 'vue'
import { NText } from 'naive-ui'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab } = useTabManager()

const statusText = computed(() => {
  if (!activeTab.value?.content) return '无内容'
  const c = activeTab.value.content
  const parts: string[] = []
  if (c.lineCount !== undefined) parts.push(`${c.lineCount} 行`)
  if (c.loadTimeMs !== undefined) parts.push(`${c.loadTimeMs.toFixed(1)} ms`)
  parts.push(`插件: ${c.pluginName}`)
  return parts.join(' | ')
})
</script>

<template>
  <div style="height: 24px; padding: 0 8px; display: flex; align-items: center; border-top: 1px solid #333;">
    <NText depth="3" style="font-size: 12px;">{{ statusText }}</NText>
  </div>
</template>
