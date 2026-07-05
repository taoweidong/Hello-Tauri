import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DecompressService } from '@/core/decompress'
import type { IPlatformAdapter } from '@/adapters/types'
import type { DecompressResult, FileEntry } from '@/types'
import type { ICompressionPlugin } from '@/plugins/types'

function createMockAdapter(): IPlatformAdapter {
  return {
    readFile: vi.fn(),
    readRange: vi.fn(),
    getFileSize: vi.fn(),
    decompress: vi.fn(),
    listFiles: vi.fn(),
    searchFiles: vi.fn(),
    getMimeType: vi.fn(),
  }
}

function createMockRegistry() {
  return {
    detectCompression: vi.fn(),
    safeDecompress: vi.fn(),
    getParser: vi.fn(),
    safeParse: vi.fn(),
    detect: vi.fn(),
    registerParser: vi.fn(),
    registerCompression: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  } as any
}

function createMockCompressionPlugin(): ICompressionPlugin {
  return {
    name: 'zip',
    supportedExtensions: ['.zip'],
    canHandle: () => true,
    decompress: vi.fn(),
  }
}

describe('DecompressService', () => {
  let adapter: IPlatformAdapter
  let registry: ReturnType<typeof createMockRegistry>
  let service: DecompressService

  beforeEach(() => {
    adapter = createMockAdapter()
    registry = createMockRegistry()
    service = new DecompressService(adapter, registry)
  })

  it('找到压缩插件时调用 safeDecompress 并返回结果', async () => {
    const plugin = createMockCompressionPlugin()
    const data = new Uint8Array([1, 2, 3])
    const expectedResult: DecompressResult = {
      success: true,
      files: [{ name: 'a.txt', path: 'a.txt', size: 100, isDirectory: false }],
    }

    registry.detectCompression.mockReturnValue(plugin)
    registry.safeDecompress.mockResolvedValue(expectedResult)

    const result = await service.decompress(data, 'test.zip', '/output')

    expect(registry.detectCompression).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test.zip', path: 'test.zip', size: 3 })
    )
    expect(registry.safeDecompress).toHaveBeenCalledWith(plugin, data, '/output')
    expect(result).toEqual(expectedResult)
  })

  it('无匹配插件时返回失败结果', async () => {
    const data = new Uint8Array([1, 2, 3])
    registry.detectCompression.mockReturnValue(null)

    const result = await service.decompress(data, 'test.rar', '/output')

    expect(result.success).toBe(false)
    expect(result.files).toEqual([])
    expect(result.error).toContain('No compression plugin for: test.rar')
    expect(registry.safeDecompress).not.toHaveBeenCalled()
  })

  it('safeDecompress 抛出异常时由 registry 包装', async () => {
    const plugin = createMockCompressionPlugin()
    const data = new Uint8Array([1])
    const failResult: DecompressResult = {
      success: false,
      files: [],
      error: 'decompress failed',
    }

    registry.detectCompression.mockReturnValue(plugin)
    registry.safeDecompress.mockResolvedValue(failResult)

    const result = await service.decompress(data, 'bad.zip', '/out')
    expect(result.success).toBe(false)
    expect(result.error).toBe('decompress failed')
  })
})
