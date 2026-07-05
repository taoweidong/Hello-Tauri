<script setup lang="ts">
import { ref } from 'vue'
import { NInput, NButton, NSpace } from 'naive-ui'
import { useSearch } from '@/composables/use-search'

const keyword = ref('')
const { search, searching } = useSearch()

function handleSearch() {
  if (keyword.value.trim()) {
    search([], keyword.value.trim())
  }
}

/** 检测操作系统以显示正确的快捷键修饰符 */
const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent)
const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'
</script>

<template>
  <NSpace align="center" :size="8">
    <div class="relative">
      <NInput
        v-model:value="keyword"
        type="text"
        placeholder="全局搜索..."
        clearable
        style="width: 240px; padding-right: 52px;"
        @keyup.enter="handleSearch"
      />
      <kbd class="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-[10px] leading-none rounded bg-bg-elevated border border-border text-text-secondary pointer-events-none select-none">
        {{ shortcutLabel }}
      </kbd>
    </div>
    <NButton type="primary" :loading="searching" @click="handleSearch">
      搜索
    </NButton>
  </NSpace>
</template>
