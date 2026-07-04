import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { filterArchiveFiles, validateArchiveFiles } from '@/core/archive-utils'

export function useGlobalDrop() {
  const isDragging = ref(false)
  const message = useMessage()
  const { addFiles } = useArchiveManager()

  let dragCounter = 0
  let boundEl: HTMLElement | null = null

  function onDragEnter(e: DragEvent) {
    e.preventDefault()
    dragCounter++
    if (e.dataTransfer?.types.includes('Files')) {
      isDragging.value = true
    }
  }

  function onDragOver(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function onDragLeave(_e: DragEvent) {
    dragCounter--
    if (dragCounter <= 0) {
      dragCounter = 0
      isDragging.value = false
    }
  }

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    dragCounter = 0
    isDragging.value = false

    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return

    const archives = filterArchiveFiles(files)
    if (archives.length === 0) {
      message.warning('仅支持压缩包文件')
      return
    }

    if (archives.length < files.length) {
      message.warning(`已忽略 ${files.length - archives.length} 个非压缩包文件`)
    }

    // 文件内容验证
    const validFiles = await validateArchiveFiles(archives, (name, msg) => {
      message.error(`${name}：${msg}`)
    })

    if (validFiles.length > 0) {
      addFiles(validFiles)
    }
  }

  function setup(el: HTMLElement) {
    boundEl = el
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
  }

  function cleanup() {
    if (!boundEl) return
    boundEl.removeEventListener('dragenter', onDragEnter)
    boundEl.removeEventListener('dragover', onDragOver)
    boundEl.removeEventListener('dragleave', onDragLeave)
    boundEl.removeEventListener('drop', onDrop)
    boundEl = null
    dragCounter = 0
    isDragging.value = false
  }

  return { isDragging, setup, cleanup }
}
