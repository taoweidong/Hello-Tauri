import { describe, it, expect, beforeEach } from 'vitest'
import { CacheManager } from '@/core/cache-manager'
import { MemoryCacheStorage } from '../memory-cache-storage'
import type { ArchiveItem } from '@/types'

/** 创建测试用的 ArchiveItem 模拟对象 */
function makeArchiveItem(overrides: Partial<ArchiveItem> = {}): ArchiveItem {
  return {
    id: overrides.id ?? 'archive_0',
    name: overrides.name ?? 'test.zip',
    file: undefined,
    cacheId: overrides.cacheId ?? overrides.id ?? 'archive_0',
    status: overrides.status ?? 'pending',
    progress: overrides.progress ?? 0,
    files: overrides.files ?? [],
    originalSize: overrides.originalSize ?? 0,
    compressedSize: overrides.compressedSize ?? 100,
  }
}

describe('CacheManager', () => {
  let storage: MemoryCacheStorage
  let manager: CacheManager

  beforeEach(async () => {
    storage = new MemoryCacheStorage()
    manager = new CacheManager(storage, { maxItems: 3 })
    await manager.init()
  })

  describe('缓存写入与读取', () => {
    it('cacheArchive 保存元数据和二进制数据', async () => {
      const archive = makeArchiveItem({ id: 'a1', name: 'demo.zip' })
      const file = new File(['hello world'], 'demo.zip')

      await manager.cacheArchive(archive, file)

      // 元数据可恢复
      const meta = await storage.loadMeta('a1')
      expect(meta).not.toBeNull()
      expect(meta!.name).toBe('demo.zip')
      expect(meta!.id).toBe('a1')

      // 二进制数据可恢复
      const data = await storage.loadFileData('a1')
      expect(data).not.toBeNull()
      expect(new TextDecoder().decode(data!)).toBe('hello world')
    })

    it('getFileData 返回 null 当数据不存在时', async () => {
      const data = await manager.getFileData('nonexistent')
      expect(data).toBeNull()
    })
  })

  describe('restoreAll 恢复元数据', () => {
    it('恢复所有已缓存的归档元数据', async () => {
      const a1 = makeArchiveItem({ id: 'a1', name: 'one.zip', status: 'completed' })
      const a2 = makeArchiveItem({ id: 'a2', name: 'two.zip', status: 'pending' })

      await manager.cacheArchive(a1, new File(['x'], 'one.zip'))
      // 等待以确保不同的 lastAccessed
      await new Promise(r => setTimeout(r, 10))
      await manager.cacheArchive(a2, new File(['y'], 'two.zip'))

      const restored = await manager.restoreAll()
      expect(restored).toHaveLength(2)
      expect(restored.map(m => m.name)).toContain('one.zip')
      expect(restored.map(m => m.name)).toContain('two.zip')
    })

    it('空缓存时返回空数组', async () => {
      const restored = await manager.restoreAll()
      expect(restored).toHaveLength(0)
    })
  })

  describe('remove 清理缓存', () => {
    it('同时删除元数据和二进制数据', async () => {
      const archive = makeArchiveItem({ id: 'a1' })
      await manager.cacheArchive(archive, new File(['data'], 'test.zip'))

      await manager.remove('a1')

      expect(await storage.loadMeta('a1')).toBeNull()
      expect(await storage.loadFileData('a1')).toBeNull()
    })

    it('删除不存在的 id 不抛异常', async () => {
      await expect(manager.remove('nonexistent')).resolves.toBeUndefined()
    })
  })

  describe('LRU 淘汰', () => {
    it('init 时淘汰超过 maxItems 的最旧缓存', async () => {
      // maxItems = 3，写入 5 个缓存
      for (let i = 0; i < 5; i++) {
        const archive = makeArchiveItem({ id: `a${i}`, name: `file${i}.zip` })
        await manager.cacheArchive(archive, new File([`content${i}`], `file${i}.zip`))
        // 等待以确保 lastAccessed 不同
        await new Promise(r => setTimeout(r, 5))
      }

      // 重新 init 触发淘汰
      const manager2 = new CacheManager(storage, { maxItems: 3 })
      await manager2.init()

      const remaining = await storage.listIds()
      expect(remaining).toHaveLength(3)
      // 保留最新的 3 个（a2, a3, a4）
      expect(remaining).toContain('a2')
      expect(remaining).toContain('a3')
      expect(remaining).toContain('a4')
      // 淘汰最旧的 2 个（a0, a1）
      expect(remaining).not.toContain('a0')
      expect(remaining).not.toContain('a1')
    })

    it('getFileData 更新 lastAccessed 使缓存不被淘汰', async () => {
      // maxItems = 3，写入 3 个缓存
      for (let i = 0; i < 3; i++) {
        const archive = makeArchiveItem({ id: `a${i}` })
        await manager.cacheArchive(archive, new File([`c${i}`], `f${i}.zip`))
        await new Promise(r => setTimeout(r, 5))
      }

      // touch a0（最旧的）使其 lastAccessed 更新
      await new Promise(r => setTimeout(r, 10))
      await manager.getFileData('a0')

      // 新增第 4 个缓存触发淘汰
      const a3 = makeArchiveItem({ id: 'a3' })
      await manager.cacheArchive(a3, new File(['c3'], 'f3.zip'))

      // 重新 init 触发淘汰
      const manager2 = new CacheManager(storage, { maxItems: 3 })
      await manager2.init()

      const remaining = await storage.listIds()
      expect(remaining).toHaveLength(3)
      // a0 应该保留（被 touch 过），a1 被淘汰（最旧）
      expect(remaining).toContain('a0')
      expect(remaining).not.toContain('a1')
    })
  })

  describe('updateMeta 更新缓存元数据', () => {
    it('更新文件树和状态', async () => {
      const archive = makeArchiveItem({ id: 'a1', status: 'pending', files: [] })
      await manager.cacheArchive(archive, new File(['x'], 'test.zip'))

      // 模拟解压完成
      archive.status = 'completed'
      archive.files = [{ key: 'f1', label: 'inner.txt', isLeaf: true, path: 'inner.txt' }]
      archive.originalSize = 1024

      await manager.updateMeta(archive)

      const meta = await storage.loadMeta('a1')
      expect(meta!.status).toBe('completed')
      expect(meta!.files).toHaveLength(1)
      expect(meta!.files[0].label).toBe('inner.txt')
      expect(meta!.originalSize).toBe(1024)
    })

    it('不存在的 id 不抛异常', async () => {
      const archive = makeArchiveItem({ id: 'nonexistent' })
      await expect(manager.updateMeta(archive)).resolves.toBeUndefined()
    })
  })
})
