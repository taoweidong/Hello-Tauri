<script setup lang="ts">
import { NUpload, NUploadDragger, NText } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

const { addFiles } = useArchiveManager()

function handleUpload({ file }: { file: { file: File | null } }) {
  if (file.file) {
    addFiles([file.file])
  }
  return false
}
</script>

<template>
  <NUpload
    multiple
    :show-file-list="false"
    :custom-request="handleUpload"
    accept=".zip,.gz,.gzip,.tgz,.7z,.rar,.tar"
  >
    <NUploadDragger>
      <div style="padding: 16px; text-align: center;">
        <NText depth="3">拖拽压缩包到此处，或点击上传</NText>
      </div>
    </NUploadDragger>
  </NUpload>
</template>
