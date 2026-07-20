<script setup lang="ts">
import { computed } from 'vue'
import { NSpace, NButton, NDropdown, NText } from 'naive-ui'
import { useNow } from '@vueuse/core'
import { useArchiveManager } from '@/composables/use-archives'
import { useTabManager } from '@/composables/use-tabs'
import GlobalSearch from './GlobalSearch.vue'

const { archives } = useArchiveManager()
const { closeAll } = useTabManager()

/** 实时时钟 - 每秒更新一次 */
const now = useNow({ interval: 1000 })
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

/** 处理批量操作菜单选项 */
function handleBatch(key: string) {
  if (key === 'clear') {
    // 同步清理标签页、归档列表和缓存
    closeAll()
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
