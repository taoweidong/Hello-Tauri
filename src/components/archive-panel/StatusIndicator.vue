<script setup lang="ts">
import { NTag, NProgress, NSpace } from 'naive-ui'
import type { ArchiveStatus } from '@/adapters/types'

defineProps<{
  status: ArchiveStatus
  progress: number
}>()
</script>

<template>
  <NSpace align="center" :size="4">
    <template v-if="status === 'completed'">
      <NTag type="success" size="small">已完成</NTag>
    </template>
    <template v-else-if="status === 'running'">
      <NTag type="info" size="small">解压中</NTag>
      <NProgress type="line" :percentage="progress" :show-indicator="false" style="width: 60px;" />
    </template>
    <template v-else-if="status === 'pending'">
      <NTag type="warning" size="small">排队中</NTag>
    </template>
    <template v-else-if="status === 'failed'">
      <NTag type="error" size="small">失败</NTag>
    </template>
  </NSpace>
</template>
