import { describe, it, expect } from 'vitest'
import { parseJson } from '@/core/parsers/json-parser'

describe('parseJson', () => {
  it('解析对象', () => {
    const result = parseJson('{"name":"Alice","age":30}')
    expect(result.type).toBe('json')
    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.lineCount).toBeGreaterThan(0)
  })

  it('解析数组', () => {
    const result = parseJson('[1, 2, 3]')
    expect(result.data).toEqual([1, 2, 3])
  })

  it('解析 JSONL（换行分隔对象）', () => {
    const result = parseJson('{"a":1}\n{"b":2}')
    expect(result.data).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('非法 JSON 抛错', () => {
    expect(() => parseJson('{invalid}')).toThrow()
  })

  it('抛错信息含原因', () => {
    try {
      parseJson('{invalid}')
      throw new Error('应抛错')
    } catch (err) {
      expect((err as Error).message).toContain('Invalid JSON')
    }
  })

  it('解析多行美化对象', () => {
    const result = parseJson('{\n  "a": 1\n}')
    expect(result.type).toBe('json')
    expect(result.data).toEqual({ a: 1 })
  })
})
