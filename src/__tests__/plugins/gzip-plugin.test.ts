import { describe, it, expect, vi, afterEach } from 'vitest'
import { gzipPlugin } from '@/plugins/compression/gzip-plugin'
import { gzipSync } from 'fflate'
import type { FileEntry } from '@/types'

describe('gzipPlugin', () => {
  it('canHandle 识别 .gz/.gzip/.tgz 文件', () => {
    const gz: FileEntry = { name: 'data.gz', path: '/data.gz', size: 100, isDirectory: false }
    const gzip: FileEntry = { name: 'data.gzip', path: '/data.gzip', size: 100, isDirectory: false }
    const tgz: FileEntry = { name: 'data.tgz', path: '/data.tgz', size: 100, isDirectory: false }
    expect(gzipPlugin.canHandle(gz)).toBe(true)
    expect(gzipPlugin.canHandle(gzip)).toBe(true)
    expect(gzipPlugin.canHandle(tgz)).toBe(true)
  })

  it('canHandle 拒绝不支持的格式', () => {
    const zip: FileEntry = { name: 'data.zip', path: '/data.zip', size: 100, isDirectory: false }
    const txt: FileEntry = { name: 'data.txt', path: '/data.txt', size: 100, isDirectory: false }
    expect(gzipPlugin.canHandle(zip)).toBe(false)
    expect(gzipPlugin.canHandle(txt)).toBe(false)
  })

  it('插件名称和 supportedExtensions 正确', () => {
    expect(gzipPlugin.name).toBe('gzip')
    expect(gzipPlugin.supportedExtensions).toEqual(['.gz', '.gzip', '.tgz'])
  })

  it('decompress 使用 DecompressionStream 成功解压（Web 端）', async () => {
    // 用 fflate 生成合法 gzip 数据
    const original = new TextEncoder().encode('hello gzip world')
    const gzipped = gzipSync(original)
    const data = new Uint8Array(gzipped)

    const result = await gzipPlugin.decompress(data, '')
    expect(result.success).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].name).toBe('decompressed')
    expect(result.files[0].size).toBe(original.length)
  })

  it('decompress 在 DecompressionStream 不可用时返回失败', async () => {
    // 临时移除 DecompressionStream
    const origDS = globalThis.DecompressionStream
    // @ts-expect-error 临时删除
    delete globalThis.DecompressionStream

    try {
      const data = new Uint8Array([1, 2, 3])
      const result = await gzipPlugin.decompress(data, '')
      expect(result.success).toBe(false)
      expect(result.error).toContain('解压不可用')
    } finally {
      // 恢复
      if (origDS) {
        globalThis.DecompressionStream = origDS
      }
    }
  })
})
