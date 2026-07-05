import { describe, it, expect } from 'vitest'
import { useSearch } from '@/composables/use-search'

describe('useSearch', () => {
  const files = [
    { archiveId: 'a1', filePath: '/a.txt', content: 'hello world' },
    { archiveId: 'a1', filePath: '/b.txt', content: 'goodbye' },
  ]

  it('初始状态 results 为 null，searching 为 false', () => {
    const { results, searching } = useSearch()
    expect(results.value).toBeNull()
    expect(searching.value).toBe(false)
  })

  it('search 完成后 results 包含匹配结果', async () => {
    const { results, searching, search } = useSearch()
    await search(files, 'hello')
    expect(results.value).not.toBeNull()
    expect(results.value!.keyword).toBe('hello')
    expect(results.value!.matches).toHaveLength(1)
    expect(searching.value).toBe(false)
  })

  it('search 完成后 searching 恢复为 false', async () => {
    const { searching, search } = useSearch()
    await search(files, 'hello')
    expect(searching.value).toBe(false)
  })

  it('clear 清空 results', async () => {
    const { results, search, clear } = useSearch()
    await search(files, 'hello')
    expect(results.value).not.toBeNull()
    clear()
    expect(results.value).toBeNull()
  })

  it('search 无匹配时 results.matches 为空数组', async () => {
    const { results, search } = useSearch()
    await search(files, 'notfound')
    expect(results.value!.matches).toHaveLength(0)
  })
})
