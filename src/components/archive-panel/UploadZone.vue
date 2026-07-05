<script setup lang="ts">
import { ref } from 'vue'
import { NText, useMessage } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { processArchiveUpload } from '@/core/archive-utils'

const { addFiles } = useArchiveManager()
const message = useMessage()
const fileInput = ref<HTMLInputElement>()
const isDragging = ref(false)
let dragDepth = 0

/** 处理拖放或输入的文件：过滤 → 验证 → 添加 */
async function processFiles(rawFiles: File[]) {
  const validFiles = await processArchiveUpload(rawFiles, (name, msg) => {
    message.error(`${name}：${msg}`)
  })
  if (validFiles.length) addFiles(validFiles)
}

async function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  dragDepth = 0
  const items = e.dataTransfer?.files
  if (!items?.length) return
  await processFiles(Array.from(items))
}


function handleDragEnter(e: DragEvent) {
  e.preventDefault()
  dragDepth++
  isDragging.value = true
}

function handleDragLeave() {
  dragDepth--
  if (dragDepth <= 0) {
    dragDepth = 0
    isDragging.value = false
  }
}

function handleDragOver(e: DragEvent) {
  e.preventDefault()
}

function handleClick() {
  fileInput.value?.click()
}

async function handleInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  await processFiles(Array.from(input.files))
  input.value = ''
}
</script>

<template>
  <div
    class="cursor-pointer border border-dashed border-border rounded-md mr-1 transition-colors duration-200 hover:border-primary hover:bg-primary-soft/50"
    :class="{ '!border-primary !bg-primary-soft/50': isDragging }"
    @drop="handleDrop"
    @dragenter="handleDragEnter"
    @dragleave="handleDragLeave"
    @dragover="handleDragOver"
    @click="handleClick"
  >
    <div class="p-4 text-center pointer-events-none">
      <NText depth="3">拖拽压缩包到此处，或点击上传</NText>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".zip,.gz,.gzip,.tgz,.7z,.rar,.tar"
      class="hidden"
      @change="handleInputChange"
    />
  </div>
</template>
