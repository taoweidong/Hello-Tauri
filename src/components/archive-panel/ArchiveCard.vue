<script setup lang="ts">
import { NCard, NButton } from 'naive-ui'
import type { ArchiveItem } from '@/types'
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
    class="mb-2"
    @close="emit('remove', archive.id)"
  >
    <template #header-extra>
      <StatusIndicator :status="archive.status" :progress="archive.progress" />
    </template>

    <div v-if="archive.status === 'failed'" class="text-error mb-2">
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
