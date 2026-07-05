import { describe, it, expect } from 'vitest'
import { zipPlugin } from '@/plugins/compression/zip-plugin'
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
})
