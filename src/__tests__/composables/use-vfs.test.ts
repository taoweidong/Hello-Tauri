import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * use-vfs.ts 虚拟文件系统 composable 单元测试
 * 通过 mock 平台适配器测试 readFile / listDir 的正常与异常路径
 */

// mock 适配器
const mockAdapter = {
  readFile: vi.fn(),
  listFiles: vi.fn(),
  writeFile: vi.fn(),
  getTempDir: vi.fn(),
  decompress: vi.fn(),
  mmapRead: vi.fn(),
  streamRead: vi.fn(),
}

vi.mock('@/composables/use-platform', () => ({
  usePlatform: () => ({
    getAdapter: async () => mockAdapter,
  }),
}))

import { useVirtualFileSystem } from '@/composables/use-vfs'

describe('useVirtualFileSystem', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('readFile', () => {
    it('正常读取文件返回 Uint8Array', async () => {
      const data = new Uint8Array([1, 2, 3])
      mockAdapter.readFile.mockResolvedValue(data)

      const { readFile } = useVirtualFileSystem()
      const result = await readFile('/test.txt')
      expect(result).toEqual(data)
      expect(mockAdapter.readFile).toHaveBeenCalledWith('/test.txt')
    })

    it('适配器抛出异常时向上传播', async () => {
      mockAdapter.readFile.mockRejectedValue(new Error('IO error'))

      const { readFile } = useVirtualFileSystem()
      await expect(readFile('/err.txt')).rejects.toThrow('IO error')
    })

    it('空文件返回空 Uint8Array', async () => {
      mockAdapter.readFile.mockResolvedValue(new Uint8Array(0))

      const { readFile } = useVirtualFileSystem()
      const result = await readFile('/empty.txt')
      expect(result).toHaveLength(0)
    })
  })

  describe('listDir', () => {
    it('正常列出目录返回文件条目', async () => {
      const entries = [
        { name: 'a.txt', path: '/dir/a.txt', size: 100, isDirectory: false },
        { name: 'sub', path: '/dir/sub', size: 0, isDirectory: true },
      ]
      mockAdapter.listFiles.mockResolvedValue(entries)

      const { listDir } = useVirtualFileSystem()
      const result = await listDir('/dir')
      expect(result).toEqual(entries)
      expect(mockAdapter.listFiles).toHaveBeenCalledWith('/dir')
    })

    it('空目录返回空数组', async () => {
      mockAdapter.listFiles.mockResolvedValue([])

      const { listDir } = useVirtualFileSystem()
      const result = await listDir('/empty')
      expect(result).toHaveLength(0)
    })

    it('适配器抛出异常时向上传播', async () => {
      mockAdapter.listFiles.mockRejectedValue(new Error('Permission denied'))

      const { listDir } = useVirtualFileSystem()
      await expect(listDir('/restricted')).rejects.toThrow('Permission denied')
    })
  })
})
