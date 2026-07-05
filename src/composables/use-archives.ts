import { ref, computed } from 'vue'
import type { ArchiveItem } from '@/types'
import { useCacheManager } from './use-cache'

const archives = ref<ArchiveItem[]>([])

let nextArchiveId = 0
/** 已添加文件的身份集合，用于去重（name + size + lastModified） */
const addedFileKeys = new Set<string>()

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export function useArchiveManager() {
  const cacheManager = useCacheManager()

  async function addFiles(files: File[]) {
    const unique: File[] = []
    for (const file of files) {
      const key = fileKey(file)
      if (!addedFileKeys.has(key)) {
        addedFileKeys.add(key)
        unique.push(file)
      }
    }
    if (unique.length === 0) return

    for (const file of unique) {
      const archive: ArchiveItem = {
        id: `archive_${nextArchiveId++}`,
        name: file.name,
        file,
        cacheId: `archive_${nextArchiveId - 1}`,
        status: 'pending',
        progress: 0,
        files: [],
        originalSize: 0,
        compressedSize: file.size,
      }
      archives.value.push(archive)

      // 先等待元数据持久化完成，防止后续 updateMeta 被 cacheArchive 的旧状态覆盖
      try {
        await cacheManager.cacheArchive(archive, file)
      } catch {
        // 缓存写入失败不影响主流程
      }
    }
    triggerDecompress()
  }

  async function triggerDecompress() {
    const { useDecompress } = await import('./use-decompress')
    const { decompressAll } = useDecompress()
    decompressAll()
  }

  function remove(id: string) {
    const archive = archives.value.find(a => a.id === id)
    if (archive) {
      // 清理去重集合（缓存恢复的归档用 metaFileKey，当次会话用 fileKey）
      if (archive.file) {
        addedFileKeys.delete(fileKey(archive.file))
      } else {
        // 缓存恢复的归档无法还原 lastModified，用 cacheId 标记方式清理
        addedFileKeys.delete(`restored:${archive.cacheId}`)
      }
      // 异步清理缓存
      cacheManager.remove(archive.cacheId).catch(() => {})
    }
    archives.value = archives.value.filter(a => a.id !== id)
  }

  function updateStatus(id: string, status: ArchiveItem['status'], progress?: number) {
    const archive = archives.value.find(a => a.id === id)
    if (archive) {
      archive.status = status
      if (progress !== undefined) archive.progress = progress
      if (status === 'running' && !archive.startTime) archive.startTime = Date.now()
      if (status === 'completed') archive.endTime = Date.now()

      // 解压完成或失败时更新缓存元数据
      if (status === 'completed' || status === 'failed') {
        cacheManager.updateMeta(archive).catch(() => {})
      }
    }
  }

  const stats = computed(() => {
    let totalCount = 0
    let totalCompressedSize = 0
    let totalOriginalSize = 0
    let totalFiles = 0
    let decompressedCount = 0
    for (const a of archives.value) {
      totalCount++
      totalCompressedSize += a.compressedSize
      totalOriginalSize += a.originalSize
      totalFiles += a.files.length
      if (a.status === 'completed') decompressedCount++
    }
    return { totalCount, totalCompressedSize, totalOriginalSize, totalFiles, decompressedCount }
  })

  /** 从缓存恢复归档列表（仅元数据，不加载二进制数据） */
  async function restoreFromCache(): Promise<void> {
    const allMeta = await cacheManager.restoreAll()

    for (const meta of allMeta) {
      // 使用 cacheId 作为去重标识，防止恢复后重复上传
      const restoredKey = `restored:${meta.id}`
      addedFileKeys.add(restoredKey)

      // 同时用 name+size 加入去重集合，防止用户上传同名同大小文件
      const simpleKey = `${meta.name}:${meta.size}:${meta.lastModified}`
      addedFileKeys.add(simpleKey)

      // 刷新页面后，上次正在解压的归档（running）重置为 pending，等待重新解压
      const status = meta.status === 'running' ? 'pending' : meta.status

      const archive: ArchiveItem = {
        id: meta.id,
        name: meta.name,
        // file 为 undefined（缓存恢复，不持有 File 对象）
        cacheId: meta.id,
        status,
        progress: status === 'completed' ? 100 : 0,
        files: meta.files,
        error: meta.error,
        startTime: meta.startTime,
        endTime: meta.endTime,
        originalSize: meta.originalSize,
        compressedSize: meta.compressedSize,
      }
      archives.value.push(archive)

      // 更新 nextArchiveId 确保不与恢复的 id 冲突
      const idNum = parseInt(meta.id.replace('archive_', ''), 10)
      if (!isNaN(idNum) && idNum >= nextArchiveId) {
        nextArchiveId = idNum + 1
      }
    }

    // 自动重试上次未完成（pending）的解压任务
    const hasPending = archives.value.some(a => a.status === 'pending')
    if (hasPending) {
      triggerDecompress()
    }
  }

  function reset() {
    archives.value = []
    nextArchiveId = 0
    addedFileKeys.clear()
  }

  return {
    archives,
    addFiles,
    remove,
    updateStatus,
    stats,
    reset,
    restoreFromCache,
  }
}
