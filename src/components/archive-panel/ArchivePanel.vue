<script setup lang="ts">
/**
 * 归档列表面板（左侧边栏）
 * 组合上传区域与归档卡片列表，提供解压重试能力
 */
import { NScrollbar } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { useDecompress } from '@/composables/use-decompress'
import UploadZone from './UploadZone.vue'
import ArchiveCard from './ArchiveCard.vue'

const { archives, remove, updateStatus } = useArchiveManager()
const { startDecompress } = useDecompress()

/** 重试指定归档的解压任务 */
function retryArchive(id: string) {
  const archive = archives.value.find(a => a.id === id)
  if (archive && (archive.status === 'failed' || archive.status === 'pending' || archive.status === 'running')) {
    archive.error = undefined
    updateStatus(id, 'pending', 0)
    startDecompress(archive)
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <UploadZone />
    <NScrollbar class="flex-1 mt-2">
      <ArchiveCard
        v-for="archive in archives"
        :key="archive.id"
        :archive="archive"
        @remove="remove"
        @retry="retryArchive"
      />
    </NScrollbar>
  </div>
</template>
