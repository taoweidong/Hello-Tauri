import { describe, it, expect, beforeEach, vi } from 'vitest'
import { zipSync } from 'fflate'
import {
  ZipExtensionValidator,
  ZipContentValidator,
  ValidationPipeline,
  getFileValidator,
  resetFileValidator,
} from '@/core/file-validator'

// ─── 辅助工具 ──────────────────────────────────────────────

/** 用 fflate 生成包含指定文件的 zip Buffer，再包装为 File */
function makeZipFile(name: string, entries: Record<string, string>): File {
  const encoded: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(entries)) {
    encoded[path] = new TextEncoder().encode(content)
  }
  const buf = zipSync(encoded)
  return new File([buf], name, { type: 'application/zip' })
}

// ─── ZipExtensionValidator ─────────────────────────────────

describe('ZipExtensionValidator', () => {
  const validator = new ZipExtensionValidator()

  it('.zip 扩展名通过', async () => {
    const file = new File(['data'], 'archive.zip')
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
    expect(result.message).toBeUndefined()
  })

  it('大写 .ZIP 扩展名通过（大小写不敏感）', async () => {
    const file = new File(['data'], 'archive.ZIP')
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
  })

  it('.tar 扩展名失败并返回提示信息', async () => {
    const file = new File(['data'], 'archive.tar')
    const result = await validator.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('.tar')
    expect(result.message).toContain('仅支持 .zip')
  })

  it('无扩展名文件失败', async () => {
    const file = new File(['data'], 'README')
    const result = await validator.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('不支持的文件格式')
  })

  it('文件名仅为 .zip 时通过', async () => {
    const file = new File(['data'], '.zip')
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
  })
})

// ─── ZipContentValidator ───────────────────────────────────

describe('ZipContentValidator', () => {
  it('包含 VERSION.txt 的压缩包通过', async () => {
    const file = makeZipFile('valid.zip', { 'VERSION.txt': '1.0.0' })
    const validator = new ZipContentValidator()
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
  })

  it('包含子目录下 VERSION.txt 的压缩包通过（后缀匹配）', async () => {
    const file = makeZipFile('nested.zip', { 'subdir/VERSION.txt': '1.0.0' })
    const validator = new ZipContentValidator()
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
  })

  it('缺少 VERSION.txt 的压缩包失败', async () => {
    const file = makeZipFile('missing.zip', { 'data.txt': 'hello' })
    const validator = new ZipContentValidator()
    const result = await validator.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('VERSION.txt')
    expect(result.message).toContain('缺少必要文件')
  })

  it('自定义 requiredFiles 检查', async () => {
    const file = makeZipFile('custom.zip', { 'README.md': 'hello' })
    const validator = new ZipContentValidator(['config.json'])
    const result = await validator.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('config.json')
  })

  it('自定义 requiredFiles 全部存在时通过', async () => {
    const file = makeZipFile('multi.zip', {
      'VERSION.txt': '1.0',
      'config.json': '{}',
    })
    const validator = new ZipContentValidator(['VERSION.txt', 'config.json'])
    const result = await validator.validate(file)
    expect(result.ok).toBe(true)
  })

  it('损坏的 zip 文件返回错误提示', async () => {
    // 构造一个无效的 zip 数据
    const corruptData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    const file = new File([corruptData], 'corrupt.zip', { type: 'application/zip' })
    const validator = new ZipContentValidator()
    const result = await validator.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('无法读取')
    expect(result.message).toContain('损坏')
  })
})

// ─── ValidationPipeline ────────────────────────────────────

describe('ValidationPipeline', () => {
  it('所有验证器通过时返回 ok', async () => {
    const v1 = { name: 'v1', validate: vi.fn().mockResolvedValue({ ok: true }) }
    const v2 = { name: 'v2', validate: vi.fn().mockResolvedValue({ ok: true }) }
    const pipeline = new ValidationPipeline([v1, v2])

    const file = new File(['data'], 'test.zip')
    const result = await pipeline.validate(file)
    expect(result.ok).toBe(true)
    expect(v1.validate).toHaveBeenCalledTimes(1)
    expect(v2.validate).toHaveBeenCalledTimes(1)
  })

  it('第一个验证器失败时短路，后续验证器不执行', async () => {
    const v1 = { name: 'v1', validate: vi.fn().mockResolvedValue({ ok: false, message: 'fail' }) }
    const v2 = { name: 'v2', validate: vi.fn().mockResolvedValue({ ok: true }) }
    const pipeline = new ValidationPipeline([v1, v2])

    const file = new File(['data'], 'test.zip')
    const result = await pipeline.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('fail')
    expect(v2.validate).not.toHaveBeenCalled()
  })

  it('第二个验证器失败时，第一个已执行', async () => {
    const v1 = { name: 'v1', validate: vi.fn().mockResolvedValue({ ok: true }) }
    const v2 = { name: 'v2', validate: vi.fn().mockResolvedValue({ ok: false, message: 'v2 fail' }) }
    const pipeline = new ValidationPipeline([v1, v2])

    const file = new File(['data'], 'test.zip')
    const result = await pipeline.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('v2 fail')
    expect(v1.validate).toHaveBeenCalledTimes(1)
  })

  it('空验证器列表时直接通过', async () => {
    const pipeline = new ValidationPipeline([])
    const file = new File(['data'], 'test.zip')
    const result = await pipeline.validate(file)
    expect(result.ok).toBe(true)
  })

  it('validateAll：所有文件通过', async () => {
    const v = { name: 'v', validate: vi.fn().mockResolvedValue({ ok: true }) }
    const pipeline = new ValidationPipeline([v])

    const files = [
      new File(['a'], 'a.zip'),
      new File(['b'], 'b.zip'),
    ]
    const results = await pipeline.validateAll(files)
    expect(results.size).toBe(2)
    for (const r of results.values()) {
      expect(r.ok).toBe(true)
    }
  })

  it('validateAll：第一个文件失败时停止，后续文件不验证', async () => {
    const v = { name: 'v', validate: vi.fn().mockResolvedValue({ ok: false, message: 'bad' }) }
    const pipeline = new ValidationPipeline([v])

    const files = [
      new File(['a'], 'a.zip'),
      new File(['b'], 'b.zip'),
    ]
    const results = await pipeline.validateAll(files)
    // 只有第一个文件被验证
    expect(results.size).toBe(1)
    expect(results.get(files[0])?.ok).toBe(false)
    expect(v.validate).toHaveBeenCalledTimes(1)
  })
})

// ─── getFileValidator / resetFileValidator ──────────────────

describe('getFileValidator / resetFileValidator', () => {
  beforeEach(() => {
    resetFileValidator()
  })

  it('返回单例实例', () => {
    const a = getFileValidator()
    const b = getFileValidator()
    expect(a).toBe(b)
  })

  it('resetFileValidator 后返回新实例', () => {
    const a = getFileValidator()
    resetFileValidator()
    const b = getFileValidator()
    expect(a).not.toBe(b)
  })

  it('默认管线能正确拒绝非 zip 文件', async () => {
    const pipeline = getFileValidator()
    const file = new File(['data'], 'readme.txt')
    const result = await pipeline.validate(file)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('.zip')
  })
})
