<script setup lang="ts">
import { NSpace, NButton, NDropdown } from 'naive-ui'
import { useAppStore } from '@/stores/app'
import { useArchiveManager } from '@/composables/use-archives'
import GlobalStats from './GlobalStats.vue'
import GlobalSearch from './GlobalSearch.vue'

const store = useAppStore()
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
  <NSpace align="center" justify="space-between" style="height: 100%;">
    <GlobalStats />
    <NSpace align="center" :size="16">
      <GlobalSearch />
      <NDropdown :options="batchOptions" @select="handleBatch">
        <NButton>批量操作</NButton>
      </NDropdown>
      <NButton @click="store.toggleTheme">
        {{ store.isDarkTheme ? '浅色' : '深色' }}
      </NButton>
    </NSpace>
  </NSpace>
</template>
