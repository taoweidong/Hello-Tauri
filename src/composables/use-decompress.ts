import { useArchiveManager } from './use-archives'
import { usePluginEngine } from './use-plugins'
import { useCacheManager } from './use-cache'
import { TaskScheduler } from '@/core/task-scheduler'
import { FileTreeBuilder } from '@/core/file-tree'
import type { ArchiveItem } from '@/types'

const scheduler = new TaskScheduler(3)
const treeBuilder = new FileTreeBuilder()

export function useDecompress() {
  const { archives, updateStatus } = useArchiveManager()
  const { registry } = usePluginEngine()
  const cacheManager = useCacheManager()

  async function startDecompress(archive: ArchiveItem) {
    updateStatus(archive.id, 'running', 0)

    const taskId = scheduler.enqueue(async () => {
      try {
        // 优先使用当次会话中的 File 对象，避免重复 IO
        // 缓存恢复时 archive.file 为 undefined，从存储层按需读取
        let data: Uint8Array
        if (archive.file) {
          data = new Uint8Array(await archive.file.arrayBuffer())
        } else {
          const cached = await cacheManager.getFileData(archive.cacheId)
          if (!cached) {
            updateStatus(archive.id, 'failed')
            archive.error = '缓存数据丢失，请重新上传文件'
            return
          }
          data = cached
        }

        const fileEntry = {
          name: archive.name,
          path: archive.name,
          size: data.length,
          isDirectory: false,
        }

        const plugin = registry.detectCompression(fileEntry)
        if (!plugin) {
          updateStatus(archive.id, 'failed')
          archive.error = `No plugin for: ${archive.name}`
          return
        }

        updateStatus(archive.id, 'running', 30)

        const result = await registry.safeDecompress(plugin, data, '')

        if (!result.success) {
          updateStatus(archive.id, 'failed')
          archive.error = result.error ?? 'Unknown error'
          return
        }

        updateStatus(archive.id, 'running', 80)

        const tree = treeBuilder.build(result.files, '')
        archive.files = tree
        archive.originalSize = result.files.reduce((sum, f) => sum + f.size, 0)

        updateStatus(archive.id, 'completed', 100)
      } catch (err) {
        updateStatus(archive.id, 'failed')
        archive.error = err instanceof Error ? err.message : 'Unknown error'
      }
    })

    if (taskId === null) {
      updateStatus(archive.id, 'failed')
      archive.error = 'Task queue is full'
    }
  }

  function decompressAll() {
    for (const archive of archives.value) {
      if (archive.status === 'pending') {
        startDecompress(archive)
      }
    }
  }

  return { startDecompress, decompressAll }
}
