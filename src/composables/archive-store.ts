import { ref } from 'vue'
import type { ArchiveItem } from '@/types'
import { useCacheManager } from './use-cache'
import { createLogger } from '@/core/logger'

/** 归档存储模块日志器 */
const logger = createLogger('ArchiveStore')

/**
 * 归档共享状态底层模块（A3 循环依赖治理）
 *
 * use-archives 与 use-decompress 均依赖本模块获取归档列表与状态更新能力，
 * 形成单向依赖链：use-archives → use-decompress → archive-store，
 * 消除原先 use-archives ↔ use-decompress 的循环依赖。
 */

/** 所有归档项的响应式列表（模块级单例） */
const archives = ref<ArchiveItem[]>([])

/** 归档共享状态访问器 */
export function useArchiveStore() {
  const cacheManager = useCacheManager()

  /**
   * 更新归档状态与进度
   * @param id - 归档 id
   * @param status - 新状态
   * @param progress - 进度百分比（可选）
   */
  function updateStatus(id: string, status: ArchiveItem['status'], progress?: number) {
    const archive = archives.value.find(a => a.id === id)
    if (archive) {
      archive.status = status
      if (progress !== undefined) archive.progress = progress
      if (status === 'running' && !archive.startTime) archive.startTime = Date.now()
      if (status === 'completed') archive.endTime = Date.now()

      // 解压完成或失败时更新缓存元数据
      if (status === 'completed' || status === 'failed') {
        cacheManager.updateMeta(archive).catch((e: unknown) => {
          logger.warn(`缓存元数据更新失败: ${archive.id}`, e)
        })
      }
    }
  }

  return { archives, updateStatus }
}
