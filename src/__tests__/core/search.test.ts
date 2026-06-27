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
})
