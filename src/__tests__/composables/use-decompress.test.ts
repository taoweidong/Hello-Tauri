import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ArchiveItem } from '@/types'

// mock use-archives
const mockUpdateStatus = vi.fn()
const mockArchives = { value: [] as ArchiveItem[] }
vi.mock('@/composables/use-archives', () => ({
  useArchiveManager: () => ({
    archives: mockArchives,
    updateStatus: mockUpdateStatus,
  }),
}))

// mock use-plugins
const mockDetectCompression = vi.fn()
const mockSafeDecompress = vi.fn()
vi.mock('@/composables/use-plugins', () => ({
  usePluginEngine: () => ({
    registry: {
      detectCompression: mockDetectCompression,
      safeDecompress: mockSafeDecompress,
    },
  }),
}))

// mock use-cache
const mockGetFileData = vi.fn()
vi.mock('@/composables/use-cache', () => ({
  useCacheManager: () => ({
    getFileData: mockGetFileData,
  }),
}))

// mock TaskScheduler：立即执行回调并返回 taskId
let pendingCallback: (() => Promise<void>) | null = null
vi.mock('@/core/task-scheduler', () => {
  function MockScheduler(this: any) {
    this.enqueue = vi.fn((fn: () => Promise<void>) => {
      pendingCallback = fn
      fn() // 启动异步回调
      return 'task_1'
    })
  }
  return { TaskScheduler: MockScheduler }
})

// mock FileTreeBuilder
vi.mock('@/core/file-tree', () => {
  function MockTreeBuilder(this: any) {
    this.build = vi.fn().mockReturnValue([{ key: 'root', label: 'root', isLeaf: false }])
  }
  return { FileTreeBuilder: MockTreeBuilder }
})

import { useDecompress } from '@/composables/use-decompress'

/** 等待所有微任务完成 */
function flushAsync() {
  return new Promise(r => setTimeout(r, 0))
}

/** 创建测试用 ArchiveItem */
function createArchive(overrides?: Partial<ArchiveItem>): ArchiveItem {
  return {
    id: 'archive_0',
    name: 'test.zip',
    cacheId: 'archive_0',
    status: 'pending',
    progress: 0,
    files: [],
    originalSize: 0,
    compressedSize: 100,
    ...overrides,
  }
}

describe('useDecompress', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingCallback = null
    mockArchives.value = []
  })

  it('返回 startDecompress 和 decompressAll 方法', () => {
    const { startDecompress, decompressAll } = useDecompress()
    expect(typeof startDecompress).toBe('function')
    expect(typeof decompressAll).toBe('function')
  })

  it('startDecompress：有 File 对象时从 arrayBuffer 读取数据并成功解压', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()

    const content = new Uint8Array([1, 2, 3, 4])
    archive.file = new File([content], 'test.zip')

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockResolvedValue({
      success: true,
      files: [{ name: 'inner.txt', path: 'inner.txt', size: 50, isDirectory: false }],
    })

    await startDecompress(archive)
    await flushAsync()

    // 状态更新序列：running(0) → running(30) → running(80) → completed(100)
    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'running', 0)
    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'running', 30)
    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'running', 80)
    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'completed', 100)
    expect(archive.originalSize).toBe(50)
  })

  it('startDecompress：无 File 对象时从缓存读取数据', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()

    const cachedData = new Uint8Array([10, 20, 30])
    mockGetFileData.mockResolvedValue(cachedData)

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockResolvedValue({
      success: true,
      files: [{ name: 'data.txt', path: 'data.txt', size: 30, isDirectory: false }],
    })

    await startDecompress(archive)
    await flushAsync()

    expect(mockGetFileData).toHaveBeenCalledWith(archive.cacheId)
    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'completed', 100)
  })

  it('startDecompress：缓存数据丢失时标记失败', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()

    mockGetFileData.mockResolvedValue(null)

    await startDecompress(archive)
    await flushAsync()

    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'failed')
    expect(archive.error).toContain('缓存数据丢失')
  })

  it('startDecompress：无压缩插件匹配时标记失败', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()
    archive.file = new File([new Uint8Array([1, 2])], 'test.zip')

    mockDetectCompression.mockReturnValue(null)

    await startDecompress(archive)
    await flushAsync()

    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'failed')
    expect(archive.error).toContain('No plugin for')
  })

  it('startDecompress：解压失败时记录错误信息', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()
    archive.file = new File([new Uint8Array([1, 2])], 'test.zip')

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockResolvedValue({
      success: false,
      files: [],
      error: 'Corrupt ZIP data',
    })

    await startDecompress(archive)
    await flushAsync()

    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'failed')
    expect(archive.error).toBe('Corrupt ZIP data')
  })

  it('startDecompress：解压抛出异常时捕获错误', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()
    archive.file = new File([new Uint8Array([1, 2])], 'test.zip')

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockRejectedValue(new Error('Unexpected crash'))

    await startDecompress(archive)
    await flushAsync()

    expect(mockUpdateStatus).toHaveBeenCalledWith(archive.id, 'failed')
    expect(archive.error).toBe('Unexpected crash')
  })

  it('startDecompress：非 Error 异常使用默认错误信息', async () => {
    const { startDecompress } = useDecompress()
    const archive = createArchive()
    archive.file = new File([new Uint8Array([1, 2])], 'test.zip')

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockRejectedValue('string error')

    await startDecompress(archive)
    await flushAsync()

    expect(archive.error).toBe('Unknown error')
  })

  it('decompressAll：仅解压 pending 状态的归档', async () => {
    const { decompressAll } = useDecompress()

    const pending1 = createArchive({ id: 'a1', name: 'a.zip' })
    pending1.file = new File([new Uint8Array([1])], 'a.zip')
    const running = createArchive({ id: 'a2', name: 'b.zip', status: 'running' })
    const pending2 = createArchive({ id: 'a3', name: 'c.zip' })
    pending2.file = new File([new Uint8Array([2])], 'c.zip')

    mockArchives.value = [pending1, running, pending2]

    const mockPlugin = { name: 'zip' }
    mockDetectCompression.mockReturnValue(mockPlugin)
    mockSafeDecompress.mockResolvedValue({
      success: true,
      files: [{ name: 'f.txt', path: 'f.txt', size: 10, isDirectory: false }],
    })

    decompressAll()
    await flushAsync()

    // pending1 和 pending2 应被处理（running 状态跳过）
    const runningZeroCalls = mockUpdateStatus.mock.calls.filter(
      ([, status, progress]) => status === 'running' && progress === 0
    )
    expect(runningZeroCalls.length).toBe(2)
  })

  it('decompressAll：无 pending 归档时不做任何操作', () => {
    const { decompressAll } = useDecompress()
    mockArchives.value = [
      createArchive({ status: 'completed' }),
      createArchive({ status: 'failed' }),
    ]

    decompressAll()

    expect(mockDetectCompression).not.toHaveBeenCalled()
  })
})
