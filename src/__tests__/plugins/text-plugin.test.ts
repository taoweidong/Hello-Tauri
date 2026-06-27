import { describe, it, expect } from 'vitest'
import { textPlugin } from '@/plugins/parser/text-plugin'
import type { FileEntry } from '@/adapters/types'

describe('textPlugin', () => {
  const file: FileEntry = { name: 'app.log', path: '/app.log', size: 100, isDirectory: false }

  it('canParse returns true for .txt/.log files', () => {
    expect(textPlugin.canParse(file)).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'data.txt' })).toBe(true)
    expect(textPlugin.canParse({ ...file, name: 'image.png' })).toBe(false)
  })

  it('parse returns text content with line count', async () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('parse handles empty file', async () => {
    const data = new Uint8Array(0)
    const result = await textPlugin.parse(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })
})
