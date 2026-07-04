<script setup lang="ts">
import { ref } from 'vue'
import { NText, useMessage } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { filterArchiveFiles, validateArchiveFiles } from '@/core/archive-utils'

const { addFiles } = useArchiveManager()
const message = useMessage()
const fileInput = ref<HTMLInputElement>()
const isDragging = ref(false)
let dragDepth = 0

/** 处理拖放或输入的文件：过滤压缩包 → 验证 → 添加 */
async function processFiles(rawFiles: File[]) {
  const archives = filterArchiveFiles(rawFiles)
  if (!archives.length) return

  const validFiles = await validateArchiveFiles(archives, (name, msg) => {
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
    class="upload-zone"
    :class="{ 'is-dragging': isDragging }"
    @drop="handleDrop"
    @dragenter="handleDragEnter"
    @dragleave="handleDragLeave"
    @dragover="handleDragOver"
    @click="handleClick"
  >
    <!-- 子元素设置 pointer-events:none，避免拖拽事件冒泡导致 dragleave 误触发 -->
    <div style="padding: 16px; text-align: center; pointer-events: none;">
      <NText depth="3">拖拽压缩包到此处，或点击上传</NText>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      accept=".zip,.gz,.gzip,.tgz,.7z,.rar,.tar"
      style="display: none;"
      @change="handleInputChange"
    />
  </div>
</template>

<style scoped>
.upload-zone {
  cursor: pointer;
  border: 1px dashed var(--n-border-color, #666);
  border-radius: 6px;
  margin-right: 4px;
  transition: border-color 0.2s, background-color 0.2s;
}
.upload-zone:hover,
.upload-zone.is-dragging {
  border-color: var(--n-color-focus, #36ad6a);
  background-color: rgba(54, 173, 106, 0.05);
}
</style>
