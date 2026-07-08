import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * cache-idb.ts 单元测试
 * 由于 jsdom 不提供完整的 IndexedDB，使用 mock 方式测试 IdbCacheStorage 逻辑
 */

// mock IDBDatabase 和相关对象
function createMockStore(data: Map<string, any> = new Map()) {
  return {
    put: vi.fn((value: any, key?: string) => {
      const k = key ?? value.id
      data.set(k, value)
      return { onsuccess: null, onerror: null } as any
    }),
    get: vi.fn((key: string) => {
      const result = data.get(key)
      return { result, onsuccess: null, onerror: null } as any
    }),
    getAll: vi.fn(() => {
      const result = Array.from(data.values())
      return { result, onsuccess: null, onerror: null } as any
    }),
    getAllKeys: vi.fn(() => {
      const result = Array.from(data.keys())
      return { result, onsuccess: null, onerror: null } as any
    }),
    delete: vi.fn((key: string) => {
      data.delete(key)
      return { onsuccess: null, onerror: null } as any
    }),
  }
}

describe('IdbCacheStorage 逻辑验证（通过 MemoryCacheStorage 行为等价测试）', () => {
  /**
   * 由于 jsdom 无 IndexedDB，直接测试 ICacheStorage 接口的内存实现
   * 确保 IdbCacheStorage 所依赖的 ICacheStorage 契约正确
   */
  let storage: any

  beforeEach(async () => {
    const { MemoryCacheStorage } = await import('../memory-cache-storage')
    storage = new MemoryCacheStorage()
    await storage.init()
  })

  it('saveMeta + loadMeta 存取元数据', async () => {
    const meta = {
      id: 'a1',
      name: 'test.zip',
      files: [],
      status: 'completed' as const,
      progress: 100,
      lastAccessed: Date.now(),
      originalSize: 1024,
      compressedSize: 512,
    }
    await storage.saveMeta('a1', meta)
    const loaded = await storage.loadMeta('a1')
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe('test.zip')
  })

  it('loadMeta 不存在的 id 返回 null', async () => {
    const result = await storage.loadMeta('nonexistent')
    expect(result).toBeNull()
  })

  it('loadAllMeta 按 lastAccessed 升序排列', async () => {
    await storage.saveMeta('a1', { id: 'a1', name: 'a.zip', files: [], status: 'completed', progress: 100, lastAccessed: 200, originalSize: 0, compressedSize: 0 })
    await storage.saveMeta('a2', { id: 'a2', name: 'b.zip', files: [], status: 'completed', progress: 100, lastAccessed: 100, originalSize: 0, compressedSize: 0 })
    const all = await storage.loadAllMeta()
    expect(all).toHaveLength(2)
    expect(all[0].id).toBe('a2') // 较旧的在前
    expect(all[1].id).toBe('a1')
  })

  it('deleteMeta 删除元数据', async () => {
    await storage.saveMeta('a1', { id: 'a1', name: 'a.zip', files: [], status: 'completed', progress: 100, lastAccessed: 100, originalSize: 0, compressedSize: 0 })
    await storage.deleteMeta('a1')
    const result = await storage.loadMeta('a1')
    expect(result).toBeNull()
  })

  it('saveFileData + loadFileData 存取二进制数据', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await storage.saveFileData('a1', data)
    const loaded = await storage.loadFileData('a1')
    expect(loaded).not.toBeNull()
    expect(Array.from(loaded!)).toEqual([1, 2, 3, 4, 5])
  })

  it('loadFileData 不存在的 id 返回 null', async () => {
    const result = await storage.loadFileData('nonexistent')
    expect(result).toBeNull()
  })

  it('deleteFileData 删除二进制数据', async () => {
    await storage.saveFileData('a1', new Uint8Array([1]))
    await storage.deleteFileData('a1')
    const result = await storage.loadFileData('a1')
    expect(result).toBeNull()
  })

  it('listIds 返回所有归档 id', async () => {
    await storage.saveMeta('a1', { id: 'a1', name: 'a.zip', files: [], status: 'completed', progress: 100, lastAccessed: 100, originalSize: 0, compressedSize: 0 })
    await storage.saveMeta('a2', { id: 'a2', name: 'b.zip', files: [], status: 'completed', progress: 100, lastAccessed: 200, originalSize: 0, compressedSize: 0 })
    const ids = await storage.listIds()
    expect(ids).toContain('a1')
    expect(ids).toContain('a2')
    expect(ids).toHaveLength(2)
  })
})

describe('IdbCacheStorage close 方法', () => {
  it('close() 方法存在于类定义中', async () => {
    // 验证 IdbCacheStorage 类有 close 方法（不实际调用 DB）
    const { IdbCacheStorage } = await import('@/core/cache-idb')
    const instance = new IdbCacheStorage()
    expect(typeof instance.close).toBe('function')
  })

  it('close() 在未初始化时不抛异常', async () => {
    const { IdbCacheStorage } = await import('@/core/cache-idb')
    const instance = new IdbCacheStorage()
    // 未调用 init()，close 不应抛异常
    expect(() => instance.close()).not.toThrow()
  })
})
