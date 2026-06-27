<script setup lang="ts">
import { NStatistic, NTag, NSpace } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

const { stats } = useArchiveManager()
</script>

<template>
  <NSpace :size="16" align="center">
    <NStatistic label="总包数" :value="stats.totalCount">
      <template #suffix><NTag size="small">个</NTag></template>
    </NStatistic>
    <NStatistic label="压缩大小" :value="stats.totalCompressedSize">
      <template #suffix><NTag size="small">B</NTag></template>
    </NStatistic>
    <NStatistic label="已解压" :value="stats.decompressedCount">
      <template #suffix><NTag size="small" type="success">个</NTag></template>
    </NStatistic>
    <NStatistic label="总文件" :value="stats.totalFiles">
      <template #suffix><NTag size="small">个</NTag></template>
    </NStatistic>
  </NSpace>
</template>
