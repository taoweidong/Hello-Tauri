import { describe, it, expect } from 'vitest'
import { gzipPlugin } from '@/plugins/compression/gzip-plugin'
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
})
