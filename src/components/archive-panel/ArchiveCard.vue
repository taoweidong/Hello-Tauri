<script setup lang="ts">
import { NCard, NSpace, NButton } from 'naive-ui'
import type { ArchiveItem } from '@/adapters/types'
import StatusIndicator from './StatusIndicator.vue'
import FileTree from './FileTree.vue'

const props = defineProps<{
  archive: ArchiveItem
}>()

const emit = defineEmits<{
  remove: [id: string]
  retry: [id: string]
}>()
</script>

<template>
  <NCard
    :title="archive.name"
    size="small"
    closable
    style="margin-bottom: 8px;"
    @close="emit('remove', archive.id)"
  >
    <template #header-extra>
      <StatusIndicator :status="archive.status" :progress="archive.progress" />
    </template>

    <div v-if="archive.status === 'failed'" style="color: #EF4444; margin-bottom: 8px;">
      {{ archive.error }}
      <NButton size="tiny" @click="emit('retry', archive.id)">重试</NButton>
    </div>

    <FileTree
      v-if="archive.files.length > 0"
      :data="archive.files"
      :archive-id="archive.id"
    />
  </NCard>
</template>
