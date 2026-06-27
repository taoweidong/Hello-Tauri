import { ref, computed } from 'vue'
import type { ArchiveItem } from '@/adapters/types'

const archives = ref<ArchiveItem[]>([])

let nextArchiveId = 0

export function useArchiveManager() {
  function addFiles(files: File[]) {
    for (const file of files) {
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
  }

  function remove(id: string) {
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
  }

  return { archives, addFiles, remove, updateStatus, stats, reset }
}
