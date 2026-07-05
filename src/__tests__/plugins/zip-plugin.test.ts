import { describe, it, expect } from 'vitest'
import { zipPlugin } from '@/plugins/compression/zip-plugin'
import { zipSync } from 'fflate'
import type { FileEntry } from '@/types'

describe('zipPlugin', () => {
  it('canHandle 识别 .zip 文件', () => {
    const zipFile: FileEntry = { name: 'test.zip', path: '/test.zip', size: 100, isDirectory: false }
    expect(zipPlugin.canHandle(zipFile)).toBe(true)
  })

  it('canHandle 拒绝非 .zip 文件', () => {
    const txtFile: FileEntry = { name: 'test.txt', path: '/test.txt', size: 100, isDirectory: false }
    const gzFile: FileEntry = { name: 'test.gz', path: '/test.gz', size: 100, isDirectory: false }
    expect(zipPlugin.canHandle(txtFile)).toBe(false)
    expect(zipPlugin.canHandle(gzFile)).toBe(false)
  })

  it('插件名称和 supportedExtensions 正确', () => {
    expect(zipPlugin.name).toBe('zip')
    expect(zipPlugin.supportedExtensions).toEqual(['.zip'])
  })

  it('无效数据解压返回失败', async () => {
    const badData = new Uint8Array([0, 1, 2, 3, 4, 5])
    const result = await zipPlugin.decompress(badData, '/output')
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('合法 ZIP 数据成功解压', async () => {
    // 用 fflate 创建合法 ZIP 数据
    const zipData = zipSync({
      'hello.txt': new TextEncoder().encode('Hello World'),
      'subdir/nested.txt': new TextEncoder().encode('Nested content'),
    })
    const result = await zipPlugin.decompress(zipData, '')
    expect(result.success).toBe(true)
    expect(result.files.length).toBeGreaterThanOrEqual(2)
    const names = result.files.map(f => f.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('subdir/nested.txt')
  })

  it('解压结果中的目录节点 isDirectory 为 true', async () => {
    const zipData = zipSync({
      'dir/': new Uint8Array(0),
      'dir/file.txt': new TextEncoder().encode('content'),
    })
    const result = await zipPlugin.decompress(zipData, '')
    expect(result.success).toBe(true)
    const dirEntry = result.files.find(f => f.name === 'dir/')
    if (dirEntry) {
      expect(dirEntry.isDirectory).toBe(true)
    }
  })
})
