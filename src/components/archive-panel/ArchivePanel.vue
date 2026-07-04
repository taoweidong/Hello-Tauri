<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { useDecompress } from '@/composables/use-decompress'
import UploadZone from './UploadZone.vue'
import ArchiveCard from './ArchiveCard.vue'

const { archives, remove, updateStatus } = useArchiveManager()
const { startDecompress } = useDecompress()

function retryArchive(id: string) {
  const archive = archives.value.find(a => a.id === id)
  if (archive && archive.status === 'failed') {
    archive.error = undefined
    updateStatus(id, 'pending', 0)
    startDecompress(archive)
  }
}
</script>

<template>
  <div style="height: 100%; display: flex; flex-direction: column;">
    <UploadZone />
    <NScrollbar style="flex: 1; margin-top: 8px;">
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
