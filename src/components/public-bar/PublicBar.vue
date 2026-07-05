<script setup lang="ts">
import { NSpace, NButton, NDropdown } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import GlobalSearch from './GlobalSearch.vue'

const { archives } = useArchiveManager()

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
    </NSpace>
  </NSpace>
</template>
