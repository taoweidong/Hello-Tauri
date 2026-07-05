import { describe, it, expect, vi, beforeEach } from 'vitest'

// 绕过 setup.ts 中的全局 mock，直接测试真实模块
vi.unmock('@/composables/use-cache')

describe('use-cache composable', () => {
  beforeEach(() => {
    vi.resetModules()
    // 每次重置后重新注册 mock
    vi.doMock('@/core/cache-manager', () => {
      // 必须使用 class 或 function 构造函数，因为源码中用 new 调用
      class MockCacheManager {
        init = vi.fn().mockResolvedValue(undefined)
        getFileData = vi.fn()
        saveFileData = vi.fn()
        getArchiveList = vi.fn()
        saveArchiveList = vi.fn()
        clear = vi.fn()
        constructor(_storage?: any, _options?: any) {}
      }
      return { CacheManager: MockCacheManager }
    })
    vi.doMock('@/core/cache-idb', () => {
      class MockIdbStorage {}
      return { IdbCacheStorage: MockIdbStorage }
    })
    vi.doMock('@/core/cache-fs', () => {
      class MockFsStorage {}
      return { FsCacheStorage: MockFsStorage }
    })
  })

  it('useCacheManager 返回单例', async () => {
    const { useCacheManager, resetCache } = await import('@/composables/use-cache')
    const a = useCacheManager()
    const b = useCacheManager()
    expect(a).toBe(b)
    resetCache()
  })

  it('resetCache 后重新获取会创建新实例', async () => {
    const { useCacheManager, resetCache } = await import('@/composables/use-cache')
    const a = useCacheManager()
    resetCache()
    const b = useCacheManager()
    expect(a).not.toBe(b)
  })

  it('initCache 返回 CacheManager 实例', async () => {
    const { initCache, resetCache } = await import('@/composables/use-cache')
    const manager = await initCache()
    expect(manager).toBeDefined()
    expect(manager.init).toBeDefined()
    resetCache()
  })
})
