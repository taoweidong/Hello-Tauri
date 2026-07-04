import { ref, computed } from 'vue'
import type { ArchiveItem } from '@/types'

const archives = ref<ArchiveItem[]>([])

let nextArchiveId = 0
/** 已添加文件的身份集合，用于去重（name + size + lastModified） */
const addedFileKeys = new Set<string>()

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

export function useArchiveManager() {
  function addFiles(files: File[]) {
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
      archives.value.push({
        id: `archive_${nextArchiveId++}`,
        name: file.name,
        file,
        status: 'pending',
        progress: 0,
        files: [],
        originalSize: 0,
        compressedSize: file.size,
      })
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
      addedFileKeys.delete(fileKey(archive.file))
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
    }
  }

  const stats = computed(() => ({
    totalCount: archives.value.length,
    totalCompressedSize: archives.value.reduce((sum, a) => sum + a.compressedSize, 0),
    totalOriginalSize: archives.value.reduce((sum, a) => sum + a.originalSize, 0),
    totalFiles: archives.value.reduce((sum, a) => sum + a.files.length, 0),
    decompressedCount: archives.value.filter(a => a.status === 'completed').length,
  }))

  function reset() {
    archives.value = []
    nextArchiveId = 0
    addedFileKeys.clear()
  }

  return { archives, addFiles, remove, updateStatus, stats, reset }
}
