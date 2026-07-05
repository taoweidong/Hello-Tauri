<script setup lang="ts">
import { computed } from 'vue'
import { NSpace, NButton, NDropdown, NText } from 'naive-ui'
import { useNow } from '@vueuse/core'
import { useArchiveManager } from '@/composables/use-archives'
import GlobalSearch from './GlobalSearch.vue'

const { archives } = useArchiveManager()

/** 实时时钟 - 每分钟更新一次（60000ms） */
const now = useNow({ interval: 60000 })
const currentTime = computed(() => {
  return now.value.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
})

const batchOptions = [
  { label: '一键清空', key: 'clear' },
  { label: '全部导出', key: 'export' },
  { label: '批量重新解压', key: 'reDecompress' },
]

function handleBatch(key: string) {
  if (key === 'clear') {
    archives.value = []
  }
}
</script>

<template>
  <NSpace align="center" justify="end" style="height: 100%; width: 100%;">
    <NSpace align="center" :size="16">
      <GlobalSearch />
      <NDropdown :options="batchOptions" @select="handleBatch">
        <NButton size="small">批量操作</NButton>
      </NDropdown>
      <NText depth="3" style="font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap;">
        {{ currentTime }}
      </NText>
    </NSpace>
  </NSpace>
</template>
