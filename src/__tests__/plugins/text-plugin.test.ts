import { describe, it, expect } from 'vitest'
import { textPlugin } from '@/plugins/parser/text-plugin'
import type { FileEntry } from '@/adapters/types'

describe('textPlugin', () => {
  const file: FileEntry = { name: 'notes.txt', path: '/notes.txt', size: 100, isDirectory: false }

  it('canParse 对 .txt 返回 true，对 .log 返回 false（已交由 logPlugin）', () => {
    expect(textPlugin.canParse(file)).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'app.log' })).toBe(false)
    expect(textPlugin.canParse({ ...file, name: 'image.png' })).toBe(false)
  })

  it('parse 返回文本内容与行数', async () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('parse 处理空文件', async () => {
    const data = new Uint8Array(0)
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })
})
