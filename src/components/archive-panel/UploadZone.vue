<script setup lang="ts">
import { ref } from 'vue'
import { NText } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'

const { addFiles } = useArchiveManager()
const fileInput = ref<HTMLInputElement>()
const isDragging = ref(false)
let dragDepth = 0

/** 支持的文件扩展名 */
const ACCEPTED_EXTS = ['.zip', '.gz', '.gzip', '.tgz', '.7z', '.rar', '.tar']

function isArchiveFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ACCEPTED_EXTS.some(ext => lower.endsWith(ext))
}

function handleDrop(e: DragEvent) {
  e.preventDefault()
  isDragging.value = false
  dragDepth = 0
  const items = e.dataTransfer?.files
  if (!items?.length) return
  const files = Array.from(items).filter(f => isArchiveFile(f.name))
  if (files.length) addFiles(files)
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

function handleInputChange(e: Event) {
  const input = e.target as HTMLInputElement
  if (!input.files?.length) return
  const files = Array.from(input.files).filter(f => isArchiveFile(f.name))
  if (files.length) addFiles(files)
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
