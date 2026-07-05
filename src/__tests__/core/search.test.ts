import { describe, it, expect } from 'vitest'
import { SearchService } from '@/core/search'

describe('SearchService', () => {
  const svc = new SearchService()

  it('finds all occurrences in text', () => {
    const text = 'hello world\nhello again\nbye'
    const matches = svc.searchInText(text, 'hello', '/test.txt', 'a1')
    expect(matches).toHaveLength(2)
    expect(matches[0].lineNumber).toBe(1)
    expect(matches[1].lineNumber).toBe(2)
  })

  it('is case insensitive', () => {
    const text = 'Hello HELLO hello'
    const matches = svc.searchInText(text, 'hello', '/test.txt', 'a1')
    expect(matches).toHaveLength(3)
  })

  it('returns empty for no keyword', () => {
    expect(svc.searchInText('hello', '', '/test.txt', 'a1')).toEqual([])
  })

  it('searchAll aggregates results from multiple files', async () => {
    const files = [
      { archiveId: 'a1', filePath: '/a.txt', content: 'hello world' },
      { archiveId: 'a1', filePath: '/b.txt', content: 'hello again' },
    ]
    const results = await svc.searchAll(files, 'hello')
    expect(results.matches).toHaveLength(2)
    expect(results.keyword).toBe('hello')
  })

  it('同一行多次出现关键词', () => {
    const text = 'foo bar foo baz foo'
    const matches = svc.searchInText(text, 'foo', '/test.txt', 'a1')
    expect(matches).toHaveLength(3)
    expect(matches[0].matchStart).toBe(0)
    expect(matches[1].matchStart).toBe(8)
    expect(matches[2].matchStart).toBe(16)
  })

  it('关键词不存在时返回空', () => {
    const text = 'hello world'
    const matches = svc.searchInText(text, 'xyz', '/test.txt', 'a1')
    expect(matches).toHaveLength(0)
  })

  it('空文本返回空', () => {
    const matches = svc.searchInText('', 'hello', '/test.txt', 'a1')
    expect(matches).toHaveLength(0)
  })

  it('match 结果包含正确的 fileName 提取', () => {
    const text = 'error here'
    const matches = svc.searchInText(text, 'error', '/deep/path/file.log', 'a1')
    expect(matches).toHaveLength(1)
    expect(matches[0].fileName).toBe('file.log')
    expect(matches[0].lineContent).toBe('error here')
    expect(matches[0].matchStart).toBe(0)
    expect(matches[0].matchEnd).toBe(5)
  })

  it('searchAll 返回 searchTimeMs', async () => {
    const files = [{ archiveId: 'a1', filePath: '/a.txt', content: 'test' }]
    const results = await svc.searchAll(files, 'test')
    expect(results.searchTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('searchAll 空文件列表返回空匹配', async () => {
    const results = await svc.searchAll([], 'hello')
    expect(results.matches).toHaveLength(0)
    expect(results.keyword).toBe('hello')
  })

  it('searchAll 空关键词返回空匹配', async () => {
    const files = [{ archiveId: 'a1', filePath: '/a.txt', content: 'hello' }]
    const results = await svc.searchAll(files, '')
    expect(results.matches).toHaveLength(0)
  })
})
