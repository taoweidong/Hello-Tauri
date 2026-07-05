import { describe, it, expect, beforeEach, vi } from 'vitest'

// mock use-decompress 防止动态 import 触发循环依赖
vi.mock('@/composables/use-decompress', () => ({
  useDecompress: () => ({
    decompressAll: vi.fn(),
  }),
}))

import { useArchiveManager } from '@/composables/use-archives'
import { resetCache } from '@/composables/use-cache'

describe('useArchiveManager', () => {
  beforeEach(() => {
    const { reset } = useArchiveManager()
    reset()
    // 清理缓存存储（测试隔离）
    resetCache()
  })

  it('adds files and creates archive items', () => {
    const { archives, addFiles } = useArchiveManager()
    const files = [
      new File(['test'], 'test.zip', { type: 'application/zip' }),
    ]
    addFiles(files)
    expect(archives.value).toHaveLength(1)
    expect(archives.value[0].name).toBe('test.zip')
    expect(archives.value[0].status).toBe('pending')
  })

  it('removes archive by id', () => {
    const { archives, addFiles, remove } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    remove(id)
    expect(archives.value).toHaveLength(0)
  })

  it('computes aggregate stats', async () => {
    const { archives, addFiles, stats } = useArchiveManager()
    await addFiles([
      new File(['abc'], 'a.zip'),
      new File(['defgh'], 'b.zip'),
    ])
    expect(stats.value.totalCount).toBe(2)
    expect(stats.value.totalCompressedSize).toBe(8)
  })

  it('sets startTime when status becomes running', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'running')
    expect(archives.value[0].status).toBe('running')
    expect(archives.value[0].startTime).toBeTypeOf('number')
  })

  it('sets endTime when status becomes completed', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'completed')
    expect(archives.value[0].status).toBe('completed')
    expect(archives.value[0].endTime).toBeTypeOf('number')
  })

  it('updates progress when provided', () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    updateStatus(id, 'running', 50)
    expect(archives.value[0].progress).toBe(50)
  })

  it('failed 状态触发缓存元数据更新', async () => {
    const { archives, addFiles, updateStatus } = useArchiveManager()
    addFiles([new File(['test'], 'test.zip')])
    const id = archives.value[0].id
    // failed 不设 endTime，但会触发 updateMeta
    updateStatus(id, 'failed')
    expect(archives.value[0].status).toBe('failed')
    expect(archives.value[0].endTime).toBeUndefined()
  })

  it('去重：同名同大小文件只添加一次', () => {
    const { archives, addFiles } = useArchiveManager()
    const file = new File(['test'], 'test.zip')
    addFiles([file, file])
    expect(archives.value).toHaveLength(1)
  })

  it('去重：不同文件正常添加', async () => {
    const { archives, addFiles } = useArchiveManager()
    await addFiles([
      new File(['a'], 'a.zip'),
      new File(['bb'], 'b.zip'),
    ])
    expect(archives.value).toHaveLength(2)
  })

  it('remove 后去重键被清除，可以重新添加同名文件', () => {
    const { archives, addFiles, remove } = useArchiveManager()
    const file = new File(['test'], 'test.zip')
    addFiles([file])
    expect(archives.value).toHaveLength(1)
    const id = archives.value[0].id
    remove(id)
    expect(archives.value).toHaveLength(0)
    // 重新添加同名文件
    addFiles([file])
    expect(archives.value).toHaveLength(1)
  })

  it('addFiles 空数组时不创建归档', () => {
    const { archives, addFiles } = useArchiveManager()
    addFiles([])
    expect(archives.value).toHaveLength(0)
  })

  it('remove 不存在的 id 不报错', () => {
    const { remove } = useArchiveManager()
    expect(() => remove('nonexistent_id')).not.toThrow()
  })

  it('restoreFromCache 恢复缓存的归档列表', async () => {
    const { archives, addFiles, restoreFromCache, reset } = useArchiveManager()
    // 先添加文件以写入缓存
    addFiles([new File(['hello'], 'cached.zip')])
    expect(archives.value).toHaveLength(1)
    const cachedId = archives.value[0].id

    // 等待异步缓存写入完成
    await vi.waitFor(() =>
      expect(archives.value).toHaveLength(1)
    )
    // 额外等待微任务确保 cacheArchive 完成
    await new Promise(r => setTimeout(r, 10))

    // 重置内存状态（模拟重启）
    reset()
    resetCache()
    expect(archives.value).toHaveLength(0)

    // 重新添加以写入缓存（因为 resetCache 已清空存储）
    addFiles([new File(['hello'], 'cached.zip')])
    const newCachedId = archives.value[0].id
    await new Promise(r => setTimeout(r, 10))

    // 重置内存但保留缓存
    reset()
    expect(archives.value).toHaveLength(0)

    // 从缓存恢复
    await restoreFromCache()
    expect(archives.value).toHaveLength(1)
    expect(archives.value[0].id).toBe(newCachedId)
    expect(archives.value[0].name).toBe('cached.zip')
  })

  it('restoreFromCache 后 nextArchiveId 不与恢复的 id 冲突', async () => {
    const { archives, addFiles, restoreFromCache, reset } = useArchiveManager()
    // 添加文件并等待缓存写入
    addFiles([new File(['data'], 'old.zip')])
    await new Promise(r => setTimeout(r, 10))
    const oldId = archives.value[0].id

    // 重置内存但保留缓存
    reset()

    // 恢复
    await restoreFromCache()
    expect(archives.value).toHaveLength(1)

    // 添加新文件，id 应不冲突
    addFiles([new File(['new'], 'new.zip')])
    const ids = archives.value.map(a => a.id)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
    // 新 id 应不等于恢复的 id
    const newId = archives.value.find(a => a.name === 'new.zip')!.id
    expect(newId).not.toBe(oldId)
  })
})
