<script setup lang="ts">
import { NScrollbar } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import UploadZone from './UploadZone.vue'
import ArchiveCard from './ArchiveCard.vue'

const { archives, remove } = useArchiveManager()
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
        @retry="() => {}"
      />
    </NScrollbar>
  </div>
</template>
