import { describe, it, expect } from 'vitest'
import { jsonPlugin } from '@/plugins/parser/json-plugin'

describe('jsonPlugin', () => {
  it('canParse returns true for .json/.jsonl files', () => {
    expect(jsonPlugin.canParse({ name: 'data.json', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(jsonPlugin.canParse({ name: 'data.jsonl', path: '/', size: 0, isDirectory: false })).toBe(true)
    expect(jsonPlugin.canParse({ name: 'data.txt', path: '/', size: 0, isDirectory: false })).toBe(false)
  })

  it('parse returns parsed object with lineCount', async () => {
    const data = new TextEncoder().encode('{"name":"Alice","age":30}')
    const result = await jsonPlugin.parse(data)
    expect(result.type).toBe('json')
    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.lineCount).toBeGreaterThan(0)
  })

  it('parse throws on invalid JSON', async () => {
    const data = new TextEncoder().encode('{invalid}')
    await expect(jsonPlugin.parse(data)).rejects.toThrow()
  })

  it('parse handles arrays', async () => {
    const data = new TextEncoder().encode('[1, 2, 3]')
    const result = await jsonPlugin.parse(data)
    expect(result.data).toEqual([1, 2, 3])
  })
})
