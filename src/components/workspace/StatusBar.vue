<script setup lang="ts">
import { computed } from 'vue'
import { useTabManager } from '@/composables/use-tabs'

const { activeTab, cursorPosition } = useTabManager()

const fileInfo = computed(() => {
  if (!activeTab.value?.content) return '无文件打开'
  const c = activeTab.value.content
  const parts: string[] = []
  if (c.lineCount !== undefined) parts.push(`${c.lineCount} 行`)
  if (c.encoding) parts.push(c.encoding)
  if (c.pluginName) parts.push(c.pluginName)
  return parts.join(' | ')
})

const fileSize = computed(() => {
  if (!activeTab.value?.content?.size) return ''
  const size = activeTab.value.content.size
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
})

const hasContent = computed(() => !!activeTab.value?.content)
</script>

<template>
  <div class="flex items-center justify-between w-full">
    <div class="flex items-center gap-3">
      <span v-if="hasContent" class="tabular-nums">行 {{ cursorPosition.line }}, 列 {{ cursorPosition.column }}</span>
      <span v-if="hasContent" class="opacity-40">|</span>
      <span>{{ fileInfo }}</span>
      <span v-if="fileSize" class="opacity-60">{{ fileSize }}</span>
    </div>
    <div class="flex items-center gap-2">
      <span class="text-[10px] opacity-50">字体缩放</span>
      <input
        type="range"
        min="80"
        max="150"
        value="100"
        class="w-20 h-1 accent-primary cursor-pointer"
        title="字体缩放"
      />
    </div>
  </div>
</template>
