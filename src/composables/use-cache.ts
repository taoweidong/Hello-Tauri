/**
 * 缓存管理器平台适配 composable
 * 根据 __PLATFORM__ 编译时常量选择存储后端，提供 CacheManager 单例
 */
import { CacheManager } from '@/core/cache-manager'
import { IdbCacheStorage } from '@/core/cache-idb'
import { FsCacheStorage } from '@/core/cache-fs'
import type { ICacheStorage } from '@/core/cache-storage'

let cacheManager: CacheManager | null = null
let initPromise: Promise<CacheManager> | null = null

/**
 * 获取 CacheManager 单例（懒初始化）
 * 首次调用时根据平台创建对应的存储后端
 */
export function useCacheManager(): CacheManager {
  if (!cacheManager) {
    const platform = __PLATFORM__
    const storage: ICacheStorage = platform === 'tauri'
      ? new FsCacheStorage()
      : new IdbCacheStorage()
    cacheManager = new CacheManager(storage, { maxItems: 20 })
  }
  return cacheManager
}

/**
 * 初始化缓存系统并恢复上一次的归档列表
 * 应在应用启动时调用一次（main.ts）
 * 初始化失败时重置 Promise 缓存，允许下次重试
 */
export async function initCache(): Promise<CacheManager> {
  if (initPromise) return initPromise

  initPromise = (async () => {
    const manager = useCacheManager()
    await manager.init()
    return manager
  })()

  // 初始化失败时重置缓存，允许下次重试
  initPromise.catch(() => {
    initPromise = null
  })

  return initPromise
}

/**
 * 重置缓存单例（仅用于测试）
 */
export function resetCache(): void {
  cacheManager = null
  initPromise = null
}
