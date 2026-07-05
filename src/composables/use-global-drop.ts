import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useArchiveManager } from '@/composables/use-archives'
import { filterArchiveFiles, validateArchiveFiles } from '@/core/archive-utils'

/** 全局拖放上传 composable，处理文件拖放到窗口的交互 */
export function useGlobalDrop() {
  /** 当前是否处于拖放状态 */
  const isDragging = ref(false)
  const message = useMessage()
  const { addFiles } = useArchiveManager()

  /** 拖放计数器（处理子元素冒泡） */
  let dragCounter = 0
  /** 已绑定事件的 DOM 元素 */
  let boundEl: HTMLElement | null = null

  /** 处理 dragenter 事件 */
  function onDragEnter(e: DragEvent) {
    e.preventDefault()
    dragCounter++
    if (e.dataTransfer?.types.includes('Files')) {
      isDragging.value = true
    }
  }

  /** 处理 dragover 事件 */
  function onDragOver(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  /** 处理 dragleave 事件 */
  function onDragLeave(_e: DragEvent) {
    dragCounter--
    if (dragCounter <= 0) {
      dragCounter = 0
      isDragging.value = false
    }
  }

  /** 处理 drop 事件，过滤并验证文件后添加到归档 */
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

    // 有非压缩包文件被过滤时提示用户
    const filteredCount = files.length - archives.length
    if (filteredCount > 0) {
      message.warning(`已忽略 ${filteredCount} 个非压缩包文件`)
    }

    const validFiles = await validateArchiveFiles(archives, (name, msg) => {
      message.error(`${name}：${msg}`)
    })

    if (validFiles.length > 0) {
      addFiles(validFiles)
    }
  }

  /**
   * 绑定拖放事件到指定 DOM 元素
   * @param el - 目标 DOM 元素
   */
  function setup(el: HTMLElement) {
    boundEl = el
    el.addEventListener('dragenter', onDragEnter)
    el.addEventListener('dragover', onDragOver)
    el.addEventListener('dragleave', onDragLeave)
    el.addEventListener('drop', onDrop)
  }

  /** 解绑拖放事件并重置状态 */
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
