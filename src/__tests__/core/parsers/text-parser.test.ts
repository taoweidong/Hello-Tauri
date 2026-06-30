import { describe, it, expect } from 'vitest'
import { parseText } from '@/core/parsers/text-parser'

describe('parseText', () => {
  it('解码 UTF-8 并计数行数', () => {
    const data = new TextEncoder().encode('line1\nline2\nline3')
    const result = parseText(data)
    expect(result.type).toBe('text')
    expect(result.data).toBe('line1\nline2\nline3')
    expect(result.lineCount).toBe(3)
  })

  it('处理空文件', () => {
    const result = parseText(new Uint8Array(0))
    expect(result.type).toBe('text')
    expect(result.data).toBe('')
    expect(result.lineCount).toBe(0)
  })

  it('处理中文字符', () => {
    const data = new TextEncoder().encode('你好\n世界')
    const result = parseText(data)
    expect(result.data).toBe('你好\n世界')
    expect(result.lineCount).toBe(2)
  })
})
