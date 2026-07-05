import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isArchiveFile, filterArchiveFiles } from '@/core/archive-utils'

describe('isArchiveFile', () => {
  it('识别支持的压缩包格式', () => {
    expect(isArchiveFile('test.zip')).toBe(true)
    expect(isArchiveFile('test.gz')).toBe(true)
    expect(isArchiveFile('test.gzip')).toBe(true)
    expect(isArchiveFile('test.tgz')).toBe(true)
    expect(isArchiveFile('test.7z')).toBe(true)
    expect(isArchiveFile('test.rar')).toBe(true)
    expect(isArchiveFile('test.tar')).toBe(true)
  })

  it('大写扩展名也能识别', () => {
    expect(isArchiveFile('test.ZIP')).toBe(true)
    expect(isArchiveFile('test.Zip')).toBe(true)
    expect(isArchiveFile('TEST.GZ')).toBe(true)
  })

  it('不支持的格式返回 false', () => {
    expect(isArchiveFile('test.txt')).toBe(false)
    expect(isArchiveFile('test.csv')).toBe(false)
    expect(isArchiveFile('test.json')).toBe(false)
    expect(isArchiveFile('test.exe')).toBe(false)
    expect(isArchiveFile('noext')).toBe(false)
  })

  it('路径中包含目录前缀也能正确判断', () => {
    expect(isArchiveFile('/path/to/file.zip')).toBe(true)
    expect(isArchiveFile('C:\\data\\test.rar')).toBe(true)
  })
})

describe('filterArchiveFiles', () => {
  it('过滤出压缩包文件', () => {
    const files = [
      new File([''], 'a.zip', { type: 'application/zip' }),
      new File([''], 'b.txt', { type: 'text/plain' }),
      new File([''], 'c.gz', { type: 'application/gzip' }),
      new File([''], 'd.json', { type: 'application/json' }),
    ]
    const result = filterArchiveFiles(files)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('a.zip')
    expect(result[1].name).toBe('c.gz')
  })

  it('空数组返回空', () => {
    expect(filterArchiveFiles([])).toEqual([])
  })

  it('全部非压缩包返回空', () => {
    const files = [
      new File([''], 'a.txt'),
      new File([''], 'b.csv'),
    ]
    expect(filterArchiveFiles(files)).toEqual([])
  })
})

describe('validateArchiveFiles', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('验证通过的文件全部保留', async () => {
    vi.doMock('@/core/file-validator', () => ({
      getFileValidator: () => ({
        validate: async () => ({ ok: true }),
      }),
      resetFileValidator: () => {},
    }))
    const { validateArchiveFiles } = await import('@/core/archive-utils')
    const files = [new File([''], 'a.zip'), new File([''], 'b.zip')]
    const result = await validateArchiveFiles(files)
    expect(result).toHaveLength(2)
  })

  it('验证失败的文件被过滤，并触发 onError 回调', async () => {
    vi.doMock('@/core/file-validator', () => ({
      getFileValidator: () => ({
        validate: async (f: File) =>
          f.name.endsWith('.zip') ? { ok: true } : { ok: false, message: '格式不支持' },
      }),
      resetFileValidator: () => {},
    }))
    const { validateArchiveFiles } = await import('@/core/archive-utils')
    const errors: Array<{ name: string; msg: string }> = []
    const files = [new File([''], 'a.zip'), new File([''], 'b.txt')]
    const result = await validateArchiveFiles(files, (name, msg) => errors.push({ name, msg }))
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('a.zip')
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe('b.txt')
    expect(errors[0].msg).toBe('格式不支持')
  })

  it('无 onError 回调时验证失败不抛错', async () => {
    vi.doMock('@/core/file-validator', () => ({
      getFileValidator: () => ({
        validate: async () => ({ ok: false, message: '失败' }),
      }),
      resetFileValidator: () => {},
    }))
    const { validateArchiveFiles } = await import('@/core/archive-utils')
    const result = await validateArchiveFiles([new File([''], 'bad.zip')])
    expect(result).toHaveLength(0)
  })
})
