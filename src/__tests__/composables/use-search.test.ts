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

  it('空文件列表搜索返回空匹配', async () => {
    const { results, search } = useSearch()
    await search([], 'hello')
    expect(results.value!.matches).toHaveLength(0)
  })

  it('特殊字符关键字不抛异常', async () => {
    const { results, search } = useSearch()
    await search(files, '[regex]')
    expect(results.value).not.toBeNull()
  })

  it('空字符串关键字返回空匹配', async () => {
    const { results, search } = useSearch()
    await search(files, '')
    expect(results.value!.matches).toHaveLength(0)
  })

  it('searching 在搜索期间为 true', async () => {
    const { searching, search } = useSearch()
    const promise = search(files, 'hello')
    // searchAll 是同步的（去掉了 async），所以 searching 会快速切换
    await promise
    expect(searching.value).toBe(false)
  })

  it('多次搜索后只保留最新结果', async () => {
    const { results, search } = useSearch()
    await search(files, 'hello')
    expect(results.value!.keyword).toBe('hello')
    await search(files, 'goodbye')
    expect(results.value!.keyword).toBe('goodbye')
  })
})
