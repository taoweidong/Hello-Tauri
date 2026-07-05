import { describe, it, expect } from 'vitest'
import { formatSize, formatDuration } from '@/core/format'

describe('formatSize', () => {
  it('0 字节返回 "0 B"', () => {
    expect(formatSize(0)).toBe('0 B')
  })

  it('小于 1KB 显示 B', () => {
    expect(formatSize(500)).toBe('500 B')
    expect(formatSize(1)).toBe('1 B')
    expect(formatSize(1023)).toBe('1023 B')
  })

  it('KB 级别', () => {
    expect(formatSize(1024)).toBe('1 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 100)).toBe('100 KB')
  })

  it('MB 级别', () => {
    expect(formatSize(1024 * 1024)).toBe('1 MB')
    expect(formatSize(1024 * 1024 * 1.5)).toBe('1.5 MB')
  })

  it('GB 级别', () => {
    expect(formatSize(1024 ** 3)).toBe('1 GB')
    expect(formatSize(1024 ** 3 * 2.5)).toBe('2.5 GB')
  })
})

describe('formatDuration', () => {
  it('小于 1000ms 显示毫秒', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(1)).toBe('1 ms')
    expect(formatDuration(999)).toBe('999 ms')
  })

  it('大于等于 1000ms 显示秒', () => {
    expect(formatDuration(1000)).toBe('1.00 s')
    expect(formatDuration(1500)).toBe('1.50 s')
    expect(formatDuration(60000)).toBe('60.00 s')
  })
})
